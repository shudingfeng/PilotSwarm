/**
 * The VM's 15-second heartbeat to the disk controller (README, "The
 * heartbeat"). The launcher that starts the worker may send heartbeats
 * before the extension loads; the extension takes them over in register():
 * it sends its own first, then stops the launcher's through the hand-over
 * slot, so the controller sees no gap.
 *
 * A launcher that sends heartbeats puts an object with a stop() method in
 * globalThis[Symbol.for("pilotswarm.devdrive.heartbeat-handover")].
 */
import os from "node:os";

export const HEARTBEAT_HANDOVER = Symbol.for("pilotswarm.devdrive.heartbeat-handover");
export const HEARTBEAT_INTERVAL_MS = 15_000;

const defaultTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
};

/**
 * @param {object} options
 * @param {{ heartbeat: Function }} options.controller
 * @param {{ heartbeatReport: Function, epoch: Function }} options.drive
 * @param {{ getActiveWorkloadCount: Function }} options.worker
 * @param {string} options.launchId          PS_LAUNCH_ID, or a new ID for this start
 * @param {string|null} [options.configVersion]
 * @param {() => Promise<{ sizeBytes: number, freeBytes: number }>} options.volumeInfo   the drive's volume (Q:)
 * @param {(answer: object, sentEpoch: number) => void} options.onAnswer   must not wait
 * @param {string} [options.vmName]          reported only; the controller knows the VM by its address
 * @param {number} [options.intervalMs]
 * @param {{ setTimeout: Function, clearTimeout: Function, now: () => number }} [options.timers]
 * @param {(message: string) => void} [options.log]
 */
export function createHeartbeat({
    controller, drive, worker, launchId, configVersion = null, volumeInfo, onAnswer,
    vmName = os.hostname(), intervalMs = HEARTBEAT_INTERVAL_MS, timers = defaultTimers, log = () => {},
}) {
    let timer = null;
    let running = false;
    let inFlight = null;
    let draining = false;
    let failures = 0;

    async function beat() {
        const sentEpoch = drive.epoch();
        const report = drive.heartbeatReport();
        let sizeBytes = null;
        let freeBytes = null;
        if (report.attachedDisk) {
            try {
                const volume = await volumeInfo();
                if (Number.isSafeInteger(volume?.sizeBytes) && Number.isSafeInteger(volume?.freeBytes)) {
                    sizeBytes = volume.sizeBytes;
                    freeBytes = volume.freeBytes;
                }
            } catch { /* reported as unknown */ }
        }
        let activeWorkloadCount = null;
        try { activeWorkloadCount = await worker.getActiveWorkloadCount(); } catch { /* reported as unknown */ }
        const body = {
            vmName,
            launchId,
            phase: "running",
            attachedDisk: report.attachedDisk,
            attachedDiskSizeBytes: sizeBytes,
            attachedDiskFreeBytes: freeBytes,
            activeWorkloadCount,
            draining,
            configVersion,
            syncId: report.syncId,
            syncedHeadSha: report.syncedHeadSha,
        };
        let answer;
        try {
            answer = await controller.heartbeat(body);
        } catch (error) {
            failures += 1;
            // Every failure would flood the log during a controller outage.
            if (failures === 1 || failures % 20 === 0) log(`devdrive: heartbeat failed (${failures} in a row): ${error?.message ?? error}`);
            return null;
        }
        if (failures > 0) log(`devdrive: heartbeat answered again after ${failures} failure(s)`);
        failures = 0;
        try {
            onAnswer(answer, sentEpoch);
        } catch (error) {
            log(`devdrive: acting on a heartbeat answer failed: ${error?.message ?? error}`);
        }
        return answer;
    }

    function schedule(startedAt) {
        if (!running) return;
        timer = timers.setTimeout(tick, Math.max(0, startedAt + intervalMs - timers.now()));
    }

    function tick() {
        timer = null;
        if (!running) return;
        const startedAt = timers.now();
        inFlight = beat().finally(() => {
            inFlight = null;
            schedule(startedAt);
        });
    }

    return {
        /** The first heartbeat now, then one every interval. Resolves with the first answer (null when it failed). */
        async start() {
            if (running) return null;
            running = true;
            const startedAt = timers.now();
            inFlight = beat();
            let first = null;
            try {
                first = await inFlight;
            } finally {
                inFlight = null;
                schedule(startedAt);
            }
            return first;
        },
        async stop() {
            running = false;
            timers.clearTimeout(timer);
            timer = null;
            await Promise.resolve(inFlight).catch(() => {});
        },
        setDraining(value) {
            draining = Boolean(value);
        },
        get draining() {
            return draining;
        },
        get running() {
            return running;
        },
        /** One heartbeat now (tests). */
        beat,
    };
}

/** Stop the heartbeat a launcher started before the extension loaded, if there is one. */
export async function takeOverHeartbeat(log = () => {}, { timeoutMs = 10_000 } = {}) {
    const handover = globalThis[HEARTBEAT_HANDOVER];
    if (!handover) return false;
    delete globalThis[HEARTBEAT_HANDOVER];
    let timer;
    try {
        // A launcher that does not stop in time must not keep the worker from starting.
        await Promise.race([
            Promise.resolve().then(() => handover.stop?.()),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
        ]);
        return true;
    } catch (error) {
        log(`devdrive: stopping the launcher's heartbeat failed: ${error?.message ?? error}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
