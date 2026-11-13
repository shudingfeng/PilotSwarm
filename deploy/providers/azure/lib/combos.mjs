// The combination checks of the Azure provider's optional settings: the
// Windows worker pool's and AZURE_POLICY_RESTRICTED's.
// deploy/scripts/lib/overlay-contracts.mjs runs them in validateRequiredEnv,
// beside the VPN gateway's, before any step of every service, and re-exports
// them.

import { DATABASE_ENV_DEFAULTS, deploysPostgres, databaseUsesManagedIdentity } from "../../../scripts/lib/database-env.mjs";
import {
  policyRestricted,
  perimeterOperatorIpPrefixes,
  winWorkersEnabled,
  winWorkerCoordinationHost,
  ownerRoutingEnabled,
  ownershipEnforced,
  settingValue,
  winWorkerSettings,
  diskControllerTokenScope,
} from "./settings.mjs";
import { winWorkerExtraEnv, winWorkerFeedEndpoints } from "./bicep-parameters.mjs";

// Whether the workers and the portal reach Blob with their managed identity,
// decided as the runtime decides it (createSessionBlobStore in
// packages/sdk/src/blob-store.ts): the Blob flag when it is not empty, else the
// database flag, each true only for 1, true, yes or on. Like loadEnv, an env
// map without the Blob flag gets this deploy path's default.
export function blobUsesManagedIdentity(env) {
  const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
  const blobFlag = String(
    env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY ?? DATABASE_ENV_DEFAULTS.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY,
  ).trim();
  return blobFlag !== "" ? truthy(blobFlag) : truthy(env.PILOTSWARM_USE_MANAGED_IDENTITY);
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
//   win-workers-requires-coordination-host
//                                 — the coordination host makes the Windows
//                                   workers owner-only and runs everything
//                                   else, so no Windows worker runs another
//                                   user's work next to its owner's token.
//   win-workers-requires-ownership-enforcement
//   dispatcher-requires-ownership-enforcement
//                                 — AUTHZ_ENFORCE_OWNERSHIP must be true (read
//                                   as packages/app/web/authz.js reads it):
//                                   otherwise the portal only audits who may
//                                   open a session, and a session that runs on
//                                   its owner's Windows worker with the
//                                   owner's token, or that a dispatcher
//                                   created for its owner, is open to anyone.
//   coordination-host-requires-win-workers
//                                 — the coordination host serves the pool.
//   coordination-host-requires-owner-routing
//                                 — the Windows workers run only owner-tagged
//                                   turns, and only owner routing records the
//                                   owner's tag on each session the dispatcher
//                                   creates for a user; without it those
//                                   sessions would run on the coordination
//                                   host instead. Other sessions run untagged
//                                   on the host either way.
//   owner-routing-requires-win-workers
//                                 — only a bound Windows worker serves an
//                                   owner tag; elsewhere owner-tagged work
//                                   would wait for a worker that never comes.
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

  if (enabled && !coordinationHost) {
    refuse(
      "win-workers-requires-coordination-host",
      "WIN_WORKERS_ENABLED=true needs WIN_WORKER_COORDINATION_HOST=true: the coordination host makes the Windows " +
        "workers owner-only and runs everything else, so no Windows worker runs another user's work, a Workflow " +
        "included, next to its owner's token.",
    );
  }
  if (!ownershipEnforced(env)) {
    if (enabled) {
      refuse(
        "win-workers-requires-ownership-enforcement",
        "WIN_WORKERS_ENABLED=true needs AUTHZ_ENFORCE_OWNERSHIP=true: otherwise the portal only audits who may open " +
          "a session, so anyone could prompt an owner's session, which runs on that owner's Windows worker with the " +
          "owner's token.",
      );
    }
    if (settingValue(env, "DISPATCHER_SP_OBJECT_ID")) {
      refuse(
        "dispatcher-requires-ownership-enforcement",
        "DISPATCHER_SP_OBJECT_ID needs AUTHZ_ENFORCE_OWNERSHIP=true: otherwise the portal only audits who may open " +
          "a session, so the sessions the dispatcher creates for their owners stay neither private nor read-only " +
          "to others, and turning delegation off stops nothing.",
      );
    }
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
      "WIN_WORKER_COORDINATION_HOST=true needs PILOTSWARM_OWNER_ROUTING=1: the Windows workers then run only " +
        "owner-tagged turns, and only owner routing records the owner's tag on each session the dispatcher creates " +
        "for a user. Without it those sessions would run on the coordination host, without their Dev Drive or their " +
        "owner's token.",
    );
  }
  if (ownerRouting && !enabled) {
    refuse(
      "owner-routing-requires-win-workers",
      "PILOTSWARM_OWNER_ROUTING=1 needs WIN_WORKERS_ENABLED=true: only a bound Windows worker serves an " +
        "owner tag, so owner-tagged work would wait for a worker that never comes.",
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
