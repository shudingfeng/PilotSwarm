/**
 * PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS: which sessions count as system
 * sessions, and the Copilot session config SessionManager creates and resumes
 * them with. The Copilot transport and the session catalog are stubbed; the
 * local test system-session-tools.test.js checks the tools the real CLI offers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, countsAsSystemSession } from "../../dist/session-manager.js";

const SETTING = "PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS";
const LIMITS = { availableTools: ["custom:*", "builtin:skill"], enableSessionStore: false, skipEmbeddingRetrieval: true };
const SYSTEM_USER = { provider: "system", subject: "system", email: null, displayName: "System" };
const ALICE = { provider: "test", subject: "alice", email: null, displayName: null };
const ROWS = {
    "system-root": { isSystem: true, owner: null, rootSessionId: "system-root" },
    // What a system session spawns: owned by the system user, not marked system.
    "system-child": { isSystem: false, owner: SYSTEM_USER, parentSessionId: "system-root", rootSessionId: "system-root" },
    "ownerless-child": { isSystem: false, owner: null, parentSessionId: "system-root", rootSessionId: "system-root" },
    "user-root": { isSystem: false, owner: ALICE, rootSessionId: "user-root" },
    "user-child": { isSystem: false, owner: ALICE, parentSessionId: "user-root", rootSessionId: "user-root" },
};
const SYSTEM_SESSIONS = ["system-root", "system-child", "ownerless-child"];
const USER_SESSIONS = ["user-root", "user-child"];

/** The options of LIMITS that a session config sets. */
const limitsOf = (config) => Object.fromEntries(Object.keys(LIMITS).filter((key) => key in config).map((key) => [key, config[key]]));

async function withSetting(value, fn) {
    const previous = process.env[SETTING];
    if (value === undefined) delete process.env[SETTING];
    else process.env[SETTING] = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env[SETTING];
        else process.env[SETTING] = previous;
    }
}

