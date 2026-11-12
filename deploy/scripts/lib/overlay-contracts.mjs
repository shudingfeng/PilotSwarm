// Single source of truth for per-overlay env-key contracts.
//
// Each portal overlay (the value `resolveOverlayKey()` returns) maps to a
// contract with four role buckets:
//
//   userRequiredEnvKeys: must be present + non-empty BEFORE deploy.mjs runs
//                    any step. Operator-supplied (new-env scaffold or
//                    hand-edited deploy/envs/local/<env>/.env).
//   composedEnvKeys: populated by compose-env.mjs from upstream bicep
//                    outputs (POSTGRES_FQDN, BLOB_CONTAINER_ENDPOINT, …).
//                    Required at substitute time, not at the pre-deploy
//                    gate (chicken-and-egg: bicep step produces the inputs
//                    they're composed from).
//   stubKeys:        off-path keys that must exist in the env Map for
//                    substitute-env.mjs's target-based fail-closed gate
//                    to succeed. deploy.mjs auto-fills these with the
//                    `unused` sentinel.
//   bicepOutputKeys: populated by deploy-bicep.mjs via the OUTPUT_ALIAS
//                    map (or sourced from the base template.env, for the
//                    handful of static keys this group also covers).
//                    Required at substitute time but not at the pre-deploy
//                    validator.
//   settingKeys:     optional portal settings with a default in aks-env.mjs
//                    (PORTAL_SETTING_DEFAULTS). stage-manifests.mjs leaves a
//                    key at its default out of the staged overlay, so a
//                    stamp that sets none of them renders as before.
//
// Adding a new overlay key is a one-line change in this file —
// deploy.mjs / new-env.mjs pick it up automatically via the contract
// table.

export { databaseOverlayOmittedKeys } from "./database-env.mjs";
import { PORTAL_CONFIG_KEYS } from "./portal-config.mjs";
import { deploysPostgres, databaseUsesManagedIdentity, blobUsesManagedIdentity } from "./database-env.mjs";
import {
  policyRestricted,
  perimeterOperatorIpPrefixes,
  PORTAL_SETTING_DEFAULTS,
  winWorkersEnabled,
  winWorkerCoordinationHost,
  ownerRoutingEnabled,
  winWorkerSettings,
  diskControllerTokenScope,
} from "./aks-env.mjs";
import { winWorkerExtraEnv, winWorkerFeedEndpoints } from "./render-params.mjs";
import { workspacesEnabled } from "./workspaces.mjs";

// Edge mode and TLS source value spaces. Mirrors `new-env.mjs` EDGE_MODES /
// TLS_SOURCES — kept in sync via overlay-contracts.test.mjs.
export const EDGE_MODES = ["afd", "private", "public"];
export const TLS_SOURCES = ["letsencrypt", "akv", "akv-selfsigned"];

// JS-side authoritative defaults. Single source of truth — referenced by
// stage-manifests.mjs:resolveOverlayName() and portal/bicep/main.bicep
// (the bicep-side defaults carry a comment pointer to this file).
export const DEFAULT_EDGE_MODE = "afd";
export const DEFAULT_TLS_SOURCE = "letsencrypt";

// Collapse `akv-selfsigned` → `akv` (the two share a single overlay; the
// only delta is the AKV issuer name, owned by Portal bicep). Mirrors
// stage-manifests.mjs's resolveOverlayName().
function collapseTlsSource(tlsSource) {
  return tlsSource === "akv-selfsigned" ? "akv" : tlsSource;
}

// (edgeMode, tlsSource) → overlay directory key under
// deploy/providers/azure/gitops/portal/overlays/. Single source of truth.
export function resolveOverlayKey({ edgeMode, tlsSource }) {
  const em = (edgeMode || DEFAULT_EDGE_MODE).toLowerCase();
  const ts = collapseTlsSource((tlsSource || DEFAULT_TLS_SOURCE).toLowerCase());
  return `${em}-${ts}`;
}

