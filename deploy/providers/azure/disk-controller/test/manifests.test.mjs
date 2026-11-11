// The controller's Kubernetes manifests (deploy/providers/azure/gitops/
// disk-controller) and the inert Flux module (services/disk-controller): the
// key fields of the base, the edge and TLS components and the overlays, read
// with the small YAML reader. With kubectl on PATH, every overlay is also
// rendered and checked as a whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { COORDINATION_PORT, DISPATCHER_PORT, WORKER_PORT, loadConfig } from "../lib/config.mjs";
import { CA_CLUSTER_OBJECT, COORDINATION_SERVICE, DEFAULT_WORKER_PORT_IP, DISPATCHER_SERVICE, LEAF_SECRET, leafIdentity } from "../tls.mjs";
import { parseYaml, parseYamlDocuments } from "./yaml.mjs";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const AZURE = join(PACKAGE, "..");
const GITOPS = join(AZURE, "gitops", "disk-controller");
const PORTAL = join(AZURE, "gitops", "portal");
const POD_LABELS = { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "disk-controller" };
const WORKER_POD_LABELS = { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "worker" };
const WORKER_SUBNET = "10.20.32.0/24";
const APPGW_SUBNET = "10.20.16.0/24";
const HEALTH_PATH = "/disk-pool/v1/healthz";
const OVERLAYS = {
  "afd-akv": ["edge-appgw", "replacements"],
  "afd-letsencrypt": ["edge-appgw", "tls-letsencrypt", "replacements"],
  "private-akv": ["edge-nginx", "replacements"],
};

const yaml = (root, path) => parseYaml(readFileSync(join(root, path), "utf8"));
const base = (file) => yaml(GITOPS, `base/${file}`);

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function component(root, name) {
  const kustomization = yaml(root, `components/${name}/kustomization.yaml`);
  return {
    kustomization,
    patches: (kustomization.patches ?? []).map((p) => ({ target: p.target, body: parseYamlDocuments(p.patch)[0] })),
    resources: (kustomization.resources ?? []).map((file) => yaml(root, `components/${name}/${file}`)),
  };
}

const ingressPatch = (c) => c.patches.find((p) => p.target.kind === "Ingress" && !Array.isArray(p.body)).body;
const overlayNamespace = (name) => yaml(GITOPS, `overlays/${name}/kustomization.yaml`).namespace;
const overlayEnv = (name) => parseEnv(readFileSync(join(GITOPS, "overlays", name, ".env"), "utf8"));
const portsOf = (rule) => rule.ports.map((p) => `${p.protocol}/${p.port}`);

test("the base runs one controller at a time, as its own identity, with the TLS bundle the controller reads", () => {
  const files = readdirSync(join(GITOPS, "base")).filter((f) => f !== "kustomization.yaml").sort();
  assert.deepEqual([...base("kustomization.yaml").resources].sort(), files, "every base file is a resource");
  const deployment = base("deployment.yaml");
  assert.equal(deployment.metadata.name, "pilotswarm-disk-controller");
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  assert.deepEqual(deployment.spec.selector.matchLabels, POD_LABELS);
  const pod = deployment.spec.template;
  assert.deepEqual(pod.metadata.labels, { ...POD_LABELS, "azure.workload.identity/use": "true" });
  const account = base("service-account.yaml");
  assert.equal(pod.spec.serviceAccountName, account.metadata.name);
  assert.equal(account.metadata.annotations["azure.workload.identity/client-id"], "__WORKLOAD_IDENTITY_CLIENT_ID__");
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);

  assert.equal(pod.spec.containers.length, 1);
  const [container] = pod.spec.containers;
  assert.equal(container.image, "__IMAGE__");
  assert.deepEqual(container.ports.map((p) => p.containerPort), [WORKER_PORT, DISPATCHER_PORT, COORDINATION_PORT]);
  assert.deepEqual(container.envFrom, [{ configMapRef: { name: "disk-controller-env" } }]);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);

  // The mounted bundle is where the controller looks by default, and it is the
  // secret the TLS step writes; no Kubernetes Secret holds the key.
  const tlsFile = container.env.find((e) => e.name === "PS_DISK_CONTROLLER_TLS_FILE").value;
  const mount = container.volumeMounts.find((m) => m.name === "tls");
  assert.equal(tlsFile, posix.join(mount.mountPath, LEAF_SECRET));
  const minimal = overlayEnv("afd-akv");
  assert.equal(loadConfig({ ...minimal, PS_DISK_CONTROLLER_TLS_FILE: "" }).tlsFile, tlsFile);
  const volume = pod.spec.volumes.find((v) => v.name === "tls");
  const spc = base("secret-provider-class.yaml");
  assert.equal(volume.csi.volumeAttributes.secretProviderClass, spc.metadata.name);
  assert.deepEqual(parseYaml(spc.spec.parameters.objects).array.map(parseYaml), [{ objectName: LEAF_SECRET, objectType: "secret" }]);
  assert.equal(spc.spec.secretObjects, undefined);
  assert.equal(spc.spec.parameters.clientID, "__WORKLOAD_IDENTITY_CLIENT_ID__");

  // exec probes only: the NetworkPolicies open no path from the node.
  for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) {
    assert.deepEqual(Object.keys(container[probe]).filter((k) => ["exec", "httpGet", "tcpSocket", "grpc"].includes(k)), ["exec"], probe);
    assert.match(container[probe].exec.command.join(" "), new RegExp(`\\b${DISPATCHER_PORT}\\b`), probe);
  }
  assert.match(container.readinessProbe.exec.command.join(" "), new RegExp(`path: '${HEALTH_PATH}'`));
});

