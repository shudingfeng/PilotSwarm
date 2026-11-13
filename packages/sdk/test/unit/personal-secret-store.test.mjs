/**
 * External personal secrets (PILOTSWARM_PERSONAL_SECRETS=external): a
 * personal GitHub provider's token goes to the deployment's secret store,
 * and its row keeps only the store's reference. The provider catalog lists
 * and selects such a provider without its token, and only the portal saves
 * one: the agent's manage_provider tool refuses.
 *
 * The real ProviderStore runs over a pool that only records queries, with an
 * in-memory secret store and a stand-in for GitHub's API, so nothing reaches
 * a database, a cloud service or the network. The worker's per-turn
 * resolution is in personal-credential-resolver.test.mjs.
 *
 * Run: node --test test/unit/personal-secret-store.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ProviderStore, normalizeCallerSecret } from "../../dist/provider-store.js";
import { createProviderTools } from "../../dist/provider-tools.js";
import { assertPersonalSecretStore, personalSecretsMode } from "../../dist/personal-secret-store.js";
import { buildRuntimeRegistry, resolveRuntimeModelSelection } from "../../dist/provider-catalog.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../../dist/index.js";

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = `github_pat_${"x".repeat(82)}`;
const OLD_TOKEN = `github_pat_${"o".repeat(82)}`;
const CLASSIC = `ghp_${"x".repeat(36)}`;
const EXPIRY = "2026-11-20T12:00:00.000Z";
const OWNER = { provider: "entra", subject: "carol-oid" };

const TYPES = new ModelProviderRegistry({
    providers: [
        { id: "github-copilot", type: "github", models: [{ name: "claude-opus-5" }, { name: "gpt-6-astra" }] },
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

const external = (t, extra = {}) => withEnv(t, {
    PILOTSWARM_PERSONAL_SECRETS: "external", PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: undefined, ...extra,
});

/** A public-only token that expires at EXPIRY and holds none of the refused permissions. */
function fakeGitHub({ visibility = "public" } = {}) {
    const requests = [];
    const fetch = async (url) => {
        requests.push(url);
        if (new URL(url).pathname === "/user/repos") {
            return Response.json([{ visibility }], {
                headers: { "GitHub-Authentication-Token-Expiration": EXPIRY.replace("T", " ").replace(".000Z", " UTC") },
            });
        }
        return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
    };
    return { fetch, requests };
}

/** An in-memory secret store: a new secret per registration, a new version per update. */
function fakeSecretStore({ failPut = false, failDelete = false } = {}) {
    const secrets = new Map();
    const calls = [];
    let registrations = 0;
    return {
        secrets,
        calls,
        async put(secret) {
            calls.push(["put", secret]);
            if (failPut) throw new Error(`store unreachable while saving ${secret.token}`);
            const name = secret.previous?.name ?? `ghcp-${secret.owner.userId}-${++registrations}`;
            const versions = secrets.get(name) ?? [];
            versions.push(secret.token);
            secrets.set(name, versions);
            return { store: "fake-store", name, version: `v${versions.length}`, expiresOn: secret.expiresOn };
        },
        async delete(ref) {
            calls.push(["delete", ref]);
            if (failDelete) throw new Error("store unreachable");
            secrets.delete(ref.name);
        },
        async describe(ref) {
            calls.push(["describe", ref]);
            return secrets.has(ref.name) ? { enabled: true, expiresOn: null } : null;
        },
    };
}

const reference = (name, version, expiresOn = EXPIRY) => ({ kind: "externalSecret", store: "fake-store", name, version, expiresOn });

/** A pool that records every query and answers by procedure name; `connect` shares the log. */
function fakePool(answers = {}) {
    const queries = [];
    const query = async (sql, params) => {
        const text = typeof sql === "string" ? sql : sql.text;
        queries.push({ sql: text, params: typeof sql === "string" ? params : sql.values });
        const fn = Object.keys(answers).find((name) => text.includes(name));
        const answer = fn ? answers[fn] : [];
        if (answer instanceof Error) throw answer;
        return { rows: typeof answer === "function" ? answer(params) : answer };
    };
    return {
        queries,
        query,
        connect: async () => ({ query, release: () => queries.push({ sql: "RELEASE" }) }),
        writes: () => queries.filter(({ sql }) => /cms_provider_(create|update_personal_credential|update_shared_credential)/.test(sql)),
        statements: () => queries.map(({ sql }) => /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(sql) ? sql : sql.match(/cms_provider_\w+/)?.[0] ?? sql),
    };
}

