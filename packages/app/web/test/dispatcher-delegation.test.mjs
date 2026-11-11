// Delegation to the deployment's dispatcher (DISPATCHER_SP_OBJECT_ID): the
// opt-in, `onBehalfOfOwner`, live revocation and the delegated end of work,
// on the portal runtime's single gate, with a stub transport (no database).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PortalRuntime } from "../runtime.js";
import { delegationRevokedError, isDispatcherPrincipal, loadAuthzConfig, parseOnBehalfOfOwner } from "../authz.js";
import { createConnectionHandler } from "../api/ws.js";

const DISPATCHER = "0b5e0c8a-1d2e-4f30-9a41-5c6d7e8f9a0b";
const as = (subject, role = "user") => ({
    principal: { provider: "entra", subject, displayName: `${subject} name`, email: null },
    authorization: { role },
});
const dispatcher = as(DISPATCHER);
const owner = as("owner-on");

const LISTING = [
    { sessionId: "s-off", owner: { provider: "entra", subject: "owner-off" } },
    { sessionId: "s-on", owner: { provider: "entra", subject: "owner-on" } },
    { sessionId: "s-on-child", parentSessionId: "s-on", owner: { provider: "entra", subject: "owner-on" } },
    { sessionId: "s-system", isSystem: true },
    { sessionId: "s-own", owner: { provider: "entra", subject: DISPATCHER } },
    { sessionId: "s-unowned" },
    { sessionId: "s-system-user", owner: { provider: "system", subject: "system" } },
];

/**
 * Sessions are `{ owner, visibility?, shares?: { subject: access }, isSystem? }`;
 * `flags` maps a subject to its opt-in. `log` records every side effect in order.
 */
function world({ env = {}, flags = {}, sessions = {}, failDelegatedAudit = false } = {}) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = loadAuthzConfig({ AUTHZ_ENFORCE_OWNERSHIP: "true", DISPATCHER_SP_OBJECT_ID: DISPATCHER, ...env });
    const log = [];
    const audits = [];
    const lookups = [];
    const optIns = new Map(Object.entries(flags));
    runtime._logDelegatedCall = (entry) => log.push(["logLine", entry.action, entry.sessionId]);
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => {
            const session = sessions[sessionId];
            if (!session) return null;
            const sessionOwner = session.owner ? { provider: "entra", subject: session.owner, displayName: null, email: null } : null;
            return {
                rootSessionId: sessionId,
                isSystem: session.isSystem === true,
                visibility: session.visibility || "private",
                owner: sessionOwner,
                viewerIsOwner: Boolean(sessionOwner) && viewer.provider === "entra" && viewer.subject === session.owner,
                viewerShareAccess: session.shares?.[viewer.subject] ?? null,
            };
        },
        getMyDispatcherDelegation: async ({ principal }) => {
            lookups.push(principal.subject);
            return { enabled: optIns.get(principal.subject) === true, dispatcherConfigured: false };
        },
        setMyDispatcherDelegation: async ({ principal, enabled }) => {
            optIns.set(principal.subject, enabled);
            log.push(["setOptIn", principal.subject, enabled]);
            return { enabled, dispatcherConfigured: false };
        },
        recordAuthzAudit: async (entry) => {
            if (failDelegatedAudit && entry.decision === "delegated") throw new Error("database unavailable");
            audits.push(entry);
            log.push(["audit", entry.action, entry.decision]);
        },
        grantSessionShare: async (sessionId, grantee, access) => { log.push(["share", sessionId, grantee.subject, access]); },
        createSession: async (options) => { log.push(["create", options]); return { sessionId: "new-1" }; },
        createSessionForAgent: async (agentName, options) => { log.push(["createForAgent", agentName, options]); return { sessionId: "new-2" }; },
        deleteSession: async (...args) => { log.push(["delete", ...args]); },
        completeSession: async (...args) => { log.push(["complete", ...args]); },
        cancelSession: async (...args) => { log.push(["cancel", ...args]); },
        sendMessage: async (sessionId) => { log.push(["send", sessionId]); },
        getSessionEvents: async (sessionId) => { log.push(["events", sessionId]); return []; },
        readFacts: async (_query, opts) => { log.push(["facts", opts.sessionId ?? null]); return { count: 0, facts: [] }; },
        mgmt: {
            getSession: async (sessionId) => ({ sessionId }),
            listSessions: async () => LISTING,
            listSessionsVisible: async () => LISTING,
            listSessionsPage: async () => ({ sessions: LISTING, hasMore: true, nextCursor: { updatedAt: 1, sessionId: "s-system-user" } }),
            listSessionGroups: async (viewer) => {
                log.push(["groups", viewer.subject]);
                return [{ groupId: `group-of-${viewer.subject}`, owner: { provider: viewer.provider, subject: viewer.subject } }];
            },
            placeSessionsInGroup: async (viewer, sessionIds, groupId) => {
                log.push(["place", viewer.subject, sessionIds, groupId]);
                return [];
            },
        },
    };
    return { runtime, log, audits, lookups, optIns };
}