test("the worker port is an internal load balancer at 10.20.15.250 that admits only the worker subnet", () => {
  const service = base("service-worker.yaml");
  assert.equal(service.metadata.name, "pilotswarm-disk-controller");
  assert.equal(service.spec.type, "LoadBalancer");
  assert.deepEqual(service.metadata.annotations, {
    "service.beta.kubernetes.io/azure-load-balancer-internal": "true",
    "service.beta.kubernetes.io/azure-load-balancer-ipv4": DEFAULT_WORKER_PORT_IP,
    "service.beta.kubernetes.io/azure-deny-all-except-load-balancer-source-ranges": "true",
  });
  assert.equal(DEFAULT_WORKER_PORT_IP, "10.20.15.250", "the address the leaf names");
  assert.equal(service.spec.externalTrafficPolicy, "Local");
  assert.deepEqual(service.spec.loadBalancerSourceRanges, [WORKER_SUBNET]);
  assert.deepEqual(service.spec.selector, POD_LABELS);
  assert.deepEqual(service.spec.ports.map((p) => [p.port, p.targetPort, p.protocol]), [[WORKER_PORT, WORKER_PORT, "TCP"]]);

  for (const [file, name, port] of [["service-dispatcher.yaml", DISPATCHER_SERVICE, DISPATCHER_PORT], ["service-coordination.yaml", COORDINATION_SERVICE, COORDINATION_PORT]]) {
    const cluster = base(file);
    assert.equal(cluster.metadata.name, name, "the name the leaf certificate carries");
    assert.equal(cluster.spec.type, "ClusterIP");
    assert.equal(cluster.metadata.annotations, undefined);
    assert.deepEqual(cluster.spec.selector, POD_LABELS);
    assert.deepEqual(cluster.spec.ports.map((p) => [p.port, p.targetPort]), [[port, port]]);
  }
});

test("the base NetworkPolicy admits 3003 from the worker subnet and 3005 from the coordination host's pods only", () => {
  const policy = base("network-policy.yaml");
  assert.deepEqual(policy.spec.podSelector.matchLabels, POD_LABELS);
  assert.deepEqual(policy.spec.policyTypes, ["Ingress"]);
  assert.deepEqual(policy.spec.ingress.map(portsOf), [[`TCP/${WORKER_PORT}`], [`TCP/${COORDINATION_PORT}`]]);
  assert.deepEqual(policy.spec.ingress[0].from, [{ ipBlock: { cidr: WORKER_SUBNET } }]);
  assert.deepEqual(policy.spec.ingress[1].from, [{ podSelector: { matchLabels: WORKER_POD_LABELS } }]);
});

