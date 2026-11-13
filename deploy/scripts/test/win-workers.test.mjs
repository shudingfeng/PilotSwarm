// The Windows worker pool's deploy side (WIN_WORKERS_ENABLED): its settings
// and their defaults, the parity of everything rendered without it, the
// workers' userData and configuration version, the controller's staged
// overlay, the Bicep (compiled with `az bicep build` when the Azure CLI has
// Bicep, and read as text), and the Windows worker deploy step
// (deploy/providers/azure/deploy-steps/win-workers.mjs) against an Azure CLI
// the test answers. The combination refusals are in overlay-contracts.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { REPO_ROOT, parseEnvFile, templateEnvPath, resolveCli, run } from "../lib/common.mjs";
import {
  AKS_ENV_DEFAULTS,
  WIN_WORKER_ENV_DEFAULTS,
  DISK_CONTROLLER_ENV_DEFAULTS,
  PORTAL_SETTING_DEFAULTS,
  WIN_WORKER_OUTPUT_DEFAULTS,
  winWorkerSettings,
} from "../lib/aks-env.mjs";
import {
  renderParams,
  renderWinWorkerUserData,
  checkWinWorkerUserData,
  winWorkerExtraEnv,
  WIN_WORKER_USER_DATA_ENV_KEYS,
  WIN_WORKER_USER_DATA_MAX_BYTES,
  WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES,
  DISK_CONTROLLER_WORKER_URL,
} from "../lib/render-params.mjs";
import { stageManifests, diskControllerOverlayEnv } from "../lib/stage-manifests.mjs";
import { composeDerivedEnv } from "../lib/compose-env.mjs";
import { DATABASE_INPUT_KEYS } from "../lib/database-env.mjs";
import * as step from "../../providers/azure/deploy-steps/win-workers.mjs";
import { runCaRotation } from "../../providers/azure/deploy-steps/ca-rotation.mjs";
import {
  CA_CERT_SECRET,
  CA_KEY_SECRET,
  NEXT_CA_CERT_SECRET,
  NEXT_CA_KEY_SECRET,
  PREVIOUS_CA_CERT_SECRET,
  caBundle,
  caClusterManifest,
  finishCaRotation,
  promoteCaRotation,
  startCaRotation,
} from "../../providers/azure/disk-controller/tls.mjs";
import { loadConfig } from "../../providers/azure/disk-controller/lib/config.mjs";
import { createFakeAppGateway, createFakeAz, createFakeOpenssl, createTestPki } from "../../providers/azure/disk-controller/test/x509.mjs";

const BICEP = join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep");
const readBicep = (file) => readFileSync(join(BICEP, file), "utf8");
const pki = createTestPki();

const SUBSCRIPTION = "00000000-0000-0000-0000-000000000003";
const TENANT = "00000000-0000-0000-0000-000000000002";
const PORTAL_APP = "11111111-1111-1111-1111-111111111111";
const WORKER_CLIENT = "22222222-2222-2222-2222-222222222222";
const WORKER_OID = "33333333-3333-3333-3333-333333333333";
const CONTROLLER_CLIENT = "44444444-4444-4444-4444-444444444444";
const CONTROLLER_OID = "55555555-5555-5555-5555-555555555555";
const PORTAL_OID = "66666666-6666-6666-6666-666666666666";
const ROLE_IDS = {
  WIN_WORKER_CONTROLLER_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000001",
  WIN_WORKER_SUBNET_JOIN_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000002",
  WIN_WORKER_VAULT_WRITER_ROLE_ID: "aaaaaaaa-0000-0000-0000-000000000003",
};
const STANDBY_OID = "77777777-7777-7777-7777-777777777777";

// The values base-infra and the other templates need besides template.env.
const STAMP = Object.freeze({
  SUBSCRIPTION_ID: SUBSCRIPTION,
  AZURE_TENANT_ID: TENANT,
  RESOURCE_PREFIX: "psstamp",
  RESOURCE_GROUP: "stamp-rg",
  PORTAL_RESOURCE_NAME: "psstamp-wus3-portal",
  FRONT_DOOR_ID: "fixture-front-door",
  FRONT_DOOR_PROFILE_NAME: "fixture-profile",
  FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg",
  FRONT_DOOR_ENDPOINT_NAME: "fixture-endpoint",
  APPLICATION_GATEWAY_NAME: "psstamp-appgw",
  PRIVATE_LINK_CONFIGURATION_NAME: "privateLinkConfig",
  APPROVAL_MANAGED_IDENTITY_ID: "/subscriptions/fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/approver",
  DEPLOYMENT_STORAGE_ACCOUNT_NAME: "psstampsa",
  AKS_CLUSTER_NAME: "psstamp-aks",
  KV_NAME: "psstampkv",
  PORTAL_HOSTNAME: "portal.example.com",
  PRIVATE_DNS_ZONE: "unused",
  AKS_VNET_ID: "unused",
  ACME_EMAIL: "operator@example.com",
  PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP,
});

// What base-infra reports for the pool (deploy-bicep.mjs's alias map).
const OUTPUTS = Object.freeze({
  POSTGRES_FQDN: "stamp-pg.postgres.database.azure.com",
  POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "psstamp-csi-mid",
  AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net",
  WIN_WORKER_IDENTITY_NAME: "psstamp-win-worker-mid",
  WIN_WORKER_IDENTITY_CLIENT_ID: WORKER_CLIENT,
  EXPECTED_WIN_WORKER_OID: WORKER_OID,
  DISK_CONTROLLER_IDENTITY_CLIENT_ID: CONTROLLER_CLIENT,
  DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID: CONTROLLER_OID,
  PS_DISK_POOL_STATE_URL: "https://placeholder.blob.core.windows.net/disk-pool-state",
  PERSONAL_KEY_VAULT_URI: "https://myvault.vault.azure.net/",
  DEPLOY_KEY_VAULT_NAME: "psstampkvdep",
  WIN_WORKER_GALLERY_IMAGE_ID: `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.Compute/galleries/psstampgallery/images/pilotswarm-win-worker`,
  WIN_WORKER_SCALE_SET_ID: `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.Compute/virtualMachineScaleSets/psstamp-win-workers`,
  WIN_WORKER_DCR_ID: `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.Insights/dataCollectionRules/psstamp-win-worker-dcr`,
  COORDINATION_IDENTITY_CLIENT_ID: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  COORDINATION_IDENTITY_PRINCIPAL_ID: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  COORDINATION_IDENTITY_NAME: "psstamp-linux-worker-mid",
});

// The pool, with what it needs (overlay-contracts.mjs).
const POOL = Object.freeze({
  WIN_WORKERS_ENABLED: "true",
  WIN_WORKER_ALERT_EMAILS: "ops@example.com",
  WIN_WORKER_COORDINATION_HOST: "true",
  PILOTSWARM_OWNER_ROUTING: "1",
  AUTHZ_ENFORCE_OWNERSHIP: "true",
});

const poolEnv = (extra = {}) => {
  const env = { ...parseEnvFile(templateEnvPath()), ...STAMP, ...OUTPUTS, ...POOL, ...ROLE_IDS, ...extra };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return env;
};

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ps-win-workers-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const decode = (userData) => JSON.parse(Buffer.from(userData, "base64").toString("utf8"));

// ─── Settings ───

test("every pool and portal setting has its default in aks-env.mjs, and template.env names it", () => {
  const unset = "__PS_UNSET__";
  assert.deepEqual(WIN_WORKER_ENV_DEFAULTS, {
    WIN_WORKERS_ENABLED: "false",
    WIN_WORKER_COUNT: "5",
    WIN_WORKER_MIN_RUNNING: "1",
    WIN_WORKER_STANDBY_MIN: "1",
    WIN_WORKER_VM_SIZE: "Standard_D16ds_v5",
    WIN_WORKER_IMAGE_VERSION: unset,
    WIN_WORKER_IDLE_RECYCLE_MINUTES: "30",
    WIN_WORKER_SCALE_IN_BATCH: "1",
    WIN_WORKER_SCALE_IN_INTERVAL_MINUTES: "5",
    WIN_WORKER_COORDINATION_HOST: "false",
    WIN_WORKER_COORDINATION_HOST_REPLICAS: "2",
    WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: unset,
    WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: unset,
    WIN_WORKER_WORKING_HOURS: unset,
    WIN_WORKER_EXTRA_ENV: unset,
    WIN_WORKER_FEED_ENDPOINTS: unset,
    WIN_WORKER_ALERT_EMAILS: unset,
    WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: unset,
    WIN_DEV_DRIVE_POOL_COUNT: "10",
    WIN_DEV_DRIVE_SPARE_COUNT: "2",
    WIN_DEV_DRIVE_MAX_PER_USER: "3",
    WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS: "7",
    WIN_DEV_DRIVE_SIZE_GB: "1024",
    WIN_DEV_DRIVE_GROW_FREE_PERCENT: "20",
    WIN_DEV_DRIVE_GROW_STEP_GB: "256",
    WIN_DEV_DRIVE_MAX_GB: "2048",
    WIN_DEV_DRIVE_IOPS: "6000",
  });
  // The portal's settings default to its behavior without them.
  assert.deepEqual(PORTAL_SETTING_DEFAULTS, {
    PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: unset,
    PILOTSWARM_PERSONAL_SECRETS: "database",
    PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: unset,
    PILOTSWARM_PERSONAL_SECRET_VAULT_URI: unset,
    PILOTSWARM_OWNER_ROUTING: "0",
    PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE: unset,
    PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC: unset,
    PILOTSWARM_SESSION_MESSAGE_SCOPE: unset,
  });
  assert.equal(AKS_ENV_DEFAULTS.DISPATCHER_SP_OBJECT_ID, unset);
  // loadEnv merges these, so a GitHub variable or a shell value can set each.
  for (const defaults of [WIN_WORKER_ENV_DEFAULTS, DISK_CONTROLLER_ENV_DEFAULTS, PORTAL_SETTING_DEFAULTS]) {
    for (const [key, value] of Object.entries(defaults)) assert.equal(AKS_ENV_DEFAULTS[key], value, key);
  }
  // Base-infra's outputs stay out of loadEnv's defaults: the outputs cache
  // fills only keys the env map lacks.
  for (const key of Object.keys(WIN_WORKER_OUTPUT_DEFAULTS)) assert.ok(!(key in AKS_ENV_DEFAULTS), key);

  const template = readFileSync(templateEnvPath(), "utf8");
  for (const key of [...Object.keys(WIN_WORKER_ENV_DEFAULTS), ...Object.keys(DISK_CONTROLLER_ENV_DEFAULTS), ...Object.keys(PORTAL_SETTING_DEFAULTS)]) {
    assert.ok(new RegExp(`^#?\\s*${key}\\b`, "m").test(template), `template.env names ${key}`);
  }
  // A new env copies the switch off; the parsed template keeps the pool off.
  assert.equal(parseEnvFile(templateEnvPath()).WIN_WORKERS_ENABLED, "false");
});

test("the reference deploy workflow carries every new setting from the environment's variables", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/deploy-azure.yml"), "utf8");
  for (const key of [...Object.keys(WIN_WORKER_ENV_DEFAULTS), ...Object.keys(PORTAL_SETTING_DEFAULTS), "DISPATCHER_SP_OBJECT_ID"]) {
    assert.match(workflow, new RegExp(`^ +${key}: \\$\\{\\{ vars\\.${key} \\}\\}\\r?$`, "m"), key);
  }
});
// ─── Parameters: parity without the pool, the pool's parameters with it ───

const templateFor = (module) =>
  join(REPO_ROOT, `deploy/providers/azure/services/${module}/bicep/${module}.params.template.json`);

// The rendering before the pool existed: every placeholder replaced by its
// value inside the JSON string (the template.env values of the normalized
// keys render unchanged).
function substituteTemplate(raw, env) {
  return raw.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key) =>
    String(env[key]).replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
}

test("with WIN_WORKERS_ENABLED and AZURE_POLICY_RESTRICTED off, every module's parameters render byte for byte as before", () => {
  withTmp((dir) => {
    const base = { ...parseEnvFile(templateEnvPath()), ...STAMP, ...OUTPUTS };
    for (const module of ["base-infra", "portal", "worker", "disk-controller"]) {
      const templatePath = templateFor(module);
      const raw = readFileSync(templatePath, "utf8");
      for (const flag of [undefined, "", "false", " FALSE "]) {
        const envMap = { ...base, WIN_WORKERS_ENABLED: flag, AZURE_POLICY_RESTRICTED: "false" };
        if (flag === undefined) delete envMap.WIN_WORKERS_ENABLED;
        const { renderedPath } = renderParams({ module, templatePath, envMap, outDir: dir });
        assert.equal(readFileSync(renderedPath, "utf8"), substituteTemplate(raw, envMap), `${module} WIN_WORKERS_ENABLED=${flag}`);
      }
    }
  });
});

function renderBaseInfra(env) {
  return withTmp((dir) => {
    const { renderedPath } = renderParams({ module: "base-infra", templatePath: templateFor("base-infra"), envMap: env, outDir: dir });
    return JSON.parse(readFileSync(renderedPath, "utf8")).parameters;
  });
}

test("WIN_WORKERS_ENABLED=true adds only the pool's parameters to base-infra, and no other module changes", () => {
  const env = poolEnv();
  const on = renderBaseInfra(env);
  const off = JSON.parse(substituteTemplate(readFileSync(templateFor("base-infra"), "utf8"), env)).parameters;
  for (const name of Object.keys(off)) assert.deepEqual(on[name], off[name], name);
  const added = Object.fromEntries(Object.entries(on).filter(([name]) => !(name in off)));
  assert.deepEqual(added, {
    winWorkersEnabled: { value: true },
    winWorkerCount: { value: 5 },
    winWorkerMinRunning: { value: 1 },
    winWorkerStandbyMin: { value: 1 },
    winWorkerVmSize: { value: "Standard_D16ds_v5" },
    winWorkerImageVersion: { value: "" },
    winWorkerAlertEmails: { value: ["ops@example.com"] },
    diskPoolControllerRoleId: { value: ROLE_IDS.WIN_WORKER_CONTROLLER_ROLE_ID },
    workerSubnetJoinRoleId: { value: ROLE_IDS.WIN_WORKER_SUBNET_JOIN_ROLE_ID },
    personalVaultWriterRoleId: { value: ROLE_IDS.WIN_WORKER_VAULT_WRITER_ROLE_ID },
    winWorkerCoordinationHost: { value: true },
  });
  withTmp((dir) => {
    for (const module of ["portal", "worker", "disk-controller"]) {
      const templatePath = templateFor(module);
      const { renderedPath } = renderParams({ module, templatePath, envMap: env, outDir: dir });
      assert.equal(readFileSync(renderedPath, "utf8"), substituteTemplate(readFileSync(templatePath, "utf8"), env), module);
    }
  });
  // Every parameter the pool adds is one base-infra declares.
  const declared = [...readBicep("main.bicep").matchAll(/^param (\w+) /gm)].map((m) => m[1]);
  for (const name of Object.keys(added)) assert.ok(declared.includes(name), name);
});

