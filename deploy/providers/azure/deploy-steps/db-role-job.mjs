// The database role Job's manifest and its run, for the Windows worker pool
// (WIN_WORKERS_ENABLED=true). The Job itself is Setup-WinWorkerDbRole.mjs.
//
// stage-manifests.mjs calls stageDbRoleJob() when it stages the portal. With
// the pool it writes deploy/.tmp/portal-<env>/db-role-job.yaml, outside the
// GitOps tree it publishes: a ConfigMap that holds Setup-WinWorkerDbRole.mjs
// and the portal's staged model catalog, and a Job that runs the script in
// the portal's image and namespace with the portal's service account (and so
// as the portal's workload identity) and the portal's database settings.
// Without the pool it only removes a manifest an earlier run left there.
//
// deploy.mjs calls runStagedDbRoleJob() in the portal's rollout step, once
// the portal has rolled out: it deletes the Job and its ConfigMap, applies the
// manifest again and waits for the Job. The names are fixed: a Job's pod
// template can't change, and the grants want one run at a time. Every kubectl
// and Azure CLI call goes through `runFn`, so tests can answer it.
// Bootstrap-WinWorkerStamp.ps1 takes the same file as -MigrationJobManifest.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, run } from "../../../scripts/lib/common.mjs";
import { databaseUsesManagedIdentity } from "../../../scripts/lib/database-env.mjs";
import { settingValue, winWorkersEnabled } from "../../../scripts/lib/aks-env.mjs";
import { COMPLETE_MARKER, parseDefaultModel, readJobSettings } from "./Setup-WinWorkerDbRole.mjs";

export const DB_ROLE_JOB_NAME = "pilotswarm-db-role";
export const DB_ROLE_JOB_FILE = "db-role-job.yaml";
export const DB_ROLE_JOB_SCRIPT = "Setup-WinWorkerDbRole.mjs";
// Under /app, so the script's imports resolve to the image's node_modules.
export const DB_ROLE_JOB_MOUNT = "/app/db-role-job";
export const DB_ROLE_JOB_CATALOG = "model_providers.json";
const PORTAL_SERVICE_ACCOUNT = "pilotswarm-portal";
const PORTAL_SECRETS = "pilotswarm-portal-secrets";
// The image's `node` user.
const IMAGE_USER = 1000;
// A ConfigMap holds at most 1 MiB.
const MAX_CONFIG_MAP_BYTES = 900 * 1024;
// The Job's own limit; the deploy waits a little longer for its verdict.
const JOB_DEADLINE_SECONDS = 1800;
const DEFAULT_TIMEOUT_MS = (JOB_DEADLINE_SECONDS + 300) * 1000;

// The portal's settings the Job reads, by name.
const DATABASE_SETTINGS = ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL", "PILOTSWARM_DB_AAD_USER"];
const MEMBER_SETTINGS = ["WIN_WORKER_IDENTITY_NAME", "EXPECTED_WIN_WORKER_OID"];
const COORDINATION_SETTINGS = ["COORDINATION_IDENTITY_NAME", "COORDINATION_IDENTITY_PRINCIPAL_ID"];

export function dbRoleJobManifestPath(stagingDir) {
  return join(stagingDir, DB_ROLE_JOB_FILE);
}

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

// The Job's environment, from the env map the portal's overlay is rendered
// from. Throws on a value the Job would refuse, or one that must not be
// written to a file: a database URL with a password.
export function dbRoleJobEnv(env) {
  const values = {};
  for (const key of DATABASE_SETTINGS) {
    const value = settingValue(env, key);
    if (!value) throw new Error(`The database role Job needs ${key}: deploy base-infra first, so the deploy composes it.`);
    if (key !== "PILOTSWARM_DB_AAD_USER") {
      let password = "";
      try {
        password = new URL(value).password;
      } catch {
        throw new Error(`The database role Job needs ${key} as a postgres:// or postgresql:// URL.`);
      }
      if (password) throw new Error(`The database role Job refuses ${key} with a password: it signs in with the portal's managed identity.`);
    }
    values[key] = value;
  }
  if (!databaseUsesManagedIdentity(env)) {
    throw new Error("The database role Job signs in with the portal's managed identity: PILOTSWARM_USE_MANAGED_IDENTITY must be 1.");
  }
  values.PILOTSWARM_USE_MANAGED_IDENTITY = "1";
  for (const key of MEMBER_SETTINGS) {
    const value = settingValue(env, key);
    if (!value) throw new Error(`The database role Job needs ${key} from base-infra: deploy base-infra with WIN_WORKERS_ENABLED=true first.`);
    values[key] = value;
  }
  const coordination = COORDINATION_SETTINGS.map((key) => settingValue(env, key));
  if (coordination.some(Boolean)) COORDINATION_SETTINGS.forEach((key, i) => { values[key] = coordination[i]; });
  values.PS_MODEL_PROVIDERS_PATH = `${DB_ROLE_JOB_MOUNT}/${DB_ROLE_JOB_CATALOG}`;
  readJobSettings(values);
  return values;
}