test("the dispatcher Ingress routes only the dispatcher's path prefixes to the dispatcher port, and never the health route", () => {
  const ingress = base("ingress.yaml");
  assert.equal(ingress.metadata.name, DISPATCHER_SERVICE);
  const [rule] = ingress.spec.rules;
  assert.deepEqual(rule.http.paths.map((p) => [p.path, p.pathType, p.backend.service.name, p.backend.service.port.number]), [
    ["/disk-pool/v1/disks/", "Prefix", DISPATCHER_SERVICE, DISPATCHER_PORT],
    ["/disk-pool/v1/owners/", "Prefix", DISPATCHER_SERVICE, DISPATCHER_PORT],
  ]);
  assert.ok(!rule.http.paths.some((p) => HEALTH_PATH.startsWith(p.path)));
  const everything = readdirSync(GITOPS, { recursive: true }).filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(GITOPS, f), "utf8")).join("\n");
  assert.doesNotMatch(everything.replace(/^\s*#.*$/gm, ""), /cert-manager\.io\/cluster-issuer/, "the portal's certificate is issued once");
});

test("with App Gateway, the dispatcher port admits App Gateway's subnet, which checks the controller's certificate", () => {
  const appgw = component(GITOPS, "edge-appgw");
  const [policy] = appgw.resources;
  assert.equal(policy.kind, "NetworkPolicy");
  assert.deepEqual(policy.spec.podSelector.matchLabels, POD_LABELS);
  assert.deepEqual(policy.spec.ingress.map(portsOf), [[`TCP/${DISPATCHER_PORT}`]]);
  assert.deepEqual(policy.spec.ingress[0].from, [{ ipBlock: { cidr: APPGW_SUBNET } }]);

  const patch = ingressPatch(appgw);
  const portal = ingressPatch(component(PORTAL, "edge-appgw"));
  const dispatcherName = leafIdentity({ namespace: overlayNamespace("afd-akv") }).commonName;
  const annotations = patch.metadata.annotations;
  const agic = (name) => annotations[`appgw.ingress.kubernetes.io/${name}`];
  assert.equal(agic("backend-protocol"), "https");
  assert.equal(agic("backend-hostname"), dispatcherName);
  assert.equal(agic("health-probe-hostname"), dispatcherName);
  assert.equal(agic("health-probe-path"), HEALTH_PATH);
  assert.equal(agic("health-probe-port"), String(DISPATCHER_PORT));
  assert.equal(agic("appgw-trusted-root-certificate"), "__APPGW_TRUSTED_ROOT_CERTS__");
  for (const shared of ["use-private-ip", "ssl-redirect"]) {
    assert.equal(agic(shared), portal.metadata.annotations[`appgw.ingress.kubernetes.io/${shared}`], `the portal listener's ${shared}`);
  }
  assert.equal(patch.spec.ingressClassName, portal.spec.ingressClassName);
  assert.deepEqual(patch.spec.tls, portal.spec.tls, "the portal listener's TLS entry");
  assert.equal(agic("appgw-ssl-certificate"), "__PORTAL_TLS_CERT_NAME__");
  assert.ok(!Object.keys(annotations).some((k) => /health-probe-status-codes|request-timeout|connection-draining/.test(k)));
  const fromEnv = Object.fromEntries(appgw.kustomization.replacements.map((r) => [r.source.fieldPath, r.targets[0].fieldPaths[0]]));
  assert.deepEqual(fromEnv, {
    "data.APPGW_TRUSTED_ROOT_CERTS": "metadata.annotations.[appgw.ingress.kubernetes.io/appgw-trusted-root-certificate]",
    "data.PORTAL_TLS_CERT_NAME": "metadata.annotations.[appgw.ingress.kubernetes.io/appgw-ssl-certificate]",
  });

  const letsencrypt = component(GITOPS, "tls-letsencrypt");
  const portalLetsencrypt = component(PORTAL, "tls-letsencrypt");
  assert.deepEqual(letsencrypt.patches.find((p) => Array.isArray(p.body)).body,
    [{ op: "remove", path: "/metadata/annotations/appgw.ingress.kubernetes.io~1appgw-ssl-certificate" }]);
  assert.deepEqual(ingressPatch(letsencrypt).spec.tls, ingressPatch(portalLetsencrypt).spec.tls, "the portal's cert-manager Secret");
  assert.equal(ingressPatch(letsencrypt).metadata.annotations, undefined, "no cluster-issuer annotation");
});

