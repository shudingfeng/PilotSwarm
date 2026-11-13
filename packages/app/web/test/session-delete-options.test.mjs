import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "pilotswarm-sdk";
import { PortalRuntime } from "../runtime.js";
import { loadAuthzConfig } from "../authz.js";

test("deleteSession forwards its reason and the forced delete's options, and adds none of its own", async () => {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    const calls = [];
    runtime.transport = {
        getSessionAccess: async () => ({ viewerIsOwner: true, isSystem: false, canManage: true, canWrite: true, canRead: true }),
        deleteSession: async (...args) => calls.push(args),
    };
    const auth = { principal: { provider: "dev", subject: "owner" }, authorization: { role: "user" } };
    await runtime.call("deleteSession", { sessionId: "s1", reason: "work ended", force: true, settleTimeoutMs: 0 }, auth);
    await runtime.call("deleteSession", { sessionId: "s2" }, auth);
    // A plain delete keeps the default reason, as before the forced delete existed.
    await runtime.call("deleteSession", { sessionId: "s3", reason: "work ended" }, auth);
    assert.deepEqual(calls, [
        ["s1", "work ended", { force: true, settleTimeoutMs: 0 }],
        ["s2", undefined, {}],
        ["s3", undefined, {}],
    ]);
});

test("only the owner or an admin may force a delete, also while ownership is only audited", async () => {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    assert.equal(runtime.authz.enforce, false, "the default: ownership is audited, not enforced");
    const calls = [];
    const audit = [];
    runtime.transport = {
        getSessionAccess: async () => ({
            viewerIsOwner: false, isSystem: false, visibility: "private", viewerShareAccess: null,
            owner: { provider: "dev", subject: "alice" },
        }),
        deleteSession: async (...args) => calls.push(args),
        recordAuthzAudit: async (entry) => { audit.push(entry); },
    };
    const bob = { principal: { provider: "dev", subject: "bob" }, authorization: { role: "user" } };
    await assert.rejects(
        runtime.call("deleteSession", { sessionId: "alice-session", force: true }, bob),
        (error) => error.status === 403 && /owner or an admin/.test(error.message),
    );
    assert.equal(calls.length, 0, "nothing was deleted");
    assert.ok(audit.some((entry) => entry.decision === "deny" && entry.action === "deleteSession"), "the refusal is audited");

    await runtime.call("deleteSession", { sessionId: "alice-session" }, bob);
    const admin = { principal: { provider: "dev", subject: "carol" }, authorization: { role: "admin" } };
    await runtime.call("deleteSession", { sessionId: "alice-session", force: true }, admin);
    assert.deepEqual(calls, [
        ["alice-session", undefined, {}],
        ["alice-session", undefined, { force: true }],
    ], "an unforced delete is audited as before, and an admin may force one");
});

const DISPATCHER = "dispatcher-1";
const as = (subject, role = "user") => ({ principal: { provider: "entra", subject }, authorization: { role } });
const alice = as("alice");

/**
 * A Portal that enforces ownership, over the real management client on an
 * in-memory catalog and duroxide client. `tree` lists [sessionId,
 * parentSessionId, { deleted, instance }] rows, root first; alice owns the
 * private tree, and `shares` maps a subject to its share on the root. Alice
 * also owns `others` live sessions, updated after it. The catalog answers as
 * its procedures do: the access read resolves a live session to its root and
 * has no row for a deleted one, and the listing checks the viewer against the
 * root, deleted or not.
 */
