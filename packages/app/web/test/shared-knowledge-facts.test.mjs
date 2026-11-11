// With PILOTSWARM_SESSION_MESSAGE_SCOPE=owner, the portal keeps non-admins out
// of the shared facts under the Facts Manager's prefixes (skills/, asks/,
// config/facts-manager/): every session's prompt reads them. Unset, the
// portal's facts writes behave as before.
import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

const user = { principal: { provider: "dev", subject: "user-0001", displayName: "Example User" }, authorization: { role: "user" } };
const admin = { principal: { provider: "dev", subject: "admin-0001", displayName: "Example Admin" }, authorization: { role: "admin" } };

function portal(scope) {
    const saved = process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE;
    if (scope === undefined) delete process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE;
    else process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE = scope;
    let runtime;
    try {
        runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    } finally {
        if (saved === undefined) delete process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE;
        else process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE = saved;
    }
    const writes = [];
    const audits = [];
    runtime.start = async () => {};
    runtime.transport = {
        storeFact: async (input) => { writes.push(["storeFact", input]); return { stored: true }; },
        deleteFactRecord: async (input) => { writes.push(["deleteFact", input]); return { deleted: true }; },
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        // The caller owns every session it names.
        getSessionAccess: async (sessionId) => ({
            rootSessionId: sessionId, isSystem: false, visibility: "private",
            owner: user.principal, viewerIsOwner: true, viewerShareAccess: null,
        }),
    };
    return { runtime, writes, audits };
}

const RESERVED_KEYS = ["skills/release/checklist", "asks/release/owner", "config/facts-manager/skill-ttl"];

// Every shared write or delete here can reach a key under a reserved prefix.
const REFUSED = [
    ...RESERVED_KEYS.map((key) => ["storeFact", { key, value: { text: "x" }, shared: true }]),
    // A shared flag wins over a session id in the store, so this is still a shared write.
    ["storeFact", { key: "skills/release/checklist", value: 1, shared: true, sessionId: "session-0001" }],
    ["storeFact", [{ key: "notes/release", value: 1, shared: true }, { key: "asks/release/owner", value: 2, shared: true }]],
    ...RESERVED_KEYS.map((key) => ["deleteFact", { key, shared: true }]),
    ...["%", "*", "s%", "skills/*", "as%", "config/%", "config/facts-manager/%", "sk_lls/%", "sk\\ills/%"]
        .map((key) => ["deleteFact", { key, pattern: true, scope: "shared" }]),
    // A pattern delete with shared: true and no scope defaults to shared scope.
    ["deleteFact", { key: "%", pattern: true, shared: true }],
];

// Facts that no session's prompt reads from the reserved namespaces.
const ALLOWED = [
    ["storeFact", { key: "notes/release", value: 1, shared: true }],
    ["storeFact", { key: "intake/release/session-0001", value: 1, shared: true }],
    ["deleteFact", { key: "notes/release", shared: true }],
    ["deleteFact", { key: "notes/%", pattern: true, scope: "shared" }],
    ["deleteFact", { key: "intake/*", pattern: true, scope: "shared" }],
    // Session-scoped facts under the same prefixes are the session's own.
    ["storeFact", { key: "skills/draft", value: 1, sessionId: "session-0001" }],
    ["deleteFact", { key: "%", pattern: true, scope: "session", sessionId: "session-0001" }],
];

const label = (method, input) => `${method} ${JSON.stringify(input)}`;

for (const [method, input] of REFUSED) {
    test(`owner scope refuses a non-admin's ${label(method, input)}`, async () => {
        const { runtime, writes, audits } = portal("owner");
        await assert.rejects(runtime.call(method, { input }, user), (error) => {
            assert.equal(error.status, 403);
            assert.equal(error.code, "FORBIDDEN");
            assert.match(error.message, /^Only an administrator can store or delete shared facts under '(skills|asks|config\/facts-manager)\/'\.$/);
            return true;
        });
        assert.deepEqual(writes, [], "nothing reached the fact store");
        assert.equal(audits.length, 1);
        assert.equal(audits[0].decision, "deny");
        assert.equal(audits[0].action, method);
        assert.equal(audits[0].actor.subject, "user-0001");
    });
}

for (const [method, input] of ALLOWED) {
    test(`owner scope still accepts a non-admin's ${label(method, input)}`, async () => {
        const { runtime, writes } = portal("owner");
        await runtime.call(method, { input }, user);
        assert.deepEqual(writes, [[method, input]]);
    });
}

test("owner scope still accepts an administrator's writes and deletes under the reserved prefixes", async () => {
    const { runtime, writes } = portal("owner");
    for (const [method, input] of REFUSED) await runtime.call(method, { input }, admin);
    assert.deepEqual(writes, REFUSED);
});

for (const scope of [undefined, "fleet"]) {
    test(`${scope ?? "unset"} scope keeps today's behavior: a non-admin's shared writes and deletes go through`, async () => {
        const { runtime, writes, audits } = portal(scope);
        for (const [method, input] of REFUSED) await runtime.call(method, { input }, user);
        assert.deepEqual(writes, REFUSED);
        assert.deepEqual(audits, []);
    });
}

test("the portal refuses to start with an unknown PILOTSWARM_SESSION_MESSAGE_SCOPE", () => {
    assert.throws(() => portal("everyone"), /PILOTSWARM_SESSION_MESSAGE_SCOPE must be fleet or owner/);
});
