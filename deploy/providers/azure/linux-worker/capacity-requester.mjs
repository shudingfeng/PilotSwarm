/**
 * The coordination host's capacity requester: an extension module for the
 * Linux worker that, beside a Windows worker pool of owner-only workers, runs
 * the work no owner's worker runs (README). Load it with the worker's
 * extension-module hook:
 *
 *   PILOTSWARM_EXTENSION_MODULES=/app/deploy/providers/azure/linux-worker/capacity-requester.mjs
 *   PS_COORDINATION_URL=https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005
 *   PS_COORDINATION_TOKEN_SCOPE=<app client ID>/.default
 *   NODE_EXTRA_CA_CERTS=<the disk controller's CA certificate>
 *
 * register(worker) sets the capacity requester, which sends each capacity
 * request to the disk controller's coordination route,
 * POST /v1/coordination/demand, with a token of the pod's own workload
 * identity, and passes the controller's answer on. On a worker with a
 * requester, PilotSwarm refuses, without a retry, a turn of a session whose
 * stored config carries an owner tag that the turn's input lacks, so an
 * owner-routed session never runs a turn here.
 *
 * It refuses a worker that runs an owner's sessions. Only Node's built-ins
 * load with it; @azure/identity loads when the first token is needed.
 */
import https from "node:https";

/** The disk controller's coordination route. */
export const DEMAND_ROUTE = "/v1/coordination/demand";

const OWNER_TAG_PREFIX = "owner.";
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A v2 token for the controller's app: <client ID>/.default or api://<client ID>/.default.
const TOKEN_SCOPE = /^(?:api:\/\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.default$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ANSWER_BYTES = 64 * 1024;
const WORKLOAD_IDENTITY_SETTINGS = ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_FEDERATED_TOKEN_FILE"];

/** The answer for an owner whose subject is not a Microsoft Entra object ID, which the controller cannot serve. */
export const OWNER_NOT_SUPPORTED = "OWNER_NOT_SUPPORTED";
export const OWNER_NOT_SUPPORTED_MESSAGE = "This session's owner has no Microsoft Entra object ID, so the disk controller can give it "
  + "no Windows worker. Sign in with Microsoft Entra ID to use this deployment's Windows workers.";

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const text = (value) => String(value ?? "").trim();
const textOf = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
};
const abortReason = (signal) => signal.reason ?? new Error("aborted");

/** PS_COORDINATION_URL: the coordination route's https origin, without a path, query or credentials. */
export function parseCoordinationUrl(value) {
  const raw = text(value);
  if (!raw) {
    throw new Error("PS_COORDINATION_URL is required: the disk controller's coordination endpoint, "
      + "https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005");
  }
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(raw)) {
    throw new Error("PS_COORDINATION_URL must be an https:// URL with a host and port and nothing else, "
      + "such as https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005");
  }
  return url.origin;
}

/** PS_COORDINATION_TOKEN_SCOPE: the scope of a v2 token for the disk controller's app. */
export function parseTokenScope(value) {
  const scope = text(value);
  if (!scope) throw new Error("PS_COORDINATION_TOKEN_SCOPE is required: <app client ID>/.default of the disk controller's app");
  if (!TOKEN_SCOPE.test(scope)) {
    throw new Error("PS_COORDINATION_TOKEN_SCOPE must be <app client ID>/.default or api://<app client ID>/.default");
  }
  return scope;
}

/**
 * The module's settings from the worker's environment. It refuses a worker
 * started with an owner tag or as an owner-only worker: the coordination
 * host must run no owner's sessions.
 */
export function settingsFromEnv(env = process.env) {
  if (text(env.PILOTSWARM_WORKER_OWNER_TAG)) {
    throw new Error("the coordination host runs no owner's sessions, and this worker has PILOTSWARM_WORKER_OWNER_TAG: "
      + "load this module only on a worker without an owner tag");
  }
  const ownerOnly = text(env.PILOTSWARM_WORKER_OWNER_ONLY);
  if (ownerOnly && ownerOnly !== "0") {
    throw new Error(`the coordination host runs no owner's sessions, and this worker has PILOTSWARM_WORKER_OWNER_ONLY=${ownerOnly}: `
      + "load this module only on a worker without owner-only mode");
  }
  return {
    url: parseCoordinationUrl(env.PS_COORDINATION_URL),
    scope: parseTokenScope(env.PS_COORDINATION_TOKEN_SCOPE),
  };
}

/**
 * The subject of a session's owner routing tag, `owner.<subject>`: with
 * Microsoft Entra sign-in, the owner's object ID. A missing tag, another
 * prefix or an empty subject is a programming error, and throws.
 */
