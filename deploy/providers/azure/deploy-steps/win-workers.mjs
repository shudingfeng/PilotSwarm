// Windows worker pool deploy step for the Azure provider. deploy/scripts/deploy.mjs
// calls it only with WIN_WORKERS_ENABLED=true, around the steps that Bicep
// alone can't do for the pool:
//
//   before base-infra  look up the three custom role definitions that the
//                      subscription owner creates once (and print a missing
//                      one's definition). With WIN_WORKER_IMAGE_VERSION set:
//                      check whether the scale set exists, so Bicep sets its
//                      capacity only when it creates it; find the standby pool
//                      resource provider's principal; read the disk
//                      controller's trusted CA bundle for the VMs' userData;
//                      and, when the scale set is to be created, read or make
//                      the VMs' local administrator password in the
//                      deploy-only vault and hand it to Bicep as a secure
//                      parameter;
//   after base-infra   change an existing scale set's model with a PATCH that
//                      never names sku.capacity, which the controller owns;
//                      delete an AllowAllAzureServices firewall rule left on
//                      the stamp's PostgreSQL server; and delete the portal
//                      identity's old account-wide Blob grant once its
//                      container grant exists. An incremental deployment never
//                      deletes what the template no longer declares;
//   before the disk controller's manifests
//                      make the controller's TLS certificate (tls.mjs), make
//                      sure each trusted CA is on an App Gateway trusted root
//                      (afd) and list those roots for the dispatcher Ingress,
//                      put the CA bundle in the cluster for NGINX and the
//                      coordination host, and check the controller's settings
//                      with its own parser;
//   before the worker's manifests, with the pool
//                      delete the portal identity's federated credential for
//                      the worker's service account (`worker-fedcred`): the
//                      worker then runs as the coordination host, with its own
//                      identity, or runs no pod. Fail while one remains. With
//                      WIN_WORKER_COORDINATION_HOST=true, also put the
//                      controller's CA bundle in the cluster, making it first
//                      on a stamp's first deploy, where the worker comes before
//                      the controller; and, while two CAs are trusted, pass the
//                      bundle's hash to the host's staging, so a changed bundle
//                      restarts the host.
//
// The CA rotation (deploy/scripts/rotate-ca.mjs, ca-rotation.mjs) reuses
// these names and steps. Secrets never appear on a command line or in a log:
// they pass through files in a private temporary folder that is removed at
// once. Every Azure CLI and kubectl call goes through `runFn`, so tests can
// answer it.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, run } from "../../../scripts/lib/common.mjs";
import { deploysPostgres } from "../../../scripts/lib/database-env.mjs";
import { sfiCompliant, settingValue, winWorkerSettings, winWorkersEnabled } from "../../../scripts/lib/aks-env.mjs";
import { renderWinWorkerUserData } from "../../../scripts/lib/render-params.mjs";
import { diskControllerOverlayEnv } from "../../../scripts/lib/stage-manifests.mjs";
import { COORDINATION_HOST_CA_HASH_KEY, caBundleHash, coordinationHostEnabled } from "../../../scripts/lib/coordination-host.mjs";
import { applyCaToCluster, ensureDiskControllerTls, readTrustedCas } from "../disk-controller/tls.mjs";
import { loadConfig } from "../disk-controller/lib/config.mjs";

export const ADMIN_PASSWORD_SECRET = "win-worker-admin-password";
export const ALLOW_ALL_AZURE_SERVICES_RULE = "AllowAllAzureServices";
export const STANDBY_POOL_PROVIDER_NAME = "Standby Pool Resource Provider";
// The portal identity's credential for the Linux worker's service account,
// which uami-federation.bicep creates only without the Windows worker pool.
export const WORKER_FEDERATED_CREDENTIAL = "worker-fedcred";
export const WORKER_SERVICE_ACCOUNT = "copilot-runtime-worker";
// The Compute API version of the model PATCH; instance protection needs
// 2023-09-01 or later.
export const SCALE_SET_API_VERSION = "2024-11-01";
// App Gateway's trusted roots for the controller's CAs: a CA that a root
// holds already keeps that root, whatever its name, since App Gateway refuses
// a second root with the same certificate. A CA that no root holds is
// uploaded as `<prefix>-<first 12 hex of the SHA-256 of the CA's DER>`, and
// keeps that name through a rotation. APPGW_TRUSTED_ROOT_CERTS is the prefix;
// a stamp from before CA rotations has its CA on the root named after the
// prefix itself, which stays.
export const DEFAULT_TRUSTED_ROOT_PREFIX = "pilotswarm-disk-controller-ca";
// App Gateway names follow Azure's network naming rule: 1 to 80 letters,
// digits, `_`, `.` and `-`, starting with a letter or digit and ending with
// one or `_`. The `-<12 hex>` suffix leaves the prefix 67 characters.
const TRUSTED_ROOT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,66}$/;

const BLOB_DATA_CONTRIBUTOR_ROLE_ID = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const NOT_FOUND = /ResourceNotFound|ResourceGroupNotFound|ParentResourceNotFound|NotFound|was not found|could not be found/i;
const SECRET_NOT_FOUND = /SecretNotFound|was not found|could not be found|\(NotFound\)/i;

