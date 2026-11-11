/**
 * The worker hooks the Dev Drive extension registers (README, "Owner
 * binding, admission and credentials"): all of them ask the disk controller,
 * which knows each root session's drive lease and owner.
 *
 *   admission            POST /v1/vms/admit before every turn
 *   credential resolver  POST /v1/credentials/model for a provider whose key is
 *                        in the deployment's secret store
 *   capacity requester   POST /v1/vms/demand, only without owner-only workers
 *   binding              an unbound worker restarts once the controller binds
 *                        its VM to an owner
 */
const OWNER_TAG_PREFIX = "owner.";
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OWNER_NOT_SUPPORTED = "OWNER_NOT_SUPPORTED";
export const OWNER_NOT_SUPPORTED_MESSAGE = "This session's owner has no Microsoft Entra object ID, so the disk controller can give it no Windows worker. "
    + "Sign in with Microsoft Entra ID to use this deployment's Windows workers.";

const defaultTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
};

const textOf = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const positive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
};

/**
 * The root sessions this VM admitted: under its binding, which is fixed for
 * the worker's lifetime, each of them belongs to the VM's owner, so only
 * they may take a drive back from another idle session here.
 */
export function createAdmittedRoots(limit = 10_000) {
    const roots = new Map();
    return {
        add(rootSessionId) {
            roots.delete(rootSessionId);
            roots.set(rootSessionId, true);
            if (roots.size > limit) roots.delete(roots.keys().next().value);
        },
        delete: (rootSessionId) => roots.delete(rootSessionId),
        has: (rootSessionId) => roots.has(rootSessionId),
        get size() { return roots.size; },
    };
}

/**
 * Admission before every turn. A controller that cannot be asked throws,
 * so the turn fails and is retried; it never runs unchecked.
 */
export function createSessionAdmission({ controller, admitted }) {
    return async ({ sessionId, rootSessionId, isSystem }) => {
        const answer = await controller.admit({ sessionId, rootSessionId, isSystem: Boolean(isSystem) });
        const message = textOf(answer?.message);
        switch (answer?.decision) {
            case "admit":
                if (!isSystem) admitted.add(rootSessionId);
                return { decision: "admit" };
            case "busy":
                return { decision: "busy", ...(message ? { message } : {}), ...(positive(answer.retryAfterMs) ? { retryAfterMs: positive(answer.retryAfterMs) } : {}) };
            case "deny":
                admitted.delete(rootSessionId);
                return { decision: "deny", ...(message ? { message } : {}) };
            default:
                throw new Error("the disk controller gave no admission decision");
        }
    };
}

/**
 * The model token of a provider whose key is in the deployment's secret
 * store. PilotSwarm keeps the token in memory, by secret name and version,
 * and calls this only for a version it does not hold, or after the model
 * refused the token. The answer passes on as refused, busy or unavailable,
 * so the turn fails without a retry, waits, or fails and is retried.
 */
export function createCredentialResolver({ controller }) {
    return async ({ sessionId, rootSessionId, provider, secret }) => controller.modelCredential({
        sessionId,
        rootSessionId,
        provider,
        secretName: secret?.name,
        secretVersion: secret?.version,
    });
}

function sleep(ms, signal, timers) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        const onAbort = () => {
            timers.clearTimeout(id);
            reject(signal.reason ?? new Error("aborted"));
        };
        const id = timers.setTimeout(() => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener?.("abort", onAbort, { once: true });
    });
}

/**
 * The capacity requester: asks the controller for a VM of the session's
 * owner, again and again until it answers or PilotSwarm's 15-second signal
 * fires, and passes its answer on: `deny` for a root without a drive lease,
 * which ends the turn, or `busy` with retryAfterMs for a parked or returning
 * one, which holds the session on its timer. An owner without an object ID
 * gets `deny` at once: the controller binds VMs to object IDs only, so no
 * retry could ever serve that session.
 */
export function createCapacityRequester({ controller, timers = defaultTimers, backoffMs = [250, 500, 1_000, 2_000, 4_000] }) {
    return async ({ rootSessionId, ownerTag }, signal) => {
        const tag = String(ownerTag ?? "");
        if (!tag.startsWith(OWNER_TAG_PREFIX) || tag.length === OWNER_TAG_PREFIX.length) throw new Error("the session has no owner routing tag");
        const ownerOid = tag.slice(OWNER_TAG_PREFIX.length);
        if (!OBJECT_ID.test(ownerOid)) return { decision: "deny", code: OWNER_NOT_SUPPORTED, message: OWNER_NOT_SUPPORTED_MESSAGE };
        for (let attempt = 0; ; attempt += 1) {
            if (signal?.aborted) throw signal.reason ?? new Error("aborted");
            let answer = null;
            try {
                answer = await controller.demand({ ownerOid, rootSessionId }, signal ? { signal } : {});
            } catch {
                answer = null;
            }
            if (answer && answer.status >= 200 && answer.status < 300 && answer.body && typeof answer.body === "object") {
                const body = answer.body;
                const message = textOf(body.message);
                const code = typeof body.code === "string" && CODE.test(body.code) ? body.code : undefined;
                if (body.decision === "ok") return { decision: "ok" };
                if (body.decision === "deny") return { decision: "deny", ...(message ? { message } : {}), ...(code ? { code } : {}) };
                if (body.decision === "busy") {
                    return {
                        decision: "busy",
                        ...(message ? { message } : {}),
                        ...(code ? { code } : {}),
                        ...(positive(body.retryAfterMs) ? { retryAfterMs: positive(body.retryAfterMs) } : {}),
                    };
                }
            }
            // A refusal of the route itself (for example on a pool with owner-only workers) does not pass by retrying.
            if (answer && answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
                throw new Error(`the disk controller refused the capacity request: HTTP ${answer.status}`);
            }
            await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)], signal, timers);
        }
    };
}

/**
 * The VM's owner binding, fixed for the worker's lifetime. A worker started
 * without an owner (not owner-only) exits with code 75 once a heartbeat
 * answer binds its VM, so that its service manager starts it again with the
 * owner's tag; the drain gets 2 minutes. The first heartbeat runs before the
 * worker starts and never restarts it: the next one does.
 */
export function createBinding({ worker, ownerTag = null, ownerOnly = false, onRestart = () => {}, log = () => {}, drainTimeoutMs = 120_000 }) {
    let owner = typeof ownerTag === "string" && ownerTag.startsWith(OWNER_TAG_PREFIX) ? ownerTag.slice(OWNER_TAG_PREFIX.length) : null;
    const startedBound = owner !== null;
    let restarting = false;
    return {
        observe(ownerOid) {
            if (typeof ownerOid !== "string" || !ownerOid) return;
            if (owner && owner !== ownerOid) {
                log(`devdrive: the disk controller names owner ${ownerOid}, but this worker serves owner ${owner} for its lifetime`);
                return;
            }
            owner = ownerOid;
            if (startedBound || ownerOnly || restarting || !worker.isStarted) return;
            restarting = true;
            onRestart();
            log("devdrive: this VM was bound to an owner; the worker drains and exits with code 75 to start again with the owner's tag");
            Promise.resolve()
                .then(() => worker.requestExit(75, "bind", { drainTimeoutMs }))
                .catch((error) => log(`devdrive: the restart for the binding failed: ${error?.message ?? error}`));
        },
        get owner() { return owner; },
        get restarting() { return restarting; },
    };
}
