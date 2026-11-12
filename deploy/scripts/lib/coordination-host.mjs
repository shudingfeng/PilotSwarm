// The coordination host (WIN_WORKER_COORDINATION_HOST=true, which the Windows
// worker pool requires): the Linux worker, `copilot-runtime-worker`, runs the
// orchestrations, durable timers, system agents, title generator, every
// turn's bookkeeping, the sessions that people start in the Portal with their
// workspaces and every Workflow activity, and sends every capacity request to
// the disk controller, while the Windows workers run only their owner's turns
// (deploy/providers/azure/linux-worker/README.md).
//
// stage-manifests.mjs stages the worker with:
//
//   pool and host on   the worker overlay's .env with the host's own identity
//                      (base-infra's COORDINATION_IDENTITY_* outputs) as
//                      WORKLOAD_IDENTITY_CLIENT_ID and PILOTSWARM_DB_AAD_USER,
//                      in the map of that one substitution
//                      (coordinationHostOverlayEnv): the env map, which the
//                      portal stages from, keeps the portal's identity. The
//                      staged overlay gets the coordination-host component,
//                      and coordination-host-plugin with
//                      WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP,
//                      coordination-host-ca while the disk controller trusts
//                      two CAs (a CA rotation), coordination-host-workspaces
//                      with WORKSPACES_ENABLED=true, and
//                      WIN_WORKER_COORDINATION_HOST_REPLICAS replicas (2)
//                      (stageCoordinationHost). The staged model catalog's
//                      Foundry providers take the host's identity too, since
//                      it loads no Key Vault secret;
//   pool on, host off  refused, as overlay-contracts.mjs refuses it before
//                      any step;
//   pool off           nothing changes, so the worker keeps its 3 replicas.
//
// The Flux path stays overlays/default: the components and the replica count
// go into the staged copy only, the way workspaces.mjs adds its component.
// With workspaces on, workspaces.mjs puts its component first in the list,
// so coordination-host-workspaces, last of the host's, sets the extension
// modules and plugin folders of both.
// deploy.mjs builds the worker image with COPILOT_PKG_CACHE_HOME while the
// host is on (workerImageBuildArgs), and the Windows worker deploy step
// deletes the portal identity's credential for the worker's service account
// before the worker's manifests (deploy/providers/azure/deploy-steps/win-workers.mjs).
//
// No I/O beyond the staged tree; no import of common.mjs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { substituteOverlayEnv } from "./substitute-env.mjs";
import { diskControllerTokenScope, settingValue, winWorkerCoordinationHost, winWorkerSettings, winWorkersEnabled } from "./aks-env.mjs";
import { workspacesEnabled } from "./workspaces.mjs";

export const COORDINATION_HOST_COMPONENT = "coordination-host";
export const COORDINATION_HOST_PLUGIN_COMPONENT = "coordination-host-plugin";
export const COORDINATION_HOST_CA_COMPONENT = "coordination-host-ca";
export const COORDINATION_HOST_WORKSPACES_COMPONENT = "coordination-host-workspaces";
export const WORKER_DEPLOYMENT = "copilot-runtime-worker";
// While the disk controller trusts two CAs (a CA rotation), the host's pod
// template carries the SHA-256 of their PEM bundle, which the Windows worker
// deploy step passes in the env map under this key before the worker's
// manifests: the host reads NODE_EXTRA_CA_CERTS only when it starts, so a
// new bundle must restart its pods. With one CA the key is unset and the pod
// template stays as it was.
export const COORDINATION_HOST_CA_HASH_KEY = "DISK_CONTROLLER_CA_SHA256";
export const COORDINATION_HOST_CA_ANNOTATION = "pilotswarm.dev/disk-controller-ca-sha256";
export const CA_HASH_PLACEHOLDER = "__DISK_CONTROLLER_CA_SHA256__";
// Where the worker image unpacks the Copilot CLI program as root when the
// build argument of that name is set (deploy/Dockerfile.worker); the
// component's COPILOT_PKG_CACHE_HOME names the same folder.
export const COORDINATION_HOST_PKG_CACHE_HOME = "/app/copilot-pkg";
// The disk controller's coordination Service and port, which its TLS
// certificate names (deploy/providers/azure/disk-controller/tls.mjs).
export const COORDINATION_SERVICE = "pilotswarm-disk-controller-coordination";
export const COORDINATION_PORT = 3005;
export const PLUGIN_CONFIGMAP_PLACEHOLDER = "__COORDINATION_HOST_PLUGIN_CONFIGMAP__";
// With workspaces, the host loads the plugin folder of the workspaces
// component (gitops/worker/components/workspaces/worker-patch.yaml), and with
// WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP the coordination-host-plugin
// component's folder before it: coordination-host-workspaces names both.
export const PLUGIN_DIRS_PLACEHOLDER = "__COORDINATION_HOST_PLUGIN_DIRS__";
export const COORDINATION_HOST_PLUGIN_DIR = "/app/coordination-plugin";
export const WORKSPACES_PLUGIN_DIR = "/app/packages/sdk/examples/repo-workspaces/plugin";

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const REDACT_SECRET_PREFIXES = "PILOTSWARM_REDACT_SECRET_PREFIXES";

