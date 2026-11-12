/**
 * Owner routing's gates on PostgreSQL, with PilotSwarm workers, the real
 * Copilot CLI and the scripted model (docs/proposals/windows-worker-pool.md,
 * "Capacity requests" and "Children"): a tagged session's set-workspace
 * command asks for capacity before its check and caps the check; the fast
 * busy policy of a tagged and flagged session; the regeneration distiller's
 * service session takes the tree's tag; and the pending-shutdown path caps
 * the destroy of a tagged session.
 *
 * Sessions are owner-routed by the tag stored with their creation config.
 *
 * Run: npx vitest run test/local/owner-routing-gates.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { waitForSessionState } from "../helpers/cms-helpers.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import {
    activityName, eventually, executionInputs, OWNER_TAG, ownerOf, scheduledActivities, sessionHistory, turnWorkers, withOwnerCluster,
} from "../helpers/owner-routing-cluster.js";
import { SHUTDOWN_TIMEOUT_MS, WORKSPACE_CHECK_CAP_MS, WORKSPACE_RELEASE_CAP_MS } from "../../src/orchestration/state.ts";
import { REGEN_DISTILLER_SERVICE_KIND } from "../../src/distiller-tools.ts";

const TIMEOUT = 300_000;

/** A request's refusal, or a failure when it was not refused. */
async function refusal(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("expected a refusal");
}

/** The timer an orchestration created right after it scheduled `activity` the last time: the race's other half. */
function raceTimerAfter(history, activity) {
    const at = history.findLastIndex((e) => e.kind === "ActivityScheduled" && activityName(e) === activity);
    const timer = at >= 0 ? history.slice(at + 1).find((e) => e.kind === "TimerCreated") : undefined;
    return timer ? { scheduled: history[at], timer, fireAtMs: JSON.parse(timer.data).fireAtMs } : undefined;
}

/**
 * Fire a durable timer now. The set-workspace check's cap is 20 minutes; the
 * test moves its TimerFired message up in Duroxide's queue instead of waiting.
 */
async function fireTimerNow(env, instanceId, fireAtMs) {
    const db = new pg.Client({ connectionString: env.store });
    await db.connect();
    try {
        const { rowCount } = await db.query(
            `UPDATE "${env.duroxideSchema}".orchestrator_queue SET visible_at = now()
              WHERE instance_id = $1 AND work_item::jsonb -> 'TimerFired' ->> 'fire_at_ms' = $2`,
            [instanceId, String(fireAtMs)],
        );
        return rowCount;
    } finally {
        await db.end();
    }
}

