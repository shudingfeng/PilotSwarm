/**
 * Owner routing and orchestration 1.0.84.
 *
 * The orchestration tests drive the real 1.0.82, frozen 1.0.83 and 1.0.84
 * generators with a scripted context and the real session proxy, so every
 * activity is the descriptor duroxide would schedule: its name, input, tag
 * and session key.
 * The owner-only tests run duroxide runtimes on an in-memory SQLite store.
 *
 * Run: node --test test/unit/owner-routing.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSessionManagerProxy, createSessionProxy, personalCredentialTurnResult, sessionAdmissionTurnResult } from "../../dist/session-proxy.js";
import { PersonalCredentialError } from "../../dist/personal-secret-store.js";
import {
    AGENT_HANDOFF_CAPABILITY,
    MAX_WORKER_TAGS as ROUTING_MAX_WORKER_TAGS,
    OWNER_CAPACITY_CAPABILITY,
    TURN_CONTROL_CAPABILITY,
    WORKFLOW_REQUEST_CAPABILITY,
    WORKSPACE_CAPABILITY,
    workerTagFilter,
} from "../../dist/activity-routing.js";
import { WORKFLOW_MILESTONE_WORKER_TAGS } from "../../dist/workflow/milestone-worker.js";
import {
    CAPACITY_UNAVAILABLE,
    askOwnerCapacityRequester,
    normalizeOwnerCapacityAnswer,
    ownerRoutingTagForRow,
} from "../../dist/owner-routing.js";
import { durableSessionOrchestration_1_0_82 } from "../../dist/orchestration_1_0_82/index.js";
import { durableSessionOrchestration_1_0_83 } from "../../dist/orchestration_1_0_83/index.js";
import { durableSessionOrchestration_1_0_84 } from "../../dist/orchestration/index.js";
import { WORKSPACE_CHECK_CAP_MS, WORKSPACE_RELEASE_CAP_MS, workspaceRetryDelayMs, WORKSPACE_BUSY_RETRY_SCHEDULE_SECONDS } from "../../dist/orchestration/state.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../../dist/index.js";

const { MAX_WORKER_TAGS, Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");

const OWNER = "owner.0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11";
const WORKSPACE = { schema: 1, root: "repos", folder: "sessions/s-1/app" };

// ─── The session proxy, the manager proxy and the worker filter ─────────────

function descriptorContext() {
    const activity = (name, input, sessionId) => {
        const task = { type: "activity", name, input, ...(sessionId ? { sessionId } : {}) };
        task.withTag = (tag) => { task.tag = tag; return task; };
        return task;
    };
    return {
        instanceId: "session-s-1",
        scheduleActivity: (name, input) => activity(name, input),
        scheduleActivityOnSession: (name, input, sessionId) => activity(name, input, sessionId),
    };
}

function sessionScopedTasks(proxy) {
    return [
        proxy.runTurn("work", false, 1),
        proxy.runTurn("work", true, 0, { epochStart: true }),
        proxy.hydrate(),
        proxy.dehydrate("idle"),
        proxy.needsHydration(),
        proxy.checkpoint(),
        proxy.abortTurn("stop", 1),
        proxy.checkWorkspace({ workspace: WORKSPACE, revision: 2, turnIndex: 1 }),
        proxy.releaseWorkspace({ reason: "idle", revision: 1, turnIndex: 1 }),
        proxy.destroy(),
    ];
}

test("with an owner tag every session-scoped activity carries it, and without one routing is unchanged", () => {
    const ctx = descriptorContext();
    // 1.0.84 schedules 1.0.83's workflow-intake-v1 turns, whose tag the owner tag replaces too; 1.0.82's turn-control-v1
    // never passes an owner tag, and the proxy would treat one the same way.
    for (const [contract, turnNames, turnTag] of [
        ["workflow-intake-v1", ["runTurnV5", "runTurnEpochV5"], WORKFLOW_REQUEST_CAPABILITY],
        ["turn-control-v1", ["runTurnV4", "runTurnEpochV4"], TURN_CONTROL_CAPABILITY],
    ]) {
        const tagged = sessionScopedTasks(createSessionProxy(ctx, "s-1", "affinity-1", { workspace: WORKSPACE }, contract, { ownerTag: OWNER }));
        assert.deepEqual(tagged.map((t) => t.name), [
            ...turnNames, "hydrateSession", "dehydrateSession", "needsHydrationSession",
            "checkpointSession", "abortTurn", "checkWorkspace", "releaseWorkspace", "destroySession",
        ], contract);
        for (const task of tagged) {
            assert.equal(task.tag, OWNER, `${contract} ${task.name}`);
            assert.equal(task.sessionId, "affinity-1", task.name);
        }
        const plain = sessionScopedTasks(createSessionProxy(ctx, "s-1", "affinity-1", { workspace: WORKSPACE }, contract));
        assert.deepEqual(plain.map((t) => t.tag), [
            turnTag, turnTag, undefined, undefined, undefined,
            undefined, undefined, WORKSPACE_CAPABILITY, WORKSPACE_CAPABILITY, undefined,
        ], contract);
        // Same names and inputs: only the tag differs.
        assert.deepEqual(plain.map((t) => [t.name, t.input, t.sessionId]), tagged.map((t) => [t.name, t.input, t.sessionId]));
    }
});

test("the turn input carries the owner tag and the fast busy policy only when the orchestration sends them", () => {
    const proxy = createSessionProxy(descriptorContext(), "s-1", "affinity-1", {}, "workflow-intake-v1", { ownerTag: OWNER });
    const withRouting = proxy.runTurn("work", false, 1, { ownerTag: OWNER, workspaceBusyFastRelease: true }).input;
    assert.equal(withRouting.ownerTag, OWNER);
    assert.equal(withRouting.workspaceBusyFastRelease, true);
    const without = proxy.runTurn("work", false, 1, {}).input;
    assert.ok(!("ownerTag" in without) && !("workspaceBusyFastRelease" in without));
});

test("manager activities carry no owner tag; the capacity request carries its own capability tag", () => {
    const manager = createSessionManagerProxy(descriptorContext(), "workflow-intake-v1", { childResultProvenance: true });
    const capacity = manager.requestOwnerCapacity("s-1", OWNER);
    assert.equal(capacity.name, "requestOwnerCapacity");
    assert.equal(capacity.tag, OWNER_CAPACITY_CAPABILITY);
    assert.deepEqual(capacity.input, { sessionId: "s-1", ownerTag: OWNER });
    assert.equal(capacity.sessionId, undefined);

    const legacy = manager.spawnChildSession("s-1", {}, "task", 1, false, undefined, undefined, undefined, false);
    const routed = manager.spawnChildSession("s-1", {}, "task", 1, false, undefined, undefined, undefined, false, undefined, undefined,
        { ownerTag: OWNER, workspaceBusyFastRelease: true });
    assert.equal(legacy.tag, AGENT_HANDOFF_CAPABILITY);
    assert.equal(routed.tag, AGENT_HANDOFF_CAPABILITY);
    assert.deepEqual(routed.input, { ...legacy.input, ownerTag: OWNER, workspaceBusyFastRelease: true });
    assert.ok(!("ownerTag" in legacy.input));
    for (const task of [manager.resolveAgentConfig("a"), manager.listModels(), manager.summarizeSession("s-1"), manager.updateCmsState("s-1", "idle")]) {
        assert.notEqual(task.tag, OWNER);
    }
});

test("a worker's filter: four capability tags, plus the owner tag or the capacity tag, never both", () => {
    assert.equal(MAX_WORKER_TAGS, 5);
    assert.equal(ROUTING_MAX_WORKER_TAGS, MAX_WORKER_TAGS);
    const base = [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY];
    assert.deepEqual(WORKFLOW_MILESTONE_WORKER_TAGS, [WORKFLOW_REQUEST_CAPABILITY]);
    const cases = [
        [{}, base],
        [{ ownerTag: OWNER }, [...base, OWNER]],
        [{ ownerCapacity: true }, [...base, OWNER_CAPACITY_CAPABILITY]],
    ];
    for (const [opts, tags] of cases) {
        assert.deepEqual(workerTagFilter({ workflowTags: WORKFLOW_MILESTONE_WORKER_TAGS, ...opts }), { defaultAnd: tags });
        assert.deepEqual(workerTagFilter(opts), { defaultAnd: tags }, "the default capability tags are the worker's");
    }
    // Six tags: refused, so such a worker never starts.
    assert.throws(() => workerTagFilter({ workflowTags: WORKFLOW_MILESTONE_WORKER_TAGS, ownerTag: OWNER, ownerCapacity: true }), /takes no capacity requests/);
});

test("every filter a worker can build holds at most duroxide's five tags; any other is refused", () => {
    const built = [];
    for (const ownerTag of [undefined, OWNER]) {
        for (const ownerCapacity of [false, true]) {
            for (const ownerOnly of [false, true]) {
                let filter;
                try {
                    filter = workerTagFilter({ workflowTags: WORKFLOW_MILESTONE_WORKER_TAGS, ownerTag, ownerCapacity, ownerOnly });
                } catch (error) {
                    assert.ok(error instanceof TypeError, String(error));
                    continue;
                }
                const tags = "tags" in filter ? filter.tags : filter.defaultAnd;
                assert.ok(tags.length > 0 && tags.length <= MAX_WORKER_TAGS, JSON.stringify(filter));
                built.push({ ownerTag, ownerCapacity, ownerOnly });
            }
        }
    }
    // The default, owner, capacity and owner-only filters (the last with or without a requester, which it ignores).
    assert.equal(built.length, 5);
    // More capability tags with an owner or capacity tag are refused, not cut.
    assert.throws(() => workerTagFilter({ workflowTags: ["a.v1", "b.v1"], ownerTag: OWNER }), /at most 5 tags/);
});

test("a worker with an owner tag and a capacity requester refuses to start unless it is owner-only", async () => {
    const worker = new PilotSwarmWorker({ store: "postgresql://unused", ownerTag: OWNER });
    worker.setOwnerCapacityRequester(async () => ({ decision: "ok" }));
    await assert.rejects(worker.start(), /takes no capacity requests/);
    assert.notEqual(worker._started, true);
});

test("a worker refuses an owner tag that is not owner.<subject>, and a requester that is not a function", () => {
    for (const ownerTag of ["", "alice", "owner.", "owner.a b", `owner.${"x".repeat(300)}`]) {
        assert.throws(() => new PilotSwarmWorker({ store: "postgresql://unused", ownerTag }), /ownerTag must be "owner\.<subject>"/);
    }
    assert.throws(() => PilotSwarmWorker.prototype.setOwnerCapacityRequester.call({}, "nope"), /must be a function or null/);
});

// ─── Owner-only workers ─────────────────────────────────────────────────────

test("an owner-only worker's filter names its owner tag alone, also with a capacity requester; without the option it is unchanged", () => {
    for (const ownerCapacity of [false, true]) {
        const filter = workerTagFilter({ ownerTag: OWNER, ownerOnly: true, ownerCapacity });
        assert.deepEqual(filter, { tags: [OWNER] });
        assert.ok(filter.tags.length <= MAX_WORKER_TAGS);
    }
    const base = [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY];
    assert.deepEqual(workerTagFilter({ ownerOnly: false }), { defaultAnd: base });
    assert.throws(() => workerTagFilter({ ownerTag: OWNER, ownerCapacity: true, ownerOnly: false }), /takes no capacity requests/);
    assert.throws(() => workerTagFilter({ ownerOnly: true, ownerCapacity: true }), /owner-only worker needs an owner tag/);
});

test("an owner-only worker refuses to start without a valid owner tag", () => {
    const store = "postgresql://unused";
    assert.throws(() => new PilotSwarmWorker({ store, ownerOnly: true }), /ownerOnly needs an ownerTag/);
    assert.throws(() => new PilotSwarmWorker({ store, ownerOnly: true, ownerTag: "" }), /ownerTag must be "owner\.<subject>"/);
    for (const ownerOnly of ["1", 1, "true", null]) {
        assert.throws(() => new PilotSwarmWorker({ store, ownerOnly, ownerTag: OWNER }), /ownerOnly must be true or false/);
    }
});

test("an owner-only runtime runs orchestration turns but claims only its owner's activities, with or without a session; the clock and GUID activities wait for another worker", { timeout: 60_000 }, async () => {
    const OTHER = "owner.9d2e4c71-3b6a-4f0d-8e25-5c8a1f6b7e02";
    const tags = {
        untagged: null,
        handoff: AGENT_HANDOFF_CAPABILITY,
        workspace: WORKSPACE_CAPABILITY,
        turnControl: TURN_CONTROL_CAPABILITY,
        workflowRequest: WORKFLOW_REQUEST_CAPABILITY,
        capacity: OWNER_CAPACITY_CAPABILITY,
        otherOwner: OTHER,
        owner: OWNER,
    };
    const cases = Object.entries(tags).flatMap(([id, tag]) => [{ id, tag }, { id: `${id}-session`, tag, session: true }]);
    // ctx.utcNow() and ctx.newGuid() schedule untagged duroxide activities.
    cases.push(
        { id: "owner-after-clock", tag: OWNER, first: (ctx) => ctx.utcNow() },
        { id: "owner-after-guid", tag: OWNER, first: (ctx) => ctx.newGuid() },
    );
    const byId = new Map(cases.map((c) => [c.id, c]));
    const ids = [...byId.keys()];
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const ran = [];
    const runtimes = [];
    async function start(worker, filter) {
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50, orchestrationConcurrency: 1, workerConcurrency: 1, logLevel: "error", workerTagFilter: filter });
        runtime.registerActivity("Probe", async (ctx, id) => {
            ran.push({ id, worker, tag: ctx.tag() });
            return worker;
        });
        runtime.registerOrchestration("Route", function* (ctx, id) {
            const { tag, session, first } = byId.get(id);
            if (first) yield first(ctx);
            const task = session ? ctx.scheduleActivityOnSession("Probe", id, `key-${id}`) : ctx.scheduleActivity("Probe", id);
            return yield (tag ? task.withTag(tag) : task);
        });
        await runtime.start();
        runtimes.push(runtime);
    }
    const scheduled = async (id) => (await client.readExecutionHistory(id, 1))
        .filter((e) => e.kind === "ActivityScheduled")
        .map((e) => /^\{"name":"([^"]+)"/.exec(e.data)?.[1]);
    // Activities run at least once: on SQLite a contended ack can run one again.
    const ranIds = () => [...new Set(ran.map((r) => r.id))].sort();
    const expected = (id) => (id.startsWith("owner") ? "owner-only" : id.startsWith("otherOwner") ? "other-owner" : "default");
    try {
        await start("owner-only", workerTagFilter({ ownerTag: OWNER, ownerOnly: true, ownerCapacity: true }));
        for (const id of ids) await client.startOrchestration(id, "Route", id);
        for (const id of ["owner", "owner-session"]) {
            assert.equal((await client.waitForOrchestration(id, 10_000)).output, "owner-only", id);
        }
        // The only runtime runs every orchestration up to its first activity...
        for (const id of ids) {
            const deadline = Date.now() + 10_000;
            while ((await scheduled(id)).length === 0) {
                assert.ok(Date.now() < deadline, `${id} was never scheduled`);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        // ...and claims none of the activities but its owner's.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        assert.deepEqual(ranIds(), ["owner", "owner-session"]);
        assert.deepEqual(await scheduled("owner-after-clock"), ["__duroxide_syscall:utc_now_ms"]);
        assert.deepEqual(await scheduled("owner-after-guid"), ["__duroxide_syscall:new_guid"]);

        await start("default", workerTagFilter({ ownerCapacity: true }));
        await start("other-owner", workerTagFilter({ ownerTag: OTHER, ownerOnly: true }));
        for (const id of ids) {
            const result = await client.waitForOrchestration(id, 10_000);
            assert.equal(result.status, "Completed", id);
            assert.equal(result.output, expected(id), id);
        }
        assert.deepEqual(ranIds(), [...ids].sort());
        for (const r of ran) {
            assert.equal(r.worker, expected(r.id), r.id);
            assert.equal(r.tag, byId.get(r.id).tag, r.id);
        }
    } finally {
        for (const runtime of runtimes.reverse()) await runtime.shutdown(1_000);
    }
});

test("a row's owner tag: owner.<subject> of a user; none for no owner, the system user or a system session", () => {
    assert.equal(ownerRoutingTagForRow({ owner: { provider: "entra", subject: "0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11" } }), OWNER);
    assert.equal(ownerRoutingTagForRow({ owner: null }), undefined);
    assert.equal(ownerRoutingTagForRow({ owner: { provider: "system", subject: "system" } }), undefined);
    assert.equal(ownerRoutingTagForRow({ owner: { provider: "entra", subject: "x" }, isSystem: true }), undefined);
    assert.equal(ownerRoutingTagForRow({ owner: { provider: "entra", subject: "a b" } }), undefined);
    assert.equal(ownerRoutingTagForRow({ owner: { provider: "entra", subject: "x".repeat(300) } }), undefined);
    assert.equal(ownerRoutingTagForRow(null), undefined);
});

test("capacity answers: deny and busy keep their message, code and wait; anything else runs the turn", () => {
    assert.deepEqual(normalizeOwnerCapacityAnswer({ decision: "deny", message: " no capacity " }), { decision: "deny", code: "CAPACITY_DENIED", message: "no capacity" });
    assert.deepEqual(normalizeOwnerCapacityAnswer({ decision: "busy", retryAfterMs: 45_000.7, code: "OWNER_STARTING" }),
        { decision: "busy", code: "OWNER_STARTING", message: "The workers of this session's owner are busy.", retryAfterMs: 45_000 });
    assert.equal(normalizeOwnerCapacityAnswer({ decision: "busy" }).code, "WORKSPACE_BUSY");
    assert.equal(normalizeOwnerCapacityAnswer({ decision: "busy", code: "lower case" }).code, "WORKSPACE_BUSY");
    for (const answer of [undefined, null, {}, { decision: "ok" }, { decision: "admit" }, "deny"]) {
        assert.deepEqual(normalizeOwnerCapacityAnswer(answer), { decision: "ok" });
    }
});

test("the requester gets 15 seconds: then its signal fires and the answer is busy CAPACITY_UNAVAILABLE for a minute", async () => {
    let seen;
    const silent = await askOwnerCapacityRequester((request, signal) => {
        seen = { request, signal };
        return new Promise(() => {});
    }, { sessionId: "child", rootSessionId: "root", ownerTag: OWNER }, 50);
    assert.deepEqual(seen.request, { sessionId: "child", rootSessionId: "root", ownerTag: OWNER });
    assert.equal(seen.signal.aborted, true);
    assert.equal(silent.decision, "busy");
    assert.equal(silent.code, CAPACITY_UNAVAILABLE);
    assert.equal(silent.retryAfterMs, 60_000);

    const failing = await askOwnerCapacityRequester(() => { throw new Error("controller down"); }, { sessionId: "s", rootSessionId: "s", ownerTag: OWNER });
    assert.equal(failing.code, CAPACITY_UNAVAILABLE);
    assert.match(failing.message, /controller down/);
    assert.equal((await askOwnerCapacityRequester(null, { sessionId: "s", rootSessionId: "s", ownerTag: OWNER })).code, CAPACITY_UNAVAILABLE);
    assert.deepEqual(await askOwnerCapacityRequester(async () => ({ decision: "deny", message: "no capacity" }),
        async () => ({ sessionId: "s", rootSessionId: "r", ownerTag: OWNER })), { decision: "deny", code: "CAPACITY_DENIED", message: "no capacity" });
});

test("the fast busy schedule is 10 s, 20 s, 1 min, then every 3 min", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map((step) => workspaceRetryDelayMs(step, undefined, undefined, WORKSPACE_BUSY_RETRY_SCHEDULE_SECONDS)),
        [10_000, 20_000, 60_000, 180_000, 180_000, 180_000]);
    assert.deepEqual([0, 1, 2, 3, 4].map((step) => workspaceRetryDelayMs(step, undefined)), [30_000, 120_000, 300_000, 900_000, 900_000]);
});

// ─── The client: what an orchestration starts with ──────────────────────────

function fakeStore() {
    const rows = new Map();
    const creation = new Map();
    const starts = [];
    const catalog = {
        async createSession(sessionId, opts = {}) {
            const parent = opts.parentSessionId ? rows.get(opts.parentSessionId) : null;
            rows.set(sessionId, {
                sessionId,
                parentSessionId: opts.parentSessionId ?? null,
                rootSessionId: parent ? parent.rootSessionId : sessionId,
                owner: opts.owner ?? null,
                isSystem: Boolean(opts.isSystem),
                state: "pending",
                orchestrationId: null,
            });
            creation.set(sessionId, opts.creationConfig ? JSON.parse(JSON.stringify(opts.creationConfig)) : null);
        },
        async getSession(sessionId) { return rows.get(sessionId) ?? null; },
        async getSessionCreationConfig(sessionId) { return creation.get(sessionId) ?? null; },
        async updateSession(sessionId, updates) { Object.assign(rows.get(sessionId) ?? {}, updates); },
        async recordEvents() {},
        async listSessions() { return [...rows.values()]; },
    };
    const duroxide = {
        async startOrchestrationVersioned(id, name, input, version) { starts.push({ id, input, version }); },
        async enqueueEvent() {},
        async getStatus() { throw new Error("no status"); },
    };
    const client = (options = {}) => {
        const c = new PilotSwarmClient({ store: "postgresql://unused", ...options });
        c._catalog = catalog;
        c.duroxideClient = duroxide;
        return c;
    };
    const startOf = (sessionId) => starts.find((s) => s.id === `session-${sessionId}`)?.input;
    return { rows, creation, starts, client, startOf };
}

const USER = { provider: "entra", subject: "0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11" };

test("a top-level session first sent through another client gets the tag of its row's owner; other rows get none", async () => {
    const store = fakeStore();
    const creator = store.client({ ownerRouting: false });
    const user = await creator.createSession({ owner: USER });
    const unowned = await creator.createSession({});
    const systemOwned = await creator.createSession({ owner: { provider: "system", subject: "system" } });
    // A row marked is_system, as createSystemSession writes it.
    await creator._catalog.createSession("system-row", { isSystem: true, owner: USER });

    // As after a Portal restart: another process sends the first message.
    const portal = store.client({ ownerRouting: true });
    for (const id of [user.sessionId, unowned.sessionId, systemOwned.sessionId, "system-row"]) await portal._startTurn(id, "hello");
    assert.equal(store.startOf(user.sessionId).ownerTag, OWNER);
    assert.equal(store.startOf(unowned.sessionId).ownerTag, undefined);
    assert.equal(store.startOf(systemOwned.sessionId).ownerTag, undefined);
    assert.equal(store.startOf("system-row").ownerTag, undefined);
    assert.equal(store.startOf("system-row").isSystem, true);

    // Without the setting, routed as today.
    const plain = await creator.createSession({ owner: USER });
    await store.client({ ownerRouting: false })._startTurn(plain.sessionId, "hello");
    assert.ok(!("ownerTag" in store.startOf(plain.sessionId)));
    assert.ok(!("workspaceBusyFastRelease" in store.startOf(plain.sessionId)));
});

test("a session created during a turn keeps the turn's tag and fast policy when another client starts it, and is never derived", async () => {
    const store = fakeStore();
    const turnClient = store.client({ ownerRouting: false, workspaceBusyFastRelease: false });
    const root = await turnClient.createSession({ owner: USER });
    const child = await turnClient.createSession({
        parentSessionId: root.sessionId, nestingLevel: 1, owner: USER, ownerTag: OWNER, workspaceBusyFastRelease: true,
    });
    const createdRoot = await turnClient.createSession({ owner: USER, ownerTag: OWNER, workspaceBusyFastRelease: true });
    // Saved with the creation config, outside the session config.
    assert.equal(store.creation.get(child.sessionId).ownerTag, OWNER);
    assert.equal(store.creation.get(child.sessionId).workspaceBusyFastRelease, true);

    const other = store.client({ ownerRouting: false, workspaceBusyFastRelease: false });
    await other._startTurn(child.sessionId, "task", { bootstrap: true });
    await other._startTurn(createdRoot.sessionId, "task", { bootstrap: true });
    for (const id of [child.sessionId, createdRoot.sessionId]) {
        const input = store.startOf(id);
        assert.equal(input.ownerTag, OWNER, id);
        assert.equal(input.workspaceBusyFastRelease, true, id);
        assert.ok(!("ownerTag" in input.config) && !("workspaceBusyFastRelease" in input.config));
    }

    // A child without saved routing is never given a derived tag, even by a
    // client with owner routing on.
    const untaggedChild = await turnClient.createSession({ parentSessionId: root.sessionId, nestingLevel: 1, owner: USER });
    await store.client({ ownerRouting: true, workspaceBusyFastRelease: true })._startTurn(untaggedChild.sessionId, "task");
    assert.ok(!("ownerTag" in store.startOf(untaggedChild.sessionId)));
    assert.ok(!("workspaceBusyFastRelease" in store.startOf(untaggedChild.sessionId)));
});

test("the client settings default from PILOTSWARM_OWNER_ROUTING and PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE", async () => {
    const saved = { routing: process.env.PILOTSWARM_OWNER_ROUTING, fast: process.env.PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE };
    try {
        process.env.PILOTSWARM_OWNER_ROUTING = "1";
        process.env.PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE = "1";
        const store = fakeStore();
        const s = await store.client().createSession({ owner: USER });
        await store.client()._startTurn(s.sessionId, "hello");
        assert.equal(store.startOf(s.sessionId).ownerTag, OWNER);
        assert.equal(store.startOf(s.sessionId).workspaceBusyFastRelease, true);
    } finally {
        if (saved.routing === undefined) delete process.env.PILOTSWARM_OWNER_ROUTING; else process.env.PILOTSWARM_OWNER_ROUTING = saved.routing;
        if (saved.fast === undefined) delete process.env.PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE; else process.env.PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE = saved.fast;
    }
});

test("a session the dispatcher creates for an owner (onBehalfOfOwner) carries the owner's tag, not the dispatcher's", async () => {
    const store = fakeStore();
    const portal = store.client({ ownerRouting: true });
    // As the Portal creates it: owned by the named user, private, and its
    // first prompt sent by the dispatcher as itself.
    const delegated = await portal.createSession({ owner: USER, visibility: "private" });
    const dispatcher = { kind: "user", provider: "entra", subject: "5d0c9b61-2f4e-4a8d-b1c7-3e9f0a6d2b44", relation: "collaborator", origin: "api" };
    await portal._startTurn(delegated.sessionId, "do the work", { sender: dispatcher });
    assert.equal(store.startOf(delegated.sessionId).ownerTag, OWNER);
});

// ─── The orchestration ──────────────────────────────────────────────────────

const PARKED = Symbol("parked");

/**
 * Drive an orchestration handler until it finishes or waits for something
 * the script does not give it. A continue-as-new starts the next execution
 * with the same handler and key-value store, as duroxide does. Every effect
 * is logged.
 *
 * script.turns       runTurn results, in order
 * script.capacity    requestOwnerCapacity answers, in order (default ok)
 * script.queue       messages: { msg, when?(h) } — deliverable once when() holds
 * script.fireTimers  how many long timers may fire when nothing is queued
 * script.hang        activity names that never finish: a race against a cap loses
 * script.check       checkWorkspace answer
 */
