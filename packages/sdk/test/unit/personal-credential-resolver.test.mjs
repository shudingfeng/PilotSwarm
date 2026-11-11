/**
 * External personal secrets on the worker: a provider whose GitHub token is
 * in the deployment's secret store gets the token from the worker's personal
 * credential resolver on every turn, from memory when that secret version
 * was fetched before. Nothing else stands in for it: not the legacy or
 * System key, not the worker's GITHUB_TOKEN, not another provider's token,
 * for the turn or for the vision-capability lookup.
 *
 * SessionManager runs with the Copilot transport stubbed, as in
 * session-workspace-binding.test.mjs. The orchestration's own turn-result
 * handling is driven with a stand-in context to show how each answer ends
 * the turn.
 *
 * Run: node --test test/unit/personal-credential-resolver.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../dist/session-manager.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry } from "../../dist/provider-catalog.js";
import { PersonalCredentialError } from "../../dist/personal-secret-store.js";
import { personalCredentialTurnResult } from "../../dist/session-proxy.js";
import { isAuthFailureError } from "../../dist/orchestration/utils.js";
import { createInitialState, deriveOptions } from "../../dist/orchestration/state.js";
import { handleTurnResult } from "../../dist/orchestration/turn.js";

const WORKER_TOKEN = "worker-default-github-token";
const LEGACY_KEY = "legacy-user-key";
const TEAM_TOKEN = "team-shared-github-token";
const MODEL = "carol-ghcp:claude-opus-5";

const TYPES = new ModelProviderRegistry({
    providers: [{ id: "github-copilot", type: "github", models: [{ name: "claude-opus-5" }] }],
}, { keepUncredentialed: true });

const reference = (name = "ghcp-7-a1", version = "v1") => ({
    kind: "externalSecret", store: "fake-store", name, version, expiresOn: "2026-12-01T00:00:00.000Z",
});

/** The worker's catalog: a shared provider with its own token, and Carol's personal one in the store. */
function registryWith(secret = reference()) {
    return buildRuntimeRegistry(TYPES, [
        { name: "team-ghcp", typeId: "github-copilot", class: "shared", ownerUserId: null, baseUrl: null,
            secretRef: { kind: "githubToken", value: TEAM_TOKEN } },
        { name: "carol-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, baseUrl: null,
            secretRef: secret },
    ], null);
}

function fixture(t, {
    answer = async (request) => ({ status: "ok", token: `token-${request.secret.version}` }),
    models = {},
} = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-personal-credential-"));
    const manager = new SessionManager(WORKER_TOKEN, null, { modelProviders: registryWith() }, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const legacyLookups = [];
    const known = {
        getSession: async (sessionId) => ({
            sessionId, model: models[sessionId] ?? MODEL, rootSessionId: "root-1", isSystem: false,
            owner: { provider: "entra", subject: "carol" },
        }),
        getUserGitHubCopilotKey: async (principal) => { legacyLookups.push(principal); return LEGACY_KEY; },
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        providers: undefined, features: undefined, motds: undefined,
    };
    // Anything else the session path reads answers "nothing stored".
    manager.setSessionCatalog(new Proxy(known, { get: (target, name) => (name in target ? target[name] : async () => null) }));
    const requests = [];
    manager.setPersonalCredentialResolver(async (request) => {
        requests.push(request);
        return answer(request);
    });
    const clientKeys = [];
    const handles = [];
    manager.ensureClient = async (...args) => {
        clientKeys.push(args[0]);
        const open = (kind, config) => {
            const handle = { kind, disconnected: false, disconnect: async () => { handle.disconnected = true; },
                rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({}) } } };
            handles.push(handle);
            mkdirSync(join(home, config.sessionId), { recursive: true });
            return handle;
        };
        return {
            createSession: async (config) => open("create", config),
            resumeSession: async (_id, config) => open("resume", config),
            deleteSession: async () => {},
            listModels: async () => [{ id: "claude-opus-5", capabilities: { supports: { vision: true } } }],
        };
    };
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, requests, clientKeys, handles, legacyLookups };
}

const turn = (manager, turnIndex) => manager.getOrCreate("s1", { model: MODEL }, { turnIndex });

