/**
 * Owner routing on PostgreSQL with Duroxide when workers die, hold sessions
 * or lose races (docs/proposals/windows-worker-pool.md, "What our local tests
 * showed"): the routing of an owner-tagged session's activities holds after
 * its worker is killed outright, while it runs an activity or an
 * orchestration turn; a worker with an owner tag also runs untagged and
 * capability-tagged work; a live holder keeps its session from workers whose
 * filter admits an activity its own filter doesn't; and a destroy that already
 * runs finishes although it lost its race.
 *
 * Bare Duroxide runtimes run PilotSwarm's session proxies and worker filter,
 * here and in a child process (helpers/owner-routing-runtime.mjs). Both load
 * the built dist/ code, so they replay each other's histories.
 *
 * Run: npx vitest run test/local/owner-routing-durability.test.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createTestEnv, testTime } from "../helpers/local-env.js";
import { forkOwnerRuntime, PROBE_ACTIVITIES, PROBE_ANSWERS, registerOwnerProbes } from "../helpers/owner-routing-runtime.mjs";
import * as proxies from "../../dist/session-proxy.js";
import {
    AGENT_HANDOFF_CAPABILITY, OWNER_CAPACITY_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY, WORKSPACE_CAPABILITY,
    workerTagFilter,
} from "../../dist/activity-routing.js";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

const TIMEOUT = 300_000;
const TAG = {
    a: "owner.6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01",
    b: "owner.9d2e4c71-3b6a-4f0d-8e25-5c8a1f6b7e02",
    c: "owner.2a7b9e13-6c4d-4b1f-a3e8-7d5c0f9b4e03",
};
/** PilotSwarm's worker lock and session idle timeout; no session lock, so Duroxide's 30 seconds apply. */
const RUNTIME_OPTIONS = {
    orchestrationConcurrency: 1,
    workerConcurrency: 2,
    dispatcherPollIntervalMs: 20,
    workerLockTimeoutMs: 10_000,
    sessionIdleTimeoutMs: 3_600_000,
};
const DUROXIDE_SESSION_LOCK_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, what, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** The events of an orchestration's history, every execution. */
async function historyOf(client, instanceId) {
    const events = [];
    for (const executionId of await client.listExecutions(instanceId)) {
        events.push(...await client.readExecutionHistory(instanceId, executionId));
    }
    return events;
}

/** Duroxide never delivers an event raised before the orchestration waits for it. */
async function waitsFor(client, instanceId, name) {
    return (await historyOf(client, instanceId)).some((e) => e.kind === "ExternalSubscribed" && JSON.parse(e.data).name === name);
}

/** The activities an orchestration scheduled, in order. An ActivityScheduled event's data is not always valid JSON past the name. */
async function scheduled(client, instanceId) {
    return (await historyOf(client, instanceId))
        .filter((e) => e.kind === "ActivityScheduled")
        .map((e) => /^\{"name":"([^"]+)"/.exec(e.data ?? "")?.[1]);
}

/**
 * PilotSwarm's destroySession activity from dist/, on a session manager that
 * the test plays: registerActivities wires the handler that workers run.
 */
function pilotSwarmDestroySession(sessionManager) {
    const handlers = {};
    proxies.registerActivities({ registerActivity: (name, handler) => { handlers[name] = handler; } }, sessionManager, null);
    return handlers.destroySession;
}

/**
 * Runtimes on one test schema: `start` runs one in this process, `spawn` one
 * in a child process that the test can kill. Every activity a runtime starts
 * is recorded in `executions`; `turns` records which runtime of this process
 * ran the turn after "owner-turn-kill"'s "go" event.
 */
async function withRuntimes(label, body) {
    const env = createTestEnv(label);
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const executions = [];
    const turns = [];
    const runtimes = new Map();
    const children = [];
    const record = (worker, ctx, name, input) => {
        executions.push({ worker, name, tag: ctx.tag(), sessionId: input?.sessionId, kind: input?.kind, at: Date.now() });
    };
    async function start(id, filter, { runtimeOptions = {}, activities = {} } = {}) {
        const runtime = new Runtime(provider, {
            ...RUNTIME_OPTIONS,
            workerNodeId: `${env.runId}-${id}`,
            workerTagFilter: filter,
            logLevel: "error",
            ...runtimeOptions,
        });
        registerOwnerProbes(runtime, proxies, { afterGo: () => turns.push(id) });
        for (const name of PROBE_ACTIVITIES) {
            runtime.registerActivity(name, async (ctx, input) => {
                record(id, ctx, name, input);
                return activities[name] ? activities[name](ctx, input) : PROBE_ANSWERS[name] ?? null;
            });
        }
        await runtime.start();
        runtimes.set(id, runtime);
    }
    async function stop(id) {
        await runtimes.get(id)?.shutdown(3_000).catch(() => {});
        runtimes.delete(id);
    }
    function spawn(id, filter, { runtimeOptions = {}, ...options } = {}) {
        const child = forkOwnerRuntime(env, id, {
            ...options,
            filter,
            runtimeOptions: { ...RUNTIME_OPTIONS, ...runtimeOptions },
            onRan: (ran) => executions.push(ran),
        });
        children.push(child);
        return child;
    }
    const ran = (sessionId) => executions.filter((e) => e.sessionId === sessionId && e.name !== "requestOwnerCapacity");
    try {
        await body({ env, client, executions, turns, start, stop, spawn, ran, timeoutMs: 120_000 });
    } finally {
        for (const child of children) await child.kill().catch(() => {});
        for (const id of [...runtimes.keys()].reverse()) await stop(id);
        await env.cleanup();
    }
}

