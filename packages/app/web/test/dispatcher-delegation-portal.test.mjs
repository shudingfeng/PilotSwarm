import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Dispatcher delegation over the real HTTP stack: an in-process portal
 * against local Postgres, dev-auth personas via `Bearer dev:<name>`, with the
 * `dispatcher` persona named by DISPATCHER_SP_OBJECT_ID, ownership enforced
 * and PILOTSWARM_OWNER_ROUTING=1. No workers run: sessions stay pending,
 * which is all the opt-in, creation, sharing, revocation and forced delete
 * need.
 */

const DATABASE_URL =
    process.env.PS_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const runId = crypto.randomBytes(4).toString("hex");
const SCHEMAS = [`wt_deleg_cms_${runId}`, `wt_deleg_dx_${runId}`, `wt_deleg_facts_${runId}`];

const pgAvailable = await (async () => {
    const probe = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
    try {
        await probe.connect();
        await probe.end();
        return true;
    } catch {
        await probe.end().catch(() => {});
        return false;
    }
})();

const SKIP = pgAvailable ? false : `local Postgres not reachable at ${DATABASE_URL}`;

let server = null;
let baseUrl = "";
let stateDir = null;
const savedEnv = {};

function setEnv(values) {
    for (const [key, value] of Object.entries(values)) {
        if (!(key in savedEnv)) savedEnv[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

async function bootServer({ dispatcher, ownerRouting = false }) {
    setEnv({
        DATABASE_URL,
        PILOTSWARM_CMS_SCHEMA: SCHEMAS[0],
        PILOTSWARM_DUROXIDE_SCHEMA: SCHEMAS[1],
        PILOTSWARM_FACTS_SCHEMA: SCHEMAS[2],
        SESSION_STATE_DIR: stateDir,
        WORKERS: "0",
        PORTAL_TUI_MODE: "local",
        PORTAL_AUTH_PROVIDER: "dev",
        PORTAL_AUTH_DEV_ALLOW: "true",
        PORTAL_AUTH_DEV_USERS: "ada:admin,alice:user,bob:user,dispatcher:user",
        AUTHZ_ENFORCE_OWNERSHIP: "true",
        DISPATCHER_SP_OBJECT_ID: dispatcher,
        PILOTSWARM_OWNER_ROUTING: ownerRouting ? "1" : undefined,
        PS_MODEL_PROVIDERS_PATH: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../sdk/test/fixtures/model-providers.test.json"),
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || "dummy-delegation-test-token",
    });
    const { startServer } = await import("../server.js");
    server = await startServer({ port: 0 });
    baseUrl = `http://localhost:${server.address().port}`;
}

async function stopServer() {
    if (server?.stopPortal) await server.stopPortal();
    server = null;
}

async function api(persona, method, apiPath, body) {
    const response = await fetch(`${baseUrl}/api/v1${apiPath}`, {
        method,
        headers: { authorization: `Bearer dev:${persona}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
}

async function ok(persona, method, apiPath, body) {
    const { status, payload } = await api(persona, method, apiPath, body);
    assert.equal(status, 200, `${method} ${apiPath} as ${persona}: ${JSON.stringify(payload)}`);
    return payload.result;
}

async function refused(persona, method, apiPath, body) {
    const { status, payload } = await api(persona, method, apiPath, body);
    return [status, payload.error?.code];
}

/** The legacy /api/rpc dispatcher, which hands the runtime every parameter it is sent. */
async function rpc(persona, method, params) {
    const response = await fetch(`${baseUrl}/api/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer dev:${persona}`, "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `${method} over /api/rpc as ${persona}: ${JSON.stringify(payload)}`);
    return payload.result;
}

/** A session's creation config as the catalog row keeps it. */
async function creationConfig(id) {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
        const { rows } = await pool.query(`SELECT creation_config FROM "${SCHEMAS[0]}".sessions WHERE session_id = $1`, [id]);
        return rows[0]?.creation_config ?? null;
    } finally {
        await pool.end();
    }
}

before(async () => {
    if (!pgAvailable) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-delegation-"));
    await bootServer({ dispatcher: "dispatcher", ownerRouting: true });
});

after(async () => {
    await stopServer();
    if (pgAvailable) {
        const pool = new pg.Pool({ connectionString: DATABASE_URL });
        try {
            for (const schema of SCHEMAS) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
            await pool.end();
        }
    }
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    setEnv(savedEnv);
});

let sessionId = null;
const delegated = { onBehalfOfOwner: { subject: "alice" } };

test("the opt-in starts off, and only the caller's own changes", { skip: SKIP }, async () => {
    assert.deepEqual(await ok("alice", "GET", "/me/dispatcher-delegation"), { enabled: false, dispatcherConfigured: true });
    assert.deepEqual(await refused("dispatcher", "POST", "/sessions", delegated), [403, "DELEGATION_REVOKED"]);
    assert.deepEqual(await ok("alice", "PUT", "/me/dispatcher-delegation", { enabled: true }), { enabled: true, dispatcherConfigured: true });
    assert.equal((await ok("bob", "GET", "/me/dispatcher-delegation")).enabled, false);
});

test("only the dispatcher may create on behalf of an owner", { skip: SKIP }, async () => {
    assert.deepEqual(await refused("bob", "POST", "/sessions", delegated), [403, "FORBIDDEN"]);
    assert.deepEqual(await refused("ada", "POST", "/sessions", delegated), [403, "FORBIDDEN"]);
    assert.deepEqual(await refused("dispatcher", "POST", "/sessions", { onBehalfOfOwner: { subject: "bob" } }), [403, "DELEGATION_REVOKED"]);
    sessionId = (await ok("dispatcher", "POST", "/sessions", delegated)).sessionId;
    assert.ok(sessionId);
});

test("the owner holds a private session whose only share is the dispatcher's write share", { skip: SKIP }, async () => {
    const access = await ok("alice", "GET", `/sessions/${sessionId}/access`);
    assert.deepEqual([access.relation, access.visibility, access.owner.subject], ["owner", "private", "alice"]);
    const shares = await ok("alice", "GET", `/sessions/${sessionId}/shares`);
    assert.deepEqual(shares.map((share) => [share.subject, share.access]), [["dispatcher", "write"]]);
    assert.equal((await ok("dispatcher", "GET", `/sessions/${sessionId}`)).sessionId, sessionId);
    assert.deepEqual(await refused("bob", "GET", `/sessions/${sessionId}`), [404, "NOT_FOUND"]);
    assert.ok((await ok("dispatcher", "GET", "/sessions")).some((row) => row.sessionId === sessionId));
});

test("the creation config records the delegated creation and, with PILOTSWARM_OWNER_ROUTING=1, the owner's tag", { skip: SKIP }, async () => {
    const config = await creationConfig(sessionId);
    assert.equal(config.ownerTag, "owner.alice");
    assert.deepEqual(config.delegatedCreation, { dispatcher: { provider: "dev", subject: "dispatcher" } });
});

test("request parameters set neither the owner tag nor the delegation record, on /api/v1 or /api/rpc", { skip: SKIP }, async () => {
    const forged = { ownerTag: "owner.carol", delegatedCreation: { dispatcher: { provider: "dev", subject: "bob" } }, workspaceBusyFastRelease: true };
    const viaV1 = (await ok("bob", "POST", "/sessions", forged)).sessionId;
    const viaRpc = (await rpc("bob", "createSession", forged)).sessionId;
    for (const id of [viaV1, viaRpc]) {
        const config = await creationConfig(id);
        assert.ok(!config || (!("ownerTag" in config) && !("delegatedCreation" in config) && !("workspaceBusyFastRelease" in config)), JSON.stringify(config));
    }
    const delegatedId = (await rpc("dispatcher", "createSession", { ...forged, onBehalfOfOwner: { subject: "alice" } })).sessionId;
    const config = await creationConfig(delegatedId);
    assert.equal(config.ownerTag, "owner.alice");
    assert.deepEqual(config.delegatedCreation, { dispatcher: { provider: "dev", subject: "dispatcher" } });
    assert.ok(!("workspaceBusyFastRelease" in config));
    await ok("alice", "DELETE", `/sessions/${delegatedId}?force=true&settleTimeoutMs=0`);
});

test("createSessionForWorkflow refuses onBehalfOfOwner on /api/v1 too, before looking for the Workflow", { skip: SKIP }, async () => {
    const { status, payload } = await api("dispatcher", "POST", "/sessions/for-workflow", { ref: "tools/review", onBehalfOfOwner: { subject: "alice" } });
    assert.deepEqual([status, payload.error?.code], [400, "INVALID_REQUEST"]);
    assert.match(payload.error?.message ?? "", /does not take onBehalfOfOwner/);
});

test("the delegated session is shared for reading only, by its owner and by an admin", { skip: SKIP }, async () => {
    for (const persona of ["alice", "ada"]) {
        assert.deepEqual(await refused(persona, "POST", `/sessions/${sessionId}/shares`, { user: { provider: "dev", subject: "bob" }, access: "write" }),
            [403, "DELEGATED_SESSION_READ_ONLY"], persona);
        assert.deepEqual(await refused(persona, "PUT", `/sessions/${sessionId}/visibility`, { visibility: "shared_write" }),
            [403, "DELEGATED_SESSION_READ_ONLY"], persona);
    }
    await ok("alice", "POST", `/sessions/${sessionId}/shares`, { user: { provider: "dev", subject: "bob" }, access: "read" });
    await ok("alice", "PUT", `/sessions/${sessionId}/visibility`, { visibility: "shared_read" });
    assert.equal((await ok("bob", "GET", `/sessions/${sessionId}`)).sessionId, sessionId, "a reader");
    const shares = await ok("alice", "GET", `/sessions/${sessionId}/shares`);
    assert.deepEqual(shares.map((share) => [share.subject, share.access]).sort(), [["bob", "read"], ["dispatcher", "write"]]);
    const audit = await ok("ada", "GET", `/management/authz-audit?sessionId=${encodeURIComponent(sessionId)}&limit=50`);
    const denied = audit.filter((entry) => entry.decision === "deny" && entry.details?.code === "DELEGATED_SESSION_READ_ONLY");
    assert.deepEqual(denied.map((entry) => entry.action).sort(),
        ["grantSessionShare", "grantSessionShare", "setSessionVisibility", "setSessionVisibility"]);

    // An undelegated session shares for writing as before.
    const own = (await ok("alice", "POST", "/sessions", {})).sessionId;
    await ok("alice", "POST", `/sessions/${own}/shares`, { user: { provider: "dev", subject: "bob" }, access: "write" });
    await ok("alice", "PUT", `/sessions/${own}/visibility`, { visibility: "shared_write" });

    // Back to the dispatcher's share alone, for the tests below.
    await ok("alice", "POST", `/sessions/${sessionId}/shares/revoke`, { user: { provider: "dev", subject: "bob" } });
    await ok("alice", "PUT", `/sessions/${sessionId}/visibility`, { visibility: "private" });
});

test("turning the opt-in off refuses the dispatcher at once and keeps its share; on restores it", { skip: SKIP }, async () => {
    await ok("alice", "PUT", "/me/dispatcher-delegation", { enabled: false });
    assert.deepEqual(await refused("dispatcher", "GET", `/sessions/${sessionId}`), [403, "DELEGATION_REVOKED"]);
    assert.deepEqual(await refused("dispatcher", "DELETE", `/sessions/${sessionId}?force=true&settleTimeoutMs=0`), [403, "DELEGATION_REVOKED"]);
    assert.equal((await ok("dispatcher", "GET", "/sessions")).some((row) => row.sessionId === sessionId), false);
    const page = await ok("dispatcher", "GET", "/management/sessions?limit=50");
    assert.equal(page.sessions.some((row) => row.sessionId === sessionId), false);
    assert.deepEqual((await ok("alice", "GET", `/sessions/${sessionId}/shares`)).map((share) => share.subject), ["dispatcher"]);

    await ok("alice", "PUT", "/me/dispatcher-delegation", { enabled: true });
    assert.equal((await ok("dispatcher", "GET", `/sessions/${sessionId}`)).sessionId, sessionId);
});

test("the delegated dispatcher ends the work with a forced delete, audited", { skip: SKIP }, async () => {
    assert.deepEqual(await refused("bob", "DELETE", `/sessions/${sessionId}?force=true&settleTimeoutMs=0`), [404, "NOT_FOUND"]);
    await ok("dispatcher", "DELETE", `/sessions/${sessionId}?reason=work%20ended&force=true&settleTimeoutMs=0`);
    assert.deepEqual(await refused("alice", "GET", `/sessions/${sessionId}`), [404, "NOT_FOUND"]);

    const audit = await ok("ada", "GET", `/management/authz-audit?sessionId=${encodeURIComponent(sessionId)}&limit=50`);
    const delegatedEntries = audit.filter((entry) => entry.decision === "delegated");
    assert.deepEqual(delegatedEntries.map((entry) => entry.action).sort(), ["createSession", "deleteSession"]);
    const deletion = delegatedEntries.find((entry) => entry.action === "deleteSession");
    assert.deepEqual([deletion.actorSubject, deletion.target, deletion.details.force, deletion.details.settleTimeoutMs],
        ["dispatcher", "dev/alice", true, 0]);
});

test("with DISPATCHER_SP_OBJECT_ID unset nothing is delegated, onBehalfOfOwner is ignored, and the stored opt-in stays", { skip: SKIP }, async () => {
    await stopServer();
    await bootServer({ dispatcher: undefined, ownerRouting: true });
    assert.deepEqual(await ok("alice", "GET", "/me/dispatcher-delegation"), { enabled: true, dispatcherConfigured: false });
    // As before the parameter existed: the caller's own session, with no record and no tag.
    const own = (await ok("dispatcher", "POST", "/sessions", delegated)).sessionId;
    const access = await ok("dispatcher", "GET", `/sessions/${own}/access`);
    assert.deepEqual([access.relation, access.owner.subject], ["owner", "dispatcher"]);
    const config = await creationConfig(own);
    assert.ok(!config || (!("delegatedCreation" in config) && !("ownerTag" in config)), JSON.stringify(config));
    assert.deepEqual(await refused("alice", "GET", `/sessions/${own}`), [404, "NOT_FOUND"]);
    // The Workflow route looks for the Workflow instead of refusing the parameter.
    assert.deepEqual(await refused("dispatcher", "POST", "/sessions/for-workflow", { ref: "tools/review", ...delegated }), [404, "PACKAGE_WORKFLOW_NOT_FOUND"]);
});
