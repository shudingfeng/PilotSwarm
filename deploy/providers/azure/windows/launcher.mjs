/**
 * The Windows worker service's entry point. WinSW runs it as the service
 * PilotSwarmWorker, under the virtual account NT SERVICE\PilotSwarmWorker:
 *
 *   "C:\Program Files\nodejs\node.exe" C:\pilotswarm\launcher.mjs
 *
 * On every service start it:
 *
 *   1. refuses any Node.js but the image's (EXPECTED_NODE_VERSION);
 *   2. loads C:\pilotswarm\worker.env and overlays the deployment's values from
 *      the scale set's userData (IMDS), failing closed when one is missing or
 *      invalid (README, "userData");
 *   3. checks that IMDS issues tokens to the expected identity
 *      (EXPECTED_WIN_WORKER_OID);
 *   4. creates this start's launch ID (PS_LAUNCH_ID) and starts the VM's
 *      15-second heartbeat to the disk controller with phase "starting",
 *      trusting only the controller's CAs from userData, before anything slow;
 *   5. frees LUN 0 when a heartbeat answer names a drive on this VM (the
 *      attacher's /offline-lun0, then /v1/leases/detach with crashed: true),
 *      retrying with backoff, before any step that can fail;
 *   6. clears C:\pilotswarm\temp, then asks the attacher to sync the release
 *      (/sync-release), and fails closed when it cannot;
 *   7. waits until /v1/vms/register reports the VM active, and with
 *      PILOTSWARM_WORKER_OWNER_ONLY=1 until a heartbeat answer names the VM's
 *      owner;
 *   8. signs the Azure CLI in as the worker identity in the background;
 *   9. hands the heartbeat over to the Dev Drive extension and imports the
 *      release's worker.js in this process.
 *
 * Imports only Node.js built-in modules.
 */
import { spawn } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The Node.js the image installs, the version deploy/Dockerfile.worker pins. */
export const EXPECTED_NODE_VERSION = "24.22.1";
export const DEFAULT_ROOT = "C:\\pilotswarm";
export const USER_DATA_VERSION = 1;
/** The Dev Drive extension takes the heartbeat over through this slot (heartbeat.mjs). */
export const HEARTBEAT_HANDOVER = Symbol.for("pilotswarm.devdrive.heartbeat-handover");
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_ATTACHER_URL = "http://127.0.0.1:3099";
/** The worker inside a release folder. */
export const WORKER_ENTRY = ["packages", "sdk", "examples", "worker.js"];
export const IMDS_BASE = "http://169.254.169.254/metadata";

/** The deployment's values that come only from userData. Every one is required. */
export const USER_DATA_SETTINGS = Object.freeze([
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

/** Set by the launcher itself, never by worker.env or userData. */
export const LAUNCHER_SETTINGS = Object.freeze(["PILOTSWARM_WORKER_OWNER_TAG", "PS_LAUNCH_ID"]);

/** Names an extra userData pair may not set: they change how processes start, or carry credentials. */
export const PROTECTED_EXTRA_NAMES = Object.freeze([
    "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA",
    "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH", "GITHUB_TOKEN", "GH_TOKEN",
]);
/**
 * Prefixes an extra userData pair may not use: the platform's own namespaces,
 * whose values belong in worker.env or the userData table, and the tools'
 * settings that would change every session's Git, Azure CLI, NuGet or
 * credential flow (GIT_CONFIG_PARAMETERS injects Git configuration,
 * AZURE_EXTENSION_* turns dynamic CLI extensions back on).
 */
export const PROTECTED_EXTRA_PREFIXES = Object.freeze([
    "NODE_", "COPILOT_", "PILOTSWARM_", "PS_", "WIN_WORKER_", "AZURE_", "GIT_", "NUGET_", "GCM_", "ARTIFACTS_CREDENTIALPROVIDER_",
]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ANSWER_BYTES = 1024 * 1024;

/** A refusal to start: the message says what is wrong; the service exits with code 1. */
export class LaunchError extends Error {
    constructor(message) {
        super(message);
        this.name = "LaunchError";
    }
}

export const isGuid = (value) => typeof value === "string" && GUID.test(value);
const lower = (value) => String(value).toLowerCase();
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Refuses any Node.js but the image's own. */
export function checkNodeVersion(actual = process.versions.node, expected = EXPECTED_NODE_VERSION) {
    if (actual !== expected) {
        throw new LaunchError(`the worker runs only on the image's Node.js ${expected}; this service started Node.js ${actual}`);
    }
}

/**
 * worker.env: NAME=VALUE lines. Blank lines and lines starting with # are
 * skipped, the value is everything after the first `=`, taken literally (no
 * quotes, no expansion). A name listed twice is refused.
 * @returns {Array<{ name: string, value: string }>}
 */
export function parseEnvFile(text, source = "worker.env") {
    const entries = [];
    const seen = new Set();
    const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
        const line = raw.trimStart();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) throw new LaunchError(`${source}, line ${index + 1}: expected NAME=VALUE`);
        const name = line.slice(0, eq).trim();
        if (!ENV_NAME.test(name)) throw new LaunchError(`${source}, line ${index + 1}: "${name}" is not a valid setting name`);
        if (seen.has(lower(name))) throw new LaunchError(`${source} sets ${name} twice`);
        seen.add(lower(name));
        entries.push({ name, value: line.slice(eq + 1) });
    }
    return entries;
}

function urlWithoutSecrets(name, value, protocols) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new LaunchError(`userData: ${name} is not a URL`);
    }
    if (!protocols.includes(url.protocol)) throw new LaunchError(`userData: ${name} must be a ${protocols.join(" or ")} URL`);
    // Any process on the VM can read userData, so it never carries a secret.
    if (url.password) throw new LaunchError(`userData: ${name} carries a password; userData must hold no secret`);
    return url;
}

