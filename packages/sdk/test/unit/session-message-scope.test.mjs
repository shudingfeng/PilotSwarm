// The session message scope (worker option `sessionMessageScope`, set from
// PILOTSWARM_SESSION_MESSAGE_SCOPE by the bundled worker entrypoints). "owner"
// delivers a session message or reply only between sessions with the same
// user owner, or between system sessions, and refuses anything else with
// policy_denied before it is queued. Unset or "fleet" delivers as before.
//
// Run: node --test test/unit/session-message-scope.test.mjs (after npm run build)
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    replyInternalSessionMessage,
    resetSessionMessageRateLimitsForTests,
    resolveSessionMessageScope,
    sendInternalSessionMessage,
} from "../../dist/session-messages.js";
import { registerActivities } from "../../dist/session-proxy.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { PilotSwarmWorker } from "../../dist/worker.js";

const alice = { provider: "dev", subject: "user-0001", displayName: "Alice Example", email: "alice@example.invalid" };
const bob = { provider: "dev", subject: "user-0002", displayName: "Bob Example", email: "bob@example.invalid" };
const systemUser = { provider: "system", subject: "system", displayName: "System", email: null };

// Catalog rows. A session is its own root unless it names another.
const row = (sessionId, fields = {}) => ({
    sessionId, state: "running", parentSessionId: null, isSystem: false, owner: null, rootSessionId: sessionId, ...fields,
});
const ROWS = [
    row("alice-1", { owner: alice }),
    row("alice-2", { owner: alice, parentSessionId: "alice-1", rootSessionId: "alice-1" }),
    row("bob-1", { owner: bob }),
    row("system-1", { isSystem: true, agentId: "facts-manager" }),
    row("system-2", { isSystem: true, agentId: "sweeper" }),
    // A system session's child: the system user owns it; it is not isSystem itself.
    row("system-child", { owner: systemUser, parentSessionId: "system-1", rootSessionId: "system-1" }),
    // A user-owned session under a system root counts as system.
    row("under-system", { owner: alice, parentSessionId: "system-2", rootSessionId: "system-2" }),
    row("unowned"),
];

function harness(scope) {
    const sessions = new Map(ROWS.map((r) => [r.sessionId, r]));
    const enqueued = [];
    const lookups = [];
    const runtime = {
        catalog: {
            async getSession(sessionId) {
                lookups.push(sessionId);
                return sessions.get(sessionId) ?? null;
            },
        },
        duroxideClient: {
            async getStatus() { return { status: "Running" }; },
            async enqueueEvent(orchestrationId, eventName, payload) {
                enqueued.push({ orchestrationId, eventName, prompt: JSON.parse(payload).prompt });
            },
        },
        ...(scope === undefined ? {} : { scope }),
    };
    return { runtime, enqueued, lookups };
}

const send = (runtime, from, to) => sendInternalSessionMessage(runtime, {
    fromSessionId: from, toSessionId: to, subject: "Release notes", body: "Where are the release notes?",
});
const reply = (runtime, from, to) => replyInternalSessionMessage(runtime, {
    requestId: "request-0001", fromSessionId: from, toSessionId: to, verdict: "answered", body: "Drafted.",
});

const REFUSED = [
    ["owner A's session to owner B's", "alice-1", "bob-1"],
    ["a system session to a user session", "system-1", "alice-1"],
    ["a user session to a system session", "alice-1", "system-1"],
    ["a child the system user owns to a user session", "system-child", "alice-1"],
    ["a user session to a child the system user owns", "alice-1", "system-child"],
    ["a session under a system root to its owner's session", "under-system", "alice-1"],
    ["an unowned session to a user session", "unowned", "alice-1"],
];
const DELIVERED = [
    ["within owner A's sessions", "alice-1", "alice-2"],
    ["between system sessions", "system-1", "system-2"],
    ["from a child the system user owns to a system session", "system-child", "system-2"],
    ["from a session under a system root to a system session", "under-system", "system-1"],
];

beforeEach(() => resetSessionMessageRateLimitsForTests());

for (const [label, from, to] of REFUSED) {
    test(`owner scope refuses a message and a reply from ${label}, before anything is queued`, async () => {
        const { runtime, enqueued } = harness("owner");
        await assert.rejects(send(runtime, from, to), /^Error: session message policy_denied: /);
        await assert.rejects(reply(runtime, from, to), /^Error: session reply policy_denied: /);
        assert.deepEqual(enqueued, []);
    });
}

