// What the Azure provider's optional settings add to the staged overlays, for
// deploy/scripts/lib/stage-manifests.mjs, which re-exports these: the portal
// settings left out at their defaults, the disk controller's overlay values,
// and the check of its dispatcher Ingress's trusted roots.

import {
  DISK_CONTROLLER_SERVICE,
  WIN_WORKER_ENV_DEFAULTS,
  DISK_CONTROLLER_ENV_DEFAULTS,
  PORTAL_SETTING_DEFAULTS,
  WIN_WORKER_OUTPUT_DEFAULTS,
  diskControllerTokenScope,
  personalSecretVaultUri,
  settingValue,
} from "./settings.mjs";

// Portal settings at their default stay out of the staged overlay: the portal
// behaves the same without them, and a stamp that sets none of them stages
// the same files as before they existed. Unset, the dispatcher's object ID
// turns delegation off.
const PORTAL_OPTIONAL_DEFAULTS = Object.freeze({ ...PORTAL_SETTING_DEFAULTS, DISPATCHER_SP_OBJECT_ID: "__PS_UNSET__" });

export function portalSettingOmittedKeys(envMap) {
  return Object.entries(PORTAL_OPTIONAL_DEFAULTS)
    .filter(([key, fallback]) => {
      const value = settingValue(envMap, key);
      return value === "" || value === fallback;
    })
    .map(([key]) => key);
}

// The controller overlay's values, from the shared env map, which this leaves
// unchanged. The controller runs as its own identity: its service account
// takes the controller identity's client ID, never the portal's
// WORKLOAD_IDENTITY_CLIENT_ID. An empty value falls back to its default.
// The overlay's APPGW_TRUSTED_ROOT_CERTS lists the dispatcher Ingress's
// trusted roots, which the Windows worker deploy step finds or uploads and
// passes as APPGW_TRUSTED_ROOT_CERT_NAMES just before the manifests; in the
// env file, APPGW_TRUSTED_ROOT_CERTS is only the prefix of the roots it
// uploads. A stamp whose CA is on the root of the default name renders the
// same overlay as before CA rotations.
export function diskControllerOverlayEnv(env) {
  const clientId = settingValue(env, "DISK_CONTROLLER_IDENTITY_CLIENT_ID");
  if (!clientId) {
    throw new Error(
      "[stage-manifests] the disk controller needs DISK_CONTROLLER_IDENTITY_CLIENT_ID from base-infra: " +
        "deploy base-infra with WIN_WORKERS_ENABLED=true first.",
    );
  }
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== null && value !== ""));
  const rootNames = settingValue(env, "APPGW_TRUSTED_ROOT_CERT_NAMES");
  return {
    ...WIN_WORKER_ENV_DEFAULTS,
    ...DISK_CONTROLLER_ENV_DEFAULTS,
    ...WIN_WORKER_OUTPUT_DEFAULTS,
    PORTAL_TLS_CERT_NAME: "pilotswarm-portal-tls",
    ...set,
    ...(rootNames ? { APPGW_TRUSTED_ROOT_CERTS: rootNames } : {}),
    WORKLOAD_IDENTITY_CLIENT_ID: clientId,
    PS_DISK_CONTROLLER_TOKEN_SCOPE: diskControllerTokenScope(env),
    PILOTSWARM_PERSONAL_SECRET_VAULT_URI: personalSecretVaultUri(env),
  };
}

export function checkDiskControllerTrustedRoots({ service, overlayName, envMap }) {
  // With App Gateway, the dispatcher Ingress names the trusted roots of the
  // controller's CAs, which the Windows worker deploy step finds or uploads
  // and lists in the env map just before these manifests (win-workers.mjs).
  if (service === DISK_CONTROLLER_SERVICE && overlayName.startsWith("afd-") && !settingValue(envMap, "APPGW_TRUSTED_ROOT_CERT_NAMES")) {
    throw new Error(
      "[stage-manifests] the disk controller's dispatcher Ingress names App Gateway's trusted roots, which the Windows worker " +
        "deploy step lists before the controller's manifests: deploy the disk-controller service with deploy.mjs.",
    );
  }
}