function drive(handler, input, script = {}) {
    const kv = new Map(script.kv ?? []);
    const log = [];
    const activities = [];
    const statuses = [];
    const turns = [...(script.turns ?? [])];
    const capacity = [...(script.capacity ?? [])];
    const queue = (script.queue ?? []).map((e) => (typeof e === "string" || !("msg" in e) ? { msg: e } : e));
    let timersLeft = script.fireTimers ?? 0;
    let now = 1_800_000_000_000;
    let guid = 0;
    const h = {
        count: (name) => activities.filter((a) => a.name === name).length,
        activities,
        log,
        statuses,
        kv,
        timersFired: [],
        cans: [],
    };
    const deliverable = () => queue.findIndex((e) => !e.when || e.when(h));
    const take = () => {
        const ix = deliverable();
        if (ix < 0) return undefined;
        const { msg } = queue.splice(ix, 1)[0];
        return typeof msg === "string" ? msg : JSON.stringify(msg);
    };
    const task = (kind, name, input, sessionId) => {
        const t = { effect: "activity", kind, name, input, ...(sessionId ? { sessionId } : {}) };
        t.withTag = (tag) => { t.tag = tag; return t; };
        return t;
    };
    const ctx = {
        instanceId: `session-${input.sessionId}`,
        traceInfo: () => {},
        traceError: () => {},
        setCustomStatus: (s) => { statuses.push(JSON.parse(s)); log.push(`status ${s}`); },
        getValue: (k) => (kv.has(k) ? kv.get(k) : null),
        setValue: (k, v) => { kv.set(k, v); log.push(`kv ${k}=${v}`); },
        clearValue: (k) => { kv.delete(k); log.push(`kv-clear ${k}`); },
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "timer", ms }),
        dequeueEvent: (q) => ({ effect: "dequeue", q }),
        race: (...tasks) => ({ effect: "race", tasks }),
        continueAsNewVersioned: (canInput, version) => ({ effect: "can", input: canInput, version }),
        scheduleActivity: (name, actInput) => task("manager", name, actInput),
        scheduleActivityOnSession: (name, actInput, key) => task("session", name, actInput, key),
    };
    const describe = (e) => {
        if (!e || typeof e !== "object") return String(e);
        if (e.effect === "activity") return `${e.name}@${e.sessionId ?? "-"}#${e.tag ?? "-"} ${JSON.stringify(e.input)}`;
        if (e.effect === "timer") return `timer(${e.ms})`;
        if (e.effect === "race") return `race[${e.tasks.map(describe).join(" | ")}]`;
        if (e.effect === "can") {
            const { sourceOrchestrationVersion, ...rest } = e.input;
            return `can(${e.version}) ${JSON.stringify(rest)}`;
        }
        return e.effect;
    };
    const answer = (a) => {
        activities.push({ name: a.name, tag: a.tag, sessionId: a.sessionId, input: a.input });
        switch (a.name) {
            case "runTurnV4":
            case "runTurnEpochV4":
            case "runTurnV5":
            case "runTurnEpochV5":
                if (turns.length === 0) throw new Error(`runTurn past the script (${JSON.stringify(a.input.prompt).slice(0, 80)})`);
                return turns.shift();
            case "requestOwnerCapacity":
                return capacity.length > 0 ? capacity.shift() : { decision: "ok" };
            case "checkWorkspace":
                return script.check ?? { ok: true, path: "/work/app" };
            case "getWorkerSessionPolicy":
                return { policy: null, allowedAgentNames: [] };
            case "listChildSessionsV2":
                return "[]";
            case "getOrchestrationStats":
                return { historySizeBytes: 0 };
            case "spawnChildSessionV2":
                return "child-1";
            case "getDescendantSessionIds":
                return [];
            case "releaseWorkspace":
                return { released: true, cancelled: 0 };
            default:
                return undefined;
        }
    };
    let gen = handler(ctx, input);
    let value;
    for (let step = 0; step < 5_000; step += 1) {
        const next = gen.next(value);
        if (next.done) return { ...h, done: true, result: next.value };
        const effect = next.value;
        log.push(describe(effect));
        switch (effect?.effect) {
            case "utcNow": value = now; break;
            case "newGuid": value = `guid-${++guid}`; break;
            case "timer": now += effect.ms; value = undefined; break;
            case "can":
                h.cans.push({ input: effect.input, version: effect.version });
                if (h.cans.length > 8) throw new Error("too many continue-as-new");
                gen = handler(ctx, effect.input);
                value = undefined;
                break;
            case "activity": value = answer(effect); break;
            case "dequeue": {
                const msg = take();
                if (msg === undefined) return { ...h, parked: "dequeue" };
                value = msg;
                break;
            }
            case "race": {
                const [left, right] = effect.tasks;
                if (left?.effect === "activity" && right?.effect === "timer") {
                    if ((script.hang ?? []).includes(left.name)) {
                        activities.push({ name: left.name, tag: left.tag, sessionId: left.sessionId, input: left.input, lost: true });
                        h.timersFired.push(right.ms);
                        now += right.ms;
                        value = { index: 1 };
                    } else {
                        value = { index: 0, value: answer(left) };
                    }
                    break;
                }
                if (left?.effect === "dequeue" && right?.effect === "timer") {
                    const msg = deliverable() >= 0 ? take() : undefined;
                    if (msg !== undefined) { value = { index: 0, value: msg }; break; }
                    if (right.ms <= 1_000) { now += right.ms; value = { index: 1 }; break; }
                    if (timersLeft > 0) {
                        timersLeft -= 1;
                        h.timersFired.push(right.ms);
                        now += right.ms;
                        value = { index: 1 };
                        break;
                    }
                    return { ...h, parked: `timer(${right.ms})` };
                }
                throw new Error(`unexpected race: ${describe(effect)}`);
            }
            default:
                throw new Error(`unexpected effect: ${describe(effect)}`);
        }
    }
    throw new Error("the orchestration did not stop");
}

