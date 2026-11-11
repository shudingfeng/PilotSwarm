/**
 * The forced delete: deleteSession(sessionId, reason, { force: true }) deletes
 * a session tree that does not settle directly, strictly and from the leaves
 * up, with the target last. These tests drive the real method on a bare
 * prototype instance with an in-memory catalog and duroxide client.
 *
 * Run: node --test test/unit/management-forced-delete.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";

// R ─┬─ T ─┬─ A ── A1
//    │     └─ B
//    └─ S
const TREE = [["R", null], ["T", "R"], ["A", "T"], ["A1", "A"], ["B", "T"], ["S", "R"]];

/** `tree`: [sessionId, parentSessionId, { deleted, system, instance }] rows. */
function fixture(tree, { fail = {}, view = { status: "running", orchestrationStatus: "Running" }, afterFirstListing, takenOnCancel = [] } = {}) {
    const rows = new Map();
    const instances = new Set();
    let tick = Date.parse("2026-11-01T00:00:00Z");
    const addRow = (sessionId, parentSessionId, flags = {}) => {
        rows.set(sessionId, {
            sessionId,
            parentSessionId,
            isSystem: flags.system === true,
            deletedAt: flags.deleted ? new Date(tick) : null,
            updatedAt: new Date(tick++),
            state: "running",
            lastError: null,
        });
        if (flags.instance !== false) instances.add(`session-${sessionId}`);
    };
    for (const [sessionId, parentSessionId, flags] of tree) addRow(sessionId, parentSessionId, flags);

    const ops = [];
    const failures = new Map(Object.entries(fail));
    const maybeFail = (key) => {
        const error = failures.get(key);
        if (!error) return;
        failures.delete(key);
        throw error;
    };
    let listed = false;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._catalog = {
        listSessionsPage: async ({ limit, cursorUpdatedAt, cursorSessionId, includeDeleted }) => {
            const sorted = [...rows.values()]
                .filter((row) => includeDeleted || !row.deletedAt)
                .sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? 1 : -1));
            const page = (cursorUpdatedAt
                ? sorted.filter((row) => row.updatedAt < cursorUpdatedAt
                    || (row.updatedAt.getTime() === cursorUpdatedAt.getTime() && row.sessionId < cursorSessionId))
                : sorted).slice(0, limit).map((row) => ({ ...row }));
            if (!listed && afterFirstListing && page.length < limit) {
                listed = true;
                afterFirstListing(addRow);
            }
            return page;
        },
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
        getSession: async (sessionId) => {
            const row = rows.get(sessionId);
            return row && !row.deletedAt ? { ...row } : null;
        },
        updateSession: async (sessionId, patch) => {
            maybeFail(`update:${sessionId}`);
            ops.push(`failed:${sessionId}`);
            Object.assign(rows.get(sessionId), patch);
        },
        softDeleteSession: async (sessionId) => {
            maybeFail(`softDelete:${sessionId}`);
            ops.push(`delete:${sessionId}`);
            rows.get(sessionId).deletedAt = new Date();
        },
    };
    client._duroxideClient = {
        getStatus: async (instanceId) => ({ status: instances.has(instanceId) ? "Running" : "NotFound" }),
        cancelInstance: async (instanceId, reason) => {
            const sessionId = instanceId.slice("session-".length);
            maybeFail(`cancel:${sessionId}`);
            ops.push(`cancel:${sessionId}`);
            assert.equal(reason, "Session deleted");
            // A worker takes the queued start just as the cancel arrives.
            if (takenOnCancel.includes(sessionId)) instances.add(instanceId);
        },
        deleteInstance: async (instanceId, force) => {
            const sessionId = instanceId.slice("session-".length);
            maybeFail(`instance:${sessionId}`);
            assert.equal(force, true);
            ops.push(`instance:${sessionId}`);
            instances.delete(instanceId);
            return { instancesDeleted: 1, executionsDeleted: 0, eventsDeleted: 0, queueMessagesDeleted: 0 };
        },
    };
    const sent = [];
    client.sendCommand = async (sessionId, command) => { sent.push([sessionId, command.cmd]); };
    client.getSession = async (sessionId) => {
        const row = rows.get(sessionId);
        return row && !row.deletedAt ? { sessionId, isSystem: row.isSystem, ...view } : null;
    };
    const live = () => [...rows.values()].filter((row) => !row.deletedAt).map((row) => row.sessionId).sort();
    return { client, rows, ops, sent, live, instances };
}

const deletedInOrder = (ops) => ops.filter((op) => op.startsWith("delete:")).map((op) => op.slice("delete:".length));

test("immediate mode deletes the subtree from the leaves up with the target last, and sends no command", async () => {
    const h = fixture(TREE);
    const started = Date.now();
    await h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 });
    assert.ok(Date.now() - started < 1_000, "it does not wait");
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.live(), ["R", "S"], "never an ancestor or a sibling");
    const order = deletedInOrder(h.ops);
    assert.equal(order.at(-1), "T", "the target goes last");
    assert.ok(order.indexOf("A1") < order.indexOf("A"), "children go before their parent");
    for (const id of ["A1", "A", "B", "T"]) {
        assert.ok(h.ops.indexOf(`instance:${id}`) < h.ops.indexOf(`delete:${id}`), `${id}'s instance goes before its row`);
        assert.equal(h.rows.get(id).state, "failed");
    }
    assert.equal(h.rows.get("T").lastError, "work ended");
    assert.equal(h.rows.get("A").lastError, "Ancestor T deleted: work ended");
});

