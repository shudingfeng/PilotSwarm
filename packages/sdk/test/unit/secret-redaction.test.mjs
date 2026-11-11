/**
 * Secret redaction for what PilotSwarm persists. With
 * PILOTSWARM_PERSONAL_SECRETS=external, GitHub tokens are redacted from
 * session events (tool output included), live updates, the session row's
 * error and wait text, canvas names, stored turn results, what an agent
 * sends to another session (tasks, messages, reasons, handoffs, sub-agent
 * contracts and results) and the process's logs, together with any prefix in
 * PILOTSWARM_REDACT_SECRET_PREFIXES. With neither setting nothing changes.
 *
 * The session catalog runs over a pool that only records queries; the logs
 * are checked in a child process, so this process's streams stay untouched.
 * An agent's tools run in a real runTurn activity whose clients reach a fake
 * duroxide client.
 *
 * Run: node --test test/unit/secret-redaction.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactSecretPrefixes, redactSecrets, redactSecretsIn } from "../../dist/secret-redaction.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import { persistedTurnResult, registerActivities } from "../../dist/session-proxy.js";
import { resetSessionMessageRateLimitsForTests } from "../../dist/session-messages.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { PilotSwarmWorker } from "../../dist/index.js";

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FINE_GRAINED = `github_pat_11ABCDEFG0123456789_${"a".repeat(59)}`;
const CLASSIC = `ghp_${"b".repeat(36)}`;
const OAUTH = `gho_${"c".repeat(36)}`;
const WORK_CREDENTIAL = "acme_eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const EXTERNAL = { PILOTSWARM_PERSONAL_SECRETS: "external" };
const BOTH = { ...EXTERNAL, PILOTSWARM_REDACT_SECRET_PREFIXES: "acme_" };

function withEnv(t, settings) {
    const saved = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(settings)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

test("with neither setting, nothing is redacted and values pass through as they are", () => {
    const text = `token ${CLASSIC} and ${WORK_CREDENTIAL}`;
    assert.equal(redactSecrets(text, {}), text);
    const value = { data: { result: text } };
    assert.equal(redactSecretsIn(value, {}), value);
    assert.equal(redactSecretsIn(value, { PILOTSWARM_PERSONAL_SECRETS: "database" }), value);
});

test("external mode redacts every GitHub token kind, keeping only its prefix", () => {
    const text = `fine ${FINE_GRAINED}, classic "${CLASSIC}", url https://x:${OAUTH}@github.com/o/r, `
        + `ghu_${"d".repeat(36)} ghs_${"e".repeat(36)} ghr_${"f".repeat(76)}`;
    assert.equal(redactSecrets(text, EXTERNAL),
        'fine github_pat_[REDACTED], classic "ghp_[REDACTED]", url https://x:gho_[REDACTED]@github.com/o/r, '
        + "ghu_[REDACTED] ghs_[REDACTED] ghr_[REDACTED]");
    assert.equal(redactSecrets("the ghp_ prefix, my_ghp_setting and GHP_LOUD stay", EXTERNAL),
        "the ghp_ prefix, my_ghp_setting and GHP_LOUD stay");
    assert.equal(redactSecrets(`GITHUB_TOKEN=${CLASSIC}\n`, EXTERNAL), "GITHUB_TOKEN=ghp_[REDACTED]\n");
});

test("a listed prefix is redacted in either mode, GitHub tokens only in external mode", () => {
    const text = `credential ${WORK_CREDENTIAL}; and ${CLASSIC}`;
    assert.equal(redactSecrets(text, { PILOTSWARM_REDACT_SECRET_PREFIXES: "acme_" }), `credential acme_[REDACTED]; and ${CLASSIC}`);
    assert.equal(redactSecrets(text, BOTH), "credential acme_[REDACTED]; and ghp_[REDACTED]");
    assert.deepEqual(redactSecretPrefixes({ PILOTSWARM_REDACT_SECRET_PREFIXES: " acme_, sk-live-,acme_ " }), ["acme_", "sk-live-"]);
    for (const bad of ["a", "ab", "_x1", "a b", "x*1", "-ab"]) {
        assert.throws(() => redactSecretPrefixes({ PILOTSWARM_REDACT_SECRET_PREFIXES: bad }), /PILOTSWARM_REDACT_SECRET_PREFIXES/, bad);
    }
});

test("values are redacted all the way down, keys included, and the original is left alone", () => {
    const original = {
        content: `Here is ${CLASSIC}`,
        events: [{ eventType: "tool.execution_complete", data: { result: { content: `export TOKEN=${FINE_GRAINED}` } } }],
        [`${OAUTH}`]: 1,
        at: new Date(0),
        count: 3,
    };
    const redacted = redactSecretsIn(original, EXTERNAL);
    assert.equal(redacted.content, "Here is ghp_[REDACTED]");
    assert.equal(redacted.events[0].data.result.content, "export TOKEN=github_pat_[REDACTED]");
    assert.equal(redacted["gho_[REDACTED]"], 1);
    assert.equal(redacted.at, original.at);
    assert.equal(redacted.count, 3);
    assert.equal(original.content, `Here is ${CLASSIC}`);
});

function catalogOver() {
    const queries = [];
    const pool = {
        query: async (sql, params) => {
            const text = typeof sql === "string" ? sql : sql.text;
            queries.push({ text, params: typeof sql === "string" ? params : sql.values });
            if (text.includes("cms_live_available")) return { rows: [{ t: true }] };
            return { rows: [{ r: {}, result: { seq: 1 } }] };
        },
    };
    return { catalog: new PgSessionCatalog(pool, "ps"), queries };
}

test("the session catalog redacts events, prompts, live updates and the session row, title included, before PostgreSQL sees them", async (t) => {
    withEnv(t, BOTH);
    const { catalog, queries } = catalogOver();
    await catalog.recordEvents("s1", [
        { eventType: "tool.execution_complete", data: { result: { content: `$env:TOKEN is ${FINE_GRAINED}` } } },
        { eventType: "assistant.message", data: { content: `use ${WORK_CREDENTIAL}` } },
    ]);
    await catalog.turnStart("s1", 1, [{ eventType: "user.message", data: { content: `my key is ${CLASSIC}` } }]);
    await catalog.publishLive("s1", "turn", { snapshot: { text: `streaming ${OAUTH}` } }, "worker-a");
    await catalog.updateSession("s1", { title: `Rotate ${OAUTH}`, lastError: `failed with ${CLASSIC}`, waitReason: `waiting on ${WORK_CREDENTIAL}` });
    await catalog.completeTurnWriteback({
        sessionId: "s1", agentId: null, model: null, reasoningEffort: null, turnIndex: 1, startedAt: new Date(0), endedAt: new Date(0),
        durationMs: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, toolCalls: 0, toolErrors: 0,
        toolNames: [], resultType: "error", errorMessage: `bad ${CLASSIC}`, workerNodeId: "w", state: "error",
        lastActiveAt: new Date(0), lastError: `bad ${CLASSIC}`, waitReason: null, currentIteration: 1,
    });
    const sent = JSON.stringify(queries);
    for (const secret of [FINE_GRAINED, CLASSIC, OAUTH, WORK_CREDENTIAL]) {
        assert.equal(sent.includes(secret), false, `${secret.slice(0, 10)}… reached PostgreSQL`);
    }
    assert.match(sent, /github_pat_\[REDACTED\]/);
    assert.match(sent, /acme_\[REDACTED\]/);
});

test("without the settings, the session catalog writes exactly what it is given", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: undefined, PILOTSWARM_REDACT_SECRET_PREFIXES: undefined });
    const { catalog, queries } = catalogOver();
    const events = [{ eventType: "assistant.message", data: { content: `use ${CLASSIC}` } }];
    await catalog.recordEvents("s1", events);
    assert.equal(queries[0].params[1], JSON.stringify(events));
});

const CHILD_OUTCOME = {
    childSessionId: "child",
    parentSessionId: "parent",
    contractJson: { current: { purpose: `Rotate ${CLASSIC}` } },
    resultJson: { current: { summary: `Rotated ${FINE_GRAINED}`, details: { [WORK_CREDENTIAL]: true } } },
    verdict: `done ${OAUTH}`,
    summary: `Rotated ${FINE_GRAINED}`,
    completedAt: null,
};

test("the session catalog redacts a sub-agent's contract and result, and a canvas's name", async (t) => {
    withEnv(t, BOTH);
    const { catalog, queries } = catalogOver();
    await catalog.upsertChildOutcome(CHILD_OUTCOME);
    await catalog.upsertSessionCanvas("s1", 1, `Deploy ${CLASSIC}`, 1, 10);
    assert.deepEqual(queries[0].params.slice(2, 6), [
        JSON.stringify({ current: { purpose: "Rotate ghp_[REDACTED]" } }),
        JSON.stringify({ current: { summary: "Rotated github_pat_[REDACTED]", details: { "acme_[REDACTED]": true } } }),
        "done gho_[REDACTED]",
        "Rotated github_pat_[REDACTED]",
    ]);
    assert.equal(queries[1].params[2], "Deploy ghp_[REDACTED]");
});

test("without the settings, a sub-agent's contract and result and a canvas's name are written as given", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: undefined, PILOTSWARM_REDACT_SECRET_PREFIXES: undefined });
    const { catalog, queries } = catalogOver();
    await catalog.upsertChildOutcome(CHILD_OUTCOME);
    await catalog.upsertSessionCanvas("s1", 1, `Deploy ${CLASSIC}`, 1, 10);
    assert.deepEqual(queries[0].params.slice(2, 6), [
        JSON.stringify(CHILD_OUTCOME.contractJson),
        JSON.stringify(CHILD_OUTCOME.resultJson),
        CHILD_OUTCOME.verdict,
        CHILD_OUTCOME.summary,
    ]);
    assert.equal(queries[1].params[2], `Deploy ${CLASSIC}`);
});

// An agent's tools in a real runTurn activity. Its clients reach a fake
// duroxide client; the catalog keeps rows in memory and writes through
// PgSessionCatalog over a recording pool, so the test sees what the queue,
// the orchestration's inputs and PostgreSQL get.
const ALICE = { provider: "dev", subject: "user-0001", displayName: "Alice Example", email: "alice@example.invalid" };
const HELPER = { name: "helper", description: "Helps.", prompt: "You help." };

/** One place an agent's text leaves its turn, with two GitHub tokens and a deployment credential. */
const said = (place) => `${place} ghp_${place.padEnd(36, "0")} github_pat_11${place.padEnd(22, "0")}_${"a".repeat(59)} acme_${place}.c2lnbmF0dXJl`;
const redactedSaid = (place) => `${place} ghp_[REDACTED] github_pat_[REDACTED] acme_[REDACTED]`;
const tokensOf = (place) => said(place).split(" ").slice(1);

