// Bicep params template rendering (Phase 3, FR-020).
//
// Reads a Bicep parameters template (deploy/providers/azure/services/<Module>/bicep/<Module>.params.template.json),
// substitutes ${VAR} placeholders left-to-right with values from the env map,
// and writes the rendered file to <staging>/<module>.params.json. With
// AZURE_POLICY_RESTRICTED=true it also adds that profile's parameters to base-infra and
// portal (policyRestrictedParameters below), and with WIN_WORKERS_ENABLED=true the Windows
// worker pool's parameters to base-infra (winWorkerParameters); the templates
// themselves never name them.
//
// Fail-closed: any unresolved ${VAR} aborts with a single summary listing all
// missing keys. We never silently pass through to az — Bicep treats missing
// inputs as a typed error far downstream and the message is opaque.

import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploysPostgres } from "./database-env.mjs";
import { workspacesEnabled } from "./workspaces.mjs";
import {
  userPoolMinCount,
  policyRestricted,
  perimeterOperatorIpPrefixes,
  winWorkersEnabled,
  winWorkerSettings,
  settingValue,
  diskControllerTokenScope,
} from "./aks-env.mjs";

const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

// Keys rendered unquoted as a JSON boolean or number: each is normalized and
// checked here, so a value like " TRUE " or "2x" fails with its own message
// instead of as broken JSON.
const NORMALIZED_KEYS = {
  DEPLOY_POSTGRES: deploysPostgres,
  WORKSPACES_ENABLED: workspacesEnabled,
  USER_POOL_MIN_COUNT: userPoolMinCount,
};

// Render <module>.params.template.json against an env map.
// Returns { renderedPath, substituted: string[] }.
export function renderParams({ module, templatePath, envMap, outDir }) {
  const raw = readFileSync(templatePath, "utf8");
  const missing = new Set();
  const substituted = [];

  const out = raw.replace(PLACEHOLDER_RE, (_match, key) => {
    const v = Object.hasOwn(NORMALIZED_KEYS, key) ? NORMALIZED_KEYS[key](envMap) : envMap[key];
    // Treat only undefined/null as missing. An explicit empty string is a
    // legitimate value (e.g. SSL_CERT_DOMAIN_SUFFIX is empty on the OSS
    // afd+letsencrypt path because bicep derives the cert subject from the
    // AppGw DNS label instead). Bicep accepts "" for `string` params.
    if (v === undefined || v === null) {
      missing.add(key);
      return _match;
    }
    substituted.push(key);
    // JSON-escape special chars so we never break the surrounding string.
    return jsonEscape(String(v));
  });

  if (missing.size > 0) {
    const list = [...missing].sort().join(", ");
    throw new Error(
      `Bicep params template ${templatePath} has unresolved placeholders: ${list}. ` +
        `Set them in deploy/envs/local/<env>/.env and re-run.`,
    );
  }

  // Sanity: the rendered file must parse as JSON.
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(
      `Rendered params for ${module} is not valid JSON: ${e.message}\n` +
        `Check the template at ${templatePath}.`,
    );
  }

  let rendered = out;
  const added = { ...policyRestrictedParameters(module, envMap), ...winWorkerParameters(module, envMap) };
  if (Object.keys(added).length > 0) {
    for (const [name, value] of Object.entries(added)) parsed.parameters[name] = { value };
    rendered = `${JSON.stringify(parsed, null, 2)}\n`;
  }

  const renderedPath = join(outDir, `${module}.params.json`);
  writeFileSync(renderedPath, rendered);
  return { renderedPath, substituted };
}

