/**
 * Two worker timeout settings, both unchanged when unset:
 *
 *   PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS: the deadline of one folder's
 *     attach. Unset, 30 seconds.
 *   PILOTSWARM_CLI_ABORT_TIMEOUT_MS: how long a turn guard (the wall-clock
 *     cap or the inactivity watchdog) waits for the Copilot CLI to answer its
 *     abort. Unset, no limit. When the CLI gives no answer in time, the turn
 *     settles as a lost connection. SessionManager ends the process tree of
 *     the CLI that serves the session, its shells included, and force-stops
 *     its pooled client.
 *
 * Run: node --test test/unit/workspace-attach-and-cli-abort-timeouts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PilotSwarmWorker } from "../../dist/index.js";
import { createCopilotClient } from "../../dist/copilot-client.js";
import { SessionManager } from "../../dist/session-manager.js";
import { ManagedSession, TURN_INACTIVITY_ERROR_MARKER, cliAbortTimeoutMsFromEnv } from "../../dist/managed-session.js";
import { processAlive } from "../../dist/process-tree.js";
import { prepareWorkspace, workspaceAttachTimeoutMsFromEnv } from "../../dist/workspace.js";
import { isCopilotConnectionClosedError } from "../../dist/orchestration/utils.js";

const ATTACH_KEY = "PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS";
const ABORT_KEY = "PILOTSWARM_CLI_ABORT_TIMEOUT_MS";
const BAD_VALUES = ["0", "-5", "1.5", "30s", "abc", "1e4", "2147483648"];

function setEnv(t, key, value) {
    const saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
    });
}

// The turn guards' timers are unref'd, so a test that waits only on them
// needs something else to keep the event loop alive.
function keepAlive(t) {
    const timer = setInterval(() => {}, 1_000);
    t.after(() => clearInterval(timer));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── Workspace attach deadline ────────────────────────────────────

test("the attach setting is a positive whole number of milliseconds, else 30 s", () => {
    assert.equal(workspaceAttachTimeoutMsFromEnv(undefined), 30_000);
    assert.equal(workspaceAttachTimeoutMsFromEnv(""), 30_000);
    assert.equal(workspaceAttachTimeoutMsFromEnv(" 600000 "), 600_000);
    for (const bad of BAD_VALUES) {
        assert.throws(() => workspaceAttachTimeoutMsFromEnv(bad),
            /PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS must be a positive whole number of milliseconds/, bad);
    }
});

// A provider that lists its root and never answers ensureAttached.
const silentProvider = {
    listRoots: async () => [{ name: "a", path: join(tmpdir(), "ps-attach-root") }],
    ensureAttached: () => new Promise(() => {}),
};
const ATTACH_REQUEST = {
    sessionId: "s1", rootSessionId: "s1", workspace: { schema: 1, root: "a", folder: "repo" },
    revision: 1, workerNodeId: "worker-1", turnIndex: 1,
};

async function attachDeadlineMs(t) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let settled = null;
    const pending = prepareWorkspace(silentProvider, ATTACH_REQUEST).then((result) => { settled = result; });
    await flush();
    return {
        async advance(ms) { t.mock.timers.tick(ms); await flush(); return settled; },
        pending,
    };
}

test("unset, an attach that gets no answer fails after exactly 30 s", async (t) => {
    setEnv(t, ATTACH_KEY, undefined);
    const attach = await attachDeadlineMs(t);
    assert.equal(await attach.advance(29_999), null, "still waiting just before 30 s");
    const result = await attach.advance(1);
    await attach.pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
    assert.match(result.message, /within 30000 ms/);
});

test("set, every attach whose caller sets no deadline waits that long", async (t) => {
    setEnv(t, ATTACH_KEY, "600000");
    const attach = await attachDeadlineMs(t);
    assert.equal(await attach.advance(30_000), null, "30 s no longer ends the wait");
    assert.equal(await attach.advance(569_999), null);
    const result = await attach.advance(1);
    await attach.pending;
    assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
    assert.match(result.message, /within 600000 ms/);
});

// ── The worker reads both settings when it is constructed ───────

function newWorker(t) {
    const root = mkdtempSync(join(tmpdir(), "ps-u-timeouts-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return new PilotSwarmWorker({ store: "sqlite::memory:", disableManagementAgents: true, sessionStateDir: join(root, "sessions") });
}

test("a worker refuses a bad timeout setting when it is constructed", (t) => {
    setEnv(t, ATTACH_KEY, "30s");
    setEnv(t, ABORT_KEY, undefined);
    assert.throws(() => newWorker(t), /PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS/);
    process.env[ATTACH_KEY] = "600000";
    process.env[ABORT_KEY] = "-1";
    assert.throws(() => newWorker(t), /PILOTSWARM_CLI_ABORT_TIMEOUT_MS/);
});

test("the worker hands the abort limit to its session manager, and none when unset", (t) => {
    setEnv(t, ATTACH_KEY, undefined);
    setEnv(t, ABORT_KEY, undefined);
    assert.equal(newWorker(t).sessionManager.workerDefaults.cliAbortTimeoutMs, undefined);
    process.env[ABORT_KEY] = "30000";
    assert.equal(newWorker(t).sessionManager.workerDefaults.cliAbortTimeoutMs, 30_000);
});

// ── A turn guard's abort ─────────────────────────────────────────

test("the abort setting is a positive whole number of milliseconds, else no limit", () => {
    assert.equal(cliAbortTimeoutMsFromEnv(undefined), undefined);
    assert.equal(cliAbortTimeoutMsFromEnv(""), undefined);
    assert.equal(cliAbortTimeoutMsFromEnv(" 30000 "), 30_000);
    for (const bad of BAD_VALUES) {
        assert.throws(() => cliAbortTimeoutMsFromEnv(bad),
            /PILOTSWARM_CLI_ABORT_TIMEOUT_MS must be a positive whole number of milliseconds/, bad);
    }
});

/**
 * A CopilotSession whose CLI acknowledges the prompt and then goes silent.
 * `answerAbort` decides when abort() answers; by default it never does.
 * After `stopped` is set, every RPC fails, as on a force-stopped client,
 * and is counted in `callsAfterStop`.
 */