const STORED_ROW = (secretRef) => ({
    name: "carol-ghcp", type_id: "github-copilot", class: "personal", owner_user_id: 7, base_url: null, secret_ref: secretRef,
});

function storeOver({ secretStore = fakeSecretStore(), github = fakeGitHub(), answers = {} } = {}) {
    const pool = fakePool({
        cms_provider_create: [{ name: "carol-ghcp", type_id: "github-copilot", class: "personal" }],
        cms_provider_update_personal_credential: [{ name: "carol-ghcp", type_id: "github-copilot", class: "personal" }],
        cms_provider_delete: [{ waiting: 0 }],
        ...answers,
    });
    const store = new ProviderStore(pool, "ps", { personalSecretStore: secretStore, gitHubTokenCheck: { fetch: github.fetch } });
    return { pool, store, secretStore, github };
}

const PERSONAL = { gitHubType: true, owner: OWNER };
const create = (store, secretRef, extra = {}) => store.createProvider({
    name: "carol-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, secretRef, ...PERSONAL, ...extra,
}, 7, false);

/** No query parameter anywhere holds the token. */
function assertTokenNotInDatabase(pool, token = TOKEN) {
    assert.equal(JSON.stringify(pool.queries).includes(token), false, "the token reached PostgreSQL");
}

// ── the setting and the caller's credential ─────────────────────

test("personal credentials stay in the database unless the setting says external; a typo is refused", () => {
    for (const value of [undefined, "", "database", " Database "]) {
        assert.equal(personalSecretsMode(value === undefined ? {} : { PILOTSWARM_PERSONAL_SECRETS: value }), "database");
    }
    assert.equal(personalSecretsMode({ PILOTSWARM_PERSONAL_SECRETS: " EXTERNAL " }), "external");
    assert.throws(() => personalSecretsMode({ PILOTSWARM_PERSONAL_SECRETS: "vault" }), /PILOTSWARM_PERSONAL_SECRETS must be database or external/);
});

test("a caller cannot send a reference to an external secret, in either mode", async (t) => {
    for (const secret of [
        { kind: "externalSecret", store: "fake-store", name: "ghcp-8-1", version: "v1" },
        { kind: " ExternalSecret ", value: TOKEN },
    ]) {
        assert.throws(() => normalizeCallerSecret(secret), (err) => err.code === "PROVIDER_INVALID" && /reference to a secret store/.test(err.message));
    }
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: undefined });
    for (const mode of ["database", "external"]) {
        process.env.PILOTSWARM_PERSONAL_SECRETS = mode;
        const { pool, store, secretStore } = storeOver();
        await assert.rejects(create(store, { kind: "externalSecret", store: "fake-store", name: "ghcp-8-1", version: "v1" }),
            (err) => err.code === "PROVIDER_INVALID");
        assert.deepEqual(pool.writes(), []);
        assert.deepEqual(secretStore.calls, []);
    }
});

// ── the store, in external mode ──────────────────────────────────

test("a new personal GitHub provider keeps its token in the secret store and only the reference in PostgreSQL", async (t) => {
    external(t, { PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: "1" });
    const { pool, store, secretStore, github } = storeOver();
    await create(store, { githubToken: TOKEN }, { requireFineGrainedGitHubToken: true });

    assert.equal(github.requests.length, 6, "the fine-grained token gate checked it first");
    assert.deepEqual(secretStore.calls, [["put", {
        provider: "carol-ghcp", owner: { userId: 7, principal: OWNER }, token: TOKEN, expiresOn: EXPIRY, previous: null,
    }]]);
    assert.equal(pool.writes().length, 1);
    assert.deepEqual(JSON.parse(pool.writes()[0].params[4]), reference("ghcp-7-1", "v1"), "secret_ref is the reference alone");
    assertTokenNotInDatabase(pool);
});

