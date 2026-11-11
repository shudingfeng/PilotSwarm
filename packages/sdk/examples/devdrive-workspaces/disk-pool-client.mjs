/**
 * The disk controller's worker routes (README, "The controller API"), over
 * HTTPS with a JSON body.
 *
 * Before every call the client asks the deployment's token module for a
 * token (PS_DISK_CONTROLLER_TOKEN_MODULE exports getToken()), and it builds
 * a new TLS agent that trusts only the CAs in PS_DISK_CONTROLLER_CA_CERT
 * (one, or two while the controller's CA rotates), read again for each
 * agent, so a rotated CA takes effect at the next call without a worker
 * restart. The client holds no credential code of its own,
 * and it never writes a token or a credential it fetched to disk or logs.
 *
 * The deployment's tool modules, which run in the worker process, get a
 * root session's per-work credential through fetchWorkCredential().
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The largest answer a client reads. */
const MAX_ANSWER_BYTES = 1024 * 1024;

export class DiskPoolError extends Error {
    constructor(message, { status, code } = {}) {
        super(message);
        this.name = "DiskPoolError";
        if (status !== undefined) this.status = status;
        if (code !== undefined) this.code = code;
    }
}

/**
 * One request with a JSON body. Resolves with the HTTP status and the parsed
 * answer (null when it is not JSON); rejects only when no answer arrives.
 */
export function requestJson(url, { method = "POST", headers = {}, body, agent, timeoutMs = 30_000, signal } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === "https:" ? https : http;
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = transport.request(target, {
            method,
            ...(agent ? { agent } : {}),
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
                const text = Buffer.concat(chunks).toString("utf8");
                let parsed = null;
                try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
                resolve({ status: res.statusCode ?? 0, body: parsed });
            });
            res.on("error", reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
        req.end(payload);
    });
}

const looksLikePath = (specifier) => path.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)
    || specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith(".\\") || specifier.startsWith("..\\");

/**
 * The deployment's controller token module: a file path or a package name.
 * A path is imported by its file URL, because Node's ESM loader refuses a
 * bare Windows path such as C:\... The module exports getToken(), as a named
 * export, on its default export, or as its default export.
 */
export async function loadTokenModule(specifier, { cwd = process.cwd() } = {}) {
    const target = looksLikePath(specifier) ? pathToFileURL(path.resolve(cwd, specifier)).href : specifier;
    let mod;
    try {
        mod = await import(target);
    } catch (error) {
        throw new Error(`the controller token module ${specifier} failed to load: ${error?.message ?? error}`);
    }
    const getToken = typeof mod?.getToken === "function" ? mod.getToken
        : typeof mod?.default?.getToken === "function" ? mod.default.getToken.bind(mod.default)
        : typeof mod?.default === "function" ? mod.default
        : null;
    if (!getToken) throw new Error(`the controller token module ${specifier} exports no getToken()`);
    return getToken;
}

/** A credential answer as the worker's hooks take it: ok, refused, busy or unavailable. */
function credentialAnswer(answer, valueField) {
    const body = answer.body && typeof answer.body === "object" ? answer.body : {};
    const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : undefined;
    if (answer.status >= 200 && answer.status < 300) {
        if (body.status === "ok" && typeof body[valueField] === "string" && body[valueField]) {
            return { status: "ok", [valueField]: body[valueField] };
        }
        if (body.status === "refused") return { status: "refused", ...(message ? { message } : {}) };
        if (body.status === "busy") {
            const retryAfterMs = Number(body.retryAfterMs);
            return {
                status: "busy",
                ...(message ? { message } : {}),
                ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs: Math.floor(retryAfterMs) } : {}),
            };
        }
    }
    return { status: "unavailable", message: message ?? `the disk controller answered HTTP ${answer.status}` };
}

/**
 * @param {object} options
 * @param {string} options.url                 the controller's worker endpoint, https://host:port
 * @param {() => (string|Promise<string>)} options.getToken   the deployment's token module
 * @param {string|null} [options.caCertPath]   the only CAs the client trusts, as a PEM bundle; unset: Node's default roots
 * @param {number} [options.timeoutMs]         per call
 * @param {Function} [options.request]         requestJson, replaceable in tests
 * @param {Function} [options.readFile]        reads the CA file
 */
