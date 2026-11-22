import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { ModelProviderRegistry, PilotSwarmManagementClient, ProviderStore } from "pilotswarm-sdk";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { NodeSdkTransport } from "../../tui/src/node-sdk-transport.js";

function runtimeForTest() {
    const prior = process.env.AUTHZ_ADMIN_SCOPE;
    process.env.AUTHZ_ADMIN_SCOPE = "unrestricted";
    try { return new PortalRuntime({ store: "sqlite::memory:", mode: "local" }); }
    finally {
        if (prior === undefined) delete process.env.AUTHZ_ADMIN_SCOPE;
        else process.env.AUTHZ_ADMIN_SCOPE = prior;
    }
}

test("portal runtime routes personal provider credential updates with the authenticated viewer", async () => {
    const calls = [];
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = {
        mgmt: {
            updateMyProviderCredential: async (viewer, input) => {
                calls.push({ viewer, input });
                return { name: input.name, typeId: "github-copilot", class: "personal" };
            },
        },
    };

    const authContext = {
        principal: { provider: "entra", subject: "user-1" },
        authorization: { role: "user" },
    };
    const result = await runtime.call("updateMyProviderCredential", {
        name: "my-ghcp",
        credentials: { githubToken: "replacement-token" },
    }, authContext);

    assert.deepEqual(calls, [{
        viewer: {
            principal: { ...authContext.principal, email: null, displayName: null },
            isAdmin: false,
            adminScope: "unrestricted",
        },
        input: { name: "my-ghcp", credentials: { githubToken: "replacement-token" } },
    }]);
    assert.deepEqual(result, { name: "my-ghcp", typeId: "github-copilot", class: "personal" });
    // NOT a credential-leak guard, despite reading like one: `result` comes
    // wholly from the stub above, which is hardcoded to {name,typeId,class},
    // and runtime.call returns the mgmt result verbatim. Nothing in the store,
    // the management client or the SQL could turn it red — and the deepEqual
    // on the line above already pins the exact value. The real guard is that
    // the store never puts a secret in what it returns; see
    // provider-credential-update.test.mjs, which asserts against the shape the
    // store actually produces.
    //
    // Kept as a cheap tripwire on the STUB's own shape only.
    assert.equal(JSON.stringify(result).includes("replacement-token"), false);
});

// ── PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT ───────────────────────
//
// With the setting on, the Portal's provider RPCs accept a GitHub-type
// credential only once the fine-grained token gate passes it, and the legacy
// key RPCs, which store a token no gate checks, refuse a key. These run the
// real management client and ProviderStore over a pool that only records
// queries, with a stand-in for GitHub, so nothing reaches a database or the
// network. The gate's own checks are pinned in the SDK's
// provider-fine-grained-github-token.test.mjs.

const SETTING = "PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT";
const TOKEN = `github_pat_${"x".repeat(82)}`;
const CLASSIC = `ghp_${"x".repeat(36)}`;
const USER = { principal: { provider: "entra", subject: "user-1" }, authorization: { role: "user" } };
const ADMIN = { principal: { provider: "entra", subject: "admin-1" }, authorization: { role: "admin" } };

const TYPES = new ModelProviderRegistry({
    providers: [
        { id: "github-copilot", type: "github", models: [{ name: "claude-opus-5" }] },
        { id: "azure-openai", type: "openai", baseUrl: "https://models.example.invalid/v1", models: [{ name: "gpt-5.4" }] },
    ],
}, { keepUncredentialed: true });

async function withSetting(value, fn) {
    const previous = process.env[SETTING];
    if (value === undefined) delete process.env[SETTING];
    else process.env[SETTING] = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env[SETTING];
        else process.env[SETTING] = previous;
    }
}

/** A public-only token, a week from expiry, holding none of the refused permissions. */
function fakeGitHub() {
    const requests = [];
    const fetch = async (url) => {
        requests.push(url);
        if (new URL(url).pathname === "/user/repos") {
            return Response.json([{ visibility: "public" }], {
                headers: { "GitHub-Authentication-Token-Expiration": new Date(Date.now() + 7 * 86_400_000).toISOString() },
            });
        }
        return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
    };
    return { fetch, requests };
}

function portalWithStore(legacy = {}) {
    const github = fakeGitHub();
    const queries = [];
    const pool = {
        query: async (sql, params) => {
            queries.push(sql);
            if (sql.includes("cms_provider_user_id")) return { rows: [{ user_id: 7 }] };
            if (sql.includes("cms_provider_list")) {
                return { rows: [
                    { name: "mine-ghcp", type_id: "github-copilot", class: "personal", owner_user_id: 7 },
                    { name: "team-ghcp", type_id: "github-copilot", class: "shared", owner_user_id: null },
                ] };
            }
            return { rows: [{ name: params?.[0], type_id: "stored", class: "stored" }] };
        },
    };
    const mgmt = Object.create(PilotSwarmManagementClient.prototype);
    mgmt._started = true;
    mgmt._modelProviders = TYPES;
    mgmt._catalog = {
        providers: new ProviderStore(pool, "ps", { gitHubTokenCheck: { fetch: github.fetch } }),
        recordAuthzAudit: async () => {},
    };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = { mgmt, ...legacy };
    const writes = () => queries.filter((sql) => /cms_provider_(create|update_personal_credential|update_shared_credential)/.test(sql));
    return { runtime, github, writes };
}