export function ownerSubjectFromTag(ownerTag) {
  const tag = typeof ownerTag === "string" ? ownerTag : "";
  const subject = tag.startsWith(OWNER_TAG_PREFIX) ? tag.slice(OWNER_TAG_PREFIX.length) : "";
  if (!subject) throw new Error("the session has no owner routing tag of the form owner.<subject>");
  return subject;
}

/**
 * POST a JSON body over HTTPS. Resolves with the HTTP status and the parsed
 * answer (null when it is not JSON); rejects when no answer arrives. Every
 * call checks the server's certificate against Node's trust store, which
 * holds the certificates NODE_EXTRA_CA_CERTS names, even when
 * NODE_TLS_REJECT_UNAUTHORIZED would turn the check off.
 */
export function requestJson(url, { method = "POST", headers = {}, body, timeoutMs = 10_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (target.protocol !== "https:") {
      reject(new Error("the coordination route is reached only over https"));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(target, {
      method,
      agent: false,
      rejectUnauthorized: true,
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) req.destroy(new Error("the answer is too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        const answer = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = answer ? JSON.parse(answer) : null;
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/** The workload identity settings that AKS sets in a pod with the azure.workload.identity/use label. */
function workloadIdentityOptions(env) {
  const missing = WORKLOAD_IDENTITY_SETTINGS.filter((name) => !text(env[name]));
  if (missing.length > 0) {
    throw new Error(`the coordination host signs in with the pod's workload identity, and ${missing.join(", ")} `
      + `${missing.length === 1 ? "is" : "are"} not set: give the pod the azure.workload.identity/use label `
      + "and its service account the identity's client ID");
  }
  return {
    clientId: text(env.AZURE_CLIENT_ID),
    tenantId: text(env.AZURE_TENANT_ID),
    tokenFilePath: text(env.AZURE_FEDERATED_TOKEN_FILE),
    ...(text(env.AZURE_AUTHORITY_HOST) ? { authorityHost: text(env.AZURE_AUTHORITY_HOST) } : {}),
  };
}

/**
 * The token source: a token for `scope` from the pod's workload identity,
 * never from managed identity, whose metadata endpoint the pod cannot reach.
 * The token stays in this process's memory until five minutes before it
 * expires, and is never logged or written. One fetch runs at a time, and it
 * gives up after `fetchTimeoutMs`. `getToken.discard()` drops a token that
 * the controller refused, so that the next request signs in again, with a
 * new credential whose own cache cannot hand the same token back; a token
 * younger than a minute stays.
 */
export function createWorkloadIdentityTokenSource({
  scope,
  env = process.env,
  importIdentity = () => import("@azure/identity"),
  now = () => Date.now(),
  refreshMarginMs = 5 * 60_000,
  fetchTimeoutMs = 30_000,
  minRefetchMs = 60_000,
} = {}) {
  const tokenScope = parseTokenScope(scope);
  const options = workloadIdentityOptions(env);
  let credential = null;
  let cached = null;
  let pending = null;

  async function fetchToken() {
    const made = credential ??= Promise.resolve()
      .then(() => importIdentity())
      .then(({ WorkloadIdentityCredential }) => new WorkloadIdentityCredential(options));
    let signIn;
    try {
      signIn = await made;
    } catch (error) {
      if (credential === made) credential = null;
      throw error;
    }
    const timeout = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`workload identity gave no token within ${fetchTimeoutMs} ms`);
        timeout.abort(error);
        reject(error);
      }, fetchTimeoutMs);
    });
    try {
      const answer = await Promise.race([signIn.getToken(tokenScope, { abortSignal: timeout.signal }), expired]);
      if (typeof answer?.token !== "string" || !answer.token) throw new Error("workload identity returned no token");
      const fetchedAt = now();
      const expiresAt = Number(answer.expiresOnTimestamp);
      const refreshAfter = Number(answer.refreshAfterTimestamp);
      cached = {
        token: answer.token,
        fetchedAt,
        refreshAt: Math.min(
          Number.isFinite(expiresAt) ? expiresAt - refreshMarginMs : fetchedAt,
          Number.isFinite(refreshAfter) && refreshAfter > 0 ? refreshAfter : Infinity,
        ),
      };
      return answer.token;
    } finally {
      clearTimeout(timer);
    }
  }

  const getToken = async () => {
    if (cached && now() < cached.refreshAt) return cached.token;
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  };
  getToken.discard = () => {
    if (!cached || now() - cached.fetchedAt < minRefetchMs) return;
    cached = null;
    credential = null;
  };
  return getToken;
}

function sleep(ms, signal, timers) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      timers.clearTimeout(id);
      reject(abortReason(signal));
    };
    const id = timers.setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** `promise`, or the signal's reason once it fires first. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The controller's decision in a 2xx answer, as the worker's capacity requester returns it; null for anything else. */