/** Turns run so far: runTurnV4 on 1.0.82, runTurnV5 on 1.0.83 and 1.0.84. */
const turnsOf = (h) => h.count("runTurnV4") + h.count("runTurnV5");
const prompt = (text, extra = {}) => ({ prompt: text, ...extra });
const command = (cmd, args) => ({ type: "cmd", cmd, id: `${cmd}-1`, ...(args ? { args } : {}) });
const ran = (result) => ({ ...result, workspaceAttached: true });
const busy = (worker = "worker-a") => ({
    type: "wait", seconds: 30, reason: "workspace unavailable: WORKSPACE_BUSY", gate: "workspace", code: "WORKSPACE_BUSY", workerNodeId: worker,
});
const baseInput = (extra = {}) => ({
    sessionId: "s-1",
    config: { model: "test:model", workspace: WORKSPACE },
    iteration: 0,
    blobEnabled: true,
    idleTimeout: 1_800,
    inputGracePeriod: 30,
    ...extra,
});

/**
 * A session's life: a WORKSPACE_BUSY refusal twice on one worker (held, then
 * released), a turn that spawns a child and its follow-up, the idle release,
 * a model switch, each followed by continue-as-new, the turn on the new
 * model, a set-workspace command and done.
 */
function lifeOf(handler, extra = {}) {
    return drive(handler, baseInput(extra), {
        queue: [
            prompt("hello", { clientMessageIds: ["m-1"] }),
            { msg: command("set_model", { model: "test:other" }), when: (h) => h.timersFired.includes(1_800_000) },
            {
                msg: command("set_workspace", { expectedRevision: 1, workspace: { root: "repos", folder: "sessions/s-1/other" } }),
                when: (h) => turnsOf(h) >= 5,
            },
            { msg: command("done"), when: (h) => h.count("checkWorkspace") >= 1 },
        ],
        turns: [
            busy(), busy(),
            ran({ type: "spawn_agent", task: "look around" }),
            ran({ type: "completed", content: "spawned" }),
            ran({ type: "completed", content: "on the new model" }),
        ],
        fireTimers: 3,
    });
}