for (const [label, from, to] of DELIVERED) {
    test(`owner scope delivers a message and a reply ${label}, in both directions`, async () => {
        const { runtime, enqueued } = harness("owner");
        await send(runtime, from, to);
        await reply(runtime, to, from);
        await send(runtime, to, from);
        await reply(runtime, from, to);
        assert.deepEqual(enqueued.map((event) => event.orchestrationId),
            [`session-${to}`, `session-${from}`, `session-${from}`, `session-${to}`]);
        assert.ok(enqueued.every((event) => event.eventName === "messages"));
    });
}

test("refused messages use no rate budget: the same pair still delivers after the scope allows it", async () => {
    const owner = harness("owner");
    for (let i = 0; i < 12; i++) await assert.rejects(send(owner.runtime, "alice-1", "bob-1"), /policy_denied/);
    const fleet = harness("fleet");
    await send(fleet.runtime, "alice-1", "bob-1");
    assert.equal(fleet.enqueued.length, 1, "twelve refusals used none of the pair's limit of three");
});

test("the worker's activities hand their scope to both tools: two registrations, two scopes, one process", async () => {
    const enqueued = [];
    const duroxideClient = {
        async getStatus() { return { status: "Running" }; },
        async enqueueEvent(orchestrationId) { enqueued.push(orchestrationId); },
    };
    const sessions = new Map(ROWS.map((r) => [r.sessionId, r]));
    const catalog = {
        async getSession(sessionId) { return sessions.get(sessionId) ?? null; },
        // The turn's own bookkeeping.
        async recordEvents() {},
        async updateSession() {},
        async setActiveTurnIndex() {},
        async completeTurnWriteback() {},
    };
    const clientMethods = ["start", "stop", "_getDuroxideClient"];
    const saved = Object.fromEntries(clientMethods.map((name) => [name, PilotSwarmClient.prototype[name]]));
    PilotSwarmClient.prototype.start = async function () {};
    PilotSwarmClient.prototype.stop = async function () {};
    PilotSwarmClient.prototype._getDuroxideClient = function () { return duroxideClient; };
    try {
        const content = {};
        for (const scope of ["owner", "fleet"]) {
            const handlers = {};
            const session = {
                abort() {},
                runTurn: async (_prompt, { controlToolBridge }) => ({
                    type: "completed",
                    events: [],
                    content: [
                        await controlToolBridge.sendSessionMessage({ session_id: "bob-1", subject: "Release notes", body: "Where are they?" }),
                        await controlToolBridge.replySessionMessage({ request_id: "request-0001", session_id: "bob-1", body: "Drafted." }),
                    ].join("\n"),
                }),
            };
            const sessionManager = {
                withRunTurnLock: async (_sessionId, _operation, fn) => fn(),
                getOrCreate: async () => session,
                getModelSummary: () => undefined,
                getWorkspaceProvider: () => null,
                resetSessionState: async () => {},
            };
            registerActivities({ registerActivity: (name, handler) => { handlers[name] = handler; } }, sessionManager,
                null, undefined, catalog, undefined, "sqlite::memory:",
                // The 17th parameter is the Workflow intake's test options; the scope is the 18th.
                undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, scope);
            const result = await handlers.runTurn({ traceInfo() {}, isCancelled: () => false }, {
                sessionId: "alice-1", prompt: "Ask Bob's session for the release notes.", config: {}, turnIndex: 0,
            });
            content[scope] = result.content;
        }
        assert.match(content.owner, /send_session_message failed: session message policy_denied/);
        assert.match(content.owner, /reply_session_message failed: session reply policy_denied/);
        assert.match(content.fleet, /Cross-session message queued/);
        assert.match(content.fleet, /Cross-session reply queued/);
        assert.deepEqual(enqueued, ["session-bob-1", "session-bob-1"]);
    } finally {
        Object.assign(PilotSwarmClient.prototype, saved);
    }
});

const withoutRequestId = (prompt) => prompt.replace(/request_id=[^\s\]]+/g, "request_id=<id>");

