/**
 * Owner routing on PostgreSQL with Duroxide: an owner-tagged session's
 * activities run only on its owner's workers, and at once on its worker
 * restarted under the same ID; capacity requests run only on workers with a
 * capacity requester, and lifecycle commands still end a session whose owner
 * has no worker.
 *
 * The first block runs PilotSwarm's session proxies and worker filter on bare
 * Duroxide runtimes. The second runs PilotSwarm workers with the real Copilot
 * CLI and the scripted model, so it needs no model token.
 *
 * Run: npx vitest run test/local/owner-routing.test.js
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestEnv, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { PilotSwarmClient, PilotSwarmManagementClient, PilotSwarmWorker } from "../../src/index.ts";
import { createSessionManagerProxy, createSessionProxy } from "../../src/session-proxy.ts";
import { OWNER_CAPACITY_CAPABILITY, workerTagFilter } from "../../src/activity-routing.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

const TIMEOUT = 300_000;
const SUBJECT = {
    a: "6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01",
    b: "9d2e4c71-3b6a-4f0d-8e25-5c8a1f6b7e02",
    c: "2a7b9e13-6c4d-4b1f-a3e8-7d5c0f9b4e03",
};
const TAG = Object.fromEntries(Object.entries(SUBJECT).map(([who, subject]) => [who, `owner.${subject}`]));
const OWNER = (who) => ({ provider: "test", subject: SUBJECT[who], displayName: `user ${who}` });
const WORKSPACE = { schema: 1, root: "repos", folder: "app" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, what, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
}

function parsed(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

describe("owner routing on Duroxide runtimes", () => {
    // Schedules what 1.0.84 schedules for an owner-tagged session, through
    // PilotSwarm's own proxies. With `pause`, it waits for the "go" event
    // after the workspace check, so a test can restart a worker there.
    function* probe(ctx, input) {
        const manager = createSessionManagerProxy(ctx, "workflow-intake-v1", { childResultProvenance: true });
        const proxy = (key) => createSessionProxy(ctx, input.sessionId, key, { workspace: WORKSPACE }, "workflow-intake-v1", { ownerTag: input.ownerTag });
        let session = proxy(`affinity-${input.sessionId}`);
        yield manager.requestOwnerCapacity(input.sessionId, input.ownerTag);
        yield session.runTurn("one", false, 0);
        yield session.hydrate();
        yield session.checkWorkspace({ workspace: WORKSPACE, revision: 2, turnIndex: 1 });
        if (input.pause) yield ctx.waitForEvent("go");
        yield session.releaseWorkspace({ reason: "idle", revision: 1, turnIndex: 1 });
        // An affinity release: the next activities go out under a new key.
        session = proxy(yield ctx.newGuid());
        yield session.runTurn("two", false, 1);
        yield session.destroy();
        return "ok";
    }

    // The capped destroy of a completing session whose owner has no worker.
    function* cappedDestroy(ctx, input) {
        const session = createSessionProxy(ctx, input.sessionId, `affinity-${input.sessionId}`, {}, "workflow-intake-v1", { ownerTag: input.ownerTag });
        const raced = parsed(yield ctx.race(session.destroy(), ctx.scheduleTimer(1_000)));
        return raced.index;
    }

    async function withRuntimes(label, body, runtimeOptions = {}) {
        const env = createTestEnv(label);
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const executions = [];
        const runtimes = new Map();
        const answers = {
            runTurnV5: { type: "completed", content: "ok" },
            requestOwnerCapacity: { decision: "ok" },
            checkWorkspace: { ok: true, path: "/work/app" },
        };
        async function start(id, filter) {
            const runtime = new Runtime(provider, {
                workerNodeId: `${env.runId}-${id}`,
                orchestrationConcurrency: 1,
                workerConcurrency: 2,
                dispatcherPollIntervalMs: 20,
                workerLockTimeoutMs: 10_000,
                sessionLockTimeoutMs: 5_000,
                sessionIdleTimeoutMs: 3_600_000,
                workerTagFilter: workerTagFilter(filter),
                logLevel: "error",
                ...runtimeOptions,
            });
            runtime.registerOrchestration("owner-probe", probe);
            runtime.registerOrchestration("capped-destroy", cappedDestroy);
            for (const name of ["runTurnV5", "hydrateSession", "checkWorkspace", "releaseWorkspace", "destroySession", "requestOwnerCapacity"]) {
                runtime.registerActivity(name, async (ctx, input) => {
                    executions.push({ worker: id, name, tag: ctx.tag(), sessionId: input.sessionId, at: Date.now() });
                    return answers[name] ?? null;
                });
            }
            await runtime.start();
            runtimes.set(id, runtime);
        }
        async function stop(id) {
            await runtimes.get(id)?.shutdown(3_000).catch(() => {});
            runtimes.delete(id);
        }
        const ran = (sessionId) => executions.filter((e) => e.sessionId === sessionId && e.name !== "requestOwnerCapacity");
        try {
            await body({ client, executions, start, stop, ran, timeoutMs: 60_000 });
        } finally {
            for (const id of [...runtimes.keys()].reverse()) await stop(id);
            await env.cleanup();
        }
    }

    /**
     * Whether an orchestration's history has an event of this kind and name.
     * Duroxide never delivers an event raised before the orchestration waits
     * for it, so the restart cases raise "go" only once the wait shows here.
     */
    async function recorded(client, instanceId, kind, name) {
        for (const executionId of await client.listExecutions(instanceId)) {
            const history = await client.readExecutionHistory(instanceId, executionId);
            if (history.some((e) => e.kind === kind && JSON.parse(e.data).name === name)) return true;
        }
        return false;
    }

    const SCOPED = ["runTurnV5", "hydrateSession", "checkWorkspace", "releaseWorkspace", "runTurnV5", "destroySession"];

    it("runs each owner's session-scoped activities only on that owner's worker, also under a new affinity key, and capacity requests only on the requester's worker", async () => {
        await withRuntimes("owner_route", async ({ client, executions, start, ran, timeoutMs }) => {
            await start("owner-a", { ownerTag: TAG.a });
            await start("owner-b", { ownerTag: TAG.b });
            await start("capacity", { ownerCapacity: true });
            await client.startOrchestration("probe-a", "owner-probe", { sessionId: "sa", ownerTag: TAG.a });
            await client.startOrchestration("probe-b", "owner-probe", { sessionId: "sb", ownerTag: TAG.b });
            expect((await client.waitForOrchestration("probe-a", timeoutMs)).status).toBe("Completed");
            expect((await client.waitForOrchestration("probe-b", timeoutMs)).status).toBe("Completed");
            for (const [sessionId, worker, tag] of [["sa", "owner-a", TAG.a], ["sb", "owner-b", TAG.b]]) {
                expect(ran(sessionId).map((e) => e.name)).toEqual(SCOPED);
                expect([...new Set(ran(sessionId).map((e) => `${e.worker} ${e.tag}`))]).toEqual([`${worker} ${tag}`]);
                expect(executions.filter((e) => e.sessionId === sessionId && e.name === "requestOwnerCapacity").map((e) => `${e.worker} ${e.tag}`))
                    .toEqual([`capacity ${OWNER_CAPACITY_CAPABILITY}`]);
            }
        });
    }, TIMEOUT);

    it("holds an owner-tagged activity while no worker declares the tag and runs it once the owner's worker starts", async () => {
        await withRuntimes("owner_wait", async ({ client, executions, start, ran, timeoutMs }) => {
            await start("owner-a", { ownerTag: TAG.a });
            await start("capacity", { ownerCapacity: true });
            await client.startOrchestration("probe-c", "owner-probe", { sessionId: "sc", ownerTag: TAG.c });
            await eventually(() => executions.some((e) => e.sessionId === "sc"), "the capacity request");
            await sleep(3_000);
            expect(ran("sc")).toEqual([]);
            expect((await client.getStatus("probe-c")).status).toBe("Running");
            await start("owner-c", { ownerTag: TAG.c });
            expect((await client.waitForOrchestration("probe-c", timeoutMs)).status).toBe("Completed");
            expect(ran("sc").map((e) => e.name)).toEqual(SCOPED);
            expect([...new Set(ran("sc").map((e) => e.worker))]).toEqual(["owner-c"]);
        });
    }, TIMEOUT);

    it("moves a session to its owner's restarted worker, never to another owner's worker", async () => {
        await withRuntimes("owner_restart", async ({ client, start, stop, ran, timeoutMs }) => {
            await start("owner-a", { ownerTag: TAG.a });
            await start("owner-b", { ownerTag: TAG.b });
            await start("capacity", { ownerCapacity: true });
            await client.startOrchestration("probe-r", "owner-probe", { sessionId: "sr", ownerTag: TAG.a, pause: true });
            await eventually(() => recorded(client, "probe-r", "ExternalSubscribed", "go"), "the wait after the workspace check");
            await stop("owner-a");
            // A new worker ID: it takes the session once the old lock lapses.
            await start("owner-a2", { ownerTag: TAG.a });
            await client.raiseEvent("probe-r", "go", {});
            expect((await client.waitForOrchestration("probe-r", timeoutMs)).status).toBe("Completed");
            expect(ran("sr").map((e) => `${e.worker} ${e.name}`)).toEqual([
                "owner-a runTurnV5", "owner-a hydrateSession", "owner-a checkWorkspace",
                "owner-a2 releaseWorkspace", "owner-a2 runTurnV5", "owner-a2 destroySession",
            ]);
        });
    }, TIMEOUT);

    it("gives a session back at once to its owner's worker restarted under the same ID while the stopped worker's lock holds, never to another worker", async () => {
        // PilotSwarm sets no session lock by default, so Duroxide's 30 seconds apply.
        const lockMs = 30_000;
        await withRuntimes("owner_same_id", async ({ client, start, stop, ran, timeoutMs }) => {
            await start("owner-a", { ownerTag: TAG.a });
            await start("owner-b", { ownerTag: TAG.b });
            await start("capacity", { ownerCapacity: true });
            await client.startOrchestration("probe-s", "owner-probe", { sessionId: "ss", ownerTag: TAG.a, pause: true });
            await eventually(() => recorded(client, "probe-s", "ExternalSubscribed", "go"), "the wait after the workspace check");
            // A shutdown leaves the session locked, as a crash does: a worker
            // of the same owner under a new ID can't take the session meanwhile.
            await start("owner-a2", { ownerTag: TAG.a });
            await stop("owner-a");
            await client.raiseEvent("probe-s", "go", {});
            await eventually(() => recorded(client, "probe-s", "ActivityScheduled", "releaseWorkspace"), "the workspace release");
            await sleep(3_000);
            expect(ran("ss").map((e) => `${e.worker} ${e.name}`)).toEqual([
                "owner-a runTurnV5", "owner-a hydrateSession", "owner-a checkWorkspace",
            ]);
            // The same ID: the restarted worker takes the session back at once.
            const restartedAt = Date.now();
            await start("owner-a", { ownerTag: TAG.a });
            expect((await client.waitForOrchestration("probe-s", timeoutMs)).status).toBe("Completed");
            const [check, release] = ["checkWorkspace", "releaseWorkspace"].map((name) => ran("ss").find((e) => e.name === name));
            console.log(`  the release ran ${release.at - restartedAt} ms after the restart, ${release.at - check.at} ms after the workspace check`);
            // Claiming the workspace check locked the session for lockMs, and
            // renewals only extend the lock, so a worker with another ID could
            // not run the release sooner than lockMs after the check.
            expect(release.at - check.at).toBeLessThan(lockMs / 2);
            expect(release.worker).toBe("owner-a");
            // The new affinity key may go to either of the owner's workers.
            expect(ran("ss").map((e) => e.name)).toEqual(SCOPED);
            expect(ran("ss").every((e) => ["owner-a", "owner-a2"].includes(e.worker) && e.tag === TAG.a)).toBe(true);
        }, { sessionLockTimeoutMs: lockMs });
    }, TIMEOUT);

    it("never starts an owner-tagged destroy that lost its race while the owner had no worker", async () => {
        await withRuntimes("owner_destroy", async ({ client, start, ran, timeoutMs }) => {
            await start("other", {});
            await client.startOrchestration("destroy-c", "capped-destroy", { sessionId: "dc", ownerTag: TAG.c });
            const result = await client.waitForOrchestration("destroy-c", timeoutMs);
            expect(result.status).toBe("Completed");
            expect(parsed(result.output)).toBe(1);
            await start("owner-c", { ownerTag: TAG.c });
            await sleep(3_000);
            expect(ran("dc")).toEqual([]);
        });
    }, TIMEOUT);
});

