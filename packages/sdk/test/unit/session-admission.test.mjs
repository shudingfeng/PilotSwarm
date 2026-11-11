/**
 * PilotSwarmWorker.setSessionAdmission: before every turn, before the session
 * is locked or hydrated on the worker, the hook decides whether this worker
 * may run it. `busy` holds the turn as a busy workspace does, `deny` fails it
 * without a retry, and a turn the worker cannot check fails with an error
 * that is retried. Without a hook, nothing changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerActivities } from "../../dist/session-proxy.js";
import { TURN_CONTROL_ACTIVITY_NAMES } from "../../dist/activity-routing.js";
import { timerGate } from "../../dist/orchestration/state.js";
import { PilotSwarmWorker } from "../../dist/worker.js";

const SYSTEM_USER = { provider: "system", subject: "system", email: null, displayName: "System" };
const alice = { provider: "test", subject: "alice", email: null, displayName: "Alice" };

const ROWS = {
    "alice-root": { sessionId: "alice-root", rootSessionId: "alice-root", owner: alice, isSystem: false },
    "alice-child": { sessionId: "alice-child", rootSessionId: "alice-root", owner: alice, isSystem: false },
    "system-root": { sessionId: "system-root", rootSessionId: "system-root", owner: null, isSystem: true },
    // The child a system session spawns: the system user owns it; it is not marked is_system.
    "system-child": { sessionId: "system-child", rootSessionId: "system-root", owner: SYSTEM_USER, isSystem: false },
    "ownerless-under-system": { sessionId: "ownerless-under-system", rootSessionId: "system-root", owner: null, isSystem: false },
    // A root that a system session created.
    "system-made-root": { sessionId: "system-made-root", rootSessionId: "system-made-root", owner: SYSTEM_USER, isSystem: false },
    "ownerless-under-system-made": { sessionId: "ownerless-under-system-made", rootSessionId: "system-made-root", owner: null, isSystem: false },
    "root-gone": { sessionId: "root-gone", rootSessionId: "deleted-root", owner: alice, isSystem: false },
};

function workerWith({ admission, version = "1.0.82", noAdmissionMethod = false } = {}) {
    const handlers = new Map();
    const asked = [];
    const ran = [];
    const sessionManager = {
        getModelSummary: async () => null,
        // The turn's body starts with this lock: reaching it means the turn was admitted.
        withRunTurnLock: async (sessionId) => { ran.push(sessionId); return { type: "completed", content: "ran" }; },
        getSessionStateDir: () => tmpdir(),
        getTurnControlHub: () => null,
    };
    if (!noAdmissionMethod) {
        sessionManager.getSessionAdmission = () => admission
            ? async (request) => { asked.push(request); return admission(request); }
            : null;
    }
    const catalog = { getSession: async (id) => ROWS[id] ?? null };
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) },
        sessionManager, null, undefined, catalog, undefined, undefined, undefined, undefined,
        [], null, [], [], null, "vm-1");
    const ctx = { traceInfo() {}, orchestrationVersion: version, isCancelled: () => false };
    const turn = (sessionId, activity = "runTurn") => handlers.get(activity)(ctx, { sessionId, prompt: "hello", config: {}, turnIndex: 1 });
    return { turn, asked, ran };
}

const coordinatorOnly = ({ isSystem }) => isSystem ? { decision: "admit" } : { decision: "deny", message: "This host runs only system sessions." };

test("without a hook, every turn runs as before", async () => {
    for (const options of [{}, { noAdmissionMethod: true }]) {
        const { turn, ran } = workerWith(options);
        assert.deepEqual(await turn("alice-root"), { type: "completed", content: "ran" });
        assert.deepEqual(await turn("missing-session"), { type: "completed", content: "ran" });
        assert.deepEqual(ran, ["alice-root", "missing-session"]);
    }
});

test("busy on another owner's VM holds the turn as a busy workspace does, before the session is loaded", async () => {
    const { turn, asked, ran } = workerWith({
        admission: () => ({ decision: "busy", message: "This VM belongs to another owner.", retryAfterMs: 5_000 }),
    });
    const result = await turn("alice-child");
    assert.deepEqual(result, {
        type: "wait",
        seconds: 30,
        reason: "This VM belongs to another owner.",
        gate: "workspace",
        code: "WORKSPACE_BUSY",
        workerNodeId: "vm-1",
        retryAfterMs: 5_000,
    });
    assert.equal(timerGate(result), "workspace", "the orchestration holds it for the workspace gate");
    assert.deepEqual(asked, [{ sessionId: "alice-child", rootSessionId: "alice-root", isSystem: false }]);
    assert.deepEqual(ran, [], "the session was neither locked nor hydrated here");
});

test("deny fails an unleased user session's turn without a retry", async () => {
    const { turn, ran } = workerWith({ admission: () => ({ decision: "deny", message: "No drive is leased for this session here." }) });
    for (const activity of ["runTurn", TURN_CONTROL_ACTIVITY_NAMES.runTurn]) {
        assert.deepEqual(await turn("alice-root", activity), {
            type: "error",
            message: "Session admission denied this turn: No drive is leased for this session here.",
            retryable: false,
        });
    }
    assert.deepEqual(ran, []);
});

test("system sessions are admitted, including a child the system user owns; user sessions are not", async () => {
    const { turn, asked, ran } = workerWith({ admission: coordinatorOnly });
    const system = ["system-root", "system-child", "ownerless-under-system", "system-made-root", "ownerless-under-system-made"];
    for (const sessionId of system) {
        assert.deepEqual(await turn(sessionId), { type: "completed", content: "ran" }, sessionId);
    }
    for (const sessionId of ["alice-root", "alice-child"]) {
        const result = await turn(sessionId);
        assert.equal(result.retryable, false, sessionId);
        assert.match(result.message, /only system sessions/);
    }
    assert.deepEqual(ran, system);
    assert.deepEqual(asked.map(({ sessionId, rootSessionId, isSystem }) => [sessionId, rootSessionId, isSystem]), [
        ["system-root", "system-root", true],
        ["system-child", "system-root", true],
        ["ownerless-under-system", "system-root", true],
        ["system-made-root", "system-made-root", true],
        ["ownerless-under-system-made", "system-made-root", true],
        ["alice-root", "alice-root", false],
        ["alice-child", "alice-root", false],
    ]);
});

test("a turn the worker cannot check fails with an error that is retried, and does not run", async () => {
    const cases = [
        { admission: () => { throw new Error("controller unreachable"); }, sessionId: "alice-root", message: /the hook failed: controller unreachable/ },
        { admission: () => ({ decision: "maybe" }), sessionId: "alice-root", message: /neither admit, busy nor deny/ },
        { admission: () => undefined, sessionId: "alice-root", message: /neither admit, busy nor deny/ },
        { admission: coordinatorOnly, sessionId: "missing-session", message: /no row for the session/ },
        { admission: coordinatorOnly, sessionId: "root-gone", message: /no row for its root deleted-root/ },
    ];
    for (const { admission, sessionId, message } of cases) {
        const { turn, asked, ran } = workerWith({ admission });
        const result = await turn(sessionId);
        assert.equal(result.type, "error", sessionId);
        assert.match(result.message, /^Session admission could not check this turn: /);
        assert.match(result.message, message);
        assert.equal(result.retryable, undefined, "the orchestration retries it");
        assert.deepEqual(ran, []);
        if (sessionId !== "alice-root") assert.deepEqual(asked, [], "the hook is not asked without the session's facts");
    }
});

test("an orchestration older than 1.0.80 cannot hold a turn for the gate, so busy is an error it retries", async () => {
    const { turn, ran } = workerWith({ version: "1.0.79", admission: () => ({ decision: "busy" }) });
    assert.deepEqual(await turn("alice-root"), { type: "error", message: "Session admission: busy: this worker cannot run the session now" });
    assert.deepEqual(ran, []);
});

test("setSessionAdmission sets, replaces and removes the worker's hook", (t) => {
    const home = mkdtempSync(join(tmpdir(), "ps-admission-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const worker = new PilotSwarmWorker({ sessionStateDir: join(home, "sessions"), disableManagementAgents: true });
    assert.equal(worker.sessionManager.getSessionAdmission(), null);
    worker.setSessionAdmission(coordinatorOnly);
    assert.equal(worker.sessionManager.getSessionAdmission(), coordinatorOnly);
    worker.setSessionAdmission(null);
    assert.equal(worker.sessionManager.getSessionAdmission(), null);
    assert.throws(() => worker.setSessionAdmission({ decision: "admit" }), TypeError);
});