test("each turn resolves the key through the resolver, from memory for a secret version it already fetched", async (t) => {
    const h = fixture(t);
    const first = await turn(h.manager, 0);
    assert.deepEqual(h.requests, [{
        sessionId: "s1", rootSessionId: "root-1", provider: "carol-ghcp", secret: reference(),
    }]);
    assert.deepEqual(h.clientKeys, ["token-v1"], "the session's CLI runs on the resolved key");

    const second = await turn(h.manager, 1);
    assert.equal(second, first, "the same key keeps the warm session");
    assert.equal(h.requests.length, 1, "a version already fetched is served from memory");
    assert.deepEqual(h.legacyLookups, [], "the legacy key is never consulted");
});

test("a new secret version or another secret is fetched again, and a warm session moves to the new key", async (t) => {
    const h = fixture(t);
    const first = await turn(h.manager, 0);

    h.manager.setModelProviders(registryWith(reference("ghcp-7-a1", "v2")));
    const rotated = await turn(h.manager, 1);
    assert.deepEqual(h.requests.map((request) => request.secret.version), ["v1", "v2"]);
    assert.notEqual(rotated, first, "the warm session was recycled onto the new key's client");
    assert.equal(h.handles[0].disconnected, true);
    assert.equal(h.handles.at(-1).kind, "resume", "the conversation resumes on the new client");
    assert.deepEqual(h.clientKeys, ["token-v1", "token-v2"]);

    h.manager.setModelProviders(registryWith(reference("ghcp-7-b2", "v1")));
    await turn(h.manager, 2);
    assert.deepEqual(h.requests.at(-1).secret, reference("ghcp-7-b2", "v1"), "a re-registered secret is fetched by its own name");
});

test("after the model refuses the key, the next attempt fetches it again", async (t) => {
    const h = fixture(t);
    await turn(h.manager, 0);
    assert.equal(h.requests.length, 1);
    h.manager.forgetPersonalCredential("s1");
    await turn(h.manager, 1);
    assert.equal(h.requests.length, 2, "the cached key was dropped");
});

/** Drive one orchestration generator to its end with a stand-in context; returns its effects. */
function orchestrate(result) {
    const input = { sessionId: "s1", config: { model: MODEL }, blobEnabled: false };
    const values = new Map();
    const statuses = [];
    const effects = [];
    const effect = (name) => (...args) => ({ effect: name, args });
    const ctx = new Proxy({
        traceInfo: () => {},
        setCustomStatus: (status) => statuses.push(JSON.parse(status)),
        getValue: (key) => values.get(key) ?? null,
        setValue: (key, value) => values.set(key, value),
        clearValue: (key) => values.delete(key),
    }, { get: (target, name) => (name in target ? target[name] : effect(`ctx.${String(name)}`)) });
    const runtime = {
        ctx,
        input,
        versions: { currentVersion: "test", latestVersion: "test" },
        manager: new Proxy({}, { get: (_target, name) => effect(`manager.${String(name)}`) }),
        session: new Proxy({}, { get: (_target, name) => effect(`session.${String(name)}`) }),
        options: deriveOptions(input),
        state: createInitialState(input, deriveOptions(input)),
    };
    const generator = handleTurnResult(runtime, result, "Please check the build.");
    for (let step = generator.next(); !step.done;) {
        effects.push(step.value);
        step = generator.next(step.value?.effect === "ctx.utcNow" ? 1_000_000 : undefined);
    }
    return { state: runtime.state, statuses, effects };
}

/** The first turn, which must not run; returns its error. */
async function refusalFrom(t, answer, setup = () => {}) {
    const h = fixture(t, { answer });
    setup(h.manager);
    const err = await turn(h.manager, 0).then(() => assert.fail("the turn should not have run"), (error) => error);
    return { err, h };
}

/** With GITHUB_TOKEN, a legacy key and another provider's token all available, the turn used none of them. */
function assertNoOtherKey(h) {
    assert.deepEqual(h.clientKeys, [], "no CLI started on any other key");
    assert.deepEqual(h.legacyLookups, [], "the legacy key was never consulted");
}

test("a refused key fails the turn as an authentication failure, which the orchestration does not retry", async (t) => {
    const { err, h } = await refusalFrom(t, async () => ({ status: "refused", message: "no drive lease for this session" }));
    assert.ok(err instanceof PersonalCredentialError);
    assert.equal(err.outcome, "refused");
    assertNoOtherKey(h);

    const result = personalCredentialTurnResult(err, "worker-a");
    assert.equal(result.type, "error");
    assert.equal(isAuthFailureError(result.message), true);
    const { state, effects } = orchestrate(result);
    assert.equal(state.blockedError?.authFailure, true, "the session stops for re-authentication");
    assert.equal(state.retryCount, 0);
    assert.equal(effects.some((e) => e.effect === "ctx.scheduleTimer"), false, "no retry is scheduled");
});