/** Each userData value's own check. */
function checkUserDataValue(name, value) {
    switch (name) {
        case "DATABASE_URL":
        case "PILOTSWARM_CMS_FACTS_DATABASE_URL":
            urlWithoutSecrets(name, value, ["postgres:", "postgresql:"]);
            return;
        case "AZURE_STORAGE_ACCOUNT_URL":
        case "PS_DISK_POOL_CONTROLLER_URL": {
            const url = urlWithoutSecrets(name, value, ["https:"]);
            if (url.username || url.search || url.hash) throw new LaunchError(`userData: ${name} must be a plain https:// URL, without a user, query or fragment`);
            return;
        }
        case "AZURE_CLIENT_ID":
        case "EXPECTED_WIN_WORKER_OID":
            if (!isGuid(value)) throw new LaunchError(`userData: ${name} must be a GUID`);
            return;
        case "PS_DISK_CONTROLLER_TOKEN_SCOPE":
            if (/\s/.test(value)) throw new LaunchError(`userData: ${name} must be a scope such as api://<app>/.default`);
            return;
        case "ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS": {
            let parsed;
            try {
                parsed = JSON.parse(value);
            } catch {
                throw new LaunchError(`userData: ${name} is not JSON`);
            }
            if (!isPlainObject(parsed) || !Array.isArray(parsed.endpointCredentials)) {
                throw new LaunchError(`userData: ${name} must be {"endpointCredentials":[...]} (an empty list when the deployment has no feed)`);
            }
            for (const entry of parsed.endpointCredentials) {
                if (!isPlainObject(entry) || typeof entry.endpoint !== "string") throw new LaunchError(`userData: every ${name} entry needs an endpoint`);
                if ("password" in entry) throw new LaunchError(`userData: ${name} carries a password; use a managed identity (azureClientId) instead`);
            }
            return;
        }
        case "WIN_WORKER_CONFIG_VERSION":
            if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new LaunchError(`userData: ${name} must be 1 to 128 letters, digits and . _ : -`);
            return;
        case "PILOTSWARM_WORKER_OWNER_ONLY":
            if (value !== "0" && value !== "1") throw new LaunchError(`userData: ${name} must be exactly "0" or "1"`);
            return;
        default:
            if (value.length > 4096) throw new LaunchError(`userData: ${name} is too long`);
    }
}

/** True when an extra pair may not use this name. */
export function isProtectedExtraName(name) {
    const upper = String(name).toUpperCase();
    return PROTECTED_EXTRA_NAMES.includes(upper)
        || PROTECTED_EXTRA_PREFIXES.some((prefix) => upper.startsWith(prefix))
        || USER_DATA_SETTINGS.includes(upper)
        || LAUNCHER_SETTINGS.includes(upper);
}

/** One PEM certificate exactly: base64 lines between its two markers. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----/g;

/**
 * The controller's trusted CAs, as PEM: one CA certificate, or two while a CA
 * rotation trusts the old and the new one, with nothing but whitespace around
 * them. Every certificate is checked, not only the first.
 */
function checkCaCertificates(pem) {
    if (typeof pem !== "string" || !pem.includes("-----BEGIN CERTIFICATE-----")) {
        throw new LaunchError("userData: controllerCaCert must hold the disk controller's CA certificates as PEM");
    }
    if (/\S/.test(pem.replace(PEM_CERTIFICATE, ""))) throw new LaunchError("userData: controllerCaCert holds something other than PEM certificates");
    const blocks = [...pem.matchAll(PEM_CERTIFICATE)];
    if (blocks.length > 2) {
        throw new LaunchError(`userData: controllerCaCert holds ${blocks.length} certificates; it takes one, or two during a CA rotation`);
    }
    for (const [index, [, body]] of blocks.entries()) {
        const der = Buffer.from(body.replace(/\s/g, ""), "base64");
        let certificate;
        try {
            certificate = new X509Certificate(der);
        } catch (error) {
            throw new LaunchError(`userData: controllerCaCert certificate ${index + 1} is not a certificate: ${error?.message ?? error}`);
        }
        // A certificate parses from the front of its bytes; anything after it is junk.
        if (!certificate.raw.equals(der)) throw new LaunchError(`userData: controllerCaCert certificate ${index + 1} is not a certificate: it has bytes after its end`);
        if (!certificate.ca) throw new LaunchError(`userData: controllerCaCert certificate ${index + 1} is not a CA certificate`);
    }
}

/**
 * The scale set's userData, as IMDS returns it (base64), decoded and checked.
 * Version 1 is a UTF-8 JSON object:
 *
 *   { "version": 1,
 *     "env": { <every USER_DATA_SETTINGS name>: "<value>" },
 *     "extraEnv": { "<NAME>": "<value>" },          optional
 *     "controllerCaCert": "<PEM: one CA, or two>" }
 *
 * Anything missing, unknown or invalid is refused. controllerCaCert is
 * returned whole: TLS to the controller trusts each of its CAs.
 * @returns {{ env: Record<string,string>, extraEnv: Record<string,string>, controllerCaCert: string }}
 */