async function refusal(promise) {
    try {
        await promise;
    } catch (error) {
        return { status: error.status ?? null, code: error.code ?? null, message: error.message };
    }
    assert.fail("expected the call to be refused");
}

test("DISPATCHER_SP_OBJECT_ID names the dispatcher; unset, nobody is one", () => {
    assert.equal(loadAuthzConfig({}).dispatcherSubject, null);
    assert.equal(loadAuthzConfig({ DISPATCHER_SP_OBJECT_ID: "  " }).dispatcherSubject, null);
    const config = loadAuthzConfig({ DISPATCHER_SP_OBJECT_ID: ` ${DISPATCHER.toUpperCase()} ` });
    assert.equal(isDispatcherPrincipal({ provider: "entra", subject: DISPATCHER }, config), true, "object IDs compare case-insensitively");
    assert.equal(isDispatcherPrincipal({ provider: "entra", subject: "someone-else" }, config), false);
    assert.equal(isDispatcherPrincipal({ provider: "entra", subject: DISPATCHER }, loadAuthzConfig({})), false);

    assert.deepEqual(parseOnBehalfOfOwner({ subject: " owner-on " }, { provider: "entra" }),
        { provider: "entra", subject: "owner-on", email: null, displayName: null }, "the provider defaults to the caller's");
    assert.equal(parseOnBehalfOfOwner({ subject: "u", provider: "dev" }, { provider: "entra" }).provider, "dev");
    for (const raw of ["owner-on", {}, { subject: "" }, [{ subject: "x" }], { subject: 7 }]) {
        assert.throws(() => parseOnBehalfOfOwner(raw, { provider: "entra" }), (error) => error.code === "INVALID_REQUEST");
    }
});

test("the opt-in reads and changes only the signed-in caller's own flag", async () => {
    const w = world({ flags: { "owner-on": true } });
    const result = await w.runtime.call("setMyDispatcherDelegation", {
        enabled: false,
        principal: { provider: "entra", subject: "owner-on" },
        user: { provider: "entra", subject: "owner-on" },
    }, as("owner-off"));
    assert.deepEqual(result, { enabled: false, dispatcherConfigured: true });
    assert.deepEqual(w.log.filter(([kind]) => kind === "setOptIn"), [["setOptIn", "owner-off", false]]);
    assert.equal(w.optIns.get("owner-on"), true, "another user's flag is untouched");
    assert.deepEqual(await w.runtime.call("getMyDispatcherDelegation", {}, owner), { enabled: true, dispatcherConfigured: true });

    const unset = world({ env: { DISPATCHER_SP_OBJECT_ID: "" } });
    assert.deepEqual(await unset.runtime.call("getMyDispatcherDelegation", {}, owner), { enabled: false, dispatcherConfigured: false });

    const invalid = await refusal(w.runtime.call("setMyDispatcherDelegation", { enabled: "yes" }, owner));
    assert.equal(invalid.code, "INVALID_REQUEST");
    await w.runtime.call("setMyDispatcherDelegation", { enabled: true }, owner);
    assert.ok(w.audits.some((entry) => entry.action === "setMyDispatcherDelegation" && entry.decision === "share_change"
        && entry.target === "entra/owner-on" && entry.reason === "dispatcher delegation on"));
});