// The custom role definitions the subscription owner creates once. A role
// that can assign roles can't create role definitions, so the deploying
// principal only assigns them (win-workers.bicep, personal-keyvault.bicep).
// The controller's actions are those of deploy/providers/azure/disk-controller/README.md
// ("Permissions").
export const CUSTOM_ROLES = Object.freeze({
  diskPoolController: Object.freeze({
    envKey: "WIN_WORKER_CONTROLLER_ROLE_ID",
    roleName: "PilotSwarm Disk Pool Controller",
    description: "The PilotSwarm disk controller: Windows worker VMs, their Dev Drives and snapshots, NICs and data collection rule associations.",
    actions: Object.freeze([
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/attachDetachDataDisks/action",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/virtualMachines/runCommands/read",
      "Microsoft.Compute/virtualMachines/runCommands/write",
      "Microsoft.Compute/virtualMachines/runCommands/delete",
      "Microsoft.Compute/virtualMachineScaleSets/read",
      "Microsoft.Compute/virtualMachineScaleSets/write",
      "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/read",
      "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/write",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
      "Microsoft.Compute/snapshots/read",
      "Microsoft.Compute/snapshots/write",
      "Microsoft.Compute/snapshots/delete",
      "Microsoft.Compute/galleries/images/versions/read",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Network/networkInterfaces/join/action",
      "Microsoft.Insights/dataCollectionRuleAssociations/read",
      "Microsoft.Insights/dataCollectionRuleAssociations/write",
      "Microsoft.Insights/dataCollectionRuleAssociations/delete",
      "Microsoft.Insights/dataCollectionRules/read",
    ]),
    dataActions: Object.freeze([]),
  }),
  workerSubnetJoin: Object.freeze({
    envKey: "WIN_WORKER_SUBNET_JOIN_ROLE_ID",
    roleName: "PilotSwarm Worker Subnet Join",
    description: "Join a NIC to a subnet; assigned on the PilotSwarm Windows worker subnet only.",
    actions: Object.freeze(["Microsoft.Network/virtualNetworks/subnets/join/action"]),
    dataActions: Object.freeze([]),
  }),
  personalVaultWriter: Object.freeze({
    envKey: "WIN_WORKER_VAULT_WRITER_ROLE_ID",
    roleName: "PilotSwarm Personal Secret Writer",
    description: "Write and delete personal tokens in the PilotSwarm personal vault, and read their attributes; never read, recover or purge one.",
    actions: Object.freeze([]),
    dataActions: Object.freeze([
      "Microsoft.KeyVault/vaults/secrets/setSecret/action",
      "Microsoft.KeyVault/vaults/secrets/delete",
      "Microsoft.KeyVault/vaults/secrets/readMetadata/action",
    ]),
  }),
});

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0].slice(0, 300);
}

function privateFolder(tmpRoot) {
  const dir = mkdtempSync(join(tmpRoot, "pilotswarm-win-workers-"));
  chmodSync(dir, 0o700);
  return dir;
}

function modulesInclude(modules, name) {
  return Array.isArray(modules) && modules.includes(name);
}

// Resource names by the conventions of base-infra/bicep/main.bicep and its
// modules: the step runs before base-infra has reported any output.
export function winWorkerResourceNames(env) {
  for (const key of ["SUBSCRIPTION_ID", "RESOURCE_GROUP", "RESOURCE_PREFIX"]) {
    if (!env[key]) throw new Error(`The Windows worker deploy step needs ${key}.`);
  }
  const prefix = env.RESOURCE_PREFIX;
  const alpha = prefix.toLowerCase().replace(/[-_]/g, "");
  const group = `/subscriptions/${env.SUBSCRIPTION_ID}/resourceGroups/${env.RESOURCE_GROUP}`;
  return {
    subscriptionId: env.SUBSCRIPTION_ID,
    resourceGroup: env.RESOURCE_GROUP,
    resourceGroupId: group,
    scaleSetName: `${prefix}-win-workers`,
    scaleSetId: `${group}/providers/Microsoft.Compute/virtualMachineScaleSets/${prefix}-win-workers`,
    galleryImageId: `${group}/providers/Microsoft.Compute/galleries/${alpha}gallery/images/pilotswarm-win-worker`,
    deployKeyVaultName: `${alpha}kvdep`,
    personalKeyVaultName: `${alpha}kvpers`,
    controllerStorageAccountName: `${alpha}poolsa`,
    storageAccountName: `${alpha}sa`,
    stampKeyVaultName: `${alpha}kv`,
    postgresServerName: `${prefix}-pg`,
    applicationGatewayName: `${prefix}-appgw`,
    aksClusterName: `${prefix}-aks`,
    portalIdentityName: `${prefix}-csi-mid`,
  };
}