/**
 * PilotSwarm workers bound to owners, the scripted model, and a client with
 * owner routing and the fast busy policy. `startWorker(id, undefined, true)`
 * starts a worker without an owner tag that has the capacity requester, which
 * records every request, as the coordination host does: a worker with an
 * owner tag takes no capacity requests (with a requester it refuses to start).
 */
async function withOwnerCluster(env, { respond, capacity, worker = {}, client: clientOptions = {} }, fn) {
    const model = await startScriptedModel({ respond });
    const requests = [];
    const workers = new Map();
    let client;
    let mgmt;
    let catalog;
    try {
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        const stores = {
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath,
        };
        async function startWorker(id, ownerTag, requester = false) {
            const w = new PilotSwarmWorker({
                ...stores,
                sessionStateDir: env.sessionStateDir,
                workerNodeId: id,
                ownerTag,
                disableManagementAgents: true,
                logLevel: "error",
                ...worker,
            });
            if (requester) {
                w.setOwnerCapacityRequester(async (request) => {
                    requests.push({ worker: id, request });
                    return capacity ? capacity(request) : { decision: "ok" };
                });
            }
            await w.start();
            workers.set(id, w);
        }
        async function stopWorker(id) {
            await workers.get(id)?.stop();
            workers.delete(id);
        }
        client = new PilotSwarmClient({ ...stores, ownerRouting: true, workspaceBusyFastRelease: true, ...clientOptions });
        mgmt = new PilotSwarmManagementClient(stores);
        catalog = await createCatalog(env);
        await fn({
            startWorker,
            stopWorker,
            workerOf: (id) => workers.get(id),
            startClients: async () => { await client.start(); await mgmt.start(); },
            client,
            mgmt,
            catalog,
            model,
            requests,
            asked: (sessionId) => requests.filter((r) => r.request.sessionId === sessionId),
            qualifiedModel: FIXTURE_QUALIFIED_MODEL,
        });
    } finally {
        await mgmt?.stop().catch(() => {});
        await client?.stop().catch(() => {});
        for (const w of [...workers.values()].reverse()) await w.stop().catch(() => {});
        await catalog?.close?.();
        await model.close();
    }
}