test("an update writes a new version of the same secret, and only its reference", async (t) => {
    external(t);
    const { pool, store, secretStore } = storeOver({
        answers: { cms_provider_in_namespace: [STORED_ROW(reference("ghcp-7-1", "v1"))] },
    });
    secretStore.secrets.set("ghcp-7-1", [OLD_TOKEN]);
    await store.updatePersonalCredential("carol-ghcp", { githubToken: TOKEN }, 7, PERSONAL);

    assert.deepEqual(secretStore.calls.map(([call, arg]) => [call, arg.previous ?? arg]), [["put", reference("ghcp-7-1", "v1")]]);
    assert.deepEqual(JSON.parse(pool.writes()[0].params[1]), reference("ghcp-7-1", "v2", null));
    assert.deepEqual(secretStore.secrets.get("ghcp-7-1"), [OLD_TOKEN, TOKEN], "the earlier version stays until the store removes it");
    assertTokenNotInDatabase(pool);
});

test("updating a key saved before external mode moves it to the store, and the row keeps no value", async (t) => {
    external(t);
    const { pool, store, secretStore } = storeOver({
        answers: { cms_provider_in_namespace: [STORED_ROW({ kind: "githubToken", value: OLD_TOKEN })] },
    });
    await store.updatePersonalCredential("carol-ghcp", { githubToken: TOKEN }, 7, PERSONAL);
    assert.equal(secretStore.calls[0][1].previous, null, "a new secret, not a version of the database value");
    const written = JSON.parse(pool.writes()[0].params[1]);
    assert.deepEqual(Object.keys(written).sort(), ["expiresOn", "kind", "name", "store", "version"]);
    assert.equal(pool.writes().some(({ params }) => JSON.stringify(params).includes(OLD_TOKEN)), false);
});

test("an update of another person's or a shared provider stores nothing", async (t) => {
    external(t);
    for (const row of [null, { ...STORED_ROW(reference("ghcp-8-1", "v1")), owner_user_id: 8 }, { ...STORED_ROW({ kind: "githubToken", value: OLD_TOKEN }), class: "shared", owner_user_id: null }]) {
        const { pool, store, secretStore } = storeOver({ answers: { cms_provider_in_namespace: row ? [row] : [] } });
        await assert.rejects(store.updatePersonalCredential("carol-ghcp", { githubToken: TOKEN }, 7, PERSONAL),
            (err) => err.code === "PROVIDER_NOT_FOUND");
        assert.deepEqual(secretStore.calls, []);
        assert.deepEqual(pool.writes(), []);
    }
});

test("the token gates still apply before anything is stored", async (t) => {
    external(t, { PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT: "1" });
    const classic = storeOver();
    await assert.rejects(create(classic.store, { apiKey: CLASSIC }, { requireFineGrainedGitHubToken: true }),
        (err) => err.code === "PROVIDER_INVALID" && /classic personal access token/.test(err.message));
    const internal = storeOver({ github: fakeGitHub({ visibility: "internal" }) });
    await assert.rejects(create(internal.store, { githubToken: TOKEN }, { requireFineGrainedGitHubToken: true }), /not public/);
    for (const { pool, secretStore } of [classic, internal]) {
        assert.deepEqual(secretStore.calls, []);
        assert.deepEqual(pool.writes(), []);
    }
});

test("the secret store holds GitHub tokens only", async (t) => {
    external(t);
    const { pool, store, secretStore } = storeOver();
    await assert.rejects(store.createProvider({
        name: "carol-openai", typeId: "azure-openai", class: "personal", ownerUserId: 7, secretRef: { apiKey: "sk-test" }, gitHubType: false, owner: OWNER,
    }, 7, false), (err) => err.code === "PROVIDER_INVALID" && /GitHub tokens only/.test(err.message));
    assert.deepEqual(secretStore.calls, []);
    assert.deepEqual(pool.writes(), []);
});

test("a store that cannot save the token saves nothing, and its error never repeats the token", async (t) => {
    external(t);
    const { pool, store } = storeOver({ secretStore: fakeSecretStore({ failPut: true }) });
    await assert.rejects(create(store, { githubToken: TOKEN }), (err) => {
        assert.equal(err.code, "PROVIDER_SECRET_STORE_UNAVAILABLE");
        assert.equal(err.message.includes(TOKEN), false);
        return true;
    });
    assert.deepEqual(pool.writes(), []);
});