function azJson(runFn, args, what) {
  const result = runFn("az", [...args, "--output", "json"], { capture: true, allowFail: true });
  if (result.status !== 0) throw new Error(`Could not ${what}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(`Could not ${what}: the Azure CLI returned no JSON.`);
  }
}

// ─── Custom role definitions ───

// The definition `az role definition create --role-definition @<file>` takes.
export function customRoleDefinition(role, subscriptionId) {
  return {
    Name: role.roleName,
    IsCustom: true,
    Description: role.description,
    Actions: [...role.actions],
    NotActions: [],
    DataActions: [...role.dataActions],
    NotDataActions: [],
    AssignableScopes: [`/subscriptions/${subscriptionId}`],
  };
}

// Finds each custom role definition by name and sets its ID (a GUID) in the
// env map for render-params.mjs. A missing role stops the deploy with the
// definition the subscription owner creates; a role without one of the
// actions the pool needs is reported.
export function resolveCustomRoles(env, { runFn = run } = {}) {
  const { subscriptionId } = winWorkerResourceNames(env);
  const missing = [];
  for (const role of Object.values(CUSTOM_ROLES)) {
    const found = azJson(runFn, [
      "role", "definition", "list", "--custom-role-only", "true",
      "--name", role.roleName, "--scope", `/subscriptions/${subscriptionId}`,
    ], `look up the custom role definition '${role.roleName}'`) ?? [];
    const definition = (Array.isArray(found) ? found : []).find((d) => d?.roleName === role.roleName);
    if (!definition || !GUID.test(String(definition.name ?? ""))) {
      missing.push(role);
      continue;
    }
    const permissions = definition.permissions?.[0] ?? {};
    const have = new Set([...(permissions.actions ?? []), ...(permissions.dataActions ?? [])].map((a) => a.toLowerCase()));
    const lacking = [...role.actions, ...role.dataActions].filter((action) => !have.has(action.toLowerCase()));
    if (lacking.length > 0) {
      log("warn", `[win-workers] the custom role '${role.roleName}' lacks ${lacking.join(", ")}; the subscription owner should update it.`);
    }
    env[role.envKey] = String(definition.name).toLowerCase();
  }
  if (missing.length > 0) {
    const definitions = missing.map((role) => JSON.stringify(customRoleDefinition(role, subscriptionId), null, 2)).join("\n");
    throw new Error(
      `The Windows worker pool needs ${missing.length === 1 ? "a custom role definition" : "custom role definitions"} that ` +
        `the subscription owner creates once, with \`az role definition create --role-definition @<file>\` for each:\n${definitions}`,
    );
  }
}

// ─── The scale set, the standby pool's principal, the CA ───

// True when the scale set exists, false when Azure says that it, or its
// resource group, is not there. Any other failure stops the deploy: taking it
// for "absent" would make Bicep write the capacity of a scale set the
// controller runs.
export function scaleSetExists({ resourceGroup, name }, { runFn = run } = {}) {
  const result = runFn("az", [
    "vmss", "show", "--resource-group", resourceGroup, "--name", name, "--query", "id", "--output", "tsv",
  ], { capture: true, allowFail: true });
  if (result.status === 0) return true;
  if (NOT_FOUND.test(String(result.stderr ?? ""))) return false;
  throw new Error(`Cannot check whether scale set '${name}' exists: ${firstLine(result.stderr) || `exit ${result.status}`}`);
}

// The standby pool resource provider's service principal in this tenant:
// WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID when set, else looked up by its
// display name, which needs directory read access.
export function standbyPoolPrincipalId(env, { runFn = run } = {}) {
  const configured = settingValue(env, "WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID");
  if (configured) {
    if (!GUID.test(configured)) throw new Error("WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID must be an object ID.");
    return configured.toLowerCase();
  }
  const result = runFn("az", ["ad", "sp", "list", "--display-name", STANDBY_POOL_PROVIDER_NAME, "--output", "json"],
    { capture: true, allowFail: true });
  let ids = [];
  if (result.status === 0) {
    try {
      ids = (JSON.parse(result.stdout || "[]") ?? [])
        .filter((sp) => sp?.displayName === STANDBY_POOL_PROVIDER_NAME && GUID.test(String(sp.id ?? "")))
        .map((sp) => sp.id.toLowerCase());
    } catch {
      ids = [];
    }
  }
  if (ids.length !== 1) {
    throw new Error(
      `Could not find the '${STANDBY_POOL_PROVIDER_NAME}' service principal` +
        (result.status === 0 ? ` (${ids.length} found)` : `: ${firstLine(result.stderr) || `exit ${result.status}`}`) +
        ". Set WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID to its object ID in this tenant.",
    );
  }
  return ids[0];
}