function deletedTree(tree, { shares = {}, optIns = {}, others = 0 } = {}) {
    const rows = new Map();
    const instances = new Set();
    let tick = Date.parse("2026-11-01T00:00:00Z");
    const unrelated = Array.from({ length: others }, (_, i) => [`other-${i}`, null]);
    for (const [sessionId, parentSessionId, flags = {}] of [...tree, ...unrelated]) {
        rows.set(sessionId, {
            sessionId,
            parentSessionId,
            rootSessionId: parentSessionId ? rows.get(parentSessionId).rootSessionId : sessionId,
            isSystem: false,
            visibility: "private",
            owner: { provider: "entra", subject: "alice", email: null, displayName: null },
            state: "running",
            createdAt: new Date(tick),
            updatedAt: new Date(tick++),
            deletedAt: flags.deleted ? new Date(tick) : null,
        });
        if (flags.instance !== false) instances.add(`session-${sessionId}`);
    }
    const rootOf = (row) => rows.get(row.rootSessionId);
    const canRead = (row, viewer) => rootOf(row).owner.subject === viewer.subject
        || rootOf(row).visibility !== "private"
        || Boolean(shares[viewer.subject]);

    const mgmt = Object.create(PilotSwarmManagementClient.prototype);
    mgmt._started = true;
    mgmt._catalog = {
        getSessionAccess: async (sessionId, viewer) => {
            const row = rows.get(sessionId);
            if (!row || row.deletedAt) return null;
            const root = rootOf(row);
            return {
                rootSessionId: root.sessionId,
                isSystem: root.isSystem,
                visibility: root.visibility,
                owner: root.owner,
                viewerIsOwner: root.owner.provider === viewer.provider && root.owner.subject === viewer.subject,
                viewerShareAccess: shares[viewer.subject] ?? null,
            };
        },
        listSessionsPage: async ({ limit, cursorUpdatedAt, cursorSessionId, includeDeleted, viewer }) => [...rows.values()]
            .filter((row) => (includeDeleted || !row.deletedAt) && (!viewer || canRead(row, viewer)))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .filter((row) => !cursorUpdatedAt || row.updatedAt < cursorUpdatedAt
                || (row.updatedAt.getTime() === cursorUpdatedAt.getTime() && row.sessionId < cursorSessionId))
            .slice(0, limit)
            .map((row) => ({ ...row })),
        getDescendantSessionIds: async (sessionId) => {
            const out = [];
            const walk = (id) => {
                for (const row of rows.values()) {
                    if (row.parentSessionId !== id || row.deletedAt) continue;
                    out.push(row.sessionId);
                    walk(row.sessionId);
                }
            };
            walk(sessionId);
            return out;
        },
        updateSession: async (sessionId, patch) => { Object.assign(rows.get(sessionId), patch); },
        softDeleteSession: async (sessionId) => { rows.get(sessionId).deletedAt = new Date(); },
    };
    mgmt._duroxideClient = {
        getStatus: async (instanceId) => ({ status: instances.has(instanceId) ? "Running" : "NotFound" }),
        cancelInstance: async () => {},
        deleteInstance: async (instanceId) => { instances.delete(instanceId); },
    };
    mgmt.getSession = async (sessionId) => {
        const row = rows.get(sessionId);
        return row && !row.deletedAt ? { sessionId, status: "running", orchestrationStatus: "Running" } : null;
    };

    const audits = [];
    const logLines = [];
    const calls = [];
    const record = (method) => async (...args) => { calls.push([method, ...args]); };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = loadAuthzConfig({ AUTHZ_ENFORCE_OWNERSHIP: "true", DISPATCHER_SP_OBJECT_ID: DISPATCHER });
    runtime._logDelegatedCall = (entry) => logLines.push(entry);
    runtime.transport = {
        mgmt,
        getSessionAccess: (sessionId, viewer) => mgmt.getSessionAccess(sessionId, viewer),
        deleteSession: (sessionId, reason, options) => mgmt.deleteSession(sessionId, reason, options),
        getMyDispatcherDelegation: async ({ principal }) => ({ enabled: optIns[principal.subject] === true }),
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        sendMessage: record("sendMessage"),
        cancelSession: record("cancelSession"),
        completeSession: record("completeSession"),
    };
    const live = () => [...rows.values()].filter((row) => !row.deletedAt).map((row) => row.sessionId).sort();
    return { runtime, rows, instances, audits, logLines, calls, live };
}

async function refusal(promise) {
    try {
        await promise;
    } catch (error) {
        return { status: error.status ?? null, code: error.code ?? null };
    }
    assert.fail("expected the call to be refused");
}

// R, soft-deleted by a plain delete, and C, the child its lenient cascade could not delete.
const LEFT_BEHIND = [["R", null, { deleted: true, instance: false }], ["C", "R"]];
const RETRY = { sessionId: "R", reason: "work ended", force: true, settleTimeoutMs: 0 };

test("with ownership enforced, the owner's forced retry on a deleted root finishes the child a plain delete left", async () => {
    const t = deletedTree(LEFT_BEHIND);
    await t.runtime.call("deleteSession", RETRY, alice);
    assert.deepEqual(t.live(), []);
    assert.equal(t.instances.has("session-C"), false, "the child's orchestration instance is deleted too");
    assert.equal(t.rows.get("C").lastError, "Ancestor R deleted: work ended");
    assert.equal(t.audits.some((entry) => entry.decision === "deny"), false);
});

test("with ownership enforced, an admin's forced retry finishes it too, audited as break-glass", async () => {
    const t = deletedTree(LEFT_BEHIND);
    await t.runtime.call("deleteSession", RETRY, as("ada", "admin"));
    assert.deepEqual(t.live(), []);
    assert.ok(t.audits.some((entry) => entry.action === "deleteSession" && entry.decision === "break_glass"));
});