test("with NGINX, the dispatcher port admits the app-routing pods, which check the controller's certificate against the CA Secret", () => {
  const nginx = component(GITOPS, "edge-nginx");
  const [policy] = nginx.resources;
  assert.deepEqual(policy.spec.podSelector.matchLabels, POD_LABELS);
  assert.deepEqual(policy.spec.ingress.map(portsOf), [[`TCP/${DISPATCHER_PORT}`]]);
  assert.deepEqual(policy.spec.ingress[0].from, [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "app-routing-system" } } }]);

  const namespace = overlayNamespace("private-akv");
  const patch = ingressPatch(nginx);
  const portal = ingressPatch(component(PORTAL, "edge-nginx"));
  assert.deepEqual(patch.metadata.annotations, {
    "nginx.ingress.kubernetes.io/ssl-redirect": "true",
    "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
    "nginx.ingress.kubernetes.io/proxy-ssl-verify": "on",
    "nginx.ingress.kubernetes.io/proxy-ssl-secret": `${namespace}/${CA_CLUSTER_OBJECT}`,
    "nginx.ingress.kubernetes.io/proxy-ssl-name": leafIdentity({ namespace }).commonName,
  });
  assert.equal(patch.spec.ingressClassName, portal.spec.ingressClassName);
  assert.deepEqual(patch.spec.tls, portal.spec.tls, "the portal's TLS Secret on the shared host");
});

test("the overlays pick the edge by mode, share the portal's namespace and carry every setting the controller and the replacements read", () => {
  assert.deepEqual(readdirSync(join(GITOPS, "overlays")).sort(), Object.keys(OVERLAYS).sort());
  const gitignore = readFileSync(join(AZURE, "gitops", ".gitignore"), "utf8").split(/\r?\n/);
  const validate = readFileSync(join(AZURE, "gitops", "validate.sh"), "utf8");
  const defaults = loadConfig({
    PS_DISK_POOL_STATE_URL: "https://placeholder.blob.core.windows.net/disk-pool-state",
    PS_DISK_CONTROLLER_TOKEN_SCOPE: "api://00000000-0000-0000-0000-000000000000/.default",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    EXPECTED_WIN_WORKER_OID: "00000000-0000-0000-0000-000000000000",
  });
  for (const [name, components] of Object.entries(OVERLAYS)) {
    const overlay = yaml(GITOPS, `overlays/${name}/kustomization.yaml`);
    assert.equal(overlay.namespace, yaml(PORTAL, `overlays/${name}/kustomization.yaml`).namespace, `${name} uses the portal's namespace`);
    assert.deepEqual(overlay.resources, ["../../base"]);
    assert.deepEqual(overlay.components, components.map((c) => `../../components/${c}`), name);
    assert.deepEqual(overlay.configMapGenerator, [{ name: "disk-controller-env", envs: [".env"] }]);

    const env = overlayEnv(name);
    assert.equal(env.NAMESPACE, overlay.namespace);
    const read = components.flatMap((c) => component(GITOPS, c).kustomization.replacements ?? []).map((r) => r.source.fieldPath.replace(/^data\./, ""));
    for (const key of read) assert.ok(key in env, `${name}/.env has ${key}`);
    const config = loadConfig(env);
    assert.deepEqual({ ...config, tlsFile: undefined }, { ...defaults, tlsFile: undefined }, `${name}/.env renders the controller's defaults`);

    assert.ok(gitignore.includes(`!disk-controller/overlays/${name}/.env`), `${name}/.env is committed`);
    assert.ok(validate.includes(`"\${SCRIPT_DIR}/disk-controller/overlays/${name}"`), `validate.sh builds ${name}`);
  }
});

test("the Flux module names an overlay for every supported edge and TLS source, and the deploy tool registers it", () => {
  const services = join(AZURE, "services");
  const bicep = readFileSync(join(services, "disk-controller", "bicep", "main.bicep"), "utf8");
  const allowed = (param) => [...new RegExp(`@allowed\\(\\[([^\\]]*)\\]\\)\\s*param ${param} `).exec(bicep)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed("edgeMode"), ["afd", "private"]);
  assert.match(bicep, /kustomizationPath: 'overlays\/\$\{edgeMode\}-\$\{tlsSource == 'akv-selfsigned' \? 'akv' : tlsSource\}'/);
  const paths = allowed("edgeMode").flatMap((edge) => allowed("tlsSource").map((tls) => `${edge}-${tls === "akv-selfsigned" ? "akv" : tls}`))
    .filter((path) => path !== "private-letsencrypt");
  for (const path of paths) assert.ok(existsSync(join(GITOPS, "overlays", path, "kustomization.yaml")), path);

  // Deployed after the portal, whose namespace and host the controller joins;
  // deploy.mjs skips it unless WIN_WORKERS_ENABLED=true.
  const service = JSON.parse(readFileSync(join(services, "disk-controller", "deploy.json"), "utf8"));
  assert.equal(service.name, "disk-controller");
  assert.equal(service.image.dockerfile, "deploy/Dockerfile.disk-controller");
  assert.equal(service.rollout.deployment, "pilotswarm-disk-controller");
  const manifest = JSON.parse(readFileSync(join(services, "deploy-manifest.json"), "utf8"));
  assert.ok(manifest.services.indexOf("disk-controller") > manifest.services.indexOf("portal"));
});