export function coordinationHostEnabled(env) {
  return winWorkersEnabled(env) && winWorkerCoordinationHost(env);
}

// The hash the host's pod template carries for a CA bundle.
export function caBundleHash(bundle) {
  return createHash("sha256").update(String(bundle), "utf8").digest("hex");
}

// The controller's coordination route, in the namespace of the portal and the
// controller, by the name its TLS certificate carries.
export function coordinationUrl(env) {
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  return `https://${COORDINATION_SERVICE}.${namespace}.svc:${COORDINATION_PORT}`;
}

// The worker overlay's identity with the host on, for the map of the
// worker's .env substitution only; empty otherwise.
export function coordinationHostOverlayEnv(env) {
  if (!coordinationHostEnabled(env)) return {};
  const clientId = settingValue(env, "COORDINATION_IDENTITY_CLIENT_ID");
  const name = settingValue(env, "COORDINATION_IDENTITY_NAME");
  if (!GUID.test(clientId) || !name) {
    throw new Error(
      "[stage-manifests] the coordination host needs COORDINATION_IDENTITY_CLIENT_ID and COORDINATION_IDENTITY_NAME " +
        "from base-infra: deploy base-infra with WIN_WORKER_COORDINATION_HOST=true first.",
    );
  }
  return { WORKLOAD_IDENTITY_CLIENT_ID: clientId, PILOTSWARM_DB_AAD_USER: name };
}

// The values of the component's coordination-host.properties. Without redaction
// prefixes, that line is left out.
export function coordinationHostComponentEnv(env) {
  const prefixes = winWorkerSettings(env).coordinationHostRedactSecretPrefixes;
  return {
    PS_COORDINATION_URL: coordinationUrl(env),
    PS_COORDINATION_TOKEN_SCOPE: diskControllerTokenScope(env),
    ...(prefixes.length > 0 ? { [REDACT_SECRET_PREFIXES]: prefixes.join(",") } : {}),
  };
}

// The worker Deployment's replica count, or null to keep the manifest's. With
// the pool the worker runs as the coordination host.
export function workerReplicas(env) {
  if (!winWorkersEnabled(env)) return null;
  return winWorkerSettings(env).coordinationHostReplicas;
}

// The `docker build` arguments of a service's image.
export function workerImageBuildArgs(service, env) {
  return service === "worker" && coordinationHostEnabled(env)
    ? { COPILOT_PKG_CACHE_HOME: COORDINATION_HOST_PKG_CACHE_HOME }
    : {};
}

// The order `deploy all` runs its services in. With the host on, the worker
// moves to just after the portal: the portal's rollout step runs the database
// role Job, which applies the migrations and makes the host's identity a
// member of the workers' database group
// (deploy/providers/azure/deploy-steps/db-role-job.mjs), and the host's pods
// sign in as that identity and apply no migration. Otherwise, or when the
// sequence lacks either service, it is returned as it is.
export function coordinationHostSequence(sequence, env) {
  const worker = sequence.indexOf("worker");
  const portal = sequence.indexOf("portal");
  if (!coordinationHostEnabled(env) || worker < 0 || portal < 0 || worker > portal) return sequence;
  const reordered = sequence.filter((service) => service !== "worker");
  reordered.splice(reordered.indexOf("portal") + 1, 0, "worker");
  return reordered;
}

const newline = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