test("with ownership enforced, the forced retry finds a deleted root beyond the first page of the caller's listing", async () => {
    const t = deletedTree(LEFT_BEHIND, { others: 250 });
    await t.runtime.call("deleteSession", RETRY, alice);
    assert.equal(t.live().includes("C"), false);
    assert.equal(t.live().length, 250, "nothing outside the tree");
});

test("with ownership enforced, anyone else, a plain delete and every other call on the deleted root still get 404", async () => {
    const t = deletedTree(LEFT_BEHIND, { shares: { carol: "write" } });
    for (const caller of [as("bob"), as("carol")]) {
        const error = await refusal(t.runtime.call("deleteSession", RETRY, caller));
        assert.deepEqual([error.status, error.code], [404, "NOT_FOUND"], `${caller.principal.subject}, even with a write share`);
    }
    const unknown = await refusal(t.runtime.call("deleteSession", { ...RETRY, sessionId: "never-existed" }, alice));
    assert.deepEqual([unknown.status, unknown.code], [404, "NOT_FOUND"], "the same answer as for a session that never existed");
    for (const [method, params] of [
        ["deleteSession", { sessionId: "R", reason: "work ended" }],
        ["getSession", { sessionId: "R" }],
        ["sendMessage", { sessionId: "R", prompt: "hello" }],
        ["cancelSession", { sessionId: "R" }],
        ["completeSession", { sessionId: "R" }],
    ]) {
        const error = await refusal(t.runtime.call(method, params, alice));
        assert.deepEqual([error.status, error.code], [404, "NOT_FOUND"], `the owner's ${method}`);
    }
    assert.deepEqual(t.live(), ["C"]);
    assert.ok(t.instances.has("session-C"));
    assert.deepEqual(t.calls, []);
    assert.ok(t.audits.length > 0);
    assert.ok(t.audits.every((entry) => entry.decision === "deny" && entry.reason === "session not found or deleted"));
});

test("with ownership enforced, the delegated dispatcher's forced retry finishes the tree while a live session is left, audited first", async () => {
    const t = deletedTree(LEFT_BEHIND, { shares: { [DISPATCHER]: "write" }, optIns: { alice: true } });
    await t.runtime.call("deleteSession", RETRY, as(DISPATCHER));
    assert.deepEqual(t.live(), []);
    const audit = t.audits.find((entry) => entry.decision === "delegated");
    assert.equal(audit.action, "deleteSession");
    assert.equal(audit.target, "entra/alice");
    assert.deepEqual(audit.details, { owner: { provider: "entra", subject: "alice" }, force: true, settleTimeoutMs: 0 });
    assert.deepEqual(t.logLines.map((entry) => [entry.action, entry.sessionId]), [["deleteSession", "R"]]);
});

test("the dispatcher's forced retry follows the delegation rules, and gets 404 once no live session shows its share", async () => {
    const revoked = deletedTree(LEFT_BEHIND, { shares: { [DISPATCHER]: "write" }, optIns: { alice: false } });
    const off = await refusal(revoked.runtime.call("deleteSession", RETRY, as(DISPATCHER)));
    assert.deepEqual([off.status, off.code], [403, "DELEGATION_REVOKED"], "as on a live session");

    const readOnly = deletedTree(LEFT_BEHIND, { shares: { [DISPATCHER]: "read" }, optIns: { alice: true } });
    const read = await refusal(readOnly.runtime.call("deleteSession", RETRY, as(DISPATCHER)));
    assert.deepEqual([read.status, read.code], [404, "NOT_FOUND"], "a read share is not enough");
    for (const t of [revoked, readOnly]) assert.deepEqual(t.live(), ["C"]);

    // All that is left is the orchestration instance of a deleted child.
    const gone = deletedTree([["R", null, { deleted: true, instance: false }], ["C", "R", { deleted: true }]], {
        shares: { [DISPATCHER]: "write" },
        optIns: { alice: true },
    });
    const unseen = await refusal(gone.runtime.call("deleteSession", RETRY, as(DISPATCHER)));
    assert.deepEqual([unseen.status, unseen.code], [404, "NOT_FOUND"]);
    assert.ok(gone.instances.has("session-C"));
    assert.equal(gone.audits.some((entry) => entry.decision === "delegated"), false);
    await gone.runtime.call("deleteSession", RETRY, alice);
    assert.equal(gone.instances.has("session-C"), false, "the owner can still finish it");
});
