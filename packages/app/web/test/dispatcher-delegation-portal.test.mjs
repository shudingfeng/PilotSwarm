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
 * `dispatcher` persona named by DISPATCHER_SP_OBJECT_ID and ownership
 * enforced. No workers run: sessions stay pending, which is all the opt-in,
 * creation, revocation and forced delete need.
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

async function bootServer({ dispatcher }) {
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

before(async () => {
    if (!pgAvailable) return;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-delegation-"));
    await bootServer({ dispatcher: "dispatcher" });
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

test("with DISPATCHER_SP_OBJECT_ID unset nothing is delegated, and the stored opt-in stays", { skip: SKIP }, async () => {
    await stopServer();
    await bootServer({ dispatcher: undefined });
    assert.deepEqual(await ok("alice", "GET", "/me/dispatcher-delegation"), { enabled: true, dispatcherConfigured: false });
    assert.deepEqual(await refused("dispatcher", "POST", "/sessions", delegated), [403, "FORBIDDEN"]);
});
