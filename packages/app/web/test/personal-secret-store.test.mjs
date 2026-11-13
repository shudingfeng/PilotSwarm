/**
 * External personal secrets in the portal: the composition hook that loads
 * the deployment's store (PILOTSWARM_PERSONAL_SECRET_STORE_MODULE), and the
 * provider RPCs that hand a personal GitHub token to it, keep only its
 * reference in the database, and delete the secret with the provider.
 *
 * The real management client and ProviderStore run over a pool that only
 * records queries, with an in-memory store, so nothing reaches a database
 * or a cloud service. The SDK's side is in
 * packages/sdk/test/unit/personal-secret-store.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ModelProviderRegistry, PilotSwarmManagementClient, ProviderStore } from "pilotswarm-sdk";
import { PortalRuntime } from "../runtime.js";
import { loadPersonalSecretStore } from "../personal-secret-store.js";

const TOKEN = `github_pat_${"x".repeat(82)}`;
const USER = { principal: { provider: "entra", subject: "carol-oid" }, authorization: { role: "user" } };
const ADMIN = { principal: { provider: "entra", subject: "admin-1" }, authorization: { role: "admin" } };

const TYPES = new ModelProviderRegistry({
    providers: [
        { id: "github-copilot", type: "github", models: [{ name: "claude-opus-5" }] },
        { id: "azure-openai", type: "openai", baseUrl: "https://models.example.invalid/v1", models: [{ name: "gpt-5.4" }] },
    ],
}, { keepUncredentialed: true });

function withEnv(t, settings) {
    const saved = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(settings)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

function memoryStore({ failPut = false } = {}) {
    const calls = [];
    let registrations = 0;
    return {
        calls,
        async put(secret) {
            calls.push(["put", secret]);
            if (failPut) throw new Error("vault unreachable");
            return { store: "memory", name: secret.previous?.name ?? `ghcp-${++registrations}`, version: `v${calls.length}`, expiresOn: null };
        },
        async delete(ref) { calls.push(["delete", ref]); },
        async describe() { return null; },
    };
}

const STORED = { kind: "externalSecret", store: "memory", name: "ghcp-1", version: "v1", expiresOn: null };

function portalWith(personalSecretStore) {
    const queries = [];
    const query = async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("cms_provider_user_id")) return { rows: [{ user_id: 7 }] };
        if (sql.includes("cms_provider_list")) {
            return { rows: [{ name: "carol-ghcp", type_id: "github-copilot", class: "personal", owner_user_id: 7 }] };
        }
        if (sql.includes("cms_provider_in_namespace")) {
            return { rows: [{ name: "carol-ghcp", type_id: "github-copilot", class: "personal", owner_user_id: 7, secret_ref: STORED }] };
        }
        if (sql.includes("cms_provider_delete")) return { rows: [{ waiting: 0 }] };
        return { rows: [{ name: params?.[0], type_id: "github-copilot", class: "personal" }] };
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local", personalSecretStore });
    assert.equal(runtime.transport.mgmt.config.personalSecretStore, personalSecretStore, "the store reaches the management client");
    const mgmt = Object.create(PilotSwarmManagementClient.prototype);
    mgmt._started = true;
    mgmt._modelProviders = TYPES;
    mgmt._catalog = { providers: new ProviderStore(pool, "ps", { personalSecretStore }), recordAuthzAudit: async () => {} };
    runtime.start = async () => {};
    runtime.transport = { mgmt };
    return { runtime, queries };
}

test("with external personal secrets, the portal saves a personal GitHub token in the store and only its reference in the database", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: "external", PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: undefined });
    const store = memoryStore();
    const { runtime, queries } = portalWith(store);

    const created = await runtime.call("createMyProvider", { name: "carol-ghcp", type: "github-copilot", credentials: { githubToken: TOKEN } }, USER);
    assert.equal(JSON.stringify(created).includes(TOKEN), false);
    assert.deepEqual(store.calls[0], ["put", {
        provider: "carol-ghcp", owner: { userId: 7, principal: { provider: "entra", subject: "carol-oid" } },
        token: TOKEN, expiresOn: null, previous: null,
    }]);

    await runtime.call("updateMyProviderCredential", { name: "carol-ghcp", credentials: { githubToken: TOKEN } }, USER);
    assert.deepEqual(store.calls[1][1].previous, STORED, "an update writes a new version of the provider's secret");

    await runtime.call("deleteMyProvider", { name: "carol-ghcp" }, USER);
    assert.deepEqual(store.calls[2], ["delete", STORED], "deleting the provider deletes the secret");

    assert.equal(JSON.stringify(queries).includes(TOKEN), false, "the token never reached the database");
});

test("the portal refuses a personal key of another type, and reports a store outage as such", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: "external" });
    const { runtime } = portalWith(memoryStore());
    await assert.rejects(runtime.call("createMyProvider", { name: "carol-openai", type: "azure-openai", credentials: { apiKey: "sk-test" } }, USER),
        (err) => err.code === "PROVIDER_INVALID" && err.status === 400 && /GitHub tokens only/.test(err.message));

    const unreachable = portalWith(memoryStore({ failPut: true }));
    await assert.rejects(unreachable.runtime.call("createMyProvider", { name: "carol-ghcp", type: "github-copilot", credentials: { githubToken: TOKEN } }, USER),
        (err) => {
            assert.equal(err.status, 503);
            assert.equal(err.expose, true, "its fixed message is shown");
            assert.match(err.message, /secret store did not store the token, so nothing was saved/);
            return true;
        });
});

test("with external personal secrets, the legacy personal key RPC refuses a key; the System key keeps today's rule", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: "external", PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: undefined });
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = {
        setCurrentUserGitHubCopilotKey: async ({ key }) => { calls.push(["user", key]); return {}; },
        setSystemGitHubCopilotKey: async ({ key }) => { calls.push(["system", key]); return {}; },
    };
    await assert.rejects(runtime.call("setCurrentUserGitHubCopilotKey", { key: TOKEN }, USER), (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /keeps personal GitHub tokens only in its secret store/);
        assert.equal(err.message.includes(TOKEN), false);
        return true;
    });
    await runtime.call("setCurrentUserGitHubCopilotKey", { key: null }, USER);
    await runtime.call("setSystemGitHubCopilotKey", { key: TOKEN }, ADMIN);
    assert.deepEqual(calls, [["user", null], ["system", TOKEN]]);
});

test("malformed settings stop the portal at startup", async (t) => {
    for (const [name, value, pattern] of [
        ["PILOTSWARM_PERSONAL_SECRETS", "vault", /PILOTSWARM_PERSONAL_SECRETS must be database or external/],
        ["PILOTSWARM_REDACT_SECRET_PREFIXES", "x", /PILOTSWARM_REDACT_SECRET_PREFIXES/],
    ]) {
        withEnv(t, { [name]: value });
        assert.throws(() => new PortalRuntime({ store: "sqlite::memory:", mode: "local" }), pattern);
        delete process.env[name];
    }
});

// ── the composition hook ─────────────────────────────────────────

test("the hook loads nothing by default, and external mode needs a store module", async () => {
    assert.equal(await loadPersonalSecretStore({}), null);
    await assert.rejects(loadPersonalSecretStore({ PILOTSWARM_PERSONAL_SECRETS: "external" }),
        /PILOTSWARM_PERSONAL_SECRETS=external needs PILOTSWARM_PERSONAL_SECRET_STORE_MODULE/);
});

test("the hook loads a store from a factory, an object or the module's own exports, and refuses an incomplete one", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-secret-store-module-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const methods = "async put() { return { store: 'm', name: 'n', version: '1' }; }, async delete() {}, async describe() { return null; }";
    const modules = {
        "factory.mjs": `export async function createPersonalSecretStore({ env }) { return { region: env.STORE_REGION, ${methods} }; }`,
        "object.mjs": `export default { ${methods} };`,
        "exports.mjs": "export async function put() {} export async function delete_() {} export { delete_ as delete }; export async function describe() {}",
        "incomplete.mjs": "export default { async put() {}, async delete() {} };",
    };
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(root, name), source);
    const env = (name) => ({ PILOTSWARM_PERSONAL_SECRETS: "external", PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: join(root, name), STORE_REGION: "west" });

    assert.equal((await loadPersonalSecretStore(env("factory.mjs"))).region, "west", "the factory gets the environment");
    assert.equal(typeof (await loadPersonalSecretStore(env("object.mjs"))).describe, "function");
    assert.equal(typeof (await loadPersonalSecretStore(env("exports.mjs"))).delete, "function");
    await assert.rejects(loadPersonalSecretStore(env("incomplete.mjs")),
        /PILOTSWARM_PERSONAL_SECRET_STORE_MODULE \(.*incomplete\.mjs\) must implement put, delete and describe; it lacks describe/);

    // A database-mode portal still loads a configured store, to delete the keys it holds.
    assert.ok(await loadPersonalSecretStore({ PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: join(root, "object.mjs") }));

    const imported = [];
    const importModule = async (specifier) => { imported.push(specifier); return { default: memoryStore() }; };
    await loadPersonalSecretStore({ PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: "@example/secret-store" }, { importModule });
    await loadPersonalSecretStore({ PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: join(root, "object.mjs") }, { importModule });
    assert.deepEqual(imported, ["@example/secret-store", pathToFileURL(join(root, "object.mjs")).href]);
});

test("the portal does not start in external mode without a store module", async (t) => {
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: "external", PILOTSWARM_PERSONAL_SECRET_STORE_MODULE: undefined });
    const { startServer } = await import("../server.js");
    await assert.rejects(startServer({ port: 0 }), /needs PILOTSWARM_PERSONAL_SECRET_STORE_MODULE/);
});