export function decodeUserData(text) {
    const raw = String(text ?? "").trim();
    if (!raw) throw new LaunchError("the scale set's userData is empty: the deployment's settings are missing");
    if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new LaunchError("the scale set's userData is not base64");
    let data;
    try {
        data = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
        throw new LaunchError("the scale set's userData is not a JSON document");
    }
    if (!isPlainObject(data)) throw new LaunchError("the scale set's userData must be a JSON object");
    if (data.version !== USER_DATA_VERSION) throw new LaunchError(`userData version ${JSON.stringify(data.version)} is not supported; this launcher reads version ${USER_DATA_VERSION}`);
    const unknown = Object.keys(data).filter((key) => !["version", "env", "extraEnv", "controllerCaCert"].includes(key));
    if (unknown.length) throw new LaunchError(`userData has unknown fields: ${unknown.join(", ")}`);
    if (!isPlainObject(data.env)) throw new LaunchError("userData.env must be an object");

    const env = {};
    for (const [name, value] of Object.entries(data.env)) {
        const known = USER_DATA_SETTINGS.find((setting) => setting === name);
        if (!known) throw new LaunchError(`userData.env sets ${name}, which is not a userData setting; deployment values go in extraEnv`);
        if (typeof value !== "string") throw new LaunchError(`userData: ${name} must be a string`);
        env[known] = value;
    }
    const missing = USER_DATA_SETTINGS.filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
    if (missing.length) throw new LaunchError(`userData is missing ${missing.join(", ")}; the worker does not start with the image's defaults`);
    for (const [name, value] of Object.entries(env)) checkUserDataValue(name, value);

    const extraEnv = {};
    if (data.extraEnv !== undefined) {
        if (!isPlainObject(data.extraEnv)) throw new LaunchError("userData.extraEnv must be an object");
        const seen = new Set();
        for (const [name, value] of Object.entries(data.extraEnv)) {
            if (!ENV_NAME.test(name)) throw new LaunchError(`userData.extraEnv: "${name}" is not a valid setting name`);
            if (seen.has(lower(name))) throw new LaunchError(`userData.extraEnv sets ${name} twice`);
            seen.add(lower(name));
            if (isProtectedExtraName(name)) throw new LaunchError(`userData.extraEnv may not set ${name}`);
            if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
                throw new LaunchError(`userData.extraEnv: ${name} must be a string of at most 4096 characters`);
            }
            extraEnv[name] = value;
        }
    }
    checkCaCertificates(data.controllerCaCert);
    return { env, extraEnv, controllerCaCert: data.controllerCaCert };
}

/**
 * The worker's environment: the service's own, then worker.env, then the
 * userData values, then the extra pairs, which may not change a name that
 * worker.env or userData sets. Names are compared without case, as Windows
 * does.
 * @returns {Record<string, string>} the names and values to set
 */
export function buildWorkerEnv({ workerEnv, userData }) {
    const values = new Map();
    const set = (name, value) => values.set(lower(name), { name, value });
    for (const { name, value } of workerEnv) {
        if (USER_DATA_SETTINGS.includes(name.toUpperCase())) throw new LaunchError(`worker.env sets ${name}, which only userData may set`);
        if (LAUNCHER_SETTINGS.includes(name.toUpperCase())) throw new LaunchError(`worker.env sets ${name}, which only the launcher sets`);
        set(name, value);
    }
    for (const [name, value] of Object.entries(userData.env)) set(name, value);
    for (const [name, value] of Object.entries(userData.extraEnv)) {
        if (values.has(lower(name))) throw new LaunchError(`userData.extraEnv sets ${name}, which worker.env already sets`);
        set(name, value);
    }
    return Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]));
}

/** Sets `values` in `target`, replacing a name that differs only in case; removes `remove`. */
export function applyEnv(target, values, remove = []) {
    const drop = new Set([...Object.keys(values), ...remove].map(lower));
    for (const key of Object.keys(target)) if (drop.has(lower(key))) delete target[key];
    for (const [name, value] of Object.entries(values)) target[name] = value;
    return target;
}

/**
 * Every path value under `currentDir` (C:\pilotswarm\current) is rewritten to
 * the release folder it names now, so a running worker never sees another
 * release. Lists separated by , or ; are handled entry by entry.
 */
export function pinReleasePaths(values, currentDir, releaseDir) {
    const prefix = currentDir.replace(/[\\/]+$/, "");
    const lowerPrefix = lower(prefix);
    const pin = (entry) => {
        const lowered = lower(entry);
        if (lowered === lowerPrefix || lowered.startsWith(`${lowerPrefix}\\`) || lowered.startsWith(`${lowerPrefix}/`)) {
            return releaseDir + entry.slice(prefix.length);
        }
        return entry;
    };
    const out = {};
    for (const [name, value] of Object.entries(values)) {
        out[name] = typeof value === "string" ? value.split(/([,;])/).map((part) => (part === "," || part === ";" ? part : pin(part))).join("") : value;
    }
    return out;
}

/** The `oid` claim of a token from IMDS. IMDS answers on a link-local address, so the token is not verified here. */
export function tokenObjectId(token) {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) throw new LaunchError("IMDS returned a token that is not a JWT");
    let payload;
    try {
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        throw new LaunchError("IMDS returned a token whose claims cannot be read");
    }
    return typeof payload?.oid === "string" ? payload.oid.toLowerCase() : null;
}