test("onBehalfOfOwner is refused for every caller but the dispatcher, admins included", async () => {
    const callers = [as("someone"), as("admin-1", "admin")];
    for (const caller of callers) {
        const w = world({ flags: { "owner-on": true } });
        const error = await refusal(w.runtime.call("createSession", { onBehalfOfOwner: { subject: "owner-on" } }, caller));
        assert.deepEqual([error.status, error.code], [403, "FORBIDDEN"]);
        assert.equal(w.log.some(([kind]) => kind === "create"), false);
        assert.ok(w.audits.some((entry) => entry.action === "createSession" && entry.decision === "deny"));
    }
    const unset = world({ env: { DISPATCHER_SP_OBJECT_ID: "" }, flags: { "owner-on": true } });
    const error = await refusal(unset.runtime.call("createSession", { onBehalfOfOwner: { subject: "owner-on" } }, dispatcher));
    assert.deepEqual([error.status, error.code], [403, "FORBIDDEN"], "with no dispatcher configured nobody may delegate");
    assert.equal(unset.log.some(([kind]) => kind === "create"), false);
});

test("onBehalfOfOwner needs the owner's opt-in, another user and a private session", async () => {
    const w = world({ flags: { "owner-on": true } });
    const off = await refusal(w.runtime.call("createSession", { onBehalfOfOwner: { subject: "owner-off" } }, dispatcher));
    assert.deepEqual([off.status, off.code], [403, "DELEGATION_REVOKED"]);
    const self = await refusal(w.runtime.call("createSession", { onBehalfOfOwner: { subject: DISPATCHER } }, dispatcher));
    assert.equal(self.code, "INVALID_REQUEST");
    const shared = await refusal(w.runtime.call("createSession", { onBehalfOfOwner: { subject: "owner-on" }, visibility: "shared_read" }, dispatcher));
    assert.equal(shared.code, "INVALID_REQUEST");
    assert.equal(w.log.some(([kind]) => kind === "create" || kind === "share"), false);
});

test("a delegated session is the owner's, private, with the dispatcher's write share as its only share, audited first", async () => {
    const w = world({ env: { SESSIONS_DEFAULT_VISIBILITY: "shared_write" }, flags: { "owner-on": true } });
    const created = await w.runtime.call("createSession", {
        model: "provider:model",
        groupId: "group-of-owner-on",
        onBehalfOfOwner: { subject: "owner-on" },
    }, dispatcher);
    assert.equal(created.sessionId, "new-1");
    const create = w.log.find(([kind]) => kind === "create")[1];
    assert.deepEqual(create.owner, { provider: "entra", subject: "owner-on", email: null, displayName: null });
    assert.equal(create.visibility, "private", "not the deployment's shared_write default");
    assert.equal(create.model, "provider:model");
    const kinds = w.log.map(([kind, action, detail]) => [kind, kind === "share" ? `${action}:${detail}` : action]);
    const order = (step) => kinds.findIndex(([kind, detail]) => kind === step[0] && (step[1] === undefined || detail === step[1]));
    assert.ok(order(["groups", "owner-on"]) < order(["create"]), "the group must be one of the owner's");
    assert.ok(order(["create"]) < order(["audit", "createSession"]));
    assert.ok(order(["audit", "createSession"]) < order(["share", `new-1:${DISPATCHER}`]), "audited before the dispatcher gains access");
    assert.deepEqual(w.log.filter(([kind]) => kind === "share"), [["share", "new-1", DISPATCHER, "write"]]);
    assert.deepEqual(w.log.filter(([kind]) => kind === "logLine"), [["logLine", "createSession", "new-1"]]);
    assert.deepEqual(w.log.filter(([kind]) => kind === "place"), [["place", "owner-on", ["new-1"], "group-of-owner-on"]]);
    const audit = w.audits.find((entry) => entry.decision === "delegated");
    assert.equal(audit.target, "entra/owner-on");
    assert.equal(audit.actor.subject, DISPATCHER);

    await w.runtime.call("createSessionForAgent", { agentName: "builder", onBehalfOfOwner: { subject: "owner-on" } }, dispatcher);
    const forAgent = w.log.find(([kind]) => kind === "createForAgent");
    assert.equal(forAgent[1], "builder");
    assert.equal(forAgent[2].owner.subject, "owner-on");
    assert.equal(forAgent[2].isAdmin, false, "the owner's agent catalog, without admin reach");
    assert.equal(forAgent[2].visibility, "private");
    assert.equal(w.audits.find((entry) => entry.action === "createSessionForAgent").details.agentName, "builder");
});