// Parameters that only AZURE_POLICY_RESTRICTED=true adds. With the setting off nothing
// is added: the file stays the template's substitution and Bicep keeps its
// defaults, so redeploying an existing stamp changes nothing.
function policyRestrictedParameters(module, env) {
  if (!policyRestricted(env)) return null;
  if (module === "portal") return { policyRestricted: true };
  if (module !== "base-infra") return null;
  const params = { policyRestricted: true, perimeterOperatorIpPrefixes: perimeterOperatorIpPrefixes(env) };
  // Under the setting Bicep skips its App Gateway probe, a deployment
  // script, and takes the result of the deploy step's probe instead. A
  // missing result must not pass as false: Bicep would then reset the
  // configuration that AGIC wrote to an existing App Gateway.
  if (String(env.EDGE_MODE ?? "afd").trim().toLowerCase() === "afd") {
    const exists = String(env.APP_GATEWAY_EXISTS ?? "").trim().toLowerCase();
    if (exists !== "true" && exists !== "false") {
      throw new Error(
        "AZURE_POLICY_RESTRICTED=true needs APP_GATEWAY_EXISTS (true or false) from the App Gateway probe in " +
          "deploy/providers/azure/deploy-steps/policy-restricted.mjs. Deploy base-infra through deploy.mjs.",
      );
    }
    params.appGwExists = exists === "true";
  }
  return params;
}

// ─── Windows worker pool ───

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// The controller's worker port: the internal load balancer address in
// aks-subnet that deploy/providers/azure/gitops/disk-controller/base/service-worker.yaml
// pins, which the worker subnet's NSG admits (base-infra/bicep/vnet.bicep).
export const DISK_CONTROLLER_WORKER_URL = "https://10.20.15.250:3003";

// The workers' userData, which their launcher reads from IMDS at every
// service start (deploy/providers/azure/windows/README.md, "userData"): base64
// of a UTF-8 JSON document with exactly the fields `version`, `env`,
// `extraEnv` (optional) and `controllerCaCert`. A missing, unknown or invalid
// field stops the worker on every VM, so the renderer refuses each one first.
export const WIN_WORKER_USER_DATA_VERSION = 1;

// Azure takes a VM's userData only below 64 KiB of base64.
export const WIN_WORKER_USER_DATA_MAX_BYTES = 64 * 1024;

// `env`: exactly these names, in this order, each a non-empty string.
export const WIN_WORKER_USER_DATA_ENV_KEYS = Object.freeze([
  "DATABASE_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL",
  "PILOTSWARM_DB_AAD_USER",
  "AZURE_STORAGE_ACCOUNT_URL",
  "PS_DISK_POOL_CONTROLLER_URL",
  "PS_DISK_CONTROLLER_TOKEN_SCOPE",
  "AZURE_CLIENT_ID",
  "EXPECTED_WIN_WORKER_OID",
  "ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS",
  "WIN_WORKER_CONFIG_VERSION",
  "PILOTSWARM_WORKER_OWNER_ONLY",
]);

// The names the launcher sets itself.
const LAUNCHER_ENV_NAMES = Object.freeze(["PILOTSWARM_WORKER_OWNER_TAG", "PS_LAUNCH_ID"]);

// WIN_WORKER_EXTRA_ENV may not set these, compared without case as Windows
// compares environment names: they decide how the worker or its tools start
// and as whom, change a platform or tool setting, or carry credentials. The
// launcher refuses them again on the VM, and also any name that the image's
// worker.env or the deployment's worker settings file sets, which the deploy
// can't see; SESSION_STATE_DIR and MSBUILDDISABLENODEREUSE are the image's
// own names outside these prefixes.
export const WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES = Object.freeze([
  "NODE_", "COPILOT_", "PILOTSWARM_", "PS_", "WIN_WORKER_", "AZURE_", "GIT_", "NUGET_", "GCM_", "ARTIFACTS_CREDENTIALPROVIDER_",
]);
export const WIN_WORKER_RESERVED_EXTRA_ENV_NAMES = Object.freeze([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA",
  "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH", "GITHUB_TOKEN", "GH_TOKEN", "DATABASE_URL",
  ...WIN_WORKER_USER_DATA_ENV_KEYS, ...LAUNCHER_ENV_NAMES, "SESSION_STATE_DIR", "MSBUILDDISABLENODEREUSE",
]);
const EXTRA_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXTRA_ENV_VALUE_MAX = 4096;

// Why WIN_WORKER_EXTRA_ENV may not set `name`, or null.
function extraEnvNameRefusal(name) {
  const upper = name.toUpperCase();
  if (WIN_WORKER_USER_DATA_ENV_KEYS.includes(upper)) return "the workers' userData already sets it";
  if (LAUNCHER_ENV_NAMES.includes(upper)) return "the workers' launcher sets it";
  if (WIN_WORKER_RESERVED_EXTRA_ENV_NAMES.includes(upper)) return "it is reserved";
  const prefix = WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES.find((p) => upper.startsWith(p));
  return prefix ? `names starting with ${prefix} are reserved` : null;
}