/** One request to IMDS. Resolves with the status and body text; rejects when no answer arrives. */
export function imdsRequest(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers: { Metadata: "true" }, agent: false }, (res) => {
            const chunks = [];
            let size = 0;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_ANSWER_BYTES) req.destroy(new Error("the IMDS answer is too large"));
                else chunks.push(chunk);
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`IMDS gave no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
    });
}

/** IMDS: the scale set's userData and tokens for the VM's identity. */
export function createImdsClient({ request = imdsRequest } = {}) {
    return {
        async userData() {
            const answer = await request(`${IMDS_BASE}/instance/compute/userData?api-version=2021-01-01&format=text`);
            if (answer.status !== 200) throw Object.assign(new Error(`IMDS answered HTTP ${answer.status} for userData`), { status: answer.status });
            return answer.text;
        },
        async token({ resource, clientId }) {
            const url = `${IMDS_BASE}/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}&client_id=${encodeURIComponent(clientId)}`;
            const answer = await request(url);
            if (answer.status !== 200) throw Object.assign(new Error(`IMDS answered HTTP ${answer.status} for a token`), { status: answer.status });
            let body;
            try {
                body = JSON.parse(answer.text);
            } catch {
                throw new Error("IMDS answered a token request with something other than JSON");
            }
            if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("IMDS answered without a token");
            const expiresOn = Number(body.expires_on) * 1000;
            return { token: body.access_token, expiresAt: Number.isFinite(expiresOn) && expiresOn > 0 ? expiresOn : Date.now() + 5 * 60_000 };
        },
    };
}

/** Retries a call while IMDS is not ready yet: no answer, 404, 410, 429 or 5xx. */
export async function retryImds(call, { attempts = 8, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await call();
        } catch (error) {
            lastError = error;
            const status = error?.status;
            if (status !== undefined && ![404, 410, 429].includes(status) && !(status >= 500)) throw error;
        }
        if (attempt < attempts) await wait(Math.min(10_000, 1_000 * 2 ** (attempt - 1)));
    }
    throw lastError;
}

/** Controller tokens from IMDS, kept in memory until five minutes before they expire. */
export function createTokenSource({ imds, scope, clientId, now = Date.now }) {
    const resource = String(scope).trim().replace(/\/\.default$/i, "");
    let cached = null;
    let pending = null;
    return {
        async getToken() {
            if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token;
            pending ??= retryImds(() => imds.token({ resource, clientId }), { attempts: 3 })
                .then((entry) => {
                    cached = entry;
                    return entry.token;
                })
                .finally(() => {
                    pending = null;
                });
            return pending;
        },
    };
}

/**
 * One request with a JSON body. Resolves with the HTTP status and the parsed
 * answer (null when it is not JSON); rejects only when no answer arrives.
 * `ca` replaces Node's default roots for an https:// URL.
 */
export function requestJson(url, { method = "POST", headers = {}, body, ca, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === "https:" ? https : http;
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = transport.request(target, {
            method,
            agent: false,
            ...(ca ? { ca } : {}),
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
                let parsed = null;
                try {
                    const text = Buffer.concat(chunks).toString("utf8");
                    parsed = text ? JSON.parse(text) : null;
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

function httpFailure(route, answer) {
    const body = isPlainObject(answer.body) ? answer.body : {};
    const detail = [body.error ?? body.code, body.message].filter((part) => typeof part === "string" && part).join(": ");
    return Object.assign(new Error(`${route}: HTTP ${answer.status}${detail ? ` ${detail}` : ""}`), { status: answer.status, body });
}

/** The disk controller's worker routes the launcher uses, over HTTPS that trusts only `ca`. */
export function createControllerClient({ url, ca, getToken, request = requestJson }) {
    if (!/^https:\/\/[^/]/i.test(String(url ?? ""))) throw new LaunchError("PS_DISK_POOL_CONTROLLER_URL must be an https:// URL");
    const base = String(url).replace(/\/+$/, "");
    async function post(route, body, timeoutMs) {
        const token = await getToken();
        const answer = await request(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, ca, timeoutMs });
        if (answer.status < 200 || answer.status >= 300) throw httpFailure(route, answer);
        return isPlainObject(answer.body) ? answer.body : {};
    }
    return {
        register: () => post("/v1/vms/register", {}, 30_000),
        heartbeat: (body) => post("/v1/vms/heartbeat", body, 10_000),
        detach: (body) => post("/v1/leases/detach", body, 5 * 60_000),
    };
}

/** True for http:// on 127.0.0.1: the attacher's token never leaves the VM. */
export function isAttacherUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === "http:" && url.hostname === "127.0.0.1" && (url.pathname === "/" || url.pathname === "");
    } catch {
        return false;
    }
}

/** The attacher's routes the launcher uses. A 401 reads the token file again and retries once. */
export function createAttacherClient({ url, tokenFile, readFile = fs.promises.readFile, request = requestJson }) {
    if (!isAttacherUrl(url)) throw new LaunchError(`PS_DISK_ATTACHER_URL must be http://127.0.0.1:<port>, not ${url}`);
    const base = String(url).replace(/\/+$/, "");
    let token = null;
    const readToken = async () => {
        token = String(await readFile(tokenFile, "utf8")).trim();
        return token;
    };
    async function call(route, body, timeoutMs) {
        if (token === null) await readToken();
        const send = () => request(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, timeoutMs });
        let answer = await send();
        if (answer.status === 401) {
            // The attacher writes a new token at every start.
            await readToken();
            answer = await send();
        }
        return answer;
    }
    return {
        async offlineLun0({ diskName, workerPid }) {
            const answer = await call("/offline-lun0", { diskName, workerPid }, 5 * 60_000);
            if (answer.status >= 200 && answer.status < 300 && answer.body?.ok === true) return answer.body;
            throw httpFailure("/offline-lun0", answer);
        },
        /** { status, body } of /sync-release; the caller decides what to retry. */
        syncRelease: () => call("/sync-release", {}, 60 * 60_000),
    };
}