test("with the gate on, the Portal refuses a classic token on a GitHub provider: create, and both updates", async () => {
    await withSetting("1", async () => {
        const { runtime, github, writes } = portalWithStore();
        for (const [method, params, auth] of [
            ["createMyProvider", { name: "new-ghcp", type: "github-copilot", credentials: { apiKey: CLASSIC } }, USER],
            ["createProvider", { name: "team-ghcp-2", type: "github-copilot", credentials: { apiKey: CLASSIC } }, ADMIN],
            ["updateMyProviderCredential", { name: "mine-ghcp", credentials: { apiKey: CLASSIC } }, USER],
            ["updateSharedProviderCredential", { name: "team-ghcp", credentials: { apiKey: CLASSIC } }, ADMIN],
        ]) {
            await assert.rejects(runtime.call(method, params, auth), (err) => {
                assert.equal(err.code, "PROVIDER_INVALID", method);
                assert.equal(err.status, 400);
                assert.match(err.message, /accepts only fine-grained personal access tokens/);
                assert.equal(err.message.includes(CLASSIC), false, "the key must never be echoed");
                return true;
            });
        }
        assert.deepEqual(writes(), []);
        assert.deepEqual(github.requests, []);
    });
});

test("with the gate on, the Portal stores another type's key as today, and a token GitHub passes", async () => {
    await withSetting("1", async () => {
        const { runtime, github, writes } = portalWithStore();
        await runtime.call("createMyProvider", { name: "mine-openai", type: "azure-openai", credentials: { apiKey: "sk-test-key" } }, USER);
        assert.equal(writes().length, 1);
        assert.deepEqual(github.requests, []);

        // An update names no type: the stored row's type puts it under the gate.
        await runtime.call("updateMyProviderCredential", { name: "mine-ghcp", credentials: { githubToken: TOKEN } }, USER);
        assert.equal(writes().length, 2);
        assert.equal(github.requests.length, 6);
    });
});

test("with the gate off, the Portal stores a classic token as today and asks GitHub nothing", async () => {
    await withSetting(undefined, async () => {
        const { runtime, github, writes } = portalWithStore();
        await runtime.call("createMyProvider", { name: "new-ghcp", type: "github-copilot", credentials: { apiKey: CLASSIC } }, USER);
        await runtime.call("updateMyProviderCredential", { name: "mine-ghcp", credentials: { apiKey: CLASSIC } }, USER);
        assert.equal(writes().length, 2);
        assert.deepEqual(github.requests, []);
    });
});

test("with the gate on, the legacy key RPCs refuse a key, even a fine-grained one, but still clear one", async () => {
    await withSetting("1", async () => {
        const calls = [];
        const { runtime } = portalWithStore({
            setCurrentUserGitHubCopilotKey: async ({ key }) => { calls.push(["user", key]); return {}; },
            setSystemGitHubCopilotKey: async ({ key }) => { calls.push(["system", key]); return {}; },
        });
        for (const [method, auth] of [["setCurrentUserGitHubCopilotKey", USER], ["setSystemGitHubCopilotKey", ADMIN]]) {
            await assert.rejects(runtime.call(method, { key: TOKEN }, auth), (err) => {
                assert.equal(err.code, "FORBIDDEN");
                assert.equal(err.status, 403);
                assert.match(err.message, new RegExp(`'${method}' is disabled`));
                assert.equal(err.message.includes(TOKEN), false);
                return true;
            });
            await runtime.call(method, { key: null }, auth);
        }
        assert.deepEqual(calls, [["user", null], ["system", null]]);
    });
});

test("with the gate off, the legacy key RPCs store a key as today", async () => {
    await withSetting(undefined, async () => {
        const calls = [];
        const { runtime } = portalWithStore({
            setCurrentUserGitHubCopilotKey: async ({ key }) => { calls.push(key); return {}; },
        });
        await runtime.call("setCurrentUserGitHubCopilotKey", { key: CLASSIC }, USER);
        assert.deepEqual(calls, [CLASSIC]);
    });
});

test("a malformed gate setting stops the portal at startup", async () => {
    await withSetting("enabled", async () => {
        assert.throws(() => new PortalRuntime({ store: "sqlite::memory:", mode: "local" }), new RegExp(`${SETTING} must be 1 or 0`));
    });
});