test("a row the database refuses takes its new secret back out of the store", async (t) => {
    external(t);
    const { store, secretStore } = storeOver({
        answers: { cms_provider_create: new Error('PROVIDER_CONFLICT: the name "carol-ghcp" is already taken') },
    });
    await assert.rejects(create(store, { githubToken: TOKEN }), (err) => err.code === "PROVIDER_CONFLICT");
    assert.deepEqual(secretStore.calls.map(([call]) => call), ["put", "delete"]);
    assert.equal(secretStore.secrets.size, 0);
});

test("deleting the provider deletes its secret; a failure on either side keeps both", async (t) => {
    external(t);
    const row = STORED_ROW(reference("ghcp-7-1", "v1"));
    const ok = storeOver({ answers: { cms_provider_in_namespace: [row] } });
    ok.secretStore.secrets.set("ghcp-7-1", [TOKEN]);
    assert.equal(await ok.store.deleteProvider("carol-ghcp", 7, false), 0);
    assert.deepEqual(ok.secretStore.calls, [["delete", reference("ghcp-7-1", "v1")]]);
    assert.deepEqual(ok.pool.statements(), ["cms_provider_in_namespace", "BEGIN", "cms_provider_delete", "COMMIT", "RELEASE"]);

    const unreachable = storeOver({ secretStore: fakeSecretStore({ failDelete: true }), answers: { cms_provider_in_namespace: [row] } });
    await assert.rejects(unreachable.store.deleteProvider("carol-ghcp", 7, false), (err) => {
        assert.equal(err.code, "PROVIDER_SECRET_STORE_UNAVAILABLE");
        assert.match(err.message, /the provider was kept/);
        return true;
    });
    assert.deepEqual(unreachable.pool.statements(), ["cms_provider_in_namespace", "BEGIN", "cms_provider_delete", "ROLLBACK", "RELEASE"]);

    const inUse = storeOver({ answers: {
        cms_provider_in_namespace: [row],
        cms_provider_delete: new Error('PROVIDER_IN_USE: "carol-ghcp" is selected by a default or system-agent override; clear that routing first'),
    } });
    await assert.rejects(inUse.store.deleteProvider("carol-ghcp", 7, false), (err) => err.code === "PROVIDER_IN_USE");
    assert.deepEqual(inUse.secretStore.calls, [], "a provider the database keeps keeps its secret");
    assert.ok(inUse.pool.statements().includes("ROLLBACK"));
});

test("a host without the secret store refuses personal keys, and refuses to delete a provider whose key is stored", async (t) => {
    external(t);
    const pool = fakePool({ cms_provider_in_namespace: [STORED_ROW(reference("ghcp-7-1", "v1"))] });
    const store = new ProviderStore(pool, "ps");
    await assert.rejects(create(store, { githubToken: TOKEN }), (err) => err.code === "PROVIDER_FORBIDDEN" && /only the portal/.test(err.message));
    await assert.rejects(store.updatePersonalCredential("carol-ghcp", { githubToken: TOKEN }, 7, PERSONAL), (err) => err.code === "PROVIDER_FORBIDDEN");
    await assert.rejects(store.deleteProvider("carol-ghcp", 7, false), (err) => err.code === "PROVIDER_FORBIDDEN" && /Delete it in the portal/.test(err.message));
    assert.deepEqual(pool.statements(), ["cms_provider_in_namespace", "cms_provider_in_namespace"]);
});

test("credentials read back carry a stored reference alone, so no worker preloads a personal token", async (t) => {
    external(t);
    const stray = { ...reference("ghcp-7-1", "v1"), value: TOKEN, githubToken: TOKEN };
    const pool = fakePool({
        provider_instances: [{ ...STORED_ROW(stray), system_use_enabled: false }],
        cms_provider_in_namespace: [STORED_ROW(stray)],
        cms_provider_for_system: [STORED_ROW(stray)],
    });
    const store = new ProviderStore(pool, "ps");
    for (const credential of [(await store.allCredentials())[0], await store.getCredential("carol-ghcp", 7), await store.getSystemCredential("carol-ghcp")]) {
        assert.deepEqual(credential.secretRef, reference("ghcp-7-1", "v1"));
    }
});