class SilentCopilotSession {
    constructor(sessionId = "fake") {
        this.sessionId = sessionId;
        this.handlers = [];
        this.abortCalls = 0;
        this.callsAfterStop = 0;
        this.stopped = false;
        this.answerAbort = () => new Promise(() => {});
        const rpc = (value) => async () => {
            if (this.stopped) {
                this.callsAfterStop++;
                throw new Error("Connection is disposed.");
            }
            return value;
        };
        this.rpc = { tasks: { list: rpc({ tasks: [] }), cancel: rpc({ cancelled: true }), remove: rpc({}) } };
    }
    on(typeOrHandler, handler) {
        const entry = typeof typeOrHandler === "function" ? typeOrHandler : handler;
        this.handlers.push(entry);
        return () => { this.handlers = this.handlers.filter((h) => h !== entry); };
    }
    registerTools() {}
    async send() { return "message-1"; }
    abort() {
        this.abortCalls++;
        return this.answerAbort();
    }
    async disconnect() {}
}

async function timedTurn(managed) {
    const startedAt = Date.now();
    const result = await managed.runTurn("go");
    return { result, elapsedMs: Date.now() - startedAt };
}

test("unset, the inactivity guard still waits for the CLI's answer to its abort", async (t) => {
    keepAlive(t);
    const fake = new SilentCopilotSession();
    fake.answerAbort = () => new Promise((resolve) => setTimeout(resolve, 300));
    const managed = new ManagedSession("no-limit", fake, { turnInactivityTimeoutMs: 50 });

    const { result, elapsedMs } = await timedTurn(managed);
    assert.equal(fake.abortCalls, 1);
    assert.ok(elapsedMs >= 300, `the turn settled after the abort answered (${elapsedMs} ms)`);
    assert.equal(result.type, "error");
    assert.match(result.message, /^No events from the Copilot CLI subprocess for \d+s — connection is closed or the subprocess is wedged; treating the turn as lost\.$/);
});

test("with a limit, an abort the CLI never answers ends the turn as a lost connection, reported once", async (t) => {
    keepAlive(t);
    const fake = new SilentCopilotSession();
    const reports = [];
    // Native tasks on: the cleanup after the turn would ask the stopped CLI.
    const managed = new ManagedSession("wedged", fake, { turnInactivityTimeoutMs: 50, nativeSubagents: "sync" });
    managed.setAbortLimit({ timeoutMs: 100, onUnanswered: () => { reports.push(Date.now()); fake.stopped = true; } });

    const { result, elapsedMs } = await timedTurn(managed);
    assert.equal(reports.length, 1, "the unanswered abort is reported once");
    assert.ok(elapsedMs < 2_000, `the turn settled within the limit (${elapsedMs} ms)`);
    assert.equal(fake.callsAfterStop, 0, "nothing asks the stopped CLI, not even the native-task cleanup");
    assert.equal(result.type, "error");
    assert.ok(result.message.includes(TURN_INACTIVITY_ERROR_MARKER));
    assert.match(result.message, /The Copilot CLI did not answer the abort within 100 ms\.$/);
    assert.equal(isCopilotConnectionClosedError(result.message), true, "the orchestration retries it on a fresh CLI");
});