const PLACES = [
    "spawnTask", "spawnSystemMessage", "spawnContract", "messageQueued", "contractPatch", "messageSteered",
    "childHandoff", "childInstructions", "selfHandoff", "selfInstructions", "stopReason", "completeResult",
    "cancelReason", "cancelPartial", "deleteReason", "sessionSubject", "sessionBody", "sessionReply",
    "managerMessage", "managerReason", "managerPrompt",
];

function agentWorld() {
    const rows = new Map([
        ["parent", { sessionId: "parent", state: "running", parentSessionId: null, rootSessionId: "parent", isSystem: false, owner: ALICE }],
        ["peer", { sessionId: "peer", state: "running", parentSessionId: null, rootSessionId: "peer", isSystem: false, owner: ALICE }],
    ]);
    const creationConfigs = new Map();
    const { catalog: database, queries } = catalogOver();
    const world = { rows, queries, enqueued: [], started: [], controls: [] };
    world.duroxide = {
        async getStatus() { return { status: "Running" }; },
        async startOrchestrationVersioned(instance, _name, input) { world.started.push({ instance, input }); },
        async enqueueEvent(instance, queue, payload) { world.enqueued.push({ instance, queue, payload: JSON.parse(payload) }); },
    };
    world.catalog = {
        async getSession(sessionId) { return rows.get(sessionId) ?? null; },
        async listSessions() { return [...rows.values()]; },
        async createSession(sessionId, options) {
            rows.set(sessionId, {
                sessionId, state: "pending", parentSessionId: options.parentSessionId ?? null, rootSessionId: sessionId,
                isSystem: false, owner: options.owner ?? null, agentId: options.agentId ?? null,
            });
            creationConfigs.set(sessionId, options.creationConfig ?? null);
        },
        async getSessionCreationConfig(sessionId) { return creationConfigs.get(sessionId) ?? null; },
        async updateSession(sessionId, updates) {
            Object.assign(rows.get(sessionId) ?? {}, updates);
            await database.updateSession(sessionId, updates);
        },
        recordEvents: (...args) => database.recordEvents(...args),
        completeTurnWriteback: (...args) => database.completeTurnWriteback(...args),
        upsertChildOutcome: (input) => database.upsertChildOutcome(input),
        async getChildOutcome() { return null; },
        async setActiveTurnIndex() {},
    };
    world.persisted = () => JSON.stringify([world.enqueued, world.started, [...creationConfigs.values()], world.controls, queries]);
    return world;
}