const noWorkspace = (extra = {}) => baseInput({ config: { model: "test:model" }, ...extra });

/**
 * A session without a workspace that a workspace-gate wait holds twice, as an
 * admission hook, a credential resolver or a failed default folder answers,
 * with a turn that runs in between; then a model switch continues it as new.
 */
const twoHolds = (refusal = busy("w1")) => ({
    queue: [
        prompt("first"),
        { msg: prompt("second"), when: (h) => turnsOf(h) >= 2 },
        { msg: command("set_model", { model: "test:other" }), when: (h) => turnsOf(h) >= 3 },
    ],
    turns: [refusal, { type: "completed", content: "ok" }, refusal, { type: "completed", content: "on the new model" }],
    fireTimers: 1,
});

test("without an owner tag or the fast policy, 1.0.84 yields exactly what 1.0.83 yields", () => {
    const frozen = lifeOf(durableSessionOrchestration_1_0_83);
    const now = lifeOf(durableSessionOrchestration_1_0_84);
    assert.equal(now.result, "done");
    assert.equal(now.cans.length, 1, "the model switch continued as new");
    assert.deepEqual(now.log, frozen.log);
    assert.equal(now.count("requestOwnerCapacity"), 0);
    assert.ok(now.activities.every((a) => !String(a.tag ?? "").startsWith("owner.")));
    // The scenario covered what it claims.
    const names = now.activities.map((a) => a.name);
    for (const name of ["runTurnV5", "releaseWorkspace", "spawnChildSessionV2", "checkWorkspace", "destroySession"]) {
        assert.ok(names.includes(name), name);
    }
    assert.deepEqual(now.timersFired, [30_000, 120_000, 1_800_000]);
    // A 1.0.82 input and a 1.0.83 input (neither has the new fields) continue into 1.0.84 as into frozen 1.0.83.
    for (const source of [durableSessionOrchestration_1_0_82, durableSessionOrchestration_1_0_83]) {
        const carried = lifeOf(source).cans[0].input;
        const upgraded = drive(durableSessionOrchestration_1_0_84, carried, { queue: [command("done")] });
        const control = drive(durableSessionOrchestration_1_0_83, carried, { queue: [command("done")] });
        assert.deepEqual(upgraded.log, control.log);
        assert.equal(upgraded.result, "done");
    }
    // A session without a workspace that a gate wait holds, with a busy
    // refusal or a failed attach (a default folder's): the same yields too.
    for (const refusal of [busy("w1"), { ...busy("w1"), code: "WORKSPACE_ATTACH_FAILED", reason: "workspace unavailable: attach failed" }]) {
        const held = drive(durableSessionOrchestration_1_0_84, noWorkspace(), twoHolds(refusal));
        assert.deepEqual(held.log, drive(durableSessionOrchestration_1_0_83, noWorkspace(), twoHolds(refusal)).log, refusal.code);
        assert.equal(held.count("runTurnV5"), 4, refusal.code);
    }
});