test("a delegated creation fails when its audit cannot be written, and removes the session", async () => {
    const w = world({ flags: { "owner-on": true }, failDelegatedAudit: true });
    const error = await refusal(w.runtime.call("createSession", { onBehalfOfOwner: { subject: "owner-on" } }, dispatcher));
    assert.deepEqual([error.status, error.code], [503, "AUDIT_UNAVAILABLE"]);
    assert.equal(w.log.some(([kind]) => kind === "share" || kind === "logLine"), false, "no share without an audit entry");
    const removed = w.log.find(([kind]) => kind === "delete");
    assert.deepEqual(removed.slice(1), ["new-1", "Delegated creation failed", { force: true, settleTimeoutMs: 0 }]);
});

const SHARED_WITH_DISPATCHER = {
    "s-1": { owner: "owner-on", shares: { [DISPATCHER]: "write" } },
    "s-2": { owner: "owner-on", visibility: "shared_read" },
    "s-3": { owner: "owner-on" },
};

test("with the opt-in off the dispatcher gets 403 DELEGATION_REVOKED where it had access, and 404 where it never had", async () => {
    const w = world({ flags: { "owner-on": false }, sessions: SHARED_WITH_DISPATCHER });
    const calls = [
        ["getSession", { sessionId: "s-1" }],
        ["getSessionEvents", { sessionId: "s-1" }],
        ["sendMessage", { sessionId: "s-1", prompt: "hello" }],
        ["readFacts", { sessionId: "s-1" }],
        ["completeSession", { sessionId: "s-1" }],
        ["cancelSession", { sessionId: "s-1" }],
        ["deleteSession", { sessionId: "s-1", force: true, settleTimeoutMs: 0 }],
        ["getSession", { sessionId: "s-2" }],
    ];
    for (const [method, params] of calls) {
        const error = await refusal(w.runtime.call(method, params, dispatcher));
        assert.deepEqual([error.status, error.code], [403, "DELEGATION_REVOKED"], method);
    }
    const never = await refusal(w.runtime.call("getSession", { sessionId: "s-3" }, dispatcher));
    assert.deepEqual([never.status, never.code], [404, "NOT_FOUND"], "no existence oracle for a session it was never given");
    assert.equal(w.log.some(([kind]) => ["send", "events", "facts", "complete", "cancel", "delete"].includes(kind)), false);
    assert.ok(w.audits.some((entry) => entry.decision === "deny" && entry.target === "entra/owner-on"));

    // The share was kept, so turning the opt-in back on restores the same access.
    w.optIns.set("owner-on", true);
    assert.deepEqual(await w.runtime.call("getSession", { sessionId: "s-1" }, dispatcher), { sessionId: "s-1" });
    await w.runtime.call("sendMessage", { sessionId: "s-1", prompt: "hello" }, dispatcher);
    assert.ok(w.log.some(([kind, sessionId]) => kind === "send" && sessionId === "s-1"));

    // The owner and everyone else are unaffected, and cost no flag lookup.
    const before = w.lookups.length;
    w.optIns.set("owner-on", false);
    assert.deepEqual(await w.runtime.call("getSession", { sessionId: "s-1" }, owner), { sessionId: "s-1" });
    assert.equal(w.lookups.length, before);
});