function fixture(t, { unreadable = new Set() } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-tool-limits-"));
    const h = { calls: [], disconnectFailures: 0 };
    h.manager = new SessionManager(undefined, null, { nativeSubagents: "sync" }, home);
    h.manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    h.manager.setSessionCatalog({
        getSession: async (id) => {
            if (unreadable.has(id)) throw new Error("catalog unavailable");
            return ROWS[id] ?? null;
        },
        recordEvents: async () => {},
    });
    const open = (kind, sessionId, config) => {
        h.calls.push({ kind, sessionId, config });
        mkdirSync(join(home, sessionId), { recursive: true });
        return {
            disconnect: async () => {
                if (h.disconnectFailures > 0) {
                    h.disconnectFailures -= 1;
                    throw new Error("disconnect failed");
                }
            },
        };
    };
    const client = {
        createSession: async (config) => open("create", config.sessionId, config),
        resumeSession: async (sessionId, config) => open("resume", sessionId, config),
        deleteSession: async () => {},
    };
    h.manager.ensureClient = async () => client;
    h.manager.ensureClientForKey = async () => client;
    t.after(async () => {
        for (const id of [...h.manager.sessions.keys()]) await h.manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return h;
}

/** A first turn creates the session; once its warm handle is gone, the next turn resumes it. */
async function createAndResume(t, sessionId) {
    const h = fixture(t);
    await h.manager.getOrCreate(sessionId, {}, { turnIndex: 0 });
    await h.manager.dropWarmSession(sessionId);
    await h.manager.getOrCreate(sessionId, {}, { turnIndex: 1 });
    assert.deepEqual(h.calls.map((call) => call.kind), ["create", "resume"]);
    return h.calls.map((call) => call.config);
}

test("the setting limits system sessions, the sessions the system user owns and sessions under a system root", async (t) => {
    await withSetting(undefined, async () => {
        for (const id of [...SYSTEM_SESSIONS, ...USER_SESSIONS]) {
            for (const sdk of await createAndResume(t, id)) assert.deepEqual(limitsOf(sdk), {}, `${id}: no limit without the setting`);
        }
        const [child] = await createAndResume(t, "system-child");
        assert.equal(child.customAgentsLocalOnly, true, "without the setting, a system session's child has native tasks");
    });
    await withSetting("1", async () => {
        for (const id of SYSTEM_SESSIONS) {
            for (const sdk of await createAndResume(t, id)) {
                assert.deepEqual(limitsOf(sdk), LIMITS, id);
                assert.equal(sdk.customAgentsLocalOnly, undefined, `${id}: no native tasks`);
                assert.ok(sdk.excludedTools.includes("task"), `${id}: no task tool`);
            }
        }
        for (const id of USER_SESSIONS) {
            for (const sdk of await createAndResume(t, id)) {
                assert.deepEqual(limitsOf(sdk), {}, `${id}: an ordinary session is not limited`);
                assert.equal(sdk.customAgentsLocalOnly, true, `${id}: an ordinary session keeps native tasks`);
            }
        }
    });
});

test("the root's row is read only when the session's own row does not decide", async () => {
    const reads = [];
    const getSession = async (id) => {
        reads.push(id);
        return ROWS[id] ?? null;
    };
    assert.equal(await countsAsSystemSession("system-root", ROWS["system-root"], getSession), true);
    assert.equal(await countsAsSystemSession("system-child", ROWS["system-child"], getSession), true);
    assert.equal(await countsAsSystemSession("user-root", ROWS["user-root"], getSession), false);
    assert.deepEqual(reads, []);
    assert.equal(await countsAsSystemSession("ownerless-child", ROWS["ownerless-child"], getSession), true);
    assert.equal(await countsAsSystemSession("user-child", ROWS["user-child"], getSession), false);
    assert.deepEqual(reads, ["system-root", "user-root"]);

    const unreadable = async () => { throw new Error("catalog unavailable"); };
    assert.equal(await countsAsSystemSession("user-child", ROWS["user-child"], unreadable), true,
        "a root that cannot be read counts as system");
});

test("a change of the setting reaches a warm system session at its next turn", async (t) => {
    const h = fixture(t);
    const turn = (turnIndex, value) => withSetting(value, () => h.manager.getOrCreate("system-root", {}, { turnIndex }));
    const first = await turn(0, undefined);
    assert.deepEqual(limitsOf(h.calls[0].config), {});

    const limited = await turn(1, "1");
    assert.notEqual(limited, first, "the limit needs a new CLI handle");
    assert.equal(h.calls[1].kind, "resume");
    assert.deepEqual(limitsOf(h.calls[1].config), LIMITS);

    assert.equal(await turn(2, "1"), limited, "an unchanged limit keeps the warm handle");
    assert.equal(h.calls.length, 2);

    await turn(3, undefined);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(limitsOf(h.calls[2].config), {});
});

test("a dehydrate that resumes a session to retry its disconnect keeps the session's limits", async (t) => {
    const h = fixture(t);
    await withSetting("1", async () => {
        for (const id of ["system-child", "user-child"]) {
            await h.manager.getOrCreate(id, {}, { turnIndex: 0 });
            h.disconnectFailures = 1;
            await h.manager.dehydrate(id, "test");
        }
    });
    const retry = (id) => h.calls.find((call) => call.kind === "resume" && call.sessionId === id);
    assert.deepEqual(limitsOf(retry("system-child").config), LIMITS);
    assert.deepEqual(limitsOf(retry("user-child").config), {});
});

test("with the setting, a session whose own row can't be read is limited until the row reads again", async (t) => {
    const unreadable = new Set(["user-root"]);
    await withSetting(undefined, async () => {
        const h = fixture(t, { unreadable });
        await h.manager.getOrCreate("user-root", {}, { turnIndex: 0 });
        assert.deepEqual(limitsOf(h.calls[0].config), {}, "without the setting nothing changes");
    });
    await withSetting("1", async () => {
        const h = fixture(t, { unreadable });
        await h.manager.getOrCreate("user-root", {}, { turnIndex: 0 });
        assert.deepEqual(limitsOf(h.calls[0].config), LIMITS, "create");
        await h.manager.dropWarmSession("user-root");
        await h.manager.getOrCreate("user-root", {}, { turnIndex: 1 });
        assert.deepEqual(limitsOf(h.calls[1].config), LIMITS, "resume");
        h.disconnectFailures = 1;
        await h.manager.dehydrate("user-root", "test");
        assert.deepEqual(limitsOf(h.calls[2].config), LIMITS, "the dehydrate's retry");
        unreadable.clear();
        await h.manager.getOrCreate("user-root", {}, { turnIndex: 2 });
        assert.deepEqual(limitsOf(h.calls.at(-1).config), {}, "readable again: an ordinary session");
    });
});