// The manifest: YAML documents written as JSON, a ConfigMap and the Job.
export function renderDbRoleJobManifest({ env, catalogText, scriptText }) {
  const image = settingValue(env, "IMAGE");
  if (!image) throw new Error("The database role Job runs in the portal's image: IMAGE is not set.");
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch (error) {
    throw new Error(`The portal's staged model catalog is not valid JSON: ${error.message}`);
  }
  parseDefaultModel(catalog);
  const jobEnv = dbRoleJobEnv(env);
  const labels = { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "db-role-job" };
  const metadata = { name: DB_ROLE_JOB_NAME, namespace, labels };
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata,
    data: { [DB_ROLE_JOB_SCRIPT]: lf(scriptText), [DB_ROLE_JOB_CATALOG]: lf(catalogText) },
  };
  const size = Buffer.byteLength(JSON.stringify(configMap.data), "utf8");
  if (size > MAX_CONFIG_MAP_BYTES) throw new Error(`The database role Job's ConfigMap would hold ${size} bytes, more than a ConfigMap takes.`);
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata,
    spec: {
      backoffLimit: 1,
      activeDeadlineSeconds: JOB_DEADLINE_SECONDS,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { ...labels, "azure.workload.identity/use": "true" } },
        spec: {
          serviceAccountName: PORTAL_SERVICE_ACCOUNT,
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: IMAGE_USER,
            runAsGroup: IMAGE_USER,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "db-role",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["node", `${DB_ROLE_JOB_MOUNT}/${DB_ROLE_JOB_SCRIPT}`],
            env: Object.entries(jobEnv).map(([name, value]) => ({ name, value })),
            // The portal's model credentials, which the default model's
            // provider may need; the Job never prints them.
            envFrom: [{ secretRef: { name: PORTAL_SECRETS, optional: true } }],
            volumeMounts: [{ name: "db-role-job", mountPath: DB_ROLE_JOB_MOUNT, readOnly: true }],
            resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "1Gi" } },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          }],
          volumes: [{ name: "db-role-job", configMap: { name: DB_ROLE_JOB_NAME, defaultMode: 0o444 } }],
        },
      },
    },
  };
  return [
    "# The Windows worker pool's database role Job (deploy/providers/azure/deploy-steps/db-role-job.mjs),",
    "# staged with the portal's manifests. deploy.mjs runs it after the portal's rollout, and",
    "# Bootstrap-WinWorkerStamp.ps1 runs it as -MigrationJobManifest: delete both objects, then apply.",
    "---",
    JSON.stringify(configMap, null, 2),
    "---",
    JSON.stringify(job, null, 2),
    "",
  ].join("\n");
}

// Stages the Job's manifest beside the portal's staged GitOps tree (pool on),
// or removes one an earlier run left (pool off). Returns its path, or null.
export function stageDbRoleJob({ env, stagingDir, stagedServiceRoot }) {
  const path = dbRoleJobManifestPath(stagingDir);
  if (!winWorkersEnabled(env)) {
    rmSync(path, { force: true });
    return null;
  }
  const catalogPath = join(stagedServiceRoot, "base", DB_ROLE_JOB_CATALOG);
  if (!existsSync(catalogPath)) throw new Error(`The database role Job reads the portal's staged model catalog, which is missing: ${catalogPath}`);
  const manifest = renderDbRoleJobManifest({
    env,
    catalogText: readFileSync(catalogPath, "utf8"),
    scriptText: readFileSync(new URL(`./${DB_ROLE_JOB_SCRIPT}`, import.meta.url), "utf8"),
  });
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(path, manifest);
  log("info", `[stage-manifests] WIN_WORKERS_ENABLED=true: staged the database role Job → ${path}`);
  return path;
}