test("the HTTP Decision catalog route reaches the real Node SDK transport with the authenticated viewer", async () => {
    const calls = [];
    const expected = [{
        providerId: "decision-shared", providerType: "foundry-wif", qualifiedName: "decision-shared:ps-decision-1-1",
        modelName: "ps-decision-1-1", catalogKind: "runtime_provider", credentialAvailable: true,
    }];
    const mgmt = {
        listRuntimeDecisionModels: async viewer => { calls.push(viewer); return expected; },
    };
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt });

    const principal = { provider: "entra", subject: "admin-1", email: "admin@example.test", displayName: "Admin" };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = {
                principal,
                authorization: { allowed: true, role: "admin", reason: "test", matchedGroups: ["admins"] },
            };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/models/decision`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, result: expected });
        assert.deepEqual(calls, [{ principal: {
            provider: "entra", subject: "admin-1", email: "admin@example.test", displayName: "Admin",
        }, isAdmin: true }]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

// Negative cases for the Cluster Decision Default over HTTP (owner 2026-11-20): PUT /model-defaults with scope cluster_decision
// reaches the real management-client checks; a non-admin is refused 403 and invalid tuples 4xx, and none of them writes.
test("PUT /model-defaults cluster_decision: non-admin 403, invalid tuples 4xx, admin set and clear write only valid tuples", async () => {
    const { PilotSwarmManagementClient, ModelProviderRegistry } = await import("pilotswarm-sdk");
    const registry = new ModelProviderRegistry({ providers: [
        { id: "foundry", type: "foundry-wif", baseUrl: "https://decision.example.test/openai/v1", models: [{ name: "gpt-chat" }],
            decisionModels: [{ name: "ps-decision-1-1" }] },
    ] }, { keepUncredentialed: true });
    const row = (name, cls) => ({ name, typeId: "foundry", class: cls, ownerUserId: cls === "personal" ? 7 : null,
        baseUrl: "https://decision.example.test/openai/v1", secretRef: {}, instanceId: `${name}-id`, usableByMe: true });
    const rows = [row("shared-decision", "shared"), row("mine", "personal")];
    const writes = [];
    const store = {
        lookupUserId: async () => 7,
        listProviders: async () => rows,
        getCredential: async name => rows.find(item => item.name === name) ?? null,
        setClusterDecisionDefault: async (tuple, isAdmin) => { writes.push({ tuple, isAdmin }); },
    };
    const mgmt = Object.assign(Object.create(PilotSwarmManagementClient.prototype), {
        _started: true, _modelProviders: registry, _catalog: { providers: store, recordAuthzAudit: async () => {} },
    });
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt });
    let role = "user";
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = { principal: { provider: "entra", subject: "u-1", email: "u@example.test", displayName: "U" },
                authorization: { allowed: true, role, reason: "test", matchedGroups: [] } };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const put = async body => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/model-defaults`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "cluster_decision", ...body }),
        });
        return { status: response.status, body: await response.json() };
    };
    const valid = { provider: "shared-decision", model: "shared-decision:ps-decision-1-1" };
    try {
        let answer = await put(valid);
        assert.equal(answer.status, 403, JSON.stringify(answer.body));
        assert.equal(answer.body.error.code, "PROVIDER_FORBIDDEN");
        assert.match(answer.body.error.message, /Only an administrator can set the Cluster Decision Default/);
        answer = await put({ provider: null, model: null });
        assert.equal(answer.status, 403, "a non-admin cannot clear it either");

        role = "admin";
        for (const [label, body, status, code] of [
            ["a provider without a model", { provider: "shared-decision", model: null }, 400, "PROVIDER_INVALID"],
            ["a model without a provider", { provider: null, model: "shared-decision:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["a chat model", { provider: "shared-decision", model: "shared-decision:gpt-chat" }, 400, "PROVIDER_INVALID"],
            ["another provider's model", { provider: "shared-decision", model: "other:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["a Decision model the catalog does not list", { provider: "shared-decision", model: "shared-decision:no-such-decision" }, 400, "PROVIDER_INVALID"],
            ["a personal provider", { provider: "mine", model: "mine:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["an unknown provider", { provider: "nobody", model: "nobody:ps-decision-1-1" }, 404, "PROVIDER_NOT_FOUND"],
            ["a chat reasoning effort", { ...valid, reasoningEffort: "high" }, 400, "PROVIDER_INVALID"],
        ]) {
            answer = await put(body);
            assert.equal(answer.status, status, `${label}: ${JSON.stringify(answer.body)}`);
            assert.equal(answer.body.error.code, code, label);
        }
        assert.deepEqual(writes, [], "no refused request wrote a default");

        answer = await put(valid);
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        answer = await put({ provider: null, model: null });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.deepEqual(writes, [
            { tuple: { provider: "shared-decision", model: "shared-decision:ps-decision-1-1", reasoning: null, context: null }, isAdmin: true },
            { tuple: { provider: null, model: null, reasoning: null, context: null }, isAdmin: true },
        ]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