test("an owner-tagged session: every session-scoped activity carries the tag, across continue-as-new, and the tag rides the turn input", () => {
    const run = lifeOf(durableSessionOrchestration_1_0_84, { ownerTag: OWNER, workspaceBusyFastRelease: true });
    assert.equal(run.result, "done");
    assert.equal(run.cans.length, 1);
    for (const can of run.cans) {
        assert.equal(can.input.ownerTag, OWNER);
        assert.equal(can.input.workspaceBusyFastRelease, true);
    }
    const sessionScoped = run.activities.filter((a) => a.sessionId);
    for (const name of ["runTurnV5", "releaseWorkspace", "checkWorkspace", "destroySession"]) {
        assert.ok(sessionScoped.some((a) => a.name === name), name);
    }
    for (const a of sessionScoped) assert.equal(a.tag, OWNER, a.name);
    const turns = run.activities.filter((a) => a.name === "runTurnV5");
    assert.equal(turns.length, 5);
    for (const turn of turns) {
        assert.equal(turn.input.ownerTag, OWNER);
        assert.equal(turn.input.workspaceBusyFastRelease, true);
    }
    // Manager activities keep their own routing.
    for (const a of run.activities.filter((x) => !x.sessionId)) assert.notEqual(a.tag, OWNER, a.name);
    const spawn = run.activities.find((a) => a.name === "spawnChildSessionV2");
    assert.equal(spawn.tag, AGENT_HANDOFF_CAPABILITY);
    assert.equal(spawn.input.ownerTag, OWNER);
    assert.equal(spawn.input.workspaceBusyFastRelease, true);
});

