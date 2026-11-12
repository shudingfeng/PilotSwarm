/**
 * Owner routing and Workflows (docs/proposals/windows-worker-pool.md,
 * "Workflows" and "New roots"). A Workflow carries no owner tag, so in an
 * owner-routed tree a Workflow is not started or tested: an agent's
 * spawn_workflow and workflow_definition start and test, and a person's
 * start, are refused. create_agent_session makes no new root there. With
 * owner routing off nothing changes.
 *
 * The agent's tools run in a real runTurn activity whose clients reach a
 * fake duroxide client and an in-memory catalog.
 *
 * Run: node --test test/unit/owner-routed-workflows.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerActivities } from "../../dist/session-proxy.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { NEW_ROOT_OWNER_ROUTED_TEXT, ownerRoutedTreeTag, WORKFLOW_OWNER_ROUTED } from "../../dist/owner-routing.js";

const USER = { provider: "entra", subject: "0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11" };
const OWNER = `owner.${USER.subject}`;
const HELPER = { name: "helper", description: "Helps.", prompt: "You help." };
const YAML = "name: tidy\nstart: done\nstates:\n  done: { type: succeed }\n";

function catalogOf(rows, configs = {}) {
    const rowMap = new Map(Object.entries(rows).map(([sessionId, row]) => [sessionId, { sessionId, rootSessionId: sessionId, parentSessionId: null, ...row }]));
    const configMap = new Map(Object.entries(configs));
    return {
        rows: rowMap,
        configs: configMap,
        async getSession(sessionId) { return rowMap.get(sessionId) ?? null; },
        async getSessionCreationConfig(sessionId) { return configMap.get(sessionId) ?? null; },
    };
}

test("a tree is owner-routed by the tag saved for its session or its root, and only so", async () => {
    const catalog = catalogOf({
        root: { owner: USER },
        child: { owner: USER, parentSessionId: "root", rootSessionId: "root" },
        "tagged-root": { owner: USER },
        "under-tagged-root": { owner: USER, parentSessionId: "tagged-root", rootSessionId: "tagged-root" },
        "system-root": { owner: USER, isSystem: true },
        "system-child": { owner: { provider: "system", subject: "system" }, parentSessionId: "system-root", rootSessionId: "system-root" },
        "system-owned": { owner: { provider: "system", subject: "system" } },
        unowned: { owner: null },
    }, {
        child: { ownerTag: OWNER },
        "tagged-root": { ownerTag: OWNER },
        unowned: { ownerTag: "not a tag" },
    });
    const saved = process.env.PILOTSWARM_OWNER_ROUTING;
    try {
        // The Portal's setting decides what it records, not what a tree is.
        for (const setting of [undefined, "1"]) {
            if (setting === undefined) delete process.env.PILOTSWARM_OWNER_ROUTING; else process.env.PILOTSWARM_OWNER_ROUTING = setting;
            assert.equal(await ownerRoutedTreeTag(catalog, "child"), OWNER, "a tag saved for the session");
            assert.equal(await ownerRoutedTreeTag(catalog, "under-tagged-root"), OWNER, "a tag saved for its root");
            assert.equal(await ownerRoutedTreeTag(catalog, "tagged-root"), OWNER);
            for (const id of ["root", "system-root", "system-child", "system-owned", "unowned", "missing"]) {
                assert.equal(await ownerRoutedTreeTag(catalog, id), undefined, `${id}: never tagged`);
            }
        }
    } finally {
        if (saved === undefined) delete process.env.PILOTSWARM_OWNER_ROUTING; else process.env.PILOTSWARM_OWNER_ROUTING = saved;
    }
});

// ─── The agent's tools ──────────────────────────────────────────────────────

function agentWorld() {
    const catalog = catalogOf({ parent: { state: "running", isSystem: false, owner: USER } });
    const world = { catalog, started: [] };
    Object.assign(catalog, {
        async createSession(sessionId, options) {
            catalog.rows.set(sessionId, {
                sessionId, state: "pending", parentSessionId: options.parentSessionId ?? null, rootSessionId: sessionId,
                isSystem: false, owner: options.owner ?? null, agentId: options.agentId ?? null,
            });
            catalog.configs.set(sessionId, options.creationConfig ?? null);
        },
        async listSessions() { return [...catalog.rows.values()]; },
        async updateSession(sessionId, updates) { Object.assign(catalog.rows.get(sessionId) ?? {}, updates); },
        async recordEvents() {},
        async completeTurnWriteback() {},
        async upsertChildOutcome() {},
        async getChildOutcome() { return null; },
        async setActiveTurnIndex() {},
    });
    world.duroxide = {
        async getStatus() { return { status: "Running" }; },
        async startOrchestrationVersioned(instance, _name, input) { world.started.push({ instance, input }); },
        async enqueueEvent() {},
    };
    return world;
}

/** One turn of "parent", with or without an owner tag, whose agent makes each call in turn. */
async function runAgentTurn(world, ownerTag, calls) {
    const saved = { start: PilotSwarmClient.prototype.start, stop: PilotSwarmClient.prototype.stop };
    Object.assign(PilotSwarmClient.prototype, {
        async start() { this.duroxideClient = world.duroxide; this._catalog = world.catalog; this.started = true; },
        async stop() {},
    });
    try {
        const replies = [];
        const session = {
            abort() {},
            runTurn: async (_prompt, { controlToolBridge: bridge }) => {
                for (const call of calls) replies.push(String(await call(bridge)));
                return { type: "completed", events: [], content: "Done." };
            },
        };
        const sessionManager = {
            withRunTurnLock: async (_sessionId, _operation, fn) => fn(),
            getOrCreate: async () => session,
            getModelSummary: () => undefined,
            getWorkspaceProvider: () => null,
            resetSessionState: async () => {},
        };
        const handlers = {};
        registerActivities({ registerActivity: (name, handler) => { handlers[name] = handler; } }, sessionManager,
            null, undefined, world.catalog, undefined, "sqlite::memory:",
            undefined, undefined, [], null, [], [HELPER], null, "worker-a");
        await handlers.runTurn({ traceInfo() {}, isCancelled: () => false }, {
            sessionId: "parent", prompt: "Do the work.", config: {}, turnIndex: 0, ...(ownerTag ? { ownerTag } : {}),
        });
        return replies;
    } finally {
        Object.assign(PilotSwarmClient.prototype, saved);
    }
}