// ─── The run ───

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0].slice(0, 300);
}

// The Job's name and namespace, from the staged manifest.
export function stagedJob(manifestText) {
  const documents = String(manifestText).split(/^---\s*$/m).map((part) => part.replace(/^\s*#.*$/gm, "").trim()).filter(Boolean);
  const jobs = documents.map((document) => JSON.parse(document)).filter((object) => object?.kind === "Job");
  if (jobs.length !== 1) throw new Error(`The database role Job's manifest must hold one Job, not ${jobs.length}.`);
  return { name: jobs[0].metadata.name, namespace: jobs[0].metadata.namespace };
}

// "Complete", "Failed" or "Running", from `kubectl get job --output json`.
export function jobState(jobJson) {
  const conditions = JSON.parse(jobJson || "{}")?.status?.conditions ?? [];
  const holds = (type) => conditions.some((condition) => condition.type === type && condition.status === "True");
  if (holds("Failed")) return "Failed";
  if (holds("Complete")) return "Complete";
  return "Running";
}

// The kubeconfig the rollout step uses (wait-rollout.mjs): the cluster's
// credentials in the staging folder, never the user's own kubeconfig.
function kubeEnvFor(env, stagingDir, runFn) {
  const cluster = settingValue(env, "AKS_CLUSTER_NAME");
  const resourceGroup = settingValue(env, "RESOURCE_GROUP");
  if (!cluster || !resourceGroup) return process.env;
  mkdirSync(stagingDir, { recursive: true });
  const kubeconfig = join(stagingDir, "kubeconfig");
  const result = runFn("az", ["aks", "get-credentials", "--resource-group", resourceGroup, "--name", cluster,
    "--file", kubeconfig, "--overwrite-existing", "--output", "none"], { capture: true, allowFail: true });
  if (result.status !== 0) throw new Error(`Could not get the cluster's credentials: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  return { ...process.env, KUBECONFIG: kubeconfig };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runStagedDbRoleJob({ env, stagingDir }, {
  runFn = run, sleepFn = sleep, nowFn = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 10_000,
} = {}) {
  const manifest = dbRoleJobManifestPath(stagingDir);
  if (!existsSync(manifest)) {
    throw new Error(`The database role Job's manifest is missing (${manifest}): run the portal's manifests step with WIN_WORKERS_ENABLED=true first.`);
  }
  const { name, namespace } = stagedJob(readFileSync(manifest, "utf8"));
  const kubeEnv = kubeEnvFor(env, stagingDir, runFn);
  const kubectl = (args, what) => {
    const result = runFn("kubectl", args, { capture: true, allowFail: true, env: kubeEnv });
    if (result.status !== 0 && what) throw new Error(`Could not ${what}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
    return result;
  };
  const logs = () => {
    const result = kubectl(["logs", "--selector", `job-name=${name}`, "--namespace", namespace, "--tail=60", "--prefix"]);
    return String(result.stdout ?? "").trim();
  };

  kubectl(["delete", "--filename", manifest, "--ignore-not-found", "--wait=true", "--cascade=foreground", "--timeout=5m"],
    `delete the last run of job/${name}`);
  kubectl(["apply", "--filename", manifest], `apply ${manifest}`);
  log("info", `[db-role-job] job/${name} runs the migrations and the worker group's grants in namespace ${namespace}.`);

  const deadline = nowFn() + timeoutMs;
  for (;;) {
    const state = jobState(kubectl(["get", "job", name, "--namespace", namespace, "--output", "json"], `read job/${name}`).stdout);
    if (state === "Complete") {
      const output = logs();
      if (!output.split(/\r?\n/).some((line) => line.trimEnd().endsWith(COMPLETE_MARKER))) {
        throw new Error(`job/${name} completed without reporting every step done. Its last lines:\n${output}`);
      }
      log("ok", `[db-role-job] job/${name} completed:\n${output}`);
      return { name, namespace };
    }
    if (state === "Failed" || nowFn() >= deadline) {
      throw new Error(
        `job/${name} ${state === "Failed" ? "failed" : `did not finish within ${Math.round(timeoutMs / 60000)} minutes`}. ` +
          `Its last lines:\n${logs()}`,
      );
    }
    await sleepFn(pollMs);
  }
}