test("without ownership enforcement a revoked opt-in is audited as would_deny and changes no access", async () => {
    const w = world({ env: { AUTHZ_ENFORCE_OWNERSHIP: "false" }, flags: { "owner-on": false }, sessions: SHARED_WITH_DISPATCHER });
    assert.deepEqual(await w.runtime.call("getSession", { sessionId: "s-1" }, dispatcher), { sessionId: "s-1" });
    await w.runtime.call("completeSession", { sessionId: "s-1" }, dispatcher);
    assert.ok(w.log.some(([kind]) => kind === "complete"));
    assert.ok(w.audits.some((entry) => entry.action === "getSession" && entry.decision === "would_deny"));
    assert.ok(w.audits.some((entry) => entry.action === "completeSession" && entry.decision === "would_deny"));
    const rows = await w.runtime.call("listSessions", {}, dispatcher);
    assert.equal(rows.length, LISTING.length, "listings stay unfiltered, like everyone's");
});

test("listings drop, for the dispatcher only, the sessions of owners who do not allow it", async () => {
    const w = world({ flags: { "owner-on": true, "owner-off": false } });
    const rows = await w.runtime.call("listSessions", {}, dispatcher);
    assert.deepEqual(rows.map((row) => row.sessionId), ["s-on", "s-on-child", "s-system", "s-own", "s-unowned", "s-system-user"]);
    assert.deepEqual(w.lookups.sort(), ["owner-off", "owner-on"], "one lookup per owner");

    const page = await w.runtime.call("listSessionsPage", { limit: 50 }, dispatcher);
    assert.deepEqual(page.sessions.map((row) => row.sessionId), rows.map((row) => row.sessionId));
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.nextCursor, { updatedAt: 1, sessionId: "s-system-user" }, "paging continues from the unfiltered page");

    const lookups = w.lookups.length;
    assert.equal((await w.runtime.call("listSessions", {}, as("someone"))).length, LISTING.length);
    assert.equal(w.lookups.length, lookups);
});

test("the delegated end of work: complete, cancel and delete, each audited before it runs", async () => {
    for (const enforce of ["true", "false"]) {
        const w = world({ env: { AUTHZ_ENFORCE_OWNERSHIP: enforce }, flags: { "owner-on": true }, sessions: SHARED_WITH_DISPATCHER });
        await w.runtime.call("completeSession", { sessionId: "s-1", reason: "work ended" }, dispatcher);
        await w.runtime.call("cancelSession", { sessionId: "s-1" }, dispatcher);
        await w.runtime.call("deleteSession", { sessionId: "s-1", reason: "work ended", force: true, settleTimeoutMs: 0 }, dispatcher);
        assert.deepEqual(w.log.filter(([kind]) => ["audit", "logLine", "complete", "cancel", "delete"].includes(kind)), [
            ["audit", "completeSession", "delegated"], ["logLine", "completeSession", "s-1"], ["complete", "s-1", "work ended"],
            ["audit", "cancelSession", "delegated"], ["logLine", "cancelSession", "s-1"], ["cancel", "s-1"],
            ["audit", "deleteSession", "delegated"], ["logLine", "deleteSession", "s-1"],
            ["delete", "s-1", "work ended", { force: true, settleTimeoutMs: 0 }],
        ], `AUTHZ_ENFORCE_OWNERSHIP=${enforce}`);
        const deleted = w.audits.find((entry) => entry.action === "deleteSession");
        assert.deepEqual(deleted.details, { owner: { provider: "entra", subject: "owner-on" }, force: true, settleTimeoutMs: 0 });
        assert.equal(deleted.target, "entra/owner-on");
    }
});

