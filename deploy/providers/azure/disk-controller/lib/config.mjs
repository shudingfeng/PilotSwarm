// The disk controller's settings, read once at start from the environment
// its manifest renders. Unset, empty and the deploy tool's `__PS_UNSET__`
// sentinel all mean "unset". A value that is set but wrong stops the start:
// a typo must never quietly fall back to a default.
import { parseWorkingHours } from "./working-hours.mjs";

export const UNSET_SENTINEL = "__PS_UNSET__";

export const WORKER_PORT = 3003;
export const DISPATCHER_PORT = 3004;
export const COORDINATION_PORT = 3005;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCALE_SET_ID = /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachineScaleSets\/([^/]+)$/i;
const SNAPSHOT_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/snapshots\/[^/]+$/i;
const DCR_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Insights\/dataCollectionRules\/[^/]+$/i;
const VERSION = /^[0-9A-Za-z._-]{1,128}$/;
const WINDOWS_FOLDER = /^[A-Za-z]:\\[^"'`$;&|<>\r\n]*$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(`The disk controller's settings are not valid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function value(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null) return "";
  const text = String(raw).trim();
  return text === UNSET_SENTINEL ? "" : text;
}

/**
 * Parses the controller's settings. `env` defaults to process.env. Returns a
 * frozen object; throws a ConfigError that names every bad setting.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const required = (name, check, hint) => {
    const text = value(env, name);
    if (!text) {
      problems.push(`${name} is required: ${hint}.`);
      return "";
    }
    if (check && !check(text)) {
      problems.push(`${name} must be ${hint}.`);
      return "";
    }
    return text;
  };
  const optional = (name, check, hint) => {
    const text = value(env, name);
    if (text && check && !check(text)) {
      problems.push(`${name} must be ${hint}.`);
      return "";
    }
    return text;
  };
  const integer = (name, fallback, min, max) => {
    const text = value(env, name);
    if (!text) return fallback;
    const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!(number >= min && number <= max)) {
      problems.push(`${name} must be a whole number from ${min} to ${max}.`);
      return fallback;
    }
    return number;
  };
  const flag = (name, fallback) => {
    const text = value(env, name).toLowerCase();
    if (!text) return fallback;
    if (text === "true") return true;
    if (text === "false") return false;
    problems.push(`${name} must be true or false.`);
    return fallback;
  };

  const stateUrl = required("PS_DISK_POOL_STATE_URL", isContainerUrl, "the https URL of the blob container that keeps the controller's state, without a query");
  const scope = required("PS_DISK_CONTROLLER_TOKEN_SCOPE", (text) => tokenAudience(text) !== null, "the worker token scope, <app client ID>/.default or api://<app client ID>/.default");
  const tenantId = required("AZURE_TENANT_ID", (text) => GUID.test(text), "the Entra tenant ID that issues the tokens the controller accepts");
  const authority = optional("AZURE_AUTHORITY_HOST", isHttpsOrigin, "an https authority host such as https://login.microsoftonline.com/") || "https://login.microsoftonline.com/";
  const workerOid = required("EXPECTED_WIN_WORKER_OID", (text) => GUID.test(text), "the object ID of the workers' shared identity");
  const dispatcherOid = optional("DISPATCHER_SP_OBJECT_ID", (text) => GUID.test(text), "an object ID");
  const vaultUri = optional("PILOTSWARM_PERSONAL_SECRET_VAULT_URI", isHttpsOrigin, "the personal vault's https URI and nothing more");
  const scaleSetId = optional("WIN_WORKER_SCALE_SET_ID", (text) => SCALE_SET_ID.test(text), "a virtual machine scale set's resource ID");
  const dcrId = optional("WIN_WORKER_DCR_ID", (text) => DCR_ID.test(text), "a data collection rule's resource ID");
  const goldenSnapshotId = optional("WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID", (text) => SNAPSHOT_ID.test(text), "a snapshot's resource ID");
  const imageVersion = optional("WIN_WORKER_IMAGE_VERSION", (text) => VERSION.test(text), "an image version such as 1.0.20261104");
  const configVersion = optional("WIN_WORKER_CONFIG_VERSION", (text) => VERSION.test(text), "letters, digits, dots, hyphens or underscores");

  const maxVms = integer("WIN_WORKER_COUNT", 5, 1, 100);
  const minRunning = integer("WIN_WORKER_MIN_RUNNING", 1, 0, 100);
  if (minRunning > maxVms) problems.push("WIN_WORKER_MIN_RUNNING must not be above WIN_WORKER_COUNT.");
  const idleRecycleMinutes = integer("WIN_WORKER_IDLE_RECYCLE_MINUTES", 30, 1, 1440);
  const scaleInBatch = integer("WIN_WORKER_SCALE_IN_BATCH", 1, 1, 100);
  const scaleInIntervalMinutes = integer("WIN_WORKER_SCALE_IN_INTERVAL_MINUTES", 5, 0, 1440);
  const ownerOnly = flag("WIN_WORKER_COORDINATION_HOST", false);
  let workingHours = null;
  const hoursText = value(env, "WIN_WORKER_WORKING_HOURS");
  if (hoursText) {
    try {
      workingHours = parseWorkingHours(hoursText);
    } catch (err) {
      problems.push(`WIN_WORKER_WORKING_HOURS ${err.message}`);
    }
  }

  const poolCount = integer("WIN_DEV_DRIVE_POOL_COUNT", 10, 1, 1000);
  const spareCount = integer("WIN_DEV_DRIVE_SPARE_COUNT", 2, 0, 1000);
  if (spareCount > poolCount) problems.push("WIN_DEV_DRIVE_SPARE_COUNT must not be above WIN_DEV_DRIVE_POOL_COUNT.");
  const maxPerOwner = integer("WIN_DEV_DRIVE_MAX_PER_USER", 3, 1, 1000);
  const leaseExpiryDays = integer("WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS", 7, 1, 365);
  const sizeGb = integer("WIN_DEV_DRIVE_SIZE_GB", 1024, 4, 65536);
  const growFreePercent = integer("WIN_DEV_DRIVE_GROW_FREE_PERCENT", 20, 1, 99);
  const growStepGb = integer("WIN_DEV_DRIVE_GROW_STEP_GB", 256, 1, 65536);
  const maxGb = integer("WIN_DEV_DRIVE_MAX_GB", 2048, 4, 65536);
  if (maxGb < sizeGb) problems.push("WIN_DEV_DRIVE_MAX_GB must not be below WIN_DEV_DRIVE_SIZE_GB.");
  const iops = integer("WIN_DEV_DRIVE_IOPS", 6000, 3000, 80000);
  const mbps = integer("WIN_DEV_DRIVE_MBPS", 250, 125, 1200);

  const tlsFile = value(env, "PS_DISK_CONTROLLER_TLS_FILE") || "/mnt/disk-controller-tls/disk-controller-tls";
  const startupGraceSeconds = integer("PS_DISK_CONTROLLER_STARTUP_GRACE_SECONDS", 60, 0, 3600);
  const snapshotRefreshDays = integer("PS_DISK_CONTROLLER_SNAPSHOT_REFRESH_DAYS", 7, 0, 365);
  const vmScriptsDir = optional("PS_DISK_CONTROLLER_VM_SCRIPTS_DIR", (text) => WINDOWS_FOLDER.test(text), "a Windows folder such as C:\\pilotswarm\\scripts") || "C:\\pilotswarm\\scripts";

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    stateUrl,
    tokens: Object.freeze({
      tenantId: tenantId.toLowerCase(),
      audience: tokenAudience(scope),
      authorityHost: authority.endsWith("/") ? authority : `${authority}/`,
      workerOid: workerOid.toLowerCase(),
      dispatcherOid: dispatcherOid ? dispatcherOid.toLowerCase() : null,
    }),
    personalVaultUri: vaultUri ? new URL(vaultUri).origin : null,
    scaleSet: scaleSetId ? parseScaleSetId(scaleSetId) : null,
    dcrId: dcrId || null,
    goldenSnapshotId: goldenSnapshotId || null,
    imageVersion: imageVersion || null,
    configVersion: configVersion || null,
    vms: Object.freeze({
      max: maxVms,
      minRunning,
      idleRecycleMs: idleRecycleMinutes * 60_000,
      scaleInBatch,
      scaleInIntervalMs: scaleInIntervalMinutes * 60_000,
      ownerOnly,
      workingHours,
    }),
    drives: Object.freeze({
      poolCount,
      spareCount,
      maxPerOwner,
      leaseExpiryMs: leaseExpiryDays * 86_400_000,
      sizeGb,
      growFreePercent,
      growStepGb,
      maxGb,
      iops,
      mbps,
    }),
    tlsFile,
    startupGraceMs: startupGraceSeconds * 1000,
    snapshotRefreshMs: snapshotRefreshDays * 86_400_000,
    vmScriptsDir,
  });
}

function isContainerUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && segments.length === 1;
}

function isHttpsOrigin(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}

/** The audience of a v2 token for a `<client ID>/.default` scope: the client ID. */
export function tokenAudience(scope) {
  const match = /^(?:api:\/\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/\.default$/i.exec(String(scope ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

export function parseScaleSetId(id) {
  const match = SCALE_SET_ID.exec(id);
  if (!match) throw new Error("not a virtual machine scale set's resource ID");
  return Object.freeze({ id, subscriptionId: match[1].toLowerCase(), resourceGroup: match[2], name: match[3] });
}