/** The worker that started each of a session's turns. */
async function turnWorkers(catalog, sessionId) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.turn_started"]);
    return events.map((e) => e.workerNodeId);
}

/** The input of each of a session's executions, from Duroxide's history. */
async function executionInputs(client, sessionId) {
    const duroxide = client._getDuroxideClient();
    const instanceId = `session-${sessionId}`;
    const inputs = [];
    for (const executionId of await duroxide.listExecutions(instanceId)) {
        const history = await duroxide.readExecutionHistory(instanceId, executionId);
        const started = history.find((e) => /Orchestrat.*Started/.test(e.kind) && e.data);
        const payload = JSON.parse(started.data);
        inputs.push(parsed(payload.input));
    }
    return inputs;
}

async function spawnedChild(catalog, parentSessionId) {
    return eventually(async () => {
        const events = await catalog.getSessionEvents(parentSessionId, undefined, 1000, ["session.agent_spawned"]);
        return events[0]?.data?.childSessionId;
    }, "the spawned child");
}

/**
 * Hold the first catalog write of `state` for one session on these workers,
 * after it is written, until `release()`: the catalog then shows the state
 * while the orchestration, which waits for that activity, can't move on. The
 * hold gives up after a minute so a failing test can't hang the cluster.
 */
function holdCatalogStateWrite(workers, sessionId, state) {
    let release = () => {};
    const released = new Promise((resolve) => { release = resolve; });
    let held = 0;
    const restores = workers.map((worker) => {
        const catalog = worker._catalog;
        const write = catalog.updateSession;
        catalog.updateSession = async function (id, updates, ...rest) {
            const result = await write.call(this, id, updates, ...rest);
            if (id === sessionId && updates?.state === state && held === 0) {
                held += 1;
                await Promise.race([released, sleep(60_000)]);
            }
            return result;
        };
        return () => { catalog.updateSession = write; };
    });
    return { held: () => held, release: () => release(), restore: () => restores.forEach((restore) => restore()) };
}

