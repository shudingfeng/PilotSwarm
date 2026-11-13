/**
 * The Dev Drive workspace provider (README): a root session's work lives on
 * its own drive, which the disk controller attaches to the VM at LUN 0 and
 * the local attacher mounts as the volume of the workspace roots (Q:). A VM
 * holds one drive at a time.
 *
 * ensureAttached(req), under the VM's LUN 0 mutex (vmLun0Mutex):
 *   1. this root's drive is mounted here -> the path, at once (the fast
 *      path), unless the controller asked for the drive back, a branch sync
 *      or a crash check is still pending
 *   2. another root's drive is mounted -> a check never takes it; otherwise
 *      take it back from its idle holder through
 *      worker.tryReleaseIdleWorkspace (no WIP push), unless that session was
 *      itself just taken back here (it then runs elsewhere: /v1/vms/busy)
 *   3. POST /v1/leases/attach { rootSessionId, requestId, purpose }
 *   4. the attacher's /online-lun0
 *   5. after a crash: stale Git locks, Git's connectivity check and git
 *      status; back from local work: the branch sync
 *
 * release(req) removes one folder from the set this drive holds. The last
 * one pushes the WIP branch (not for a take-back, a controller release or a
 * shutdown), writes the clean-detach record, takes LUN 0 offline and asks
 * the controller to detach the drive. A release that names a root whose
 * drive is no longer mounted here does nothing.
 *
 * A drive that is still attached here but that no session holds is freed
 * the same way, retried with backoff until the controller confirms the
 * detach; until then LUN 0 counts as taken.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

const BUSY = "WORKSPACE_BUSY";
const ATTACH_FAILED = "WORKSPACE_ATTACH_FAILED";
const ATTACH_TIMEOUT = "WORKSPACE_ATTACH_TIMEOUT";
const ROOT_UNKNOWN = "WORKSPACE_ROOT_UNKNOWN";

export const PROVIDER_DEFAULTS = Object.freeze({
    /** One attach, from the mutex to the answer; register() uses PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS when it is set. */
    attachBudgetMs: 10 * 60_000,
    /** What a take-back gives the holder's release. */
    preemptReleaseTimeoutMs: 60_000,
    /** The whole WIP push of a release. */
    wipPushTimeoutMs: 90_000,
    /** How long the shutdown hook waits for a release in flight. */
    shutdownWaitMs: 120_000,
    /** A check that cannot have the drive tries again after this. */
    checkRetryAfterMs: 10_000,
    /** A turn that finds LUN 0 taken tries again after this. */
    busyRetryAfterMs: 10_000,
    /** An attach that failed for a reason that may pass. */
    attachRetryAfterMs: 30_000,
    /** Between attempts to free a drive, the last one repeating. */
    freeBackoffMs: [1_000, 2_000, 5_000, 15_000, 30_000, 60_000],
    /** Between /extend-lun0 attempts while Windows does not see the new size. */
    extendRetryMs: 60_000,
    onlineAttempts: 3,
    onlineRetryMs: 5_000,
});

const defaultTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
};

/** A FIFO mutex: acquire() resolves with a function that releases it (once). */
export function createMutex() {
    const queue = [];
    let locked = false;
    const grant = () => {
        if (locked || queue.length === 0) return;
        locked = true;
        const resolve = queue.shift();
        let released = false;
        resolve(() => {
            if (released) return;
            released = true;
            locked = false;
            grant();
        });
    };
    return {
        acquire: () => new Promise((resolve) => { queue.push(resolve); grant(); }),
        get locked() { return locked; },
        get waiting() { return queue.length; },
    };
}

/** The key PilotSwarm holds a folder under: the session, the root and the folder. */
export const folderKey = (req) => `${req.sessionId}\0${req.workspace?.root ?? ""}\0${req.workspace?.folder ?? ""}`;

function validReleaseRequest(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.diskName !== "string" || !value.diskName) return null;
    return { diskName: value.diskName, reason: typeof value.reason === "string" ? value.reason : "unknown" };
}