// ── rendered overlays ───────────────────────────────────────────────

const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

// Objects keyed "Kind/name", as in deploy/scripts/test/workspaces.test.mjs.
function render(overlay) {
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const built = spawnSync("kubectl", ["kustomize", join(GITOPS, "overlays", overlay)], opts);
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(built.stdout, /__(?!PS_UNSET__)[A-Z_]+__/, "every placeholder is filled");
  const json = spawnSync("kubectl", ["annotate", "--local", "-f", "-", "-o", "json", "pilotswarm.dev/render-probe-"], {
    ...opts,
    input: built.stdout,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(json.status, 0, json.stderr);
  const items = json.stdout.trim().split(/\n(?=\{\n)/).map((text) => JSON.parse(text));
  return Object.fromEntries(items.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
}

for (const overlay of Object.keys(OVERLAYS)) {
  test(`kubectl renders the ${overlay} overlay with its values filled`, { skip: !kubectlWorks && "kubectl is not installed" }, () => {
    const objects = render(overlay);
    const env = overlayEnv(overlay);
    for (const item of Object.values(objects)) assert.equal(item.metadata.namespace, "pilotswarm", `${item.kind}/${item.metadata.name}`);
    const configMap = Object.values(objects).find((o) => o.kind === "ConfigMap" && o.metadata.name.startsWith("disk-controller-env-"));
    const deployment = objects["Deployment/pilotswarm-disk-controller"];
    const [container] = deployment.spec.template.spec.containers;
    assert.equal(container.image, env.IMAGE);
    assert.equal(container.envFrom[0].configMapRef.name, configMap.metadata.name);
    assert.equal(objects["ServiceAccount/pilotswarm-disk-controller"].metadata.annotations["azure.workload.identity/client-id"], env.WORKLOAD_IDENTITY_CLIENT_ID);
    const spc = objects["SecretProviderClass/pilotswarm-disk-controller-tls"].spec.parameters;
    assert.deepEqual([spc.clientID, spc.keyvaultName, spc.tenantId], [env.WORKLOAD_IDENTITY_CLIENT_ID, env.KV_NAME, env.AZURE_TENANT_ID]);
    const ingress = objects[`Ingress/${DISPATCHER_SERVICE}`];
    assert.equal(ingress.spec.rules[0].host, env.PORTAL_HOSTNAME);
    assert.deepEqual(ingress.spec.tls[0].hosts, [env.PORTAL_HOSTNAME]);
    assert.ok(objects["NetworkPolicy/pilotswarm-disk-controller"] && objects[`NetworkPolicy/${DISPATCHER_SERVICE}`]);
    const annotations = ingress.metadata.annotations ?? {};
    if (overlay.startsWith("afd-")) {
      assert.equal(annotations["appgw.ingress.kubernetes.io/appgw-trusted-root-certificate"], env.APPGW_TRUSTED_ROOT_CERTS);
      assert.equal(annotations["appgw.ingress.kubernetes.io/health-probe-path"], HEALTH_PATH);
    }
    if (overlay === "afd-akv") assert.equal(annotations["appgw.ingress.kubernetes.io/appgw-ssl-certificate"], env.PORTAL_TLS_CERT_NAME);
    if (overlay === "afd-letsencrypt") {
      assert.equal(annotations["appgw.ingress.kubernetes.io/appgw-ssl-certificate"], undefined);
      assert.equal(ingress.spec.tls[0].secretName, "pilotswarm-portal-tls-le");
    }
    if (overlay === "private-akv") assert.equal(annotations["nginx.ingress.kubernetes.io/proxy-ssl-secret"], `pilotswarm/${CA_CLUSTER_OBJECT}`);
  });
}