/**
 * The VM's heartbeat while no worker runs: `phase: "starting"`, this start's
 * launch ID, the configuration version and no drive. The Dev Drive extension
 * takes it over by calling `handover.stop()`.
 */
export function createLauncherHeartbeat({
    controller, launchId, configVersion, vmName = os.hostname(), intervalMs = HEARTBEAT_INTERVAL_MS,
    onAnswer = () => {}, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now,
}) {
    let running = false;
    let timer = null;
    let inFlight = null;
    let failures = 0;
    let sent = 0;

    async function beat() {
        const sequence = ++sent;
        const body = { vmName, launchId, phase: "starting", attachedDisk: null, activeWorkloadCount: 0, draining: false, configVersion };
        let answer;
        try {
            answer = await controller.heartbeat(body);
        } catch (error) {
            failures += 1;
            if (failures === 1 || failures % 20 === 0) log(`launcher: heartbeat failed (${failures} in a row): ${error?.message ?? error}`);
            return null;
        }
        if (failures > 0) log(`launcher: heartbeat answered again after ${failures} failure(s)`);
        failures = 0;
        try {
            onAnswer(answer, sequence);
        } catch (error) {
            log(`launcher: acting on a heartbeat answer failed: ${error?.message ?? error}`);
        }
        return answer;
    }

    function schedule(startedAt) {
        if (!running) return;
        timer = timers.setTimeout(tick, Math.max(0, startedAt + intervalMs - now()));
    }

    function tick() {
        timer = null;
        if (!running) return;
        const startedAt = now();
        inFlight = beat().finally(() => {
            inFlight = null;
            schedule(startedAt);
        });
    }

    async function stop() {
        running = false;
        if (timer) timers.clearTimeout(timer);
        timer = null;
        await Promise.resolve(inFlight).catch(() => {});
    }

    return {
        /** Sends the first heartbeat now and one every interval; does not wait for the answer. */
        start() {
            if (running) return;
            running = true;
            tick();
        },
        stop,
        /** What the launcher puts in the hand-over slot for the extension. */
        handover: Object.freeze({ stop }),
        get running() {
            return running;
        },
        /** The number of heartbeats sent so far. */
        get sent() {
            return sent;
        },
    };
}

/**
 * Frees LUN 0 before the worker runs: a drive that a heartbeat answer names
 * as attached to this VM is taken offline (/offline-lun0) and detached with
 * `crashed: true`, retried with backoff until the controller confirms. No
 * session can hold it yet, so this never cuts off a session's work. An answer
 * to a heartbeat sent before a drive was freed does not start another cleanup.
 */
export function createLun0Freer({
    attacher, controller, pid = process.pid, currentSequence, log = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), initialDelayMs = 1_000, maxDelayMs = 60_000,
}) {
    const pending = new Map();
    const freedAt = new Map();
    let answered = false;
    let stopped = false;
    let waiters = [];
    const notify = () => {
        const list = waiters;
        waiters = [];
        for (const resolve of list) resolve();
    };

    async function free({ diskName, rootSessionId }) {
        const requestId = randomUUID();
        let delay = initialDelayMs;
        for (let attempt = 1; !stopped; attempt++) {
            try {
                await attacher.offlineLun0({ diskName, workerPid: pid });
                await controller.detach({
                    diskName, ...(typeof rootSessionId === "string" && rootSessionId ? { rootSessionId } : {}), requestId, crashed: true,
                });
                log(`launcher: freed LUN 0: ${diskName} is offline and detached`);
                freedAt.set(diskName, currentSequence());
                return;
            } catch (error) {
                log(`launcher: freeing ${diskName} failed (attempt ${attempt}), retrying in ${Math.round(delay / 1000)} s: ${error?.message ?? error}`);
            }
            await sleep(delay);
            delay = Math.min(maxDelayMs, delay * 2);
        }
    }

    return {
        onAnswer(answer, sequence) {
            answered = true;
            const attached = answer?.attached;
            const diskName = typeof attached?.diskName === "string" ? attached.diskName : null;
            if (!stopped && diskName && !pending.has(diskName) && !(sequence <= (freedAt.get(diskName) ?? 0))) {
                log(`launcher: the disk controller records ${diskName} on this VM; freeing LUN 0 before the worker starts`);
                const job = free(attached).finally(() => {
                    pending.delete(diskName);
                    notify();
                });
                pending.set(diskName, job);
            }
            notify();
        },
        /** Resolves once a heartbeat answer arrived and no cleanup is running, or once stopped. */
        async settled() {
            while (!stopped && (!answered || pending.size > 0)) await new Promise((resolve) => waiters.push(resolve));
        },
        stop() {
            stopped = true;
            notify();
        },
        get busy() {
            return pending.size > 0;
        },
    };
}

