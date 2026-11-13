// The controller's HTTP layer: one route table per listener, token checks,
// JSON bodies and answers. `handle` takes a plain request description, so
// tests drive the whole path, token and source-IP checks included, without
// opening a socket; `nodeHandler` adapts it to node:http and node:https.
import { bearerToken, refusal } from "./auth.mjs";

export const BODY_LIMIT_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function json(status, body, headers = {}) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: body === null ? "" : JSON.stringify(body),
  };
}

function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  for (const route of routes) {
    const params = typeof route.path === "string"
      ? (route.path === pathname ? {} : null)
      : route.path.exec(pathname)?.groups ?? null;
    if (!params) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: { ...params } };
  }
  return pathMatched ? { status: 405 } : { status: 404 };
}

/**
 * `routes`: [{ method, path (string or RegExp with named groups), auth
 * ("none" | "worker" | "dispatcher" | "admin" | "coordinator"), vm (true to
 * resolve the calling VM from the source IP), handler }]. A handler gets
 * { body, params, caller, vm, remoteAddress } and returns { status?, body }.
 */
export function createApp({ name, routes, verifyToken, tokens, resolveVm, log }) {
  async function handle({ method, url, headers = {}, remoteAddress, body: text = "" }) {
    let pathname;
    try {
      pathname = new URL(url, "https://controller.invalid").pathname;
    } catch {
      return json(400, { error: "BAD_REQUEST", message: "The request URL is not valid." });
    }
    const matched = matchRoute(routes, method, pathname);
    if (!matched.route) {
      return json(matched.status, { error: matched.status === 405 ? "METHOD_NOT_ALLOWED" : "NOT_FOUND", message: "No such route on this port." });
    }
    const { route, params } = matched;
    try {
      let caller = null;
      if (route.auth !== "none") {
        const token = bearerToken(headers.authorization);
        if (!token) {
          return json(401, { error: "UNAUTHENTICATED", message: "A bearer token is required." }, { "www-authenticate": "Bearer" });
        }
        try {
          caller = await verifyToken(token);
        } catch (err) {
          log?.warn("auth.rejected", { listener: name, route: pathname, reason: err?.message ?? String(err) });
          return json(401, { error: "UNAUTHENTICATED", message: "The bearer token is not valid." }, { "www-authenticate": "Bearer" });
        }
        const reason = refusal(route.auth, caller, tokens);
        if (reason) {
          log?.audit("auth.forbidden", { listener: name, route: pathname, caller: caller.oid, reason });
          return json(403, { error: "FORBIDDEN", message: "This caller may not use this route." });
        }
      }
      let vm = null;
      if (route.vm) {
        vm = await resolveVm(remoteAddress);
        if (!vm) {
          log?.audit("auth.unknown-source", { listener: name, route: pathname, caller: caller?.oid, source: remoteAddress ?? null });
          return json(403, { error: "UNKNOWN_SOURCE", message: "The request does not come from a worker VM of this pool." });
        }
      }
      let body = {};
      if (method === "POST" && String(text).trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: "BAD_REQUEST", message: "The body is not JSON." });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json(400, { error: "BAD_REQUEST", message: "The body must be a JSON object." });
        }
      }
      const result = await route.handler({ body, params, caller, vm, remoteAddress });
      return json(result?.status ?? 200, result?.body === undefined ? null : result.body);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message, ...err.extra });
      log?.error("request.failed", { listener: name, route: pathname, error: err?.message ?? String(err) });
      return json(500, { error: "INTERNAL", message: "The controller could not complete the request." });
    }
  }

  async function nodeHandler(req, res) {
    try {
      const chunks = [];
      let size = 0;
      // A body over the limit is read to its end, bounded by the server's
      // request timeout, and dropped, so the caller still gets the answer.
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= BODY_LIMIT_BYTES) chunks.push(chunk);
      }
      const answer = size > BODY_LIMIT_BYTES
        ? json(413, { error: "TOO_LARGE", message: "The request body is too large." })
        : await handle({
          method: req.method,
          url: req.url,
          headers: req.headers,
          remoteAddress: req.socket?.remoteAddress,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      res.writeHead(answer.status, answer.body ? answer.headers : { "cache-control": "no-store" });
      res.end(answer.body);
    } catch (err) {
      // The caller went away mid-request; nothing to answer.
      log?.warn("request.aborted", { listener: name, error: err?.message ?? String(err) });
      res.destroy();
    }
  }

  return { name, handle, nodeHandler };
}