export function createDiskPoolClient({ url, getToken, caCertPath = null, timeoutMs = 30_000, request = requestJson, readFile = fs.promises.readFile }) {
    if (!/^https:\/\/[^/]/i.test(String(url ?? ""))) throw new Error("the disk controller URL (PS_DISK_POOL_CONTROLLER_URL) must be an https:// URL");
    if (typeof getToken !== "function") throw new Error("the disk controller client needs getToken()");
    const base = String(url).replace(/\/+$/, "");

    async function newAgent() {
        const ca = caCertPath ? await readFile(caCertPath) : undefined;
        return new https.Agent({ keepAlive: false, ...(ca ? { ca } : {}) });
    }

    /** POST a route; resolves with { status, body }. Throws when no answer arrives. */
    async function post(route, body, { timeoutMs: callTimeoutMs = timeoutMs, signal } = {}) {
        let timer;
        const token = await Promise.race([
            Promise.resolve().then(() => getToken()),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new DiskPoolError(`the controller token module gave no token within ${callTimeoutMs} ms`)), callTimeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
        if (typeof token !== "string" || !token) throw new DiskPoolError("the controller token module returned no token");
        const agent = await newAgent();
        try {
            return await request(`${base}${route}`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
                body,
                agent,
                timeoutMs: callTimeoutMs,
                ...(signal ? { signal } : {}),
            });
        } finally {
            agent.destroy();
        }
    }

    /** POST a route that must answer 2xx; resolves with its body. */
    async function call(route, body, opts) {
        const answer = await post(route, body, opts);
        if (answer.status < 200 || answer.status >= 300) {
            const detail = answer.body && typeof answer.body === "object"
                ? [answer.body.error ?? answer.body.code, answer.body.message].filter(Boolean).join(": ")
                : "";
            throw new DiskPoolError(`${route}: HTTP ${answer.status}${detail ? ` ${detail}` : ""}`, {
                status: answer.status,
                ...(answer.body?.error || answer.body?.code ? { code: answer.body.error ?? answer.body.code } : {}),
            });
        }
        return answer.body ?? {};
    }

    return {
        post,
        heartbeat: (body) => call("/v1/vms/heartbeat", body, { timeoutMs: 10_000 }),
        attach: (body) => call("/v1/leases/attach", body, { timeoutMs: 5 * 60_000 }),
        detach: (body) => call("/v1/leases/detach", body, { timeoutMs: 5 * 60_000 }),
        busy: (body) => call("/v1/vms/busy", body, { timeoutMs: 10_000 }),
        admit: (body) => call("/v1/vms/admit", body, { timeoutMs: 10_000 }),
        demand: (body, opts = {}) => post("/v1/vms/demand", body, { timeoutMs: 10_000, ...opts }),
        async modelCredential(body) {
            try {
                return credentialAnswer(await post("/v1/credentials/model", body, { timeoutMs: 15_000 }), "token");
            } catch (error) {
                return { status: "unavailable", message: `the disk controller did not answer: ${error?.message ?? error}` };
            }
        },
        async workCredential({ rootSessionId }) {
            try {
                return credentialAnswer(await post("/v1/credentials/work", { rootSessionId }, { timeoutMs: 15_000 }), "credential");
            } catch (error) {
                return { status: "unavailable", message: `the disk controller did not answer: ${error?.message ?? error}` };
            }
        },
    };
}

/**
 * The client from the worker's settings: PS_DISK_POOL_CONTROLLER_URL,
 * PS_DISK_CONTROLLER_TOKEN_MODULE (both required) and PS_DISK_CONTROLLER_CA_CERT.
 */
export async function createDiskPoolClientFromEnv(env = process.env, overrides = {}) {
    const url = String(env.PS_DISK_POOL_CONTROLLER_URL ?? "").trim();
    if (!url) throw new Error("PS_DISK_POOL_CONTROLLER_URL is required: the disk controller's worker endpoint");
    const tokenModule = String(env.PS_DISK_CONTROLLER_TOKEN_MODULE ?? "").trim();
    if (!tokenModule) throw new Error("PS_DISK_CONTROLLER_TOKEN_MODULE is required: the module whose getToken() returns the controller token");
    const getToken = await loadTokenModule(tokenModule);
    return createDiskPoolClient({
        url,
        getToken,
        caCertPath: String(env.PS_DISK_CONTROLLER_CA_CERT ?? "").trim() || null,
        ...overrides,
    });
}

let sharedClient = null;

/** The client register() built: the deployment's tool modules in the same process use it. */
export function useDiskPoolClient(client) {
    sharedClient = client ? Promise.resolve(client) : null;
}

/**
 * A root session's per-work credential, for the deployment's tool modules in
 * the worker process: { status: "ok", credential }, or refused, busy (with
 * retryAfterMs) or unavailable. The credential stays in the caller's memory.
 * Without the extension's client, one is built from the settings.
 */
export async function fetchWorkCredential(rootSessionId, { env = process.env } = {}) {
    sharedClient ??= createDiskPoolClientFromEnv(env);
    let client;
    try {
        client = await sharedClient;
    } catch (error) {
        sharedClient = null;
        return { status: "unavailable", message: error?.message ?? String(error) };
    }
    return client.workCredential({ rootSessionId });
}