describe("owner routing gates", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("asks for capacity before a tagged session's set-workspace check: deny and busy keep the workspace, ok runs the check on the owner's worker, and the 20-minute cap answers WORKSPACE_BUSY for a check no worker of the owner takes", async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-owner-ws-")));
        for (const folder of ["repo-x", "repo-y"]) fs.mkdirSync(path.join(root, folder));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        let answer = { decision: "ok" };
        try {
            await withOwnerCluster(env, { respond: () => ({ content: "ok" }), capacity: () => answer }, async ({ startWorker, stopWorker, startClients, client, mgmt, catalog, asked, qualifiedModel }) => {
                await startWorker("coordinator", { requester: true });
                await startWorker("owner-a", { ownerTag: OWNER_TAG.a, workspaceProvider: provider });
                await startClients();
                const session = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), ownerTag: OWNER_TAG.a });
                const sessionId = session.sessionId;
                expect(await session.sendAndWait("first turn", TIMEOUT)).toBe("ok");
                const set = (folder, expectedRevision) => mgmt.setSessionWorkspace(sessionId, { expectedRevision, workspace: { root: "a", folder } });
                const checks = async () => (await scheduledActivities(client, sessionId)).filter((name) => name === "checkWorkspace").length;

                answer = { decision: "deny", code: "NO_DRIVE_LEASE", message: "This root holds no drive lease." };
                const denied = await refusal(set("repo-x", 0));
                expect([denied.code, denied.revision]).toEqual(["NO_DRIVE_LEASE", 0]);
                expect(denied.message).toContain("This root holds no drive lease.");
                answer = { decision: "busy", message: "The drive is parked.", retryAfterMs: 900_000 };
                const busy = await refusal(set("repo-x", 0));
                expect([busy.code, busy.revision]).toEqual(["WORKSPACE_BUSY", 0]);
                expect(busy.message).toContain("The drive is parked.");
                expect(await checks()).toBe(0);
                expect(provider.callsFor("ensureAttached", { sessionId })).toEqual([]);

                answer = { decision: "ok" };
                expect(await set("repo-x", 0)).toMatchObject({ status: "changed", revision: 1, workspace: { root: "a", folder: "repo-x" } });
                expect(provider.callsFor("ensureAttached", { sessionId }).map((call) => call.workerNodeId)).toEqual(["owner-a"]);

                // No worker of the owner: the check waits, raced against the cap.
                await stopWorker("owner-a");
                const pending = refusal(set("repo-y", 1));
                const race = await eventually(async () => (await checks()) === 2 && raceTimerAfter(await sessionHistory(client, sessionId), "checkWorkspace"), "the capped check");
                expect(race.fireAtMs - race.timer.timestampMs).toBe(WORKSPACE_CHECK_CAP_MS);
                expect(await fireTimerNow(env, `session-${sessionId}`, race.fireAtMs)).toBe(1);
                const capped = await pending;
                expect([capped.code, capped.revision]).toEqual(["WORKSPACE_BUSY", 1]);
                expect(capped.message).toContain("did not finish within 20 minutes");

                // Each command asked first, on the coordinator, for the session's root.
                const scheduled = (await scheduledActivities(client, sessionId)).filter((name) => ["requestOwnerCapacity", "checkWorkspace"].includes(name));
                expect(scheduled).toEqual([
                    "requestOwnerCapacity", // the first turn
                    "requestOwnerCapacity", // deny
                    "requestOwnerCapacity", // busy
                    "requestOwnerCapacity", "checkWorkspace", // ok
                    "requestOwnerCapacity", "checkWorkspace", // the cap
                ]);
                expect(asked(sessionId).map((r) => [r.worker, r.request])).toEqual(
                    Array(5).fill(["coordinator", { sessionId, rootSessionId: sessionId, ownerTag: OWNER_TAG.a }]),
                );

                // The capped check freed the session for its next command.
                await mgmt.completeSession(sessionId, "done after the capped check", { wait: false });
                expect((await waitForSessionState(catalog, sessionId, ["completed"], 60_000)).state).toBe("completed");
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, TIMEOUT);

    it("releases the worker of a tagged session with the fast busy policy on its first WORKSPACE_BUSY capacity answer and asks again after 10 s, then 20 s; a tagged session without the policy keeps its worker and asks again after 30 s", async () => {
        const env = getEnv();
        const busyAnswers = new Map();
        const capacity = (request) => {
            const left = busyAnswers.get(request.sessionId) ?? 0;
            if (left === 0) return { decision: "ok" };
            busyAnswers.set(request.sessionId, left - 1);
            return { decision: "busy", message: "The owner's worker is starting." };
        };
        const respond = (_body, position) => ({ content: `ok:${position.lastUserText.slice(0, 16)}` });
        await withOwnerCluster(env, { respond, capacity }, async ({ startWorker, startClients, client, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", { requester: true });
            await startWorker("owner-a", { ownerTag: OWNER_TAG.a });
            await startClients();
            const fast = await client.createSession({
                sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), ownerTag: OWNER_TAG.a, workspaceBusyFastRelease: true,
            });
            const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), ownerTag: OWNER_TAG.a });
            busyAnswers.set(fast.sessionId, 2);
            busyAnswers.set(plain.sessionId, 1);
            await Promise.all([fast.send("fast policy"), plain.send("default policy")]);
            for (const session of [fast, plain]) {
                await eventually(async () => (await turnWorkers(catalog, session.sessionId)).length > 0, "the turn after the busy answers", 120_000);
                await waitForSessionState(catalog, session.sessionId, ["idle"], 60_000);
            }

            const gaps = (sessionId) => asked(sessionId).map((r) => r.at).slice(1).map((at, i) => at - asked(sessionId)[i].at);
            const slack = testTime.ms(5_000);
            console.log(`  fast policy: asked again after ${gaps(fast.sessionId).join(", ")} ms; default policy: after ${gaps(plain.sessionId).join(", ")} ms`);
            expect(gaps(fast.sessionId)).toHaveLength(2);
            const [first, second] = gaps(fast.sessionId);
            expect(first).toBeGreaterThanOrEqual(10_000);
            expect(first).toBeLessThan(10_000 + slack);
            expect(second).toBeGreaterThanOrEqual(20_000);
            expect(second).toBeLessThan(20_000 + slack);
            expect(gaps(plain.sessionId)).toHaveLength(1);
            expect(gaps(plain.sessionId)[0]).toBeGreaterThanOrEqual(30_000);
            expect(gaps(plain.sessionId)[0]).toBeLessThan(30_000 + slack);

            const releases = async (sessionId) => (await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.affinity_released"]))
                .map((e) => e.data)
                .filter((data) => data.reason === "workspace_unavailable");
            expect(await releases(fast.sessionId)).toEqual([
                expect.objectContaining({ code: "WORKSPACE_BUSY", failures: 1 }),
                expect.objectContaining({ code: "WORKSPACE_BUSY", failures: 1 }),
            ]);
            expect(await releases(plain.sessionId)).toEqual([]);
            expect((await executionInputs(client, fast.sessionId))[0]).toMatchObject({ ownerTag: OWNER_TAG.a, workspaceBusyFastRelease: true });
            expect((await executionInputs(client, plain.sessionId))[0]).not.toHaveProperty("workspaceBusyFastRelease");
            expect(await turnWorkers(catalog, fast.sessionId)).toEqual(["owner-a"]);
            expect(await turnWorkers(catalog, plain.sessionId)).toEqual(["owner-a"]);
        });
    }, TIMEOUT);

    it("gives the regeneration distiller's service session the tagged tree's owner tag and busy policy: it asks for capacity for the tree's root and its turn runs on the owner's worker", async () => {
        const env = getEnv();
        const respond = (_body, position) => ({ content: `ok:${position.lastUserText.slice(0, 16)}` });
        await withOwnerCluster(env, { respond }, async ({ startWorker, startClients, client, mgmt, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", { requester: true });
            await startWorker("owner-a", { ownerTag: OWNER_TAG.a });
            await startClients();
            const root = await client.createSession({
                sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), ownerTag: OWNER_TAG.a, workspaceBusyFastRelease: true,
            });
            expect(await root.sendAndWait("before the regeneration", TIMEOUT)).toContain("ok:");
            await waitForSessionState(catalog, root.sessionId, ["idle"], 60_000);

            await mgmt.regenerateSession(root.sessionId, { force: true });
            const distiller = await eventually(async () => (await catalog.listSessions())
                .find((row) => row.serviceKind === REGEN_DISTILLER_SERVICE_KIND && row.serviceOf === root.sessionId), "the distiller session");
            await eventually(async () => (await turnWorkers(catalog, distiller.sessionId)).length > 0, "the distiller's turn");
            const [committed] = await eventually(async () => {
                const events = await catalog.getSessionEvents(root.sessionId, undefined, 1000, ["session.epoch_committed", "session.regenerate_failed"]);
                return events.length > 0 ? events : null;
            }, "the end of the regeneration", 180_000);
            expect(committed.eventType).toBe("session.epoch_committed");

            expect(distiller.parentSessionId).toBe(root.sessionId);
            expect(await catalog.getSessionCreationConfig(distiller.sessionId)).toMatchObject({ ownerTag: OWNER_TAG.a, workspaceBusyFastRelease: true });
            expect((await executionInputs(client, distiller.sessionId))[0]).toMatchObject({
                ownerTag: OWNER_TAG.a, workspaceBusyFastRelease: true, parentSessionId: root.sessionId,
            });
            expect(asked(distiller.sessionId)[0]).toMatchObject({
                worker: "coordinator",
                request: { sessionId: distiller.sessionId, rootSessionId: root.sessionId, ownerTag: OWNER_TAG.a },
            });
            expect(new Set(await turnWorkers(catalog, distiller.sessionId))).toEqual(new Set(["owner-a"]));
        });
    }, TIMEOUT);

    it("ends a tagged parent whose child never settles as failed at the shutdown deadline, its destroy capped while no worker of its owner runs", async () => {
        const env = getEnv();
        let parentId = null;
        // The parent waits on its busy timer, where commands reach it; the
        // child's turn waits in the queue for a worker that never comes.
        const capacity = (request) => (request.sessionId === parentId
            ? { decision: "busy", message: "The owner's worker is starting.", retryAfterMs: 600_000 }
            : { decision: "ok" });
        await withOwnerCluster(env, { respond: () => ({ content: "ok" }), capacity }, async ({ startWorker, startClients, client, mgmt, catalog, qualifiedModel }) => {
            // No worker declares owner c's tag.
            await startWorker("coordinator", { requester: true });
            await startClients();
            parentId = randomUUID();
            const parent = await client.createSession({ sessionId: parentId, model: qualifiedModel, owner: ownerOf("c"), ownerTag: OWNER_TAG.c });
            await parent.send("wait for the owner's worker");
            await waitForSessionState(catalog, parentId, ["waiting"], 60_000);
            const child = await client.createSession({
                sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("c"), parentSessionId: parentId, nestingLevel: 1, ownerTag: OWNER_TAG.c,
            });
            await child.send("the child's turn waits in the queue");
            await eventually(async () => (await scheduledActivities(client, child.sessionId)).includes("runTurnV5"), "the child's queued turn");

            const sentAt = Date.now();
            await mgmt.completeSession(parentId, "done while the child's turn waits", { wait: false });
            const failed = await waitForSessionState(catalog, parentId, ["failed"], SHUTDOWN_TIMEOUT_MS + 60_000);
            const elapsed = Date.now() - sentAt;
            console.log(`  the parent failed ${elapsed} ms after done`);
            expect(failed.lastError).toContain(`timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s waiting for 1 child session(s)`);
            // The deadline, then the whole cap: no worker of the owner ran the destroy.
            expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS + WORKSPACE_RELEASE_CAP_MS);
            expect(elapsed).toBeLessThan(SHUTDOWN_TIMEOUT_MS + WORKSPACE_RELEASE_CAP_MS + testTime.ms(15_000));

            // The destroy no worker took lost its race to the 10-second cap.
            const history = await sessionHistory(client, parentId);
            const race = raceTimerAfter(history, "destroySession");
            expect(race.fireAtMs - race.timer.timestampMs).toBe(WORKSPACE_RELEASE_CAP_MS);
            const finished = new Set(history.filter((e) => /^Activity(Completed|Failed)$/.test(e.kind)).map((e) => e.sourceEventId));
            expect(finished.has(race.scheduled.eventId)).toBe(false);
            expect(await scheduledActivities(client, parentId)).not.toContain("runTurnV5");
        });
    }, TIMEOUT);
});