// Shared roster: keys substituted into the portal overlay `.env` from
// bicep outputs (via deploy-bicep.mjs's OUTPUT_ALIAS) or seeded from the
// base template.env (the NAMESPACE / PILOTSWARM_USE_MANAGED_IDENTITY pair).
// Identical across all three overlays today; kept as a named constant so a
// future divergence is a single-line change per overlay.
const SHARED_BICEP_OUTPUT_KEYS = Object.freeze([
  "IMAGE",
  "NAMESPACE",
  "KV_NAME",
  "WORKLOAD_IDENTITY_CLIENT_ID",
  "AZURE_TENANT_ID",
  "PORTAL_HOSTNAME",
  "PILOTSWARM_USE_MANAGED_IDENTITY",
  "PILOTSWARM_BLOB_USE_MANAGED_IDENTITY",
  "SPC_KEYS_HASH",
  ...PORTAL_CONFIG_KEYS.map(({ env }) => env),
]);

// Shared composed-key roster (populated by compose-env.mjs from prior
// bicep outputs). Identical across all three overlays. On BYO deployments,
// databaseOverlayOmittedKeys removes URLs (projected by CSI instead); it also
// removes the AAD user when database managed identity is disabled.
const SHARED_COMPOSED_ENV_KEYS = Object.freeze([
  "AZURE_STORAGE_ACCOUNT_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL",
  "PILOTSWARM_DB_AAD_USER",
  "DATABASE_URL",
  "HORIZON_EMBED_URL",
  "HORIZON_EMBED_MODEL",
  "HORIZON_EMBED_DIM",
  "HORIZON_EMBED_API_KEY_HEADER",
]);

// The optional-setting roster, the same on every overlay: the portal
// settings of PORTAL_SETTING_DEFAULTS (aks-env.mjs).
export const SHARED_SETTING_KEYS = Object.freeze(Object.keys(PORTAL_SETTING_DEFAULTS));

// Per-overlay contracts.
export const OVERLAY_CONTRACTS = Object.freeze({
  "afd-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
    settingKeys: SHARED_SETTING_KEYS,
  }),
  "afd-letsencrypt": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "ACME_EMAIL",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
    settingKeys: SHARED_SETTING_KEYS,
  }),
  "private-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "HOST",
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
      "SSL_CERT_DOMAIN_SUFFIX",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
    settingKeys: SHARED_SETTING_KEYS,
  }),
  "public-letsencrypt": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "ACME_EMAIL",
      "PORTAL_HOSTNAME",
      "PORTAL_AUTH_PROVIDER",
      "PORTAL_AUTH_ENTRA_TENANT_ID",
      "AZURE_TENANT_ID",
      "PORTAL_AUTH_ENTRA_CLIENT_ID",
      "PORTAL_AUTH_ALLOW_UNAUTHENTICATED",
      "PILOTSWARM_USE_MANAGED_IDENTITY",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "SSL_CERT_DOMAIN_SUFFIX",
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
    settingKeys: SHARED_SETTING_KEYS,
  }),
});

// Return the contract for a given (edgeMode, tlsSource). Throws if the
// resolved overlay key is unknown — that's a hard bug, not user error.
export function getContract({ edgeMode, tlsSource }) {
  const key = resolveOverlayKey({ edgeMode, tlsSource });
  const c = OVERLAY_CONTRACTS[key];
  if (!c) {
    throw new Error(
      `overlay-contracts: no contract for resolved overlay '${key}' ` +
        `(EDGE_MODE='${edgeMode}' TLS_SOURCE='${tlsSource}'). ` +
        `Add an entry to OVERLAY_CONTRACTS in deploy/scripts/lib/overlay-contracts.mjs.`,
    );
  }
  return c;
}

