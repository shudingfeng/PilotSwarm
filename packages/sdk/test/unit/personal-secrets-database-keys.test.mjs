/**
 * External personal secrets (PILOTSWARM_PERSONAL_SECRETS=external) and the
 * keys saved in the database before the setting was turned on: a personal
 * GitHub provider's key in its row, and a person's legacy key
 * (`users.github_copilot_key`). Workers don't use them. A turn on such a
 * provider fails as an authentication failure, which is not retried, and
 * nothing stands in for the key: the owner updates it, which moves it to the
 * store. A legacy key reads as no key. The System key, which an
 * administrator stores for the deployment, still works, and in database
 * mode nothing changes.
 *
 * SessionManager runs with the Copilot transport stubbed, as in
 * personal-credential-resolver.test.mjs.
 *
 * Run: node --test test/unit/personal-secrets-database-keys.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../dist/session-manager.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry } from "../../dist/provider-catalog.js";
import { PersonalCredentialError } from "../../dist/personal-secret-store.js";
import { personalCredentialTurnResult } from "../../dist/session-proxy.js";
import { isAuthFailureError } from "../../dist/orchestration/utils.js";
import { SYSTEM_USER_PRINCIPAL } from "../../dist/cms.js";

const WORKER_TOKEN = "worker-default-github-token";
const OLD_KEY = `github_pat_${"o".repeat(82)}`;
const TEAM_TOKEN = "team-shared-github-token";
const LEGACY_KEY = "legacy-user-key";
const SYSTEM_KEY = "system-key";
const MODEL = "carol-ghcp:claude-opus-5";
const LEGACY_MODEL = "github-copilot:claude-opus-5";
const CAROL = { provider: "entra", subject: "carol" };

const TYPES = new ModelProviderRegistry({
    providers: [{ id: "github-copilot", type: "github", models: [{ name: "claude-opus-5" }] }],
}, { keepUncredentialed: true });

/** A shared provider with its key, Carol's with the key saved before external mode, Dave's in the store. */
const ROWS = [
    { name: "team-ghcp", typeId: "github-copilot", class: "shared", ownerUserId: null, baseUrl: null,
        secretRef: { kind: "githubToken", value: TEAM_TOKEN } },
    { name: "carol-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, baseUrl: null,
        secretRef: { kind: "githubToken", value: OLD_KEY } },
    { name: "dave-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 8, baseUrl: null,
        secretRef: { kind: "externalSecret", store: "fake-store", name: "ghcp-8-a1", version: "v1", expiresOn: null } },
];

function secretsMode(t, value) {
    const saved = process.env.PILOTSWARM_PERSONAL_SECRETS;
    if (value === undefined) delete process.env.PILOTSWARM_PERSONAL_SECRETS;
    else process.env.PILOTSWARM_PERSONAL_SECRETS = value;
    t.after(() => {
        if (saved === undefined) delete process.env.PILOTSWARM_PERSONAL_SECRETS;
        else process.env.PILOTSWARM_PERSONAL_SECRETS = saved;
    });
}

/** A session manager over `registry`, its CLI transport stubbed, recording every key it starts a CLI on. `workerToken: null` is none. */
function fixture(t, { registry, workerToken = WORKER_TOKEN, catalog = true, sessions = {} }) {
    const home = mkdtempSync(join(tmpdir(), "ps-database-keys-"));
    const manager = new SessionManager(workerToken ?? undefined, null, { modelProviders: registry }, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const legacyLookups = [];
    if (catalog) {
        const known = {
            getSession: async (sessionId) => ({
                sessionId, rootSessionId: sessionId, model: MODEL, isSystem: false, owner: CAROL, ...sessions[sessionId],
            }),
            getUserGitHubCopilotKey: async (principal) => {
                legacyLookups.push({ provider: principal.provider, subject: principal.subject });
                return principal.subject === SYSTEM_USER_PRINCIPAL.subject ? SYSTEM_KEY : LEGACY_KEY;
            },
            getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
            providers: undefined, features: undefined, motds: undefined,
        };
        // Anything else the session path reads answers "nothing stored".
        manager.setSessionCatalog(new Proxy(known, { get: (target, name) => (name in target ? target[name] : async () => null) }));
    }
    const requests = [];
    manager.setPersonalCredentialResolver(async (request) => {
        requests.push(request);
        return { status: "ok", token: "resolved-token" };
    });
    const clientKeys = [];
    manager.ensureClient = async (...args) => {
        clientKeys.push(args[0]);
        const open = (config) => {
            mkdirSync(join(home, config.sessionId), { recursive: true });
            return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({}) } } };
        };
        return {
            createSession: async (config) => open(config),
            resumeSession: async (_id, config) => open(config),
            deleteSession: async () => {},
            listModels: async () => [{ id: "claude-opus-5", capabilities: { supports: { vision: true } } }],
        };
    };
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, requests, clientKeys, legacyLookups };
}