test("a failure stops at once, names what failed and keeps the target; a retry finishes the subtree", async () => {
    const h = fixture(TREE, { fail: { "softDelete:A": new Error("database unavailable") } });
    await assert.rejects(
        h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 }),
        /Forced delete of session T stopped at A: soft-deleting it failed: database unavailable/,
    );
    const live = h.live();
    assert.equal(live.includes("A1"), false, "A1, below the failure, is gone");
    for (const id of ["A", "T", "R", "S"]) assert.ok(live.includes(id), `${id} stays`);
    await h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 });
    assert.deepEqual(h.live(), ["R", "S"]);
});

test("a retry whose target is already gone finishes a session left under a soft-deleted parent", async () => {
    const h = fixture([["R", null], ["T", "R", { deleted: true, instance: false }], ["A", "T", { deleted: true }], ["A1", "A"], ["S", "R"]]);
    await h.client.deleteSession("T", "work ended", { force: true });
    assert.deepEqual(h.live(), ["R", "S"]);
    assert.equal(h.instances.has("session-A"), false, "the soft-deleted parent's instance is deleted too");
    assert.deepEqual(h.sent, []);
});

test("with force, a delete command that does not settle within settleTimeoutMs takes the strict path", async () => {
    const h = fixture(TREE);
    await h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 50 });
    assert.deepEqual(h.sent, [["T", "delete"]]);
    assert.deepEqual(h.live(), ["R", "S"]);
});

test("a start no worker has taken is cancelled, one a worker takes meanwhile is deleted, and a failed cancel stops the delete", async () => {
    // duroxide reports a start that no worker has taken as NotFound and won't
    // delete it; a cancel queued behind it ends it before any turn runs.
    const tree = [["R", null], ["T", "R", { instance: false }], ["A", "T", { instance: false }], ["B", "T", { instance: false }]];
    const h = fixture(tree, { takenOnCancel: ["B"] });
    await h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 });
    assert.deepEqual(h.live(), ["R"]);
    assert.deepEqual(h.ops.filter((op) => op.startsWith("cancel:")).sort(), ["cancel:A", "cancel:B", "cancel:T"]);
    assert.equal(h.ops.includes("instance:A"), false, "A's queued start is cancelled; there is no instance to delete");
    assert.ok(h.ops.indexOf("cancel:B") < h.ops.indexOf("instance:B"), "a worker took B's start meanwhile, so B's instance is deleted");
    assert.equal(h.instances.has("session-B"), false);

    const failing = fixture(tree, { fail: { "cancel:A": new Error("database unavailable") } });
    await assert.rejects(
        failing.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 }),
        /stopped at A: deleting its orchestration instance failed: database unavailable/,
    );
    assert.ok(failing.live().includes("A") && failing.live().includes("T"), "A and the target stay for a retry");
});

test("a child created after the listing stops the delete before its parent, and a retry deletes both", async () => {
    const h = fixture(TREE, { afterFirstListing: (addRow) => addRow("N", "T") });
    await assert.rejects(
        h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 }),
        /stopped at T: the check for live descendants failed: N appeared after the listing; retry/,
    );
    assert.deepEqual(h.live(), ["N", "R", "S", "T"]);
    await h.client.deleteSession("T", "work ended", { force: true, settleTimeoutMs: 0 });
    assert.deepEqual(h.live(), ["R", "S"]);
});

test("a system session in the subtree stops the forced delete", async () => {
    const h = fixture([["T", null], ["A", "T", { system: true }]]);
    await assert.rejects(h.client.deleteSession("T", "x", { force: true, settleTimeoutMs: 0 }), /stopped at A: deleting it failed/);
    assert.deepEqual(h.live(), ["A", "T"]);
    assert.deepEqual(h.ops, []);
});

test("settleTimeoutMs needs force and stays within 0 to 65 000 ms", async () => {
    const h = fixture(TREE);
    await assert.rejects(h.client.deleteSession("T", "x", { settleTimeoutMs: 0 }), (error) => error.code === "INVALID_REQUEST");
    await assert.rejects(h.client.deleteSession("T", "x", { force: true, settleTimeoutMs: 65_001 }), (error) => error.code === "INVALID_REQUEST");
    assert.deepEqual(h.ops, []);
});

test("without force, a terminal session keeps the lenient cascade: a descendant that fails is logged and skipped", async (t) => {
    t.mock.method(console, "error", () => {});
    const h = fixture(TREE, { view: { status: "completed", orchestrationStatus: "Completed" }, fail: { "softDelete:A": new Error("database unavailable") } });
    await h.client.deleteSession("T", "work ended");
    assert.deepEqual(h.live(), ["A", "R", "S"]);
});