// Human-readable rendering for VPN combo error codes. Keeps the message
// and remediation hint adjacent to the code so deploy.mjs / new-env.mjs
// don't have to re-derive them. The hint NEVER points at the scaffolder
// (re-running new-env.mjs would clobber operator edits) — it points at
// the env file and the VPN docs.
const VPN_COMBO_ERROR_DETAILS = Object.freeze({
  "vpn-requires-afd": Object.freeze({
    message:
      "VPN gateway requires EDGE_MODE='afd' (the auto-seeded AppGw WAF guard at " +
      "priorities 90/91/92 only makes sense when AFD is the public ingress and " +
      "AppGw is the private front-end).",
    hint:
      "Set EDGE_MODE=afd in deploy/envs/local/<env>/.env, or disable the VPN " +
      "gateway by setting VPN_GATEWAY_ENABLED=false. See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-akv": Object.freeze({
    message:
      "VPN gateway requires TLS_SOURCE='akv' or 'akv-selfsigned' " +
      "(Let's Encrypt's HTTP-01 challenge cannot reach a VPN-only client).",
    hint:
      "Set TLS_SOURCE=akv (or akv-selfsigned) in deploy/envs/local/<env>/.env, " +
      "or disable the VPN gateway by setting VPN_GATEWAY_ENABLED=false. " +
      "See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-domain-suffix": Object.freeze({
    message:
      "VPN gateway requires SSL_CERT_DOMAIN_SUFFIX to be set (the managed " +
      "Private DNS zone is named from this suffix).",
    hint:
      "Set SSL_CERT_DOMAIN_SUFFIX in deploy/envs/local/<env>/.env. " +
      "See docs/developer/deploy/aks.md.",
  }),
  "vpn-pool-overlap": Object.freeze({
    message:
      "VPN_CLIENT_ADDRESS_POOL overlaps the stamp VNet CIDR (or is malformed). " +
      "The client pool MUST be disjoint from the VNet address space — overlap " +
      "would black-hole intra-stamp traffic from connected VPN clients.",
    hint:
      "Pick a non-overlapping IPv4 CIDR for VPN_CLIENT_ADDRESS_POOL in " +
      "deploy/envs/local/<env>/.env (the default stamp VNet is 10.20.0.0/16; " +
      "set VNET_CIDR if you've customised it). See docs/developer/deploy/aks.md.",
  }),
  "vpn-requires-tenant-id": Object.freeze({
    message:
      "VPN gateway requires AZURE_TENANT_ID to be set (the P2S Entra ID " +
      "authentication flow needs the tenant GUID; an empty value would fall " +
      "through to bicep's empty default and produce a confusing late failure).",
    hint:
      "Set AZURE_TENANT_ID in deploy/envs/local/<env>/.env (it ships populated " +
      "in template.env — restore it if it was blanked). See docs/developer/deploy/aks.md.",
  }),
});

// Build a rich combo-error object from a code returned by
// validateVpnGatewayCombo(). Unknown codes get a generic message so a
// future combo-error addition isn't silently rendered as "[object Object]".
function describeVpnComboError(code) {
  const detail = VPN_COMBO_ERROR_DETAILS[code];
  if (!detail) {
    return {
      code,
      message: `VPN gateway combo error: ${code}.`,
      hint: "See docs/developer/deploy/aks.md.",
    };
  }
  return { code, message: detail.message, hint: detail.hint };
}

// Pre-deploy validator. Returns `{ missing, combo }`:
//   missing — array of userRequiredEnvKey names that are unset/blank (and
//             ACME_EMAIL when malformed on letsencrypt). These render as
//             "requires <keys> to be set" with a scaffolder hint.
//   combo   — array of `{ code, message, hint }` objects describing VPN
//             gateway, AZURE_POLICY_RESTRICTED and Windows worker pool combo errors.
//             These render
//             distinctly: a named error + a hint that does NOT point at
//             the scaffolder.
// Callers decide whether to throw or log — deploy.mjs throws via
// process.exit(1); new-env.mjs warn-and-continues at scaffold time.
export function validateRequiredEnv({ edgeMode, tlsSource, env }) {
  const contract = getContract({ edgeMode, tlsSource });
  const missing = [];
  for (const k of contract.userRequiredEnvKeys) {
    const v = env[k];
    if (v === undefined || v === null || String(v).trim() === "" || String(v).trim() === "__PS_UNSET__") {
      missing.push(k);
    }
  }
  if (edgeMode === "public") {
    const requiredValues = {
      PORTAL_AUTH_PROVIDER: "entra",
      PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
      PILOTSWARM_USE_MANAGED_IDENTITY: String(env.HORIZONDB_ENABLED).toLowerCase() === "true" ? "0" : "1",
    };
    for (const [key, expected] of Object.entries(requiredValues)) {
      if (String(env[key] ?? "").toLowerCase() !== expected && !missing.includes(key)) missing.push(key);
    }
    for (const key of ["AZURE_TENANT_ID", "PORTAL_AUTH_ENTRA_TENANT_ID", "PORTAL_AUTH_ENTRA_CLIENT_ID"]) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(env[key] ?? "")) && !missing.includes(key)) missing.push(key);
    }
  }
  // ACME_EMAIL gets a stricter shape check on letsencrypt — preserves
  // the prior deploy.mjs behaviour. We do it here so the contract is the
  // sole owner of "what counts as valid for this overlay".
  if (tlsSource === "letsencrypt") {
    const ace = env.ACME_EMAIL;
    if (ace && String(ace).trim() !== "" && !String(ace).includes("@")) {
      missing.push("ACME_EMAIL"); // present but malformed → treat as missing
    }
  }
  // VPN gateway combo validation. Returned as a SEPARATE channel from
  // `missing` because the rendering and remediation
  // differ — combo errors are not "set this key" errors and should not
  // direct operators at the scaffolder. Gated on VPN_GATEWAY_ENABLED=true
  // inside validateVpnGatewayCombo so non-VPN stamps are unaffected. The
  // AZURE_POLICY_RESTRICTED and Windows worker pool checks share the channel, each
  // gated on its own settings.
  const vpnCodes = validateVpnGatewayCombo({ edgeMode, tlsSource, env });
  const combo = [
    ...vpnCodes.map(describeVpnComboError),
    ...validatePolicyRestrictedCombo({ edgeMode, tlsSource, env }),
    ...validateWinWorkersCombo({ edgeMode, tlsSource, env }),
  ];
  return { missing, combo };
}

// ===========================================================================
// Windows worker pool combo validator.
//
// deploy.mjs runs this before any step of every service, so a run that only
// publishes manifests is checked too. Returns `{ code, message, hint }`
// objects; empty with the pool's settings at their defaults:
//   win-workers-settings          — a pool or owner-routing setting has a
//                                   value the deploy can't read.
//   win-workers-requires-vnet     — WIN_WORKERS_ENABLED=true needs EDGE_MODE
//                                   'afd' or 'private': the pool lives in the
//                                   stamp VNet, which public mode doesn't have.
//   win-workers-requires-alert-emails
//                                 — WIN_WORKER_ALERT_EMAILS must name at least
//                                   one receiver, so no alert fires unseen.
//   win-workers-requires-entra-app
//                                 — the workers and the controller use the
//                                   portal's Entra app tokens
//                                   (PORTAL_AUTH_ENTRA_CLIENT_ID).
//   win-workers-requires-stamp-database
//                                 — the workers sign in to the stamp's own
//                                   PostgreSQL server with their identity; a
//                                   bring-your-own database URL would have to
//                                   reach every VM as a secret.
//   win-workers-requires-database-identity
//                                 — the pool makes that server accept Entra
//                                   sign-in only, so PILOTSWARM_USE_MANAGED_IDENTITY
//                                   must be 1.
//   win-workers-extra-env         — a WIN_WORKER_EXTRA_ENV pair is malformed or
//                                   names a reserved setting.
//   win-workers-min-running-requires-coordination-host
//                                 — WIN_WORKER_MIN_RUNNING=0 leaves no VM to
//                                   run orchestrations and timers; only the
//                                   coordination host does that.
//   coordination-host-requires-win-workers
//   coordination-host-requires-owner-routing
//                                 — owner-only workers claim only owner-tagged
//                                   work, and the coordination host runs no
//                                   user turn, so without owner tags no user
//                                   turn would run.
//   owner-routing-requires-win-workers
//                                 — only a bound Windows worker serves an
//                                   owner tag; elsewhere owner-tagged work
//                                   would wait for a worker that never comes.
//   coordination-host-excludes-workspaces
//                                 — the coordination host runs no user turn,
//                                   so it takes neither the session
//                                   workspaces' mounts nor their provider,
//                                   which would replace its own extension.
// ===========================================================================
export function validateWinWorkersCombo({ edgeMode, tlsSource, env }) {
  const hint =
    "Change the setting in deploy/envs/local/<env>/.env. See the Windows worker pool section of " +
    "deploy/providers/azure/envs/template.env.";
  const errors = [];
  const refuse = (code, message) => errors.push({ code, message, hint });

  let enabled = false;
  let coordinationHost = false;
  let ownerRouting = false;
  let settings = null;
  for (const read of [
    () => { enabled = winWorkersEnabled(env); },
    () => { coordinationHost = winWorkerCoordinationHost(env); },
    () => { ownerRouting = ownerRoutingEnabled(env); },
    () => { settings = winWorkerSettings(env); },
  ]) {
    try {
      read();
    } catch (e) {
      refuse("win-workers-settings", e.message);
    }
  }

  if (enabled) {
    const em = String(edgeMode ?? "").toLowerCase();
    if (em !== "afd" && em !== "private") {
      refuse(
        "win-workers-requires-vnet",
        `WIN_WORKERS_ENABLED=true needs EDGE_MODE='afd' or 'private', not '${em}': the pool's subnets, ` +
          "NAT gateway and private endpoints live in the stamp VNet, which public mode doesn't have.",
      );
    }
    if (settings && settings.alertEmails.length === 0) {
      refuse(
        "win-workers-requires-alert-emails",
        "WIN_WORKERS_ENABLED=true needs WIN_WORKER_ALERT_EMAILS, at least one comma-separated address " +
          "that receives the pool's security and operations alerts.",
      );
    }
    try {
      diskControllerTokenScope(env);
    } catch (e) {
      refuse("win-workers-requires-entra-app", e.message);
    }
    if (!deploysPostgres(env)) {
      refuse(
        "win-workers-requires-stamp-database",
        "WIN_WORKERS_ENABLED=true needs the stamp's own PostgreSQL server (DEPLOY_POSTGRES=true): the " +
          "Windows workers sign in to it with their managed identity, and a bring-your-own database URL " +
          "would have to reach every VM as a secret.",
      );
    } else {
      let databaseIdentity;
      try {
        databaseIdentity = databaseUsesManagedIdentity(env);
      } catch {
        databaseIdentity = false;
      }
      if (!databaseIdentity) {
        refuse(
          "win-workers-requires-database-identity",
          "WIN_WORKERS_ENABLED=true makes the stamp's PostgreSQL server accept Entra sign-in only, " +
            "so PILOTSWARM_USE_MANAGED_IDENTITY must be 1.",
        );
      }
    }
    try {
      winWorkerExtraEnv(env);
    } catch (e) {
      refuse("win-workers-extra-env", e.message);
    }
    try {
      winWorkerFeedEndpoints(env, "");
    } catch (e) {
      refuse("win-workers-settings", e.message);
    }
  }

  if (settings && settings.minRunning === 0 && !coordinationHost) {
    refuse(
      "win-workers-min-running-requires-coordination-host",
      "WIN_WORKER_MIN_RUNNING=0 needs WIN_WORKER_COORDINATION_HOST=true: with no Windows VM up, only the " +
        "coordination host runs orchestrations and timers.",
    );
  }
  if (coordinationHost && !enabled) {
    refuse(
      "coordination-host-requires-win-workers",
      "WIN_WORKER_COORDINATION_HOST=true needs WIN_WORKERS_ENABLED=true: the coordination host serves the " +
        "Windows worker pool.",
    );
  }
  if (coordinationHost && !ownerRouting) {
    refuse(
      "coordination-host-requires-owner-routing",
      "WIN_WORKER_COORDINATION_HOST=true needs PILOTSWARM_OWNER_ROUTING=1: the Windows workers then claim " +
        "only owner-tagged work and the coordination host runs no user turn, so without owner tags no " +
        "user turn would run.",
    );
  }
  if (ownerRouting && !enabled) {
    refuse(
      "owner-routing-requires-win-workers",
      "PILOTSWARM_OWNER_ROUTING=1 needs WIN_WORKERS_ENABLED=true: only a bound Windows worker serves an " +
        "owner tag, so owner-tagged work would wait for a worker that never comes.",
    );
  }
  let workspaces = false;
  try {
    workspaces = workspacesEnabled(env);
  } catch {
    // The workspaces switch reports a bad value itself.
  }
  if (coordinationHost && workspaces) {
    refuse(
      "coordination-host-excludes-workspaces",
      "WIN_WORKER_COORDINATION_HOST=true needs WORKSPACES_ENABLED=false: the coordination host runs no user turn, " +
        "so it mounts no session workspace and loads no workspace provider.",
    );
  }
  return errors;
}

// ===========================================================================
// AZURE_POLICY_RESTRICTED combo validator.
//
// The profile is for subscriptions whose Azure Policy requires a network
// security perimeter and denies Storage shared keys and deployment scripts,
// so it can use no ARM deployment script. deploy.mjs runs this before any
// step of every service, so a run that only publishes manifests is checked
// too. Returns `{ code, message, hint }` objects; empty when the setting is
// off or the combination is fine:
//   policy-restricted-requires-afd               — EDGE_MODE must be 'afd'. `private` needs
//                                    an akv TLS source (next code); `public`
//                                    has no stamp VNet to hold the blob
//                                    private endpoint.
//   policy-restricted-requires-letsencrypt       — TLS_SOURCE 'akv' and 'akv-selfsigned'
//                                    issue and bind the portal certificate
//                                    with deployment scripts.
//   policy-restricted-operator-prefixes          — a PERIMETER_OPERATOR_IP_PREFIXES entry
//                                    is not an IPv4 address or CIDR prefix.
//   policy-restricted-requires-database-identity — the profile's PostgreSQL server takes
//                                    Entra sign-in only, so a provisioned
//                                    database needs
//                                    PILOTSWARM_USE_MANAGED_IDENTITY=1.
//   policy-restricted-requires-blob-identity     — the profile turns off Storage shared
//                                    keys, so the workers and the portal
//                                    need Blob managed identity
//                                    (PILOTSWARM_BLOB_USE_MANAGED_IDENTITY,
//                                    1 by default on this deploy path).
// ===========================================================================
export function validatePolicyRestrictedCombo({ edgeMode, tlsSource, env }) {
  if (!policyRestricted(env)) return [];
  const hint =
    "Change the setting in deploy/envs/local/<env>/.env, or deploy without AZURE_POLICY_RESTRICTED=true. " +
    "See docs/developer/deploy/aks.md.";
  const errors = [];

  const em = String(edgeMode ?? "").toLowerCase();
  if (em !== "afd") {
    errors.push({
      code: "policy-restricted-requires-afd",
      message:
        `AZURE_POLICY_RESTRICTED=true supports EDGE_MODE='afd' only, not '${em}'. Private mode needs an akv ` +
        "TLS source, which uses deployment scripts, and public mode has no stamp VNet to hold the " +
        "blob private endpoint.",
      hint,
    });
  }

  const ts = String(tlsSource ?? "").toLowerCase();
  if (ts === "akv" || ts === "akv-selfsigned") {
    errors.push({
      code: "policy-restricted-requires-letsencrypt",
      message:
        `AZURE_POLICY_RESTRICTED=true refuses TLS_SOURCE='${ts}': the akv TLS sources issue and bind the portal ` +
        "certificate with ARM deployment scripts, which need Storage shared keys. Use TLS_SOURCE=letsencrypt.",
      hint,
    });
  }

  try {
    perimeterOperatorIpPrefixes(env);
  } catch (e) {
    errors.push({ code: "policy-restricted-operator-prefixes", message: e.message, hint });
  }

  let databaseIdentity;
  try {
    databaseIdentity = databaseUsesManagedIdentity(env);
  } catch {
    databaseIdentity = false;
  }
  if (deploysPostgres(env) && !databaseIdentity) {
    errors.push({
      code: "policy-restricted-requires-database-identity",
      message:
        "AZURE_POLICY_RESTRICTED=true makes the provisioned PostgreSQL server accept Entra sign-in only, " +
        "so PILOTSWARM_USE_MANAGED_IDENTITY must be 1.",
      hint,
    });
  }

  if (!blobUsesManagedIdentity(env)) {
    errors.push({
      code: "policy-restricted-requires-blob-identity",
      message:
        "AZURE_POLICY_RESTRICTED=true denies Storage shared keys, so the workers and the portal must reach Blob " +
        "with their managed identity: PILOTSWARM_BLOB_USE_MANAGED_IDENTITY must be 1.",
      hint,
    });
  }

  return errors;
}

// ===========================================================================
// VPN gateway combo validator.
//
// Gated on `env.VPN_GATEWAY_ENABLED === 'true'`. Returns an array of error
// codes (empty = OK). Codes:
//   vpn-requires-afd            — EDGE_MODE must be 'afd' (the auto-seeded
//                                 AppGw WAF guard at priorities 90/91/92
//                                 only makes sense when AFD is the public
//                                 ingress and AppGw is private-FE).
//   vpn-requires-akv            — TLS_SOURCE must be 'akv' or
//                                 'akv-selfsigned'; Let's Encrypt is
//                                 unsupported on the VPN path (HTTP-01
//                                 cannot reach a VPN-only client).
//   vpn-requires-domain-suffix  — SSL_CERT_DOMAIN_SUFFIX must be non-empty
//                                 (managed Private DNS zone uses it).
//   vpn-pool-overlap            — VPN_CLIENT_ADDRESS_POOL overlaps the
//                                 stamp VNet CIDR. Reads VNET_CIDR from
//                                 env when present, defaults to
//                                 '10.20.0.0/16' (matches vnet.bicep's
//                                 default base address space).
//   vpn-requires-tenant-id      — AZURE_TENANT_ID must be set (non-empty)
//                                 when the VPN gateway is enabled.
//                                 Closes the gap behind the bicep
//                                 `tenantId=''` default — even though
//                                 template.env ships a populated value,
//                                 an operator who blanks it gets a clear
//                                 pre-deploy error instead of a confusing
//                                 bicep failure.
//
// Returns an empty array when VPN_GATEWAY_ENABLED is anything other than
// the literal string 'true' (handles the unset / 'false' / 'FALSE' /
// boolean-false cases).
// ===========================================================================
export function validateVpnGatewayCombo({ edgeMode, tlsSource, env }) {
  const enabled = String(env?.VPN_GATEWAY_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled) return [];

  const errors = [];

  const em = String(edgeMode ?? "").toLowerCase();
  if (em !== "afd") errors.push("vpn-requires-afd");

  // Accept both `akv` and `akv-selfsigned` (they collapse to the same
  // overlay anyway; the only delta is the AKV issuer). The forbidden value
  // is `letsencrypt`.
  const ts = String(tlsSource ?? "").toLowerCase();
  if (ts !== "akv" && ts !== "akv-selfsigned") errors.push("vpn-requires-akv");

  const suffix = env?.SSL_CERT_DOMAIN_SUFFIX;
  if (suffix === undefined || suffix === null || String(suffix).trim() === "") {
    errors.push("vpn-requires-domain-suffix");
  }

  const pool = env?.VPN_CLIENT_ADDRESS_POOL;
  // VNET_CIDR is forward-compatible — not in template.env today; default
  // mirrors vnet.bicep's `10.20.0.0/16` baseline.
  const vnetCidr = env?.VNET_CIDR && String(env.VNET_CIDR).trim() !== ""
    ? String(env.VNET_CIDR).trim()
    : "10.20.0.0/16";
  if (pool && String(pool).trim() !== "") {
    try {
      if (cidrsOverlap(String(pool).trim(), vnetCidr)) {
        errors.push("vpn-pool-overlap");
      }
    } catch {
      // Malformed CIDR → also a pool problem.
      errors.push("vpn-pool-overlap");
    }
  }

  // AZURE_TENANT_ID must be present when VPN is enabled. The bicep side
  // declares `param tenantId string = ''` so a blanked value would silently
  // flow through and surface as a confusing late error in the gateway
  // module — fail-closed here instead.
  const tenantId = env?.AZURE_TENANT_ID;
  if (tenantId === undefined || tenantId === null || String(tenantId).trim() === "") {
    errors.push("vpn-requires-tenant-id");
  }

  return errors;
}

// IPv4 CIDR overlap helper. Returns true when the two prefixes share any
// address. Pure-JS, no dependencies; only handles IPv4 (the VPN gateway
// supports IPv6 client pools too, but the stamp VNet is IPv4-only — when
// IPv6 support arrives we extend here and add tests).
function cidrsOverlap(a, b) {
  const [na, ma] = parseCidr(a);
  const [nb, mb] = parseCidr(b);
  // Two prefixes overlap iff one contains the other. Apply the SHORTER
  // (less specific) mask to both networks — if they match, the longer
  // prefix's network is contained in the shorter prefix.
  const mask = ma < mb ? ma : mb;
  return networkOf(na, mask) === networkOf(nb, mask);
}

function parseCidr(cidr) {
  const m = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/([0-9]{1,2})$/.exec(cidr);
  if (!m) throw new Error(`invalid IPv4 CIDR: ${cidr}`);
  const ip = m[1].split(".").map((o) => {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`invalid IPv4 octet in ${cidr}`);
    }
    return n;
  });
  const mask = Number(m[2]);
  if (!Number.isInteger(mask) || mask < 0 || mask > 32) {
    throw new Error(`invalid IPv4 prefix length in ${cidr}`);
  }
  // Use unsigned right shift to keep the result in [0, 2^32-1].
  const num = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  return [num, mask];
}

function networkOf(ipNum, prefix) {
  if (prefix === 0) return 0;
  // 32-bit left-aligned mask; >>> 0 to coerce back to unsigned.
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) >>> 0;
}

// Off-path stub-fill. Mutates `env` in place, setting any stubKey that
// is currently blank to the `unused` sentinel. Driven by the contract so
// adding a new off-path key is a one-line change in this file.
export function applyStubKeys({ edgeMode, tlsSource, env }) {
  const contract = getContract({ edgeMode, tlsSource });
  const STUB = "unused";
  const stubbed = [];
  for (const k of contract.stubKeys) {
    if (!env[k] || String(env[k]).trim() === "") {
      env[k] = STUB;
      stubbed.push(k);
    }
  }
  return stubbed;
}