test("the delegated end of work fails, before anything happens, when its audit cannot be written", async () => {
    const w = world({ flags: { "owner-on": true }, sessions: SHARED_WITH_DISPATCHER, failDelegatedAudit: true });
    for (const method of ["completeSession", "cancelSession", "deleteSession"]) {
        const error = await refusal(w.runtime.call(method, { sessionId: "s-1" }, dispatcher));
        assert.deepEqual([error.status, error.code], [503, "AUDIT_UNAVAILABLE"], method);
    }
    assert.equal(w.log.some(([kind]) => ["complete", "cancel", "delete", "logLine"].includes(kind)), false);
});

test("the dispatcher cannot end work without the opt-in, without its write share, or with no dispatcher configured", async () => {
    const sessions = {
        ...SHARED_WITH_DISPATCHER,
        "s-read": { owner: "owner-on", shares: { [DISPATCHER]: "read" } },
    };
    const off = world({ flags: { "owner-on": false }, sessions });
    assert.equal((await refusal(off.runtime.call("deleteSession", { sessionId: "s-1" }, dispatcher))).code, "DELEGATION_REVOKED");

    const on = world({ flags: { "owner-on": true }, sessions });
    for (const method of ["completeSession", "cancelSession", "deleteSession"]) {
        const readOnly = await refusal(on.runtime.call(method, { sessionId: "s-read" }, dispatcher));
        assert.deepEqual([readOnly.status, readOnly.code], [403, "FORBIDDEN"], `${method}: a read share is not enough`);
        const never = await refusal(on.runtime.call(method, { sessionId: "s-3" }, dispatcher));
        assert.deepEqual([never.status, never.code], [404, "NOT_FOUND"], `${method}: no share at all`);
    }

    const unset = world({ env: { DISPATCHER_SP_OBJECT_ID: "" }, flags: { "owner-on": true }, sessions });
    for (const method of ["completeSession", "cancelSession", "deleteSession"]) {
        const error = await refusal(unset.runtime.call(method, { sessionId: "s-1" }, dispatcher));
        assert.deepEqual([error.status, error.code], [403, "FORBIDDEN"], `${method}: refused as today`);
    }
    assert.equal(unset.lookups.length, 0, "no flag lookups while no dispatcher is configured");
    for (const w of [off, on, unset]) {
        assert.equal(w.log.some(([kind]) => ["complete", "cancel", "delete"].includes(kind)), false);
    }
});

test("only the owner, an admin or the delegated dispatcher may force a delete, in both modes", async () => {
    const sessions = { "s-1": { owner: "owner-on", shares: { [DISPATCHER]: "write", collaborator: "write" } } };
    for (const enforce of ["true", "false"]) {
        const w = world({ env: { AUTHZ_ENFORCE_OWNERSHIP: enforce }, flags: { "owner-on": true }, sessions });
        const error = await refusal(w.runtime.call("deleteSession", { sessionId: "s-1", force: true }, as("collaborator")));
        assert.deepEqual([error.status, error.code], [403, "FORBIDDEN"], `AUTHZ_ENFORCE_OWNERSHIP=${enforce}`);
        await w.runtime.call("deleteSession", { sessionId: "s-1", force: true }, owner);
        await w.runtime.call("deleteSession", { sessionId: "s-1", force: true }, as("admin-1", "admin"));
        await w.runtime.call("deleteSession", { sessionId: "s-1", force: true }, dispatcher);
        assert.equal(w.log.filter(([kind]) => kind === "delete").length, 3);
    }
    const dark = world({ env: { AUTHZ_ENFORCE_OWNERSHIP: "false" }, sessions });
    await dark.runtime.call("deleteSession", { sessionId: "s-1" }, as("collaborator"));
    assert.equal(dark.log.filter(([kind]) => kind === "delete").length, 1, "an ordinary delete is audit-only, as before");
});