describe("owner routing with PilotSwarm workers", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("runs a user's session and the child it spawns only on the owner's worker; the child takes the tag and the fast policy and keeps both across continue-as-new", async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            const text = position.lastUserText;
            if (text.includes("child-task")) return { content: "child done" };
            if (text.includes("spawn the child")) {
                return position.step === 0
                    ? { tools: [{ name: "spawn_agent", args: { task: "child-task: say hi" } }] }
                    : { content: "spawned" };
            }
            return { content: `ok:${text.slice(0, 24)}` };
        };
        await withOwnerCluster(env, { respond }, async ({ startWorker, startClients, client, mgmt, catalog, asked, requests, qualifiedModel }) => {
            await startWorker("coordinator", undefined, true);
            await startWorker("owner-a", TAG.a);
            await startWorker("owner-b", TAG.b);
            await startClients();
            const parent = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("a") });
            const other = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("b") });
            expect(await parent.sendAndWait("spawn the child", TIMEOUT)).toContain("spawned");
            expect(await other.sendAndWait("hello from b", TIMEOUT)).toContain("ok:");
            const childId = await spawnedChild(catalog, parent.sessionId);
            await waitForSessionState(catalog, childId, ["idle"], 120_000);

            // A model switch continues the child as new.
            await mgmt.setSessionModel(childId, qualifiedModel);
            await eventually(async () => (await executionInputs(client, childId)).length >= 2, "the child's continue-as-new");
            await eventually(async () => (await turnWorkers(catalog, childId)).length >= 2, "the child's turn after the switch");

            expect(new Set(await turnWorkers(catalog, parent.sessionId))).toEqual(new Set(["owner-a"]));
            expect(new Set(await turnWorkers(catalog, childId))).toEqual(new Set(["owner-a"]));
            expect(new Set(await turnWorkers(catalog, other.sessionId))).toEqual(new Set(["owner-b"]));

            const routed = (who) => ({ ownerTag: TAG[who], workspaceBusyFastRelease: true });
            expect((await executionInputs(client, parent.sessionId))[0]).toMatchObject(routed("a"));
            expect((await executionInputs(client, other.sessionId))[0]).toMatchObject(routed("b"));
            const childInputs = await executionInputs(client, childId);
            expect(childInputs[0]).toMatchObject({ ...routed("a"), parentSessionId: parent.sessionId });
            expect(childInputs.at(-1)).toMatchObject(routed("a"));

            // Every turn asked first, on the worker with the requester, with the session's root.
            expect(requests.every((r) => r.worker === "coordinator")).toBe(true);
            expect(asked(parent.sessionId)[0].request).toEqual({ sessionId: parent.sessionId, rootSessionId: parent.sessionId, ownerTag: TAG.a });
            expect(asked(other.sessionId)[0].request).toEqual({ sessionId: other.sessionId, rootSessionId: other.sessionId, ownerTag: TAG.b });
            expect(asked(childId).map((r) => r.request)).toEqual([
                { sessionId: childId, rootSessionId: parent.sessionId, ownerTag: TAG.a },
                { sessionId: childId, rootSessionId: parent.sessionId, ownerTag: TAG.a },
            ]);
        });
    }, TIMEOUT);

    it("ends a denied turn without a retry and lets the session complete; completes a busy session on done while no worker declares its owner's tag", async () => {
        const env = getEnv();
        const deniedOnce = new Set();
        const capacity = (request) => {
            if (request.ownerTag === TAG.c) return { decision: "busy", retryAfterMs: 60_000, message: "No capacity for this owner yet." };
            if (!deniedOnce.has(request.sessionId)) {
                deniedOnce.add(request.sessionId);
                return { decision: "deny", message: "This owner has no capacity." };
            }
            return { decision: "ok" };
        };
        const respond = (_body, position) => ({ content: position.lastUserText.includes("second try") ? "second try ran" : "ok" });
        await withOwnerCluster(env, { respond, capacity }, async ({ startWorker, workerOf, startClients, client, mgmt, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", undefined, true);
            await startWorker("owner-a", TAG.a);
            await startClients();

            const denied = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("a") });
            // The refusal's catalog write is held until this client has synced
            // its response cursor for the next prompt: the sync always reads
            // the status the orchestration published by the time the catalog
            // shows the error, and the second try must not get the refusal back.
            const errorWrite = holdCatalogStateWrite([workerOf("coordinator"), workerOf("owner-a")], denied.sessionId, "error");
            const syncTurnCursors = client._syncTurnCursors;
            client._syncTurnCursors = async function (orchestrationId) {
                await syncTurnCursors.call(this, orchestrationId);
                if (orchestrationId === `session-${denied.sessionId}` && errorWrite.held() === 1) errorWrite.release();
            };
            try {
                await denied.send("first try");
                const refused = await waitForSessionState(catalog, denied.sessionId, ["error"], 60_000);
                expect(refused.lastError).toBe("This owner has no capacity.");
                expect(errorWrite.held()).toBe(1);
                expect(await turnWorkers(catalog, denied.sessionId)).toEqual([]);
                expect(await denied.sendAndWait("second try", TIMEOUT)).toBe("second try ran");
            } finally {
                errorWrite.release();
                errorWrite.restore();
                client._syncTurnCursors = syncTurnCursors;
            }
            expect(asked(denied.sessionId)).toHaveLength(2);
            await mgmt.completeSession(denied.sessionId, "done after a refusal");
            expect((await catalog.getSession(denied.sessionId)).state).toBe("completed");

            const held = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("c") });
            await held.send("wait for a worker");
            const waiting = await waitForSessionState(catalog, held.sessionId, ["waiting"], 60_000);
            expect(waiting.waitReason).toBe("No capacity for this owner yet.");
            const startedAt = Date.now();
            await mgmt.completeSession(held.sessionId, "done while no owner worker runs");
            expect(Date.now() - startedAt).toBeLessThan(45_000);
            expect((await catalog.getSession(held.sessionId)).state).toBe("completed");
            expect(await turnWorkers(catalog, held.sessionId)).toEqual([]);
            expect(asked(held.sessionId)).toHaveLength(1);
        });
    }, TIMEOUT);

    it("resumes a child after a durable wait on its owner's new worker when the owner's only worker stopped meanwhile", async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            const text = position.lastUserText;
            if (text.includes("wait is now complete")) return { content: "child resumed" };
            if (text.includes("child-task")) {
                // A durable wait ends the turn after the model's next answer.
                return position.step === 0
                    ? { tools: [{ name: "wait", args: { seconds: 15, reason: "let the owner's worker restart" } }] }
                    : { content: "waiting" };
            }
            if (text.includes("spawn the child")) {
                return position.step === 0
                    ? { tools: [{ name: "spawn_agent", args: { task: "child-task: wait, then report" } }] }
                    : { content: "spawned" };
            }
            return { content: `ok:${text.slice(0, 24)}` };
        };
        await withOwnerCluster(env, { respond, worker: { sessionLockTimeoutMs: 5_000 }, client: { waitThreshold: 5 } }, async ({ startWorker, stopWorker, startClients, client, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", undefined, true);
            await startWorker("owner-a", TAG.a);
            await startWorker("owner-b", TAG.b);
            await startClients();
            const parent = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("a") });
            expect(await parent.sendAndWait("spawn the child", TIMEOUT)).toContain("spawned");
            const childId = await spawnedChild(catalog, parent.sessionId);
            await waitForSessionState(catalog, childId, ["waiting"], 120_000);
            await waitForSessionState(catalog, parent.sessionId, ["idle"], 120_000);

            await stopWorker("owner-a");
            await startWorker("owner-a2", TAG.a);

            await eventually(async () => (await turnWorkers(catalog, childId)).length >= 2, "the child's turn after its wait", 180_000);
            await waitForSessionState(catalog, childId, ["idle"], 120_000);
            expect(await turnWorkers(catalog, childId)).toEqual(["owner-a", "owner-a2"]);
            expect(asked(childId).map((r) => r.worker)).toEqual(["coordinator", "coordinator"]);
            expect((await turnWorkers(catalog, parent.sessionId)).every((id) => id === "owner-a" || id === "owner-a2")).toBe(true);
        });
    }, TIMEOUT);

    it("a forced delete ends an owner-tagged tree, with and without a delete command, while no worker declares the owner's tag", async () => {
        const env = getEnv();
        const capacity = (request) => (request.ownerTag === TAG.c
            ? { decision: "busy", retryAfterMs: 60_000, message: "No capacity for this owner yet." }
            : { decision: "ok" });
        const respond = () => ({ content: "ok" });
        await withOwnerCluster(env, { respond, capacity }, async ({ startWorker, startClients, client, mgmt, catalog, qualifiedModel }) => {
            await startWorker("coordinator", undefined, true);
            await startWorker("owner-a", TAG.a);
            await startClients();
            // Owner c has no worker: a root, a child created with its tag, and
            // another root all wait for capacity.
            const root = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("c") });
            await root.send("wait for a worker");
            await waitForSessionState(catalog, root.sessionId, ["waiting"], 60_000);
            const child = await client.createSession({
                sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("c"),
                parentSessionId: root.sessionId, nestingLevel: 1, ownerTag: TAG.c,
            });
            await child.send("the child waits too");
            await waitForSessionState(catalog, child.sessionId, ["waiting"], 60_000);
            const lone = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER("c") });
            await lone.send("wait as well");
            await waitForSessionState(catalog, lone.sessionId, ["waiting"], 60_000);
            const instance = (id) => client._getDuroxideClient().getStatus(`session-${id}`).then((s) => s?.status);

            // With the delete command: the destroy of the owner-tagged sessions
            // is capped, so the command settles without the owner's worker.
            let startedAt = Date.now();
            await mgmt.deleteSession(root.sessionId, "forced while no owner worker runs", { force: true });
            expect(Date.now() - startedAt).toBeLessThan(65_000);
            await eventually(async () => !(await catalog.getSession(child.sessionId)), "the child's delete");
            expect(await catalog.getSession(root.sessionId)).toBeNull();

            // Without one: the instance and the row go at once.
            startedAt = Date.now();
            await mgmt.deleteSession(lone.sessionId, "forced at once", { force: true, settleTimeoutMs: 0 });
            expect(Date.now() - startedAt).toBeLessThan(30_000);
            expect(await catalog.getSession(lone.sessionId)).toBeNull();
            expect(await instance(lone.sessionId)).toBe("NotFound");
        });
    }, TIMEOUT);
    it("keeps a session started on 1.0.82 untagged on that version and after its continue-as-new to 1.0.84", async () => {
        const env = getEnv();
        const respond = (_body, position) => ({ content: `ok:${position.lastUserText.slice(0, 24)}` });
        await withOwnerCluster(env, { respond }, async ({ startWorker, startClients, client, mgmt, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", undefined, true);
            await startWorker("owner-a", TAG.a);
            await startClients();
            const sessionId = randomUUID();
            const pin = pinSessionStartVersion(client, "1.0.82", { sessionId });
            try {
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER("a") });
                expect(await session.sendAndWait("on the old version", TIMEOUT)).toContain("ok:");
            } finally {
                pin.restore();
            }
            expect(pin.starts.map((s) => s.used)).toEqual(["1.0.82"]);
            expect(await sessionOrchestrationVersion(client, sessionId)).toBe("1.0.82");

            await mgmt.setSessionModel(sessionId, qualifiedModel);
            await eventually(async () => (await sessionOrchestrationVersion(client, sessionId)) === "1.0.84", "the move to 1.0.84");
            await eventually(async () => (await turnWorkers(catalog, sessionId)).length >= 2, "the turn after the move");
            const inputs = await executionInputs(client, sessionId);
            // The client's start input names the owner; 1.0.82 ignores it and
            // carries neither field into the next execution.
            expect(inputs[0]).toMatchObject({ ownerTag: TAG.a, workspaceBusyFastRelease: true });
            expect(inputs.at(-1)).toMatchObject({ sourceOrchestrationVersion: "1.0.82" });
            expect(inputs.at(-1)).not.toHaveProperty("ownerTag");
            expect(inputs.at(-1)).not.toHaveProperty("workspaceBusyFastRelease");
            expect(asked(sessionId)).toEqual([]);
        });
    }, TIMEOUT);
});