// Why an `extraEnv` value is refused, or null.
function extraEnvValueRefusal(value) {
  if (typeof value !== "string") return "is not a string";
  if (value.length > EXTRA_ENV_VALUE_MAX) return `is longer than ${EXTRA_ENV_VALUE_MAX} characters`;
  return value.includes("\0") ? "contains a NUL character" : null;
}

// WIN_WORKER_EXTRA_ENV: non-secret NAME=VALUE pairs for every Windows worker,
// separated by semicolons, so a value can't hold one. A value is everything
// after the pair's first `=`, trimmed. Returns [name, value] pairs; throws on
// a malformed, reserved or repeated name, or a value the launcher refuses.
// Messages name the entry, never its value.
export function winWorkerExtraEnv(env) {
  const pairs = [];
  const seen = new Set();
  const entries = settingValue(env, "WIN_WORKER_EXTRA_ENV").split(";").map((entry) => entry.trim()).filter(Boolean);
  for (const [index, text] of entries.entries()) {
    const eq = text.indexOf("=");
    if (eq <= 0) throw new Error(`WIN_WORKER_EXTRA_ENV entry ${index + 1} is not a NAME=VALUE pair.`);
    const name = text.slice(0, eq).trim();
    if (!EXTRA_ENV_NAME.test(name)) {
      throw new Error(`WIN_WORKER_EXTRA_ENV entry ${index + 1}: '${name}' is not an environment variable name.`);
    }
    const refusal = extraEnvNameRefusal(name);
    if (refusal) throw new Error(`WIN_WORKER_EXTRA_ENV may not set ${name}: ${refusal}.`);
    if (seen.has(name.toUpperCase())) throw new Error(`WIN_WORKER_EXTRA_ENV sets ${name} twice.`);
    seen.add(name.toUpperCase());
    const value = text.slice(eq + 1).trim();
    const valueRefusal = extraEnvValueRefusal(value);
    if (valueRefusal) throw new Error(`WIN_WORKER_EXTRA_ENV: the value of ${name} ${valueRefusal}.`);
    pairs.push([name, value]);
  }
  return pairs;
}

// WIN_WORKER_FEED_ENDPOINTS: comma-separated https package feed URLs that the
// workers' NuGet credential provider signs in to with their managed identity.
// Unset, the workers get an empty list.
export function winWorkerFeedEndpoints(env, clientId) {
  const endpointCredentials = [];
  for (const entry of settingValue(env, "WIN_WORKER_FEED_ENDPOINTS").split(",")) {
    const endpoint = entry.trim();
    if (!endpoint) continue;
    const url = parsedUrl(endpoint);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(`WIN_WORKER_FEED_ENDPOINTS entry '${endpoint}' is not a plain https URL.`);
    }
    if (!endpointCredentials.some((known) => known.endpoint === endpoint)) {
      endpointCredentials.push({ endpoint, azureClientId: clientId });
    }
  }
  return JSON.stringify({ endpointCredentials });
}

function parsedUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The launcher's rule for each `env` value: why it is refused, or null.
function userDataValueRefusal(name, value) {
  if (typeof value !== "string" || value.trim() === "") return "is empty";
  switch (name) {
    case "DATABASE_URL":
    case "PILOTSWARM_CMS_FACTS_DATABASE_URL": {
      const url = parsedUrl(value);
      if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) return "must be a postgres:// or postgresql:// URL";
      return url.password ? "carries a password; userData holds no secret" : null;
    }
    case "AZURE_STORAGE_ACCOUNT_URL":
    case "PS_DISK_POOL_CONTROLLER_URL": {
      const url = parsedUrl(value);
      const plain = url && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
      return plain ? null : "must be a plain https:// URL, without a user, query or fragment";
    }
    case "PS_DISK_CONTROLLER_TOKEN_SCOPE":
      return /^(?:api:\/\/)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/\.default$/i.test(value)
        ? null
        : "must be <client ID>/.default or api://<client ID>/.default";
    case "AZURE_CLIENT_ID":
    case "EXPECTED_WIN_WORKER_OID":
      return GUID.test(value) ? null : "must be a GUID";
    case "ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS": {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return "is not JSON";
      }
      if (!isPlainObject(parsed) || !Array.isArray(parsed.endpointCredentials)) return 'must be {"endpointCredentials":[...]}';
      for (const entry of parsed.endpointCredentials) {
        if (!isPlainObject(entry) || typeof entry.endpoint !== "string" || !entry.endpoint) return "needs an endpoint in every entry";
        if ("password" in entry) return "carries a password; the workers sign in to feeds with their managed identity";
      }
      return null;
    }
    case "WIN_WORKER_CONFIG_VERSION":
      return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? null : "must be 1 to 128 letters, digits and . _ : -";
    case "PILOTSWARM_WORKER_OWNER_ONLY":
      return value === "0" || value === "1" ? null : 'must be exactly "0" or "1"';
    default:
      return value.length > EXTRA_ENV_VALUE_MAX ? `is longer than ${EXTRA_ENV_VALUE_MAX} characters` : null;
  }
}

// The disk controller's trusted CAs, as the launcher checks them: a PEM
// bundle of one CA certificate, or two while a CA rotation trusts the old and
// the new one (current first), with nothing but whitespace around them. Each
// certificate is checked, not only the first. One certificate renders the
// document it always did.
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----/g;

function caBundleRefusal(text) {
  if (/\S/.test(text.replace(PEM_CERTIFICATE, ""))) return "holds something other than PEM certificates";
  const blocks = [...text.matchAll(PEM_CERTIFICATE)];
  if (blocks.length < 1 || blocks.length > 2) return `holds ${blocks.length} certificates; it takes one, or two during a CA rotation`;
  for (const [index, [, body]] of blocks.entries()) {
    const der = Buffer.from(body.replace(/\s/g, ""), "base64");
    let certificate = null;
    try {
      certificate = new X509Certificate(der);
    } catch {
      certificate = null;
    }
    // A certificate parses from the front of its bytes; anything after it is junk.
    if (!certificate?.raw.equals(der)) return `certificate ${index + 1} is not a certificate`;
    if (!certificate.ca) return `certificate ${index + 1} is not a CA certificate`;
  }
  return null;
}

function caCertificatePem(caPem) {
  const pem = `${String(caPem ?? "").trim()}\n`;
  const refusal = caBundleRefusal(pem);
  if (refusal) throw new Error(`The Windows workers' userData needs the disk controller's CA certificates as PEM, and controllerCaCert ${refusal}.`);
  return pem;
}

// Checks a decoded userData document against the launcher's format, as the
// renderer does before it encodes one; throws on the first field the launcher
// would refuse. Pure. Messages name fields, never values.
export function checkWinWorkerUserData(document) {
  if (!isPlainObject(document)) throw new Error("The Windows workers' userData must be a JSON object.");
  const fail = (message) => {
    throw new Error(`The Windows workers' userData ${message}.`);
  };
  const unknown = Object.keys(document).filter((key) => !["version", "env", "extraEnv", "controllerCaCert"].includes(key));
  if (unknown.length > 0) fail(`has unknown fields: ${unknown.join(", ")}`);
  if (document.version !== WIN_WORKER_USER_DATA_VERSION) fail(`must be version ${WIN_WORKER_USER_DATA_VERSION}`);
  if (!isPlainObject(document.env)) fail("env must be an object");
  const names = Object.keys(document.env);
  const missing = WIN_WORKER_USER_DATA_ENV_KEYS.filter((name) => !names.includes(name));
  if (missing.length > 0) fail(`env lacks ${missing.join(", ")}`);
  const extra = names.filter((name) => !WIN_WORKER_USER_DATA_ENV_KEYS.includes(name));
  if (extra.length > 0) fail(`env holds names that are not userData settings (extraEnv takes those): ${extra.join(", ")}`);
  for (const name of WIN_WORKER_USER_DATA_ENV_KEYS) {
    const refusal = userDataValueRefusal(name, document.env[name]);
    if (refusal) fail(`refuses ${name}: it ${refusal}`);
  }
  if (document.extraEnv !== undefined) {
    if (!isPlainObject(document.extraEnv)) fail("extraEnv must be an object");
    const seen = new Set();
    for (const [name, value] of Object.entries(document.extraEnv)) {
      if (!EXTRA_ENV_NAME.test(name)) fail(`extraEnv refuses '${name}': it is not an environment variable name`);
      const refusal = extraEnvNameRefusal(name);
      if (refusal) fail(`extraEnv may not set ${name}: ${refusal}`);
      if (seen.has(name.toUpperCase())) fail(`extraEnv sets ${name} twice`);
      seen.add(name.toUpperCase());
      const valueRefusal = extraEnvValueRefusal(value);
      if (valueRefusal) fail(`extraEnv refuses the value of ${name}: it ${valueRefusal}`);
    }
  }
  caCertificatePem(document.controllerCaCert);
}