test("an outage fails the turn with an ordinary error, which the orchestration retries", async (t) => {
    for (const answer of [
        async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:443"); },
        async () => ({ status: "unavailable", message: "the credential service answered HTTP 401" }),
        async () => ({ status: "ok", token: "" }),
        async () => ({ nonsense: true }),
    ]) {
        const { err, h } = await refusalFrom(t, answer);
        assert.equal(err.outcome, "unavailable");
        assertNoOtherKey(h);
        const result = personalCredentialTurnResult(err, "worker-a");
        assert.equal(isAuthFailureError(result.message), false, `${result.message} must read as an ordinary error`);
        const { state, effects } = orchestrate(result);
        assert.equal(state.blockedError, undefined, "no re-authentication");
        assert.equal(state.retryCount, 1, "the turn counts one retry");
        assert.ok(effects.some((e) => e.effect === "ctx.scheduleTimer"), "and schedules it");
    }
});

test("a busy answer holds the session on the busy policy, without re-authentication", async (t) => {
    const { err, h } = await refusalFrom(t, async () => ({ status: "busy", message: "the drive is parked", retryAfterMs: 900_000 }));
    assert.equal(err.outcome, "busy");
    assertNoOtherKey(h);

    const result = personalCredentialTurnResult(err, "worker-a");
    assert.deepEqual(
        { type: result.type, gate: result.gate, code: result.code, workerNodeId: result.workerNodeId, retryAfterMs: result.retryAfterMs },
        { type: "wait", gate: "workspace", code: "WORKSPACE_BUSY", workerNodeId: "worker-a", retryAfterMs: 900_000 },
        "the same wait a busy workspace returns",
    );
    const { state, statuses } = orchestrate(result);
    assert.equal(state.blockedError, undefined, "no re-authentication");
    assert.equal(state.retryCount, 0);
    assert.equal(state.activeTimer?.type, "workspace_retry");
    assert.equal(state.activeTimer?.originalDurationMs, 900_000, "the resolver's retry-after sets the wait");
    assert.equal(state.budgetStash?.[0]?.prompt, "Please check the build.", "the prompt is held for the retry");
    assert.equal(statuses.at(-1)?.workspaceCode, "WORKSPACE_BUSY");
});

test("without a resolver, the turn fails with an ordinary error and uses no other key", async (t) => {
    const { err, h } = await refusalFrom(t, undefined, (manager) => manager.setPersonalCredentialResolver(null));
    assert.equal(err.outcome, "unavailable");
    assert.equal(isAuthFailureError(err.message), false);
    assertNoOtherKey(h);
});

test("the vision lookup asks on the resolved key, or on none", async (t) => {
    const h = fixture(t);
    let defaultClientAsked = 0;
    h.manager.client = { listModels: async () => { defaultClientAsked += 1; return []; } };
    const info = await h.manager.getModelVisionInfo(MODEL, { sessionId: "s1" });
    assert.equal(info.vision, true);
    assert.deepEqual(h.clientKeys, ["token-v1"], "the catalog was read on the session's own key");

    const refused = fixture(t, { answer: async () => ({ status: "refused" }) });
    refused.manager.client = { listModels: async () => { defaultClientAsked += 1; return []; } };
    const unknown = await refused.manager.getModelVisionInfo(MODEL, { sessionId: "s1" });
    assert.deepEqual(unknown, { modelId: "claude-opus-5", known: false, vision: false });
    assert.deepEqual(refused.clientKeys, [], "no client on another key");
    assert.equal((await refused.manager.getModelVisionInfo(MODEL)).known, false, "nor without a session");
    assert.equal(defaultClientAsked, 0, "the worker's default client never stands in");
    assert.deepEqual(refused.legacyLookups, []);
});

test("a provider whose key is in the database resolves as before, without the resolver", async (t) => {
    const h = fixture(t, { models: { s2: "team-ghcp:claude-opus-5" } });
    await h.manager.preparePersonalCredential("s2", "team-ghcp:claude-opus-5");
    await h.manager.getOrCreate("s2", { model: "team-ghcp:claude-opus-5" }, { turnIndex: 0 });
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.clientKeys, [TEAM_TOKEN]);
});
