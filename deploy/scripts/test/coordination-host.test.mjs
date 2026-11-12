// The coordination host (WIN_WORKER_COORDINATION_HOST=true, with the Windows
// worker pool; lib/coordination-host.mjs): its settings, the staged worker,
// portal and controller overlays from one env map, the `coordination-host`
// gitops components (read as YAML, and rendered with `kubectl kustomize`, as
// Flux renders them, when kubectl is on PATH), base-infra's Bicep for the
// host's identity, federation, grants and alert (compiled with `az bicep
// build` when the Azure CLI has Bicep), the Windows worker deploy step that
// deletes the portal identity's credential for the worker's service account,
// and that step's place in deploy.mjs. The combination refusals are in
// overlay-contracts.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";

import { REPO_ROOT, parseEnvFile, run, templateEnvPath } from "../lib/common.mjs";
import { AKS_ENV_DEFAULTS, WIN_WORKER_ENV_DEFAULTS, WIN_WORKER_OUTPUT_DEFAULTS, winWorkerSettings } from "../lib/aks-env.mjs";
import * as host from "../lib/coordination-host.mjs";
import { _internals as bicepInternals } from "../lib/deploy-bicep.mjs";
import { renderParams } from "../lib/render-params.mjs";
import { ALL_SEQUENCE } from "../lib/service-info.mjs";
import { computeSpcKeysHash } from "../lib/spc-keys-hash.mjs";
import { stageManifests } from "../lib/stage-manifests.mjs";
import * as step from "../../providers/azure/deploy-steps/win-workers.mjs";
import { CA_CERT_SECRET, CA_CLUSTER_OBJECT, COORDINATION_SERVICE, LEAF_SECRET, NEXT_CA_CERT_SECRET, caBundle, caClusterManifest, leafIdentity } from "../../providers/azure/disk-controller/tls.mjs";
import { dbRoleJobManifestPath } from "../../providers/azure/deploy-steps/db-role-job.mjs";
import { COORDINATION_PORT } from "../../providers/azure/disk-controller/lib/config.mjs";
import { createFakeAz, createTestPki } from "../../providers/azure/disk-controller/test/x509.mjs";
import { parseYaml, parseYamlDocuments } from "../../providers/azure/disk-controller/test/yaml.mjs";
import { settingsFromEnv } from "../../providers/azure/linux-worker/capacity-requester.mjs";

const AZURE = join(REPO_ROOT, "deploy/providers/azure");
const WORKER_GITOPS = join(AZURE, "gitops/worker");
const COMPONENT = join(WORKER_GITOPS, "components/coordination-host");
const PLUGIN_COMPONENT = join(WORKER_GITOPS, "components/coordination-host-plugin");
const BICEP = join(AZURE, "services/base-infra/bicep");
const readBicep = (file) => readFileSync(join(BICEP, file), "utf8");
const yamlFile = (path) => parseYaml(readFileSync(path, "utf8"));

const SUBSCRIPTION = "33333333-3333-3333-3333-333333333333";
const TENANT = "22222222-2222-2222-2222-222222222222";
const PORTAL_APP = "11111111-1111-1111-1111-111111111111";
const PORTAL_CLIENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PORTAL_OID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HOST_CLIENT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const HOST_OID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const HOST_NAME = "psstamp-linux-worker-mid";
const CONTROLLER_CLIENT = "44444444-4444-4444-4444-444444444444";
const CONTROLLER_OID = "55555555-5555-5555-5555-555555555555";
const WIN_WORKER_NAME = "psstamp-win-worker-mid";
const WIN_WORKER_OID = "66666666-6666-6666-6666-666666666666";
const WORKER_LABELS = { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "worker" };
const CONTROLLER_LABELS = { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "disk-controller" };
const WORKER_SUBJECT = "system:serviceaccount:pilotswarm:copilot-runtime-worker";

// base-infra's outputs for the pool and the host, as the alias map writes them.
const OUTPUTS = Object.freeze({
  WORKLOAD_IDENTITY_CLIENT_ID: PORTAL_CLIENT,
  COORDINATION_IDENTITY_CLIENT_ID: HOST_CLIENT,
  COORDINATION_IDENTITY_PRINCIPAL_ID: HOST_OID,
  COORDINATION_IDENTITY_NAME: HOST_NAME,
  // The Windows workers' identity, which the portal's database role Job adds
  // to the workers' group (db-role-job.mjs).
  WIN_WORKER_IDENTITY_NAME: WIN_WORKER_NAME,
  EXPECTED_WIN_WORKER_OID: WIN_WORKER_OID,
  DISK_CONTROLLER_IDENTITY_CLIENT_ID: CONTROLLER_CLIENT,
  DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID: CONTROLLER_OID,
  DEPLOY_KEY_VAULT_NAME: "psstampkvdep",
  PERSONAL_KEY_VAULT_URI: "https://myvault.vault.azure.net/",
  PS_DISK_POOL_STATE_URL: "https://placeholder.blob.core.windows.net/disk-pool-state",
});

// The pool without the host, which deploy refuses (overlay-contracts.mjs),
// and the pool with what it needs.
const POOL = Object.freeze({ WIN_WORKERS_ENABLED: "true", WIN_WORKER_ALERT_EMAILS: "ops@example.com" });
const HOST = Object.freeze({ ...POOL, WIN_WORKER_COORDINATION_HOST: "true", PILOTSWARM_OWNER_ROUTING: "1", AUTHZ_ENFORCE_OWNERSHIP: "true" });

// What staging the worker, the portal and the controller reads: a managed
// identity stamp database whose Entra administrator is the portal's identity.
function stampEnv(extra = {}) {
  const env = {
    EDGE_MODE: "afd",
    TLS_SOURCE: "letsencrypt",
    FOUNDRY_ENDPOINT: "",
    IMAGE: "stub.azurecr.io/pilotswarm:t1",
    NAMESPACE: "pilotswarm",
    KV_NAME: "psstampkv",
    AZURE_TENANT_ID: TENANT,
    PORTAL_HOSTNAME: "portal.example.com",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net/",
    AZURE_STORAGE_CONTAINER: "copilot-sessions",
    PILOTSWARM_TURN_TIMEOUT_MS: "2700000",
    PILOTSWARM_LIVE_TURN: "0",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://psstamp-csi-mid@stamp-pg.postgres.database.azure.com:5432/pilotswarm?sslmode=require",
    PILOTSWARM_DB_AAD_USER: "psstamp-csi-mid",
    DATABASE_URL: "postgresql://psstamp-csi-mid@stamp-pg.postgres.database.azure.com:5432/pilotswarm?sslmode=require",
    PORTAL_AUTH_PROVIDER: "entra",
    PORTAL_AUTH_ENTRA_TENANT_ID: TENANT,
    PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP,
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTH_ENTRA_USER_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_DEFAULT_ROLE: "viewer",
    PORTAL_AUTHZ_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_USER_GROUPS: "__PS_UNSET__",
    // The trusted root the Windows worker deploy step lists before the
    // controller's manifests (win-workers.mjs, beforeManifests).
    APPGW_TRUSTED_ROOT_CERT_NAMES: "pilotswarm-disk-controller-ca-0123456789ab",
    ...OUTPUTS,
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return env;
}
const hostEnv = (extra = {}) => stampEnv({ ...HOST, ...extra });

function stage(t, service, env) {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-coordination-host-stage-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  return stageManifests({ service, envName: "testenv", env, stagingDir });
}

const keyOf = (line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
const envValues = (path) => Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).filter(keyOf)
  .map((line) => [keyOf(line), line.slice(line.indexOf("=") + 1)]));
const overlayOf = (root) => readFileSync(join(root, "overlays/default/kustomization.yaml"), "utf8");
const componentsOf = (root) => yamlFile(join(root, "overlays/default/kustomization.yaml")).components;

const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