test("shared providers, and every provider in database mode, are stored as before", async (t) => {
    external(t);
    const shared = storeOver();
    await shared.store.createProvider({ name: "team-ghcp", typeId: "github-copilot", class: "shared", secretRef: { githubToken: TOKEN } }, 1, true);
    assert.equal(JSON.parse(shared.pool.writes()[0].params[4]).value, TOKEN);
    assert.deepEqual(shared.secretStore.calls, []);

    delete process.env.PILOTSWARM_PERSONAL_SECRETS;
    const database = storeOver();
    await create(database.store, { githubToken: TOKEN });
    await database.store.updatePersonalCredential("carol-ghcp", { githubToken: TOKEN }, 7, PERSONAL);
    assert.deepEqual(database.pool.statements(), ["cms_provider_create", "cms_provider_update_personal_credential"]);
    assert.equal(JSON.parse(database.pool.writes()[1].params[1]).value, TOKEN);
    assert.deepEqual(database.secretStore.calls, []);
});

test("a store module must implement put, delete and describe", () => {
    assert.throws(() => assertPersonalSecretStore({ put() {}, delete() {} }, "The test store"), /The test store must implement put, delete and describe; it lacks describe/);
    const store = fakeSecretStore();
    assert.equal(assertPersonalSecretStore(store), store);
});

// ── manage_provider ──────────────────────────────────────────────

test("in external mode, manage_provider refuses to save a personal credential; the portal is the only way in", async (t) => {
    external(t);
    const { pool, store, secretStore } = storeOver();
    const tools = new Map(createProviderTools({
        catalog: { providers: store },
        resolveViewer: () => ({ userId: 7, isAdmin: true }),
        isGitHubProviderType: (typeId) => typeId === "github-copilot",
    }).map((tool) => [tool.name, tool]));
    const manage = (args) => tools.get("manage_provider").handler(args);
    for (const args of [
        { action: "create", name: "carol-ghcp", mine: true, type: "github-copilot", credentials: { githubToken: TOKEN } },
        { action: "update_credential", name: "carol-ghcp", mine: true, credentials: { githubToken: TOKEN } },
    ]) {
        const result = await manage(args);
        assert.equal(result.code, "PROVIDER_FORBIDDEN", args.action);
        assert.match(result.error, /only the portal saves them/);
    }
    assert.deepEqual(pool.queries, []);
    assert.deepEqual(secretStore.calls, []);

    // A shared provider is not a personal secret.
    await manage({ action: "update_credential", name: "team-ghcp", mine: false, credentials: { githubToken: TOKEN } });
    assert.equal(pool.writes().length, 1);
});

// ── the provider catalog ─────────────────────────────────────────