test("unset and fleet deliver every message and reply, framed and looked up as before", async () => {
    const runs = {};
    for (const scope of [undefined, "fleet"]) {
        resetSessionMessageRateLimitsForTests();
        const { runtime, enqueued, lookups } = harness(scope);
        const pairs = [...REFUSED, ...DELIVERED].map(([, from, to]) => [from, to]);
        for (const [from, to] of pairs) {
            await send(runtime, from, to);
            await reply(runtime, from, to);
        }
        assert.deepEqual(enqueued.map((event) => event.orchestrationId),
            pairs.flatMap(([, to]) => [`session-${to}`, `session-${to}`]));
        // The target, then the sender, per call: no extra reads when the scope is off.
        assert.deepEqual(lookups, pairs.flatMap(([from, to]) => [to, from, to, from]));
        runs[scope ?? "unset"] = enqueued.map((event) => withoutRequestId(event.prompt));
    }
    assert.deepEqual(runs.fleet, runs.unset);

    resetSessionMessageRateLimitsForTests();
    const { runtime, enqueued } = harness(undefined);
    await send(runtime, "alice-1", "bob-1");
    await reply(runtime, "alice-1", "bob-1");
    await send(runtime, "alice-1", "alice-2");
    await send(runtime, "system-1", "alice-1");
    const [crossOwner, crossOwnerReply, sameOwner, fromSystem] = enqueued.map((event) => event.prompt);
    assert.match(crossOwner, /relation=cross-owner/);
    assert.match(crossOwner, /\[CROSS-OWNER MESSAGE\][^\n]*\(Alice Example <alice@example\.invalid>\)/);
    assert.match(crossOwnerReply, /relation=cross-owner verdict=answered\]\nThis response comes from a session owned by a different user/);
    assert.doesNotMatch(sameOwner, /cross-owner|CROSS-OWNER/);
    assert.doesNotMatch(fromSystem, /cross-owner|CROSS-OWNER/);
});

test("the scope setting: unset or empty is fleet, case and spaces are ignored, anything else is refused", async () => {
    for (const value of [undefined, null, "", " ", "fleet", "FLEET"]) assert.equal(resolveSessionMessageScope(value), "fleet");
    for (const value of ["owner", " Owner "]) assert.equal(resolveSessionMessageScope(value), "owner");
    for (const value of ["ownr", "user", "none", "1", true]) {
        assert.throws(() => resolveSessionMessageScope(value), /must be fleet or owner/, String(value));
    }
    const { runtime, enqueued } = harness("everyone");
    await assert.rejects(send(runtime, "alice-1", "alice-2"), /must be fleet or owner/);
    assert.deepEqual(enqueued, [], "a bad scope never falls back to delivering");
});

test("the worker refuses an unknown sessionMessageScope when it is constructed", () => {
    assert.throws(
        () => new PilotSwarmWorker({ store: "postgresql://u:p@unittest.invalid/app", sessionMessageScope: "everyone" }),
        /sessionMessageScope \/ PILOTSWARM_SESSION_MESSAGE_SCOPE must be fleet or owner/,
    );
});

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
for (const entrypoint of ["packages/sdk/examples/worker.js", "packages/app/tui/src/embedded-workers.js"]) {
    for (const value of ["owner", undefined]) {
        test(`${entrypoint} passes PILOTSWARM_SESSION_MESSAGE_SCOPE=${value ?? "(unset)"} to the worker`, () => {
            const sdkUrl = new URL("../../dist/index.js", import.meta.url).href;
            const entryUrl = new URL(entrypoint, new URL("../../../../", import.meta.url)).href;
            const script = `
                import { mock } from "node:test";
                mock.module(${JSON.stringify(sdkUrl)}, { namedExports: {
                    horizonConfigFromEnv: () => ({}),
                    loadExtensionModules: async () => [],
                    parseExtensionModules: () => [],
                    PilotSwarmWorker: class {
                        constructor(options) { this.options = options; }
                        async start() {
                            process.stdout.write("SCOPE:" + JSON.stringify(this.options.sessionMessageScope ?? null) + "\\n");
                            process.exit(0);
                        }
                    }
                } });
                const entry = await import(${JSON.stringify(entryUrl)});
                if (entry.startEmbeddedWorkers) await entry.startEmbeddedWorkers({ count: 1, store: process.env.DATABASE_URL });
            `;
            const env = { ...process.env, DATABASE_URL: "postgresql://u:p@unittest.invalid/app" };
            if (value === undefined) delete env.PILOTSWARM_SESSION_MESSAGE_SCOPE;
            else env.PILOTSWARM_SESSION_MESSAGE_SCOPE = value;
            const result = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", "--no-warnings=ExperimentalWarning",
                "--input-type=module", "-e", script,
            ], { cwd: repoRoot, env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            const match = result.stdout.match(/SCOPE:(.*)/);
            assert.ok(match, result.stdout);
            assert.equal(JSON.parse(match[1]), value ?? null);
        });
    }
}