function requiredSetting(env, key, source) {
  const value = settingValue(env, key);
  if (!value) throw new Error(`The Windows workers' userData needs ${key}, ${source}.`);
  return value;
}

const sortedObject = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The Windows workers' userData: the stamp's values that the image does not
 * carry. Pure: everything comes from `env` and `caPem`, the PEM bundle of the
 * disk controller's trusted CAs (one, or two during a CA rotation, current
 * first). Any process on a VM can read userData, so it holds no secret:
 * database sign-in is the workers' identity's (Entra), feeds take that
 * identity too, and CA certificates are public.
 *
 * The configuration version is a SHA-256 over every value in the document
 * but itself, plus the scale set settings a running VM can't take on (its
 * size and image version). The controller drains and replaces a VM that
 * reports another version, so a changed CA bundle reaches every VM.
 *
 * Throws, naming the setting, on anything the launcher would refuse.
 * Returns { userData (base64), configVersion, document }.
 */
export function renderWinWorkerUserData(env, { caPem } = {}) {
  const settings = winWorkerSettings(env);
  const fqdn = requiredSetting(env, "POSTGRES_FQDN", "base-infra's PostgreSQL server");
  const database = settingValue(env, "POSTGRES_DATABASE_NAME") || "pilotswarm";
  const identityName = requiredSetting(env, "WIN_WORKER_IDENTITY_NAME", "the workers' identity from base-infra");
  const clientId = requiredSetting(env, "WIN_WORKER_IDENTITY_CLIENT_ID", "the workers' identity from base-infra");
  const principalId = requiredSetting(env, "EXPECTED_WIN_WORKER_OID", "the workers' identity from base-infra");
  const storage = (settingValue(env, "AZURE_STORAGE_ACCOUNT_URL") ||
    requiredSetting(env, "BLOB_CONTAINER_ENDPOINT", "the stamp storage account from base-infra")).replace(/\/+$/, "");
  const databaseUrl = `postgresql://${encodeURIComponent(identityName)}@${fqdn}:5432/${encodeURIComponent(database)}?sslmode=require`;

  const values = {
    DATABASE_URL: databaseUrl,
    PILOTSWARM_CMS_FACTS_DATABASE_URL: databaseUrl,
    PILOTSWARM_DB_AAD_USER: identityName,
    AZURE_STORAGE_ACCOUNT_URL: storage,
    PS_DISK_POOL_CONTROLLER_URL: DISK_CONTROLLER_WORKER_URL,
    PS_DISK_CONTROLLER_TOKEN_SCOPE: diskControllerTokenScope(env),
    AZURE_CLIENT_ID: clientId,
    EXPECTED_WIN_WORKER_OID: principalId,
    ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: winWorkerFeedEndpoints(env, clientId),
    // The deploy refuses a pool without the coordination host, which runs the
    // untagged work, so the Windows workers are always owner-only.
    PILOTSWARM_WORKER_OWNER_ONLY: "1",
  };
  const extraEnv = winWorkerExtraEnv(env);
  const controllerCaCert = caCertificatePem(caPem);

  const configVersion = createHash("sha256").update(JSON.stringify({
    version: WIN_WORKER_USER_DATA_VERSION,
    env: sortedObject(Object.entries(values)),
    extraEnv: sortedObject(extraEnv),
    controllerCaCert,
    scaleSet: { vmSize: settings.vmSize, imageVersion: settings.imageVersion ?? "" },
  })).digest("hex");

  const document = {
    version: WIN_WORKER_USER_DATA_VERSION,
    env: Object.fromEntries(WIN_WORKER_USER_DATA_ENV_KEYS.map((key) => [
      key, key === "WIN_WORKER_CONFIG_VERSION" ? configVersion : values[key],
    ])),
    ...(extraEnv.length > 0 ? { extraEnv: Object.fromEntries(extraEnv) } : {}),
    controllerCaCert,
  };
  checkWinWorkerUserData(document);
  const userData = Buffer.from(JSON.stringify(document), "utf8").toString("base64");
  if (userData.length >= WIN_WORKER_USER_DATA_MAX_BYTES) {
    throw new Error(
      `The Windows workers' userData is ${userData.length} bytes of base64; Azure takes less than ${WIN_WORKER_USER_DATA_MAX_BYTES}. ` +
        "Shorten WIN_WORKER_EXTRA_ENV.",
    );
  }
  return { userData, configVersion, document };
}
function deployStepValue(env, key, check, what) {
  const value = settingValue(env, key);
  if (!check(value)) {
    throw new Error(
      `WIN_WORKERS_ENABLED=true needs ${key} (${what}) from the Windows worker deploy step in ` +
        "deploy/providers/azure/deploy-steps/win-workers.mjs. Deploy base-infra through deploy.mjs.",
    );
  }
  return value;
}

