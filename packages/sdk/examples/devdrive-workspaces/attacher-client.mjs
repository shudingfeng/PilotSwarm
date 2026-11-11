/**
 * The VM's disk attacher (README, "The attacher API"): a local service that
 * brings LUN 0 online as the Dev Drive, takes it offline, and extends it
 * after the controller grew the disk. It listens on the loopback address
 * only and takes the token from its token file in every request.
 *
 *   POST /online-lun0   { diskName }              -> { ok: true } once the drive is mounted
 *   POST /offline-lun0  { diskName, workerPid }   -> { ok: true }; LUN 0 is offline (also when it already was)
 *   POST /extend-lun0   { diskName, sizeGb }      -> { ok: true } once the volume fills the disk,
 *                                                    { ok: false, retry: true } until Windows sees the new size
 */
import fs from "node:fs";
import { requestJson } from "./disk-pool-client.mjs";

export const DEFAULT_ATTACHER_URL = "http://127.0.0.1:3099";
export const DEFAULT_ATTACHER_TOKEN_FILE = "C:\\pilotswarm\\run\\attacher.token";

export class AttacherError extends Error {
    constructor(message, { status, code } = {}) {
        super(message);
        this.name = "AttacherError";
        if (status !== undefined) this.status = status;
        if (code !== undefined) this.code = code;
    }
}

/** True for http:// on a loopback address: the attacher's token must never leave the VM. */
export function isLoopbackHttpUrl(value) {
    let url;
    try { url = new URL(String(value)); } catch { return false; }
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * @param {object} options
 * @param {string} [options.url]        PS_DISK_ATTACHER_URL
 * @param {string} [options.tokenFile]  PS_DISK_ATTACHER_TOKEN_FILE
 * @param {number} [options.timeoutMs]  per call; bringing a disk online can take minutes
 * @param {Function} [options.request]  requestJson, replaceable in tests
 * @param {Function} [options.readFile]
 */
export function createAttacherClient({
    url = DEFAULT_ATTACHER_URL,
    tokenFile = DEFAULT_ATTACHER_TOKEN_FILE,
    timeoutMs = 5 * 60_000,
    request = requestJson,
    readFile = fs.promises.readFile,
} = {}) {
    if (!isLoopbackHttpUrl(url)) throw new Error(`the disk attacher URL (PS_DISK_ATTACHER_URL) must be http:// on a loopback address, not ${url}`);
    const base = String(url).replace(/\/+$/, "");
    let token = null;

    const readToken = async () => {
        token = String(await readFile(tokenFile, "utf8")).trim();
        return token;
    };

    async function call(route, body) {
        if (token === null) await readToken();
        const send = () => request(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, timeoutMs });
        let answer = await send();
        if (answer.status === 401) {
            // The attacher may have written a new token since this worker read it.
            await readToken();
            answer = await send();
        }
        const data = answer.body && typeof answer.body === "object" ? answer.body : {};
        if (answer.status < 200 || answer.status >= 300) {
            throw new AttacherError(`${route}: HTTP ${answer.status}${data.message ? ` ${data.message}` : ""}`, {
                status: answer.status,
                ...(data.code ? { code: data.code } : {}),
            });
        }
        return data;
    }

    /** A route that must answer ok. */
    async function must(route, body) {
        const data = await call(route, body);
        if (data.ok !== true) throw new AttacherError(`${route}: ${data.message ?? "the attacher did not answer ok"}`, { ...(data.code ? { code: data.code } : {}) });
        return data;
    }

    return {
        onlineLun0: (body) => must("/online-lun0", body),
        offlineLun0: (body) => must("/offline-lun0", body),
        /** { ok: true } when done; { ok: false, retry: true } while Windows does not see the new size yet. */
        async extendLun0(body) {
            const data = await call("/extend-lun0", body);
            if (data.ok === true) return { ok: true };
            if (data.retry === true) return { ok: false, retry: true, ...(data.message ? { message: data.message } : {}) };
            throw new AttacherError(`/extend-lun0: ${data.message ?? "the attacher did not answer ok"}`);
        },
    };
}