test("one capacity request before each turn, tagged for workers with a requester, and before a set-workspace check", () => {
    const run = lifeOf(durableSessionOrchestration_1_0_84, { ownerTag: OWNER });
    const order = run.activities.map((a) => a.name)
        .filter((n) => ["requestOwnerCapacity", "runTurnV5", "checkWorkspace"].includes(n));
    assert.deepEqual(order, [
        ...Array.from({ length: 5 }, () => ["requestOwnerCapacity", "runTurnV5"]).flat(),
        "requestOwnerCapacity", "checkWorkspace",
    ]);
    for (const a of run.activities.filter((x) => x.name === "requestOwnerCapacity")) {
        assert.equal(a.tag, OWNER_CAPACITY_CAPABILITY);
        assert.deepEqual(a.input, { sessionId: "s-1", ownerTag: OWNER });
    }
});

test("a deny ends the turn without a retry and takes no turn index; the next prompt asks again", () => {
    const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER }), {
        queue: [prompt("first"), { msg: prompt("second"), when: (h) => h.count("requestOwnerCapacity") >= 1 }],
        capacity: [{ decision: "deny", message: "This owner has no capacity." }],
        turns: [ran({ type: "completed", content: "ok" })],
    });
    assert.equal(run.count("requestOwnerCapacity"), 2);
    const turns = run.activities.filter((a) => a.name === "runTurnV5");
    assert.equal(turns.length, 1);
    assert.match(turns[0].input.prompt, /second/);
    assert.equal(turns[0].input.turnIndex, 0, "the refused turn took no index");
    const cms = run.activities.find((a) => a.name === "updateCmsState");
    assert.deepEqual([cms.input.state, cms.input.lastError, cms.input.closeControls], ["error", "This owner has no capacity.", true]);
    assert.ok(run.statuses.some((s) => s.status === "error" && s.nonRetryable === true && s.error === "This owner has no capacity."));
});

test("a busy answer holds the prompt on the busy timer without a turn, and a done command completes within the release cap", () => {
    const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER }), {
        queue: [prompt("hello", { clientMessageIds: ["m-1"] }), { msg: command("done"), when: (h) => h.count("requestOwnerCapacity") >= 1 }],
        capacity: [{ decision: "busy", retryAfterMs: 45_000, message: "The owner's workers are starting." }],
        hang: ["destroySession"],
    });
    assert.equal(run.done, true);
    assert.equal(run.result, "done");
    assert.equal(run.count("runTurnV5"), 0);
    const held = run.activities.find((a) => a.name === "recordSessionEvent" && a.input.events[0].eventType === "user.message");
    assert.equal(held.input.events[0].data.content, "hello");
    assert.equal(held.input.events[0].data.workspaceQueued, true);
    assert.ok(run.statuses.some((s) => s.status === "waiting" && s.gate === "workspace" && s.waitSeconds === 45));
    assert.ok(run.activities.some((a) => a.name === "updateCmsState" && a.input.state === "waiting" && a.input.waitReason === "The owner's workers are starting."));
    // The destroy found no worker of the owner: the cap ended the wait.
    assert.deepEqual(run.timersFired, [WORKSPACE_RELEASE_CAP_MS]);
    assert.ok(run.activities.some((a) => a.name === "destroySession" && a.lost && a.tag === OWNER));
});