function addComponents(overlayPath, components) {
  const overlay = readFileSync(overlayPath, "utf8");
  const marker = /^components:[ \t]*$/gm;
  if ((overlay.match(marker) ?? []).length !== 1) {
    throw new Error(`Expected exactly one components list in ${overlayPath}.`);
  }
  const lines = ["components:", ...components.map((name) => `  - ../../components/${name}`)];
  writeFileSync(overlayPath, overlay.replace(marker, lines.join(newline(overlay))));
}

function setReplicas(overlayPath, count) {
  const overlay = readFileSync(overlayPath, "utf8");
  if (/^replicas:/m.test(overlay)) throw new Error(`${overlayPath} sets replicas already.`);
  const nl = newline(overlay);
  const lines = ["", "# The deploy tool's replica count (deploy/scripts/lib/coordination-host.mjs).", "replicas:",
    `  - name: ${WORKER_DEPLOYMENT}`, `    count: ${count}`, ""];
  writeFileSync(overlayPath, `${overlay.replace(/\s+$/, "")}${nl}${lines.join(nl)}`);
}

// Stages the coordination host into the staged worker tree (see the top of
// this file). Returns null when the pool is off, else what it did.
export function stageCoordinationHost({ service, env, stagedServiceRoot, overlayName }) {
  if (service !== "worker") return null;
  const replicas = workerReplicas(env);
  if (replicas === null) return null;
  if (!coordinationHostEnabled(env)) {
    throw new Error(
      "WIN_WORKERS_ENABLED=true needs WIN_WORKER_COORDINATION_HOST=true: the coordination host makes the Windows " +
        "workers owner-only and runs everything else.",
    );
  }
  const overlayPath = join(stagedServiceRoot, "overlays", overlayName, "kustomization.yaml");
  const componentRoot = join(stagedServiceRoot, "components", COORDINATION_HOST_COMPONENT);
  if (!existsSync(join(componentRoot, "kustomization.yaml"))) {
    throw new Error(`WIN_WORKER_COORDINATION_HOST=true, but the worker has no ${COORDINATION_HOST_COMPONENT} component at ${componentRoot}.`);
  }
  const values = coordinationHostComponentEnv(env);
  const envFile = join(componentRoot, "coordination-host.properties");
  substituteOverlayEnv({
    srcPath: envFile,
    dstPath: envFile,
    envMap: values,
    omittedKeys: REDACT_SECRET_PREFIXES in values ? [] : [REDACT_SECRET_PREFIXES],
  });
  const replace = (file, placeholder, value) => {
    const text = readFileSync(file, "utf8");
    if (!text.includes(placeholder)) throw new Error(`${file} has no ${placeholder} to replace.`);
    writeFileSync(file, text.split(placeholder).join(value));
  };
  const components = [COORDINATION_HOST_COMPONENT];
  const pluginConfigMap = winWorkerSettings(env).coordinationHostPluginConfigMap;
  if (pluginConfigMap) {
    replace(join(stagedServiceRoot, "components", COORDINATION_HOST_PLUGIN_COMPONENT, "deployment-patch.yaml"),
      PLUGIN_CONFIGMAP_PLACEHOLDER, pluginConfigMap);
    components.push(COORDINATION_HOST_PLUGIN_COMPONENT);
  }
  const caHash = settingValue(env, COORDINATION_HOST_CA_HASH_KEY);
  if (caHash) {
    if (!/^[0-9a-f]{64}$/.test(caHash)) throw new Error(`${COORDINATION_HOST_CA_HASH_KEY} must be the SHA-256 of the disk controller's CA bundle, in hex.`);
    replace(join(stagedServiceRoot, "components", COORDINATION_HOST_CA_COMPONENT, "kustomization.yaml"), CA_HASH_PLACEHOLDER, caHash);
    components.push(COORDINATION_HOST_CA_COMPONENT);
  }
  if (workspacesEnabled(env)) {
    const pluginDirs = [...(pluginConfigMap ? [COORDINATION_HOST_PLUGIN_DIR] : []), WORKSPACES_PLUGIN_DIR].join(",");
    replace(join(stagedServiceRoot, "components", COORDINATION_HOST_WORKSPACES_COMPONENT, "deployment-patch.yaml"),
      PLUGIN_DIRS_PLACEHOLDER, pluginDirs);
    components.push(COORDINATION_HOST_WORKSPACES_COMPONENT);
  }
  addComponents(overlayPath, components);
  setReplicas(overlayPath, replicas);
  return { coordinationHost: true, replicas, components };
}