test("with an image version, base-infra gets the scale set's parameters, and the deploy step's answers are required", () => {
  const image = { WIN_WORKER_IMAGE_VERSION: "1.0.20261104", WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: STANDBY_OID, WIN_WORKER_CA_CERT: pki.caPem };
  for (const exists of ["true", "false"]) {
    const params = renderBaseInfra(poolEnv({ ...image, WIN_WORKER_SCALE_SET_EXISTS: exists }));
    assert.equal(params.winWorkerImageVersion.value, "1.0.20261104");
    assert.equal(params.winWorkerScaleSetExists.value, exists === "true");
    assert.equal(params.standbyPoolPrincipalId.value, STANDBY_OID);
    const document = decode(params.winWorkerUserData.value);
    assert.equal(document.env.WIN_WORKER_CONFIG_VERSION, params.winWorkerConfigVersion.value);
    // The admin password is a secure parameter, never in the rendered file.
    assert.equal(params.winWorkerAdminPassword, undefined);
  }
  const declared = [...readBicep("main.bicep").matchAll(/^param (\w+) /gm)].map((m) => m[1]);
  for (const name of ["winWorkerScaleSetExists", "standbyPoolPrincipalId", "winWorkerUserData", "winWorkerConfigVersion", "winWorkerAdminPassword"]) {
    assert.ok(declared.includes(name), name);
  }
  for (const [missing, message] of [
    ["WIN_WORKER_SCALE_SET_EXISTS", /needs WIN_WORKER_SCALE_SET_EXISTS/],
    ["WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID", /needs WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID/],
    ["WIN_WORKER_CA_CERT", /needs the disk controller's CA certificate/],
  ]) {
    const env = poolEnv({ ...image, WIN_WORKER_SCALE_SET_EXISTS: "false", [missing]: undefined });
    assert.throws(() => renderBaseInfra(env), message, missing);
  }
  for (const key of Object.keys(ROLE_IDS)) {
    assert.throws(() => renderBaseInfra(poolEnv({ [key]: undefined })), new RegExp(`needs ${key}`), key);
  }
});

// ─── userData and the configuration version ───

function userDataEnv(extra = {}) {
  return poolEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104", ...extra });
}

test("userData carries every setting the launcher requires, the CA and no secret, in the launcher's format", () => {
  const { userData, configVersion, document } = renderWinWorkerUserData(userDataEnv(), { caPem: pki.caPem });
  assert.deepEqual(decode(userData), document);
  assert.deepEqual(Object.keys(document), ["version", "env", "controllerCaCert"]);
  assert.equal(document.version, 1);
  assert.deepEqual(Object.keys(document.env), [...WIN_WORKER_USER_DATA_ENV_KEYS]);
  const url = `postgresql://psstamp-win-worker-mid@${OUTPUTS.POSTGRES_FQDN}:5432/pilotswarm?sslmode=require`;
  assert.deepEqual(document.env, {
    DATABASE_URL: url,
    PILOTSWARM_CMS_FACTS_DATABASE_URL: url,
    PILOTSWARM_DB_AAD_USER: "psstamp-win-worker-mid",
    AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net",
    PS_DISK_POOL_CONTROLLER_URL: "https://10.20.15.250:3003",
    PS_DISK_CONTROLLER_TOKEN_SCOPE: `${PORTAL_APP}/.default`,
    AZURE_CLIENT_ID: WORKER_CLIENT,
    EXPECTED_WIN_WORKER_OID: WORKER_OID,
    ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: JSON.stringify({ endpointCredentials: [] }),
    WIN_WORKER_CONFIG_VERSION: configVersion,
    PILOTSWARM_WORKER_OWNER_ONLY: "1",
  });
  assert.equal(DISK_CONTROLLER_WORKER_URL, "https://10.20.15.250:3003");
  assert.ok(new X509Certificate(document.controllerCaCert).ca);
  // No password anywhere: database sign-in is the worker identity's.
  for (const key of ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL"]) assert.equal(new URL(document.env[key]).password, "");
  // The controller and the launcher both read the version.
  assert.match(configVersion, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => loadConfig({ ...diskControllerOverlayEnv(poolEnv()), WIN_WORKER_CONFIG_VERSION: configVersion }));
});

test("userData: the workers are owner-only whatever the env map says, and the deployment's feed endpoints and extra pairs go in", () => {
  for (const host of ["true", "false", undefined]) {
    const { document } = renderWinWorkerUserData(userDataEnv({ WIN_WORKER_COORDINATION_HOST: host }), { caPem: pki.caPem });
    assert.equal(document.env.PILOTSWARM_WORKER_OWNER_ONLY, "1", `WIN_WORKER_COORDINATION_HOST=${host}`);
  }
  const env = userDataEnv({
    WIN_WORKER_FEED_ENDPOINTS: "https://feeds.example.com/one/index.json, https://feeds.example.com/two/index.json",
    WIN_WORKER_EXTRA_ENV: "EXAMPLE_API_URL=https://api.example.com/v1?a=b ; EXAMPLE_API_SCOPE=api://example/.default",
  });
  const { document } = renderWinWorkerUserData(env, { caPem: pki.caPem });
  assert.equal(document.env.PILOTSWARM_WORKER_OWNER_ONLY, "1");
  assert.deepEqual(JSON.parse(document.env.ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS).endpointCredentials, [
    { endpoint: "https://feeds.example.com/one/index.json", azureClientId: WORKER_CLIENT },
    { endpoint: "https://feeds.example.com/two/index.json", azureClientId: WORKER_CLIENT },
  ]);
  assert.deepEqual(document.extraEnv, {
    EXAMPLE_API_URL: "https://api.example.com/v1?a=b",
    EXAMPLE_API_SCOPE: "api://example/.default",
  });
});

test("the configuration version follows every userData value and the settings a running VM can't take on", () => {
  const version = (extra = {}, caPem = pki.caPem) => renderWinWorkerUserData(userDataEnv(extra), { caPem }).configVersion;
  const base = version();
  assert.equal(version(), base, "deterministic");
  // A trailing newline in the stored CA changes nothing.
  assert.equal(version({}, `${pki.caPem.trim()}\n\n`), base);
  for (const [label, extra, caPem] of [
    ["VM size", { WIN_WORKER_VM_SIZE: "Standard_D32ds_v5" }],
    ["image version", { WIN_WORKER_IMAGE_VERSION: "1.0.20261201" }],
    ["extra pair", { WIN_WORKER_EXTRA_ENV: "EXAMPLE_MODE=on" }],
    ["extra value", { WIN_WORKER_EXTRA_ENV: "EXAMPLE_MODE=off" }],
    ["feed", { WIN_WORKER_FEED_ENDPOINTS: "https://feeds.example.com/one/index.json" }],
    ["database", { POSTGRES_FQDN: "my-pg.postgres.database.azure.com" }],
    ["storage", { AZURE_STORAGE_ACCOUNT_URL: "https://acct.blob.core.windows.net" }],
    ["identity", { WIN_WORKER_IDENTITY_CLIENT_ID: "88888888-8888-8888-8888-888888888888" }],
    ["token scope", { PORTAL_AUTH_ENTRA_CLIENT_ID: "99999999-9999-9999-9999-999999999999" }],
    ["CA", {}, createTestPki({ caName: "Other CA" }).caPem],
  ]) {
    assert.notEqual(version(extra, caPem), base, label);
  }
  // The pool's sizing that only the controller reads leaves running VMs alone.
  for (const extra of [{ WIN_WORKER_COUNT: "4" }, { WIN_WORKER_STANDBY_MIN: "2" }, { WIN_DEV_DRIVE_POOL_COUNT: "20" }]) {
    assert.equal(version(extra), base, JSON.stringify(extra));
  }
});

test("WIN_WORKER_EXTRA_ENV: NAME=VALUE pairs separated by semicolons; an empty setting gives none", () => {
  const extra = (value) => winWorkerExtraEnv({ WIN_WORKER_EXTRA_ENV: value });
  assert.deepEqual(extra(undefined), []);
  assert.deepEqual(extra("__PS_UNSET__"), []);
  assert.deepEqual(extra(" A_B=1;;C=x=y ; _D= "), [["A_B", "1"], ["C", "x=y"], ["_D", ""]]);
  assert.deepEqual(extra(`LONG=${"x".repeat(4096)}`)[0][1].length, 4096);
});

test("WIN_WORKER_EXTRA_ENV refuses every reserved prefix and name, without case, and names the userData or the launcher sets", () => {
  const refuse = (name, pattern) => assert.throws(() => winWorkerExtraEnv({ WIN_WORKER_EXTRA_ENV: `OK_NAME=1;${name}=x` }), pattern, name);
  assert.deepEqual([...WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES].sort(), [
    "ARTIFACTS_CREDENTIALPROVIDER_", "AZURE_", "COPILOT_", "GCM_", "GIT_", "NODE_", "NUGET_", "PILOTSWARM_", "PS_", "WIN_WORKER_",
  ]);
  for (const prefix of WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES) {
    for (const name of [`${prefix}EXAMPLE`, `${prefix.toLowerCase()}example`]) {
      refuse(name, new RegExp(`may not set ${name}: names starting with ${prefix} are reserved`));
    }
  }
  for (const name of ["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA",
    "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH", "GITHUB_TOKEN", "GH_TOKEN", "Path", "temp", "gh_token"]) {
    refuse(name, new RegExp(`may not set ${name}: it is reserved`));
  }
  // Every name the userData's env holds, whatever its prefix.
  for (const name of [...WIN_WORKER_USER_DATA_ENV_KEYS, "expected_win_worker_oid", "Database_Url"]) {
    refuse(name, new RegExp(`may not set ${name}: the workers' userData already sets it`));
  }
  for (const name of ["PILOTSWARM_WORKER_OWNER_TAG", "PS_LAUNCH_ID", "ps_launch_id"]) {
    refuse(name, new RegExp(`may not set ${name}: the workers' launcher sets it`));
  }
  // The image's own worker.env names outside the reserved prefixes.
  for (const name of ["SESSION_STATE_DIR", "MSBUILDDISABLENODEREUSE"]) refuse(name, /it is reserved/);
  // Names close to a reserved one are the deployment's own.
  assert.deepEqual(winWorkerExtraEnv({ WIN_WORKER_EXTRA_ENV: "PATHS=1;NODEX=2;GITHUB_URL=3;MY_PATH=4;EXPECTED=5" }).map(([name]) => name),
    ["PATHS", "NODEX", "GITHUB_URL", "MY_PATH", "EXPECTED"]);
});

test("WIN_WORKER_EXTRA_ENV refuses repeats, malformed entries and values the launcher would refuse, without echoing a value", () => {
  const extra = (value) => winWorkerExtraEnv({ WIN_WORKER_EXTRA_ENV: value });
  assert.throws(() => extra("A=1;a=2"), /WIN_WORKER_EXTRA_ENV sets a twice/);
  for (const [value, message] of [
    ["=secret-value", /entry 1 is not a NAME=VALUE pair/],
    ["OK=1;secret-value", /entry 2 is not a NAME=VALUE pair/],
    ["1A=secret-value", /entry 1: '1A' is not an environment variable name/],
    ["A B=secret-value", /entry 1: 'A B' is not an environment variable name/],
    [`${"A".repeat(129)}=secret-value`, /is not an environment variable name/],
    [`A=${"x".repeat(4097)}`, /the value of A is longer than 4096 characters/],
    ["A=secret\0value", /the value of A contains a NUL character/],
  ]) {
    assert.throws(() => extra(value), (error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes("secret"), "the message names no value");
      return true;
    }, value);
  }
  // The renderer refuses them before anything is rendered.
  assert.throws(() => renderWinWorkerUserData(userDataEnv({ WIN_WORKER_EXTRA_ENV: "PATH=C:\\x" }), { caPem: pki.caPem }), /may not set PATH/);
});

test("userData refuses to render without the stamp's outputs, with a value the launcher would refuse, or a CA that isn't one", () => {
  const render = (extra, caPem = pki.caPem) => renderWinWorkerUserData(userDataEnv(extra), { caPem });
  for (const key of ["POSTGRES_FQDN", "WIN_WORKER_IDENTITY_NAME", "WIN_WORKER_IDENTITY_CLIENT_ID", "EXPECTED_WIN_WORKER_OID"]) {
    assert.throws(() => render({ [key]: undefined }), new RegExp(`needs ${key}`), key);
  }
  assert.throws(() => render({ AZURE_STORAGE_ACCOUNT_URL: undefined, BLOB_CONTAINER_ENDPOINT: undefined }), /needs BLOB_CONTAINER_ENDPOINT/);
  assert.equal(render({ AZURE_STORAGE_ACCOUNT_URL: undefined, BLOB_CONTAINER_ENDPOINT: "https://example.blob.core.windows.net/" })
    .document.env.AZURE_STORAGE_ACCOUNT_URL, "https://example.blob.core.windows.net");
  assert.throws(() => render({ PORTAL_AUTH_ENTRA_CLIENT_ID: "__PS_UNSET__" }), /PORTAL_AUTH_ENTRA_CLIENT_ID/);
  for (const [extra, message] of [
    [{ WIN_WORKER_IDENTITY_CLIENT_ID: "not-a-guid" }, /refuses AZURE_CLIENT_ID: it must be a GUID/],
    [{ EXPECTED_WIN_WORKER_OID: "not-a-guid" }, /refuses EXPECTED_WIN_WORKER_OID: it must be a GUID/],
    [{ POSTGRES_FQDN: "bad host" }, /refuses DATABASE_URL: it must be a postgres:\/\/ or postgresql:\/\/ URL/],
    [{ AZURE_STORAGE_ACCOUNT_URL: "http://example.blob.core.windows.net" }, /refuses AZURE_STORAGE_ACCOUNT_URL: it must be a plain https:\/\/ URL/],
    [{ AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net/?sv=1" }, /refuses AZURE_STORAGE_ACCOUNT_URL/],
    [{ AZURE_STORAGE_ACCOUNT_URL: "https://user@example.blob.core.windows.net" }, /refuses AZURE_STORAGE_ACCOUNT_URL/],
    [{ WIN_WORKER_FEED_ENDPOINTS: "https://user:pw@feeds.example.com/index.json" }, /WIN_WORKER_FEED_ENDPOINTS entry .* is not a plain https URL/],
  ]) {
    assert.throws(() => render(extra), message, JSON.stringify(extra));
  }
  for (const caPem of [undefined, "", "not a certificate", pki.issueLeaf().pem, pki.caKeyPem]) {
    assert.throws(() => renderWinWorkerUserData(userDataEnv(), { caPem }), /the disk controller's CA certificates as PEM, and controllerCaCert /);
  }
  assert.throws(() => renderWinWorkerUserData(userDataEnv()), /the disk controller's CA certificates as PEM/);
});

test("controllerCaCert renders one CA, or both of a CA rotation, current first; every certificate is checked as the launcher checks it", async () => {
  const { BAD_CA_BUNDLES, CA_PEM, CA2_PEM } = await import("../../providers/azure/windows/test/fixtures.mjs");
  const one = renderWinWorkerUserData(userDataEnv(), { caPem: pki.caPem });
  // The deploy's bundle of one CA is the document of before CA rotations.
  assert.equal(renderWinWorkerUserData(userDataEnv(), { caPem: caBundle([pki.caPem]) }).userData, one.userData);
  assert.equal(one.document.controllerCaCert, `${pki.caPem.trim()}\n`);
  assert.equal(one.document.version, 1);
  const other = createTestPki({ caName: "Next CA" });
  const two = renderWinWorkerUserData(userDataEnv(), { caPem: caBundle([pki.caPem, other.caPem]) });
  assert.equal(two.document.controllerCaCert, `${pki.caPem.trim()}\n${other.caPem.trim()}\n`);
  assert.equal(two.document.version, 1, "the format keeps its version");
  assert.notEqual(two.configVersion, one.configVersion, "a new bundle recycles the VMs");
  assert.notEqual(renderWinWorkerUserData(userDataEnv(), { caPem: caBundle([other.caPem, pki.caPem]) }).configVersion, two.configVersion,
    "the current CA comes first, so a promote changes the bundle too");
  assert.doesNotThrow(() => checkWinWorkerUserData(structuredClone(two.document)));
  assert.doesNotThrow(() => renderWinWorkerUserData(userDataEnv(), { caPem: `${CA_PEM}${CA2_PEM}` }));
  for (const [label, bundle, message] of BAD_CA_BUNDLES) {
    assert.throws(() => renderWinWorkerUserData(userDataEnv(), { caPem: bundle }), message, label);
    assert.throws(() => checkWinWorkerUserData({ ...structuredClone(one.document), controllerCaCert: bundle }), message, label);
  }
});

test("rendered userData stays below Azure's 64 KiB, and a WIN_WORKER_EXTRA_ENV that would pass it is refused", () => {
  assert.equal(WIN_WORKER_USER_DATA_MAX_BYTES, 65536);
  const typical = renderWinWorkerUserData(userDataEnv({
    WIN_WORKER_FEED_ENDPOINTS: "https://feeds.example.com/one/index.json",
    WIN_WORKER_EXTRA_ENV: Array.from({ length: 10 }, (_, i) => `EXAMPLE_${i}=${"v".repeat(1000)}`).join(";"),
  }), { caPem: pki.caPem });
  assert.ok(typical.userData.length < WIN_WORKER_USER_DATA_MAX_BYTES, `${typical.userData.length} bytes`);
  const oversize = Array.from({ length: 13 }, (_, i) => `EXAMPLE_${i}=${"v".repeat(4096)}`).join(";");
  assert.throws(() => renderWinWorkerUserData(userDataEnv({ WIN_WORKER_EXTRA_ENV: oversize }), { caPem: pki.caPem }),
    /The Windows workers' userData is \d+ bytes of base64; Azure takes less than 65536\. Shorten WIN_WORKER_EXTRA_ENV\./);
});

test("the document check refuses what the launcher refuses: unknown, missing or invalid fields", () => {
  const { document } = renderWinWorkerUserData(userDataEnv({ WIN_WORKER_EXTRA_ENV: "EXAMPLE_MODE=on" }), { caPem: pki.caPem });
  assert.doesNotThrow(() => checkWinWorkerUserData(structuredClone(document)));
  const withoutExtra = structuredClone(document);
  delete withoutExtra.extraEnv;
  assert.doesNotThrow(() => checkWinWorkerUserData(withoutExtra), "extraEnv is optional");
  const changed = (change) => {
    const copy = structuredClone(document);
    change(copy);
    return copy;
  };
  const withEnv = (name, value) => changed((d) => { d.env[name] = value; });
  for (const [label, candidate, message] of [
    ["not an object", [], /must be a JSON object/],
    ["unknown field", changed((d) => { d.secrets = {}; }), /has unknown fields: secrets/],
    ["version", changed((d) => { d.version = 2; }), /must be version 1/],
    ["version as a string", changed((d) => { d.version = "1"; }), /must be version 1/],
    ["env not an object", changed((d) => { d.env = "x"; }), /env must be an object/],
    ["missing env name", changed((d) => { delete d.env.PS_DISK_CONTROLLER_TOKEN_SCOPE; }), /env lacks PS_DISK_CONTROLLER_TOKEN_SCOPE/],
    ["unknown env name", withEnv("EXAMPLE_MODE", "on"), /env holds names that are not userData settings \(extraEnv takes those\): EXAMPLE_MODE/],
    ["env name in another case", changed((d) => { d.env.database_url = d.env.DATABASE_URL; delete d.env.DATABASE_URL; }), /env lacks DATABASE_URL/],
    ["empty value", withEnv("PILOTSWARM_DB_AAD_USER", " "), /refuses PILOTSWARM_DB_AAD_USER: it is empty/],
    ["non-string value", withEnv("PILOTSWARM_WORKER_OWNER_ONLY", 1), /refuses PILOTSWARM_WORKER_OWNER_ONLY: it is empty/],
    ["database password", withEnv("DATABASE_URL", "postgresql://u:pw@h:5432/d"), /refuses DATABASE_URL: it carries a password/],
    ["facts database scheme", withEnv("PILOTSWARM_CMS_FACTS_DATABASE_URL", "mysql://u@h/d"), /refuses PILOTSWARM_CMS_FACTS_DATABASE_URL: it must be a postgres/],
    ["controller over http", withEnv("PS_DISK_POOL_CONTROLLER_URL", "http://10.20.15.250:3003"), /refuses PS_DISK_POOL_CONTROLLER_URL: it must be a plain https/],
    ["controller with a fragment", withEnv("PS_DISK_POOL_CONTROLLER_URL", "https://10.20.15.250:3003/#x"), /refuses PS_DISK_POOL_CONTROLLER_URL/],
    ["scope", withEnv("PS_DISK_CONTROLLER_TOKEN_SCOPE", "https://example.com/.default"), /refuses PS_DISK_CONTROLLER_TOKEN_SCOPE: it must be <client ID>\/\.default or api:\/\/<client ID>\/\.default/],
    ["scope with whitespace", withEnv("PS_DISK_CONTROLLER_TOKEN_SCOPE", `${PORTAL_APP}/.default `), /refuses PS_DISK_CONTROLLER_TOKEN_SCOPE/],
    ["client ID", withEnv("AZURE_CLIENT_ID", "worker"), /refuses AZURE_CLIENT_ID: it must be a GUID/],
    ["feeds not JSON", withEnv("ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS", "[nope"), /refuses ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: it is not JSON/],
    ["feeds shape", withEnv("ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS", "[]"), /it must be \{"endpointCredentials":\[\.\.\.\]\}/],
    ["feed without endpoint", withEnv("ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS", '{"endpointCredentials":[{"azureClientId":"x"}]}'), /it needs an endpoint in every entry/],
    ["feed password", withEnv("ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS", '{"endpointCredentials":[{"endpoint":"https://f.example.com/","password":"x"}]}'), /it carries a password/],
    ["configuration version", withEnv("WIN_WORKER_CONFIG_VERSION", "v 1"), /refuses WIN_WORKER_CONFIG_VERSION: it must be 1 to 128 letters, digits and \. _ : -/],
    ["long configuration version", withEnv("WIN_WORKER_CONFIG_VERSION", "a".repeat(129)), /refuses WIN_WORKER_CONFIG_VERSION/],
    ["owner-only", withEnv("PILOTSWARM_WORKER_OWNER_ONLY", "true"), /refuses PILOTSWARM_WORKER_OWNER_ONLY: it must be exactly "0" or "1"/],
    ["extraEnv not an object", changed((d) => { d.extraEnv = [["A", "1"]]; }), /extraEnv must be an object/],
    ["extraEnv name", changed((d) => { d.extraEnv = { "1A": "x" }; }), /extraEnv refuses '1A': it is not an environment variable name/],
    ["extraEnv reserved", changed((d) => { d.extraEnv = { gcm_interactive: "never" }; }), /extraEnv may not set gcm_interactive: names starting with GCM_ are reserved/],
    ["extraEnv userData name", changed((d) => { d.extraEnv = { expected_win_worker_oid: "x" }; }), /extraEnv may not set expected_win_worker_oid: the workers' userData already sets it/],
    ["extraEnv repeat", changed((d) => { d.extraEnv = { EXAMPLE: "1", example: "2" }; }), /extraEnv sets example twice/],
    ["extraEnv value type", changed((d) => { d.extraEnv = { EXAMPLE: 1 }; }), /extraEnv refuses the value of EXAMPLE: it is not a string/],
    ["extraEnv long value", changed((d) => { d.extraEnv = { EXAMPLE: "x".repeat(4097) }; }), /it is longer than 4096 characters/],
    ["extraEnv NUL", changed((d) => { d.extraEnv = { EXAMPLE: "a\0b" }; }), /it contains a NUL character/],
    ["no CA", changed((d) => { delete d.controllerCaCert; }), /CA certificates as PEM, and controllerCaCert holds/],
    ["leaf, not CA", changed((d) => { d.controllerCaCert = pki.issueLeaf().pem; }), /CA certificates as PEM, and controllerCaCert certificate 1 is not a CA certificate/],
  ]) {
    assert.throws(() => checkWinWorkerUserData(candidate), message, label);
  }
});
// ─── Manifests: parity without the pool, the controller beside the portal ───

const PORTAL_OVERLAYS = [
  ["afd", "letsencrypt", "afd-letsencrypt"],
  ["afd", "akv", "afd-akv"],
  ["private", "akv", "private-akv"],
  ["public", "letsencrypt", "public-letsencrypt"],
];
const CONTROLLER_OVERLAYS = PORTAL_OVERLAYS.filter(([edge]) => edge !== "public");
const PORTAL_SETTING_KEYS = Object.keys(PORTAL_SETTING_DEFAULTS);
// The keys of each portal overlay before the Windows worker pool, the same in
// all four. With the pool's and the portal's settings at their defaults, a
// staged overlay holds exactly these, so a key added for the pool can't change
// the portal's ConfigMap on a stamp that doesn't set it.
const UPSTREAM_PORTAL_OVERLAY_KEYS = [
  "IMAGE", "NAMESPACE", "KV_NAME", "WORKLOAD_IDENTITY_CLIENT_ID", "AZURE_TENANT_ID", "PORTAL_HOSTNAME",
  "PILOTSWARM_USE_MANAGED_IDENTITY", "PILOTSWARM_BLOB_USE_MANAGED_IDENTITY", "AZURE_STORAGE_ACCOUNT_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL", "PILOTSWARM_DB_AAD_USER", "DATABASE_URL",
  "HORIZON_EMBED_URL", "HORIZON_EMBED_MODEL", "HORIZON_EMBED_DIM", "HORIZON_EMBED_API_KEY_HEADER", "SPC_KEYS_HASH",
  "PORTAL_AUTH_PROVIDER", "PORTAL_AUTH_ENTRA_TENANT_ID", "PORTAL_AUTH_ENTRA_CLIENT_ID", "PORTAL_AUTH_ALLOW_UNAUTHENTICATED",
  "PORTAL_AUTH_ENTRA_ADMIN_GROUPS", "PORTAL_AUTH_ENTRA_USER_GROUPS", "PORTAL_AUTHZ_DEFAULT_ROLE",
  "PORTAL_AUTHZ_ADMIN_GROUPS", "PORTAL_AUTHZ_USER_GROUPS", "AUTHZ_ENFORCE_OWNERSHIP", "AUTHZ_ADMIN_SCOPE",
  "SESSIONS_DEFAULT_VISIBILITY", "SESSIONS_SYSTEM_VISIBILITY",
];

// What staging the worker, the portal and the controller reads; the database
// settings are those of a managed-identity stamp database.
function manifestEnv(extra = {}) {
  return {
    EDGE_MODE: "afd",
    TLS_SOURCE: "letsencrypt",
    FOUNDRY_ENDPOINT: "",
    IMAGE: "stub.azurecr.io/pilotswarm:t1",
    NAMESPACE: "pilotswarm",
    KV_NAME: "psstampkv",
    WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-00000000000a",
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
    // controller's manifests (beforeManifests).
    APPGW_TRUSTED_ROOT_CERT_NAMES: "pilotswarm-disk-controller-ca-0123456789ab",
    ...extra,
  };
}

function stage(t, service, env) {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-win-workers-stage-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  return stageManifests({ service, envName: "testenv", env, stagingDir });
}

const keyOf = (line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
const envLines = (path) => readFileSync(path, "utf8").split(/\r?\n/);
const envValues = (path) => Object.fromEntries(envLines(path).filter(keyOf).map((line) => [keyOf(line), line.slice(line.indexOf("=") + 1)]));
const overlayNamespace = (root, overlay) => /^namespace: (\S+)/m.exec(readFileSync(join(root, "overlays", overlay, "kustomization.yaml"), "utf8"))?.[1];

test("with the pool's and the portal's settings at their defaults, every staged portal overlay is as before", (t) => {
  const unsetAll = Object.fromEntries([...PORTAL_SETTING_KEYS, "DISPATCHER_SP_OBJECT_ID"].map((key) => [key, ""]));
  for (const [edge, tls, overlay] of PORTAL_OVERLAYS) {
    for (const extra of [{}, { WIN_WORKERS_ENABLED: "false", PERSONAL_KEY_VAULT_URI: "" }, unsetAll, { DISPATCHER_SP_OBJECT_ID: "__PS_UNSET__" }]) {
      const root = stage(t, "portal", manifestEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...extra }));
      const source = envLines(join(REPO_ROOT, "deploy/providers/azure/gitops/portal/overlays", overlay, ".env"));
      for (const key of [...PORTAL_SETTING_KEYS, "DISPATCHER_SP_OBJECT_ID"]) assert.ok(source.some((line) => keyOf(line) === key), `${overlay} names ${key}`);
      // The staged file has every line of the overlay as it was before the
      // pool, in order, and no other key.
      const before = source.filter((line) => !keyOf(line) || UPSTREAM_PORTAL_OVERLAY_KEYS.includes(keyOf(line)));
      const staged = envLines(join(root, "overlays", overlay, ".env"));
      assert.deepEqual(staged.map((line) => keyOf(line) ?? line), before.map((line) => keyOf(line) ?? line), `${overlay} ${JSON.stringify(extra)}`);
    }
  }
});

test("a portal setting away from its default reaches every staged portal overlay", (t) => {
  const settings = {
    PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: "1",
    PILOTSWARM_PERSONAL_SECRETS: "external",
    PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: "/app/deploy/providers/azure/secret-store/keyvault-personal-secret-store.mjs",
    PILOTSWARM_OWNER_ROUTING: "1",
    PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE: "1",
    PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC: "600",
    PILOTSWARM_SESSION_MESSAGE_SCOPE: "owner",
  };
  const dispatcher = "00000000-0000-4000-8000-0000000000d1";
  for (const [edge, tls, overlay] of PORTAL_OVERLAYS) {
    // The stamp's own personal vault, from base-infra's outputs.
    const fromOutput = envValues(join(stage(t, "portal", manifestEnv({
      EDGE_MODE: edge, TLS_SOURCE: tls, ...settings, DISPATCHER_SP_OBJECT_ID: dispatcher, PERSONAL_KEY_VAULT_URI: OUTPUTS.PERSONAL_KEY_VAULT_URI,
    })), "overlays", overlay, ".env"));
    assert.deepEqual(
      Object.fromEntries([...PORTAL_SETTING_KEYS, "DISPATCHER_SP_OBJECT_ID"].map((key) => [key, fromOutput[key]])),
      { ...settings, DISPATCHER_SP_OBJECT_ID: dispatcher, PILOTSWARM_PERSONAL_SECRET_VAULT_URI: OUTPUTS.PERSONAL_KEY_VAULT_URI },
      overlay,
    );
    // A vault the env file names wins over the stamp's own.
    const named = envValues(join(stage(t, "portal", manifestEnv({
      EDGE_MODE: edge, TLS_SOURCE: tls, PILOTSWARM_PERSONAL_SECRET_VAULT_URI: "https://test-vault.vault.azure.net/", PERSONAL_KEY_VAULT_URI: OUTPUTS.PERSONAL_KEY_VAULT_URI,
    })), "overlays", overlay, ".env"));
    assert.equal(named.PILOTSWARM_PERSONAL_SECRET_VAULT_URI, "https://test-vault.vault.azure.net/");
  }
});

test("the controller stages from the portal's env map: its own identity, base-infra's outputs, the portal's namespace", (t) => {
  for (const [edge, tls, overlay] of CONTROLLER_OVERLAYS) {
    const env = manifestEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...OUTPUTS, ...POOL, WIN_WORKER_CONFIG_VERSION: "a".repeat(64) });
    const portal = stage(t, "portal", env);
    const unchanged = structuredClone(env);
    const controller = stage(t, "disk-controller", env);
    assert.deepEqual(env, unchanged, "staging the controller changes nothing in the env map");

    const portalValues = envValues(join(portal, "overlays", overlay, ".env"));
    const values = envValues(join(controller, "overlays", overlay, ".env"));
    assert.equal(portalValues.WORKLOAD_IDENTITY_CLIENT_ID, env.WORKLOAD_IDENTITY_CLIENT_ID);
    assert.equal(values.WORKLOAD_IDENTITY_CLIENT_ID, CONTROLLER_CLIENT, "the controller's service account takes its own identity");
    assert.equal(values.PS_DISK_CONTROLLER_TOKEN_SCOPE, `${PORTAL_APP}/.default`);
    for (const key of ["PS_DISK_POOL_STATE_URL", "EXPECTED_WIN_WORKER_OID", "WIN_WORKER_SCALE_SET_ID", "WIN_WORKER_DCR_ID", "WIN_WORKER_GALLERY_IMAGE_ID"]) {
      assert.equal(values[key], OUTPUTS[key], key);
    }
    assert.equal(values.WIN_WORKER_STANDBY_POOL_ID, "__PS_UNSET__", "base-infra reported no standby pool");
    assert.equal(values.WIN_WORKER_CONFIG_VERSION, "a".repeat(64));
    assert.equal(values.PILOTSWARM_PERSONAL_SECRET_VAULT_URI, OUTPUTS.PERSONAL_KEY_VAULT_URI);
    assert.equal(values.PORTAL_HOSTNAME, portalValues.PORTAL_HOSTNAME);
    assert.equal(overlayNamespace(controller, overlay), overlayNamespace(portal, overlay));
    // The controller's own parser takes what the overlay hands it.
    assert.doesNotThrow(() => loadConfig(values));
    if (edge === "afd") assert.equal(values.APPGW_TRUSTED_ROOT_CERTS, env.APPGW_TRUSTED_ROOT_CERT_NAMES, "the roots the deploy step listed");
    // With App Gateway, staging needs the roots the deploy step lists.
    const unnamed = { ...env, APPGW_TRUSTED_ROOT_CERT_NAMES: undefined };
    if (edge === "afd") {
      assert.throws(() => stage(t, "disk-controller", unnamed), /dispatcher Ingress names App Gateway's trusted roots, which the Windows worker deploy step lists/);
    } else {
      assert.doesNotThrow(() => stage(t, "disk-controller", unnamed));
    }
  }
  assert.throws(() => stage(t, "disk-controller", manifestEnv()), /needs DISK_CONTROLLER_IDENTITY_CLIENT_ID/);
});

test("a stamp from before CA rotations stages the controller's overlay as before: its root under the same key, so neither the Ingress nor the controller changes", (t) => {
  for (const [edge, tls, overlay] of CONTROLLER_OVERLAYS.filter(([edge]) => edge === "afd")) {
    // What beforeManifests lists for a CA on the root named after the prefix.
    const env = manifestEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...OUTPUTS, ...POOL, APPGW_TRUSTED_ROOT_CERT_NAMES: "pilotswarm-disk-controller-ca" });
    const source = readFileSync(join(REPO_ROOT, "deploy/providers/azure/gitops/disk-controller/overlays", overlay, ".env"), "utf8");
    const staged = readFileSync(join(stage(t, "disk-controller", env), "overlays", overlay, ".env"), "utf8");
    const keys = (text) => text.split(/\r?\n/).map(keyOf).filter(Boolean);
    assert.deepEqual(keys(staged), keys(source), `${overlay}: the settings keep their keys`);
    assert.match(staged, /^APPGW_TRUSTED_ROOT_CERTS=pilotswarm-disk-controller-ca\r?$/m, overlay);
  }
});

const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

// Renders one overlay directory with `kubectl kustomize`, as Flux does, and
// returns its objects keyed by "Kind/name" (see workspaces.test.mjs).
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
  return Object.fromEntries(items.map((item) => [`${item.kind}/${item.metadata.name}`, item]));
}

test("rendered from one env map, the controller's objects sit in the portal's namespace, and the dispatcher Ingress has none of the portal's backend or probe values", (t) => {
  for (const [edge, tls, overlay] of CONTROLLER_OVERLAYS) {
    const env = manifestEnv({ EDGE_MODE: edge, TLS_SOURCE: tls, ...OUTPUTS, ...POOL });
    const portalObjects = render(t, join(stage(t, "portal", env), "overlays", overlay));
    if (!portalObjects) return;
    const objects = render(t, join(stage(t, "disk-controller", env), "overlays", overlay));
    const namespace = portalObjects["Deployment/pilotswarm-portal"].metadata.namespace;
    for (const [key, item] of Object.entries(objects)) assert.equal(item.metadata.namespace, namespace, key);
    for (const key of ["Deployment/pilotswarm-disk-controller", "Service/pilotswarm-disk-controller",
      "Service/pilotswarm-disk-controller-dispatcher", "Service/pilotswarm-disk-controller-coordination",
      "Ingress/pilotswarm-disk-controller-dispatcher"]) {
      assert.ok(objects[key], `${overlay}: ${key}`);
    }
    assert.ok(Object.keys(objects).some((key) => key.startsWith("NetworkPolicy/")), `${overlay}: NetworkPolicies`);

    const ingress = objects["Ingress/pilotswarm-disk-controller-dispatcher"];
    const [rule] = ingress.spec.rules;
    assert.equal(rule.host, env.PORTAL_HOSTNAME);
    assert.deepEqual(rule.http.paths.map((p) => [p.path, p.backend.service.name, p.backend.service.port.number]), [
      ["/disk-pool/v1/disks/", "pilotswarm-disk-controller-dispatcher", 3004],
      ["/disk-pool/v1/owners/", "pilotswarm-disk-controller-dispatcher", 3004],
    ]);
    const annotations = ingress.metadata.annotations ?? {};
    const portalIngress = Object.values(portalObjects).find((item) => item.kind === "Ingress");
    const portalAnnotations = portalIngress.metadata.annotations ?? {};
    for (const key of Object.keys(annotations).filter((name) => /backend-hostname|health-probe|request-timeout|proxy-(read|send)-timeout|proxy-body-size/.test(name))) {
      assert.notEqual(annotations[key], portalAnnotations[key], `${overlay}: ${key}`);
    }
    for (const value of [env.PORTAL_HOSTNAME, "/api/health", "3001"]) {
      assert.ok(!Object.entries(annotations).some(([key, v]) => /backend|probe/.test(key) && v === value), `${overlay}: no portal ${value}`);
    }
    if (edge === "afd") {
      assert.equal(annotations["appgw.ingress.kubernetes.io/backend-hostname"], `pilotswarm-disk-controller-dispatcher.${namespace}.svc`);
      assert.equal(annotations["appgw.ingress.kubernetes.io/health-probe-path"], "/disk-pool/v1/healthz");
      assert.equal(annotations["appgw.ingress.kubernetes.io/health-probe-port"], "3004");
      assert.equal(annotations["appgw.ingress.kubernetes.io/appgw-trusted-root-certificate"], env.APPGW_TRUSTED_ROOT_CERT_NAMES);
      assert.ok(!("cert-manager.io/cluster-issuer" in annotations));
    } else {
      assert.equal(annotations["nginx.ingress.kubernetes.io/proxy-ssl-name"], `pilotswarm-disk-controller-dispatcher.${namespace}.svc`);
      assert.equal(annotations["nginx.ingress.kubernetes.io/proxy-ssl-secret"], `${namespace}/pilotswarm-disk-controller-ca`);
    }
  }
});

// ─── Bicep ───

const main = readBicep("main.bicep");
const vnet = readBicep("vnet.bicep");
const winWorkers = readBicep("win-workers.bicep");
const alerts = readBicep("win-worker-alerts.bicep");

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

function cidr(value) {
  const [address, bits] = value.split("/");
  const number = address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  return { first: number - (number % size), last: number - (number % size) + size - 1 };
}
const overlaps = (a, b) => a.first <= b.last && b.first <= a.last;
const stringDefault = (source, name) => {
  const match = new RegExp(`^param ${name} string = '([^']*)'`, "m").exec(source);
  assert.ok(match, `param ${name} has a default`);
  return match[1];
};

test("everything the pool adds to base-infra is conditional on winWorkersEnabled, which defaults to false", () => {
  assert.match(main, /^param winWorkersEnabled bool = false\s*$/m);
  assert.match(main, /^param winWorkerImageVersion string = ''\s*$/m);
  for (const symbol of ["DeployKeyVault", "PersonalKeyVault", "VaultPrivateDnsZone", "PersonalKeyVaultPrivateEndpoint",
    "ControllerStorage", "ControllerStorageBlobPrivateEndpoint", "WinWorkerDcr", "WinWorkers", "WinWorkerAlerts"]) {
    assert.equal(conditionOf(main, symbol), "winWorkersEnabled", symbol);
  }
  for (const symbol of ["winWorkersNatIp", "winWorkersNat", "winWorkersSubnetNsg"]) {
    assert.equal(conditionOf(vnet, symbol), "winWorkersEnabled", symbol);
  }
  assert.match(vnet, /winWorkersEnabled \? winWorkersSubnetEntry : \[\]/);
  const uami = readBicep("uami.bicep");
  for (const symbol of ["winWorkerIdentity", "diskControllerIdentity"]) assert.equal(conditionOf(uami, symbol), "winWorkersEnabled", symbol);
  const storage = readBicep("storage.bicep");
  assert.equal(conditionOf(storage, "winWorkerReleasesContainer"), "winWorkersEnabled");
  const federation = readBicep("uami-federation.bicep");
  assert.equal(conditionOf(federation, "diskControllerFederation"), "!empty(diskControllerIdentityName)");
  assert.match(blockOf(main, "UamiFederation"), /diskControllerIdentityName: Uami\.outputs\.diskControllerIdentityName/);
  assert.match(uami, /^output diskControllerIdentityName string = winWorkersEnabled \? diskControllerIdentity\.name : ''\s*$/m);
  // The portal's credential stays as it is. The one for the Linux worker's
  // service account goes with the pool, since the worker then runs as the
  // coordination host, with its own identity, or not at all
  // (coordination-host.test.mjs); without the pool it is created as before.
  assert.equal(conditionOf(federation, "workerFederation"), "!winWorkersEnabled");
  assert.equal(conditionOf(federation, "portalFederation"), undefined);
  const postgres = readBicep("postgres.bicep");
  assert.equal(conditionOf(postgres, "allowWinWorkerEgress"), "!empty(winWorkerEgressIpAddress)");
  assert.match(blockOf(main, "Postgres"), /winWorkerEgressIpAddress: winWorkersEnabled \? Vnet!\.outputs\.winWorkersNatIpAddress : ''/);
  // Every pool output is empty without the pool, or comes from a module that
  // reports empty values then.
  for (const line of main.split(/\r?\n/).filter((l) => /^output (winWorker|diskPool|personalKeyVault|deployKeyVault)\w* /.test(l))) {
    assert.match(line, /= winWorkersEnabled \? |= Uami\.outputs\./, line);
  }
});

test("the scale set gets a capacity only when Bicep creates it, and the standby pool attaches to it by ID", () => {
  assert.match(winWorkers, /^var deployScaleSet = !empty\(imageVersion\)\s*$/m);
  assert.equal(conditionOf(winWorkers, "scaleSet"), "deployScaleSet && !scaleSetExists");
  const scaleSet = blockOf(winWorkers, "scaleSet");
  assert.match(scaleSet, /sku: \{\s*name: vmSize\s*tier: 'Standard'\s*capacity: initialCapacity\s*\}/);
  assert.equal(winWorkers.split("capacity:").length - 1, 1, "only the creation names a capacity");
  const module = blockOf(main, "WinWorkers");
  assert.match(module, /initialCapacity: winWorkerMinRunning/);
  assert.match(module, /scaleSetExists: winWorkerScaleSetExists/);
  assert.match(module, /adminPassword: winWorkerAdminPassword/);
  assert.match(main, /^@secure\(\)\r?\nparam winWorkerAdminPassword string = ''\s*$/m);
  assert.match(winWorkers, /^@secure\(\)\r?\nparam adminPassword string = ''\s*$/m);

  assert.equal(conditionOf(winWorkers, "standbyPool"), "deployScaleSet");
  const standbyPool = blockOf(winWorkers, "standbyPool");
  // By resource ID: an existing scale set is not in this deployment.
  assert.match(standbyPool, /attachedVirtualMachineScaleSetId: scaleSetId\b/);
  assert.match(winWorkers, /^var scaleSetId = resourceId\('Microsoft\.Compute\/virtualMachineScaleSets', scaleSetName\)\s*$/m);
  assert.match(standbyPool, /virtualMachineState: 'Deallocated'/);
  assert.match(standbyPool, /maxReadyCapacity: maxVms\s*minReadyCapacity: standbyMin/);
  assert.match(module, /maxVms: winWorkerCount/);
  assert.match(module, /standbyMin: winWorkerStandbyMin/);
  // The five roles the standby pool resource provider needs.
  assert.deepEqual([...blockOf(winWorkers, "standbyPoolRoleIds").matchAll(/'([0-9a-f-]{36})'|managedIdentityOperatorRoleId/g)].map((m) => m[1] ?? "f1a07417-d97a-45cb-824c-7a7467783830"), [
    "9980e02c-c2be-4d73-94e8-173b1dc7cf3c",
    "4d97b98b-1d4f-4787-a291-c67834d212e7",
    "f1a07417-d97a-45cb-824c-7a7467783830",
    "1ef6a3be-d0ac-425d-8c01-acb62866290b",
    "85a2d0d9-2eba-4c9c-b355-11c2cc0788ab",
  ]);
  assert.match(blockOf(winWorkers, "standbyPoolRoles"), /if \(deployScaleSet\)[\s\S]*principalId: standbyPoolPrincipalId/);
});

test("the scale set model: Flexible, one zone and fault domain, managed OS disk, one identity, userData, manual upgrades", () => {
  const scaleSet = blockOf(winWorkers, "scaleSet");
  for (const pattern of [
    /zones: \[\s*'1'\s*\]/,
    /orchestrationMode: 'Flexible'/,
    /platformFaultDomainCount: 1\b/,
    /upgradePolicy: \{\s*mode: 'Manual'\s*\}/,
    /automaticRepairsPolicy: \{\s*enabled: false\s*\}/,
    /securityType: 'Standard'/,
    /userData: userData/,
    /imageReference: \{\s*id: '\$\{imageDefinition\.id\}\/versions\/\$\{imageVersion\}'\s*\}/,
    /osDisk: \{\s*createOption: 'FromImage'\s*caching: 'ReadWrite'\s*diskSizeGB: 256\s*deleteOption: 'Delete'\s*managedDisk:/,
    /enableIPForwarding: false\s*deleteOption: 'Delete'/,
    /subnet: \{\s*id: workerSubnet\.id\s*\}/,
  ]) {
    assert.match(scaleSet, pattern);
  }
  assert.match(scaleSet, /identity: \{\s*type: 'UserAssigned'\s*userAssignedIdentities: \{\s*'\$\{workerIdentity\.id\}': \{\}\s*\}\s*\}/);
  assert.doesNotMatch(scaleSet, /SystemAssigned|diffDiskSettings/);
  assert.match(blockOf(main, "WinWorkers"), /userData: winWorkerUserData\s*workerIdentityName: Uami\.outputs\.winWorkerIdentityName/);
  // The gallery and its image definition come with the pool, before any image version.
  assert.equal(conditionOf(winWorkers, "gallery"), undefined);
  assert.match(blockOf(winWorkers, "imageDefinition"), /osType: 'Windows'\s*osState: 'Generalized'\s*hyperVGeneration: 'V2'/);
  assert.match(winWorkers, /^var imageDefinitionName = 'pilotswarm-win-worker'\s*$/m);
});

test("the Azure Monitor Agent signs in as the workers' identity, and their data collection rule feeds the main workspace", () => {
  const extension = blockOf(winWorkers, "monitorAgentExtension");
  assert.match(extension, /publisher: 'Microsoft\.Azure\.Monitor'\s*type: 'AzureMonitorWindowsAgent'/);
  assert.match(extension, /managedIdentity: \{\s*'identifier-name': 'mi_res_id'\s*'identifier-value': workerIdentity\.id\s*\}/);
  assert.match(blockOf(winWorkers, "scaleSet"), /extensions: \[\s*monitorAgentExtension\s*\]/);
  const dcr = readBicep("win-worker-dcr.bicep");
  assert.match(dcr, /kind: 'Windows'/);
  assert.match(dcr, /workspaceResourceId: logAnalyticsWorkspaceId/);
  assert.match(blockOf(main, "WinWorkerDcr"), /logAnalyticsWorkspaceId: LogAnalytics\.outputs\.workspaceId/);
});

test("the custom roles: the controller's on the resource group, subnet join on the worker subnet only, the secret writer on the personal vault", () => {
  const controller = blockOf(winWorkers, "controllerRole");
  assert.doesNotMatch(controller, /scope:/, "resource group scope");
  assert.match(controller, /principalId: controllerPrincipalId[\s\S]*roleDefinitions', diskPoolControllerRoleId\)/);
  const subnetJoin = blockOf(winWorkers, "controllerSubnetJoin");
  assert.match(subnetJoin, /scope: workerSubnet\b/);
  assert.match(subnetJoin, /roleDefinitions', workerSubnetJoinRoleId\)/);
  assert.match(blockOf(winWorkers, "controllerIdentityOperator"), /scope: workerIdentity\b/);
  const personalVault = readBicep("personal-keyvault.bicep");
  const writer = blockOf(personalVault, "assignSecretWriterToPortal");
  assert.match(writer, /scope: keyVault\b[\s\S]*principalId: portalPrincipalId[\s\S]*roleDefinitions', personalVaultWriterRoleId\)/);
  assert.match(blockOf(main, "PersonalKeyVault"), /portalPrincipalId: Uami\.outputs\.csiIdentityPrincipalId\s*personalVaultWriterRoleId: personalVaultWriterRoleId/);
  // Only the controller reads it.
  assert.match(blockOf(personalVault, "assignSecretsUserToController"), /scope: keyVault\b[\s\S]*principalId: controllerPrincipalId/);

  // The definitions the subscription owner creates, assignable in the subscription only.
  const definition = (key) => step.customRoleDefinition(step.CUSTOM_ROLES[key], SUBSCRIPTION);
  for (const key of Object.keys(step.CUSTOM_ROLES)) assert.deepEqual(definition(key).AssignableScopes, [`/subscriptions/${SUBSCRIPTION}`]);
  assert.deepEqual(definition("workerSubnetJoin").Actions, ["Microsoft.Network/virtualNetworks/subnets/join/action"]);
  assert.deepEqual(definition("personalVaultWriter").Actions, []);
  assert.deepEqual(definition("personalVaultWriter").DataActions, [
    "Microsoft.KeyVault/vaults/secrets/setSecret/action",
    "Microsoft.KeyVault/vaults/secrets/delete",
    "Microsoft.KeyVault/vaults/secrets/readMetadata/action",
  ]);
  const controllerActions = definition("diskPoolController").Actions;
  assert.ok(!controllerActions.some((action) => /subnets\/join|roleAssignments|KeyVault|Storage/i.test(action)), "no subnet join, grants, vault or storage");
  assert.ok(controllerActions.includes("Microsoft.Compute/virtualMachines/runCommands/write"));
  assert.ok(controllerActions.includes("Microsoft.Insights/dataCollectionRuleAssociations/write"));
});

const SECURITY = "securityWorkspaceId";
const MAIN = "mainWorkspaceId";
const EXPECTED_ALERTS = {
  "personal-vault-read": SECURITY,
  "deploy-vault-ca-key-read": SECURITY,
  "controller-state-access": SECURITY,
  "release-or-manifest-write": SECURITY,
  "sensitive-role-assignment": MAIN,
  "data-role-assignment": MAIN,
  "run-command": MAIN,
  "federated-credential-write": MAIN,
  "pod-exec": MAIN,
  "pod-created-directly": MAIN,
  "service-account-token": MAIN,
  "forced-session-delete": MAIN,
  "drive-quarantined": MAIN,
  "vm-crash-loop": MAIN,
  "vm-mass-silence": MAIN,
  "snapshot-refresh-failed": MAIN,
  "pool-full": MAIN,
  "drive-full": MAIN,
  "attach-without-turn": MAIN,
};

test("every alert rule queries its workspace and notifies the one action group", () => {
  const rules = [...blockOf(alerts, "rules").matchAll(/^  \{\r?\n    name: '([^']+)'[\s\S]*?^    workspaceId: (\w+)/gm)]
    .map(([, name, workspace]) => [name, workspace]);
  assert.deepEqual(Object.fromEntries(rules), EXPECTED_ALERTS);
  assert.equal(rules.length, Object.keys(EXPECTED_ALERTS).length, "no rule is listed twice");
  const alertRules = blockOf(alerts, "alertRules");
  assert.match(alertRules, /for rule in rulesWithWindow:/);
  assert.match(alerts, /^var rulesWithWindow = map\(rules, rule => union\(\{ windowSize: 'PT1H' \}, rule\)\)\s*$/m);
  assert.match(alertRules, /windowSize: rule\.windowSize\s/);
  assert.match(alertRules, /scopes: \[\s*rule\.workspaceId\s*\]/);
  assert.match(alertRules, /actionGroups: \[\s*actionGroup\.id\s*\]/);
  assert.match(alertRules, /evaluationFrequency: 'PT5M'/);
  assert.match(blockOf(alerts, "actionGroup"), /for \(email, i\) in alertEmails: \{\s*name: 'receiver-\$\{i\}'\s*emailAddress: email/);
  const module = blockOf(main, "WinWorkerAlerts");
  assert.match(module, /securityWorkspaceId: policyRestricted \? LogAnalyticsNsp!\.outputs\.workspaceId : LogAnalytics\.outputs\.workspaceId/);
  assert.match(module, /mainWorkspaceId: LogAnalytics\.outputs\.workspaceId/);
  assert.match(module, /alertEmails: winWorkerAlertEmails/);
  // Logs: kube-audit (with exec's get requests), blob logs of both accounts,
  // AuditEvent of the three vaults, to the security workspace.
  assert.match(blockOf(alerts, "aksAuditLogs"), /category: 'kube-audit'\s/);
  assert.doesNotMatch(alerts, /kube-audit-admin'/);
  for (const symbol of ["storageBlobLogs", "controllerBlobLogs", "stampKeyVaultLogs", "deployKeyVaultLogs", "personalKeyVaultLogs"]) {
    assert.match(blockOf(alerts, symbol), /workspaceId: securityWorkspaceId/, symbol);
  }
});

test("the alert queries match the records the controller and the portal write", () => {
  const sources = ["fleet.mjs", "pool.mjs", "refresh.mjs", "broker.mjs"]
    .map((file) => readFileSync(join(REPO_ROOT, "deploy/providers/azure/disk-controller/lib", file), "utf8")).join("\n");
  for (const event of ["drive.quarantine", "vms.crash-loop", "vms.mass-silence", "snapshot.refresh-failed", "pool.full", "drive.full"]) {
    assert.match(alerts, new RegExp(`entry\\.event\\) == "${event.replace(".", "\\.")}"`), event);
    assert.ok(sources.includes(`"${event}"`), `the controller writes ${event}`);
  }
  assert.match(sources, /ctl\.log\.alert\(/);
  assert.match(sources, /ctl\.log\.audit\("drive\.attach", \{\s*drive: disk\.name, vm: vm\.name, root: rootSessionId, owner, purpose: body\.purpose/);
  assert.match(sources, /ctl\.log\.audit\("vm\.admit", \{\s*vm: vm\.name, session: sessionId, root: rootSessionId, isSystem: body\.isSystem,\s*decision: answer\.decision,/);
  assert.match(readFileSync(join(REPO_ROOT, "deploy/providers/azure/disk-controller/lib/log.mjs"), "utf8"), /JSON\.stringify\(\{ time: [^,]+, level, event, \.\.\.clean\(fields\) \}\)/);
  const deployment = readFileSync(join(REPO_ROOT, "deploy/providers/azure/gitops/disk-controller/base/deployment.yaml"), "utf8");
  assert.match(deployment, /containers:\s*- name: disk-controller\b/);
  assert.match(alerts, /ContainerName == "disk-controller"/);
  const runtime = readFileSync(join(REPO_ROOT, "packages/app/web/runtime.js"), "utf8");
  assert.match(runtime, /event: "pilotswarm\.dispatcher_delegation"/);
  assert.match(alerts, /entry\.event\) == "pilotswarm\.dispatcher_delegation" and tostring\(entry\.action\) == "deleteSession" and tobool\(entry\.force\)/);
  // Each scheduled rule counts a row once, by its ingestion time.
  const withLets = ["attach-without-turn", "pod-exec"];
  for (const name of Object.keys(EXPECTED_ALERTS).filter((n) => !withLets.includes(n))) {
    const rule = new RegExp(`name: '${name}'[\\s\\S]*?query: join\\(\\[[\\s\\S]*?newRows\\s*\\], '\\\\n\\| '\\)`).exec(alerts);
    assert.ok(rule, `${name} reads only new rows`);
  }
  assert.match(blockOf(alerts, "podExecPipeline"), /'requests'\s*newRows\s/);
  assert.match(blockOf(alerts, "attachWithoutTurnLets"), /ingestion_time\(\) between \(ago\(20m\) \.\. ago\(15m\)\)/);
});

test("the attach alert matches every drive attach with an admission of its root on the same VM: before a turn's, around a check's", () => {
  const lets = blockOf(alerts, "attachWithoutTurnLets");
  // Every attach, a turn's or a check's, from the controller's audit record.
  assert.match(lets, /let attaches = records \| where tostring\(entry\.event\) == "drive\.attach" \| where ingestion_time\(\)/);
  assert.match(lets, /project attachedAt = TimeGenerated, vm, root, purpose = tostring\(entry\.purpose\);/);
  assert.match(lets, /let admissions = records \| where tostring\(entry\.event\) == "vm\.admit" and tostring\(entry\.decision\) == "admit" \| project admittedAt = TimeGenerated, vm, root;/);
  assert.doesNotMatch(alerts, /credential\.model/, "a cached model token asks the controller for nothing");
  const pipeline = blockOf(alerts, "attachWithoutTurnPipeline");
  assert.match(pipeline, /'attaches'\s*'join kind=leftouter admissions on vm, root'/);
  assert.match(pipeline, /\(purpose == "turn" and admittedAt between \(\(attachedAt - 30m\) \.\. \(attachedAt \+ 1m\)\)\)/);
  assert.match(pipeline, /\(purpose != "turn" and admittedAt between \(\(attachedAt - 23h\) \.\. \(attachedAt \+ 15m\)\)\)/);
  assert.match(pipeline, /by attachedAt, vm, root, purpose'\s*'where matched == 0'/);
  // A check looks 23 hours back from attaches up to 20 minutes old: a day's window.
  assert.match(blockOf(alerts, "rules"), /name: 'attach-without-turn'[^}]*windowSize: 'P1D'/);
  assert.equal([...blockOf(alerts, "rules").matchAll(/windowSize:/g)].length, 1, "every other rule reads an hour");
});

test("pod-exec alerts as an exec or attach session opens, once per request, and falls back to the end of a request without that stage", () => {
  const lets = blockOf(alerts, "podExecLets");
  assert.match(lets, /let requests = AKSAudit \| where tostring\(ObjectRef\.namespace\) == "\$\{namespace\}" \| where tostring\(ObjectRef\.resource\) == "pods" and tostring\(ObjectRef\.subresource\) in \("exec", "attach"\) \| where Stage in \("ResponseStarted", "ResponseComplete"\);/);
  assert.match(lets, /let started = requests \| where Stage == "ResponseStarted" \| distinct AuditId;/);
  const pipeline = blockOf(alerts, "podExecPipeline");
  assert.match(pipeline, /'where Stage == "ResponseStarted" or AuditId !in \(started\)'/);
  assert.match(pipeline, /'summarize arg_min\(TimeGenerated, \*\) by AuditId'/);
  assert.match(blockOf(alerts, "rules"), /name: 'pod-exec'[^}]*query: '\$\{podExecLets\}\\n\$\{podExecPipeline\}'/);
  // The other kube-audit rules are about completed requests.
  assert.match(blockOf(alerts, "auditLog"), /'where Stage == "ResponseComplete"'/);
  for (const name of ["pod-created-directly", "service-account-token"]) {
    assert.match(blockOf(alerts, "rules"), new RegExp(`name: '${name}'[^}]*query: join\\(\\[\\s*auditLog\\s`), name);
  }
});

test("the role assignment alerts exempt exactly the grants the deployment makes to the controller and the portal", () => {
  // Each grant module reports its grants on the watched scopes as they are made.
  const grantsOf = (source) => [...blockOf(source, "roleGrants").matchAll(/principalId: (\w+)\s*roleId: (\w+)\s*scope: ([\w.()]+)/g)]
    .map(([, principal, role, scope]) => `${principal}|${role}|${scope}`);
  const assigned = (source, symbol, scope) => {
    const block = blockOf(source, symbol);
    const principal = /principalId: (\w+)/.exec(block)[1];
    const role = /roleDefinitions', (\w+)\)/.exec(block)[1];
    return `${principal}|${role}|${scope}`;
  };
  const personalVault = readBicep("personal-keyvault.bicep");
  assert.match(blockOf(personalVault, "assignSecretsUserToController"), /scope: keyVault\b/);
  assert.match(blockOf(personalVault, "assignSecretWriterToPortal"), /scope: keyVault\b/);
  assert.deepEqual(grantsOf(personalVault), [
    assigned(personalVault, "assignSecretsUserToController", "keyVault.id"),
    assigned(personalVault, "assignSecretWriterToPortal", "keyVault.id"),
  ]);
  const state = readBicep("controller-storage.bicep");
  assert.match(blockOf(state, "assignStateContributorToController"), /scope: stateContainer\b/);
  assert.deepEqual(grantsOf(state), [assigned(state, "assignStateContributorToController", "stateContainer.id")]);
  assert.doesNotMatch(blockOf(winWorkers, "controllerRole"), /scope:/, "resource group scope");
  assert.deepEqual(grantsOf(winWorkers), [assigned(winWorkers, "controllerRole", "resourceGroup().id")]);
  assert.match(blockOf(main, "WinWorkerAlerts"),
    /ownRoleGrants: concat\(PersonalKeyVault!\.outputs\.roleGrants, ControllerStorage!\.outputs\.roleGrants, WinWorkers!\.outputs\.roleGrants\)/);
  assert.doesNotMatch(blockOf(main, "WinWorkerAlerts"), /portalPrincipalId/);

  // The rules exempt principal, role and scope together, never a principal alone.
  assert.match(alerts, /^var ownRoleGrantKeys = map\(ownRoleGrants, grant => toLower\(format\('"\{0\}\|\{1\}\|\{2\}"', grant\.principalId, grant\.roleId, grant\.scope\)\)\)\s*$/m);
  assert.match(alerts, /^var ownRoleGrantList = empty\(ownRoleGrantKeys\) \? '""' : join\(ownRoleGrantKeys, ', '\)\s*$/m);
  assert.match(blockOf(alerts, "roleAssignmentWrites"), /'extend assignment = strcat\(principal, "\|", role, "\|", scope\)'/);
  for (const name of ["sensitive-role-assignment", "data-role-assignment"]) {
    const rule = new RegExp(`name: '${name}'[\\s\\S]*?newRows\\s*\\]`).exec(alerts)[0];
    assert.match(rule, /'where assignment !in \(\$\{ownRoleGrantList\}\)'/, name);
    assert.doesNotMatch(rule, /principal (?:!=|==|!in)|controllerOid|portalOid/, name);
  }
  // Key Vault Certificate User reads a certificate's secret: getSecret.
  assert.match(blockOf(alerts, "dataRoleIds"), /'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba' \/\/ Key Vault Certificate User/);
});

test("the CA-key read alert fires for a read of the current key or a rotation's next key, and for no certificate", () => {
  const rule = /name: 'deploy-vault-ca-key-read'[\s\S]*?query: join\(\[([\s\S]*?)newRows/.exec(alerts)?.[1];
  assert.ok(rule, "the rule and its query");
  assert.match(rule, /'where OperationName == "SecretGet"'/);
  // The rule's filter on the secret's id: `contains` clauses joined by `or`.
  const filter = /'where secretId (contains "[^"]+"(?: or secretId contains "[^"]+")*)'/.exec(rule)?.[1];
  assert.ok(filter, "one filter on the secret's id");
  const needles = [...filter.matchAll(/contains "([^"]+)"/g)].map(([, needle]) => needle);
  const fires = (name) => needles.some((needle) => `https://vault.example/secrets/${name}/0123456789abcdef`.includes(needle));
  for (const name of [CA_KEY_SECRET, NEXT_CA_KEY_SECRET]) assert.ok(fires(name), `a read of ${name}`);
  for (const name of [CA_CERT_SECRET, NEXT_CA_CERT_SECRET, PREVIOUS_CA_CERT_SECRET]) assert.ok(!fires(name), `no alert for ${name}`);
});

test("the worker subnet: its NAT gateway, and an NSG that admits nothing and reaches only the controller and Blob", () => {
  const rules = blockOf(vnet, "winWorkersNsgRules").split(/name: '/).slice(1).map((rule) => {
    const field = (key) => new RegExp(`${key}: '?([^'\\r\\n]+)'?`).exec(rule)?.[1];
    return [rule.slice(0, rule.indexOf("'")), field("priority"), field("direction"), field("access"), field("protocol"),
      field("destinationAddressPrefix"), field("destinationPortRange")];
  });
  assert.deepEqual(rules, [
    ["DenyAllInboundFirst", "100", "Inbound", "Deny", "*", "*", "*"],
    ["AllowDiskControllerOutbound", "100", "Outbound", "Allow", "Tcp", "diskControllerWorkerPortIp", "3003"],
    ["AllowBlobPrivateEndpointOutbound", "105", "Outbound", "Allow", "Tcp", "storageBlobPrivateEndpointIp", "443"],
    ["AllowVnetDnsOutbound", "106", "Outbound", "Allow", "*", "dnsResolverInboundIp", "53"],
    ["DenyVnetOutbound", "110", "Outbound", "Deny", "*", "addressSpace", "*"],
    ["DenyVpnClientsOutbound", "111", "Outbound", "Deny", "*", "vpnClientAddressPool", "*"],
  ]);
  // The DNS and VPN rules exist only with the VPN gateway; four rules otherwise.
  assert.match(blockOf(vnet, "winWorkersNsgRules"), /\], vpnGatewayEnabled \? \[\s*\{\s*name: 'AllowVnetDnsOutbound'/);
  assert.match(blockOf(vnet, "winWorkersNsgRules"), /\], vpnGatewayEnabled \? \[\s*\{\s*name: 'DenyVpnClientsOutbound'/);
  assert.equal(stringDefault(vnet, "addressSpace"), "10.20.0.0/16");
  assert.equal(stringDefault(vnet, "diskControllerWorkerPortIp"), "10.20.15.250");
  assert.match(main, /^var diskControllerWorkerPortIp = '10\.20\.15\.250'\s*$/m);
  assert.match(blockOf(main, "Vnet"), /diskControllerWorkerPortIp: diskControllerWorkerPortIp\s*storageBlobPrivateEndpointIp: storageBlobPrivateEndpointIp/);
  // The controller's worker port is that address on its load balancer.
  const service = readFileSync(join(REPO_ROOT, "deploy/providers/azure/gitops/disk-controller/base/service-worker.yaml"), "utf8");
  assert.match(service, /10\.20\.15\.250/);
  assert.match(service, /port: 3003/);
  assert.equal(DISK_CONTROLLER_WORKER_URL, "https://10.20.15.250:3003");

  const subnet = blockOf(vnet, "winWorkersSubnetEntry");
  assert.match(subnet, /networkSecurityGroup: \{\s*id: winWorkersSubnetNsg\.id\s*\}\s*natGateway: \{\s*id: winWorkersNat\.id\s*\}/);
  assert.match(blockOf(vnet, "winWorkersNat"), /zones: \[\s*'1'\s*\][\s\S]*publicIpAddresses: \[\s*\{\s*id: winWorkersNatIp\.id/);
  assert.match(blockOf(vnet, "winWorkersNatIp"), /publicIPAllocationMethod: 'Static'/);
  const workerSubnet = cidr(stringDefault(vnet, "winWorkersSubnetPrefix"));
  assert.deepEqual(workerSubnet, cidr("10.20.32.0/24"));
  const space = cidr("10.20.0.0/16");
  assert.ok(workerSubnet.first >= space.first && workerSubnet.last <= space.last);
  for (const name of ["aksSubnetPrefix", "appGatewaySubnetPrefix", "appGatewayPrivateLinkSubnetPrefix", "gatewaySubnetPrefix",
    "dnsResolverInboundSubnetPrefix", "privateEndpointSubnetPrefix"]) {
    assert.ok(!overlaps(workerSubnet, cidr(stringDefault(vnet, name))), `the worker subnet overlaps ${name}`);
  }
  assert.ok(!overlaps(workerSubnet, cidr(stringDefault(main, "vpnClientAddressPool"))));
});

test("the private endpoints: the stamp's blob at .4, the controller's state at .5, the personal vault at .6 in pe-subnet", () => {
  assert.match(main, /^var controllerStorageBlobPrivateEndpointIp = '10\.20\.33\.5'\s*$/m);
  assert.match(main, /^var personalKeyVaultPrivateEndpointIp = '10\.20\.33\.6'\s*$/m);
  const peSubnet = cidr(stringDefault(vnet, "privateEndpointSubnetPrefix"));
  for (const address of ["10.20.33.4", "10.20.33.5", "10.20.33.6"]) {
    const ip = cidr(`${address}/32`).first;
    assert.ok(ip >= peSubnet.first + 4 && ip < peSubnet.last, `${address} is a usable pe-subnet address`);
  }
  const controllerEndpoint = blockOf(main, "ControllerStorageBlobPrivateEndpoint");
  assert.match(controllerEndpoint, /privateLinkResourceId: ControllerStorage!\.outputs\.storageAccountId\s*groupId: 'blob'/);
  assert.match(controllerEndpoint, /privateIpAddress: controllerStorageBlobPrivateEndpointIp\s*privateDnsZoneId: BlobPrivateDnsZone!\.outputs\.zoneId/);
  const vaultEndpoint = blockOf(main, "PersonalKeyVaultPrivateEndpoint");
  assert.match(vaultEndpoint, /privateLinkResourceId: PersonalKeyVault!\.outputs\.keyVaultId\s*groupId: 'vault'/);
  assert.match(vaultEndpoint, /privateIpAddress: personalKeyVaultPrivateEndpointIp\s*privateDnsZoneId: VaultPrivateDnsZone!\.outputs\.zoneId/);
  // privatelink.vaultcore.azure.net in the public cloud, linked with NxDomainRedirect like the blob zone.
  assert.match(blockOf(main, "VaultPrivateDnsZone"), /zoneName: 'privatelink\$\{replace\(environment\(\)\.suffixes\.keyvaultDns, '\.vault\.', '\.vaultcore\.'\)\}'/);
  assert.match(readBicep("private-dns-zone.bicep"), /resolutionPolicy: 'NxDomainRedirect'/);
  // The blob endpoint and its zone come with the pool too.
  assert.match(main, /^var privateEndpointsEnabled = policyRestricted \|\| winWorkersEnabled\s*$/m);
  assert.match(vnet, /^var privateEndpointSubnetEnabled = policyRestricted \|\| winWorkersEnabled\s*$/m);
});

test("the vaults and the controller's state account", () => {
  const personal = readBicep("personal-keyvault.bicep");
  for (const pattern of [/enableRbacAuthorization: true/, /enablePurgeProtection: true/, /softDeleteRetentionInDays: 7\b/,
    /publicNetworkAccess: policyRestricted \? 'SecuredByPerimeter' : 'Disabled'/, /bypass: 'None'\s*defaultAction: 'Deny'/]) {
    assert.match(personal, pattern);
  }
  const deployVault = readBicep("deploy-keyvault.bicep");
  assert.match(deployVault, /enableRbacAuthorization: true[\s\S]*enablePurgeProtection: true/);
  assert.match(deployVault, /policyRestricted \? \{\s*publicNetworkAccess: 'SecuredByPerimeter'\s*\} : \{\}/);
  assert.match(blockOf(deployVault, "assignSecretsOfficerToDeployer"), /if \(!empty\(deployPrincipalId\)\)[\s\S]*b86a8fe4-44ce-4948-aee5-eccb2c155cd7|kvSecretsOfficerRoleId/);
  assert.equal([...deployVault.matchAll(/roleAssignments@/g)].length, 1, "the deploying principal is the only one granted");
  const state = readBicep("controller-storage.bicep");
  for (const pattern of [/allowSharedKeyAccess: false/, /publicNetworkAccess: policyRestricted \? 'SecuredByPerimeter' : 'Disabled'/,
    /^var stateContainerName = 'disk-pool-state'\s*$/m]) {
    assert.match(state, pattern);
  }
  const grant = blockOf(state, "assignStateContributorToController");
  assert.match(grant, /scope: stateContainer\b[\s\S]*principalId: controllerPrincipalId/);
  assert.equal([...state.matchAll(/roleAssignments@/g)].length, 1, "the controller is the only one granted");
  assert.match(main, /^output diskPoolStateUrl string = winWorkersEnabled \? ControllerStorage!\.outputs\.stateContainerUrl : ''\s*$/m);
  // With the perimeter: the deploy-only vault in the stamp profile, the
  // personal vault and the state account in a profile without access rules.
  const nspModule = blockOf(main, "Nsp");
  assert.match(nspModule, /additionalEnforcedResourceIds: winWorkersEnabled \? \[\s*DeployKeyVault!\.outputs\.keyVaultId\s*\] : \[\]/);
  assert.match(nspModule, /privateOnlyResourceIds: winWorkersEnabled \? \[\s*PersonalKeyVault!\.outputs\.keyVaultId\s*ControllerStorage!\.outputs\.storageAccountId\s*\] : \[\]/);
  const nsp = readBicep("nsp.bicep");
  assert.equal(conditionOf(nsp, "privateOnlyProfile"), "!empty(privateOnlyResourceIds)");
  assert.doesNotMatch(blockOf(nsp, "privateOnlyProfile"), /accessRules/);
});

test("the main storage account: the portal identity's Blob grant moves to copilot-sessions, and the workers get container grants only", () => {
  const storage = readBicep("storage.bicep");
  assert.equal(conditionOf(storage, "assignBlobContributorToWorkerWorkload"), "!empty(workerWorkloadPrincipalId) && !winWorkersEnabled");
  assert.equal(conditionOf(storage, "assignSessionsContributorToWorkerWorkload"), "!empty(workerWorkloadPrincipalId) && winWorkersEnabled");
  assert.match(blockOf(storage, "assignSessionsContributorToWorkerWorkload"), /scope: sessionsContainer\b/);
  assert.match(blockOf(storage, "assignSessionsContributorToWinWorkers"), /scope: sessionsContainer\b[\s\S]*blobDataContributorDef/);
  assert.match(blockOf(storage, "assignReleasesReaderToWinWorkers"), /scope: winWorkerReleasesContainer\b[\s\S]*blobDataReaderDef/);
  assert.match(blockOf(storage, "winWorkerReleasesContainer"), /name: 'win-worker-releases'/);
});

test("PostgreSQL with the pool: Entra only, and a firewall that admits the cluster's and the workers' egress addresses only", () => {
  assert.match(main, /^var postgresEgressOnly = policyRestricted \|\| winWorkersEnabled\s*$/m);
  assert.match(main, /^var clusterEgressIpEnabled = .*\|\| winWorkersEnabled\s*$/m);
  const module = blockOf(main, "Postgres");
  assert.match(module, /aadOnly: edgeMode == 'public' \|\| postgresEgressOnly/);
  assert.match(module, /clusterEgressIpAddress: postgresEgressOnly \? horizonEgressIp!\.properties\.ipAddress : ''/);
  const postgres = readBicep("postgres.bicep");
  assert.equal(conditionOf(postgres, "allowAzureServices"), "empty(clusterEgressIpAddress)");
  assert.match(blockOf(postgres, "allowWinWorkerEgress"), /startIpAddress: winWorkerEgressIpAddress\s*endIpAddress: winWorkerEgressIpAddress/);
  assert.match(main, /^output winWorkerEgressIp string = winWorkersEnabled \? Vnet!\.outputs\.winWorkersNatIpAddress : ''\s*$/m);
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

// Builds run four at a time. On Windows the Azure CLI is a batch file, which
// Node starts only through cmd.exe (as common.mjs's run() does).
function azAsync(args) {
  const cli = resolveCli("az");
  const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
  const quote = (s) => (/[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const child = batch
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[cli, ...args].map(quote).join(" ")}"`], { windowsVerbatimArguments: true })
    : spawn(cli, args);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

async function buildBicep(dir, file) {
  const outfile = join(dir, `${file}.json`);
  const result = await azAsync(["bicep", "build", "--file", join(BICEP, file), "--outfile", outfile]);
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /\bError\b/, file);
  return JSON.parse(readFileSync(outfile, "utf8"));
}

test("every template the pool adds or changes compiles, and the compiled scale set keeps its capacity to its creation", { timeout: 600_000 }, async (t) => {
  if (!bicepWorks) {
    t.skip("the Azure CLI with Bicep is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ps-win-workers-bicep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = ["main.bicep", "win-workers.bicep", "win-worker-alerts.bicep", "win-worker-dcr.bicep", "personal-keyvault.bicep",
    "deploy-keyvault.bicep", "controller-storage.bicep", "vnet.bicep", "storage.bicep", "postgres.bicep", "nsp.bicep",
    "uami.bicep", "uami-federation.bicep", "private-endpoint.bicep", "private-dns-zone.bicep"];
  const built = {};
  const queue = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) built[file] = await buildBicep(dir, file);
  }));
  const template = built["main.bicep"];
  const module = template.resources.find((r) => r.type === "Microsoft.Resources/deployments" && String(r.name).includes("-win-workers-"));
  assert.equal(module.condition, "[parameters('winWorkersEnabled')]");
  const inner = module.properties.template.resources;
  const scaleSet = inner.find((r) => r.type === "Microsoft.Compute/virtualMachineScaleSets");
  assert.equal(scaleSet.condition, "[and(variables('deployScaleSet'), not(parameters('scaleSetExists')))]");
  assert.equal(scaleSet.sku.capacity, "[parameters('initialCapacity')]");
  assert.equal(Object.keys(scaleSet.identity.userAssignedIdentities).length, 1);
  assert.equal(inner.find((r) => r.type === "Microsoft.StandbyPool/standbyVirtualMachinePools").condition, "[variables('deployScaleSet')]");
  const gated = template.resources.filter((r) => r.type === "Microsoft.Resources/deployments" && r.condition === "[parameters('winWorkersEnabled')]");
  assert.equal(gated.length, 9, "the pool's nine modules");
});

// ─── The Windows worker deploy step ───

const option = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const notFound = (what) => ({ status: 3, stderr: `ERROR: (ResourceNotFound) The Resource '${what}' under resource group 'stamp-rg' was not found.` });
const secretNotFound = (name) => ({ status: 3, stderr: `ERROR: (SecretNotFound) A secret with (name/id) ${name} was not found in this key vault.` });

// Storage Blob Data Contributor, a built-in role.
const BLOB_DATA_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

const ROLE_DEFINITIONS = Object.values(step.CUSTOM_ROLES).map((role) => ({
  roleName: role.roleName,
  name: ROLE_IDS[role.envKey],
  permissions: [{ actions: [...role.actions], dataActions: [...role.dataActions] }],
}));

// An Azure CLI the test answers: role definitions, the scale set, the standby
// pool provider, the deploy-only vault, PostgreSQL's rule, the portal
// identity and its Blob grants, the scale set PATCH.
function fakeStepAz({
  roles = ROLE_DEFINITIONS, scaleSetExists = false, secrets = { [CA_CERT_SECRET]: pki.caPem }, ruleExists = false,
  accountGrants = [], containerGrants = [], standbyPools = [{ id: STANDBY_OID, displayName: step.STANDBY_POOL_PROVIDER_NAME }],
} = {}) {
  const calls = [];
  const patches = [];
  const stored = {};
  const accountScope = `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.Storage/storageAccounts/psstampsa`;
  const answer = (args) => {
    const is = (...words) => words.every((word, i) => args[i] === word);
    if (is("role", "definition", "list")) return { stdout: JSON.stringify(roles.filter((r) => r.roleName === option(args, "--name"))) };
    if (is("vmss", "show")) return scaleSetExists ? { stdout: `${OUTPUTS.WIN_WORKER_SCALE_SET_ID}\n` } : notFound("Microsoft.Compute/virtualMachineScaleSets/psstamp-win-workers");
    if (is("ad", "sp", "list")) return { stdout: JSON.stringify(standbyPools) };
    if (is("keyvault", "secret", "list")) {
      return { stdout: JSON.stringify(Object.keys({ ...secrets, ...stored }).map((name) => ({ name, attributes: { enabled: true } }))) };
    }
    if (is("keyvault", "secret", "show")) {
      const value = (stored[option(args, "--name")] ?? secrets[option(args, "--name")]);
      return value === undefined ? secretNotFound(option(args, "--name")) : { stdout: `${JSON.stringify(value)}\n` };
    }
    if (is("keyvault", "secret", "set")) {
      stored[option(args, "--name")] = readFileSync(option(args, "--file"), "utf8");
      return {};
    }
    if (is("rest", "--method", "patch")) {
      patches.push({ url: option(args, "--url"), body: JSON.parse(readFileSync(option(args, "--body").slice(1), "utf8")) });
      return {};
    }
    if (is("postgres", "flexible-server", "firewall-rule", "show")) return ruleExists ? { stdout: "{}" } : notFound("firewallRules/AllowAllAzureServices");
    if (is("postgres", "flexible-server", "firewall-rule", "delete")) return {};
    if (is("identity", "show")) return { stdout: `${PORTAL_OID}\n` };
    if (is("role", "assignment", "list")) {
      const scope = option(args, "--scope");
      const grants = scope === accountScope ? accountGrants : scope.endsWith("/containers/copilot-sessions") ? containerGrants : [];
      return { stdout: JSON.stringify(grants.map((g) => ({ scope, principalId: PORTAL_OID, roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${BLOB_DATA_CONTRIBUTOR}`, ...g }))) };
    }
    if (is("role", "assignment", "delete")) return {};
    return { status: 9, stderr: `unexpected az ${args.join(" ")}` };
  };
  const runFn = (name, args) => {
    assert.equal(name, "az");
    calls.push(args);
    return { status: 0, stdout: "", stderr: "", ...answer(args) };
  };
  return { calls, patches, stored, runFn, verbs: () => calls.map((args) => args.slice(0, args[0] === "postgres" ? 4 : 3).join(" ")) };
}

const stepEnv = (extra = {}) => ({
  SUBSCRIPTION_ID: SUBSCRIPTION, RESOURCE_GROUP: "stamp-rg", RESOURCE_PREFIX: "psstamp", EDGE_MODE: "afd",
  PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP, ...OUTPUTS, ...POOL, ...extra,
});

function privateTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "ps-win-workers-step-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the step's resource names follow base-infra's", () => {
  const names = step.winWorkerResourceNames({ SUBSCRIPTION_ID: SUBSCRIPTION, RESOURCE_GROUP: "stamp-rg", RESOURCE_PREFIX: "ps-stamp" });
  assert.equal(names.scaleSetName, "ps-stamp-win-workers");
  assert.equal(names.deployKeyVaultName, "psstampkvdep");
  assert.equal(names.personalKeyVaultName, "psstampkvpers");
  assert.equal(names.controllerStorageAccountName, "psstamppoolsa");
  assert.equal(names.storageAccountName, "psstampsa");
  assert.equal(names.postgresServerName, "ps-stamp-pg");
  assert.equal(names.portalIdentityName, "ps-stamp-csi-mid");
  for (const [variable, suffix] of [["deployKeyVaultName", "kvdep"], ["personalKeyVaultName", "kvpers"], ["controllerStorageAccountName", "poolsa"]]) {
    assert.match(main, new RegExp(`^var ${variable} = '\\$\\{alphaPrefix\\}${suffix}'\\s*$`, "m"));
  }
  assert.match(winWorkers, /^var scaleSetName = '\$\{resourceNamePrefix\}-win-workers'\s*$/m);
  assert.match(winWorkers, /^var galleryName = '\$\{alphaPrefix\}gallery'\s*$/m);
  assert.match(main, /^var storageAccountName = '\$\{alphaPrefix\}sa'\s*$/m);
  // Key Vault and storage account names keep to 24 characters for the
  // longest prefix the scaffolder makes (ps and 15 characters).
  const longest = step.winWorkerResourceNames({ SUBSCRIPTION_ID: SUBSCRIPTION, RESOURCE_GROUP: "rg", RESOURCE_PREFIX: `ps${"a".repeat(15)}` });
  for (const key of ["deployKeyVaultName", "personalKeyVaultName", "controllerStorageAccountName"]) assert.ok(longest[key].length <= 24, key);
});

test("the custom role definitions are found by name; a missing one stops the deploy with the definition to create", () => {
  const env = stepEnv();
  for (const key of Object.keys(ROLE_IDS)) delete env[key];
  const az = fakeStepAz();
  step.resolveCustomRoles(env, { runFn: az.runFn });
  for (const [key, value] of Object.entries(ROLE_IDS)) assert.equal(env[key], value, key);
  assert.deepEqual(az.calls.map((args) => [option(args, "--name"), option(args, "--scope"), args.includes("--custom-role-only")]),
    Object.values(step.CUSTOM_ROLES).map((role) => [role.roleName, `/subscriptions/${SUBSCRIPTION}`, true]));

  const missing = fakeStepAz({ roles: ROLE_DEFINITIONS.filter((r) => r.roleName !== "PilotSwarm Worker Subnet Join") });
  assert.throws(() => step.resolveCustomRoles(stepEnv(), { runFn: missing.runFn }), (error) => {
    assert.match(error.message, /needs a custom role definition that the subscription owner creates once, with `az role definition create --role-definition @<file>`/);
    const definition = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.deepEqual(definition, step.customRoleDefinition(step.CUSTOM_ROLES.workerSubnetJoin, SUBSCRIPTION));
    return true;
  });
  const failing = { runFn: () => ({ status: 1, stdout: "", stderr: "ERROR: (AuthorizationFailed) no access\nmore" }) };
  assert.throws(() => step.resolveCustomRoles(stepEnv(), failing), /Could not look up the custom role definition 'PilotSwarm Disk Pool Controller': ERROR: \(AuthorizationFailed\) no access$/);
});

test("before base-infra without an image version: only the role lookups, and no secure parameter", (t) => {
  const az = fakeStepAz();
  const env = stepEnv();
  assert.deepEqual(step.beforeBicep({ env, modules: ["base-infra"] }, { runFn: az.runFn, tmpRoot: privateTmp(t) }), { secureParameters: {} });
  assert.deepEqual(az.verbs(), ["role definition list", "role definition list", "role definition list"]);
  assert.equal(env.WIN_WORKER_SCALE_SET_EXISTS, undefined);
  const other = fakeStepAz();
  assert.deepEqual(step.beforeBicep({ env: stepEnv(), modules: ["portal"] }, { runFn: other.runFn }), { secureParameters: {} });
  assert.deepEqual(other.calls, []);
});

test("before base-infra creates the scale set: the administrator password is made once in the deploy-only vault and passed as a secure parameter", (t) => {
  const tmpRoot = privateTmp(t);
  const az = fakeStepAz();
  const env = stepEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104" });
  const { secureParameters } = step.beforeBicep({ env, modules: ["base-infra"] }, { runFn: az.runFn, tmpRoot });
  assert.deepEqual(az.verbs(), [
    "role definition list", "role definition list", "role definition list",
    "vmss show --resource-group", "ad sp list", "keyvault secret list", "keyvault secret show", "keyvault secret show", "keyvault secret set",
  ]);
  assert.deepEqual(az.calls.filter((args) => args[0] === "keyvault").map((args) => [args[2], option(args, "--vault-name"), option(args, "--name")]), [
    ["list", "psstampkvdep", undefined],
    ["show", "psstampkvdep", "disk-controller-ca-cert"],
    ["show", "psstampkvdep", "win-worker-admin-password"],
    ["set", "psstampkvdep", "win-worker-admin-password"],
  ]);
  const password = secureParameters["base-infra"].winWorkerAdminPassword;
  assert.match(password, /^[A-Za-z0-9!#%*+\-=?@_]{32}$/);
  assert.ok(/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password));
  assert.equal(az.stored["win-worker-admin-password"], password);
  assert.ok(!az.calls.some((args) => args.some((arg) => arg.includes(password))), "the password is never on a command line");
  assert.ok(!az.calls.some((args) => option(args, "--name") === CA_KEY_SECRET), "the CA key is never read");
  assert.deepEqual(readdirSync(tmpRoot), [], "the password file is gone");
  assert.equal(env.WIN_WORKER_SCALE_SET_EXISTS, "false");
  assert.equal(env.WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID, STANDBY_OID);
  assert.equal(env.WIN_WORKER_CA_CERT, pki.caPem);

  // The rendered parameters then carry the scale set's settings, never the password.
  const params = renderBaseInfra({ ...poolEnv(), ...env });
  assert.equal(params.winWorkerScaleSetExists.value, false);
  assert.ok(!JSON.stringify(params).includes(password));

  // A later creation reuses the kept password.
  const again = fakeStepAz({ secrets: { [CA_CERT_SECRET]: pki.caPem, [step.ADMIN_PASSWORD_SECRET]: password } });
  const second = step.beforeBicep({ env: stepEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104" }), modules: ["base-infra"] }, { runFn: again.runFn, tmpRoot });
  assert.equal(second.secureParameters["base-infra"].winWorkerAdminPassword, password);
  assert.ok(!again.verbs().includes("keyvault secret set"));
});

test("before base-infra with an existing scale set: no password, and Bicep leaves the scale set alone", (t) => {
  const az = fakeStepAz({ scaleSetExists: true });
  const env = stepEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104", WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: STANDBY_OID.toUpperCase() });
  assert.deepEqual(step.beforeBicep({ env, modules: ["base-infra"] }, { runFn: az.runFn, tmpRoot: privateTmp(t) }), { secureParameters: {} });
  assert.deepEqual(az.verbs().slice(3), ["vmss show --resource-group", "keyvault secret list", "keyvault secret show"], "no directory lookup with the principal set");
  assert.equal(env.WIN_WORKER_SCALE_SET_EXISTS, "true");
  assert.equal(env.WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID, STANDBY_OID);
  assert.equal(renderBaseInfra({ ...poolEnv(), ...env }).winWorkerScaleSetExists.value, true);
});

test("before base-infra during a CA rotation, the VMs' userData carries both trusted CAs, the current one first, and no key is read", async (t) => {
  const next = createTestPki({ caName: "Next CA" });
  const az = fakeStepAz({ scaleSetExists: true, secrets: { [CA_CERT_SECRET]: pki.caPem, [NEXT_CA_CERT_SECRET]: next.caPem } });
  const env = stepEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104", WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: STANDBY_OID });
  step.beforeBicep({ env, modules: ["base-infra"] }, { runFn: az.runFn, tmpRoot: privateTmp(t) });
  assert.equal(env.WIN_WORKER_CA_CERT, caBundle([pki.caPem, next.caPem]));
  assert.ok(!az.calls.some((args) => /-key/.test(option(args, "--name") ?? "")), "no key is read");
  const params = renderBaseInfra({ ...poolEnv(), ...env });
  assert.equal(decode(params.winWorkerUserData.value).controllerCaCert, caBundle([pki.caPem, next.caPem]));
  // An existing scale set's model takes it after base-infra, so new VMs trust both.
  const patched = fakeStepAz();
  await step.afterBicep({ env, modules: ["base-infra"] }, { runFn: patched.runFn, tmpRoot: privateTmp(t) });
  const { userData } = patched.patches[0].body.properties.virtualMachineProfile;
  assert.equal(decode(userData).controllerCaCert, caBundle([pki.caPem, next.caPem]));
});

test("before base-infra stops on an answer it can't read as absent: the scale set, the provider's principal, the CA", (t) => {
  const image = { WIN_WORKER_IMAGE_VERSION: "1.0.20261104" };
  const denied = fakeStepAz();
  const runFn = (name, args) => (args[0] === "vmss" ? { status: 1, stdout: "", stderr: "ERROR: (AuthorizationFailed) no access" } : denied.runFn(name, args));
  assert.throws(() => step.beforeBicep({ env: stepEnv(image), modules: ["base-infra"] }, { runFn }), /Cannot check whether scale set 'psstamp-win-workers' exists: ERROR: \(AuthorizationFailed\)/);
  for (const standbyPools of [[], [{ id: STANDBY_OID, displayName: "Standby Pool Resource Provider" }, { id: PORTAL_OID, displayName: "Standby Pool Resource Provider" }]]) {
    const az = fakeStepAz({ standbyPools });
    assert.throws(() => step.beforeBicep({ env: stepEnv(image), modules: ["base-infra"] }, { runFn: az.runFn }), /Set WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID/);
  }
  const noCa = fakeStepAz({ secrets: {} });
  assert.throws(() => step.beforeBicep({ env: stepEnv(image), modules: ["base-infra"] }, { runFn: noCa.runFn, tmpRoot: privateTmp(t) }),
    /vault psstampkvdep has none yet\. Deploy the disk-controller service once/);
});

test("the administrator password: 32 characters from random bytes without modulo bias, with every character class", () => {
  // 67 characters: a byte of 201 or more is dropped.
  let round = 0;
  const bytes = () => {
    round += 1;
    if (round === 1) return Buffer.alloc(64, 201);
    return Buffer.from([...Array.from({ length: 28 }, (_, i) => i % 24), 24, 49, 57, 66, ...Array(32).fill(0)]);
  };
  const password = step.generateAdminPassword(bytes);
  assert.equal(round, 2, "the first draw had no usable byte");
  assert.equal(password, "ABCDEFGHJKLMNPQRSTUVWXYZABCDa2!_");
  assert.notEqual(step.generateAdminPassword(), step.generateAdminPassword());
});

test("after base-infra: an existing scale set's model changes by a PATCH that never names its capacity", async (t) => {
  const tmpRoot = privateTmp(t);
  const az = fakeStepAz();
  const env = stepEnv({ WIN_WORKER_IMAGE_VERSION: "1.0.20261104", WIN_WORKER_SCALE_SET_EXISTS: "true", WIN_WORKER_CA_CERT: pki.caPem, WIN_WORKER_VM_SIZE: "Standard_D32ds_v5" });
  await step.afterBicep({ env, modules: ["base-infra"] }, { runFn: az.runFn, tmpRoot });
  assert.equal(az.patches.length, 1);
  const [{ url, body }] = az.patches;
  assert.equal(url, `${OUTPUTS.WIN_WORKER_SCALE_SET_ID}?api-version=${step.SCALE_SET_API_VERSION}`);
  assert.ok(step.SCALE_SET_API_VERSION >= "2023-09-01");
  assert.deepEqual(body, {
    sku: { name: "Standard_D32ds_v5", tier: "Standard" },
    properties: { virtualMachineProfile: {
      storageProfile: { imageReference: { id: `${OUTPUTS.WIN_WORKER_GALLERY_IMAGE_ID}/versions/1.0.20261104` } },
      userData: renderWinWorkerUserData(env, { caPem: pki.caPem }).userData,
    } },
  });
  assert.doesNotMatch(JSON.stringify(body), /capacity/);
  assert.deepEqual(readdirSync(tmpRoot), []);
  assert.throws(() => step.patchScaleSetModel({ scaleSetId: "x", body: { sku: { name: "Standard_D16ds_v5", capacity: 3 } } }, { runFn: az.runFn }),
    /must not name sku\.capacity/);

  // The deploy that created it, or one without an image version, sends none.
  for (const extra of [{ WIN_WORKER_SCALE_SET_EXISTS: "false" }, { WIN_WORKER_IMAGE_VERSION: "__PS_UNSET__" }]) {
    const fresh = fakeStepAz();
    await step.afterBicep({ env: { ...env, ...extra }, modules: ["base-infra"] }, { runFn: fresh.runFn, tmpRoot });
    assert.deepEqual(fresh.patches, []);
  }
});

test("after base-infra: an AllowAllAzureServices rule left on the server is deleted, unless the policy-restricted step owns that or the database is not the stamp's", async () => {
  const present = fakeStepAz({ ruleExists: true });
  await step.afterBicep({ env: stepEnv(), modules: ["base-infra"] }, { runFn: present.runFn });
  assert.deepEqual(present.verbs().slice(0, 2), ["postgres flexible-server firewall-rule show", "postgres flexible-server firewall-rule delete"]);
  const rule = `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/psstamp-pg/firewallRules/AllowAllAzureServices`;
  assert.equal(option(present.calls[1], "--ids"), rule);
  assert.ok(present.calls[1].includes("--yes"));
  const absent = fakeStepAz();
  await step.afterBicep({ env: stepEnv(), modules: ["base-infra"] }, { runFn: absent.runFn });
  assert.ok(!absent.verbs().includes("postgres flexible-server firewall-rule delete"));
  for (const extra of [{ AZURE_POLICY_RESTRICTED: "true" }, { DEPLOY_POSTGRES: "false" }]) {
    const skipped = fakeStepAz({ ruleExists: true });
    await step.afterBicep({ env: stepEnv(extra), modules: ["base-infra"] }, { runFn: skipped.runFn });
    assert.ok(!skipped.verbs().some((verb) => verb.startsWith("postgres")), JSON.stringify(extra));
  }
  const portalOnly = fakeStepAz({ ruleExists: true });
  await step.afterBicep({ env: stepEnv(), modules: ["portal"] }, { runFn: portalOnly.runFn });
  assert.deepEqual(portalOnly.calls, []);
});

test("after base-infra: the portal identity's account-wide Blob grant goes once its copilot-sessions grant exists", async () => {
  const account = `/subscriptions/${SUBSCRIPTION}/resourceGroups/stamp-rg/providers/Microsoft.Storage/storageAccounts/psstampsa`;
  const stale = { id: `${account}/providers/Microsoft.Authorization/roleAssignments/aaaa`, scope: account };
  const both = fakeStepAz({ accountGrants: [stale, { id: "other-principal", principalId: STANDBY_OID }], containerGrants: [{ id: "container-grant" }] });
  await step.afterBicep({ env: stepEnv(), modules: ["base-infra"] }, { runFn: both.runFn });
  const deletes = both.calls.filter((args) => args[0] === "role" && args[2] === "delete");
  assert.deepEqual(deletes.map((args) => option(args, "--ids")), [stale.id], "only the portal identity's account-wide grant");
  assert.equal(option(both.calls.find((args) => args[0] === "identity"), "--name"), "psstamp-csi-mid");

  const noContainerGrant = fakeStepAz({ accountGrants: [stale] });
  await assert.rejects(step.afterBicep({ env: stepEnv(), modules: ["base-infra"] }, { runFn: noContainerGrant.runFn }),
    /still has Blob access to the whole storage account psstampsa, and no grant on its copilot-sessions container yet/);
  assert.ok(!noContainerGrant.calls.some((args) => args[0] === "role" && args[2] === "delete"));

  const nothingStale = fakeStepAz();
  await step.afterBicep({ env: stepEnv(), modules: ["base-infra"] }, { runFn: nothingStale.runFn });
  assert.equal(nothingStale.calls.filter((args) => args[0] === "role" && args[1] === "assignment" && args[2] === "list").length, 1,
    "no container lookup without a stale grant");
});

test("an App Gateway trusted root is compared by certificate, whatever form Azure returns it in", () => {
  const der = new X509Certificate(pki.caPem).raw.toString("base64");
  assert.equal(step.trustedRootDer(der), der);
  assert.equal(step.trustedRootDer(pki.caPem), der);
  assert.equal(step.trustedRootDer(Buffer.from(pki.caPem).toString("base64")), der);
  assert.equal(step.trustedRootDer(""), "");
});

// The TLS step's openssl and vault, App Gateway (its trusted roots kept as
// Azure keeps them, with Azure's refusal of a second root for a certificate
// that another root holds), the cluster's credentials and kubectl.
function fakeManifestsTools({ roots = {} } = {}) {
  const openssl = createFakeOpenssl();
  const vaults = createFakeAz();
  const gateway = createFakeAppGateway({ roots });
  const calls = [];
  const applied = [];
  const runFn = (name, args, opts) => {
    calls.push({ name, args, opts });
    if (name === "openssl") return openssl.openssl(args);
    if (name === "kubectl") {
      applied.push({ manifest: readFileSync(option(args, "--filename"), "utf8"), kubeconfig: opts?.env?.KUBECONFIG });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[2] === "root-cert" && ["create", "update"].includes(args[3])) calls.at(-1).certificate = readFileSync(option(args, "--cert-file"), "utf8");
    const answer = gateway.az(args);
    if (answer) return answer;
    if (args[0] === "aks" && args[1] === "get-credentials") return { status: 0, stdout: "", stderr: "" };
    return vaults.az(args);
  };
  const uploads = () => calls.filter(({ args }) => args[2] === "root-cert" && ["create", "update"].includes(args[3]))
    .map(({ args, certificate }) => ({ verb: args[3], gateway: option(args, "--gateway-name"), name: option(args, "--name"), certificate }));
  return { runFn, calls, applied, vaults, gateway, uploads };
}

const manifestsStepEnv = (extra = {}) => stepEnv({
  NAMESPACE: "pilotswarm", KV_NAME: "psstampkv", PORTAL_HOSTNAME: "portal.example.com", AZURE_TENANT_ID: TENANT, ...extra,
});
const derSha256 = (pem) => createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
const rootFor = (pem, prefix = "pilotswarm-disk-controller-ca") => `${prefix}-${derSha256(pem).slice(0, 12)}`;
const LEGACY_ROOT = "pilotswarm-disk-controller-ca";

// A stamp deployed before CA rotations: its CA in the vaults, and on App
// Gateway under the root named after the prefix itself.
function existingStamp(t) {
  const first = fakeManifestsTools();
  step.beforeManifests({ env: manifestsStepEnv(), stagingDir: privateTmp(t) }, { runFn: first.runFn, tmpRoot: privateTmp(t) });
  const caPem = first.vaults.vault("psstampkvdep").get(CA_CERT_SECRET);
  const tools = fakeManifestsTools({ roots: { [LEGACY_ROOT]: Buffer.from(caPem).toString("base64") } });
  for (const vault of ["psstampkvdep", "psstampkv"]) {
    for (const [name, value] of first.vaults.vault(vault)) tools.vaults.vault(vault).set(name, value);
  }
  return { tools, caPem };
}

test("before the controller's manifests: its TLS, its CA on App Gateway as a root named by content and in the cluster, and its settings checked", (t) => {
  const tmpRoot = privateTmp(t);
  const stagingDir = privateTmp(t);
  const tools = fakeManifestsTools();
  const env = manifestsStepEnv();
  step.beforeManifests({ env, stagingDir }, { runFn: tools.runFn, tmpRoot });
  const caPem = tools.vaults.vault("psstampkvdep").get(CA_CERT_SECRET);
  assert.ok(new X509Certificate(caPem).ca, "the TLS step made the CA in the deploy-only vault");
  assert.ok(tools.vaults.vault("psstampkv").has("disk-controller-tls"), "and the leaf in the stamp vault");
  assert.ok(tools.vaults.events.some((event) => event.startsWith("grant Key Vault Secrets User") && event.endsWith(CONTROLLER_OID)));
  const [upload] = tools.uploads();
  assert.deepEqual([upload.verb, upload.gateway, upload.name], ["create", "psstamp-appgw", rootFor(caPem)]);
  assert.match(upload.name, /^pilotswarm-disk-controller-ca-[0-9a-f]{12}$/);
  assert.equal(new X509Certificate(upload.certificate).fingerprint256, new X509Certificate(caPem).fingerprint256);
  assert.equal(env.APPGW_TRUSTED_ROOT_CERT_NAMES, upload.name, "the dispatcher Ingress names that root");
  const credentials = tools.calls.find(({ args }) => args[0] === "aks");
  assert.equal(option(credentials.args, "--file"), join(stagingDir, "kubeconfig"));
  assert.equal(tools.applied.length, 1);
  assert.equal(tools.applied[0].kubeconfig, join(stagingDir, "kubeconfig"));
  assert.equal(tools.applied[0].manifest, caClusterManifest({ namespace: "pilotswarm", caPem }), "one CA: the objects of before rotations");
  assert.ok(tools.calls.findIndex(({ args }) => args[3] === "create") < tools.calls.findIndex(({ name }) => name === "kubectl"));
  assert.deepEqual(readdirSync(tmpRoot), [], "no key or certificate file stays behind");

  // Again, with the root there as Azure returns an uploaded PEM file: no upload.
  tools.calls.length = 0;
  step.beforeManifests({ env: manifestsStepEnv(), stagingDir }, { runFn: tools.runFn, tmpRoot });
  assert.deepEqual(tools.uploads(), []);
  assert.equal(tools.calls.filter(({ args }) => args[1] === "application-gateway").length, 1, "one read of the gateway");
  // Another certificate under the CA's own root name is put right.
  tools.gateway.state.roots.set(upload.name, Buffer.from(createTestPki({ caName: "Other CA" }).caPem).toString("base64"));
  step.beforeManifests({ env: manifestsStepEnv(), stagingDir }, { runFn: tools.runFn, tmpRoot });
  assert.deepEqual(tools.uploads().map((u) => [u.verb, u.name]), [["update", upload.name]]);
  assert.equal(tools.gateway.holderOf(caPem), upload.name);

  // Private edge: NGINX reads the CA from the cluster; no App Gateway, no root names.
  const privateEdge = fakeManifestsTools();
  const privateEnv = manifestsStepEnv({ EDGE_MODE: "private", APPGW_TRUSTED_ROOT_CERTS: "a,b" });
  step.beforeManifests({ env: privateEnv, stagingDir }, { runFn: privateEdge.runFn, tmpRoot });
  assert.ok(!privateEdge.calls.some(({ args }) => args[1] === "application-gateway"));
  assert.equal(privateEdge.applied.length, 1);
  assert.equal(privateEnv.APPGW_TRUSTED_ROOT_CERT_NAMES, undefined);
});

test("before the controller's manifests on a stamp from before CA rotations, its CA stays on the root it is on: nothing is uploaded and the Ingress names that root as before", (t) => {
  const { tools, caPem } = existingStamp(t);
  const env = manifestsStepEnv();
  step.beforeManifests({ env, stagingDir: privateTmp(t) }, { runFn: tools.runFn, tmpRoot: privateTmp(t) });
  assert.deepEqual(tools.uploads(), [], "App Gateway refuses a second root for one certificate, so none is asked for");
  assert.deepEqual(tools.gateway.writes, []);
  assert.deepEqual([...tools.gateway.state.roots.keys()], [LEGACY_ROOT]);
  assert.equal(env.APPGW_TRUSTED_ROOT_CERT_NAMES, LEGACY_ROOT);
  assert.equal(tools.gateway.holderOf(caPem), LEGACY_ROOT);
  // A root of any name that holds the CA serves, whatever the prefix.
  const renamed = manifestsStepEnv({ APPGW_TRUSTED_ROOT_CERTS: "stamp.roots" });
  step.beforeManifests({ env: renamed, stagingDir: privateTmp(t) }, { runFn: tools.runFn, tmpRoot: privateTmp(t) });
  assert.equal(renamed.APPGW_TRUSTED_ROOT_CERT_NAMES, LEGACY_ROOT);
  assert.deepEqual(tools.gateway.writes, []);
});

test("during a CA rotation on that stamp, only the next CA's root is uploaded, and the Ingress lists both roots, current first", (t) => {
  const { tools, caPem: current } = existingStamp(t);
  const next = createTestPki({ caName: "PilotSwarm disk controller CA 20260101" }).caPem;
  tools.vaults.vault("psstampkvdep").set(NEXT_CA_CERT_SECRET, next);
  const env = manifestsStepEnv({ APPGW_TRUSTED_ROOT_CERTS: "stamp.roots" });
  step.beforeManifests({ env, stagingDir: privateTmp(t) }, { runFn: tools.runFn, tmpRoot: privateTmp(t) });
  assert.deepEqual(tools.uploads().map((u) => [u.verb, u.name]), [["create", rootFor(next, "stamp.roots")]]);
  assert.equal(env.APPGW_TRUSTED_ROOT_CERT_NAMES, `${LEGACY_ROOT},${rootFor(next, "stamp.roots")}`);
  assert.equal(tools.gateway.holderOf(current), LEGACY_ROOT);
  assert.equal(tools.applied[0].manifest, caClusterManifest({ namespace: "pilotswarm", caPem: caBundle([current, next]) }));
  assert.ok(tools.calls.findLastIndex(({ args }) => args[2] === "root-cert") < tools.calls.findIndex(({ name }) => name === "kubectl"),
    "both roots are up before anything else changes");

  // The prefix is one name that App Gateway takes.
  for (const [prefix, message] of [
    ["pilotswarm-disk-controller-ca,pilotswarm-disk-controller-ca-next", /names the prefix .* not a list/],
    ["-leading-hyphen", /must be 1 to 67 letters, digits/],
    ["a".repeat(68), /must be 1 to 67 letters, digits/],
    ["with space", /must be 1 to 67 letters, digits/],
  ]) {
    const refused = fakeManifestsTools();
    assert.throws(() => step.beforeManifests({ env: manifestsStepEnv({ APPGW_TRUSTED_ROOT_CERTS: prefix }), stagingDir: privateTmp(t) },
      { runFn: refused.runFn, tmpRoot: privateTmp(t) }), message, prefix);
    assert.deepEqual(refused.calls, [], `${prefix}: refused before any command`);
  }
  assert.equal(step.trustedRootPrefix({ APPGW_TRUSTED_ROOT_CERTS: "a".repeat(67) }).length + 13, 80, "the longest prefix makes an 80-character name");
});

test("on that stamp, a whole rotation and cleanup leave the next CA's root alone, and cleanup deletes the root of the old name once nothing uses it", (t) => {
  const { tools, caPem: first } = existingStamp(t);
  const options = { runFn: tools.runFn, tmpRoot: privateTmp(t), log: () => {} };
  const dispatcher = { name: "bp-pilotswarm-dispatcher-3004", hostName: "pilotswarm-disk-controller-dispatcher.pilotswarm.svc" };
  // A deploy, and AGIC applying the Ingress it publishes.
  const deploy = () => {
    const env = manifestsStepEnv();
    step.beforeManifests({ env, stagingDir: privateTmp(t) }, options);
    tools.gateway.state.settings = [{ ...dispatcher, roots: env.APPGW_TRUSTED_ROOT_CERT_NAMES.split(",") }];
    return env.APPGW_TRUSTED_ROOT_CERT_NAMES;
  };
  const cleanup = () => runCaRotation({ env: manifestsStepEnv(), operation: "cleanup", stagingDir: privateTmp(t) }, options).deleted;
  assert.equal(deploy(), LEGACY_ROOT);
  assert.deepEqual(cleanup(), [], "the root of the old name holds the current CA");

  const next = startCaRotation({ deployVaultName: "psstampkvdep" }, options).next.pem;
  assert.equal(deploy(), `${LEGACY_ROOT},${rootFor(next)}`);
  promoteCaRotation(step.controllerTlsInputs(manifestsStepEnv()), options);
  assert.equal(deploy(), `${rootFor(next)},${LEGACY_ROOT}`, "the same two roots: promote changes nothing on App Gateway");
  assert.deepEqual(cleanup(), [], "the previous CA is still trusted");
  finishCaRotation({ deployVaultName: "psstampkvdep", stampVaultName: "psstampkv" }, options);
  assert.deepEqual(cleanup(), [], "until a deploy drops it, the Ingress still names the old root");
  assert.equal(deploy(), rootFor(next));
  assert.deepEqual(cleanup(), [LEGACY_ROOT]);
  assert.deepEqual([...tools.gateway.state.roots.keys()], [rootFor(next)]);
  assert.equal(tools.gateway.holderOf(first), undefined);
  assert.deepEqual(tools.uploads().map((u) => [u.verb, u.name]), [["create", rootFor(next)]], "one upload in the whole rotation");
});

test("before the controller's manifests, a setting the controller would refuse stops the deploy", (t) => {
  for (const [extra, message] of [
    [{ PORTAL_HOSTNAME: "unused" }, /deploy the portal first/],
    [{ WIN_DEV_DRIVE_SPARE_COUNT: "20" }, /WIN_DEV_DRIVE_SPARE_COUNT must not be above WIN_DEV_DRIVE_POOL_COUNT/],
    [{ WIN_WORKER_WORKING_HOURS: "always" }, /WIN_WORKER_WORKING_HOURS/],
    [{ DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID: "" }, /needs DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID/],
  ]) {
    const tools = fakeManifestsTools();
    assert.throws(() => step.beforeManifests({ env: manifestsStepEnv(extra), stagingDir: privateTmp(t) }, { runFn: tools.runFn, tmpRoot: privateTmp(t) }),
      message, JSON.stringify(extra));
    assert.ok(!tools.calls.some(({ name }) => name === "kubectl"), "nothing reached the cluster");
  }
});

test("with the pool, the composed database URL has no password: PostgreSQL takes Entra sign-in only", () => {
  const env = { EDGE_MODE: "afd", WIN_WORKERS_ENABLED: "true", POSTGRES_FQDN: OUTPUTS.POSTGRES_FQDN, POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "psstamp-csi-mid" };
  composeDerivedEnv(env);
  assert.equal(env.DATABASE_URL, `postgresql://psstamp-csi-mid@${OUTPUTS.POSTGRES_FQDN}:5432/pilotswarm?sslmode=require`);
  const off = { EDGE_MODE: "afd", POSTGRES_FQDN: OUTPUTS.POSTGRES_FQDN, POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "psstamp-csi-mid" };
  composeDerivedEnv(off);
  assert.ok(new URL(off.DATABASE_URL).password, "without the pool, afd keeps its password sign-in");
});

// ─── Wiring into deploy.mjs ───

// An Azure CLI on PATH that logs each call (with the parameter files of a
// deployment) and answers what a base-infra bicep step with the pool asks.
const FAKE_AZ = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const option = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const record = (extra = {}) => fs.appendFileSync(process.env.WW_TEST_CALLS, JSON.stringify({ args, ...extra }) + "\n");
const is = (...words) => words.every((word, i) => args[i] === word);
const fail = (message) => { console.error(message); process.exit(3); };
const answers = JSON.parse(fs.readFileSync(process.env.WW_TEST_ANSWERS, "utf8"));
if (is("--version")) { console.log("azure-cli (test)"); process.exit(0); }
if (is("account", "show")) { console.log(answers.subscription); process.exit(0); }
if (is("ad", "signed-in-user", "show")) process.exit(1);
if (is("group", "show")) process.exit(0);
if (is("deployment", "group", "create")) {
  const files = args.filter((arg, i) => args[i - 1] === "--parameters" && arg.startsWith("@")).map((arg) => arg.slice(1));
  record({ parameters: files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).parameters) });
  process.exit(0);
}
if (is("deployment", "group", "show")) { console.log(JSON.stringify(answers.outputs)); process.exit(0); }
if (is("keyvault", "secret", "set")) { record({ stored: fs.readFileSync(option("--file"), "utf8") }); process.exit(0); }
record();
if (is("role", "definition", "list")) { console.log(JSON.stringify(answers.roles.filter((r) => r.roleName === option("--name")))); process.exit(0); }
if (is("vmss", "show")) fail("ERROR: (ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachineScaleSets/psstamp-win-workers' under resource group 'stamp-rg' was not found.");
if (is("keyvault", "secret", "list")) {
  console.log(JSON.stringify(Object.keys(answers.secrets).map((name) => ({ name, attributes: { enabled: true } }))));
  process.exit(0);
}
if (is("keyvault", "secret", "show")) {
  const value = answers.secrets[option("--name")];
  if (value === undefined) fail("ERROR: (SecretNotFound) A secret with (name/id) " + option("--name") + " was not found in this key vault.");
  console.log(JSON.stringify(value));
  process.exit(0);
}
if (is("postgres", "flexible-server", "firewall-rule", "show")) fail("ERROR: (ResourceNotFound) The Resource 'AllowAllAzureServices' was not found.");
if (is("identity", "show")) { console.log(answers.portalPrincipalId); process.exit(0); }
if (is("role", "assignment", "list")) { console.log("[]"); process.exit(0); }
console.error("unexpected az call");
process.exit(9);
`;

let sequence = 0;
function deployWithFakeAz(t, { service = "base-infra", steps = "bicep", settings = {} } = {}) {
  const name = `ww${process.pid.toString(36)}${sequence++}`;
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  const dir = mkdtempSync(join(tmpdir(), "ps-win-workers-deploy-"));
  const temp = join(dir, "temp");
  mkdirSync(temp);
  t.after(() => {
    for (const path of [local, dir, join(REPO_ROOT, "deploy/.tmp", name), join(REPO_ROOT, "deploy/.tmp", `${service}-${name}`)]) {
      rmSync(path, { recursive: true, force: true });
    }
  });
  const env = {
    ...parseEnvFile(templateEnvPath()),
    SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT,
    RESOURCE_PREFIX: "psstamp", RESOURCE_GROUP: "stamp-rg", PORTAL_RESOURCE_NAME: "psstamp-portal",
    GLOBAL_RESOURCE_PREFIX: "psstampglobal", GLOBAL_RESOURCE_GROUP: "psstampglobal",
    FRONT_DOOR_ID: "fixture", FRONT_DOOR_PROFILE_NAME: "fixture", FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture",
    ACME_EMAIL: "operator@example.invalid", PORTAL_AUTH_ENTRA_CLIENT_ID: PORTAL_APP, PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    ...settings,
  };
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  writeFileSync(join(dir, "az.cjs"), FAKE_AZ);
  if (process.platform === "win32") {
    writeFileSync(join(dir, "az.cmd"), `@"${process.execPath}" "%~dp0az.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, "az"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/az.cjs" "$@"\n`, { mode: 0o755 });
  }
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const answers = join(dir, "answers.json");
  writeFileSync(answers, JSON.stringify({
    subscription: SUBSCRIPTION,
    roles: ROLE_DEFINITIONS,
    secrets: { [CA_CERT_SECRET]: pki.caPem },
    portalPrincipalId: PORTAL_OID,
    outputs: {
      postgresFqdn: { value: OUTPUTS.POSTGRES_FQDN },
      postgresAadAdminPrincipalName: { value: "psstamp-csi-mid" },
      winWorkerIdentityClientId: { value: WORKER_CLIENT },
    },
  }));

  const childEnv = { ...process.env };
  const ambient = [...Object.keys(env), ...Object.keys(AKS_ENV_DEFAULTS), ...Object.keys(OUTPUTS), ...Object.keys(ROLE_IDS), ...DATABASE_INPUT_KEYS,
    "WIN_WORKER_SCALE_SET_EXISTS", "WIN_WORKER_CA_CERT", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  for (const key of ambient) delete childEnv[key];
  const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  childEnv[pathKey] = `${dir}${delimiter}${childEnv[pathKey] ?? ""}`;
  for (const key of Object.keys(childEnv).filter((k) => ["TEMP", "TMP", "TMPDIR"].includes(k.toUpperCase()))) delete childEnv[key];
  Object.assign(childEnv, { TEMP: temp, TMP: temp, TMPDIR: temp, WW_TEST_CALLS: calls, WW_TEST_ANSWERS: answers });
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "deploy/scripts/deploy.mjs"), service, name, "--steps", steps, "--image-tag", "fixture",
  ], { cwd: REPO_ROOT, encoding: "utf8", env: childEnv });
  const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, logged, temp };
}

// The deploy's own messages go to stdout; its failures to stderr.
const output = ({ stdout, stderr }) => `${stdout.slice(-4000)}\n${stderr}`;
const verbsOf = (logged) => logged.map(({ args }) => args.slice(0, args[0] === "postgres" ? 4 : 3).join(" "));
const POOL_PARAMETERS = ["winWorkersEnabled", "winWorkerCount", "winWorkerMinRunning", "winWorkerStandbyMin", "winWorkerVmSize",
  "winWorkerImageVersion", "winWorkerAlertEmails", "diskPoolControllerRoleId", "workerSubnetJoinRoleId", "personalVaultWriterRoleId",
  "winWorkerScaleSetExists", "standbyPoolPrincipalId", "winWorkerUserData", "winWorkerConfigVersion", "winWorkerAdminPassword"];

test("deploy.mjs runs the Windows worker step around base-infra's Bicep only with WIN_WORKERS_ENABLED=true", (t) => {
  // Off: no step call, and no pool parameter in the rendered file.
  const off = deployWithFakeAz(t);
  assert.equal(off.result.status, 0, output(off.result));
  assert.deepEqual(verbsOf(off.logged), ["deployment group create"]);
  assert.equal(off.logged[0].parameters.length, 1);
  for (const name of POOL_PARAMETERS) assert.ok(!(name in off.logged[0].parameters[0]), name);

  // On, before an image version: the role lookups before, the clean-ups after.
  const on = deployWithFakeAz(t, { settings: { ...POOL } });
  assert.equal(on.result.status, 0, output(on.result));
  assert.deepEqual(verbsOf(on.logged), [
    "role definition list", "role definition list", "role definition list",
    "deployment group create",
    "postgres flexible-server firewall-rule show",
    "identity show --resource-group",
    "role assignment list",
  ]);
  const [parameters] = on.logged[3].parameters;
  assert.deepEqual(parameters.winWorkersEnabled, { value: true });
  assert.deepEqual(parameters.winWorkerAlertEmails, { value: ["ops@example.com"] });
  assert.deepEqual(parameters.diskPoolControllerRoleId, { value: ROLE_IDS.WIN_WORKER_CONTROLLER_ROLE_ID });
  assert.equal(parameters.winWorkerUserData, undefined, "no scale set without an image version");
  assert.equal(on.logged[3].parameters.length, 1, "no secure parameter");
});

test("deploy.mjs hands the administrator password to the deployment that creates the scale set as a secure parameter only", (t) => {
  const { result, logged, temp } = deployWithFakeAz(t, { settings: {
    ...POOL, WIN_WORKER_IMAGE_VERSION: "1.0.20261104",
    WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: STANDBY_OID,
    // base-infra's outputs from an earlier deploy, as the outputs cache holds them.
    POSTGRES_FQDN: OUTPUTS.POSTGRES_FQDN, POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "psstamp-csi-mid",
    BLOB_CONTAINER_ENDPOINT: "https://example.blob.core.windows.net/",
    WIN_WORKER_IDENTITY_NAME: OUTPUTS.WIN_WORKER_IDENTITY_NAME,
    WIN_WORKER_IDENTITY_CLIENT_ID: WORKER_CLIENT, EXPECTED_WIN_WORKER_OID: WORKER_OID,
  } });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(verbsOf(logged).slice(0, 9), [
    "role definition list", "role definition list", "role definition list",
    "vmss show --resource-group", "keyvault secret list", "keyvault secret show", "keyvault secret show", "keyvault secret set",
    "deployment group create",
  ]);
  const password = logged[7].stored;
  assert.match(password, /^.{32}$/);
  const [rendered, secure] = logged[8].parameters;
  assert.deepEqual(secure, { winWorkerAdminPassword: { value: password } });
  assert.ok(!JSON.stringify(rendered).includes(password), "the rendered file holds no password");
  assert.deepEqual(rendered.winWorkerScaleSetExists, { value: false });
  assert.equal(decode(rendered.winWorkerUserData.value).env.WIN_WORKER_CONFIG_VERSION, rendered.winWorkerConfigVersion.value);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password), "nor does the log");
  assert.ok(!logged.some(({ args }) => args.some((arg) => arg.includes(password))), "nor a command line");
  assert.deepEqual(readdirSync(temp), [], "the secure parameter file and the password file are gone");
});

test("deploy.mjs skips the disk controller unless WIN_WORKERS_ENABLED=true", (t) => {
  const { result, logged } = deployWithFakeAz(t, { service: "disk-controller", steps: "manifests" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WIN_WORKERS_ENABLED=false — 'disk-controller' is not deployed for this stamp/);
  assert.deepEqual(logged, [], "no Azure call");
});

// ─── With the Windows image's own readers ───

test("the rendered userData is what the Windows image's launcher and attacher read, and every name the launcher protects is refused at deploy time", async () => {
  const launcher = await import("../../providers/azure/windows/launcher.mjs");
  const { decodeAttacherUserData } = await import("../../providers/azure/windows/disk-attacher.mjs");
  const rotation = caBundle([pki.caPem, createTestPki({ caName: "Next CA" }).caPem]);
  for (const [extra, caPem] of [
    [{}, pki.caPem],
    [{}, rotation],
    [{
      WIN_WORKER_FEED_ENDPOINTS: "https://feeds.example.com/one/index.json, https://feeds.example.com/two/index.json",
      WIN_WORKER_EXTRA_ENV: "EXAMPLE_API_URL=https://api.example.com/v1?a=b ; EXAMPLE_API_SCOPE=api://example/.default",
    }, pki.caPem],
  ]) {
    const { userData, document } = renderWinWorkerUserData(userDataEnv(extra), { caPem });
    const decoded = launcher.decodeUserData(userData);
    assert.deepEqual(decoded.env, document.env);
    assert.deepEqual(decoded.extraEnv, document.extraEnv ?? {});
    assert.equal(decoded.controllerCaCert, document.controllerCaCert);
    const attacher = decodeAttacherUserData(userData);
    assert.equal(attacher.clientId, document.env.AZURE_CLIENT_ID.toLowerCase());
    assert.equal(attacher.accountUrl, `${new URL(document.env.AZURE_STORAGE_ACCOUNT_URL).origin}/`);
    assert.equal(attacher.controllerCaCert, document.controllerCaCert);
  }
  const protectedNames = [
    ...launcher.PROTECTED_EXTRA_NAMES,
    ...launcher.PROTECTED_EXTRA_PREFIXES.map((prefix) => `${prefix}EXAMPLE`),
    ...launcher.USER_DATA_SETTINGS,
    ...launcher.LAUNCHER_SETTINGS,
  ];
  for (const name of protectedNames) {
    assert.ok(launcher.isProtectedExtraName(name), name);
    for (const spelled of [name, name.toLowerCase()]) {
      assert.throws(() => renderWinWorkerUserData(userDataEnv({ WIN_WORKER_EXTRA_ENV: `${spelled}=x` }), { caPem: pki.caPem }),
        /WIN_WORKER_EXTRA_ENV may not set/, spelled);
    }
  }
});