function showSecret(runFn, vault, name) {
  const result = runFn("az", ["keyvault", "secret", "show", "--vault-name", vault, "--name", name, "--query", "value", "--output", "json"],
    { capture: true, allowFail: true });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (SECRET_NOT_FOUND.test(String(result.stderr ?? ""))) return null;
  throw new Error(`Could not read secret ${name} from vault ${vault}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
}

// The controller's trusted CA bundle, which the TLS step keeps in the
// deploy-only vault: the current CA and, during a CA rotation, the next or the
// previous one. Reading certificates raises no alert; no key is read.
export function readControllerCaBundle({ deployVaultName }, { runFn = run } = {}) {
  const trusted = readTrustedCas({ deployVaultName }, { runFn });
  if (!trusted) {
    throw new Error(
      `The Windows workers' userData carries the disk controller's CA certificate, and vault ${deployVaultName} has none yet. ` +
        "Deploy the disk-controller service once (its TLS step makes the CA), or leave WIN_WORKER_IMAGE_VERSION unset for this deploy.",
    );
  }
  return trusted.caBundle;
}

// ─── The VMs' local administrator password ───

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%*+-=?@_";

// 32 characters with an upper- and a lowercase letter, a digit and a symbol,
// as Windows requires; from random bytes without modulo bias.
export function generateAdminPassword(randomBytesFn = randomBytes) {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  for (;;) {
    let password = "";
    for (const byte of randomBytesFn(64)) {
      if (byte >= limit) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === 32) break;
    }
    if (password.length === 32 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)) {
      return password;
    }
  }
}

// Reads the VMs' shared local administrator password from the deploy-only
// vault, or makes it once and keeps it there. Nobody signs in with it:
// operators use Run Command.
export function ensureAdminPassword({ deployVaultName }, { runFn = run, randomBytesFn = randomBytes, tmpRoot = tmpdir() } = {}) {
  const existing = showSecret(runFn, deployVaultName, ADMIN_PASSWORD_SECRET);
  if (existing) return existing;
  const password = generateAdminPassword(randomBytesFn);
  const dir = privateFolder(tmpRoot);
  try {
    const path = join(dir, "password.txt");
    writeFileSync(path, password, { mode: 0o600 });
    const result = runFn("az", ["keyvault", "secret", "set", "--vault-name", deployVaultName, "--name", ADMIN_PASSWORD_SECRET,
      "--file", path, "--encoding", "utf-8", "--content-type", "text/plain", "--output", "none"], { capture: true, allowFail: true });
    if (result.status !== 0) {
      throw new Error(`Could not keep the Windows workers' administrator password in vault ${deployVaultName}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log("ok", `[win-workers] made the Windows workers' administrator password; it is kept only in vault ${deployVaultName}.`);
  return password;
}

// ─── The scale set model ───

// What a deploy changes in an existing scale set's model: the VMs' size, image
// and userData. It never names sku.capacity: the controller owns it, and a
// deploy that wrote it back would add or remove VMs behind the controller.
// Other model changes need the full Bicep apply inside the upgrade freeze,
// with the capacity read after the freeze starts.
export function scaleSetModelPatch({ vmSize, imageId, userData }) {
  return {
    sku: { name: vmSize, tier: "Standard" },
    properties: {
      virtualMachineProfile: {
        storageProfile: { imageReference: { id: imageId } },
        userData,
      },
    },
  };
}

export function patchScaleSetModel({ scaleSetId, body }, { runFn = run, tmpRoot = tmpdir() } = {}) {
  if (body?.sku && "capacity" in body.sku) throw new Error("A scale set model PATCH must not name sku.capacity.");
  const dir = privateFolder(tmpRoot);
  try {
    const path = join(dir, "model.json");
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    const result = runFn("az", ["rest", "--method", "patch", "--url", `${scaleSetId}?api-version=${SCALE_SET_API_VERSION}`,
      "--headers", "Content-Type=application/json", "--body", `@${path}`, "--output", "none"], { capture: true, allowFail: true });
    if (result.status !== 0) {
      throw new Error(`Could not update the model of scale set ${scaleSetId}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Stale grants and rules ───

// Deletes the rule when the server has it; returns whether it did.
export function deleteAllowAllAzureServicesRule({ subscriptionId, resourceGroup, serverName }, { runFn = run } = {}) {
  const ruleId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}/firewallRules/${ALLOW_ALL_AZURE_SERVICES_RULE}`;
  const show = runFn("az", ["postgres", "flexible-server", "firewall-rule", "show", "--ids", ruleId, "--output", "none"],
    { capture: true, allowFail: true });
  if (show.status !== 0) {
    if (NOT_FOUND.test(String(show.stderr ?? ""))) return false;
    throw new Error(
      `Cannot read the ${ALLOW_ALL_AZURE_SERVICES_RULE} firewall rule of PostgreSQL server '${serverName}': ` +
        `${firstLine(show.stderr) || `exit ${show.status}`}`,
    );
  }
  const removed = runFn("az", ["postgres", "flexible-server", "firewall-rule", "delete", "--ids", ruleId, "--yes", "--output", "none"],
    { capture: true, allowFail: true });
  if (removed.status !== 0) {
    throw new Error(`Could not delete the ${ALLOW_ALL_AZURE_SERVICES_RULE} firewall rule of PostgreSQL server '${serverName}': ${firstLine(removed.stderr) || `exit ${removed.status}`}`);
  }
  log("ok", `[win-workers] deleted the ${ALLOW_ALL_AZURE_SERVICES_RULE} firewall rule of PostgreSQL server ${serverName}.`);
  return true;
}

function blobContributorGrants(runFn, scope, principalId) {
  const assignments = azJson(runFn, ["role", "assignment", "list", "--scope", scope,
    "--fill-principal-name", "false", "--fill-role-definition-name", "false"], `list the role assignments on ${scope}`) ?? [];
  return (Array.isArray(assignments) ? assignments : []).filter((a) =>
    String(a?.scope ?? "").toLowerCase() === scope.toLowerCase() &&
    String(a?.principalId ?? "").toLowerCase() === principalId.toLowerCase() &&
    String(a?.roleDefinitionId ?? "").toLowerCase().endsWith(`/${BLOB_DATA_CONTRIBUTOR_ROLE_ID}`));
}

// With the pool, the portal identity's Blob grant is on the copilot-sessions
// container (storage.bicep). A role assignment's scope can't change, so on a
// stamp that turns the pool on later, the old account-wide grant stays until
// this deletes it, and only once the container grant exists. Returns the
// number of grants it deleted.
export function deleteAccountWideBlobGrant(names, { runFn = run } = {}) {
  const principal = runFn("az", ["identity", "show", "--resource-group", names.resourceGroup, "--name", names.portalIdentityName,
    "--query", "principalId", "--output", "tsv"], { capture: true, allowFail: true });
  if (principal.status !== 0) {
    throw new Error(`Could not read the portal identity ${names.portalIdentityName}: ${firstLine(principal.stderr) || `exit ${principal.status}`}`);
  }
  const principalId = String(principal.stdout ?? "").trim();
  if (!GUID.test(principalId)) throw new Error(`The portal identity ${names.portalIdentityName} has no principal ID.`);
  const accountId = `${names.resourceGroupId}/providers/Microsoft.Storage/storageAccounts/${names.storageAccountName}`;
  const stale = blobContributorGrants(runFn, accountId, principalId);
  if (stale.length === 0) return 0;
  const containerId = `${accountId}/blobServices/default/containers/copilot-sessions`;
  if (blobContributorGrants(runFn, containerId, principalId).length === 0) {
    throw new Error(
      `The portal identity still has Blob access to the whole storage account ${names.storageAccountName}, and no grant on its ` +
        "copilot-sessions container yet; deploy base-infra again before the old grant can go.",
    );
  }
  for (const assignment of stale) {
    const removed = runFn("az", ["role", "assignment", "delete", "--ids", assignment.id, "--output", "none"], { capture: true, allowFail: true });
    if (removed.status !== 0) {
      throw new Error(`Could not delete the account-wide Blob grant ${assignment.id}: ${firstLine(removed.stderr) || `exit ${removed.status}`}`);
    }
  }
  log("ok", `[win-workers] deleted the portal identity's account-wide Blob grant on ${names.storageAccountName}; it keeps its copilot-sessions grant.`);
  return stale.length;
}

// ─── Around base-infra's Bicep ───

// Before the bicep step's modules. Returns the secure parameters for
// deploy-bicep.mjs, by module.
export function beforeBicep({ env, modules }, { runFn = run, randomBytesFn = randomBytes, tmpRoot = tmpdir() } = {}) {
  if (!modulesInclude(modules, "base-infra")) return { secureParameters: {} };
  const names = winWorkerResourceNames(env);
  resolveCustomRoles(env, { runFn });
  const settings = winWorkerSettings(env);
  if (!settings.imageVersion) {
    log("info", "[win-workers] WIN_WORKER_IMAGE_VERSION is unset: base-infra creates the gallery and its image definition, and no scale set yet.");
    return { secureParameters: {} };
  }
  const exists = scaleSetExists({ resourceGroup: names.resourceGroup, name: names.scaleSetName }, { runFn });
  env.WIN_WORKER_SCALE_SET_EXISTS = String(exists);
  env.WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID = standbyPoolPrincipalId(env, { runFn });
  const deployVaultName = settingValue(env, "DEPLOY_KEY_VAULT_NAME") || names.deployKeyVaultName;
  env.WIN_WORKER_CA_CERT = readControllerCaBundle({ deployVaultName }, { runFn });
  if (exists) {
    log("info", `[win-workers] scale set ${names.scaleSetName} exists: Bicep leaves it alone, and its model is updated after the deployment.`);
    return { secureParameters: {} };
  }
  log("info", `[win-workers] scale set ${names.scaleSetName} does not exist yet: Bicep creates it with capacity ${settings.minRunning}.`);
  const password = ensureAdminPassword({ deployVaultName }, { runFn, randomBytesFn, tmpRoot });
  return { secureParameters: { "base-infra": { winWorkerAdminPassword: password } } };
}

// After the bicep step's modules. Each step is cheap and idempotent, so it
// also runs when a deploy marker skipped the module.
export async function afterBicep({ env, modules }, { runFn = run, tmpRoot = tmpdir() } = {}) {
  if (!modulesInclude(modules, "base-infra")) return;
  const names = winWorkerResourceNames(env);
  const settings = winWorkerSettings(env);
  if (settings.imageVersion && String(env.WIN_WORKER_SCALE_SET_EXISTS) === "true") {
    const imageId = `${settingValue(env, "WIN_WORKER_GALLERY_IMAGE_ID") || names.galleryImageId}/versions/${settings.imageVersion}`;
    const { userData, configVersion } = renderWinWorkerUserData(env, { caPem: env.WIN_WORKER_CA_CERT });
    const scaleSetId = settingValue(env, "WIN_WORKER_SCALE_SET_ID") || names.scaleSetId;
    patchScaleSetModel({ scaleSetId, body: scaleSetModelPatch({ vmSize: settings.vmSize, imageId, userData }) }, { runFn, tmpRoot });
    log("ok", `[win-workers] updated the model of scale set ${names.scaleSetName} (configuration ${configVersion.slice(0, 12)}); new VMs take it, and the controller replaces the others.`);
  }
  // The SFI deploy step deletes the rule under that profile.
  if (deploysPostgres(env) && !sfiCompliant(env)) {
    deleteAllowAllAzureServicesRule({
      subscriptionId: names.subscriptionId, resourceGroup: names.resourceGroup, serverName: names.postgresServerName,
    }, { runFn });
  }
  deleteAccountWideBlobGrant(names, { runFn });
}

// ─── Before the disk controller's manifests ───

// A kubeconfig for the stamp's cluster in `stagingDir`, and the environment
// that names it for kubectl.
export function kubeconfigEnv(names, stagingDir, runFn = run) {
  mkdirSync(stagingDir, { recursive: true });
  const kubeconfig = join(stagingDir, "kubeconfig");
  const result = runFn("az", ["aks", "get-credentials", "--resource-group", names.resourceGroup, "--name", names.aksClusterName,
    "--file", kubeconfig, "--overwrite-existing", "--output", "none"], { capture: true, allowFail: true });
  if (result.status !== 0) throw new Error(`Could not get the cluster's credentials: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  return { ...process.env, KUBECONFIG: kubeconfig };
}

export function edgeMode(env) {
  return String(env.EDGE_MODE || "afd").trim().toLowerCase();
}

// The prefix of the App Gateway trusted roots that the deploy uploads for the
// controller's CAs (APPGW_TRUSTED_ROOT_CERTS): one name, never a list, since
// the deploy names each new root itself.
export function trustedRootPrefix(env) {
  const prefix = settingValue(env, "APPGW_TRUSTED_ROOT_CERTS") || DEFAULT_TRUSTED_ROOT_PREFIX;
  if (prefix.includes(",")) {
    throw new Error(
      "APPGW_TRUSTED_ROOT_CERTS names the prefix of the App Gateway trusted roots that the deploy uploads for the disk controller's CAs, " +
        "not a list: the deploy names a new root <prefix>-<12 hex of its CA's SHA-256>, and lists the roots for the dispatcher Ingress itself.",
    );
  }
  if (!TRUSTED_ROOT_PREFIX.test(prefix)) {
    throw new Error(
      `APPGW_TRUSTED_ROOT_CERTS must be 1 to 67 letters, digits, '_', '.' or '-', starting with a letter or digit, not '${prefix}': ` +
        "App Gateway takes <prefix>-<12 hex> as a trusted root's name.",
    );
  }
  return prefix;
}

// The name a CA's new App Gateway root gets: the prefix and the first 12 hex
// of the SHA-256 of the CA's DER (its `fingerprint`, as tls.mjs reports it).
export function trustedRootName(prefix, ca) {
  return `${prefix}-${String(ca.fingerprint).slice(0, 12)}`;
}

// A trusted root's `data` as base64 DER, whatever form it comes in: the
// Azure CLI uploads a certificate file's bytes base64-encoded, so a PEM file
// comes back as base64 of the PEM text.
export function trustedRootDer(data) {
  const text = String(data ?? "").trim();
  if (!text) return "";
  const body = (pem) => pem.replace(/-----[^-]+-----|\s/g, "");
  if (text.includes("-----BEGIN CERTIFICATE-----")) return body(text);
  const decoded = Buffer.from(text.replace(/\s/g, ""), "base64");
  const asText = decoded.toString("latin1");
  return asText.includes("-----BEGIN CERTIFICATE-----") ? body(asText) : decoded.toString("base64");
}

const lastSegment = (id) => String(id ?? "").split("/").pop().toLowerCase();
// A property of an Azure CLI object, whether the CLI prints it flattened, as
// the current one does, or under `properties`, as older ones did.
function property(item, name) {
  return item?.[name] ?? item?.properties?.[name];
}

/**
 * App Gateway's trusted roots and the backend settings that name them, from
 * one read of the gateway: { roots: [{ name, der }], settings: [{ name,
 * hostName, roots: [lower-case names] }] }. Both the HTTP and the TLS backend
 * settings count.
 */
export function readGatewayTrust(names, { runFn = run } = {}) {
  const gateway = azJson(runFn, ["network", "application-gateway", "show", "--resource-group", names.resourceGroup,
    "--name", names.applicationGatewayName], `read App Gateway ${names.applicationGatewayName}`);
  if (!gateway) throw new Error(`App Gateway ${names.applicationGatewayName} was not found.`);
  const roots = (property(gateway, "trustedRootCertificates") ?? []).map((root) => ({
    name: String(root?.name ?? ""),
    der: trustedRootDer(property(root, "data")),
  }));
  const settings = [...(property(gateway, "backendHttpSettingsCollection") ?? []), ...(property(gateway, "backendSettingsCollection") ?? [])]
    .map((setting) => ({
      name: String(setting?.name ?? ""),
      hostName: String(property(setting, "hostName") ?? "").toLowerCase(),
      roots: (property(setting, "trustedRootCertificates") ?? []).map((root) => lastSegment(root?.id)),
    }));
  return { roots, settings };
}

// Writes a CA as the App Gateway trusted root `name` (`verb` create or
// update), from a private temporary file.
function writeTrustedRoot({ names, name, caPem, verb }, { runFn, tmpRoot }) {
  const dir = privateFolder(tmpRoot);
  try {
    const path = join(dir, "ca.cer");
    writeFileSync(path, `${String(caPem).trim()}\n`, { mode: 0o600 });
    const result = runFn("az", ["network", "application-gateway", "root-cert", verb, "--resource-group", names.resourceGroup,
      "--gateway-name", names.applicationGatewayName, "--name", name, "--cert-file", path, "--output", "none"], { capture: true, allowFail: true });
    if (result.status !== 0) {
      throw new Error(`Could not ${verb} App Gateway trusted root ${name}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log("ok", `[win-workers] App Gateway trusted root ${name} holds the disk controller's CA.`);
}

/**
 * Makes sure each trusted CA (tls.mjs's, current first) is on an App Gateway
 * trusted root, and returns the roots' names in that order, for the
 * dispatcher Ingress. The gateway's roots are read once and compared by
 * certificate: App Gateway refuses a second root with a certificate that
 * another root holds, so a CA on a root keeps that root, whatever its name. An
 * existing stamp's CA thus stays on the root named after the prefix itself,
 * and the Ingress names it as before. Only a CA on no root is uploaded, as
 * `<prefix>-<12 hex>`; if another certificate holds that name, it is put
 * right. An App Gateway update that names a missing root fails, so this runs
 * before the controller's manifests reach AGIC.
 */
export function ensureTrustedRoots({ names, prefix, trustedCas }, { runFn = run, tmpRoot = tmpdir() } = {}) {
  const { roots } = readGatewayTrust(names, { runFn });
  return trustedCas.map((ca) => {
    const name = trustedRootName(prefix, ca);
    const holding = roots.filter((root) => root.der === ca.der);
    if (holding.length > 0) return (holding.find((root) => root.name.toLowerCase() === name.toLowerCase()) ?? holding[0]).name;
    const taken = roots.find((root) => root.name.toLowerCase() === name.toLowerCase());
    writeTrustedRoot({ names, name: taken?.name ?? name, caPem: ca.pem, verb: taken ? "update" : "create" }, { runFn, tmpRoot });
    if (taken) taken.der = ca.der;
    else roots.push({ name, der: ca.der });
    return taken?.name ?? name;
  });
}

// The controller's settings as its overlay renders them, checked with the
// controller's own parser, so a bad value stops the deploy instead of the pod.
// With App Gateway, the trusted roots' prefix is checked too.
export function checkControllerSettings(env) {
  const hostname = settingValue(env, "PORTAL_HOSTNAME");
  if (!hostname || hostname === "unused") {
    throw new Error("The disk controller's dispatcher Ingress joins the portal's host: deploy the portal first, so PORTAL_HOSTNAME is known.");
  }
  if (edgeMode(env) === "afd") trustedRootPrefix(env);
  return loadConfig(diskControllerOverlayEnv(env));
}

export function beforeManifests({ env, stagingDir }, { runFn = run, tmpRoot = tmpdir() } = {}) {
  const names = winWorkerResourceNames(env);
  checkControllerSettings(env);
  const { namespace, caBundle, trustedCas } = ensureControllerTls(env, names, { runFn, tmpRoot });
  const afd = edgeMode(env) === "afd";
  if (afd) {
    // Every trusted CA on a root before the Ingress that names the roots
    // reaches AGIC; the overlay's APPGW_TRUSTED_ROOT_CERTS lists them
    // (stage-manifests.mjs, diskControllerOverlayEnv).
    const rootNames = ensureTrustedRoots({ names, prefix: trustedRootPrefix(env), trustedCas }, { runFn, tmpRoot });
    env.APPGW_TRUSTED_ROOT_CERT_NAMES = rootNames.join(",");
  }
  applyCaToCluster({ namespace, caPem: caBundle }, { runFn, tmpRoot, kubeEnv: kubeconfigEnv(names, stagingDir, runFn) });
  log("ok", `[win-workers] the disk controller's ${trustedCas.length === 1 ? "CA is" : "two trusted CAs are"} in the cluster${afd ? " and on App Gateway" : ""}.`);
}

// What the controller's TLS step (tls.mjs) takes for this stamp.
export function controllerTlsInputs(env, names = winWorkerResourceNames(env)) {
  const stampVaultName = settingValue(env, "KV_NAME") || names.stampKeyVaultName;
  const controllerPrincipalId = settingValue(env, "DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID");
  if (!GUID.test(controllerPrincipalId)) {
    throw new Error("The disk controller's TLS step needs DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID from base-infra: deploy base-infra with WIN_WORKERS_ENABLED=true first.");
  }
  return {
    namespace: settingValue(env, "NAMESPACE") || "pilotswarm",
    stampVaultName,
    stampVaultResourceId: `${names.resourceGroupId}/providers/Microsoft.KeyVault/vaults/${stampVaultName}`,
    deployVaultName: settingValue(env, "DEPLOY_KEY_VAULT_NAME") || names.deployKeyVaultName,
    controllerPrincipalId,
  };
}

// The controller's TLS step (tls.mjs): the CA and a current leaf exist, and
// the trusted CAs and their bundle are returned with the namespace that the
// leaf names.
function ensureControllerTls(env, names, { runFn, tmpRoot }) {
  const inputs = controllerTlsInputs(env, names);
  const { caBundle, trustedCas } = ensureDiskControllerTls(inputs, { runFn, tmpRoot });
  return { namespace: inputs.namespace, caBundle, trustedCas };
}

// ─── Before the worker's manifests (the coordination host) ───

// The portal identity's federated credentials for the worker's service
// account: `worker-fedcred`, and any other with that subject.
function workerCredentials(runFn, names, subject) {
  const credentials = azJson(runFn, ["identity", "federated-credential", "list", "--resource-group", names.resourceGroup,
    "--identity-name", names.portalIdentityName], `list the federated credentials of the portal identity ${names.portalIdentityName}`) ?? [];
  return (Array.isArray(credentials) ? credentials : [])
    .filter((c) => c?.name === WORKER_FEDERATED_CREDENTIAL || String(c?.subject ?? "") === subject);
}

// With the coordination host, the worker's service account is federated with
// the host's own identity. A credential of the portal identity for it would
// still let a pod of that account sign in as the portal's identity, the
// PostgreSQL administrator, and an incremental deployment never deletes the
// `worker-fedcred` an earlier one created. So this deletes every such
// credential, lists them again and fails while one remains. Returns the
// number it deleted.
export function deleteWorkerFederatedCredential(env, { runFn = run } = {}) {
  const names = winWorkerResourceNames(env);
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  const subject = `system:serviceaccount:${namespace}:${WORKER_SERVICE_ACCOUNT}`;
  const stale = workerCredentials(runFn, names, subject);
  for (const credential of stale) {
    const removed = runFn("az", ["identity", "federated-credential", "delete", "--resource-group", names.resourceGroup,
      "--identity-name", names.portalIdentityName, "--name", credential.name, "--yes", "--output", "none"], { capture: true, allowFail: true });
    if (removed.status !== 0 && !NOT_FOUND.test(String(removed.stderr ?? ""))) {
      throw new Error(
        `Could not delete the federated credential ${credential.name} of the portal identity ${names.portalIdentityName}: ` +
          `${firstLine(removed.stderr) || `exit ${removed.status}`}`,
      );
    }
  }
  const left = workerCredentials(runFn, names, subject);
  if (left.length > 0) {
    throw new Error(
      `The portal identity ${names.portalIdentityName} still has a federated credential for the worker's service account ` +
        `(${left.map((c) => c.name).join(", ")}); the coordination host's manifests are published only once it is gone.`,
    );
  }
  if (stale.length > 0) {
    log("ok", `[win-workers] deleted the portal identity's federated credential for the worker's service account (${stale.map((c) => c.name).join(", ")}).`);
  }
  return stale.length;
}

// Before the worker's manifests with the Windows worker pool: no credential of
// the portal identity for the worker's service account, since the worker then
// runs as the coordination host, with its own identity, or runs no pod; and,
// with the host, the controller's CA in the cluster for the host's
// NODE_EXTRA_CA_CERTS, whose pods start only once it is there. Without the
// pool it does nothing: the worker then signs in with that credential. Returns
// whether it ran.
export function beforeWorkerManifests({ env, stagingDir }, { runFn = run, tmpRoot = tmpdir() } = {}) {
  if (!winWorkersEnabled(env)) return false;
  deleteWorkerFederatedCredential(env, { runFn });
  if (!coordinationHostEnabled(env)) return true;
  const names = winWorkerResourceNames(env);
  const { namespace, caBundle, trustedCas } = ensureControllerTls(env, names, { runFn, tmpRoot });
  applyCaToCluster({ namespace, caPem: caBundle }, { runFn, tmpRoot, kubeEnv: kubeconfigEnv(names, stagingDir, runFn) });
  // The host reads NODE_EXTRA_CA_CERTS only when it starts. While the
  // controller trusts two CAs, the bundle's hash goes to the host's staging
  // (coordination-host.mjs), which puts it on the pod template, so a new
  // bundle restarts the host. With one CA the pod template stays as it was.
  if (trustedCas.length > 1) env[COORDINATION_HOST_CA_HASH_KEY] = caBundleHash(caBundle);
  else delete env[COORDINATION_HOST_CA_HASH_KEY];
  log("ok", `[win-workers] the disk controller's ${trustedCas.length === 1 ? "CA is" : "two trusted CAs are"} in the cluster for the coordination host.`);
  return true;
}