function validExtendRequest(value) {
    if (!value || typeof value !== "object") return null;
    const sizeGb = Number(value.sizeGb);
    if (typeof value.diskName !== "string" || !value.diskName || !Number.isFinite(sizeGb) || sizeGb <= 0) return null;
    return { diskName: value.diskName, sizeGb };
}

/**
 * @param {object} options
 * @param {Array<{ name: string, path: string }>} options.roots   the workspace roots, all on the drive's volume
 * @param {{ agents: boolean, skills: boolean, instructions: boolean } | null} options.adopt
 * @param {object} options.controller   attach, detach, busy (disk-pool-client.mjs)
 * @param {object} options.attacher     onlineLun0, offlineLun0, extendLun0 (attacher-client.mjs)
 * @param {object} options.repos        writeCleanRecord, pushWip, recoverAfterCrash, findAppliedSync, applySync (git-repos.mjs)
 * @param {{ tryReleaseIdleWorkspace: Function }} options.worker
 * @param {(rootSessionId: string) => string} options.wipBranchFor
 * @param {(rootSessionId: string) => boolean} [options.isAdmittedRoot]   a root this VM admitted: of its bound owner
 * @param {{ setTimeout: Function, clearTimeout: Function, now: () => number }} [options.timers]
 * @param {(message: string) => void} [options.log]
 * @param {Partial<typeof PROVIDER_DEFAULTS>} [options.options]
 */