const refusal = (promise) => promise.then(() => assert.fail("the turn should not have run"), (error) => error);

test("in external mode the catalog lists a personal provider whose key is in its row, without the key", (t) => {
    secretsMode(t, "external");
    const registry = buildRuntimeRegistry(TYPES, ROWS, null);
    assert.deepEqual(registry.allProviders.map((provider) => provider.id), ["team-ghcp", "carol-ghcp", "dave-ghcp"]);
    const carol = registry.resolve(MODEL);
    assert.equal(carol.githubToken, undefined);
    assert.equal(carol.databaseKeyIgnored, true);
    assert.equal(JSON.stringify(registry.allProviders).includes(OLD_KEY), false, "the key is nowhere in the worker's catalog");
    assert.equal(registry.resolve("team-ghcp:claude-opus-5").githubToken, TEAM_TOKEN, "a shared provider keeps its key");
    assert.equal(registry.resolve("dave-ghcp:claude-opus-5").databaseKeyIgnored, undefined, "a key in the store is resolved as before");
    assert.throws(() => new ModelProviderRegistry({ providers: [{ id: "x", type: "github", databaseKeyIgnored: true, models: ["m"] }] }),
        /databaseKeyIgnored is not a model-providers setting/);
});

test("in database mode the catalog keeps a personal provider's key as before", (t) => {
    secretsMode(t, undefined);
    const carol = buildRuntimeRegistry(TYPES, ROWS, null).resolve(MODEL);
    assert.equal(carol.githubToken, OLD_KEY);
    assert.equal(carol.databaseKeyIgnored, undefined);
    assert.equal(buildRuntimeRegistry(TYPES, ROWS, null, { personalSecrets: "external" }).resolve(MODEL).databaseKeyIgnored, true,
        "the mode a worker passes wins over the environment");
});