test("with a limit, the wall-clock guard settles a wedged CLI as a lost connection too", async (t) => {
    keepAlive(t);
    const fake = new SilentCopilotSession();
    let reports = 0;
    const managed = new ManagedSession("wedged-cap", fake, { turnTimeoutMs: 50, turnInactivityTimeoutMs: 0 });
    managed.setAbortLimit({ timeoutMs: 100, onUnanswered: () => { reports++; } });

    const { result, elapsedMs } = await timedTurn(managed);
    assert.equal(reports, 1);
    assert.ok(elapsedMs < 2_000, `the turn settled within the limit (${elapsedMs} ms)`);
    assert.equal(result.type, "error");
    assert.match(result.message, /^Turn timed out\. The Copilot CLI did not answer the abort within 100 ms\./);
    assert.equal(isCopilotConnectionClosedError(result.message), true);
});

test("with a limit, an abort answered in time settles each guard as it does today", async (t) => {
    keepAlive(t);
    const answered = () => {
        const fake = new SilentCopilotSession();
        fake.answerAbort = () => new Promise((resolve) => setTimeout(resolve, 20));
        return fake;
    };
    let reports = 0;
    const limit = { timeoutMs: 500, onUnanswered: () => { reports++; } };

    const idle = new ManagedSession("idle", answered(), { turnInactivityTimeoutMs: 50 });
    idle.setAbortLimit(limit);
    const idleResult = (await timedTurn(idle)).result;
    assert.match(idleResult.message, /treating the turn as lost\.$/);

    const capped = new ManagedSession("capped", answered(), { turnTimeoutMs: 50, turnInactivityTimeoutMs: 0 });
    capped.setAbortLimit(limit);
    const cappedResult = (await timedTurn(capped)).result;
    assert.equal(cappedResult.message, "Copilot was taking too long to process and was killed.");
    assert.equal(reports, 0);
});

// ── SessionManager stops the client that serves the session ──────

const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const WORKSPACE_ATTACH = { root: "a", rootPath: "/ws/a", path: "/ws/a/repo-x", realPath: "/ws/a/repo-x" };
const WORKSPACE_CLIENT_KEY = "\0workspace-root:a";

/** A pooled CopilotClient whose sessions are SilentCopilotSessions. */
function fakeClient(home, name) {
    const client = {
        name,
        forceStops: 0,
        opened: [],
        createSession: async (config) => client.open(config.sessionId),
        resumeSession: async (sessionId) => client.open(sessionId),
        deleteSession: async () => {},
        forceStop: async () => {
            client.forceStops++;
            // As the SDK does: SIGKILL its CLI process, and nothing below it.
            try { client.cliProcess?.kill("SIGKILL"); } catch {}
            client.cliProcess = null;
            for (const session of client.opened) session.stopped = true;
        },
        open(sessionId) {
            mkdirSync(join(home, sessionId), { recursive: true });
            const session = new SilentCopilotSession(sessionId);
            client.opened.push(session);
            return session;
        },
    };
    return client;
}

