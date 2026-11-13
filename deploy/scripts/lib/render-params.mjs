// Bicep params template rendering (Phase 3, FR-020).
//
// Reads a Bicep parameters template (deploy/providers/azure/services/<Module>/bicep/<Module>.params.template.json),
// substitutes ${VAR} placeholders left-to-right with values from the env map,
// and writes the rendered file to <staging>/<module>.params.json. With
// AZURE_POLICY_RESTRICTED=true it also adds that profile's parameters to base-infra and
// portal, and with WIN_WORKERS_ENABLED=true the Windows worker pool's parameters to
// base-infra, from deploy/providers/azure/lib/bicep-parameters.mjs; the templates
// themselves never name them.
//
// Fail-closed: any unresolved ${VAR} aborts with a single summary listing all
// missing keys. We never silently pass through to az — Bicep treats missing
// inputs as a typed error far downstream and the message is opaque.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploysPostgres } from "./database-env.mjs";
import { workspacesEnabled } from "./workspaces.mjs";
import { userPoolMinCount } from "./aks-env.mjs";
import { policyRestrictedParameters, winWorkerParameters } from "../../providers/azure/lib/bicep-parameters.mjs";

// The Windows workers' userData and the pool's parameters, for the modules
// and tests that import them from here.
export {
  DISK_CONTROLLER_WORKER_URL,
  WIN_WORKER_USER_DATA_VERSION,
  WIN_WORKER_USER_DATA_MAX_BYTES,
  WIN_WORKER_USER_DATA_ENV_KEYS,
  WIN_WORKER_RESERVED_EXTRA_ENV_PREFIXES,
  WIN_WORKER_RESERVED_EXTRA_ENV_NAMES,
  winWorkerExtraEnv,
  winWorkerFeedEndpoints,
  checkWinWorkerUserData,
  renderWinWorkerUserData,
  winWorkerParameters,
} from "../../providers/azure/lib/bicep-parameters.mjs";

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