// Parameters that only WIN_WORKERS_ENABLED=true adds to base-infra. With the
// setting off nothing is added, so redeploying an existing stamp changes
// nothing. The deploy step resolves the custom role definitions, whether the
// scale set exists, the standby pool provider's principal and the CA bundle
// (WIN_WORKER_CA_CERT) before Bicep runs; a missing answer must not pass as a
// default.
export function winWorkerParameters(module, env) {
  if (module !== "base-infra" || !winWorkersEnabled(env)) return null;
  const settings = winWorkerSettings(env);
  const params = {
    winWorkersEnabled: true,
    winWorkerCount: settings.count,
    winWorkerMinRunning: settings.minRunning,
    winWorkerStandbyMin: settings.standbyMin,
    winWorkerVmSize: settings.vmSize,
    winWorkerImageVersion: settings.imageVersion ?? "",
    winWorkerAlertEmails: settings.alertEmails,
    diskPoolControllerRoleId: deployStepValue(env, "WIN_WORKER_CONTROLLER_ROLE_ID", (v) => GUID.test(v),
      "the custom role definition PilotSwarm Disk Pool Controller"),
    workerSubnetJoinRoleId: deployStepValue(env, "WIN_WORKER_SUBNET_JOIN_ROLE_ID", (v) => GUID.test(v),
      "the custom role definition PilotSwarm Worker Subnet Join"),
    personalVaultWriterRoleId: deployStepValue(env, "WIN_WORKER_VAULT_WRITER_ROLE_ID", (v) => GUID.test(v),
      "the custom role definition PilotSwarm Personal Secret Writer"),
  };
  if (settings.imageVersion) {
    const exists = deployStepValue(env, "WIN_WORKER_SCALE_SET_EXISTS", (v) => ["true", "false"].includes(v.toLowerCase()),
      "whether the scale set exists").toLowerCase();
    params.winWorkerScaleSetExists = exists === "true";
    params.standbyPoolPrincipalId = deployStepValue(env, "WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID", (v) => GUID.test(v),
      "the standby pool resource provider's principal");
    const { userData, configVersion } = renderWinWorkerUserData(env, { caPem: env.WIN_WORKER_CA_CERT });
    params.winWorkerUserData = userData;
    params.winWorkerConfigVersion = configVersion;
  }
  // The coordination host's identity, grants and alert. The deploy refuses
  // the pool without it (overlay-contracts.mjs).
  if (settings.coordinationHost) params.winWorkerCoordinationHost = true;
  return params;
}

// Escape characters that would break a JSON string literal when interpolated.
// We do NOT wrap the result in quotes — the placeholder lives inside an existing
// JSON string in the template (e.g. `"value": "${VAR}"`), so we only need
// internal-character safety.
function jsonEscape(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}
