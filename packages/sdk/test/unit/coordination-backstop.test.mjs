/**
 * Owner routing's backstop: a worker with a capacity requester (the
 * coordination host) refuses, without a retry, a turn of a session whose
 * creation config holds an owner tag that the turn's input lacks or replaces.
 * The turn runs when the tags match or the config holds no valid tag. A worker
 * without a requester reads no config.
 *
 * Run: node --test test/unit/coordination-backstop.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { registerActivities } from "../../dist/session-proxy.js";
import { TURN_CONTROL_ACTIVITY_NAMES, WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES } from "../../dist/activity-routing.js";
import { OWNER_TAG_MISSING, ownerTagMissingText } from "../../dist/owner-routing.js";
import { isAuthFailureError } from "../../dist/orchestration/utils.js";

const OWNER_A = "owner.6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01";
const OWNER_B = "owner.9d2e4c71-3b6a-4f0d-8e25-5c8a1f6b7e02";

/** Creation configs by session; "missing" has none. */
const CONFIGS = {
    tagged: { model: "test:model", ownerTag: OWNER_A },
    untagged: { model: "test:model" },
    "invalid-tag": { model: "test:model", ownerTag: "owner.has a space" },
};

function workerWith({
    requester = async () => ({ decision: "ok" }),
    noRequesterMethod = false,
    noConfigMethod = false,
    failRead = null,
    admission = null,
} = {}) {
    const handlers = new Map();
    const ran = [];
    const reads = [];
    const asked = [];
    const sessionManager = {
        getModelSummary: async () => null,
        // The turn's body starts with this lock: reaching it means the turn ran.
        withRunTurnLock: async (sessionId) => { ran.push(sessionId); return { type: "completed", content: "ran" }; },
        getSessionStateDir: () => tmpdir(),
        getTurnControlHub: () => null,
        getSessionAdmission: () => admission ? async (request) => { asked.push(request); return admission(request); } : null,
    };
    if (!noRequesterMethod) sessionManager.getOwnerCapacityRequester = () => requester;
    const catalog = { getSession: async (id) => ({ sessionId: id, rootSessionId: id, owner: null, isSystem: false }) };
    if (!noConfigMethod) {
        catalog.getSessionCreationConfig = async (id) => {
            reads.push(id);
            if (failRead) throw failRead;
            return CONFIGS[id] ?? null;
        };
    }
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) },
        sessionManager, null, undefined, catalog, undefined, undefined, undefined, undefined,
        [], null, [], [], null, "host-1");
    const ctx = { traceInfo() {}, orchestrationVersion: "1.0.84", isCancelled: () => false };
    const turn = (sessionId, extra = {}, activity = WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES.runTurn) =>
        handlers.get(activity)(ctx, { sessionId, prompt: "hello", config: {}, turnIndex: 1, ...extra });
    return { turn, ran, reads, asked };
}

const RAN = { type: "completed", content: "ran" };

test("a worker with a capacity requester refuses, without a retry, a turn that lacks or replaces the session's saved owner tag", async () => {
    const { turn, ran } = workerWith();
    const missing = { type: "error", message: ownerTagMissingText(undefined), retryable: false };
    for (const activity of ["runTurn", TURN_CONTROL_ACTIVITY_NAMES.runTurn, ...Object.values(WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES)]) {
        assert.deepEqual(await turn("tagged", {}, activity), missing, activity);
    }
    assert.deepEqual(await turn("tagged", { ownerTag: OWNER_B }), { type: "error", message: ownerTagMissingText(OWNER_B), retryable: false });
    assert.deepEqual(ran, [], "the session was neither locked nor loaded here");
    for (const tag of [undefined, OWNER_B]) {
        const text = ownerTagMissingText(tag);
        assert.ok(text.startsWith(`${OWNER_TAG_MISSING}: `), text);
        assert.ok(!text.includes(OWNER_A) && !text.includes(OWNER_B), "the message names no owner");
        assert.equal(isAuthFailureError(text), false, "the orchestration does not read it as a bad key");
    }
    assert.match(ownerTagMissingText(undefined), /without its owner tag/);
    assert.match(ownerTagMissingText(OWNER_B), /with another owner's tag/);
});

test("the turn runs when its tag matches the saved one, and when the config holds no valid tag or there is none", async () => {
    const { turn, ran, reads } = workerWith();
    assert.deepEqual(await turn("tagged", { ownerTag: OWNER_A }), RAN);
    for (const sessionId of ["untagged", "invalid-tag", "missing"]) {
        assert.deepEqual(await turn(sessionId), RAN, sessionId);
    }
    assert.deepEqual(ran, ["tagged", "untagged", "invalid-tag", "missing"]);
    assert.deepEqual(reads, ["tagged", "untagged", "invalid-tag", "missing"]);
});

test("a worker without a requester reads no creation config and runs every turn as before", async () => {
    for (const options of [{ requester: null }, { noRequesterMethod: true }]) {
        const { turn, ran, reads } = workerWith(options);
        assert.deepEqual(await turn("tagged"), RAN);
        assert.deepEqual(await turn("tagged", { ownerTag: OWNER_B }), RAN);
        assert.deepEqual(ran, ["tagged", "tagged"]);
        assert.deepEqual(reads, [], "no read without a requester");
    }
    // A catalog that keeps no creation configs has no saved tag to check.
    const { turn, ran } = workerWith({ noConfigMethod: true });
    assert.deepEqual(await turn("tagged"), RAN);
    assert.deepEqual(ran, ["tagged"]);
});

test("a creation config the worker can't read fails the turn with an error that is retried, and nothing runs", async () => {
    const { turn, ran } = workerWith({ failRead: Object.assign(new Error("relation does not exist"), { code: "42P01" }) });
    const result = await turn("tagged");
    assert.equal(result.type, "error");
    assert.match(result.message, /^Owner routing could not check this turn: the session catalog could not read its creation config: relation does not exist$/);
    assert.equal(result.retryable, undefined, "the orchestration retries it");
    assert.deepEqual(ran, []);
});

test("the check comes before the admission hook, which a refused turn never asks", async () => {
    const { turn, asked, ran } = workerWith({ admission: () => ({ decision: "admit" }) });
    assert.equal((await turn("tagged")).retryable, false);
    assert.deepEqual(asked, []);
    assert.deepEqual(await turn("untagged"), RAN);
    assert.deepEqual(asked, [{ sessionId: "untagged", rootSessionId: "untagged", isSystem: false }]);
    assert.deepEqual(ran, ["untagged"]);
});

test("a refused turn that carries a Workflow intake invocation reports it not sent", async () => {
    const { turn } = workerWith();
    const intake = {
        invocationId: "inv-1",
        attemptId: "att-1",
        sentBefore: false,
        items: [{ exchangeId: `nx-${"a".repeat(40)}`, claimId: "claim-1", clientMessageId: "m-1", text: "a Workflow's request" }],
    };
    assert.deepEqual(await turn("tagged", { intake }), {
        type: "error",
        message: ownerTagMissingText(undefined),
        retryable: false,
        intakeDispatch: { invocationId: "inv-1", sent: false },
    });
});