describe("owner routing when workers die, hold sessions or lose races", () => {
    it("moves a session whose holder was killed outright during an activity to its owner's other worker once the session lock lapses, about 30 seconds later, and never to another worker", async () => {
        await withRuntimes("owner_kill", async ({ client, executions, start, spawn, ran, timeoutMs }) => {
            await start("owner-b", workerTagFilter({ ownerTag: TAG.b }));
            await start("capacity", workerTagFilter({ ownerCapacity: true }));
            // The owner's only worker at first, in a child process: its
            // workspace check starts and never ends.
            const holder = spawn("owner-a", workerTagFilter({ ownerTag: TAG.a }), { block: { name: "checkWorkspace", sessionId: "sk" } });
            await holder.ready;
            await client.startOrchestration("hold-k", "owner-hold", { sessionId: "sk", ownerTag: TAG.a });
            const check = await eventually(() => ran("sk").find((e) => e.name === "checkWorkspace"), "the workspace check on the holder");

            // Another worker of the owner, with another ID, then the kill.
            await start("owner-a2", workerTagFilter({ ownerTag: TAG.a }));
            const killedAt = Date.now();
            await holder.kill();
            expect((await client.waitForOrchestration("hold-k", timeoutMs)).status).toBe("Completed");

            const retried = ran("sk").filter((e) => e.name === "checkWorkspace")[1];
            console.log(`  the check ran again ${retried.at - check.at} ms after it started on the killed holder, ${retried.at - killedAt} ms after the kill`);
            expect(ran("sk").map((e) => `${e.worker} ${e.name}`)).toEqual([
                "owner-a runTurnV5", "owner-a hydrateSession", "owner-a checkWorkspace",
                "owner-a2 checkWorkspace", "owner-a2 releaseWorkspace", "owner-a2 runTurnV5", "owner-a2 destroySession",
            ]);
            expect(ran("sk").every((e) => e.tag === TAG.a)).toBe(true);
            // Claiming the check locked the session for Duroxide's 30 seconds;
            // nothing renews that lock after the kill, and nothing releases it.
            expect(retried.at - check.at).toBeGreaterThanOrEqual(DUROXIDE_SESSION_LOCK_MS - 1_000);
            expect(retried.at - check.at).toBeLessThan(DUROXIDE_SESSION_LOCK_MS + testTime.ms(10_000));
            expect(executions.filter((e) => e.name === "requestOwnerCapacity").map((e) => `${e.worker} ${e.tag}`))
                .toEqual([`capacity ${OWNER_CAPACITY_CAPABILITY}`]);
        });
    }, TIMEOUT);

    it("replays an orchestration turn whose worker was killed in it on another worker, which sends the owner-tagged activities to the owner's worker only", async () => {
        await withRuntimes("owner_turn_kill", async ({ env, client, turns, start, spawn, ran, timeoutMs }) => {
            const marker = path.join(env.baseDir, "owner-turn-kill.marker");
            // At first the only runtime, so it runs the orchestration's turns;
            // the turn that receives "go" writes the marker and holds.
            const host = spawn("host", workerTagFilter({}), { turnMarker: marker, runtimeOptions: { orchestratorLockTimeoutMs: 5_000 } });
            await host.ready;
            await client.startOrchestration("turn-e", "owner-turn-kill", { sessionId: "se", ownerTag: TAG.a });
            await eventually(() => waitsFor(client, "turn-e", "go"), "the wait for go");
            await client.raiseEvent("turn-e", "go", {});
            await eventually(() => fs.existsSync(marker), "the turn that received go");

            await start("owner-a", workerTagFilter({ ownerTag: TAG.a }));
            await start("owner-b", workerTagFilter({ ownerTag: TAG.b }));
            await sleep(2_000);
            // The held turn committed nothing, and no other runtime took it.
            expect(await scheduled(client, "turn-e")).toEqual([]);
            expect(turns).toEqual([]);
            await host.kill();

            expect((await client.waitForOrchestration("turn-e", timeoutMs)).status).toBe("Completed");
            expect(turns.length).toBeGreaterThan(0);
            expect(turns.every((id) => id === "owner-a" || id === "owner-b")).toBe(true);
            expect(await scheduled(client, "turn-e")).toEqual(["runTurnV5", "destroySession"]);
            expect(ran("se").map((e) => `${e.worker} ${e.name} ${e.tag}`)).toEqual([
                `owner-a runTurnV5 ${TAG.a}`, `owner-a destroySession ${TAG.a}`,
            ]);
        });
    }, TIMEOUT);

    it("runs untagged, capability-tagged and its own owner's work on a worker with the four capability tags and an owner tag, never another owner's or a capacity request; with the capacity tag instead, no owner's", async () => {
        const KINDS = [
            { kind: "untagged" },
            { kind: "handoff", tag: AGENT_HANDOFF_CAPABILITY },
            { kind: "workspaces", tag: WORKSPACE_CAPABILITY },
            { kind: "turn-control", tag: TURN_CONTROL_CAPABILITY },
            { kind: "workflow-request", tag: WORKFLOW_REQUEST_CAPABILITY },
            { kind: "owner a", tag: TAG.a },
            { kind: "owner b", tag: TAG.b },
            { kind: "capacity", tag: OWNER_CAPACITY_CAPABILITY },
        ];
        const SHARED = ["untagged", "handoff", "workspaces", "turn-control", "workflow-request"];
        await withRuntimes("owner_kinds", async ({ client, executions, start, stop, timeoutMs }) => {
            const runsOf = (prefix) => Object.fromEntries(executions
                .filter((e) => e.kind?.startsWith(prefix))
                .map((e) => [e.kind.slice(prefix.length), e.worker]));
            const probe = (instanceId, prefix) => client.startOrchestration(instanceId, "owner-filter-kinds", {
                kinds: KINDS.map(({ kind, tag }) => ({ kind: `${prefix}${kind}`, tag })),
            });

            const ownerFilter = workerTagFilter({ ownerTag: TAG.a });
            const capacityFilter = workerTagFilter({ ownerCapacity: true });
            expect(ownerFilter.defaultAnd).toHaveLength(5);
            expect(capacityFilter.defaultAnd).toHaveLength(5);

            // Only owner a's worker: it runs six kinds, two wait.
            await start("owner-a", ownerFilter);
            await probe("kinds-owner", "1:");
            await eventually(() => Object.keys(runsOf("1:")).length >= 6, "the owner worker's kinds");
            await sleep(3_000);
            expect(runsOf("1:")).toEqual(Object.fromEntries([...SHARED, "owner a"].map((kind) => [kind, "owner-a"])));
            await start("owner-b", workerTagFilter({ ownerTag: TAG.b }));
            await start("capacity", capacityFilter);
            expect((await client.waitForOrchestration("kinds-owner", timeoutMs)).status).toBe("Completed");
            expect(runsOf("1:")).toMatchObject({ "owner b": "owner-b", capacity: "capacity" });

            // Only the capacity worker: it runs six kinds, the owners' wait.
            await stop("owner-a");
            await stop("owner-b");
            await probe("kinds-capacity", "2:");
            await eventually(() => Object.keys(runsOf("2:")).length >= 6, "the capacity worker's kinds");
            await sleep(3_000);
            expect(runsOf("2:")).toEqual(Object.fromEntries([...SHARED, "capacity"].map((kind) => [kind, "capacity"])));
            await start("owner-a", ownerFilter);
            await start("owner-b", workerTagFilter({ ownerTag: TAG.b }));
            expect((await client.waitForOrchestration("kinds-capacity", timeoutMs)).status).toBe("Completed");
            expect(runsOf("2:")).toMatchObject({ "owner a": "owner-a", "owner b": "owner-b" });
            expect(executions.filter((e) => e.kind).length).toBe(2 * KINDS.length);
        });
    }, TIMEOUT);

    it("keeps a session on its live holder: a session-scoped activity that the holder's filter doesn't admit waits instead of running on a worker that admits it, until the holder idles the session out or stops", async () => {
        // A short lock, so waiting longer than two of its renewals stays quick.
        const runtimeOptions = { sessionLockTimeoutMs: 5_000 };
        await withRuntimes("owner_holder", async ({ client, start, stop, ran, timeoutMs }) => {
            // Owner a's holder keeps sessions for PilotSwarm's hour; owner c's
            // idles them out after 8 seconds.
            await start("owner-a", workerTagFilter({ ownerTag: TAG.a, ownerOnly: true }), { runtimeOptions });
            await start("owner-c", workerTagFilter({ ownerTag: TAG.c, ownerOnly: true }), { runtimeOptions: { ...runtimeOptions, sessionIdleTimeoutMs: 8_000 } });
            await start("default", workerTagFilter({}), { runtimeOptions });
            await client.startOrchestration("follow-a", "owner-untagged-follow-up", { sessionId: "fa", ownerTag: TAG.a });
            await client.startOrchestration("follow-c", "owner-untagged-follow-up", { sessionId: "fc", ownerTag: TAG.c });
            const turnA = await eventually(() => ran("fa").find((e) => e.name === "runTurnV5"), "owner a's turn");
            const turnC = await eventually(() => ran("fc").find((e) => e.name === "runTurnV5"), "owner c's turn");
            expect([turnA.worker, turnC.worker]).toEqual(["owner-a", "owner-c"]);

            // Owner c's session idles out on its live holder, then moves.
            const movedC = await eventually(() => ran("fc").find((e) => e.name === "hydrateSession"), "owner c's untagged follow-up", 60_000);
            console.log(`  owner c's follow-up ran ${movedC.at - turnC.at} ms after its turn`);
            expect(movedC.worker).toBe("default");
            expect(movedC.at - turnC.at).toBeGreaterThanOrEqual(8_000);
            expect((await client.waitForOrchestration("follow-c", timeoutMs)).status).toBe("Completed");

            // Owner a's live holder still keeps its session, three lock periods on.
            await sleep(Math.max(0, turnA.at + 3 * runtimeOptions.sessionLockTimeoutMs - Date.now()));
            expect(ran("fa").map((e) => e.name)).toEqual(["runTurnV5"]);
            expect((await client.getStatus("follow-a")).status).toBe("Running");
            const stoppedAt = Date.now();
            await stop("owner-a");
            expect((await client.waitForOrchestration("follow-a", timeoutMs)).status).toBe("Completed");
            const movedA = ran("fa").find((e) => e.name === "hydrateSession");
            expect(movedA.worker).toBe("default");
            expect(movedA.tag).toBeNull();
            expect(movedA.at).toBeGreaterThanOrEqual(stoppedAt);
        });
    }, TIMEOUT);

    it("lets a destroy that already runs on the owner's worker finish after it lost its race: Duroxide flags it cancelled at its next lock renewal, and PilotSwarm's destroySession doesn't check", async () => {
        await withRuntimes("owner_destroy_runs", async ({ client, start, ran, timeoutMs }) => {
            const samples = [];
            const destroy = {};
            let activityCtx;
            const destroySession = pilotSwarmDestroySession({
                releaseWorkspace: async () => ({ released: false }),
                // Longer than the cap and than one renewal of the 10-second lock.
                destroySession: async () => {
                    destroy.startedAt = Date.now();
                    while (Date.now() - destroy.startedAt < 8_000) {
                        samples.push({ at: Date.now(), cancelled: activityCtx.isCancelled() });
                        await sleep(100);
                    }
                    destroy.finishedAt = Date.now();
                },
            });
            await start("owner-a", workerTagFilter({ ownerTag: TAG.a }), {
                activities: { destroySession: (ctx, input) => { activityCtx = ctx; return destroySession(ctx, input); } },
            });
            await client.startOrchestration("race-d", "owner-destroy-race", { sessionId: "sd", ownerTag: TAG.a, capMs: 1_000 });
            const result = await client.waitForOrchestration("race-d", timeoutMs);
            expect(result.status).toBe("Completed");
            expect(typeof result.output === "string" ? JSON.parse(result.output) : result.output).toBe(1);
            await eventually(() => destroy.finishedAt, "the end of the destroy", 30_000);

            // When the timer won, as Duroxide recorded it.
            const endedAt = (await historyOf(client, "race-d")).find((e) => e.kind === "OrchestrationCompleted").timestampMs;
            const flagged = samples.find((s) => s.cancelled);
            console.log(`  the race ended ${endedAt - destroy.startedAt} ms into the destroy; cancelled flagged at ${flagged ? `${flagged.at - destroy.startedAt} ms` : "never"}; destroy finished at ${destroy.finishedAt - destroy.startedAt} ms`);
            expect(destroy.startedAt).toBeLessThan(endedAt);
            expect(samples.filter((s) => s.at <= endedAt).every((s) => !s.cancelled)).toBe(true);
            expect(flagged?.at).toBeGreaterThan(endedAt);
            // Flagged at a renewal of the 10-second lock, half its timeout after the claim, not when the race ended.
            expect(flagged.at - destroy.startedAt).toBeGreaterThanOrEqual(4_000);
            expect(destroy.finishedAt).toBeGreaterThan(flagged.at);
            expect(ran("sd").map((e) => `${e.worker} ${e.name} ${e.tag}`)).toEqual([`owner-a destroySession ${TAG.a}`]);
        });
    }, TIMEOUT);
});