/** Runs one turn of "parent" whose agent calls every tool that sends text to another session. */
async function runAgentTurn(world) {
    const clientMethods = ["start", "stop"];
    const managementMethods = ["start", "stop", "steerSessionTurn", "stopSessionTurn"];
    const savedClient = Object.fromEntries(clientMethods.map((name) => [name, PilotSwarmClient.prototype[name]]));
    const savedManagement = Object.fromEntries(managementMethods.map((name) => [name, PilotSwarmManagementClient.prototype[name]]));
    Object.assign(PilotSwarmClient.prototype, {
        async start() { this.duroxideClient = world.duroxide; this._catalog = world.catalog; this.started = true; },
        async stop() {},
    });
    Object.assign(PilotSwarmManagementClient.prototype, {
        async start() {},
        async stop() {},
        async steerSessionTurn(sessionId, opts) { world.controls.push({ sessionId, text: opts.text }); return { outcome: "accepted", steerId: 1, turn: 1 }; },
        async stopSessionTurn(sessionId, opts) { world.controls.push({ sessionId, text: opts.reason }); return { outcome: "stopped", controlSeq: 2 }; },
    });
    try {
        const replies = [];
        const session = {
            abort() {},
            runTurn: async (_prompt, { controlToolBridge: bridge }) => {
                const calls = [
                    () => bridge.spawnAgent({ task: said("spawnTask"), system_message: said("spawnSystemMessage"), contract: { purpose: said("spawnContract") } }),
                    (child) => bridge.messageAgent({ agent_id: child, message: said("messageQueued"), contract_patch: { note: said("contractPatch") } }),
                    (child) => bridge.messageAgent({ agent_id: child, message: said("messageSteered"), deliver: "now" }, { toolCallId: "call-1" }),
                    (child) => bridge.regenerateAgent({ agent_id: child, handoff: said("childHandoff"), instructions: said("childInstructions") }),
                    () => bridge.regenerateContext({ handoff: said("selfHandoff"), instructions: said("selfInstructions") }),
                    (child) => bridge.stopAgentTurn({ agent_id: child, reason: said("stopReason") }, { toolCallId: "call-2" }),
                    (child) => bridge.completeAgent({ agent_id: child, result: { verdict: "done", summary: said("completeResult") } }),
                    (child) => bridge.cancelAgent({ agent_id: child, reason: said("cancelReason"), partial_result: { summary: said("cancelPartial") } }),
                    (child) => bridge.deleteAgent({ agent_id: child, reason: said("deleteReason") }),
                    () => bridge.sendSessionMessage({ session_id: "peer", subject: said("sessionSubject"), body: said("sessionBody") }),
                    () => bridge.replySessionMessage({ request_id: "request-0001", session_id: "peer", body: said("sessionReply") }),
                    () => bridge.messageAgentSession({ session_id: "peer", message: said("managerMessage") }),
                    () => bridge.manageAgentSession({ session_id: "peer", action: "cancel", reason: said("managerReason") }),
                    () => bridge.createAgentSession({ agent_name: "helper", prompt: said("managerPrompt") }),
                ];
                for (const call of calls) {
                    const child = [...world.rows.values()].find((row) => row.parentSessionId === "parent");
                    replies.push(String(await call(child && `session-${child.sessionId}`)));
                }
                return { type: "completed", events: [], content: "Delegated." };
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
        resetSessionMessageRateLimitsForTests();
        await handlers.runTurn({ traceInfo() {}, isCancelled: () => false }, {
            sessionId: "parent", prompt: "Delegate the rotation.", config: {}, turnIndex: 0,
        });
        assert.equal(replies.length, 14);
        for (const reply of replies) assert.doesNotMatch(reply, /failed|refused|Error/, reply);
        const childId = [...world.rows.values()].find((row) => row.parentSessionId === "parent").sessionId;
        const queued = (instance) => world.enqueued.filter((event) => event.instance === instance).map((event) => event.payload);
        return {
            child: queued(`session-${childId}`),
            peer: queued("session-peer"),
            completed: world.queries.find((query) => query.text.includes("cms_upsert_child_outcome") && query.params[4] === "done"),
        };
    } finally {
        Object.assign(PilotSwarmClient.prototype, savedClient);
        Object.assign(PilotSwarmManagementClient.prototype, savedManagement);
    }
}

test("in external mode, what an agent sends to another session is redacted before it is queued or stored", async (t) => {
    withEnv(t, BOTH);
    const world = agentWorld();
    const { child, peer, completed } = await runAgentTurn(world);
    const persisted = world.persisted();
    assert.deepEqual(PLACES.filter((place) => tokensOf(place).some((token) => persisted.includes(token))), [],
        "places whose tokens reached the queue, an orchestration input or PostgreSQL");
    // The sub-agent's task, its next-turn message, and a session message and reply.
    assert.equal(child[0].prompt, redactedSaid("spawnTask"));
    assert.deepEqual(child[1], { prompt: redactedSaid("messageQueued") });
    assert.ok(peer[0].prompt.includes(`subject=${redactedSaid("sessionSubject")}`), peer[0].prompt);
    assert.ok(peer[0].prompt.endsWith(`Request body:\n${redactedSaid("sessionBody")}`), peer[0].prompt);
    assert.ok(peer[1].prompt.endsWith(`\n\n${redactedSaid("sessionReply")}`), peer[1].prompt);
    // complete_agent's result, as session_child_outcomes stores it.
    assert.equal(JSON.parse(completed.params[3]).current.summary, redactedSaid("completeResult"));
    assert.equal(completed.params[5], redactedSaid("completeResult"));
});

test("without the settings, what an agent sends to another session is queued and stored as written", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: undefined, PILOTSWARM_REDACT_SECRET_PREFIXES: undefined });
    const world = agentWorld();
    const { child, peer, completed } = await runAgentTurn(world);
    const persisted = world.persisted();
    assert.deepEqual(PLACES.filter((place) => !tokensOf(place).every((token) => persisted.includes(token))), []);
    assert.equal(persisted.includes("[REDACTED]"), false);
    assert.equal(child[0].prompt, said("spawnTask"));
    assert.deepEqual(child[1], { prompt: said("messageQueued") });
    assert.ok(peer[0].prompt.endsWith(`Request body:\n${said("sessionBody")}`), peer[0].prompt);
    assert.ok(peer[1].prompt.endsWith(`\n\n${said("sessionReply")}`), peer[1].prompt);
    assert.equal(JSON.parse(completed.params[3]).current.summary, said("completeResult"));
    assert.equal(completed.params[5], said("completeResult"));
});

