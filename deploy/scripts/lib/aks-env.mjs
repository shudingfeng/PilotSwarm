// AKS stamp settings from the env map, for base-infra's parameters.
//
//   USER_POOL_MIN_COUNT   the user pool's autoscaler minimum, 1 to 10
//                         (default 1). The session-workspaces tests need two
//                         agent nodes (docs/proposals/session-workspaces.md,
//                         section 12.1).
//   SFI_COMPLIANT         true deploys the stamp for subscriptions whose
//                         Azure Policy requires a network security perimeter
//                         and denies Storage shared keys and deployment
//                         scripts (default false). See "Policy-restricted
//                         subscriptions" in docs/developer/deploy/aks.md.
//   PERIMETER_OPERATOR_IP_PREFIXES
//                         with SFI_COMPLIANT=true, comma-separated public
//                         IPv4 addresses or CIDR prefixes that the perimeter
//                         also admits (default none).
//   WIN_WORKERS_ENABLED   true deploys a Windows worker pool beside the
//                         cluster: a Flexible scale set with a standby pool,
//                         the disk controller, their vaults, storage, network
//                         and alerts (default false). The WIN_WORKER_* and
//                         WIN_DEV_DRIVE_* settings below size it; see the
//                         Windows worker pool section of
//                         deploy/providers/azure/envs/template.env.
//
// The `repocache` pool follows WORKSPACES_ENABLED (lib/workspaces.mjs).
//
// Every default here keeps a stamp as it deploys today. `__PS_UNSET__` means
// unset: the overlay substitution refuses an empty key, and the portal and the
// controller drop the sentinel at startup.
//
// No I/O; no import of common.mjs (it imports this).

import { isIPv4 } from "node:net";

export const UNSET_SENTINEL = "__PS_UNSET__";

// The service that exists only for the Windows worker pool: the disk
// controller (deploy/providers/azure/disk-controller/). deploy.mjs skips it
// unless WIN_WORKERS_ENABLED=true.
export const DISK_CONTROLLER_SERVICE = "disk-controller";

// The Windows worker pool's settings (deploy/providers/azure/envs/template.env).
export const WIN_WORKER_ENV_DEFAULTS = Object.freeze({
  WIN_WORKERS_ENABLED: "false",
  WIN_WORKER_COUNT: "5",
  WIN_WORKER_MIN_RUNNING: "1",
  WIN_WORKER_STANDBY_MIN: "1",
  WIN_WORKER_VM_SIZE: "Standard_D16ds_v5",
  WIN_WORKER_IMAGE_VERSION: UNSET_SENTINEL,
  WIN_WORKER_IDLE_RECYCLE_MINUTES: "30",
  WIN_WORKER_SCALE_IN_BATCH: "1",
  WIN_WORKER_SCALE_IN_INTERVAL_MINUTES: "5",
  WIN_WORKER_COORDINATION_HOST: "false",
  WIN_WORKER_COORDINATION_HOST_REPLICAS: "2",
  WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: UNSET_SENTINEL,
  WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: UNSET_SENTINEL,
  WIN_WORKER_WORKING_HOURS: UNSET_SENTINEL,
  WIN_WORKER_EXTRA_ENV: UNSET_SENTINEL,
  WIN_WORKER_FEED_ENDPOINTS: UNSET_SENTINEL,
  WIN_WORKER_ALERT_EMAILS: UNSET_SENTINEL,
  WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID: UNSET_SENTINEL,
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

// The disk controller's other settings, with the controller's own defaults
// (deploy/providers/azure/disk-controller/README.md, "Settings").
export const DISK_CONTROLLER_ENV_DEFAULTS = Object.freeze({
  DISPATCHER_SP_OBJECT_ID: UNSET_SENTINEL,
  WIN_DEV_DRIVE_MBPS: "250",
  WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID: UNSET_SENTINEL,
  PS_DISK_CONTROLLER_STARTUP_GRACE_SECONDS: "60",
  PS_DISK_CONTROLLER_SNAPSHOT_REFRESH_DAYS: "7",
  PS_DISK_CONTROLLER_VM_SCRIPTS_DIR: UNSET_SENTINEL,
  // With EDGE_MODE=afd, the prefix of the App Gateway trusted roots that the
  // deploy uploads for the controller's CAs, <prefix>-<12 hex of a CA's
  // SHA-256>; a CA already on a root keeps it (deploy-steps/win-workers.mjs).
  APPGW_TRUSTED_ROOT_CERTS: "pilotswarm-disk-controller-ca",
});

// Portal settings that are not auth or authorization policy
// (portal-config.mjs holds those). Each default is the portal's behavior
// without the setting, so stage-manifests.mjs leaves a key at its default out
// of the staged overlay, and the portal's manifests stay as they were.
export const PORTAL_SETTING_DEFAULTS = Object.freeze({
  PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: UNSET_SENTINEL,
  PILOTSWARM_PERSONAL_SECRETS: "database",
  PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: UNSET_SENTINEL,
  PILOTSWARM_PERSONAL_SECRET_VAULT_URI: UNSET_SENTINEL,
  PILOTSWARM_OWNER_ROUTING: "0",
  PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE: UNSET_SENTINEL,
  PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC: UNSET_SENTINEL,
  PILOTSWARM_SESSION_MESSAGE_SCOPE: UNSET_SENTINEL,
});

// Values base-infra reports for the pool (deploy-bicep.mjs's alias map). They
// are defaults for the staged overlays only, not for loadEnv: the Bicep
// outputs cache fills a key only while the env map has no value for it.
export const WIN_WORKER_OUTPUT_DEFAULTS = Object.freeze({
  PS_DISK_POOL_STATE_URL: UNSET_SENTINEL,
  EXPECTED_WIN_WORKER_OID: UNSET_SENTINEL,
  WIN_WORKER_SCALE_SET_ID: UNSET_SENTINEL,
  WIN_WORKER_STANDBY_POOL_ID: UNSET_SENTINEL,
  WIN_WORKER_DCR_ID: UNSET_SENTINEL,
  WIN_WORKER_GALLERY_IMAGE_ID: UNSET_SENTINEL,
  WIN_WORKER_CONFIG_VERSION: UNSET_SENTINEL,
  DISK_CONTROLLER_IDENTITY_CLIENT_ID: UNSET_SENTINEL,
  COORDINATION_IDENTITY_CLIENT_ID: UNSET_SENTINEL,
  COORDINATION_IDENTITY_PRINCIPAL_ID: UNSET_SENTINEL,
  COORDINATION_IDENTITY_NAME: UNSET_SENTINEL,
});

export const AKS_ENV_DEFAULTS = Object.freeze({
  USER_POOL_MIN_COUNT: "1",
  SFI_COMPLIANT: "false",
  ...WIN_WORKER_ENV_DEFAULTS,
  ...DISK_CONTROLLER_ENV_DEFAULTS,
  ...PORTAL_SETTING_DEFAULTS,
});

export function userPoolMinCount(env) {
  const raw = env?.USER_POOL_MIN_COUNT;
  const value = String(raw ?? "").trim();
  if (value === "") return 1;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
    throw new Error(`USER_POOL_MIN_COUNT must be a whole number from 1 to 10, not '${raw}'.`);
  }
  return Number(value);
}

export function sfiCompliant(env) {
  const raw = env?.SFI_COMPLIANT;
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`SFI_COMPLIANT must be true or false, not '${raw}'.`);
}

