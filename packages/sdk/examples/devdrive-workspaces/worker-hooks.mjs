/**
 * The worker hooks the Dev Drive extension registers (README, "Owner
 * binding, admission and credentials"): all of them ask the disk controller,
 * which knows each root session's drive lease and owner.
 *
 *   admission            POST /v1/vms/admit before every turn
 *   credential resolver  POST /v1/credentials/model for a provider whose key is
 *                        in the deployment's secret store
 *   binding              an unbound worker restarts once the controller binds
 *                        its VM to an owner
 *
 * It registers no capacity requester: a bound worker declares its owner's tag,
 * and with the capacity tag too it would refuse to start. The coordination
 * host sends every capacity request.
 */
const OWNER_TAG_PREFIX = "owner.";

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