function managerFixture(t, workerDefaults) {
    const home = mkdtempSync(join(tmpdir(), "ps-cli-abort-"));
    const manager = new SessionManager(undefined, null, { turnInactivityTimeoutMs: 50, ...workerDefaults }, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const plain = fakeClient(home, "plain");
    const rooted = fakeClient(home, "rooted");
    manager.clients.set("", plain);
    manager.clients.set(WORKSPACE_CLIENT_KEY, rooted);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    return { home, manager, plain, rooted };
}

test("an unanswered abort force-stops and drops exactly the client that serves the session", async (t) => {
    keepAlive(t);
    const { home, manager, plain, rooted } = managerFixture(t, { cliAbortTimeoutMs: 100 });
    const wedged = await manager.getOrCreate("s1", {}, { turnIndex: 0 });
    const neighbour = await manager.getOrCreate("s2", {}, { turnIndex: 0 });
    const other = await manager.getOrCreate("s3", { workspace: WORKSPACE, workspaceAttach: WORKSPACE_ATTACH }, { turnIndex: 0 });
    assert.equal(plain.opened.length, 2);
    assert.equal(rooted.opened.length, 1);

    const { result, elapsedMs } = await timedTurn(wedged);
    assert.ok(elapsedMs < 2_000, `the turn settled within the limit (${elapsedMs} ms)`);
    assert.equal(result.type, "error");
    assert.equal(isCopilotConnectionClosedError(result.message), true);

    assert.equal(plain.forceStops, 1, "the client that serves the session is force-stopped");
    assert.equal(rooted.forceStops, 0, "no other client is touched");
    assert.equal(manager.clients.has(""), false, "and it leaves the pool");
    assert.equal(manager.clients.get(WORKSPACE_CLIENT_KEY), rooted);
    assert.equal(manager.get("s1"), null, "the session's handle is dropped");

    // The retry, and the next turn of the other session on that client,
    // resume on a fresh client. A session on another client keeps its handle.
    const fresh = fakeClient(home, "fresh");
    manager.clients.set("", fresh);
    const retried = await manager.getOrCreate("s1", {}, { turnIndex: 1 });
    const resumed = await manager.getOrCreate("s2", {}, { turnIndex: 1 });
    assert.notEqual(retried, wedged);
    assert.notEqual(resumed, neighbour);
    assert.deepEqual(fresh.opened.map((session) => session.sessionId), ["s1", "s2"]);
    assert.equal(await manager.getOrCreate("s3", { workspace: WORKSPACE, workspaceAttach: WORKSPACE_ATTACH }, { turnIndex: 1 }), other);
    assert.equal(rooted.opened.length, 1);

    // A create that took the stopped client before it was stopped is refused,
    // so the stopped client never starts again.
    manager.ensureClient = async () => plain;
    await assert.rejects(manager.getOrCreate("s4", {}, { turnIndex: 0 }), /Connection is closed/);
    assert.equal(plain.opened.length, 2);
});

// Runs until killed: at most a minute, should a test run die before its cleanup.
const SLEEPER = ["-e", "setTimeout(() => {}, 60_000)"];

/**
 * A stand-in for the CLI process: a real child that starts a detached
 * grandchild, as the CLI starts a detached shell. On Windows, Node ends a
 * child that is not detached when its parent dies, which would hide a
 * missed shell.
 */
async function startCliWithDetachedShell(t) {
    const cli = spawn(process.execPath, ["-e", [
        `const shell = require("node:child_process").spawn(process.execPath, ${JSON.stringify(SLEEPER)}, { stdio: "ignore", detached: true });`,
        "console.log(shell.pid);",
        "setTimeout(() => {}, 60_000);",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
    const shellPid = Number(await new Promise((resolve) => cli.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
    t.after(() => { for (const pid of [cli.pid, shellPid]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    return { cli, shellPid };
}

test("an unanswered abort ends the CLI's whole process tree, a detached shell included, then force-stops the client", async (t) => {
    keepAlive(t);
    const { manager, plain } = managerFixture(t, { cliAbortTimeoutMs: 100 });
    const { cli, shellPid } = await startCliWithDetachedShell(t);
    plain.cliProcess = cli;
    const wedged = await manager.getOrCreate("s1", {}, { turnIndex: 0 });

    const { result } = await timedTurn(wedged);
    assert.equal(isCopilotConnectionClosedError(result.message), true);
    assert.equal(plain.forceStops, 1, "the client is still force-stopped");
    const deadline = Date.now() + 10_000;
    while ((processAlive(cli.pid) || processAlive(shellPid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processAlive(cli.pid), false, "the CLI process is dead");
    assert.equal(processAlive(shellPid), false, "its detached shell is dead too");
});

test("an unanswered abort kills nothing by the pid of a CLI process that already exited", async (t) => {
    keepAlive(t);
    const { manager, plain } = managerFixture(t, { cliAbortTimeoutMs: 100 });
    // The CLI exited; another process may have its pid now.
    const other = spawn(process.execPath, SLEEPER, { stdio: "ignore" });
    t.after(() => { try { process.kill(other.pid, "SIGKILL"); } catch {} });
    plain.cliProcess = { pid: other.pid, exitCode: 1, signalCode: null, kill() {} };
    const wedged = await manager.getOrCreate("s1", {}, { turnIndex: 0 });

    await timedTurn(wedged);
    assert.equal(plain.forceStops, 1);
    assert.equal(processAlive(other.pid), true, "the process that holds the pid now keeps running");
});

test("the pinned SDK keeps a client's CLI process where the tree kill reads it", () => {
    // A re-pinned SDK without the private `cliProcess` would silently leave
    // a wedged CLI's shells running again.
    const client = createCopilotClient({});
    assert.equal(Object.prototype.hasOwnProperty.call(client, "cliProcess"), true);
    assert.equal(client.cliProcess, null, "no process before the client starts");
});

test("unset, an unanswered abort keeps the turn waiting and the client in the pool", async (t) => {
    keepAlive(t);
    const { manager, plain } = managerFixture(t, {});
    const managed = await manager.getOrCreate("s1", {}, { turnIndex: 0 });
    plain.opened[0].answerAbort = () => new Promise((resolve) => setTimeout(resolve, 300));

    const { result, elapsedMs } = await timedTurn(managed);
    assert.ok(elapsedMs >= 300, `the turn waited for the abort (${elapsedMs} ms)`);
    assert.doesNotMatch(result.message, /did not answer the abort/);
    assert.equal(plain.forceStops, 0);
    assert.equal(manager.clients.get(""), plain);
    assert.equal(await manager.getOrCreate("s1", {}, { turnIndex: 1 }), managed, "the warm handle is kept");
});