export function createDevDriveProvider({
    roots, adopt = null, controller, attacher, repos, worker, wipBranchFor,
    isAdmittedRoot = () => true, timers = defaultTimers, log = () => {}, options = {},
}) {
    const opts = { ...PROVIDER_DEFAULTS, ...options };
    const mutex = createMutex();
    const sessionDiskMap = new Map();
    /** Drives being taken offline and detached, by name: released ones and orphans. */
    const freeing = new Map();
    /** Drives a heartbeat answer named, whose check waits for the mutex. */
    const queuedFrees = new Set();
    const pending = new Set();
    let mounted = null;
    let preempting = null;
    let lastPreemptedSessionId = null;
    let releaseRequest = null;
    let controllerRelease = null;
    const extend = { done: null, lastTryAt: -Infinity, lastFor: null, inFlight: false };
    // Rises whenever an attach or a detach starts or ends. A heartbeat answer
    // sent at another value may predate an attach still in flight.
    let epoch = 0;
    let stopped = false;
    const bump = () => { epoch += 1; };

    const fail = (code, message, retryAfterMs) => ({ ok: false, code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    const busy = (message, retryAfterMs = opts.busyRetryAfterMs) => fail(BUSY, message, retryAfterMs);
    const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));
    const background = (work) => {
        const task = Promise.resolve(work).catch((error) => log(`devdrive: ${error?.message ?? error}`));
        pending.add(task);
        task.finally(() => pending.delete(task));
    };
    const checkPending = (mount) => mount.needsCheck && !mount.checked;

    function newMount(rootSessionId, diskName, needsCheck) {
        return { rootSessionId, diskName, folders: new Map(), needsCheck, checked: false, syncPending: null, applied: null, notice: null, noticeTurn: null };
    }

    function addNotice(mount, text) {
        if (!text) return;
        mount.notice = mount.notice ? `${mount.notice}\n\n${text}` : text;
        mount.noticeTurn = null;
    }

    function attachedAnswer(req, mount, attachPath) {
        mount.folders.set(folderKey(req), {
            sessionId: req.sessionId,
            root: req.workspace.root,
            ...(req.workspace.folder ? { folder: req.workspace.folder } : {}),
            ...(req.attachment ? { attachment: req.attachment } : {}),
        });
        const result = { ok: true, path: attachPath, ...(adopt ? { adopt: { ...adopt } } : {}) };
        // Said once, with the working folder of a turn; again only when the same turn is retried.
        if (mount.notice && req.purpose !== "check" && !req.attachment) {
            if (mount.noticeTurn === null || mount.noticeTurn === req.turnIndex) {
                mount.noticeTurn = req.turnIndex;
                result.notice = mount.notice;
            } else {
                mount.notice = null;
            }
        }
        return result;
    }

    function notifyBusy(rootSessionId) {
        // The controller binds or adds another VM of the owner when none is free.
        Promise.resolve().then(() => controller.busy({ rootSessionId }))
            .catch((error) => log(`devdrive: /v1/vms/busy for ${rootSessionId} failed: ${error?.message ?? error}`));
    }

    function startFreeingLocked({ diskName, rootSessionId = null }, { crashed, offline }) {
        if (mounted && mounted.diskName === diskName) mounted = null;
        const existing = freeing.get(diskName);
        if (existing) {
            existing.crashed ||= Boolean(crashed);
            existing.offline ||= Boolean(offline);
        } else {
            freeing.set(diskName, { diskName, rootSessionId, crashed: Boolean(crashed), offline: Boolean(offline), requestId: randomUUID(), attempt: 0, timer: null });
        }
        bump();
    }

    /** One attempt to take a drive offline and detach it; on failure the next attempt is scheduled. */
    async function freeLocked(diskName) {
        const entry = freeing.get(diskName);
        if (!entry) return true;
        timers.clearTimeout(entry.timer);
        entry.timer = null;
        try {
            if (entry.offline) {
                await attacher.offlineLun0({ diskName, workerPid: process.pid });
                entry.offline = false;
            }
            await controller.detach({
                diskName,
                ...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
                requestId: entry.requestId,
                crashed: entry.crashed,
            });
            if (freeing.get(diskName) === entry) freeing.delete(diskName);
            bump();
            log(`devdrive: drive ${diskName} detached${entry.crashed ? "; it gets a crash check at its next attach" : ""}`);
            return true;
        } catch (error) {
            entry.attempt += 1;
            const delay = opts.freeBackoffMs[Math.min(entry.attempt - 1, opts.freeBackoffMs.length - 1)];
            log(`devdrive: freeing drive ${diskName} failed (attempt ${entry.attempt}); trying again in ${delay} ms: ${error?.message ?? error}`);
            if (!stopped) entry.timer = timers.setTimeout(() => background(retryFree(entry)), delay);
            return false;
        }
    }

    async function retryFree(entry) {
        const unlock = await mutex.acquire();
        try {
            if (!stopped && freeing.get(entry.diskName) === entry) await freeLocked(entry.diskName);
        } finally {
            unlock();
        }
    }

    /** The last folder is gone: back up, record, then offline and detach. */
    async function detachMountedLocked(mount, { skipPush }) {
        // A drive whose crash check never passed keeps its flag, and nothing is recorded or pushed from it.
        const crashed = checkPending(mount);
        if (!crashed) {
            if (!skipPush) {
                const pushed = await Promise.resolve(repos.pushWip({
                    wipBranch: wipBranchFor(mount.rootSessionId),
                    timeoutMs: opts.wipPushTimeoutMs,
                    label: `session ${mount.rootSessionId}`,
                })).catch((error) => ({ ok: false, failed: [{ message: error?.message ?? String(error) }] }));
                if (!pushed.ok) {
                    log(`devdrive: the WIP push of drive ${mount.diskName} failed; the drive keeps every edit and the next release pushes again: `
                        + `${(pushed.failed ?? []).map((entry) => entry.message).join("; ")}`);
                }
            }
            const record = await Promise.resolve(repos.writeCleanRecord()).catch((error) => ({ ok: false, failures: [error?.message ?? String(error)] }));
            if (!record.ok) log(`devdrive: writing the clean-detach record failed: ${(record.failures ?? []).join("; ")}`);
        }
        startFreeingLocked(mount, { crashed, offline: true });
        await freeLocked(mount.diskName);
    }

    /**
     * Ask PilotSwarm to release every session holding a folder of this drive
     * (the root first). Never waits for a busy one.
     */
    async function releaseHolders(holder) {
        const sessions = [...new Set([holder.rootSessionId, ...[...holder.folders.values()].map((folder) => folder.sessionId)])];
        for (const sessionId of sessions) {
            let result;
            try {
                result = await worker.tryReleaseIdleWorkspace(sessionId, { reason: "moved", releaseTimeoutMs: opts.preemptReleaseTimeoutMs });
            } catch (error) {
                log(`devdrive: releasing session ${sessionId} failed: ${error?.message ?? error}`);
                continue;
            }
            if (result?.busy) return { busy: true, sessionId };
        }
        return { busy: false };
    }

    async function bringOnline(diskName, deadline) {
        let lastError;
        for (let attempt = 1; attempt <= opts.onlineAttempts; attempt += 1) {
            try {
                await attacher.onlineLun0({ diskName });
                return { ok: true };
            } catch (error) {
                lastError = error;
            }
            if (attempt === opts.onlineAttempts || timers.now() + opts.onlineRetryMs >= deadline) break;
            await sleep(opts.onlineRetryMs);
        }
        return { ok: false, message: lastError?.message ?? String(lastError) };
    }

    /** Steps 3 to 5, under the mutex. */
    async function attachLocked(req, attachPath, deadline) {
        const isCheck = req.purpose === "check";
        bump();
        let answer;
        try {
            answer = await controller.attach({ rootSessionId: req.rootSessionId, requestId: randomUUID(), purpose: isCheck ? "check" : "turn" });
        } catch (error) {
            return fail(ATTACH_FAILED, `the disk controller did not attach the drive: ${error?.message ?? error}`, opts.attachRetryAfterMs);
        } finally {
            bump();
        }
        if (!answer || answer.ok !== true) {
            const code = typeof answer?.code === "string" && answer.code ? answer.code : ATTACH_FAILED;
            const retryAfterMs = Number(answer?.retryAfterMs);
            return fail(code, typeof answer?.message === "string" && answer.message ? answer.message : "the disk controller refused the attach",
                Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : (answer?.retryable === false ? undefined : opts.attachRetryAfterMs));
        }
        const diskName = typeof answer.diskName === "string" ? answer.diskName : "";
        if (!diskName) return fail(ATTACH_FAILED, "the disk controller named no drive", opts.attachRetryAfterMs);
        const needsCheck = answer.takeover === true || answer.needsFsck === true;
        if (mounted && mounted.rootSessionId === req.rootSessionId && mounted.diskName === diskName) {
            // The holder's own attach for its root: the controller keeps the drive here, and a move it asked for is cancelled.
            if (releaseRequest?.diskName === diskName) releaseRequest = null;
        } else if (mounted) {
            return fail(ATTACH_FAILED, `the disk controller attached drive ${diskName}, but drive ${mounted.diskName} is mounted here`, opts.attachRetryAfterMs);
        } else {
            const online = await bringOnline(diskName, deadline);
            if (!online.ok) {
                // Nothing was written: the drive keeps the flag it came with.
                startFreeingLocked({ diskName, rootSessionId: req.rootSessionId }, { crashed: needsCheck, offline: true });
                await freeLocked(diskName);
                return fail(ATTACH_FAILED, `bringing drive ${diskName} online failed: ${online.message}`, opts.attachRetryAfterMs);
            }
            mounted = newMount(req.rootSessionId, diskName, needsCheck);
            sessionDiskMap.set(req.rootSessionId, diskName);
            bump();
        }
        const mount = mounted;
        const wipBranch = wipBranchFor(req.rootSessionId);
        if (checkPending(mount)) {
            const recovered = await Promise.resolve(repos.recoverAfterCrash({ wipBranch, deadline }))
                .catch((error) => ({ ok: false, message: error?.message ?? String(error), retryAfterMs: opts.attachRetryAfterMs }));
            if (!recovered.ok) {
                log(`devdrive: the crash check of drive ${diskName} failed: ${recovered.message}`);
                return fail(ATTACH_FAILED, `the drive's crash check failed: ${recovered.message}`, recovered.retryAfterMs);
            }
            mount.checked = true;
            addNotice(mount, recovered.notice);
        }
        const sync = answer.sync && typeof answer.sync === "object" ? answer.sync : null;
        if (!sync) {
            mount.syncPending = null;
        } else if (mount.applied?.syncId === sync.syncId) {
            mount.syncPending = null;
        } else {
            const applied = await Promise.resolve(repos.findAppliedSync(sync.syncId)).catch(() => null);
            if (applied) {
                mount.applied = applied;
                mount.syncPending = null;
            } else if (isCheck || req.attachment) {
                // One-time work waits for a turn's attach of the working folder.
                mount.syncPending = sync;
            } else {
                const result = await Promise.resolve(repos.applySync({ sync, folderPath: attachPath, wipBranch, deadline }))
                    .catch((error) => ({ ok: false, message: error?.message ?? String(error), retryAfterMs: opts.attachRetryAfterMs }));
                if (!result.ok) {
                    mount.syncPending = sync;
                    log(`devdrive: the branch sync of drive ${diskName} failed: ${result.message}`);
                    return fail(ATTACH_FAILED, `the drive's branch sync failed: ${result.message}`, result.retryAfterMs);
                }
                mount.applied = result.applied;
                mount.syncPending = null;
                if (!result.already) addNotice(mount, result.notice);
            }
        }
        return attachedAnswer(req, mount, attachPath);
    }

    const provider = {
        async listRoots() {
            return roots.map((root) => ({ name: root.name, path: root.path }));
        },

        async ensureAttached(req) {
            const root = roots.find((candidate) => candidate.name === req.workspace?.root);
            if (!root) return fail(ROOT_UNKNOWN, `root "${req.workspace?.root}" is not on this worker's Dev Drive`);
            const attachPath = req.workspace.folder ? path.join(root.path, req.workspace.folder) : root.path;
            const deadline = timers.now() + opts.attachBudgetMs;
            const isCheck = req.purpose === "check";
            let unlock = await mutex.acquire();
            let opId = null;
            try {
                const retryAfterMs = isCheck ? opts.checkRetryAfterMs : opts.busyRetryAfterMs;
                if (stopped) return busy("this worker is shutting down", retryAfterMs);
                // PilotSwarm stopped waiting for this attach while another call held LUN 0: start nothing for it.
                if (timers.now() >= deadline) return fail(ATTACH_TIMEOUT, "the attach waited for LUN 0 longer than its deadline", retryAfterMs);
                if (preempting && preempting.sessionId === req.rootSessionId) return busy("this session's drive is being taken back on this worker", retryAfterMs);
                if (mounted && mounted.rootSessionId === req.rootSessionId) {
                    const requested = releaseRequest && releaseRequest.diskName === mounted.diskName ? releaseRequest : null;
                    if (!requested && !mounted.syncPending && !checkPending(mounted)) return attachedAnswer(req, mounted, attachPath);
                    if (requested && isCheck) return busy(`the disk controller asked for this drive back (${requested.reason})`, retryAfterMs);
                    return await attachLocked(req, attachPath, deadline);
                }
                // Until the session that takes the drive back has it, every other session waits, also once LUN 0 is free.
                if (preempting && preempting.forRoot !== req.rootSessionId) return busy("another session is taking the drive on this worker", retryAfterMs);
                if (freeing.size > 0) return busy("LUN 0 is being freed", retryAfterMs);
                if (mounted) {
                    if (isCheck) return busy("another session's drive is mounted on this worker; a check never takes it", retryAfterMs);
                    if (!isAdmittedRoot(req.rootSessionId)) {
                        return busy("this worker did not admit this session, so it does not take the mounted drive for it");
                    }
                    if (req.rootSessionId === lastPreemptedSessionId) {
                        notifyBusy(req.rootSessionId);
                        return busy("this session's drive was taken back on this worker for another session; it runs on another worker");
                    }
                    const holder = mounted;
                    opId = randomUUID();
                    preempting = { sessionId: holder.rootSessionId, diskName: holder.diskName, forRoot: req.rootSessionId, opId };
                    // The holder's provider release takes this mutex.
                    unlock();
                    unlock = null;
                    const outcome = await releaseHolders(holder);
                    unlock = await mutex.acquire();
                    if (outcome.busy) {
                        notifyBusy(req.rootSessionId);
                        return busy(`the session that holds the mounted drive is busy (${outcome.sessionId})`);
                    }
                    if (mounted === holder) {
                        // Nothing on this worker holds it any more: an orphan.
                        startFreeingLocked(holder, { crashed: checkPending(holder), offline: true });
                        if (!(await freeLocked(holder.diskName))) return busy("the previous drive is being freed");
                    }
                    if (mounted || freeing.size > 0) return busy("LUN 0 is taken");
                    lastPreemptedSessionId = holder.rootSessionId;
                }
                return await attachLocked(req, attachPath, deadline);
            } finally {
                if (opId && preempting?.opId === opId) preempting = null;
                unlock?.();
            }
        },

        async release(req) {
            // Decided now: the take-back or the controller's release that led here may end before the mutex is free.
            const skipPush = req.reason === "shutdown"
                || (preempting !== null && preempting.sessionId === req.rootSessionId)
                || (controllerRelease !== null && sessionDiskMap.get(req.rootSessionId) === controllerRelease.diskName);
            const unlock = await mutex.acquire();
            try {
                const expectedDiskName = sessionDiskMap.get(req.rootSessionId);
                if (!mounted || mounted.rootSessionId !== req.rootSessionId || !mounted.diskName || mounted.diskName !== expectedDiskName) return;
                mounted.folders.delete(folderKey(req));
                if (mounted.folders.size > 0) return;
                await detachMountedLocked(mounted, { skipPush });
            } finally {
                unlock();
            }
        },
    };

    /** The controller wants the mounted drive back: release its idle holders, without a WIP push. */
    async function handleReleaseRequest(request) {
        if (controllerRelease || stopped) return;
        const holder = mounted;
        if (!holder || holder.diskName !== request.diskName) return;
        const opId = randomUUID();
        controllerRelease = { diskName: holder.diskName, reason: request.reason, opId };
        try {
            log(`devdrive: the disk controller asked for drive ${holder.diskName} back (${request.reason})`);
            const outcome = await releaseHolders(holder);
            if (outcome.busy) {
                log(`devdrive: session ${outcome.sessionId} is busy; drive ${holder.diskName} is released once it is idle`);
                return;
            }
            const unlock = await mutex.acquire();
            try {
                if (mounted === holder && !stopped) {
                    startFreeingLocked(holder, { crashed: checkPending(holder), offline: true });
                    await freeLocked(holder.diskName);
                }
            } finally {
                unlock();
            }
        } finally {
            if (controllerRelease?.opId === opId) controllerRelease = null;
        }
    }

    /** A drive the controller's record has on this VM, which no session here holds. */
    async function freeRecordedDrive(diskName, rootSessionId, sentEpoch) {
        const unlock = await mutex.acquire();
        try {
            // Only from the controller's latest record: nothing attached or detached since the heartbeat left.
            if (stopped || sentEpoch !== epoch || freeing.has(diskName) || mounted?.diskName === diskName) return;
            log(`devdrive: drive ${diskName} is attached to this VM, but no session here holds it; freeing it`);
            // LUN 0 holds it only when no drive of this worker is mounted there. Its last writer is
            // unknown here, so it is flagged for a crash check.
            startFreeingLocked({ diskName, rootSessionId }, { crashed: true, offline: !mounted });
            await freeLocked(diskName);
        } finally {
            unlock();
        }
    }

    async function handleExtend({ diskName, sizeGb }) {
        if (stopped || extend.inFlight || mounted?.diskName !== diskName) return;
        if (extend.done && extend.done.diskName === diskName && extend.done.sizeGb >= sizeGb) return;
        const key = `${diskName}\0${sizeGb}`;
        if (extend.lastFor === key && timers.now() - extend.lastTryAt < opts.extendRetryMs) return;
        extend.inFlight = true;
        extend.lastFor = key;
        extend.lastTryAt = timers.now();
        const unlock = await mutex.acquire();
        try {
            if (stopped || mounted?.diskName !== diskName) return;
            const result = await attacher.extendLun0({ diskName, sizeGb });
            if (result?.ok) {
                extend.done = { diskName, sizeGb };
                log(`devdrive: drive ${diskName} extended to ${sizeGb} GB`);
            }
        } catch (error) {
            log(`devdrive: extending drive ${diskName} failed: ${error?.message ?? error}`);
        } finally {
            extend.inFlight = false;
            unlock();
        }
    }

    return {
        provider,
        /** The drive part of a heartbeat. */
        heartbeatReport() {
            return {
                attachedDisk: mounted?.diskName ?? null,
                syncId: mounted?.applied?.syncId ?? null,
                syncedHeadSha: mounted?.applied?.headSha ?? null,
            };
        },
        epoch: () => epoch,
        /** Act on a heartbeat answer; `sentEpoch` is epoch() when the heartbeat was sent. Never waits. */
        onHeartbeatAnswer(answer, sentEpoch) {
            if (stopped || !answer || typeof answer !== "object") return;
            const fresh = sentEpoch === epoch;
            // One check per drive at a time; a drive being freed needs none.
            const queueFree = (diskName, rootSessionId) => {
                if (freeing.has(diskName) || queuedFrees.has(diskName)) return;
                queuedFrees.add(diskName);
                background(freeRecordedDrive(diskName, rootSessionId, sentEpoch).finally(() => queuedFrees.delete(diskName)));
            };
            if (fresh) releaseRequest = validReleaseRequest(answer.releaseRequested);
            if (releaseRequest && mounted?.diskName === releaseRequest.diskName) background(handleReleaseRequest(releaseRequest));
            else if (fresh && releaseRequest) queueFree(releaseRequest.diskName, null);
            const record = answer.attached && typeof answer.attached === "object" ? answer.attached : null;
            if (fresh && typeof record?.diskName === "string" && record.diskName && record.diskName !== mounted?.diskName
                && record.diskName !== releaseRequest?.diskName) {
                queueFree(record.diskName, typeof record.rootSessionId === "string" ? record.rootSessionId : null);
            }
            const grow = validExtendRequest(answer.extendRequested);
            if (grow) background(handleExtend(grow));
        },
        /**
         * The shutdown hook: wait for a release in flight (its offline and
         * detach), for at most shutdownWaitMs, then stop retrying.
         */
        async shutdown() {
            const unlock = await new Promise((resolve) => {
                let done = false;
                const timer = timers.setTimeout(() => { if (!done) { done = true; resolve(null); } }, opts.shutdownWaitMs);
                mutex.acquire().then((release) => {
                    if (done) { release(); return; }
                    done = true;
                    timers.clearTimeout(timer);
                    resolve(release);
                });
            });
            stopped = true;
            for (const entry of freeing.values()) {
                timers.clearTimeout(entry.timer);
                entry.timer = null;
            }
            unlock?.();
            return unlock !== null;
        },
        /** Wait for the work heartbeat answers started (tests). */
        async settle() {
            while (pending.size > 0) await Promise.allSettled([...pending]);
        },
        /** What the provider holds, for logs and tests. */
        state() {
            return {
                mounted: mounted ? {
                    rootSessionId: mounted.rootSessionId,
                    diskName: mounted.diskName,
                    folders: [...mounted.folders.keys()],
                    syncPending: Boolean(mounted.syncPending),
                    checkPending: checkPending(mounted),
                    applied: mounted.applied,
                } : null,
                freeing: [...freeing.values()].map((entry) => ({ diskName: entry.diskName, crashed: entry.crashed, attempt: entry.attempt })),
                preempting: preempting ? preempting.sessionId : null,
                lastPreemptedSessionId,
                releaseRequest,
                mutexLocked: mutex.locked,
            };
        },
    };
}