test("a busy answer under the fast policy releases the worker at once, under the release cap, and asks again when the timer fires", () => {
    const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, workspaceBusyFastRelease: true }), {
        queue: [prompt("hello")],
        capacity: [{ decision: "busy" }],
        turns: [ran({ type: "completed", content: "ok" })],
        fireTimers: 1,
        hang: ["releaseWorkspace"],
    });
    assert.deepEqual(run.activities.map((a) => a.name).filter((n) => ["requestOwnerCapacity", "releaseWorkspace", "runTurnV5"].includes(n)),
        ["requestOwnerCapacity", "releaseWorkspace", "requestOwnerCapacity", "runTurnV5"]);
    assert.deepEqual(run.timersFired.slice(0, 2), [WORKSPACE_RELEASE_CAP_MS, 10_000]);
    const turn = run.activities.find((a) => a.name === "runTurnV5");
    assert.equal(turn.sessionId, "guid-1", "the turn runs under the affinity key the release made");
    assert.deepEqual(turn.input.stashedPrompts, ["hello"]);
});

test("a requester that does not answer: busy CAPACITY_UNAVAILABLE keeps the worker, even under the fast policy", () => {
    const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, workspaceBusyFastRelease: true }), {
        queue: [prompt("hello"), { msg: command("done"), when: (h) => h.count("requestOwnerCapacity") >= 1 }],
        capacity: [{ decision: "busy", code: CAPACITY_UNAVAILABLE, retryAfterMs: 60_000, message: "no answer" }],
    });
    assert.equal(run.result, "done");
    assert.equal(run.count("releaseWorkspace"), 0);
    assert.ok(!run.log.includes("newGuid"), "the affinity key did not rotate");
    assert.ok(run.statuses.some((s) => s.status === "waiting" && s.waitSeconds === 60 && s.workspaceCode === CAPACITY_UNAVAILABLE));
    const destroy = run.activities.find((a) => a.name === "destroySession");
    assert.equal(destroy.sessionId, "s-1");
});

test("unanswered capacity requests don't move the busy schedule on: each waits a minute, and none releases the worker", () => {
    const silent = { decision: "busy", code: CAPACITY_UNAVAILABLE, retryAfterMs: 60_000, message: "no answer" };
    const released = (run) => run.log.filter((line) => line.includes('"eventType":"session.affinity_released"')).length;
    for (const extra of [{}, { workspaceBusyFastRelease: true }]) {
        const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, ...extra }), {
            queue: [prompt("hello")],
            capacity: [silent, silent, silent, silent, silent],
            turns: [ran({ type: "completed", content: "ok" })],
            fireTimers: 5,
        });
        assert.deepEqual(run.timersFired, [60_000, 60_000, 60_000, 60_000, 60_000], JSON.stringify(extra));
        assert.equal(run.count("requestOwnerCapacity"), 6);
        assert.equal(released(run), 0);
        const turn = run.activities.find((a) => a.name === "runTurnV5");
        assert.equal(turn.sessionId, "s-1", "the turn runs under the session's first affinity key");
        assert.deepEqual(turn.input.stashedPrompts, ["hello"]);
    }
    // Around a counted busy answer: the silent ones before it leave it at the
    // first step, and the silent ones after it keep its step's wait.
    const counted = { decision: "busy", retryAfterMs: 1_000, message: "The owner's VM is starting." };
    const mixed = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER }), {
        queue: [prompt("hello")],
        capacity: [silent, silent, counted, silent, silent],
        turns: [ran({ type: "completed", content: "ok" })],
        fireTimers: 5,
    });
    assert.deepEqual(mixed.timersFired, [60_000, 60_000, 30_000, 120_000, 120_000]);
    assert.equal(mixed.count("runTurnV5"), 1);
});

test("the fast busy policy: the first WORKSPACE_BUSY refusal releases the worker and retries follow 10 s, 20 s, 1 min, 3 min", () => {
    const refusals = [busy("w1"), busy("w2"), busy("w2"), busy("w3")];
    const fast = drive(durableSessionOrchestration_1_0_84, baseInput({ workspaceBusyFastRelease: true }), {
        queue: [prompt("hello")], turns: [...refusals, ran({ type: "completed", content: "ok" })], fireTimers: 4,
    });
    assert.deepEqual(fast.timersFired, [10_000, 20_000, 60_000, 180_000]);
    assert.equal(fast.count("releaseWorkspace"), 4, "every refusal released the worker");
    // Today's policy for the same refusals: release after two in a row on one worker.
    const today = drive(durableSessionOrchestration_1_0_84, baseInput(), {
        queue: [prompt("hello")], turns: [...refusals, ran({ type: "completed", content: "ok" })], fireTimers: 4,
    });
    assert.deepEqual(today.timersFired, [30_000, 120_000, 300_000, 900_000]);
    assert.equal(today.count("releaseWorkspace"), 1);
    // A refusal with another code keeps today's schedule under the fast policy.
    const missing = drive(durableSessionOrchestration_1_0_84, baseInput({ workspaceBusyFastRelease: true }), {
        queue: [prompt("hello")], turns: [{ ...busy("w1"), code: "WORKSPACE_FOLDER_MISSING" }, ran({ type: "completed", content: "ok" })], fireTimers: 1,
    });
    assert.deepEqual(missing.timersFired, [30_000]);
    assert.equal(missing.count("releaseWorkspace"), 0);
});