const ROWS = [
    { name: "team-openai", typeId: "azure-openai", class: "shared", ownerUserId: null, baseUrl: null, secretRef: { kind: "apiKey", value: "sk-team" } },
    { name: "carol-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, baseUrl: null, secretRef: reference("ghcp-7-1", "v1") },
    { name: "carol-openai", typeId: "azure-openai", class: "personal", ownerUserId: 7, baseUrl: null, secretRef: reference("ghcp-7-2", "v1") },
];

test("the catalog lists an external provider with its reference and no token, and drops a reference on another type", () => {
    const registry = buildRuntimeRegistry(TYPES, ROWS, null);
    assert.deepEqual(registry.allProviders.map((provider) => provider.id), ["team-openai", "carol-ghcp"]);
    const resolved = registry.resolve("carol-ghcp:claude-opus-5");
    assert.equal(resolved.type, "github");
    assert.equal(resolved.githubToken, undefined);
    assert.deepEqual(resolved.externalSecret, reference("ghcp-7-1", "v1"));
    assert.ok(registry.hasModel("carol-ghcp:gpt-6-astra"));
    assert.throws(() => new ModelProviderRegistry({ providers: [{ id: "x", type: "github", externalSecret: reference("a", "1"), models: ["m"] }] }),
        /externalSecret is not a model-providers setting/);
});

test("session creation selects an external provider without its token: explicit, by default and first available", async () => {
    const eligible = (row) => row.class === "shared" || row.ownerUserId === 7;
    assert.equal(resolveRuntimeModelSelection(TYPES, ROWS, { requestedModel: "carol-ghcp:claude-opus-5", eligible }).provider, "carol-ghcp");
    assert.equal(resolveRuntimeModelSelection(TYPES, ROWS, { requestedModel: "claude-opus-5", eligible }).model, "carol-ghcp:claude-opus-5");
    assert.equal(resolveRuntimeModelSelection(TYPES, [ROWS[1]], { eligible }).source, "first_available");

    // The portal's own client, as it creates a session for the owner.
    const client = Object.create(PilotSwarmClient.prototype);
    client._modelProviderTypes = TYPES;
    client._catalog = { providers: {
        lookupUserId: async () => 7,
        getDefaults: async () => ({
            mine: { provider: "carol-ghcp", model: "carol-ghcp:gpt-6-astra", reasoning: null, context: null },
            cluster: { provider: null, model: null, reasoning: null, context: null },
            system: { provider: null, model: null, reasoning: null, context: null },
        }),
        allCredentials: async () => ROWS,
    } };
    const selected = await client._resolveCreationModel({ owner: OWNER }, false);
    assert.deepEqual({ model: selected.model, source: selected.source }, { model: "carol-ghcp:gpt-6-astra", source: "user_default" });
});

test("the worker's catalog refresh resolves an external provider with no token in its registry", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-external-catalog-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const catalogFile = join(root, "model_providers.json");
    writeFileSync(catalogFile, JSON.stringify({ providers: TYPES.allProviders }));
    withEnv(t, { PILOTSWARM_PERSONAL_SECRETS: undefined, PILOTSWARM_REDACT_SECRET_PREFIXES: undefined });
    const worker = new PilotSwarmWorker({
        sessionStateDir: join(root, "sessions"), modelProvidersPath: catalogFile, disableManagementAgents: true,
    });
    worker._catalog = { providers: {
        allCredentials: async () => ROWS,
        getDefaults: async () => ({ cluster: { model: null } }),
    } };
    await worker._refreshProviderRegistry();
    const registry = worker.sessionManager.workerDefaults.modelProviders;
    assert.deepEqual(registry.resolve("carol-ghcp:claude-opus-5").externalSecret, reference("ghcp-7-1", "v1"));
    assert.equal(JSON.stringify(registry.allProviders).includes("github_pat_"), false);
});

// ── no cloud SDK in core ─────────────────────────────────────────

const SECRET_SERVICE_SDK = /^(@azure\/keyvault|@azure\/identity|@aws-sdk|aws-sdk|@google-cloud|node-vault|@hashicorp)/;

function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const target = join(dir, name);
        return statSync(target).isDirectory() ? sourceFiles(target) : (target.endsWith(".ts") ? [target] : []);
    });
}

test("core loads no cloud SDK for personal secrets", () => {
    const specifiers = (file) => [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\(\s*|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const file of sourceFiles(join(SDK_DIR, "src"))) {
        const found = specifiers(file).filter((s) => /keyvault|secrets-manager|secret-manager|vault/i.test(s) && !s.startsWith("."));
        assert.deepEqual(found, [], `${file} imports a secret service SDK`);
    }
    for (const name of ["personal-secret-store.ts", "secret-redaction.ts", "cli-program-guard.ts"]) {
        const external = specifiers(join(SDK_DIR, "src", name)).filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
        assert.deepEqual(external.filter((s) => s !== "duroxide"), [], `${name} imports only Node and PilotSwarm modules`);
    }
    const manifest = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
    assert.deepEqual(dependencies.filter((name) => /keyvault|secrets-manager|secret-manager|vault/i.test(name)), []);

    // What loading the feature's modules actually resolves.
    const modules = ["personal-secret-store.js", "secret-redaction.js", "cli-program-guard.js", "provider-store.js", "provider-catalog.js"]
        .map((name) => pathToFileURL(join(SDK_DIR, "dist", name)).href);
    const script = [
        'import { registerHooks } from "node:module";',
        "const seen = new Set();",
        "registerHooks({ resolve(specifier, context, next) {",
        '    if (!/^(\\.|node:|file:)/.test(specifier)) seen.add(specifier);',
        "    return next(specifier, context);",
        "} });",
        `for (const url of ${JSON.stringify(modules)}) await import(url);`,
        "console.log(JSON.stringify([...seen]));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: SDK_DIR, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const loaded = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.deepEqual(loaded.filter((specifier) => SECRET_SERVICE_SDK.test(specifier)), [], `loaded: ${loaded.join(", ")}`);
});