// The perimeter's access rules take CIDR prefixes, so an address becomes a
// /32. Empty entries (a trailing comma) are dropped, and so are repeats.
export function perimeterOperatorIpPrefixes(env) {
  const prefixes = [];
  for (const entry of String(env?.PERIMETER_OPERATOR_IP_PREFIXES ?? "").split(",")) {
    const value = entry.trim();
    if (value === "") continue;
    const [address, length = "32", ...rest] = value.split("/");
    if (!isIPv4(address) || rest.length > 0 || !/^\d{1,2}$/.test(length) || Number(length) > 32) {
      throw new Error(
        `PERIMETER_OPERATOR_IP_PREFIXES entry '${value}' is not an IPv4 address or CIDR prefix ` +
          "(for example 203.0.113.7 or 203.0.113.0/24).",
      );
    }
    const bits = Number(length);
    const octets = address.split(".").map(Number);
    const number = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = (number & mask) >>> 0;
    if (network !== number) {
      const networkAddress = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
      throw new Error(
        `PERIMETER_OPERATOR_IP_PREFIXES entry '${value}' has host bits set; use ${networkAddress}/${bits}.`,
      );
    }
    const prefix = `${address}/${bits}`;
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

// ─── Windows worker pool ───

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const CONFIGMAP_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
// The SDK's rule for PILOTSWARM_REDACT_SECRET_PREFIXES (secret-redaction.ts).
const REDACT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;

// A setting's trimmed value, with the unset sentinel read as empty.
export function settingValue(env, key) {
  const value = String(env?.[key] ?? "").trim();
  return value === UNSET_SENTINEL ? "" : value;
}

function trueOrFalse(env, key) {
  const value = settingValue(env, key).toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`${key} must be true or false, not '${env?.[key]}'.`);
}

export function winWorkersEnabled(env) {
  return trueOrFalse(env, "WIN_WORKERS_ENABLED");
}

export function winWorkerCoordinationHost(env) {
  return trueOrFalse(env, "WIN_WORKER_COORDINATION_HOST");
}

// The portal records owner tags only for exactly "1" (packages/sdk/src/client.ts),
// so any other value would quietly mean "off".
export function ownerRoutingEnabled(env) {
  const value = settingValue(env, "PILOTSWARM_OWNER_ROUTING");
  if (value === "1") return true;
  if (value === "0" || value === "") return false;
  throw new Error(`PILOTSWARM_OWNER_ROUTING must be 1 or 0, not '${env?.PILOTSWARM_OWNER_ROUTING}'.`);
}

function wholeNumber(env, key, min, max) {
  const value = settingValue(env, key) || WIN_WORKER_ENV_DEFAULTS[key];
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}, not '${env?.[key]}'.`);
  }
  return Number(value);
}

// Comma-separated addresses; empty entries and repeats are dropped.
export function winWorkerAlertEmails(env) {
  const emails = [];
  for (const entry of settingValue(env, "WIN_WORKER_ALERT_EMAILS").split(",")) {
    const email = entry.trim();
    if (!email) continue;
    if (!EMAIL.test(email)) throw new Error(`WIN_WORKER_ALERT_EMAILS entry '${email}' is not an email address.`);
    if (!emails.some((known) => known.toLowerCase() === email.toLowerCase())) emails.push(email);
  }
  return emails;
}

// The ConfigMap, in the worker's namespace, that holds the coordination
// host's plugin definitions (lib/coordination-host.mjs), or null.
export function coordinationHostPluginConfigMap(env) {
  const name = settingValue(env, "WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP");
  if (!name) return null;
  if (!CONFIGMAP_NAME.test(name)) {
    throw new Error(`WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP must be a ConfigMap name, not '${name}'.`);
  }
  return name;
}

// Comma-separated token prefixes that the coordination host redacts, checked
// as the worker checks them; empty entries and repeats are dropped.
export function coordinationHostRedactSecretPrefixes(env) {
  const prefixes = [];
  for (const entry of settingValue(env, "WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES").split(",")) {
    const prefix = entry.trim();
    if (!prefix) continue;
    if (!REDACT_PREFIX.test(prefix)) {
      throw new Error(
        `WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES entry '${prefix}' is not a token prefix: ` +
          "use at least three letters, digits, _ or -, starting with a letter or digit.",
      );
    }
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

// The pool settings the deploy itself uses (base-infra's Bicep and the
// workers' userData). The controller checks the others when it starts, and
// the deploy step runs the same check before it publishes the controller.
export function winWorkerSettings(env) {
  const count = wholeNumber(env, "WIN_WORKER_COUNT", 1, 100);
  const minRunning = wholeNumber(env, "WIN_WORKER_MIN_RUNNING", 0, 100);
  if (minRunning > count) throw new Error("WIN_WORKER_MIN_RUNNING must not be above WIN_WORKER_COUNT.");
  const standbyMin = wholeNumber(env, "WIN_WORKER_STANDBY_MIN", 0, 100);
  if (standbyMin > count) throw new Error("WIN_WORKER_STANDBY_MIN must not be above WIN_WORKER_COUNT.");
  const vmSize = settingValue(env, "WIN_WORKER_VM_SIZE") || WIN_WORKER_ENV_DEFAULTS.WIN_WORKER_VM_SIZE;
  if (!/^Standard_[A-Za-z0-9_]+$/.test(vmSize)) {
    throw new Error(`WIN_WORKER_VM_SIZE must be a VM size such as Standard_D16ds_v5, not '${env?.WIN_WORKER_VM_SIZE}'.`);
  }
  const imageVersion = settingValue(env, "WIN_WORKER_IMAGE_VERSION") || null;
  if (imageVersion && !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(imageVersion)) {
    throw new Error(
      `WIN_WORKER_IMAGE_VERSION must be a gallery image version, Major.Minor.Patch such as 1.0.20261104, not '${imageVersion}'.`,
    );
  }
  return {
    count,
    minRunning,
    standbyMin,
    vmSize,
    imageVersion,
    coordinationHost: winWorkerCoordinationHost(env),
    coordinationHostReplicas: wholeNumber(env, "WIN_WORKER_COORDINATION_HOST_REPLICAS", 0, 20),
    coordinationHostPluginConfigMap: coordinationHostPluginConfigMap(env),
    coordinationHostRedactSecretPrefixes: coordinationHostRedactSecretPrefixes(env),
    alertEmails: winWorkerAlertEmails(env),
  };
}

// The scope of the tokens the workers present to the controller: a v2 token
// for the portal's Entra app, which carries the `worker` role
// (deploy/scripts/auth/Setup-PortalAuth.ps1 -WorkerRoles).
export function diskControllerTokenScope(env) {
  const clientId = settingValue(env, "PORTAL_AUTH_ENTRA_CLIENT_ID");
  if (!GUID.test(clientId)) {
    throw new Error(
      "The Windows worker pool needs PORTAL_AUTH_ENTRA_CLIENT_ID, the client ID of the portal's Entra app: " +
        "the workers and the controller use that app's tokens.",
    );
  }
  return `${clientId.toLowerCase()}/.default`;
}

// The personal vault the portal's Key Vault secret store and the controller
// use: the env file's PILOTSWARM_PERSONAL_SECRET_VAULT_URI when it sets one,
// else the stamp's own personal vault (base-infra's PERSONAL_KEY_VAULT_URI,
// with WIN_WORKERS_ENABLED=true), else unset.
export function personalSecretVaultUri(env) {
  return settingValue(env, "PILOTSWARM_PERSONAL_SECRET_VAULT_URI") || settingValue(env, "PERSONAL_KEY_VAULT_URI") || UNSET_SENTINEL;
}