const codeOf = (reply) => {
    try { return JSON.parse(reply)?.error?.code ?? null; } catch { return null; }
};

const WORKFLOW_CALLS = [
    (bridge) => bridge.spawnWorkflow({ yaml: YAML, start: true, key: "tidy" }, { toolCallId: "call-1" }),
    (bridge) => bridge.spawnWorkflow({ yaml: YAML, key: "tidy-save" }, { toolCallId: "call-2" }),
    (bridge) => bridge.workflowDefinition({ operation: "start", name: "tidy" }, { toolCallId: "call-3" }),
    (bridge) => bridge.workflowDefinition({ operation: "test", name: "tidy" }, { toolCallId: "call-4" }),
];

test("in an owner-routed turn, spawn_workflow and workflow_definition start and test are refused; its other operations are not", async () => {
    const world = agentWorld();
    const replies = await runAgentTurn(world, OWNER, [
        ...WORKFLOW_CALLS,
        (bridge) => bridge.workflowDefinition({ operation: "list" }, { toolCallId: "call-5" }),
        (bridge) => bridge.workflowDefinition({ operation: "save", name: "tidy", yaml: YAML }, { toolCallId: "call-6" }),
    ]);
    assert.deepEqual(replies.slice(0, 4).map(codeOf), Array(4).fill(WORKFLOW_OWNER_ROUTED));
    assert.match(JSON.parse(replies[0]).error.message, /owner's workers/);
    for (const reply of replies.slice(4)) assert.notEqual(codeOf(reply), WORKFLOW_OWNER_ROUTED, reply);
    assert.deepEqual(world.started, [], "nothing was started");
});

test("without an owner tag the Workflow tools are not refused for owner routing", async () => {
    const replies = await runAgentTurn(agentWorld(), undefined, WORKFLOW_CALLS);
    assert.equal(replies.length, 4);
    for (const reply of replies) assert.notEqual(codeOf(reply), WORKFLOW_OWNER_ROUTED, reply);
});

test("in an owner-routed turn create_agent_session makes no new root; without an owner tag it does", async () => {
    const tagged = agentWorld();
    const [refused] = await runAgentTurn(tagged, OWNER, [(bridge) => bridge.createAgentSession({ agent_name: "helper", prompt: "Check it." })]);
    assert.equal(refused, NEW_ROOT_OWNER_ROUTED_TEXT);
    assert.deepEqual([...tagged.catalog.rows.keys()], ["parent"]);
    assert.deepEqual(tagged.started, []);

    const plain = agentWorld();
    const [created] = await runAgentTurn(plain, undefined, [(bridge) => bridge.createAgentSession({ agent_name: "helper", prompt: "Check it." })]);
    assert.match(created, /created top-level session/);
    assert.equal(plain.catalog.rows.size, 2);
    assert.equal(plain.started.length, 1);
    assert.ok(!("ownerTag" in plain.started[0].input));
});

// ─── A person's start ───────────────────────────────────────────────────────

test("a person's start of a Workflow is refused in an owner-routed tree (409 WORKFLOW_OWNER_ROUTED), and only there", async () => {
    const catalog = catalogOf({
        root: { owner: USER },
        child: { owner: USER, parentSessionId: "root", rootSessionId: "root" },
        "system-root": { owner: USER, isSystem: true },
        "routed-root": { owner: USER },
        "routed-child": { owner: USER, parentSessionId: "routed-root", rootSessionId: "routed-root" },
    }, { child: { ownerTag: OWNER }, "routed-root": { ownerTag: OWNER } });
    catalog.workflowStore = () => ({});
    const managementClient = () => {
        const client = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
        client._catalog = catalog;
        client._started = true;
        return client;
    };
    const start = (client, sessionId) => client.startSessionWorkflowDefinition(sessionId, { definitionId: "def-1", operationId: "op-1" },
        { principal: USER });
    const failure = async (promise) => {
        try { await promise; } catch (error) { return error; }
        assert.fail("expected the start to fail");
    };

    const saved = process.env.PILOTSWARM_OWNER_ROUTING;
    try {
        // The Portal's setting decides what it records, not where a person may start a Workflow.
        for (const setting of [undefined, "1"]) {
            if (setting === undefined) delete process.env.PILOTSWARM_OWNER_ROUTING; else process.env.PILOTSWARM_OWNER_ROUTING = setting;
            for (const sessionId of ["child", "routed-root", "routed-child"]) {
                const error = await failure(start(managementClient(), sessionId));
                assert.deepEqual([error.code, error.status], [WORKFLOW_OWNER_ROUTED, 409], `${sessionId} PILOTSWARM_OWNER_ROUTING=${setting}`);
                assert.match(error.message, /owner's workers/);
            }
            // Not owner-routed: the start goes on (and fails later, on this test's empty store, for another reason).
            for (const sessionId of ["root", "system-root"]) {
                const error = await failure(start(managementClient(), sessionId));
                assert.notEqual(error.code, WORKFLOW_OWNER_ROUTED, `${sessionId} PILOTSWARM_OWNER_ROUTING=${setting}`);
            }
        }
    } finally {
        if (saved === undefined) delete process.env.PILOTSWARM_OWNER_ROUTING; else process.env.PILOTSWARM_OWNER_ROUTING = saved;
    }
});