// Renders one overlay directory with `kubectl kustomize` and returns its
// objects keyed by "Kind/name" (see workspaces.test.mjs), or null without
// kubectl.
function render(t, overlayDir) {
  if (!kubectlWorks) {
    t.skip("kubectl is not installed");
    return null;
  }
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const built = spawnSync("kubectl", ["kustomize", overlayDir], opts);
  assert.equal(built.status, 0, built.stderr);
  const json = spawnSync("kubectl", ["annotate", "--local", "-f", "-", "-o", "json", "pilotswarm.dev/render-probe-"], {
    ...opts,
    input: built.stdout,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(json.status, 0, json.stderr);
  const items = json.stdout.trim().split(/\n(?=\{\n)/).map((text) => JSON.parse(text));
  assert.equal(items.length, (built.stdout.match(/^kind: /gm) ?? []).length, "every rendered object came back");
  return Object.fromEntries(items.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
}

const workerDeployment = (objects) => objects["Deployment/copilot-runtime-worker"];
const podSpec = (deployment) => deployment.spec.template.spec;
const workerContainer = (deployment) => podSpec(deployment).containers.find((c) => c.name === "worker");
const envOf = (container) => Object.fromEntries((container.env ?? []).filter((e) => "value" in e).map((e) => [e.name, e.value]));
const configMap = (objects, prefix) => Object.values(objects).find((o) => o.kind === "ConfigMap" && o.metadata.name.startsWith(`${prefix}-`));
const matches = (selector, labels) => Object.entries(selector).every(([key, value]) => labels?.[key] === value);

// A POSIX shell to run the init containers' scripts with: sh on PATH, or Git
// for Windows' sh.
const shell = (() => {
  const candidates = ["sh"];
  if (process.platform === "win32") candidates.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe"));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "echo ok"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() === "ok") return candidate;
  }
  return null;
})();

// Runs an init container's script with its absolute paths (`replacements`,
// by their assignment lines) moved to test folders, and chown, chmod and find
// left out: the test checks what the script writes, the YAML the permissions
// it sets. Returns the shell's result, or null without a shell.
function runInitScript(t, script, replacements) {
  if (!shell) {
    t.skip("no POSIX shell");
    return null;
  }
  let text = script;
  for (const [line, value] of Object.entries(replacements)) {
    assert.ok(text.split("\n").includes(line), line);
    text = text.replace(line, `${line.split("=")[0]}='${value.replace(/\\/g, "/")}'`);
  }
  return spawnSync(shell, ["-c", `chown() { :; }\nchmod() { :; }\nfind() { :; }\n${text}`], { encoding: "utf8" });
}

const listTree = (dir, base = "") => readdirSync(join(dir, base), { withFileTypes: true }).flatMap((entry) => {
  const rel = base ? `${base}/${entry.name}` : entry.name;
  return entry.isDirectory() ? [`${rel}/`, ...listTree(dir, rel)] : [rel];
}).sort();

// ─── Settings ───

test("the host's settings default in aks-env.mjs, and base-infra's identity outputs reach the env map by name", () => {
  const unset = "__PS_UNSET__";
  assert.equal(WIN_WORKER_ENV_DEFAULTS.WIN_WORKER_COORDINATION_HOST_REPLICAS, "2");
  assert.equal(WIN_WORKER_ENV_DEFAULTS.WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP, unset);
  assert.equal(WIN_WORKER_ENV_DEFAULTS.WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES, unset);
  for (const key of ["COORDINATION_IDENTITY_CLIENT_ID", "COORDINATION_IDENTITY_PRINCIPAL_ID", "COORDINATION_IDENTITY_NAME"]) {
    assert.equal(WIN_WORKER_OUTPUT_DEFAULTS[key], unset, key);
    assert.ok(!(key in AKS_ENV_DEFAULTS), `${key} is an output, not a setting`);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(bicepInternals.OUTPUT_ALIAS).filter(([output]) => output.startsWith("coordinationIdentity"))),
    {
      coordinationIdentityClientId: "COORDINATION_IDENTITY_CLIENT_ID",
      coordinationIdentityPrincipalId: "COORDINATION_IDENTITY_PRINCIPAL_ID",
      coordinationIdentityName: "COORDINATION_IDENTITY_NAME",
    },
  );
  const main = readBicep("main.bicep");
  for (const output of ["coordinationIdentityClientId", "coordinationIdentityPrincipalId", "coordinationIdentityName"]) {
    assert.match(main, new RegExp(`^output ${output} string = Uami\\.outputs\\.${output}\\s*$`, "m"), output);
  }

  const settings = winWorkerSettings({});
  assert.equal(settings.coordinationHostReplicas, 2);
  assert.equal(settings.coordinationHostPluginConfigMap, null);
  assert.deepEqual(settings.coordinationHostRedactSecretPrefixes, []);
  const read = (extra) => winWorkerSettings(extra);
  assert.equal(read({ WIN_WORKER_COORDINATION_HOST_REPLICAS: "0" }).coordinationHostReplicas, 0);
  assert.equal(read({ WIN_WORKER_COORDINATION_HOST_REPLICAS: "20" }).coordinationHostReplicas, 20);
  assert.equal(read({ WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: "host-plugin.v1" }).coordinationHostPluginConfigMap, "host-plugin.v1");
  assert.deepEqual(read({ WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: " acme_, sk-live-,acme_ ," }).coordinationHostRedactSecretPrefixes,
    ["acme_", "sk-live-"]);
  for (const [extra, message] of [
    [{ WIN_WORKER_COORDINATION_HOST_REPLICAS: "21" }, /WIN_WORKER_COORDINATION_HOST_REPLICAS must be a whole number from 0 to 20/],
    [{ WIN_WORKER_COORDINATION_HOST_REPLICAS: "two" }, /WIN_WORKER_COORDINATION_HOST_REPLICAS must be a whole number/],
    [{ WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: "Host_Plugin" }, /WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP must be a ConfigMap name/],
    [{ WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: "acme_,x" }, /entry 'x' is not a token prefix/],
    [{ WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: "_acme" }, /entry '_acme' is not a token prefix/],
  ]) {
    assert.throws(() => read(extra), message, JSON.stringify(extra));
  }
});

// ─── Staging: the replica rules, the identity, the component ───

test("without the pool, the staged worker is as before: its overlay unchanged, no replica count, no component", (t) => {
  for (const extra of [{}, { WIN_WORKERS_ENABLED: "false" }, { WIN_WORKERS_ENABLED: "false", WIN_WORKER_COORDINATION_HOST: "false" }]) {
    const env = stampEnv(extra);
    assert.equal(host.workerReplicas(env), null);
    const root = stage(t, "worker", env);
    assert.equal(overlayOf(root), readFileSync(join(WORKER_GITOPS, "overlays/default/kustomization.yaml"), "utf8"), JSON.stringify(extra));
    const values = envValues(join(root, "overlays/default/.env"));
    assert.deepEqual(Object.keys(values), Object.keys(envValues(join(WORKER_GITOPS, "overlays/default/.env"))), "the same keys");
    assert.equal(values.WORKLOAD_IDENTITY_CLIENT_ID, PORTAL_CLIENT);
    assert.equal(values.PILOTSWARM_DB_AAD_USER, "psstamp-csi-mid");
    assert.equal(readFileSync(join(root, "components/coordination-host/coordination-host.properties"), "utf8"),
      readFileSync(join(COMPONENT, "coordination-host.properties"), "utf8"), "the unused component is copied as it is");
  }
});

test("with the pool and without the host, staging the worker refuses, as deploy does before any step", (t) => {
  for (const extra of [POOL, { ...POOL, WIN_WORKER_COORDINATION_HOST: "false" }, { ...HOST, WIN_WORKER_COORDINATION_HOST: "false" }]) {
    assert.throws(() => stage(t, "worker", stampEnv(extra)),
      /WIN_WORKERS_ENABLED=true needs WIN_WORKER_COORDINATION_HOST=true: the coordination host makes the Windows workers owner-only/,
      JSON.stringify(extra));
  }
  // The portal and the controller stage as they would: the refusal is the worker's.
  assert.equal(host.stageCoordinationHost({ service: "portal", env: stampEnv(POOL), stagedServiceRoot: "unused", overlayName: "unused" }), null);
});

test("with the host, the worker's overlay takes the host's identity in that call only: the portal and the controller keep theirs, and the env map is unchanged", (t) => {
  const env = hostEnv();
  const before = structuredClone(env);
  const worker = stage(t, "worker", env);
  // The only change is the SPC keys hash every worker and portal staging has
  // always stamped, which is the same for both.
  assert.deepEqual(env, { ...before, SPC_KEYS_HASH: computeSpcKeysHash({ service: "worker" }) });
  assert.equal(computeSpcKeysHash({ service: "worker" }), computeSpcKeysHash({ service: "portal" }));
  const portal = stage(t, "portal", env);
  const controller = stage(t, "disk-controller", env);

  const workerValues = envValues(join(worker, "overlays/default/.env"));
  assert.equal(workerValues.WORKLOAD_IDENTITY_CLIENT_ID, HOST_CLIENT);
  assert.equal(workerValues.PILOTSWARM_DB_AAD_USER, HOST_NAME);
  const portalValues = envValues(join(portal, "overlays/afd-letsencrypt/.env"));
  assert.equal(portalValues.WORKLOAD_IDENTITY_CLIENT_ID, PORTAL_CLIENT);
  assert.equal(portalValues.PILOTSWARM_DB_AAD_USER, "psstamp-csi-mid");
  assert.equal(envValues(join(controller, "overlays/afd-letsencrypt/.env")).WORKLOAD_IDENTITY_CLIENT_ID, CONTROLLER_CLIENT);
  // Everything else in the worker's .env is the env map's.
  for (const [key, value] of Object.entries(workerValues)) {
    if (["WORKLOAD_IDENTITY_CLIENT_ID", "PILOTSWARM_DB_AAD_USER"].includes(key) || !(key in env)) continue;
    assert.equal(value, env[key], key);
  }

  for (const missing of ["COORDINATION_IDENTITY_CLIENT_ID", "COORDINATION_IDENTITY_NAME"]) {
    assert.throws(() => stage(t, "worker", hostEnv({ [missing]: "__PS_UNSET__" })),
      /the coordination host needs COORDINATION_IDENTITY_CLIENT_ID and COORDINATION_IDENTITY_NAME from base-infra/, missing);
  }
});

test("rendered from one env map, each service account carries its own identity and each pod its own database user", (t) => {
  const env = hostEnv();
  const worker = render(t, join(stage(t, "worker", env), "overlays/default"));
  if (!worker) return;
  const portal = render(t, join(stage(t, "portal", env), "overlays/afd-letsencrypt"));
  const controller = render(t, join(stage(t, "disk-controller", env), "overlays/afd-letsencrypt"));
  const clientId = (objects, name) => objects[`ServiceAccount/${name}`].metadata.annotations["azure.workload.identity/client-id"];
  assert.equal(clientId(worker, "copilot-runtime-worker"), HOST_CLIENT);
  assert.equal(clientId(portal, "pilotswarm-portal"), PORTAL_CLIENT);
  assert.equal(clientId(controller, "pilotswarm-disk-controller"), CONTROLLER_CLIENT);
  assert.equal(configMap(worker, "worker-env").data.PILOTSWARM_DB_AAD_USER, HOST_NAME);
  assert.equal(configMap(portal, "portal-env").data.PILOTSWARM_DB_AAD_USER, "psstamp-csi-mid");
  // The pods take the workload identity webhook's credential from their service account.
  assert.equal(workerDeployment(worker).spec.template.metadata.labels["azure.workload.identity/use"], "true");
  assert.equal(podSpec(workerDeployment(worker)).serviceAccountName, "copilot-runtime-worker");
});

test("with the host, the staged overlay gets the component and WIN_WORKER_COORDINATION_HOST_REPLICAS replicas, 2 by default", (t) => {
  for (const [replicas, expected] of [[undefined, 2], ["0", 0], ["5", 5]]) {
    const env = hostEnv(replicas === undefined ? {} : { WIN_WORKER_COORDINATION_HOST_REPLICAS: replicas });
    assert.equal(host.workerReplicas(env), expected);
    const root = stage(t, "worker", env);
    assert.deepEqual(componentsOf(root), ["../../components/coordination-host", "../../components/worker-replacements"]);
    assert.deepEqual(yamlFile(join(root, "overlays/default/kustomization.yaml")).replicas, [{ name: "copilot-runtime-worker", count: expected }]);
  }
  // With workspaces the host runs the Portal's sessions with them: the
  // workspaces component goes first, and coordination-host-workspaces after
  // the host's own, so its settings win.
  const hosted = stage(t, "worker", hostEnv({ WORKSPACES_ENABLED: "true" }));
  assert.deepEqual(componentsOf(hosted), ["../../components/workspaces", "../../components/coordination-host",
    "../../components/coordination-host-workspaces", "../../components/worker-replacements"]);
  // The portal and the controller get nothing of it.
  assert.equal(host.stageCoordinationHost({ service: "portal", env: hostEnv(), stagedServiceRoot: "unused", overlayName: "unused" }), null);
});

test("rendered: 3 replicas without the pool, 2 with the host; without the host the pods keep the secret store", (t) => {
  for (const [extra, replicas, coordinationHost] of [[{}, 3, false], [HOST, 2, true]]) {
    const objects = render(t, join(stage(t, "worker", stampEnv(extra)), "overlays/default"));
    if (!objects) return;
    const deployment = workerDeployment(objects);
    assert.equal(deployment.spec.replicas, replicas, JSON.stringify(extra));
    assert.equal(Boolean(objects["SecretProviderClass/copilot-worker-secrets"]), !coordinationHost);
    assert.equal(Boolean(objects["PodDisruptionBudget/copilot-runtime-worker"]), coordinationHost);
    // The base's worker egress policy, whose rules the host's replace: one policy for the worker's pods either way.
    const policies = Object.values(objects).filter((o) => o.kind === "NetworkPolicy" && matches(o.spec.podSelector.matchLabels, WORKER_LABELS));
    assert.deepEqual(policies.map((o) => o.metadata.name), ["copilot-runtime-worker-egress"]);
    const opens = (port) => policies[0].spec.egress.some((rule) => (rule.ports ?? []).some((p) => p.port === port));
    assert.equal(opens(COORDINATION_PORT), coordinationHost, "only the host's rules open the controller's port");
    assert.ok(policies[0].spec.egress.flatMap((rule) => rule.to ?? [])
      .every((to) => to.ipBlock?.cidr !== "0.0.0.0/0" || to.ipBlock.except?.includes("169.254.169.254/32")),
      "no rule reaches the instance metadata address");
  }
});

test("without the pool, the coordination-host folders in the staged tree change nothing in the render, with workspaces or without", (t) => {
  for (const extra of [{}, { WORKSPACES_ENABLED: "true" }]) {
    const root = stage(t, "worker", stampEnv(extra));
    const withFolders = render(t, join(root, "overlays/default"));
    if (!withFolders) return;
    const copy = mkdtempSync(join(tmpdir(), "ps-coordination-host-copy-"));
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(root, copy, { recursive: true });
    for (const name of ["coordination-host", "coordination-host-plugin", "coordination-host-ca", "coordination-host-workspaces"]) {
      rmSync(join(copy, "components", name), { recursive: true, force: true });
    }
    assert.deepEqual(withFolders, render(t, join(copy, "overlays/default")), JSON.stringify(extra));
  }
});

test("while the controller trusts two CAs, the host's pod template carries the bundle's hash, so a new bundle rolls the host; with one CA it stays as it was", (t) => {
  const hash = "ab".repeat(32);
  const two = stage(t, "worker", hostEnv({ [host.COORDINATION_HOST_CA_HASH_KEY]: hash }));
  assert.deepEqual(componentsOf(two),
    ["../../components/coordination-host", "../../components/coordination-host-ca", "../../components/worker-replacements"]);
  const staged = readFileSync(join(two, "components/coordination-host-ca/kustomization.yaml"), "utf8");
  assert.ok(staged.includes(`${host.COORDINATION_HOST_CA_ANNOTATION}: ${hash}`) && !staged.includes(host.CA_HASH_PLACEHOLDER));
  const one = stage(t, "worker", hostEnv());
  assert.deepEqual(componentsOf(one), ["../../components/coordination-host", "../../components/worker-replacements"]);
  assert.ok(readFileSync(join(one, "components/coordination-host-ca/kustomization.yaml"), "utf8").includes(host.CA_HASH_PLACEHOLDER),
    "the unused component keeps its placeholder");
  assert.throws(() => stage(t, "worker", hostEnv({ [host.COORDINATION_HOST_CA_HASH_KEY]: "not-a-hash" })), /must be the SHA-256 of the disk controller's CA bundle/);
  // Without the pool the worker runs no coordination, whatever the hash.
  const noPool = stage(t, "worker", stampEnv({ [host.COORDINATION_HOST_CA_HASH_KEY]: hash }));
  assert.deepEqual(componentsOf(noPool), ["../../components/worker-replacements"]);
  assert.equal(host.caBundleHash("bundle\n"), createHash("sha256").update("bundle\n").digest("hex"));

  const rotating = render(t, join(two, "overlays/default"));
  if (!rotating) return;
  const plain = render(t, join(one, "overlays/default"));
  const annotations = (objects) => workerDeployment(objects).spec.template.metadata.annotations;
  assert.equal(annotations(rotating)[host.COORDINATION_HOST_CA_ANNOTATION], hash);
  assert.equal(annotations(plain)[host.COORDINATION_HOST_CA_ANNOTATION], undefined);
  assert.equal(annotations(rotating)["pilotswarm.dev/spc-keys-hash"], annotations(plain)["pilotswarm.dev/spc-keys-hash"], "the other annotation stays");
  const withoutHash = structuredClone(rotating);
  delete withoutHash["Deployment/copilot-runtime-worker"].spec.template.metadata.annotations[host.COORDINATION_HOST_CA_ANNOTATION];
  assert.deepEqual(withoutHash, plain, "the annotation is all the component changes");
});

// ─── The component: secrets, network, the pod ───

test("the component deletes the secret store, its volume and the secretRef, and keeps the spc-keys-hash annotation", (t) => {
  const kustomization = yamlFile(join(COMPONENT, "kustomization.yaml"));
  const deletes = kustomization.patches.filter((p) => p.patch).map((p) => parseYamlDocuments(p.patch)[0]);
  assert.deepEqual(deletes, [{
    apiVersion: "secrets-store.csi.x-k8s.io/v1", kind: "SecretProviderClass", metadata: { name: "copilot-worker-secrets" }, $patch: "delete",
  }]);
  const patch = yamlFile(join(COMPONENT, "deployment-patch.yaml"));
  const container = patch.spec.template.spec.containers[0];
  assert.deepEqual(container.envFrom, [{ configMapRef: { name: "worker-env" } }, { configMapRef: { name: "coordination-host-env" } }]);
  assert.deepEqual(container.volumeMounts[0], { mountPath: "/mnt/secrets-store", $patch: "delete" });
  assert.deepEqual(patch.spec.template.spec.volumes[0], { name: "secrets-store", $patch: "delete" });
  assert.equal(patch.spec.template.metadata, undefined, "the pod template's annotations stay as they are");
  // worker-replacements still writes the annotation: a replacement fails when its target field is missing.
  assert.match(readFileSync(join(WORKER_GITOPS, "components/worker-replacements/kustomization.yaml"), "utf8"),
    /fieldPath: data\.SPC_KEYS_HASH[\s\S]*spec\.template\.metadata\.annotations\.\[pilotswarm\.dev\/spc-keys-hash\]/);

  const objects = render(t, join(stage(t, "worker", hostEnv()), "overlays/default"));
  if (!objects) return;
  assert.ok(!Object.values(objects).some((o) => o.kind === "SecretProviderClass"), "no secret store");
  const deployment = workerDeployment(objects);
  const text = JSON.stringify(deployment);
  assert.doesNotMatch(text, /secretRef|secretKeyRef|secrets-store|"csi"/, "no secretRef, no CSI volume");
  assert.equal(deployment.spec.template.metadata.annotations["pilotswarm.dev/spc-keys-hash"], computeSpcKeysHash({ service: "worker" }));
});

test("the egress NetworkPolicy: DNS to the cluster's DNS pods, 3005 to the controller's pods, Blob, and 443 and 5432 outside the VNet only", () => {
  const policy = yamlFile(join(COMPONENT, "network-policy.yaml"));
  // A patch of the base's worker egress policy that replaces its spec (policies add up).
  assert.equal(policy.metadata.name, yamlFile(join(AZURE, "gitops/worker/base/network-policy.yaml")).metadata.name);
  assert.equal(policy.spec.$patch, "replace");
  assert.deepEqual(policy.spec.podSelector, { matchLabels: WORKER_LABELS });
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.deepEqual(policy.spec.egress, [
    {
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
      ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
    },
    { to: [{ podSelector: { matchLabels: CONTROLLER_LABELS } }], ports: [{ protocol: "TCP", port: COORDINATION_PORT }] },
    { to: [{ ipBlock: { cidr: "10.20.33.4/32" } }], ports: [{ protocol: "TCP", port: 443 }] },
    {
      to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.20.0.0/16", "169.254.169.254/32", "168.63.129.16/32"] } }],
      ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 5432 }],
    },
  ]);
  // The addresses are base-infra's: the blob private endpoint and the VNet.
  assert.match(readBicep("main.bicep"), /^var storageBlobPrivateEndpointIp = '10\.20\.33\.4'\s*$/m);
  assert.match(readBicep("vnet.bicep"), /^param addressSpace string = '10\.20\.0\.0\/16'\s*$/m);
  // The controller's pods carry the labels the rule selects.
  const controller = yamlFile(join(AZURE, "gitops/disk-controller/base/deployment.yaml"));
  assert.ok(matches(CONTROLLER_LABELS, controller.spec.template.metadata.labels));
});

test("the controller's NetworkPolicy admits port 3005 only from the coordination host's pods, in the same namespace", (t) => {
  const env = hostEnv();
  const worker = render(t, join(stage(t, "worker", env), "overlays/default"));
  if (!worker) return;
  const portal = render(t, join(stage(t, "portal", env), "overlays/afd-letsencrypt"));
  const controller = render(t, join(stage(t, "disk-controller", env), "overlays/afd-letsencrypt"));
  const policies = Object.values(controller).filter((o) => o.kind === "NetworkPolicy" && matches(o.spec.podSelector.matchLabels, CONTROLLER_LABELS));
  const rules = policies.flatMap((p) => p.spec.ingress ?? []).filter((rule) => (rule.ports ?? []).some((port) => port.port === COORDINATION_PORT));
  assert.equal(rules.length, 1, "one rule opens 3005");
  const [rule] = rules;
  assert.deepEqual(rule.ports, [{ protocol: "TCP", port: COORDINATION_PORT }]);
  assert.equal(rule.from.length, 1);
  assert.deepEqual(Object.keys(rule.from[0]), ["podSelector"], "pods of the policy's own namespace, no address range");
  const pods = (objects) => Object.values(objects).filter((o) => o.spec?.template?.metadata?.labels)
    .map((o) => ({ key: `${o.kind}/${o.metadata.name}`, namespace: o.metadata.namespace, labels: o.spec.template.metadata.labels }));
  const admitted = [...pods(worker), ...pods(portal), ...pods(controller)].filter((pod) => matches(rule.from[0].podSelector.matchLabels, pod.labels));
  assert.deepEqual(admitted.map((pod) => pod.key), ["Deployment/copilot-runtime-worker"]);
  assert.equal(admitted[0].namespace, policies[0].metadata.namespace);
});

test("the pod: the settings the host runs with, 4 GiB, the controller's CA, one replica kept through a drain, spread across nodes", (t) => {
  const patch = yamlFile(join(COMPONENT, "deployment-patch.yaml"));
  const container = patch.spec.template.spec.containers[0];
  const expected = {
    PILOTSWARM_EXTENSION_MODULES: "/app/deploy/providers/azure/linux-worker/capacity-requester.mjs",
    NODE_EXTRA_CA_CERTS: "/etc/pilotswarm/disk-controller-ca/ca.crt",
    PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS: "1",
    PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS: "1",
    PILOTSWARM_SCRUB_CLI_ENV: "1",
    PILOTSWARM_CLI_DISABLE_HOOKS: "1",
    PILOTSWARM_AGENT_PACKAGES: "0",
    PILOTSWARM_SKIP_DB_MIGRATIONS: "1",
    PILOTSWARM_SESSION_MESSAGE_SCOPE: "owner",
    PILOTSWARM_PERSONAL_SECRETS: "external",
    PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: "1",
    PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN",
    COPILOT_PKG_CACHE_HOME: host.COORDINATION_HOST_PKG_CACHE_HOME,
    COPILOT_HOME: "/home/node/.copilot",
    SESSION_STATE_DIR: "/home/node/.copilot/session-state",
    PILOTSWARM_EVENT_RETENTION_MINUTES: "43200",
    PILOTSWARM_DISABLE_K8S_SCALING: "1",
    PILOTSWARM_WORKER_CONCURRENCY: "8",
    PILOTSWARM_ORCHESTRATION_CONCURRENCY: "4",
  };
  assert.deepEqual(envOf(container), expected);
  assert.ok(!("PILOTSWARM_REGEN_LLM_DISTILLER" in envOf(container)), "no distiller");
  // A Portal session's sub-agents keep its workspace.
  assert.ok(!("PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE" in envOf(container)));
  // The module the setting names is the one the image copies to that path.
  assert.ok(existsSync(join(REPO_ROOT, expected.PILOTSWARM_EXTENSION_MODULES.replace(/^\/app\//, ""))));
  assert.match(readFileSync(join(REPO_ROOT, "deploy/Dockerfile.worker"), "utf8"),
    /^COPY deploy\/providers\/azure\/linux-worker\/\*\.mjs \.\/deploy\/providers\/azure\/linux-worker\/\s*$/m);
  assert.match(readFileSync(join(REPO_ROOT, "deploy/Dockerfile.worker"), "utf8"), /^ARG COPILOT_PKG_CACHE_HOME\s*$/m);
  assert.deepEqual(container.resources, { limits: { memory: "4Gi" } });
  // The CA: the ConfigMap the TLS step applies, mounted where NODE_EXTRA_CA_CERTS points.
  const caVolume = patch.spec.template.spec.volumes.find((v) => v.name === "disk-controller-ca");
  assert.deepEqual(caVolume.configMap, { name: CA_CLUSTER_OBJECT, items: [{ key: "ca.crt", path: "ca.crt" }] });
  const caMount = container.volumeMounts.find((m) => m.name === "disk-controller-ca");
  assert.equal(posix.join(caMount.mountPath, "ca.crt"), expected.NODE_EXTRA_CA_CERTS);
  assert.equal(caMount.readOnly, true);
  const applied = parseYamlDocuments(caClusterManifest({ namespace: "pilotswarm", caPem: createTestPki().caPem }));
  assert.ok(applied.some((o) => o.kind === "ConfigMap" && o.metadata.name === CA_CLUSTER_OBJECT && o.data["ca.crt"].includes("BEGIN CERTIFICATE")));

  const budget = yamlFile(join(COMPONENT, "pod-disruption-budget.yaml"));
  assert.equal(budget.spec.minAvailable, 1);
  assert.deepEqual(budget.spec.selector, { matchLabels: WORKER_LABELS });
  assert.deepEqual(patch.spec.template.spec.topologySpreadConstraints, [{
    maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway", labelSelector: { matchLabels: WORKER_LABELS },
  }]);

  const objects = render(t, join(stage(t, "worker", hostEnv()), "overlays/default"));
  if (!objects) return;
  const deployment = workerDeployment(objects);
  const worker = workerContainer(deployment);
  const rendered = envOf(worker);
  for (const [key, value] of Object.entries(expected)) assert.equal(rendered[key], value, key);
  assert.equal(worker.resources.limits.memory, "4Gi");
  assert.deepEqual(worker.envFrom.map((e) => e.configMapRef.name.replace(/-[a-z0-9]{10}$/, "")), ["worker-env", "coordination-host-env"]);
  assert.ok(objects[`ConfigMap/${worker.envFrom[1].configMapRef.name}`], "the host's ConfigMap is in the render, by its hashed name");
  assert.ok(matches(objects["PodDisruptionBudget/copilot-runtime-worker"].spec.selector.matchLabels, deployment.spec.template.metadata.labels));
  for (const item of Object.values(objects)) assert.equal(item.metadata.namespace ?? "pilotswarm", "pilotswarm", `${item.kind}/${item.metadata.name}`);
});

test("with workspaces, the host runs the Portal's sessions with them: both modules, both plugin folders, Git's settings for agents' tools, and the repo service's port", (t) => {
  const WORKSPACES_COMPONENT = join(WORKER_GITOPS, "components/coordination-host-workspaces");
  const patch = yamlFile(join(WORKSPACES_COMPONENT, "deployment-patch.yaml"));
  const modules = envOf(patch.spec.template.spec.containers[0]).PILOTSWARM_EXTENSION_MODULES;
  assert.equal(modules, "/app/packages/sdk/examples/repo-workspaces/index.mjs,/app/deploy/providers/azure/linux-worker/capacity-requester.mjs");
  // The modules the setting names are the ones the image copies to those paths.
  for (const module of modules.split(",")) assert.ok(existsSync(join(REPO_ROOT, module.replace(/^\/app\//, ""))), module);
  assert.match(readFileSync(join(WORKSPACES_COMPONENT, "deployment-patch.yaml"), "utf8"), new RegExp(host.PLUGIN_DIRS_PLACEHOLDER));
  // The workspaces component's plugin folder, which the host names after the Windows workers' plugin.
  assert.equal(envOf(yamlFile(join(WORKER_GITOPS, "components/workspaces/worker-patch.yaml")).spec.template.spec.containers[0]).PLUGIN_DIRS,
    host.WORKSPACES_PLUGIN_DIR);

  const hostOnly = render(t, join(stage(t, "worker", hostEnv()), "overlays/default"));
  if (!hostOnly) return;
  const repoPolicy = yamlFile(join(AZURE, "gitops/repo-cache/base/network-policy.yaml"));
  const repoPods = yamlFile(join(AZURE, "gitops/repo-cache/base/deployment.yaml")).spec.template.metadata.labels;
  for (const [extra, pluginDirs] of [
    [{}, host.WORKSPACES_PLUGIN_DIR],
    [{ WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: "host-plugin" }, `${host.COORDINATION_HOST_PLUGIN_DIR},${host.WORKSPACES_PLUGIN_DIR}`],
  ]) {
    const objects = render(t, join(stage(t, "worker", hostEnv({ WORKSPACES_ENABLED: "true", ...extra })), "overlays/default"));
    const deployment = workerDeployment(objects);
    const worker = workerContainer(deployment);
    const env = envOf(worker);
    assert.equal(env.PILOTSWARM_EXTENSION_MODULES, modules);
    assert.equal(env.PLUGIN_DIRS, pluginDirs);
    assert.equal(env.PILOTSWARM_CLI_ENV_ALLOWLIST, "REPO_SERVICE_URL,GIT_AUTHOR_NAME,GIT_AUTHOR_EMAIL,GIT_COMMITTER_NAME,GIT_COMMITTER_EMAIL");
    // The workspaces component's settings and mounts, and the host's own settings, all stay.
    for (const key of ["PS_WORKSPACE_ROOTS", "PS_PLAIN_ROOTS", "PS_HOME_ROOT", "REPO_SERVICE_URL", "ATTACHER_SOCKET", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL"]) {
      assert.ok(env[key], key);
    }
    for (const [key, value] of Object.entries(envOf(workerContainer(workerDeployment(hostOnly))))) {
      if (!["PILOTSWARM_EXTENSION_MODULES", "PLUGIN_DIRS"].includes(key)) assert.equal(env[key], value, key);
    }
    assert.ok(!("PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE" in env), "a session's sub-agents keep its workspace");
    assert.deepEqual(worker.volumeMounts.filter((m) => ["/ws", "/run/pilotswarm-attacher"].includes(m.mountPath)).map((m) => m.name), ["workspaces", "attacher-socket"]);
    assert.ok(objects["DaemonSet/pilotswarm-attacher"], "the attacher mounts the repo pod's exports on the host's nodes");
    assert.equal(podSpec(deployment).terminationGracePeriodSeconds, 90, "a draining host releases its workspaces");

    // Egress: the host's own policy as it is, and a second that opens only the
    // repo service's port, to the repo pod, whose own policy admits the host.
    const policies = Object.values(objects).filter((o) => o.kind === "NetworkPolicy" && matches(o.spec.podSelector.matchLabels, WORKER_LABELS));
    assert.deepEqual(policies.map((o) => o.metadata.name).sort(), ["copilot-runtime-worker-egress", "copilot-runtime-worker-repo-cache-egress"]);
    assert.deepEqual(objects["NetworkPolicy/copilot-runtime-worker-egress"], hostOnly["NetworkPolicy/copilot-runtime-worker-egress"]);
    const repo = objects["NetworkPolicy/copilot-runtime-worker-repo-cache-egress"];
    assert.deepEqual(repo.spec.policyTypes, ["Egress"]);
    assert.deepEqual(repo.spec.egress, [{ to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "repo-cache" } } }],
      ports: [{ protocol: "TCP", port: 8080 }] }]);
    assert.ok(matches(repo.spec.egress[0].to[0].podSelector.matchLabels, repoPods));
    assert.equal(new URL(env.REPO_SERVICE_URL).port, "8080");
    const admits = repoPolicy.spec.ingress.find((rule) => rule.ports.some((p) => p.port === 8080));
    assert.ok(matches(admits.from[0].podSelector.matchLabels, deployment.spec.template.metadata.labels));
  }
});

test("the host's ConfigMap: the controller's coordination URL and token scope, which the module accepts, and redaction prefixes only when set", (t) => {
  const values = envValues(join(stage(t, "worker", hostEnv()), "components/coordination-host/coordination-host.properties"));
  assert.deepEqual(values, {
    PS_COORDINATION_URL: "https://pilotswarm-disk-controller-coordination.pilotswarm.svc:3005",
    PS_COORDINATION_TOKEN_SCOPE: `${PORTAL_APP}/.default`,
  });
  // The names the controller's certificate carries and the port it serves.
  assert.equal(host.COORDINATION_SERVICE, COORDINATION_SERVICE);
  assert.equal(host.COORDINATION_PORT, COORDINATION_PORT);
  assert.ok(leafIdentity({ namespace: "pilotswarm" }).names.includes(`DNS:${new URL(values.PS_COORDINATION_URL).hostname}`));
  assert.equal(host.coordinationUrl({ NAMESPACE: "stamp-ns" }), "https://pilotswarm-disk-controller-coordination.stamp-ns.svc:3005");
  // The capacity requester's own checks take them, on a worker without an owner tag.
  assert.deepEqual(settingsFromEnv(values), { url: "https://pilotswarm-disk-controller-coordination.pilotswarm.svc:3005", scope: `${PORTAL_APP}/.default` });

  const withPrefixes = envValues(join(stage(t, "worker", hostEnv({ WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: "acme_,acme_, sk-live-" })),
    "components/coordination-host/coordination-host.properties"));
  assert.equal(withPrefixes.PILOTSWARM_REDACT_SECRET_PREFIXES, "acme_,sk-live-");

  const objects = render(t, join(stage(t, "worker", hostEnv()), "overlays/default"));
  if (!objects) return;
  const rendered = configMap(objects, "coordination-host-env").data;
  assert.deepEqual(rendered, values);
  // Nothing the worker reads sets an owner tag or owner-only mode.
  const worker = workerContainer(workerDeployment(objects));
  const all = { ...configMap(objects, "worker-env").data, ...rendered, ...envOf(worker) };
  assert.ok(!("PILOTSWARM_WORKER_OWNER_TAG" in all) && !("PILOTSWARM_WORKER_OWNER_ONLY" in all));
  assert.doesNotThrow(() => settingsFromEnv(all));
});

// The fixed contents PILOTSWARM_CLI_DISABLE_HOOKS=1 checks, from the SDK's
// source (packages/sdk/src/cli-hooks.ts).
function sdkCliHomeTexts() {
  const hooks = readFileSync(join(REPO_ROOT, "packages/sdk/src/cli-hooks.ts"), "utf8");
  const settings = /export const CLI_HOOKS_OFF_SETTINGS_TEXT = '([^']*)';/.exec(hooks)[1].replace(/\\n/g, "\n");
  const commentLines = [.../const CLI_CONFIG_COMMENT_LINES = \[([\s\S]*?)\];/.exec(hooks)[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const configTail = /CLI_HOOKS_OFF_CONFIG_TEXT = `\$\{CLI_CONFIG_COMMENT_LINES\.join\("\\n"\)\}([^`]*)`;/.exec(hooks)[1].replace(/\\n/g, "\n");
  return { settings, config: `${commentLines.join("\n")}${configTail}` };
}

// The Windows image's placeholder defaults (-CopilotHomeFiles, -CopilotHomeFolders).
function windowsPlaceholders(name) {
  const image = readFileSync(join(AZURE, "windows/Build-WorkerOsImage.ps1"), "utf8");
  return [...new RegExp(`\\[string\\[\\]\\]\\$${name} = @\\(([^)]*)\\)`).exec(image)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// What a file placeholder holds on Windows (Get-CopilotHomePlaceholderText): its entry in
// $script:CopilotHomeFileText, else {} for a JSON file and nothing for any other.
function windowsPlaceholderText(name) {
  const image = readFileSync(join(AZURE, "windows/Build-WorkerOsImage.ps1"), "utf8");
  const table = /\$script:CopilotHomeFileText = \[ordered\]@\{([\s\S]*?)\r?\n\}/.exec(image)[1];
  const texts = Object.fromEntries([...table.matchAll(/'([^']+)' = '([^']*)'/g)].map((m) => [m[1], m[2]]));
  return name in texts ? texts[name] : name.endsWith(".json") ? "{}" : "";
}

test("the init container prepares the CLI home as the Windows image does: the same read-only placeholders, the fixed settings, session-state the worker's", () => {
  const patch = yamlFile(join(COMPONENT, "deployment-patch.yaml"));
  const [init] = patch.spec.template.spec.initContainers;
  assert.equal(init.name, "init-copilot-home", "the base's init container, which runs as root");
  const base = yamlFile(join(WORKER_GITOPS, "base/deployment.yaml")).spec.template.spec.initContainers[0];
  assert.deepEqual(base.securityContext, { runAsUser: 0, runAsGroup: 0 });
  assert.deepEqual(init.command.slice(0, 2), ["sh", "-c"]);
  const script = init.command[2];
  const lines = script.split("\n").map((line) => line.trim());
  assert.equal(lines[0], "set -eu");
  assert.ok(lines.includes("home=/home/node/.copilot"));
  // The folder: root's, group 1000 may add files, the sticky bit protects the rest.
  assert.ok(lines.includes('chown 0:1000 "$home"') && lines.includes('chmod 1775 "$home"'));
  assert.ok(lines.includes('chown 1000:1000 "$home/session-state"'));
  // Root-owned and read-only: the two settings files and the file
  // placeholders, then the folder placeholders.
  const loop = (pattern) => new RegExp(`^for name in ([^;]+); do\\n\\s*${pattern}`, "m").exec(script)[1].trim().split(/\s+/);
  assert.deepEqual(loop('chown 0:0 "\\$home/\\$name"\\n\\s*chmod 0444'), ["settings.json", "config.json", ...windowsPlaceholders("CopilotHomeFiles")]);
  assert.deepEqual(loop('mkdir -p "\\$home/\\$name"\\n\\s*chown 0:0 "\\$home/\\$name"\\n\\s*chmod 0555'), windowsPlaceholders("CopilotHomeFolders"));

  // The CLI home and the session state folder the hooks setting requires.
  const env = Object.fromEntries(patch.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
  assert.equal(env.SESSION_STATE_DIR, posix.join(env.COPILOT_HOME, "session-state"));
  const baseMount = yamlFile(join(WORKER_GITOPS, "base/deployment.yaml")).spec.template.spec.containers[0].volumeMounts
    .find((m) => m.name === "copilot-home");
  assert.equal(baseMount.mountPath, env.COPILOT_HOME);
});

test("run, the CLI home's init container writes the settings in the SDK's fixed form, and every placeholder", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ps-coordination-host-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = yamlFile(join(COMPONENT, "deployment-patch.yaml")).spec.template.spec.initContainers[0].command[2];
  const ran = runInitScript(t, script, { "home=/home/node/.copilot": home });
  if (!ran) return;
  assert.equal(ran.status, 0, ran.stderr);
  const texts = sdkCliHomeTexts();
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), texts.settings);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), texts.config);
  assert.deepEqual(JSON.parse(texts.settings), { disableAllHooks: true });
  const files = windowsPlaceholders("CopilotHomeFiles");
  const folders = windowsPlaceholders("CopilotHomeFolders");
  assert.deepEqual(listTree(home), ["config.json", "session-state/", "settings.json", ...files, ...folders.map((f) => `${f}/`)].sort());
  // As on Windows: each file placeholder holds what the CLI reads as no configuration.
  for (const name of files) assert.equal(readFileSync(join(home, name), "utf8"), windowsPlaceholderText(name), name);
  // Run again on the same folder, as after a pod restart: the same result.
  assert.equal(runInitScript(t, script, { "home=/home/node/.copilot": home }).status, 0);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), texts.config);
});

test("the plugin ConfigMap: a read-only copy of only the plugin's definitions, which PLUGIN_DIRS names; none without the setting", (t) => {
  const root = stage(t, "worker", hostEnv({ WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: "host-plugin" }));
  assert.deepEqual(componentsOf(root),
    ["../../components/coordination-host", "../../components/coordination-host-plugin", "../../components/worker-replacements"]);
  const patch = yamlFile(join(root, "components/coordination-host-plugin/deployment-patch.yaml"));
  const spec = patch.spec.template.spec;
  assert.deepEqual(spec.volumes.find((v) => v.name === "coordination-plugin-source").configMap, { name: "host-plugin" });
  assert.match(readFileSync(join(PLUGIN_COMPONENT, "deployment-patch.yaml"), "utf8"), new RegExp(host.PLUGIN_CONFIGMAP_PLACEHOLDER));
  const script = spec.initContainers[0].command[2];
  assert.match(script, /chown -R 0:0 "\$dst"/);
  assert.match(script, /find "\$dst" -type f -exec chmod 0444 \{\} \\;/);
  assert.match(script, /find "\$dst" -type d -exec chmod 0555 \{\} \\;/);
  const container = spec.containers[0];
  assert.deepEqual(container.env, [{ name: "PLUGIN_DIRS", value: "/app/coordination-plugin" }]);
  assert.deepEqual(container.volumeMounts, [{ name: "coordination-plugin", mountPath: "/app/coordination-plugin", readOnly: true }]);

  const objects = render(t, join(root, "overlays/default"));
  if (!objects) return;
  const rendered = workerDeployment(objects);
  assert.equal(envOf(workerContainer(rendered)).PLUGIN_DIRS, "/app/coordination-plugin");
  assert.deepEqual(podSpec(rendered).initContainers.map((c) => c.name).sort(), ["init-coordination-plugin", "init-copilot-home"]);
  const without = render(t, join(stage(t, "worker", hostEnv()), "overlays/default"));
  assert.ok(!("PLUGIN_DIRS" in envOf(workerContainer(workerDeployment(without)))), "the image's own plugin detection");
  assert.ok(!podSpec(workerDeployment(without)).volumes.some((v) => v.name.startsWith("coordination-plugin")));
});

test("run, the plugin's init container copies only the definitions, into the plugin's layout", (t) => {
  const source = mkdtempSync(join(tmpdir(), "ps-coordination-host-plugin-src-"));
  const target = mkdtempSync(join(tmpdir(), "ps-coordination-host-plugin-dst-"));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  const files = {
    "plugin.json": '{"name":"example"}',
    "session-policy.json": '{"creation":{}}',
    "builder.agent.md": "---\nname: builder\n---\nBuild.",
    "review.SKILL.md": "---\nname: review\n---\nReview.",
    "review.tools.json": '["view"]',
    // Never copied: an MCP server, a tool module, anything else.
    ".mcp.json": '{"server":{"command":"node"}}',
    "worker-module.js": "export default {};",
    "notes.md": "notes",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  const script = yamlFile(join(PLUGIN_COMPONENT, "deployment-patch.yaml")).spec.template.spec.initContainers[0].command[2];
  const ran = runInitScript(t, script, { "src=/plugin-source": source, "dst=/coordination-plugin": target });
  if (!ran) return;
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(listTree(target), [
    "agents/", "agents/builder.agent.md", "plugin.json", "session-policy.json",
    "skills/", "skills/review/", "skills/review/SKILL.md", "skills/review/tools.json",
  ]);
  assert.equal(readFileSync(join(target, "skills/review/SKILL.md"), "utf8"), files["review.SKILL.md"]);
  assert.equal(readFileSync(join(target, "agents/builder.agent.md"), "utf8"), files["builder.agent.md"]);

  // Without plugin.json the pod does not start.
  rmSync(join(source, "plugin.json"));
  const empty = mkdtempSync(join(tmpdir(), "ps-coordination-host-plugin-dst-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const failed = runInitScript(t, script, { "src=/plugin-source": source, "dst=/coordination-plugin": empty });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /the plugin ConfigMap has no plugin\.json/);
  assert.deepEqual(listTree(empty), []);
});

test("with the host, the staged catalog's Foundry providers take the host's identity in key mode too; the portal keeps the key", (t) => {
  const foundry = { FOUNDRY_ENABLED: "true", FOUNDRY_ENDPOINT: "https://example-foundry.cognitiveservices.azure.com/", FOUNDRY_AUTH_MODE: "key" };
  const catalog = (root) => JSON.parse(readFileSync(join(root, "base/model_providers.json"), "utf8")).providers;
  const keyed = (providers) => providers.filter((p) => p.apiKey === "env:AZURE_OAI_KEY").map((p) => p.id);
  const source = catalog(WORKER_GITOPS);
  assert.ok(keyed(source).length > 0, "the catalog has Foundry providers on the key");
  const worker = catalog(stage(t, "worker", hostEnv(foundry)));
  assert.deepEqual(keyed(worker), []);
  assert.deepEqual(worker.filter((p) => p.type === "foundry-wif").map((p) => p.id), keyed(source));
  assert.deepEqual(keyed(catalog(stage(t, "portal", hostEnv(foundry)))), keyed(source));
  assert.deepEqual(keyed(catalog(stage(t, "worker", stampEnv(foundry)))), keyed(source), "without the pool, as before");
});

// ─── Bicep ───

// `resource|module <symbol> '<target>' = if (<condition>) {` → condition.
function conditionOf(source, symbol) {
  const match = new RegExp(`^(?:resource|module) ${symbol} '[^']+' = (?:if \\((.*)\\) )?[{[]`, "m").exec(source);
  assert.ok(match, `${symbol} is declared`);
  return match[1];
}

// The text of a top-level declaration, up to the next one.
function blockOf(source, symbol) {
  const start = source.search(new RegExp(`^(?:resource|module|var|output) ${symbol}\\b`, "m"));
  assert.ok(start >= 0, `${symbol} is declared`);
  const next = source.slice(start + 1).search(/^(?:resource|module|var|output|param|@)/m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("the host's identity: only with the pool and the host, federated with the worker's service account, Blob on copilot-sessions and Foundry", () => {
  const main = readBicep("main.bicep");
  assert.match(main, /^param winWorkerCoordinationHost bool = false\s*$/m);
  const uami = readBicep("uami.bicep");
  assert.match(uami, /^var coordinationHost = winWorkersEnabled && coordinationHostEnabled\s*$/m);
  assert.equal(conditionOf(uami, "coordinationHostIdentity"), "coordinationHost");
  assert.match(blockOf(uami, "coordinationHostIdentity"), /name: '\$\{resourceNamePrefix\}-linux-worker-mid'/);
  for (const [output, value] of [["Name", "coordinationHostIdentity\\.name"], ["PrincipalId", "coordinationHostIdentity!\\.properties\\.principalId"],
    ["ClientId", "coordinationHostIdentity!\\.properties\\.clientId"]]) {
    assert.match(uami, new RegExp(`^output coordinationIdentity${output} string = coordinationHost \\? ${value} : ''\\s*$`, "m"), output);
  }
  assert.match(blockOf(main, "Uami"), /coordinationHostEnabled: winWorkerCoordinationHost/);

  const federation = readBicep("uami-federation.bicep");
  assert.match(federation, /^param coordinationHostIdentityName string = ''\s*$/m);
  assert.match(federation, /^param winWorkersEnabled bool = false\s*$/m);
  // With the pool, no pod of the worker's service account may sign in as the
  // portal's identity: the coordination host has its own.
  assert.equal(conditionOf(federation, "workerFederation"), "!winWorkersEnabled");
  assert.equal(conditionOf(federation, "coordinationHostFederation"), "!empty(coordinationHostIdentityName)");
  const hostCredential = blockOf(federation, "coordinationHostFederation");
  assert.match(hostCredential, /parent: coordinationHostIdentity\b/);
  assert.match(hostCredential, /subject: 'system:serviceaccount:\$\{serviceAccountNamespace\}:\$\{workerServiceAccountName\}'/);
  assert.match(blockOf(federation, "workerFederation"), /subject: 'system:serviceaccount:\$\{serviceAccountNamespace\}:\$\{workerServiceAccountName\}'/);
  assert.match(federation, /^param workerServiceAccountName string = 'copilot-runtime-worker'\s*$/m);
  assert.match(blockOf(main, "UamiFederation"), /coordinationHostIdentityName: Uami\.outputs\.coordinationIdentityName/);
  assert.match(blockOf(main, "UamiFederation"), /winWorkersEnabled: winWorkersEnabled/);

  const storage = readBicep("storage.bicep");
  assert.equal(conditionOf(storage, "assignSessionsContributorToCoordinationHost"), "winWorkersEnabled && !empty(coordinationHostPrincipalId)");
  assert.match(blockOf(storage, "assignSessionsContributorToCoordinationHost"), /scope: sessionsContainer\b[\s\S]*principalId: coordinationHostPrincipalId[\s\S]*blobDataContributorDef/);
  assert.match(blockOf(main, "Storage"), /coordinationHostPrincipalId: Uami\.outputs\.coordinationIdentityPrincipalId/);

  const winWorkers = readBicep("win-workers.bicep");
  assert.equal(conditionOf(winWorkers, "coordinationHostFoundryRole"), "!empty(foundryAccountName) && !empty(coordinationHostPrincipalId)");
  assert.match(blockOf(winWorkers, "coordinationHostFoundryRole"),
    /scope: foundryAccount\b[\s\S]*principalId: coordinationHostPrincipalId[\s\S]*cognitiveServicesOpenAiUserRoleId/);
  assert.match(winWorkers, /^var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'\s*$/m);
  assert.match(blockOf(main, "WinWorkers"), /coordinationHostPrincipalId: Uami\.outputs\.coordinationIdentityPrincipalId/);
});

const templateFor = (module) => join(AZURE, `services/${module}/bicep/${module}.params.template.json`);
function renderBaseInfra(env) {
  const dir = mkdtempSync(join(tmpdir(), "ps-coordination-host-params-"));
  try {
    const { renderedPath } = renderParams({ module: "base-infra", templatePath: templateFor("base-infra"), envMap: env, outDir: dir });
    return JSON.parse(readFileSync(renderedPath, "utf8")).parameters;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What base-infra's parameters need besides template.env, and the custom
// role definitions the pool's deploy step finds.
const PARAMS_ENV = Object.freeze({
  ...parseEnvFile(templateEnvPath()),
  SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT, RESOURCE_PREFIX: "psstamp", RESOURCE_GROUP: "stamp-rg",
  PORTAL_RESOURCE_NAME: "psstamp-wus3-portal", FRONT_DOOR_ID: "fixture-front-door", FRONT_DOOR_PROFILE_NAME: "fixture-profile",
  FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg", FRONT_DOOR_ENDPOINT_NAME: "fixture-endpoint",
  APPLICATION_GATEWAY_NAME: "psstamp-appgw", PRIVATE_LINK_CONFIGURATION_NAME: "privateLinkConfig",
  APPROVAL_MANAGED_IDENTITY_ID: "/subscriptions/fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/approver",
  DEPLOYMENT_STORAGE_ACCOUNT_NAME: "psstampsa", AKS_CLUSTER_NAME: "psstamp-aks", KV_NAME: "psstampkv",
  PORTAL_HOSTNAME: "portal.example.com", PRIVATE_DNS_ZONE: "unused", AKS_VNET_ID: "unused", ACME_EMAIL: "operator@example.com",
  PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP,
  WIN_WORKER_CONTROLLER_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000001",
  WIN_WORKER_SUBNET_JOIN_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000002",
  WIN_WORKER_VAULT_WRITER_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000003",
});

test("the rendered parameters name the host with the pool; without the pool they are as before", () => {
  const off = renderBaseInfra({ ...PARAMS_ENV });
  const on = renderBaseInfra({ ...PARAMS_ENV, ...HOST });
  assert.equal(off.winWorkerCoordinationHost, undefined);
  assert.equal(off.winWorkersEnabled, undefined);
  assert.deepEqual(on.winWorkerCoordinationHost, { value: true });
  assert.deepEqual(on.winWorkersEnabled, { value: true });
});

// `az bicep build` to a file: `--stdout` fails on a console that can't print
// the compiled template's characters.
const bicepWorks = (() => {
  try {
    return run("az", ["bicep", "version"], { capture: true, allowFail: true }).status === 0;
  } catch {
    return false;
  }
})();

function buildBicep(t, file) {
  const dir = mkdtempSync(join(tmpdir(), "ps-coordination-host-bicep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = join(dir, `${file}.json`);
  const result = run("az", ["bicep", "build", "--file", join(BICEP, file), "--outfile", outfile], { capture: true, allowFail: true });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  return JSON.parse(readFileSync(outfile, "utf8"));
}

// A nested deployment of the compiled main template, by its module's name,
// `${resourceNamePrefix}-<part>-${dTime}`.
const nested = (template, part) => {
  const found = template.resources.filter((r) => r.type === "Microsoft.Resources/deployments" && String(r.name).includes(`'{0}-${part}-{1}'`));
  assert.equal(found.length, 1, part);
  return found[0];
};
const resourcesOf = (deployment) => {
  const resources = deployment.properties.template.resources;
  return Array.isArray(resources) ? resources : Object.values(resources);
};

test("compiled, the Bicep creates no worker-fedcred once the rendered parameters turn the pool on", { timeout: 600_000 }, (t) => {
  if (!bicepWorks) {
    t.skip("the Azure CLI with Bicep is not installed");
    return;
  }
  const template = buildBicep(t, "main.bicep");
  // main → Uami: the host's switch.
  const uami = nested(template, "uami");
  assert.equal(uami.properties.parameters.coordinationHostEnabled.value, "[parameters('winWorkerCoordinationHost')]");
  const inner = uami.properties.template;
  assert.equal(inner.variables.coordinationHost, "[and(parameters('winWorkersEnabled'), parameters('coordinationHostEnabled'))]");
  assert.match(inner.outputs.coordinationIdentityName.value, /^\[if\(variables\('coordinationHost'\), /);
  // main → UamiFederation: the pool's switch, and the host's identity's
  // name, empty without the host.
  const federation = nested(template, "uami-fed");
  assert.equal(federation.properties.parameters.winWorkersEnabled.value, "[parameters('winWorkersEnabled')]");
  assert.match(federation.properties.parameters.coordinationHostIdentityName.value, /\.outputs\.coordinationIdentityName\.value\]$/);
  const credentials = resourcesOf(federation);
  const byName = (name) => credentials.find((r) => String(r.name).endsWith(`'${name}')]`) || String(r.name).endsWith(`/${name}`));
  assert.equal(byName("worker-fedcred").condition, "[not(parameters('winWorkersEnabled'))]");
  assert.equal(byName("coordination-host-fedcred").condition, "[not(empty(parameters('coordinationHostIdentityName')))]");
  // The rendered parameters: the pool turns the pool's switch on, so
  // worker-fedcred's condition is false, and only without the pool true.
  for (const [settings, pool] of [[HOST, true], [{}, false]]) {
    const params = renderBaseInfra({ ...PARAMS_ENV, ...settings });
    assert.equal(params.winWorkersEnabled?.value === true, pool, JSON.stringify(settings));
  }
  const params = renderBaseInfra({ ...PARAMS_ENV, ...HOST });
  assert.equal(params.winWorkersEnabled.value && params.winWorkerCoordinationHost.value, true);
  const alerts = nested(template, "win-worker-alerts");
  assert.equal(alerts.properties.parameters.coordinationHost.value, "[parameters('winWorkerCoordinationHost')]");
  const rule = resourcesOf(alerts).find((r) => r.type === "Microsoft.Insights/scheduledQueryRules" && !r.copy);
  assert.equal(rule.condition, "[parameters('coordinationHost')]");
});

test("the capacity alert: with the host only, on requests the controller has left unanswered for 5 minutes", () => {
  const alerts = readBicep("win-worker-alerts.bicep");
  assert.match(alerts, /^param coordinationHost bool = false\s*$/m);
  assert.equal(conditionOf(alerts, "capacityRequestAlert"), "coordinationHost");
  const rule = blockOf(alerts, "capacityRequestAlert");
  assert.match(rule, /name: '\$\{resourceNamePrefix\}-capacity-request-unanswered'/);
  assert.match(rule, /scopes: \[\s*mainWorkspaceId\s*\]/);
  assert.match(rule, /actionGroups: \[\s*actionGroup\.id\s*\]/);
  assert.match(rule, /evaluationFrequency: 'PT5M'/);
  assert.match(rule, /query: '\$\{capacityRequestLets\}\\n\$\{capacityRequestPipeline\}'/);
  const lets = blockOf(alerts, "capacityRequestLets");
  assert.match(lets, /ContainerLogV2 \| where PodNamespace == "\$\{namespace\}" and ContainerName == "worker"/);
  assert.match(lets, /line contains "\[requestOwnerCapacity\]"/);
  assert.match(lets, /not\(line contains_cs "CAPACITY_UNAVAILABLE"\)/);
  assert.match(lets, /where isnull\(answered\) or TimeGenerated > answered/);
  const pipeline = blockOf(alerts, "capacityRequestPipeline");
  assert.match(pipeline, /toscalar\(unanswered \| summarize min\(TimeGenerated\)\) \+ 5m/);
  assert.match(pipeline, /newRows/);
  assert.match(blockOf(readBicep("main.bicep"), "WinWorkerAlerts"), /coordinationHost: winWorkerCoordinationHost/);
  // What the worker writes: the activity's trace of each answer, and the code of an unanswered one.
  const sdk = (file) => readFileSync(join(REPO_ROOT, "packages/sdk/src", file), "utf8");
  assert.match(sdk("session-proxy.ts"), /`\[requestOwnerCapacity\] session=\$\{input\.sessionId\} owner=\$\{input\.ownerTag\}: \$\{answer\.decision\}`/);
  assert.match(sdk("owner-routing.ts"), /export const CAPACITY_UNAVAILABLE = "CAPACITY_UNAVAILABLE";/);
  assert.match(readFileSync(join(WORKER_GITOPS, "base/deployment.yaml"), "utf8"), /containers:\s*- name: worker\b/);
});

// ─── The Windows worker deploy step ───

const STEP_ENV = Object.freeze({
  SUBSCRIPTION_ID: SUBSCRIPTION, RESOURCE_GROUP: "stamp-rg", RESOURCE_PREFIX: "psstamp", NAMESPACE: "pilotswarm", KV_NAME: "psstampkv",
  ...OUTPUTS, ...HOST,
});

const option = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

// The portal identity's federated credentials, which the step lists and
// deletes: each delete removes the credential, unless it is `sticky` or the
// delete gets `deleteAnswer`. `goneAfterDelete` removes it whatever the
// delete answers, as when another run deleted it first. Other calls go to the
// TLS step's vaults, the cluster's credentials and kubectl.
function fakeStepTools({ credentials, sticky = [], deleteAnswer, goneAfterDelete = false, nextCa } = {}) {
  const pki = createTestPki({ names: leafIdentity({ namespace: "pilotswarm" }).names, commonName: leafIdentity({ namespace: "pilotswarm" }).commonName });
  const vaults = createFakeAz();
  vaults.vault("psstampkvdep").set(CA_CERT_SECRET, pki.caPem);
  if (nextCa) vaults.vault("psstampkvdep").set(NEXT_CA_CERT_SECRET, nextCa);
  vaults.vault("psstampkv").set(LEAF_SECRET, pki.issueLeaf().bundle);
  let current = [...credentials];
  const calls = [];
  const applied = [];
  const runFn = (name, args, opts) => {
    calls.push({ name, args, opts });
    if (name === "kubectl") {
      applied.push(readFileSync(option(args, "--filename"), "utf8"));
      return { status: 0, stdout: "", stderr: "" };
    }
    const is = (...words) => words.every((word, i) => args[i] === word);
    if (is("identity", "federated-credential", "list")) return { status: 0, stdout: JSON.stringify(current), stderr: "" };
    if (is("identity", "federated-credential", "delete")) {
      const name = option(args, "--name");
      if (goneAfterDelete || (!deleteAnswer && !sticky.includes(name))) current = current.filter((c) => c.name !== name);
      return deleteAnswer ?? { status: 0, stdout: "", stderr: "" };
    }
    if (is("aks", "get-credentials")) return { status: 0, stdout: "", stderr: "" };
    if (name === "openssl") return { status: 1, stdout: "", stderr: "the leaf is current: no openssl call expected" };
    return vaults.az(args);
  };
  const verbs = () => calls.map(({ name, args }) => (name === "kubectl" ? `kubectl ${args[0]}` : args.slice(0, 3).join(" ")));
  return { runFn, calls, verbs, applied, caPem: pki.caPem };
}

function privateTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "ps-coordination-host-step-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const credential = (name, subject) => ({ name, subject, issuer: "https://oidc.example.com/", audiences: ["api://AzureADTokenExchange"] });

test("before the worker's manifests: the portal identity's credentials for the worker's service account go first, then the controller's CA reaches the cluster", (t) => {
  const tools = fakeStepTools({ credentials: [
    credential("worker-fedcred", WORKER_SUBJECT),
    credential("portal-fedcred", "system:serviceaccount:pilotswarm:pilotswarm-portal"),
    credential("hand-made", WORKER_SUBJECT),
  ] });
  const stagingDir = privateTmp(t);
  assert.equal(step.beforeWorkerManifests({ env: { ...STEP_ENV }, stagingDir }, { runFn: tools.runFn, tmpRoot: privateTmp(t) }), true);
  const verbs = tools.verbs();
  assert.deepEqual(verbs.slice(0, 4), [
    "identity federated-credential list", "identity federated-credential delete", "identity federated-credential delete",
    "identity federated-credential list",
  ]);
  const deleted = tools.calls.filter(({ args }) => args[2] === "delete").map(({ args }) => args);
  assert.deepEqual(deleted.map((args) => option(args, "--name")), ["worker-fedcred", "hand-made"]);
  for (const args of deleted) {
    assert.equal(option(args, "--identity-name"), "psstamp-csi-mid");
    assert.equal(option(args, "--resource-group"), "stamp-rg");
    assert.ok(args.includes("--yes"));
  }
  // Then the TLS step's reads and grant, the cluster's credentials and the CA.
  assert.ok(verbs.indexOf("aks get-credentials --resource-group") > 3);
  assert.equal(verbs.at(-1), "kubectl apply");
  const applied = tools.calls.at(-1);
  assert.equal(applied.opts.env.KUBECONFIG, join(stagingDir, "kubeconfig"));
  assert.ok(!tools.calls.some(({ args }) => args[0] === "network"), "no App Gateway call: that is the controller's step");

  // Nothing to delete: the two lists only.
  const clean = fakeStepTools({ credentials: [credential("portal-fedcred", "system:serviceaccount:pilotswarm:pilotswarm-portal")] });
  assert.equal(step.deleteWorkerFederatedCredential({ ...STEP_ENV }, { runFn: clean.runFn }), 0);
  assert.deepEqual(clean.verbs(), ["identity federated-credential list", "identity federated-credential list"]);

  // Without the pool the worker signs in with that credential: the step touches nothing.
  const off = fakeStepTools({ credentials: [credential("worker-fedcred", WORKER_SUBJECT)] });
  assert.equal(step.beforeWorkerManifests({ env: { ...STEP_ENV, WIN_WORKERS_ENABLED: "false" }, stagingDir }, { runFn: off.runFn }), false);
  assert.deepEqual(off.calls, []);
});

test("before the worker's manifests, the cluster gets the trusted CA bundle; with two CAs the host's staging gets its hash, with one nothing", (t) => {
  const one = fakeStepTools({ credentials: [] });
  const env = { ...STEP_ENV, [host.COORDINATION_HOST_CA_HASH_KEY]: "stale" };
  step.beforeWorkerManifests({ env, stagingDir: privateTmp(t) }, { runFn: one.runFn, tmpRoot: privateTmp(t) });
  assert.equal(env[host.COORDINATION_HOST_CA_HASH_KEY], undefined, "one CA: the pod template stays as it was");
  assert.deepEqual(one.applied, [caClusterManifest({ namespace: "pilotswarm", caPem: one.caPem })]);

  const next = createTestPki({ caName: "Next CA" }).caPem;
  const two = fakeStepTools({ credentials: [], nextCa: next });
  const rotating = { ...STEP_ENV };
  step.beforeWorkerManifests({ env: rotating, stagingDir: privateTmp(t) }, { runFn: two.runFn, tmpRoot: privateTmp(t) });
  const bundle = caBundle([two.caPem, next]);
  assert.deepEqual(two.applied, [caClusterManifest({ namespace: "pilotswarm", caPem: bundle })]);
  assert.equal(rotating[host.COORDINATION_HOST_CA_HASH_KEY], host.caBundleHash(bundle));
  // And the worker's staging puts that hash on the host's pod template.
  const root = stage(t, "worker", hostEnv({ [host.COORDINATION_HOST_CA_HASH_KEY]: rotating[host.COORDINATION_HOST_CA_HASH_KEY] }));
  assert.match(readFileSync(join(root, "components/coordination-host-ca/kustomization.yaml"), "utf8"),
    new RegExp(`${host.COORDINATION_HOST_CA_ANNOTATION.replace(/[./]/g, "\\$&")}: ${host.caBundleHash(bundle)}`));
});

test("while a credential for the worker's service account remains, the step fails before anything reaches the cluster", (t) => {
  for (const [tools, message] of [
    [fakeStepTools({ credentials: [credential("worker-fedcred", WORKER_SUBJECT)], sticky: ["worker-fedcred"] }),
      /psstamp-csi-mid still has a federated credential for the worker's service account \(worker-fedcred\)/],
    [fakeStepTools({ credentials: [credential("worker-fedcred", WORKER_SUBJECT)], deleteAnswer: { status: 1, stdout: "", stderr: "ERROR: (AuthorizationFailed) no access" } }),
      /Could not delete the federated credential worker-fedcred of the portal identity psstamp-csi-mid: ERROR: \(AuthorizationFailed\)/],
  ]) {
    assert.throws(() => step.beforeWorkerManifests({ env: { ...STEP_ENV }, stagingDir: privateTmp(t) }, { runFn: tools.runFn, tmpRoot: privateTmp(t) }),
      message);
    assert.ok(!tools.calls.some(({ name, args }) => name === "kubectl" || args[0] === "aks"), "nothing reached the cluster");
  }
  // A credential another run deleted first counts as deleted, once the
  // second list no longer shows it.
  const gone = fakeStepTools({ credentials: [credential("worker-fedcred", WORKER_SUBJECT)], goneAfterDelete: true,
    deleteAnswer: { status: 3, stdout: "", stderr: "ERROR: (NotFound) The federated identity credential was not found." } });
  assert.equal(step.deleteWorkerFederatedCredential({ ...STEP_ENV }, { runFn: gone.runFn }), 1);
});

// ─── deploy.mjs: the step's place, and the worker image ───

test("the worker image is built with COPILOT_PKG_CACHE_HOME only with the host, at the path the host's pods name", () => {
  assert.deepEqual(host.workerImageBuildArgs("worker", hostEnv()), { COPILOT_PKG_CACHE_HOME: "/app/copilot-pkg" });
  for (const [service, env] of [["portal", hostEnv()], ["worker", stampEnv()]]) {
    assert.deepEqual(host.workerImageBuildArgs(service, env), {}, `${service} ${env.WIN_WORKER_COORDINATION_HOST ?? "off"}`);
  }
  const deploy = readFileSync(join(REPO_ROOT, "deploy/scripts/deploy.mjs"), "utf8");
  assert.match(deploy, /buildArgs: workerImageBuildArgs\(ctx\.service, ctx\.env\)/);
});

// An Azure CLI and a kubectl on PATH that log each call. The CLI answers what
// the worker's manifests step asks with the host on: the portal identity's
// federated credentials (deleted unless sticky), the TLS step's secrets and
// grant, the cluster's credentials and the manifest upload, whose staged
// overlay it keeps.
const FAKE_AZ = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const option = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const record = (extra = {}) => fs.appendFileSync(process.env.CH_TEST_CALLS, JSON.stringify({ tool: "az", args, ...extra }) + "\n");
const is = (...words) => words.every((word, i) => args[i] === word);
const answers = JSON.parse(fs.readFileSync(process.env.CH_TEST_ANSWERS, "utf8"));
const statePath = process.env.CH_TEST_ANSWERS + ".credentials";
const credentials = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : answers.credentials);
if (is("--version")) { console.log("azure-cli (test)"); process.exit(0); }
if (is("account", "show")) { console.log(answers.subscription); process.exit(0); }
if (is("storage", "blob", "upload-batch")) {
  const source = option("--source");
  const read = (rel) => (fs.existsSync(path.join(source, rel)) ? fs.readFileSync(path.join(source, rel), "utf8") : null);
  fs.appendFileSync(process.env.CH_TEST_CALLS, JSON.stringify({ tool: "upload", overlay: read("overlays/default/kustomization.yaml"),
    env: read("overlays/default/.env"), hostEnv: read("components/coordination-host/coordination-host.properties") }) + "\n");
  process.exit(0);
}
record();
if (is("identity", "federated-credential", "list")) { console.log(JSON.stringify(credentials())); process.exit(0); }
if (is("identity", "federated-credential", "delete")) {
  if (!answers.sticky) fs.writeFileSync(statePath, JSON.stringify(credentials().filter((c) => c.name !== option("--name"))));
  process.exit(0);
}
if (is("keyvault", "secret", "list")) {
  console.log(JSON.stringify(Object.keys(answers.secrets).map((name) => ({ name, attributes: { enabled: true } }))));
  process.exit(0);
}
if (is("keyvault", "secret", "show")) {
  const value = answers.secrets[option("--name")];
  if (value === undefined) { console.error("ERROR: (SecretNotFound) A secret with (name/id) " + option("--name") + " was not found in this key vault."); process.exit(3); }
  console.log(JSON.stringify(value));
  process.exit(0);
}
if (is("role", "assignment", "create")) process.exit(0);
if (is("aks", "get-credentials")) process.exit(0);
if (is("storage", "blob", "list")) process.exit(0);
console.error("unexpected az call");
process.exit(9);
`;

const FAKE_KUBECTL = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--filename");
fs.appendFileSync(process.env.CH_TEST_CALLS, JSON.stringify({ tool: "kubectl", args, manifest: at >= 0 ? fs.readFileSync(args[at + 1], "utf8") : null }) + "\n");
process.exit(0);
`;

let sequence = 0;
const WORKER_MANIFESTS = (name) => ["worker", name, "--steps", "manifests", "--image-tag", "fixture"];
function deployWorkerManifests(t, { settings = {}, credentials = [], sticky = false, argv = WORKER_MANIFESTS } = {}) {
  const name = `ch${process.pid.toString(36)}${sequence++}`;
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  const dir = mkdtempSync(join(tmpdir(), "ps-coordination-host-deploy-"));
  t.after(() => {
    for (const path of [local, dir, join(REPO_ROOT, "deploy/.tmp", name), ...ALL_SEQUENCE.map((service) => join(REPO_ROOT, "deploy/.tmp", `${service}-${name}`))]) {
      rmSync(path, { recursive: true, force: true });
    }
  });
  const pki = createTestPki({ names: leafIdentity({ namespace: "pilotswarm" }).names, commonName: leafIdentity({ namespace: "pilotswarm" }).commonName });
  const env = {
    ...parseEnvFile(templateEnvPath()),
    SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT,
    RESOURCE_PREFIX: "psstamp", RESOURCE_GROUP: "stamp-rg", PORTAL_RESOURCE_NAME: "psstamp-portal",
    GLOBAL_RESOURCE_PREFIX: "psstampglobal", GLOBAL_RESOURCE_GROUP: "psstampglobal",
    FRONT_DOOR_ID: "fixture", FRONT_DOOR_PROFILE_NAME: "fixture", FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture",
    ACME_EMAIL: "operator@example.invalid", PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP, PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    // base-infra's outputs from an earlier deploy, as the outputs cache holds them.
    ...OUTPUTS,
    KV_NAME: "psstampkv", ACR_LOGIN_SERVER: "stub.azurecr.io", DEPLOYMENT_STORAGE_ACCOUNT_NAME: "psstampsa",
    POSTGRES_FQDN: "stamp-pg.postgres.database.azure.com", POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "psstamp-csi-mid",
    BLOB_CONTAINER_ENDPOINT: "https://example.blob.core.windows.net/",
    ...settings,
  };
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  for (const [tool, source] of [["az", FAKE_AZ], ["kubectl", FAKE_KUBECTL]]) {
    writeFileSync(join(dir, `${tool}.cjs`), source);
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${tool}.cmd`), `@"${process.execPath}" "%~dp0${tool}.cjs" %*\r\n`);
    } else {
      writeFileSync(join(dir, tool), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${tool}.cjs" "$@"\n`, { mode: 0o755 });
    }
  }
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const answers = join(dir, "answers.json");
  writeFileSync(answers, JSON.stringify({
    subscription: SUBSCRIPTION,
    credentials,
    sticky,
    secrets: { [CA_CERT_SECRET]: pki.caPem, [LEAF_SECRET]: pki.issueLeaf().bundle },
  }));
  const childEnv = { ...process.env };
  for (const key of [...Object.keys(env), ...Object.keys(AKS_ENV_DEFAULTS), "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "KUBECONFIG"]) {
    delete childEnv[key];
  }
  const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  childEnv[pathKey] = `${dir}${delimiter}${childEnv[pathKey] ?? ""}`;
  Object.assign(childEnv, { CH_TEST_CALLS: calls, CH_TEST_ANSWERS: answers });
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "deploy/scripts/deploy.mjs"), ...argv(name),
  ], { cwd: REPO_ROOT, encoding: "utf8", env: childEnv });
  const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, logged };
}

const output = ({ stdout, stderr }) => `${stdout.slice(-4000)}\n${stderr}`;
const toolVerbs = (logged) => logged.map((call) => (call.tool === "az" ? call.args.slice(0, 3).join(" ") : call.tool === "kubectl" ? `kubectl ${call.args[0]}` : call.tool));

test("deploy.mjs: with the host, the worker's manifests step deletes the credential and puts the CA in the cluster before it publishes", (t) => {
  const { result, logged } = deployWorkerManifests(t, {
    settings: { ...HOST },
    credentials: [credential("worker-fedcred", WORKER_SUBJECT), credential("portal-fedcred", "system:serviceaccount:pilotswarm:pilotswarm-portal")],
  });
  assert.equal(result.status, 0, output(result));
  const verbs = toolVerbs(logged);
  const first = (verb) => verbs.indexOf(verb);
  assert.equal(first("identity federated-credential list"), 0, "the credential first");
  assert.ok(first("identity federated-credential delete") < first("kubectl apply"));
  assert.ok(first("kubectl apply") < first("upload"), "the CA before the manifests");
  assert.equal(verbs.filter((v) => v === "upload").length, 1);
  const deleted = logged.filter((call) => call.tool === "az" && call.args[2] === "delete").map((call) => option(call.args, "--name"));
  assert.deepEqual(deleted, ["worker-fedcred"]);
  assert.ok(logged.find((call) => call.tool === "kubectl").manifest.includes(`name: ${CA_CLUSTER_OBJECT}`));
  // What it published: the host's identity, component and replicas.
  const upload = logged.find((call) => call.tool === "upload");
  assert.match(upload.env, new RegExp(`^WORKLOAD_IDENTITY_CLIENT_ID=${HOST_CLIENT}\\r?$`, "m"));
  assert.match(upload.env, new RegExp(`^PILOTSWARM_DB_AAD_USER=${HOST_NAME}\\r?$`, "m"));
  assert.match(upload.overlay, /^ {2}- \.\.\/\.\.\/components\/coordination-host\r?$/m);
  assert.match(upload.overlay, /^ {4}count: 2\r?$/m);
  assert.match(upload.hostEnv, /^PS_COORDINATION_URL=https:\/\/pilotswarm-disk-controller-coordination\.pilotswarm\.svc:3005$/m);
});

test("deploy.mjs: while the credential remains, the worker's manifests are not published; the pool without the host is refused, and without the pool none is touched", (t) => {
  const stuck = deployWorkerManifests(t, { settings: { ...HOST }, credentials: [credential("worker-fedcred", WORKER_SUBJECT)], sticky: true });
  assert.notEqual(stuck.result.status, 0);
  assert.match(output(stuck.result), /still has a federated credential for the worker's service account \(worker-fedcred\)/);
  assert.ok(!toolVerbs(stuck.logged).includes("upload"), "nothing published");
  assert.ok(!toolVerbs(stuck.logged).includes("kubectl apply"), "nothing reached the cluster");

  // The pool without the host: refused before any step, so no Windows worker
  // runs another user's work and nothing is touched.
  const poolOnly = deployWorkerManifests(t, { settings: { ...POOL }, credentials: [credential("worker-fedcred", WORKER_SUBJECT)] });
  assert.notEqual(poolOnly.result.status, 0);
  assert.match(output(poolOnly.result), /\[win-workers-requires-coordination-host\]/);
  assert.deepEqual(toolVerbs(poolOnly.logged), []);

  // Without the pool the worker signs in with that credential.
  const noPool = deployWorkerManifests(t, { settings: {}, credentials: [credential("worker-fedcred", WORKER_SUBJECT)] });
  assert.equal(noPool.result.status, 0, output(noPool.result));
  assert.deepEqual(toolVerbs(noPool.logged), ["upload", "storage blob list"]);
});

test("deploy all: with the host, the worker comes just after the portal, whose rollout runs the database role Job; otherwise the order stays", () => {
  const all = [...ALL_SEQUENCE];
  const hosted = host.coordinationHostSequence(all, hostEnv());
  assert.deepEqual(all, ALL_SEQUENCE, "the given sequence is not changed");
  const withoutWorker = (list) => list.filter((service) => service !== "worker");
  assert.deepEqual(withoutWorker(hosted), withoutWorker(all));
  assert.equal(hosted.indexOf("worker"), hosted.indexOf("portal") + 1);
  assert.ok(hosted.indexOf("worker") < hosted.indexOf("disk-controller"), "still before the controller, whose CA the worker step makes");
  assert.ok(all.indexOf("worker") < all.indexOf("portal"), "the canonical order has the worker first");
  for (const env of [stampEnv(), hostEnv({ WIN_WORKERS_ENABLED: "false" })]) {
    assert.equal(host.coordinationHostSequence(all, env), all);
  }
  const noPortal = all.filter((service) => service !== "portal");
  assert.equal(host.coordinationHostSequence(noPortal, hostEnv()), noPortal);
  const portalFirst = ["portal", "worker"];
  assert.equal(host.coordinationHostSequence(portalFirst, hostEnv()), portalFirst);
});

test("deploy.mjs all: the bring-up runs the worker just after the portal with the host, and before it without the pool", (t) => {
  const bringUp = (settings) => {
    const { result } = deployWorkerManifests(t, { settings, argv: (name) => ["all", name, "--steps", "manifests", "--image-tag", "fixture"] });
    const line = /=== Bring-up sequence: (.+?) ===/.exec(`${result.stdout}\n${result.stderr}`);
    assert.ok(line, output(result));
    return line[1].split(" → ");
  };
  const hosted = bringUp({ ...HOST });
  assert.equal(hosted.indexOf("worker"), hosted.indexOf("portal") + 1, hosted.join(" → "));
  const plain = bringUp({});
  assert.ok(plain.indexOf("portal") > 0 && plain.indexOf("worker") < plain.indexOf("portal"), plain.join(" → "));
});

test("the portal's database role Job adds the host's identity to the workers' group beside the workers' identity, and refuses to stage without it", (t) => {
  const jobEnv = (env) => {
    const stagingDir = mkdtempSync(join(tmpdir(), "ps-coordination-host-stage-"));
    t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
    stageManifests({ service: "portal", envName: "testenv", env, stagingDir });
    const job = readFileSync(dbRoleJobManifestPath(stagingDir), "utf8").split(/^---\s*$/m)
      .map((part) => part.replace(/^\s*#.*$/gm, "").trim()).filter(Boolean)
      .map((part) => JSON.parse(part)).find((object) => object.kind === "Job");
    return Object.fromEntries(job.spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]));
  };
  const hosted = jobEnv(hostEnv());
  assert.equal(hosted.COORDINATION_IDENTITY_NAME, HOST_NAME);
  assert.equal(hosted.COORDINATION_IDENTITY_PRINCIPAL_ID, HOST_OID);
  assert.equal(hosted.WIN_WORKER_IDENTITY_NAME, WIN_WORKER_NAME);
  assert.equal(hosted.EXPECTED_WIN_WORKER_OID, WIN_WORKER_OID);
  assert.equal(hosted.PILOTSWARM_DB_AAD_USER, "psstamp-csi-mid", "the Job signs in as the portal's identity, not the host's");
  // base-infra reports the host's identity empty when it was deployed without the host.
  assert.throws(() => jobEnv(hostEnv({ COORDINATION_IDENTITY_CLIENT_ID: "", COORDINATION_IDENTITY_PRINCIPAL_ID: "", COORDINATION_IDENTITY_NAME: "" })),
    /The database role Job needs COORDINATION_IDENTITY_NAME from base-infra/);
});