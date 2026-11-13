/**
 * The disk controller's token module for Windows workers. The Dev Drive
 * extension loads it from PS_DISK_CONTROLLER_TOKEN_MODULE
 * (C:\pilotswarm\controller-token.mjs in the image) and calls getToken()
 * before every controller call.
 *
 * getToken() returns an Entra access token for PS_DISK_CONTROLLER_TOKEN_SCOPE
 * (`<controller app>/.default`) that the Azure Instance Metadata Service
 * (IMDS) issues to the VM's user-assigned identity AZURE_CLIENT_ID. The token
 * stays in this process's memory until five minutes before it expires. It is
 * never logged or written anywhere.
 *
 * Imports only Node.js built-in modules, so the image installs it as a single
 * file.
 */
import http from "node:http";

export const IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";
export const IMDS_API_VERSION = "2018-02-01";
/** A cached token is renewed this long before it expires. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IMDS answers these while the identity or the service is not ready yet. */
const RETRYABLE_STATUS = new Set([404, 410, 429, 500, 502, 503, 504]);
const MAX_ANSWER_BYTES = 64 * 1024;

/** `api://app/.default` -> `api://app`: IMDS takes the resource, not the scope. */
export function scopeToResource(scope) {
    const resource = String(scope ?? "").trim().replace(/\/\.default$/i, "");
    if (!resource || /\s/.test(resource)) {
        throw new Error("PS_DISK_CONTROLLER_TOKEN_SCOPE must name the disk controller's app, for example api://<app>/.default");
    }
    return resource;
}

/** One GET to IMDS. Resolves with the status and the body text; rejects only when no answer arrives. */
export function imdsGet(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        // No agent: IMDS is link-local and must never go through a proxy or a kept-alive socket.
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

/** IMDS's own error text, never a token: error answers carry none. */
function describeError(text) {
    try {
        const body = JSON.parse(text);
        const detail = [body?.error, body?.error_description].filter((part) => typeof part === "string" && part).join(": ");
        return detail ? ` (${detail.slice(0, 300)})` : "";
    } catch {
        return "";
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.scope       PS_DISK_CONTROLLER_TOKEN_SCOPE
 * @param {string} options.clientId    AZURE_CLIENT_ID, the VM's user-assigned identity
 * @param {Function} [options.request] imdsGet, replaceable in tests
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.wait]
 * @param {number} [options.attempts]  IMDS calls per token before giving up
 */
export function createControllerTokenSource({
    scope, clientId, request = imdsGet, now = Date.now, wait = sleep, attempts = 4,
    refreshBeforeExpiryMs = REFRESH_BEFORE_EXPIRY_MS,
} = {}) {
    const resource = scopeToResource(scope);
    const id = String(clientId ?? "").trim();
    if (!GUID.test(id)) throw new Error("AZURE_CLIENT_ID must be the client ID (a GUID) of the VM's user-assigned identity");
    const url = `${IMDS_TOKEN_URL}?api-version=${IMDS_API_VERSION}&resource=${encodeURIComponent(resource)}&client_id=${encodeURIComponent(id)}`;
    let cached = null;
    let pending = null;

    function parse(text) {
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error("IMDS answered with something other than JSON");
        }
        if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("IMDS answered without a token");
        const expiresOn = Number(body.expires_on) * 1000;
        const expiresIn = Number(body.expires_in) * 1000;
        const expiresAt = Number.isFinite(expiresOn) && expiresOn > 0
            ? expiresOn
            : now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0);
        return { token: body.access_token, expiresAt };
    }

    async function fetchToken() {
        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            let answer = null;
            try {
                answer = await request(url);
            } catch (error) {
                lastError = new Error(`IMDS did not answer: ${error?.message ?? error}`);
            }
            if (answer) {
                if (answer.status === 200) return parse(answer.text);
                lastError = new Error(`IMDS answered HTTP ${answer.status} for the controller token${describeError(answer.text)}`);
                if (!RETRYABLE_STATUS.has(answer.status)) throw lastError;
            }
            if (attempt < attempts) await wait(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
        }
        throw lastError;
    }

    return {
        resource,
        async getToken() {
            if (cached && cached.expiresAt - refreshBeforeExpiryMs > now()) return cached.token;
            pending ??= fetchToken()
                .then((entry) => {
                    cached = entry;
                    return entry.token;
                })
                .finally(() => {
                    pending = null;
                });
            return pending;
        },
        /** Forget the cached token, for example after the controller answered 401. */
        clear() {
            cached = null;
        },
    };
}

let defaultSource = null;

/** The controller token for this VM, from PS_DISK_CONTROLLER_TOKEN_SCOPE and AZURE_CLIENT_ID. */
export async function getToken() {
    defaultSource ??= createControllerTokenSource({
        scope: process.env.PS_DISK_CONTROLLER_TOKEN_SCOPE,
        clientId: process.env.AZURE_CLIENT_ID,
    });
    return defaultSource.getToken();
}