test("a gate-held session without a workspace: untagged it escalates exactly as on 1.0.83; tagged or flagged it starts the schedule again after a turn runs", () => {
    // What happened before the model switch continued as new.
    const beforeSwitch = (run) => run.log.slice(0, run.log.findIndex((line) => line.startsWith("can(")));
    const holds = (run) => beforeSwitch(run).filter((line) => line.startsWith("status ")).map((line) => JSON.parse(line.slice(7)))
        .filter((s) => s.status === "waiting" && s.gate === "workspace").map((s) => s.waitSeconds);
    const released = (run) => beforeSwitch(run).filter((line) => line.includes('"eventType":"session.affinity_released"')).length;

    // Untagged and without the fast policy, 1.0.84 is 1.0.83: the second
    // hold takes the next step, and the second refusal on the worker releases it.
    const untagged = drive(durableSessionOrchestration_1_0_84, noWorkspace(), twoHolds());
    assert.deepEqual(untagged.log, drive(durableSessionOrchestration_1_0_83, noWorkspace(), twoHolds()).log);
    for (const handler of [durableSessionOrchestration_1_0_82, durableSessionOrchestration_1_0_83, durableSessionOrchestration_1_0_84]) {
        const run = drive(handler, noWorkspace(), twoHolds());
        assert.deepEqual(holds(run), [30, 120]);
        assert.equal(released(run), 1);
        assert.deepEqual(run.cans[0].input.workspaceRetry, { step: 2, failures: { workerNodeId: "w1", count: 2 } });
    }

    // With an owner tag or the fast policy, the turn that ran ended the hold:
    // the second starts at the schedule's first step, with one failure on the worker.
    for (const [extra, expected, releases] of [
        [{ ownerTag: OWNER }, [30, 30], 0],
        [{ workspaceBusyFastRelease: true }, [10, 10], 2],
        [{ ownerTag: OWNER, workspaceBusyFastRelease: true }, [10, 10], 2],
    ]) {
        const what = JSON.stringify(extra);
        const run = drive(durableSessionOrchestration_1_0_84, noWorkspace(extra), twoHolds());
        assert.equal(run.count("runTurnV5"), 4, what);
        assert.deepEqual(holds(run), expected, `${what}: the second hold starts at step 0`);
        assert.equal(released(run), releases, what);
        assert.deepEqual(run.cans[0].input.workspaceRetry, { step: 1, failures: { workerNodeId: "w1", count: 1 } }, what);
        assert.ok(!run.activities.some((a) => a.name === "recordSessionEvent" && a.input.events[0].eventType === "session.workspace_available"));
    }

    // A continue-as-new after the turn that ran: untagged, it carries the hold
    // as 1.0.82 and 1.0.83 do; tagged or flagged, it carries none.
    const idleSwitch = {
        queue: [prompt("first"), { msg: command("set_model", { model: "test:other" }), when: (h) => turnsOf(h) >= 2 }],
        turns: [busy("w1"), { type: "completed", content: "ok" }, { type: "completed", content: "on the new model" }],
        fireTimers: 1,
    };
    for (const handler of [durableSessionOrchestration_1_0_82, durableSessionOrchestration_1_0_83, durableSessionOrchestration_1_0_84]) {
        const carried = drive(handler, noWorkspace(), idleSwitch).cans[0].input;
        assert.deepEqual(carried.workspaceStatus, { state: "unavailable", code: "WORKSPACE_BUSY" });
        assert.deepEqual(carried.workspaceRetry, { step: 1, failures: { workerNodeId: "w1", count: 1 } });
    }
    for (const extra of [{ ownerTag: OWNER }, { workspaceBusyFastRelease: true }]) {
        const carried = drive(durableSessionOrchestration_1_0_84, noWorkspace(extra), idleSwitch).cans[0].input;
        assert.ok(!("workspaceStatus" in carried) && !("workspaceRetry" in carried), JSON.stringify(extra));
        assert.equal(carried.retryCount, 0);
    }
});

test("the admission hook's and the credential resolver's busy answers hold like a busy workspace; a tagged or flagged session starts over after a turn runs", () => {
    const admission = sessionAdmissionTurnResult({ decision: "busy", message: "the owner's disk is in use" }, { workerNodeId: "w1", orchestrationVersion: "1.0.84" });
    const credential = personalCredentialTurnResult(new PersonalCredentialError("busy", "github", "the secret store is busy"), "w1", "1.0.84");
    for (const refusal of [admission, credential]) {
        assert.deepEqual([refusal.type, refusal.gate, refusal.code, refusal.workerNodeId], ["wait", "workspace", "WORKSPACE_BUSY", "w1"]);
        // Untagged and without the fast policy, the second hold escalates, as on 1.0.83.
        for (const [extra, expected] of [[{}, [30, 120]], [{ ownerTag: OWNER }, [30, 30]], [{ workspaceBusyFastRelease: true }, [10, 10]]]) {
            const run = drive(durableSessionOrchestration_1_0_84, noWorkspace(extra), {
                queue: [prompt("first"), { msg: prompt("second"), when: (h) => turnsOf(h) >= 2 }],
                turns: [refusal, { type: "completed", content: "ok" }, refusal, { type: "completed", content: "ok" }],
                fireTimers: 2,
            });
            assert.equal(run.count("runTurnV5"), 4, refusal.reason);
            const holds = run.log.filter((line) => line.startsWith("status ")).map((line) => JSON.parse(line.slice(7)))
                .filter((s) => s.status === "waiting" && s.gate === "workspace").map((s) => s.waitSeconds);
            assert.deepEqual(holds, expected, `${refusal.reason} ${JSON.stringify(extra)}`);
        }
    }
});

test("a set-workspace command of an owner-tagged session: deny, busy and the cap answer it and keep the workspace", () => {
    const set = command("set_workspace", { expectedRevision: 1, workspace: { root: "repos", folder: "other" } });
    const answerOf = (run) => JSON.parse(run.kv.get("command.response.set_workspace-1"));
    const deny = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, workspaceRevision: 1 }), {
        queue: [set], capacity: [{ decision: "deny", message: "no capacity" }],
    });
    assert.equal(answerOf(deny).error, "CAPACITY_DENIED: no capacity");
    assert.equal(deny.count("checkWorkspace"), 0);
    const busyAnswer = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, workspaceRevision: 1 }), {
        queue: [set], capacity: [{ decision: "busy", retryAfterMs: 30_000 }],
    });
    assert.match(answerOf(busyAnswer).error, /^WORKSPACE_BUSY: /);
    assert.equal(answerOf(busyAnswer).result.retryAfterMs, 30_000);
    const capped = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, workspaceRevision: 1 }), {
        queue: [set, { msg: command("done"), when: (h) => h.count("checkWorkspace") >= 1 }], hang: ["checkWorkspace", "destroySession"],
    });
    assert.match(answerOf(capped).error, /^WORKSPACE_BUSY: the workspace check did not finish within 20 minutes/);
    assert.deepEqual(capped.timersFired, [WORKSPACE_CHECK_CAP_MS, WORKSPACE_RELEASE_CAP_MS]);
    assert.equal(capped.result, "done");
    for (const run of [deny, busyAnswer, capped]) {
        assert.equal(answerOf(run).result.revision, 1, "the workspace was kept");
        assert.ok(!run.activities.some((a) => a.name === "recordSessionEvent" && a.input.events[0].eventType === "session.workspace_changed"));
    }
});

test("complete, cancel and delete of an idle owner-tagged session finish when no worker declares the owner's tag", () => {
    for (const cmd of ["done", "cancel", "delete"]) {
        const run = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER }), {
            queue: [command(cmd)], hang: ["destroySession"],
        });
        assert.equal(run.done, true, cmd);
        assert.equal(run.result, { done: "done", cancel: "cancelled", delete: "deleted" }[cmd]);
        assert.deepEqual(run.timersFired, [WORKSPACE_RELEASE_CAP_MS], cmd);
        assert.equal(JSON.parse(run.kv.get(`command.response.${cmd}-1`)).result.ok, true, cmd);
        if (cmd === "delete") assert.ok(run.activities.some((a) => a.name === "deleteSession" && a.input.sessionId === "s-1"));
    }
    // When the owner's worker holds the session, the destroy wins the race at once.
    const held = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER }), { queue: [command("done")] });
    assert.deepEqual(held.timersFired, []);
    assert.ok(held.activities.some((a) => a.name === "destroySession" && !a.lost));
});

test("a system session and a system child never get the tag", () => {
    const system = drive(durableSessionOrchestration_1_0_84, baseInput({ ownerTag: OWNER, isSystem: true, config: { model: "test:model" } }), {
        queue: [prompt("hello")], turns: [{ type: "completed", content: "ok" }],
    });
    assert.equal(system.count("requestOwnerCapacity"), 0);
    assert.ok(system.activities.every((a) => a.tag !== OWNER));
    assert.ok(!("ownerTag" in system.activities.find((a) => a.name === "runTurnV5").input));
});