test("a stored turn result has its tool output and text redacted", (t) => {
    withEnv(t, EXTERNAL);
    const stored = persistedTurnResult({
        type: "completed",
        content: `The token is ${CLASSIC}`,
        events: [
            { eventType: "tool.execution_complete", data: { result: { content: FINE_GRAINED } } },
            { eventType: "assistant.message_delta", data: { deltaContent: CLASSIC } },
        ],
    });
    assert.equal(stored.content, "The token is ghp_[REDACTED]");
    assert.deepEqual(stored.events, [{ eventType: "tool.execution_complete", data: { result: { content: "github_pat_[REDACTED]" } } }]);
});

test("logs are redacted: stdout, stderr and the orchestration and activity traces", () => {
    const url = pathToFileURL(join(SDK_DIR, "dist", "secret-redaction.js")).href;
    const script = [
        'import { createRequire } from "node:module";',
        "const durable = createRequire(import.meta.url)(\"duroxide\");",
        "const traced = [];",
        "for (const context of [durable.OrchestrationContext, durable.ActivityContext]) {",
        "    context.prototype.traceInfo = (message) => traced.push(message);",
        "}",
        `const { installLogRedaction } = await import(${JSON.stringify(url)});`,
        "if (!installLogRedaction()) throw new Error(\"redaction did not install\");",
        "installLogRedaction();",
        `console.log("out ${CLASSIC}");`,
        `process.stderr.write(Buffer.from("err ${WORK_CREDENTIAL}\\n"));`,
        `durable.OrchestrationContext.prototype.traceInfo.call({}, "orch ${FINE_GRAINED}");`,
        `durable.ActivityContext.prototype.traceInfo.call({}, "act ${OAUTH}");`,
        "console.log(JSON.stringify(traced));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: SDK_DIR, encoding: "utf8", env: { ...process.env, ...BOTH },
    });
    assert.equal(run.status, 0, run.stderr);
    const [line, traces] = run.stdout.trim().split("\n");
    assert.equal(line, "out ghp_[REDACTED]");
    assert.equal(run.stderr.trim(), "err acme_[REDACTED]");
    assert.deepEqual(JSON.parse(traces), ["orch github_pat_[REDACTED]", "act gho_[REDACTED]"]);
});

test("a worker refuses to start with a malformed prefix list", (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-redaction-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    withEnv(t, { PILOTSWARM_REDACT_SECRET_PREFIXES: "acme_,x" });
    assert.throws(
        () => new PilotSwarmWorker({ sessionStateDir: join(root, "sessions"), disableManagementAgents: true }),
        /PILOTSWARM_REDACT_SECRET_PREFIXES: "x" is not a token prefix/,
    );
});