/** Resolves with the owner the first heartbeat answer names, unless the VM is frozen or draining. */
export function createOwnerWatch() {
    let resolveOwner;
    const owner = new Promise((resolve) => {
        resolveOwner = resolve;
    });
    let found = null;
    return {
        onAnswer(answer) {
            if (found || answer?.frozen === true || answer?.draining === true) return;
            if (isGuid(answer?.ownerOid)) {
                found = answer.ownerOid.toLowerCase();
                resolveOwner(found);
            }
        },
        waitForOwner: () => owner,
    };
}

async function removeTree(target, fsp) {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
        // A link or a junction goes, never what it points to.
        try {
            await fsp.unlink(target);
        } catch {
            await fsp.rmdir(target);
        }
        return;
    }
    if (stat.isDirectory()) {
        for (const name of await fsp.readdir(target)) await removeTree(path.join(target, name), fsp);
        await fsp.rmdir(target);
        return;
    }
    try {
        await fsp.unlink(target);
    } catch (error) {
        if (error?.code !== "EPERM") throw error;
        await fsp.chmod(target, 0o666);
        await fsp.unlink(target);
    }
}

/**
 * Removes everything inside `dir`, never `dir` itself (it carries the
 * service's grant) and never through a link. Returns what could not be removed.
 */
export async function clearFolderContents(dir, { fsp = fs.promises } = {}) {
    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (error) {
        if (error?.code === "ENOENT") return { removed: 0, failed: [] };
        throw error;
    }
    let removed = 0;
    const failed = [];
    for (const name of names) {
        try {
            await removeTree(path.join(dir, name), fsp);
            removed += 1;
        } catch (error) {
            failed.push(`${name}: ${error?.code ?? error?.message ?? error}`);
        }
    }
    return { removed, failed };
}

/**
 * Signs the Azure CLI in as the worker identity:
 * `az login --identity --client-id <AZURE_CLIENT_ID>` with AZURE_CONFIG_DIR
 * set. Node cannot start az.cmd without a shell, so it runs through
 * `cmd.exe /d /s /c` after the client ID is checked to be a GUID. A failure
 * never stops the worker: it is logged and tried again 30 seconds later, then
 * every 5 minutes, until it succeeds.
 */
export function createAzSignIn({
    clientId, configDir, env = process.env, systemRoot = env.SystemRoot || "C:\\Windows", spawnProcess = spawn,
    log = () => {}, timers = { setTimeout, clearTimeout }, retryDelaysMs = [30_000, 300_000], attemptTimeoutMs = 120_000,
}) {
    if (!isGuid(clientId)) throw new LaunchError("AZURE_CLIENT_ID is not a GUID; it is never passed to cmd.exe");
    const cmd = path.win32.join(systemRoot, "System32", "cmd.exe");
    const line = `az login --identity --client-id ${clientId.toLowerCase()} --allow-no-subscriptions --output none`;
    let timer = null;
    let stopped = false;
    let failures = 0;
    let succeeded = false;

    function attempt() {
        return new Promise((resolve) => {
            let child;
            try {
                child = spawnProcess(cmd, ["/d", "/s", "/c", `"${line}"`], {
                    windowsVerbatimArguments: true,
                    windowsHide: true,
                    env: { ...env, AZURE_CONFIG_DIR: configDir },
                    stdio: ["ignore", "ignore", "pipe"],
                });
            } catch (error) {
                resolve({ ok: false, message: String(error?.message ?? error) });
                return;
            }
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
                if (stderr.length < 4096) stderr += chunk;
            });
            const kill = timers.setTimeout(() => child.kill(), attemptTimeoutMs);
            child.on("error", (error) => {
                timers.clearTimeout(kill);
                resolve({ ok: false, message: String(error?.message ?? error) });
            });
            child.on("close", (code) => {
                timers.clearTimeout(kill);
                resolve(code === 0 ? { ok: true } : { ok: false, message: `exit ${code}: ${stderr.trim().split(/\r?\n/).slice(-2).join(" ")}` });
            });
        });
    }

    async function run() {
        timer = null;
        if (stopped) return;
        const result = await attempt();
        if (result.ok) {
            succeeded = true;
            log(`launcher: the Azure CLI is signed in as the worker identity${failures ? ` after ${failures} failure(s)` : ""}`);
            return;
        }
        failures += 1;
        const delay = retryDelaysMs[Math.min(failures - 1, retryDelaysMs.length - 1)];
        log(`launcher: the Azure CLI sign-in failed (${result.message}); az in agent shells fails until it succeeds; next try in ${Math.round(delay / 1000)} s`);
        if (!stopped) timer = timers.setTimeout(() => void run(), delay);
    }

    return {
        /** Starts the first attempt; never waits for it. */
        start() {
            void run();
        },
        stop() {
            stopped = true;
            if (timer) timers.clearTimeout(timer);
        },
        get succeeded() {
            return succeeded;
        },
        get failures() {
            return failures;
        },
    };
}

/**
 * /sync-release until it succeeds. A missing token file, no answer or a
 * retryable error is tried again with backoff; anything else, or running out
 * of time, fails closed. Resolves with null when `isStopping()` turns true.
 */