function decisionOf(answer) {
  if (!answer || !(answer.status >= 200 && answer.status < 300) || !answer.body || typeof answer.body !== "object") return null;
  const body = answer.body;
  const message = textOf(body.message);
  const code = typeof body.code === "string" && CODE.test(body.code) ? body.code : undefined;
  if (body.decision === "ok") return { decision: "ok" };
  if (body.decision === "deny") return { decision: "deny", ...(message ? { message } : {}), ...(code ? { code } : {}) };
  if (body.decision === "busy") {
    const retryAfterMs = positive(body.retryAfterMs);
    return {
      decision: "busy",
      ...(message ? { message } : {}),
      ...(code ? { code } : {}),
      ...(retryAfterMs ? { retryAfterMs } : {}),
    };
  }
  return null;
}

/**
 * The capacity requester (`worker.setOwnerCapacityRequester`): asks the
 * disk controller's coordination route for capacity for the session's owner,
 * again and again with backoff until it answers or PilotSwarm's 15-second
 * signal fires, and passes its answer on: `ok`; `deny` for a root without a
 * drive lease, which ends the turn; or `busy` with retryAfterMs for a parked
 * or returning one, which holds the session on its timer. A network failure,
 * a 5xx, a 408 or a 429 is retried. Any other 4xx is a refusal of the route
 * itself, such as a token without the coordinator role, which no retry can
 * pass, so it throws at once; PilotSwarm then answers CAPACITY_UNAVAILABLE.
 * An owner whose subject is not an object ID, which the controller refuses,
 * gets `deny` with OWNER_NOT_SUPPORTED at once, without a request.
 */
export function createCoordinationRequester({
  url,
  getToken,
  request = requestJson,
  timers = defaultTimers,
  backoffMs = [250, 500, 1_000, 2_000, 4_000],
  timeoutMs = 10_000,
}) {
  const target = `${parseCoordinationUrl(url)}${DEMAND_ROUTE}`;
  if (typeof getToken !== "function") throw new TypeError("the capacity requester needs getToken()");
  if (typeof request !== "function") throw new TypeError("the capacity requester needs an HTTP client, request(url, options)");
  return async ({ rootSessionId, ownerTag }, signal) => {
    const ownerOid = ownerSubjectFromTag(ownerTag);
    // The controller takes only object IDs: such an owner can never get a worker.
    if (!OBJECT_ID.test(ownerOid)) return { decision: "deny", code: OWNER_NOT_SUPPORTED, message: OWNER_NOT_SUPPORTED_MESSAGE };
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw abortReason(signal);
      let answer = null;
      try {
        const token = await untilAborted(Promise.resolve().then(() => getToken()), signal);
        if (typeof token !== "string" || !token) throw new Error("the token source returned no token");
        answer = await untilAborted(Promise.resolve().then(() => request(target, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: { ownerOid, rootSessionId },
          timeoutMs,
          ...(signal ? { signal } : {}),
        })), signal);
      } catch {
        answer = null;
      }
      const decision = decisionOf(answer);
      if (decision) return decision;
      const status = Number(answer?.status);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        if (status === 401 || status === 403) getToken.discard?.();
        const code = typeof answer.body?.error === "string" && CODE.test(answer.body.error) ? ` ${answer.body.error}` : "";
        throw new Error(`the disk controller refused the capacity request: HTTP ${status}${code}`);
      }
      await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)], signal, timers);
    }
  };
}

/** The worker hook this module sets (PilotSwarm's owner routing hook). */
const REQUIRED_WORKER_METHODS = ["setOwnerCapacityRequester"];

/**
 * Extension entry point (PILOTSWARM_EXTENSION_MODULES). It checks every
 * setting before it sets the hook. `deps` replaces parts in tests:
 * { getToken, importIdentity, request, timers }.
 */
export async function register(worker, context = {}, deps = {}) {
  const env = context.env ?? process.env;
  const log = context.log ?? ((message) => console.log(message));
  const settings = settingsFromEnv(env);
  const missing = REQUIRED_WORKER_METHODS.filter((name) => typeof worker?.[name] !== "function");
  if (missing.length > 0) throw new Error(`the coordination host needs a PilotSwarm worker with ${missing.join(" and ")}`);
  const getToken = deps.getToken ?? createWorkloadIdentityTokenSource({
    scope: settings.scope,
    env,
    ...(deps.importIdentity ? { importIdentity: deps.importIdentity } : {}),
  });
  const requester = createCoordinationRequester({
    url: settings.url,
    getToken,
    ...(deps.request ? { request: deps.request } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  worker.setOwnerCapacityRequester(requester);
  log(`coordination host: capacity requests go to ${settings.url}${DEMAND_ROUTE}`);
  return { settings, requester };
}
