/**
 * Dispatcher delegation and owner routing in the SDK's clients
 * (docs/proposals/windows-worker-pool.md, "Owner routing" and "Delegation to a
 * dispatcher"): the trusted creation fields the portal saves for a session a
 * dispatcher creates for a user, the stored tag that every client copies at
 * start, the fast busy policy's scope, and the delegation record's read.
 *
 * The clients reach an in-memory catalog and a fake duroxide client.
 *
 * Run: node --test test/unit/delegated-creation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient, PilotSwarmManagementClient } from "../../dist/index.js";

const USER = { provider: "entra", subject: "0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11" };
const OWNER = `owner.${USER.subject}`;
const DISPATCHER = { provider: "entra", subject: "5d0c9b61-2f4e-4a8d-b1c7-3e9f0a6d2b44" };

function fakeStore({ creationConfigs = true } = {}) {
    const rows = new Map();
    const creation = new Map();
    const starts = [];
    const catalog = {
        async createSession(sessionId, opts = {}) {
            const parent = opts.parentSessionId ? rows.get(opts.parentSessionId) : null;
            rows.set(sessionId, {
                sessionId,
                parentSessionId: opts.parentSessionId ?? null,
                rootSessionId: parent ? parent.rootSessionId : sessionId,
                owner: opts.owner ?? null,
                isSystem: Boolean(opts.isSystem),
                state: "pending",
                orchestrationId: null,
            });
            creation.set(sessionId, opts.creationConfig ? JSON.parse(JSON.stringify(opts.creationConfig)) : null);
        },
        async getSession(sessionId) { return rows.get(sessionId) ?? null; },
        async updateSession(sessionId, updates) { Object.assign(rows.get(sessionId) ?? {}, updates); },
        async recordEvents() {},
        async listSessions() { return [...rows.values()]; },
    };
    if (creationConfigs) catalog.getSessionCreationConfig = async (sessionId) => creation.get(sessionId) ?? null;
    const duroxide = {
        async startOrchestrationVersioned(id, _name, input) { starts.push({ id, input }); },
        async enqueueEvent() {},
        async getStatus() { throw new Error("no status"); },
    };
    const client = (options = {}) => {
        const c = new PilotSwarmClient({ store: "postgresql://unused", ...options });
        c._catalog = catalog;
        c.duroxideClient = duroxide;
        return c;
    };
    const startOf = (sessionId) => starts.find((s) => s.id === `session-${sessionId}`)?.input;
    return { catalog, rows, creation, client, startOf };
}

test("the stored owner tag wins over this process's own record of the create and the start's options", async () => {
    const store = fakeStore();
    const client = store.client();
    const session = await client.createSession({ owner: USER, ownerTag: OWNER });
    // The durable record says otherwise than this process remembers and the caller passes.
    store.creation.get(session.sessionId).ownerTag = "owner.stored";
    await client._startTurn(session.sessionId, "hello", { ownerTag: "owner.passed" });
    assert.equal(store.startOf(session.sessionId).ownerTag, "owner.stored");

    // A catalog that keeps no creation config: this process's record of the create is all there is.
    const legacy = fakeStore({ creationConfigs: false });
    const legacyClient = legacy.client();
    const kept = await legacyClient.createSession({ owner: USER, ownerTag: OWNER });
    await legacyClient._startTurn(kept.sessionId, "hello", { ownerTag: "owner.passed" });
    assert.equal(legacy.startOf(kept.sessionId).ownerTag, OWNER);
});

test("with the fast busy policy on, a client gives it only to the owner-routed top-level sessions it starts", async () => {
    const store = fakeStore();
    const creator = store.client();
    const routed = await creator.createSession({ owner: USER, ownerTag: OWNER });
    const portalSession = await creator.createSession({ owner: USER });
    // A system row with a saved tag, and a child of the routed tree created without the policy.
    await store.catalog.createSession("system-row", { isSystem: true, owner: USER, creationConfig: { ownerTag: OWNER } });
    const child = await creator.createSession({ parentSessionId: routed.sessionId, nestingLevel: 1, owner: USER, ownerTag: OWNER });

    const fast = store.client({ workspaceBusyFastRelease: true });
    for (const id of [routed.sessionId, portalSession.sessionId, "system-row", child.sessionId]) await fast._startTurn(id, "hello");
    assert.equal(store.startOf(routed.sessionId).workspaceBusyFastRelease, true);
    assert.ok(!("workspaceBusyFastRelease" in store.startOf(portalSession.sessionId)), "a Portal session keeps today's policy");
    assert.ok(!("workspaceBusyFastRelease" in store.startOf("system-row")) && !("ownerTag" in store.startOf("system-row")));
    assert.ok(!("workspaceBusyFastRelease" in store.startOf(child.sessionId)), "a child takes its turn's policy, not the client's");
    assert.equal(store.startOf(child.sessionId).ownerTag, OWNER);
});

test("the client saves the record of a delegated creation with the creation config and refuses a malformed one", async () => {
    const store = fakeStore();
    const client = store.client({ allowedAgentNames: ["builder"] });
    const created = await client.createSession({
        owner: USER, visibility: "private", ownerTag: OWNER,
        delegatedCreation: { dispatcher: { provider: ` ${DISPATCHER.provider} `, subject: DISPATCHER.subject, extra: "dropped" } },
    });
    assert.deepEqual(store.creation.get(created.sessionId).delegatedCreation, { dispatcher: DISPATCHER });
    assert.equal(store.creation.get(created.sessionId).ownerTag, OWNER);

    const forAgent = await client.createSessionForAgent("builder", { owner: USER, ownerTag: OWNER, delegatedCreation: { dispatcher: DISPATCHER } });
    assert.deepEqual(store.creation.get(forAgent.sessionId).delegatedCreation, { dispatcher: DISPATCHER });
    assert.equal(store.creation.get(forAgent.sessionId).ownerTag, OWNER);

    const plain = await client.createSession({ owner: USER });
    assert.ok(!("delegatedCreation" in store.creation.get(plain.sessionId)));
    for (const malformed of ["dispatcher", { dispatcher: { subject: "x" } }, { dispatcher: { provider: "entra", subject: " " } }]) {
        await assert.rejects(client.createSession({ owner: USER, delegatedCreation: malformed }), (error) => error.code === "INVALID_REQUEST");
    }
    assert.equal(store.rows.size, 3, "a refused creation writes no row");
});

test("getSessionDelegation reads the record of the session's tree root", async () => {
    const rows = {
        root: { sessionId: "root", rootSessionId: "root" },
        child: { sessionId: "child", parentSessionId: "root", rootSessionId: "root" },
        plain: { sessionId: "plain", rootSessionId: "plain" },
        "under-plain": { sessionId: "under-plain", parentSessionId: "plain", rootSessionId: "plain" },
        odd: { sessionId: "odd", rootSessionId: "odd" },
    };
    const configs = {
        root: { delegatedCreation: { dispatcher: DISPATCHER }, ownerTag: OWNER },
        // A child never carries the tree's record: only the root's counts.
        "under-plain": { delegatedCreation: { dispatcher: DISPATCHER } },
        odd: { delegatedCreation: { dispatcher: "someone" } },
    };
    const mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
    mgmt._catalog = {
        async getSession(sessionId) { return rows[sessionId] ?? null; },
        async getSessionCreationConfig(sessionId) { return configs[sessionId] ?? null; },
    };
    mgmt._started = true;
    assert.deepEqual(await mgmt.getSessionDelegation("root"), { rootSessionId: "root", dispatcher: DISPATCHER });
    assert.deepEqual(await mgmt.getSessionDelegation("child"), { rootSessionId: "root", dispatcher: DISPATCHER });
    for (const id of ["plain", "under-plain", "odd", "missing"]) assert.equal(await mgmt.getSessionDelegation(id), null, id);
});