test("each delegated call is one JSON log line", async () => {
    const w = world({ flags: { "owner-on": true }, sessions: SHARED_WITH_DISPATCHER });
    delete w.runtime._logDelegatedCall;
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try {
        await w.runtime.call("deleteSession", { sessionId: "s-1", force: true, settleTimeoutMs: 0 }, dispatcher);
    } finally {
        console.log = original;
    }
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.event, "pilotswarm.dispatcher_delegation");
    assert.deepEqual({ action: line.action, sessionId: line.sessionId, owner: line.owner, dispatcher: line.dispatcher, force: line.force, settleTimeoutMs: line.settleTimeoutMs },
        { action: "deleteSession", sessionId: "s-1", owner: "entra/owner-on", dispatcher: `entra/${DISPATCHER}`, force: true, settleTimeoutMs: 0 });
});

test("dispatcherDeliveryCheck re-reads the owner's opt-in for the dispatcher's subscriptions only", async () => {
    const sessions = { ...SHARED_WITH_DISPATCHER, "s-system": { isSystem: true }, "s-own": { owner: DISPATCHER } };
    const w = world({ flags: { "owner-on": true }, sessions });
    assert.equal(await w.runtime.dispatcherDeliveryCheck("s-1", owner), null);
    assert.equal(await w.runtime.dispatcherDeliveryCheck("s-system", dispatcher), null);
    assert.equal(await w.runtime.dispatcherDeliveryCheck("s-own", dispatcher), null);
    const check = await w.runtime.dispatcherDeliveryCheck("s-1", dispatcher);
    assert.equal(await check(), true);
    w.optIns.set("owner-on", false);
    assert.equal(await check(), false);
    const dark = world({ env: { AUTHZ_ENFORCE_OWNERSHIP: "false" }, flags: { "owner-on": true }, sessions });
    assert.equal(await dark.runtime.dispatcherDeliveryCheck("s-1", dispatcher), null);
});

function fakeSocket() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.OPEN = 1;
    ws.sent = [];
    ws.send = (raw) => ws.sent.push(JSON.parse(raw));
    ws.close = (code, reason) => { ws.closed = { code, reason }; ws.emit("close"); };
    return ws;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an open subscription sends the dispatcher no further event once the owner turns delegation off", async () => {
    let allowed = true;
    let deliver = null;
    let unsubscribed = 0;
    const runtime = {
        start: async () => {},
        noteSignInRole: () => {},
        authorizeSessionSubscribe: async () => {},
        dispatcherDeliveryCheck: async () => async () => allowed,
        subscribeSession: (_sessionId, handler) => { deliver = handler; return () => { unsubscribed += 1; }; },
    };
    const ws = fakeSocket();
    await createConnectionHandler(runtime)(ws, { headers: {}, url: "/api/v1/ws" });
    ws.emit("message", JSON.stringify({ type: "subscribeSession", sessionId: "s-1" }));
    await tick();
    await tick();
    deliver({ seq: 1 });
    deliver({ seq: 2 });
    await tick();
    await tick();
    allowed = false;
    deliver({ seq: 3 });
    await tick();
    await tick();
    deliver({ seq: 4 });
    await tick();
    const events = ws.sent.filter((message) => message.type === "sessionEvent").map((message) => message.event.seq);
    assert.deepEqual(events, [1, 2]);
    const errors = ws.sent.filter((message) => message.type === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "DELEGATION_REVOKED");
    assert.equal(errors[0].sessionId, "s-1");
    assert.equal(unsubscribed, 1);
    ws.emit("close");
});

test("a subscription refused for a revoked opt-in says DELEGATION_REVOKED, not that the session is gone", async () => {
    const runtime = {
        start: async () => {},
        noteSignInRole: () => {},
        authorizeSessionSubscribe: async () => { throw delegationRevokedError(); },
        subscribeSession: () => assert.fail("must not subscribe"),
    };
    const ws = fakeSocket();
    await createConnectionHandler(runtime)(ws, { headers: {}, url: "/api/v1/ws" });
    ws.emit("message", JSON.stringify({ type: "subscribeSession", sessionId: "s-1" }));
    await tick();
    await tick();
    const error = ws.sent.find((message) => message.type === "error");
    assert.equal(error.code, "DELEGATION_REVOKED");
    assert.match(error.error, /dispatcher/);
    ws.emit("close");
});