export async function syncReleaseWithRetry({
    attacher, log = () => {}, sleep, now = Date.now, budgetMs = 15 * 60_000, isStopping = () => false,
}) {
    const started = now();
    let delay = 2_000;
    for (let attempt = 1; ; attempt++) {
        if (isStopping()) return null;
        let answer = null;
        let problem;
        try {
            answer = await attacher.syncRelease();
        } catch (error) {
            problem = `the attacher did not answer: ${error?.code ?? error?.message ?? error}`;
        }
        if (answer) {
            const body = isPlainObject(answer.body) ? answer.body : {};
            if (answer.status >= 200 && answer.status < 300 && body.ok === true) return body;
            const detail = [body.code, body.message].filter(Boolean).join(": ");
            if (!(answer.status >= 500 && body.retryable === true)) {
                throw new LaunchError(`the release sync failed (HTTP ${answer.status}${detail ? ` ${detail}` : ""})`);
            }
            problem = `HTTP ${answer.status} ${detail}`;
        }
        if (now() - started > budgetMs) throw new LaunchError(`the release sync did not succeed within ${Math.round(budgetMs / 60_000)} minutes: ${problem}`);
        log(`launcher: release sync attempt ${attempt} failed, retrying in ${Math.round(delay / 1000)} s: ${problem}`);
        await sleep(delay);
        delay = Math.min(60_000, delay * 2);
    }
}

/**
 * POST /v1/vms/register until the VM is active; resolves with its owner (null
 * when unbound), or with null when `isStopping()` turns true.
 */