test("a worker reads the setting once: the catalog it rebuilds before every turn doesn't read the environment again", async (t) => {
    secretsMode(t, undefined);
    const root = mkdtempSync(join(tmpdir(), "ps-database-keys-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const catalogFile = join(root, "model_providers.json");
    writeFileSync(catalogFile, JSON.stringify({ providers: TYPES.allProviders }));
    const worker = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions"), modelProvidersPath: catalogFile, disableManagementAgents: true });
    worker._catalog = { providers: { allCredentials: async () => ROWS, getDefaults: async () => ({ cluster: { model: null } }) } };
    process.env.PILOTSWARM_PERSONAL_SECRETS = "external";
    await worker._refreshProviderRegistry();
    assert.equal(worker.sessionManager.workerDefaults.modelProviders.resolve(MODEL).githubToken, OLD_KEY,
        "the mode the worker was built in");
});

test("a turn on such a provider fails as an authentication failure before anything starts, and nothing stands in for the key", async (t) => {
    secretsMode(t, "external");
    const h = fixture(t, { registry: buildRuntimeRegistry(TYPES, ROWS, null), sessions: { s2: { model: "team-ghcp:claude-opus-5" } } });

    const err = await refusal(h.manager.preparePersonalCredential("s1", MODEL));
    assert.ok(err instanceof PersonalCredentialError);
    assert.equal(err.outcome, "refused");
    assert.equal(err.provider, "carol-ghcp");
    assert.match(err.message, /provider "carol-ghcp" has no key in the deployment's secret store/);
    assert.match(err.message, /Update the provider's key, which moves it to the store/);
    assert.equal(err.message.includes(OLD_KEY), false);
    const result = personalCredentialTurnResult(err, "worker-a");
    assert.equal(result.type, "error");
    assert.equal(isAuthFailureError(result.message), true, "the orchestration stops for the key instead of retrying");

    const direct = await refusal(h.manager.getOrCreate("s1", { model: MODEL }, { turnIndex: 0 }));
    assert.equal(direct.outcome, "refused", "the session refuses too");
    assert.deepEqual(await h.manager.getModelVisionInfo(MODEL, { sessionId: "s1" }), { modelId: "claude-opus-5", known: false, vision: false });
    assert.deepEqual(h.requests, [], "the credential resolver is not asked");
    assert.deepEqual(h.clientKeys, [], "no CLI started, on the worker's GITHUB_TOKEN or any other key");
    assert.deepEqual(h.legacyLookups, [], "the legacy key is not read");

    const shared = await h.manager.getOrCreate("s2", { model: "team-ghcp:claude-opus-5" }, { turnIndex: 0 })
        .then(() => h.clientKeys.at(-1));
    assert.equal(shared, TEAM_TOKEN, "a shared provider runs on its own key");
});

test("a worker without a catalog refuses such a turn too, instead of running it on its GITHUB_TOKEN", async (t) => {
    secretsMode(t, "external");
    const h = fixture(t, { registry: buildRuntimeRegistry(TYPES, ROWS, null), catalog: false });
    const err = await refusal(h.manager.getOrCreate("s1", { model: MODEL }, { turnIndex: 0 }));
    assert.equal(err.outcome, "refused");
    assert.deepEqual(h.clientKeys, []);
});

test("in external mode a person's legacy key is not read, so the turn has no key; the System key still works", async (t) => {
    secretsMode(t, "external");
    const h = fixture(t, {
        registry: TYPES,
        workerToken: null,
        sessions: { s1: { model: LEGACY_MODEL }, sys: { model: LEGACY_MODEL, isSystem: true, owner: null } },
    });
    const err = await refusal(h.manager.getOrCreate("s1", { model: LEGACY_MODEL }, { turnIndex: 0 }));
    assert.equal(err.code, "GHCP_KEY_MISSING");
    assert.deepEqual(h.legacyLookups, [], "Carol's legacy key is not read");
    assert.deepEqual(h.clientKeys, []);

    await h.manager.getOrCreate("sys", { model: LEGACY_MODEL }, { turnIndex: 0 });
    assert.deepEqual(h.legacyLookups, [{ provider: SYSTEM_USER_PRINCIPAL.provider, subject: SYSTEM_USER_PRINCIPAL.subject }]);
    assert.deepEqual(h.clientKeys, [SYSTEM_KEY], "a system session runs on the System key");

    const withWorkerToken = fixture(t, { registry: TYPES, sessions: { s1: { model: LEGACY_MODEL } } });
    await withWorkerToken.manager.getOrCreate("s1", { model: LEGACY_MODEL }, { turnIndex: 0 });
    assert.deepEqual(withWorkerToken.legacyLookups, []);
    assert.deepEqual(withWorkerToken.clientKeys, [undefined], "as for anyone without a key, the worker's own client");
});

test("in database mode a person's legacy key is read as before", async (t) => {
    secretsMode(t, undefined);
    const h = fixture(t, { registry: TYPES, workerToken: null, sessions: { s1: { model: LEGACY_MODEL } } });
    await h.manager.getOrCreate("s1", { model: LEGACY_MODEL }, { turnIndex: 0 });
    assert.deepEqual(h.legacyLookups, [CAROL]);
    assert.deepEqual(h.clientKeys, [LEGACY_KEY]);
});
