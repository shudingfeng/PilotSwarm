// Who may call the controller. Every route but the health probe takes an
// Entra v2 access token for the stamp's app registration, the audience of
// PS_DISK_CONTROLLER_TOKEN_SCOPE, and each listener's routes ask for one of
// its app roles:
//
//   worker       worker routes: the role and the workers' shared identity
//                (EXPECTED_WIN_WORKER_OID); the VM comes from the source IP
//   dispatcher   dispatcher routes: the `user` role, and only
//                DISPATCHER_SP_OBJECT_ID. A person's own `user` token is
//                refused, because no other object ID passes
//   admin        /v1/admin/upgrade-freeze: the `admin` role (people) or
//                `deployer` (the deploy pipeline's identity)
//   admin-only   /v1/admin/status: the `admin` role alone. The status names
//                every lease's work, root session and owner, and every VM's
//                owner, which the deploy pipeline never needs
//   coordinator  /v1/coordination/demand: the `coordinator` role
export const ROLE = Object.freeze({
  WORKER: "worker",
  USER: "user",
  ADMIN: "admin",
  DEPLOYER: "deployer",
  COORDINATOR: "coordinator",
});

const JWT = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;

export function bearerToken(header) {
  const match = JWT.exec(String(header ?? "").trim());
  return match ? match[1] : null;
}

/** The caller a verified token's claims describe. Throws for anything but a v2 token of the tenant with an object ID. */
export function callerFromClaims(claims, { tenantId }) {
  if (claims?.ver !== "2.0") throw new Error("the token is not an Entra v2 access token");
  if (String(claims.tid ?? "").toLowerCase() !== tenantId) throw new Error("the token comes from another tenant");
  const oid = typeof claims.oid === "string" ? claims.oid.toLowerCase() : "";
  if (!oid) throw new Error("the token names no object ID");
  const roles = new Set(Array.isArray(claims.roles) ? claims.roles.filter((role) => typeof role === "string") : []);
  return Object.freeze({ oid, roles, app: typeof claims.scp !== "string" });
}

/**
 * Verifies a token's signature against the tenant's published keys, its
 * issuer, audience and lifetime, and returns the caller. Only this function
 * imports `jose`; `importModule` lets tests stand in for it.
 */
export function createTokenVerifier({ tenantId, audience, authorityHost }, { importModule = (specifier) => import(specifier) } = {}) {
  const issuer = `${authorityHost}${tenantId}/v2.0`;
  const keysUrl = new URL(`${authorityHost}${tenantId}/discovery/v2.0/keys`);
  let jose = null;
  let keys = null;
  return async function verify(token) {
    jose ??= await importModule("jose");
    keys ??= jose.createRemoteJWKSet(keysUrl, { cooldownDuration: 30_000, cacheMaxAge: 3_600_000, timeoutDuration: 5_000 });
    const { payload } = await jose.jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"], clockTolerance: 60 });
    return callerFromClaims(payload, { tenantId });
  };
}

/** Null when `caller` may use a route with this policy, or the reason it may not. */
export function refusal(policy, caller, tokens) {
  switch (policy) {
    case "worker":
      if (!caller.roles.has(ROLE.WORKER)) return "the token has no worker role";
      if (caller.oid !== tokens.workerOid) return "the token is not the workers' identity";
      return null;
    case "dispatcher":
      if (!tokens.dispatcherOid) return "no dispatcher is configured";
      if (!caller.roles.has(ROLE.USER)) return "the token has no user role";
      if (caller.oid !== tokens.dispatcherOid) return "the token is not the dispatcher's identity";
      return null;
    case "admin":
      return caller.roles.has(ROLE.ADMIN) || caller.roles.has(ROLE.DEPLOYER) ? null : "the token has neither the admin nor the deployer role";
    case "admin-only":
      return caller.roles.has(ROLE.ADMIN) ? null : "the token has no admin role";
    case "coordinator":
      return caller.roles.has(ROLE.COORDINATOR) ? null : "the token has no coordinator role";
    default:
      return `unknown policy ${policy}`;
  }
}

/** The IPv4 address of a socket's peer, without the IPv6 mapping prefix; null for anything else. */
export function peerIPv4(remoteAddress) {
  const text = String(remoteAddress ?? "").replace(/^::ffff:/i, "");
  return /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(text) ? text : null;
}