export async function waitForActive({
    controller, log = () => {}, sleep, now = Date.now, intervalMs = 5_000, slowIntervalMs = 15_000, slowAfterMs = 2 * 60_000,
    isStopping = () => false,
}) {
    const started = now();
    let last = null;
    for (;;) {
        if (isStopping()) return null;
        let state;
        try {
            const answer = await controller.register();
            if (answer?.status === "active") {
                if (answer.ownerOid === null || answer.ownerOid === undefined) return { ownerOid: null };
                if (isGuid(answer.ownerOid)) return { ownerOid: answer.ownerOid.toLowerCase() };
                state = "active with an owner that is not an object ID";
            } else {
                state = `inactive (${typeof answer?.reason === "string" ? answer.reason : "no reason"})`;
            }
        } catch (error) {
            state = `no answer: ${error?.message ?? error}`;
        }
        if (state !== last) log(`launcher: waiting for the disk controller to activate this VM: ${state}`);
        last = state;
        await sleep(now() - started > slowAfterMs ? slowIntervalMs : intervalMs);
    }
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"];

/**
 * Everything the service does before the worker runs. `deps` replaces the
 * real parts in tests. Resolves with { exitCode } when the service is asked
 * to stop before the worker starts; otherwise it hands over to worker.js and
 * resolves only when that import resolves.
 */
export async function runLauncher(deps = {}) {
    const log = deps.log ?? ((message) => console.log(message));
    const root = deps.root ?? DEFAULT_ROOT;
    const env = deps.env ?? process.env;
    const readFile = deps.readFile ?? fs.promises.readFile;
    const imds = deps.imds ?? createImdsClient();
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const signals = deps.signals ?? process;
    const pid = deps.pid ?? process.pid;
    const randomId = deps.randomId ?? randomUUID;

    checkNodeVersion(deps.nodeVersion ?? process.versions.node, deps.expectedNodeVersion ?? EXPECTED_NODE_VERSION);

    let workerEnvText;
    try {
        workerEnvText = await readFile(path.join(root, "worker.env"), "utf8");
    } catch (error) {
        throw new LaunchError(`cannot read ${path.join(root, "worker.env")}: ${error?.code ?? error?.message ?? error}`);
    }
    const workerEnv = parseEnvFile(workerEnvText);
    const userData = await decodeUserData(await retryImds(() => imds.userData(), { wait: sleep }));
    const values = buildWorkerEnv({ workerEnv, userData });

    const tokens = (deps.createTokenSource ?? createTokenSource)({ imds, scope: values.PS_DISK_CONTROLLER_TOKEN_SCOPE, clientId: values.AZURE_CLIENT_ID });
    const oid = tokenObjectId(await tokens.getToken());
    if (oid !== values.EXPECTED_WIN_WORKER_OID.toLowerCase()) {
        throw new LaunchError(`IMDS issues tokens to object ID ${oid ?? "(none)"}, not to the worker identity ${values.EXPECTED_WIN_WORKER_OID}; refusing to start`);
    }

    const launchId = randomId();
    applyEnv(env, { ...values, PS_LAUNCH_ID: launchId }, LAUNCHER_SETTINGS);
    log(`launcher: launch ${launchId}; configuration ${values.WIN_WORKER_CONFIG_VERSION}; owner-only ${values.PILOTSWARM_WORKER_OWNER_ONLY}`);

    const controller = (deps.createController ?? createControllerClient)({
        url: values.PS_DISK_POOL_CONTROLLER_URL, ca: userData.controllerCaCert, getToken: () => tokens.getToken(),
    });
    const attacher = (deps.createAttacher ?? createAttacherClient)({
        url: values.PS_DISK_ATTACHER_URL || DEFAULT_ATTACHER_URL,
        tokenFile: values.PS_DISK_ATTACHER_TOKEN_FILE || path.join(root, "run", "attacher.token"),
    });

    let heartbeat = null;
    const freer = createLun0Freer({ attacher, controller, pid, currentSequence: () => heartbeat?.sent ?? 0, log, sleep, ...(deps.freerOptions ?? {}) });
    const owners = createOwnerWatch();
    heartbeat = createLauncherHeartbeat({
        controller,
        launchId,
        configVersion: values.WIN_WORKER_CONFIG_VERSION,
        intervalMs: deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
        log,
        onAnswer: (answer, sequence) => {
            freer.onAnswer(answer, sequence);
            owners.onAnswer(answer);
        },
        ...(deps.timers ? { timers: deps.timers } : {}),
    });

    let stopping = null;
    let workerStarting = false;
    let az = null;
    let resolveStop;
    const stopRequested = new Promise((resolve) => {
        resolveStop = resolve;
    });
    const isStopping = () => stopping !== null;
    let forwarding = null;
    const onSignal = (signal) => {
        if (!workerStarting) {
            if (!stopping) {
                stopping = signal;
                log(`launcher: ${signal} received before the worker started; stopping`);
                freer.stop();
                resolveStop({ stopped: signal });
            }
            return;
        }
        // worker.js handles SIGINT and SIGTERM once it has started; until its
        // handler is there, the stop request waits for it.
        if (signal !== "SIGBREAK" && signals.listenerCount(signal) > 1) return;
        forwarding ??= (async () => {
            while (signals.listenerCount("SIGINT") <= 1) await sleep(250);
            signals.emit("SIGINT", "SIGINT");
        })();
    };
    for (const signal of STOP_SIGNALS) signals.on(signal, onSignal);

    const phase = (async () => {
        heartbeat.start();
        const temp = path.join(root, "temp");
        const cleared = await (deps.clearFolder ?? clearFolderContents)(temp);
        if (cleared.failed.length) log(`launcher: could not clear ${cleared.failed.length} item(s) in ${temp}: ${cleared.failed.slice(0, 3).join("; ")}`);

        // No step that can fail runs before LUN 0 is free.
        await freer.settled();
        if (isStopping()) return null;

        const synced = await syncReleaseWithRetry({ attacher, log, sleep, isStopping, ...(deps.syncOptions ?? {}) });
        if (!synced) return null;
        log(`launcher: release ${synced.commitSha ?? "(unnamed)"} is in place${synced.changed ? " (new)" : ""}`);
        const currentDir = path.join(root, "current");
        const releaseDir = await (deps.realpath ?? fs.promises.realpath)(currentDir).catch((error) => {
            throw new LaunchError(`${currentDir} names no release after the sync: ${error?.code ?? error?.message ?? error}`);
        });
        const workerFile = path.join(releaseDir, ...WORKER_ENTRY);
        await (deps.access ?? fs.promises.access)(workerFile).catch(() => {
            throw new LaunchError(`the release in ${releaseDir} has no ${WORKER_ENTRY.join("\\")}`);
        });
        applyEnv(env, pinReleasePaths(values, currentDir, releaseDir));

        const active = await waitForActive({ controller, log, sleep, isStopping, ...(deps.registerOptions ?? {}) });
        if (!active) return null;
        let ownerOid = active.ownerOid;
        if (!ownerOid && values.PILOTSWARM_WORKER_OWNER_ONLY === "1") {
            log("launcher: active and unbound; an owner-only worker starts once a heartbeat answer names the VM's owner");
            ownerOid = await Promise.race([owners.waitForOwner(), stopRequested.then(() => null)]);
        }
        if (isStopping()) return null;
        if (ownerOid) applyEnv(env, { PILOTSWARM_WORKER_OWNER_TAG: `owner.${ownerOid}` });
        else applyEnv(env, {}, ["PILOTSWARM_WORKER_OWNER_TAG"]);

        const configDir = values.AZURE_CONFIG_DIR || path.join(root, "azure-cli");
        const azCleared = await (deps.clearFolder ?? clearFolderContents)(configDir);
        if (azCleared.failed.length) log(`launcher: could not clear ${azCleared.failed.length} item(s) in ${configDir}`);
        az = (deps.createAzSignIn ?? createAzSignIn)({ clientId: values.AZURE_CLIENT_ID, configDir, env, log });
        az.start();

        // A drive named while the VM waited is freed before the extension owns LUN 0.
        await freer.settled();
        freer.stop();
        if (isStopping()) return null;
        workerStarting = true;
        globalThis[HEARTBEAT_HANDOVER] = heartbeat.handover;
        log(`launcher: starting ${workerFile}${ownerOid ? ` for owner ${ownerOid}` : " unbound"}`);
        await (deps.importWorker ?? ((file) => import(pathToFileURL(file).href)))(workerFile);
        return { exitCode: 0, workerStarted: true, az, heartbeat };
    })();
    // After a stop, the abandoned phase must not surface as an unhandled rejection.
    phase.catch(() => {});

    try {
        const outcome = await Promise.race([phase, stopRequested]);
        if (!outcome || outcome.stopped) {
            freer.stop();
            az?.stop();
            await heartbeat.stop();
            return { exitCode: 0, stopped: stopping };
        }
        return outcome;
    } catch (error) {
        freer.stop();
        az?.stop();
        if (globalThis[HEARTBEAT_HANDOVER] === heartbeat.handover) delete globalThis[HEARTBEAT_HANDOVER];
        await heartbeat.stop();
        throw error;
    } finally {
        if (!workerStarting) for (const signal of STOP_SIGNALS) signals.off(signal, onSignal);
    }
}

function isMainModule() {
    if (!process.argv[1]) return false;
    try {
        const main = pathToFileURL(fs.realpathSync(process.argv[1])).href;
        return process.platform === "win32" ? main.toLowerCase() === import.meta.url.toLowerCase() : main === import.meta.url;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    runLauncher().then((outcome) => {
        if (outcome && !outcome.workerStarted) process.exit(outcome.exitCode ?? 0);
    }, (error) => {
        console.error(`launcher: ${error instanceof LaunchError ? "refusing to start: " : ""}${error?.message ?? error}`);
        process.exit(1);
    });
}
