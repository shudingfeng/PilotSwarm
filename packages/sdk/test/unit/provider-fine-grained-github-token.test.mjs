/**
 * The fine-grained GitHub token gate (PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT).
 *
 * With the setting on, a credential for a GitHub-type provider must be a
 * fine-grained personal access token (`github_pat_`) that reaches no private
 * or internal repository, expires within 30 days, and holds none of the
 * account permissions that would let a stolen copy outlive it. Other types
 * keep today's behaviour, and with the setting off nothing changes at all.
 *
 * The store applies the gate only when its caller says so, because it knows
 * a type only by its name; these tests drive the real ProviderStore over a
 * pool that only records queries, and a stand-in for GitHub's API, so
 * nothing reaches the network. The Portal's side is in
 * packages/app/web/test/provider-runtime.test.mjs.
 *
 * Run: node --test test/unit/provider-fine-grained-github-token.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    ProviderStore,
    checkFineGrainedGitHubToken,
    normalizeCallerSecret,
    requiresFineGrainedGitHubTokens,
} from "../../dist/provider-store.js";
import { createProviderTools } from "../../dist/provider-tools.js";

const SETTING = "PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT";
const TOKEN = `github_pat_${"x".repeat(82)}`;
const CLASSIC = `ghp_${"x".repeat(36)}`;
const OAUTH = `gho_${"x".repeat(36)}`;
const USER_TO_SERVER = `ghu_${"x".repeat(36)}`;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** GitHub's own spelling of an expiry, e.g. `2026-11-17 12:00:00 UTC`. */
function gitHubExpiry(ms) {
    return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/**
 * A stand-in for api.github.com. `repositories` is everything the token can
 * list, served 100 to a page; `granted` holds the account-permission
 * endpoints that answer; `answers` replaces one path's answer outright.
 */
function fakeGitHub({
    repositories = [{ visibility: "public" }],
    expiry = gitHubExpiry(NOW + 7 * DAY),
    granted = [],
    answers = {},
} = {}) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({ url, init });
        const { pathname, searchParams } = new URL(url);
        if (answers[pathname]) return answers[pathname](init);
        if (pathname === "/user/repos") {
            const page = Number(searchParams.get("page"));
            return Response.json(repositories.slice((page - 1) * 100, page * 100), {
                headers: expiry ? { "GitHub-Authentication-Token-Expiration": expiry } : {},
            });
        }
        return granted.includes(pathname)
            ? Response.json([])
            : Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
    };
    return { fetch, requests, paths: () => requests.map(({ url }) => new URL(url).pathname + new URL(url).search) };
}

const check = (github, extra = {}) =>
    checkFineGrainedGitHubToken(TOKEN, { fetch: github.fetch, now: () => NOW, ...extra });

/** Refused as an invalid credential, saying what failed, without the token in it. */
async function assertRefused(promise, pattern, secret = TOKEN) {
    await assert.rejects(promise, (err) => {
        assert.equal(err.name, "ProviderError");
        assert.equal(err.code, "PROVIDER_INVALID");
        assert.match(err.message, pattern);
        assert.equal(err.message.includes(secret), false, "the token must never be echoed");
        return true;
    });
}

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

// ── the setting ──────────────────────────────────────────────────

test("the gate is off unless the setting turns it on", () => {
    for (const value of [undefined, "", "0", "false", "no", "off", " OFF "]) {
        assert.equal(requiresFineGrainedGitHubTokens(value === undefined ? {} : { [SETTING]: value }), false, String(value));
    }
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
        assert.equal(requiresFineGrainedGitHubTokens({ [SETTING]: value }), true, value);
    }
});

test("a value the gate does not know is refused, never read as off", () => {
    for (const value of ["enabled", "2", "y"]) {
        assert.throws(() => requiresFineGrainedGitHubTokens({ [SETTING]: value }), new RegExp(`${SETTING} must be 1 or 0`));
    }
});

// ── the synchronous half: the prefix ─────────────────────────────

test("with the gate, only a github_pat_ token passes, whichever field carries it", () => {
    for (const secret of [TOKEN, { value: TOKEN }, { apiKey: TOKEN }, { githubToken: TOKEN }, { token: TOKEN }, { key: TOKEN }]) {
        assert.equal(normalizeCallerSecret(secret, { requireFineGrainedGitHubToken: true }).value, TOKEN);
    }
    for (const [secret, value, kind] of [
        [{ apiKey: CLASSIC }, CLASSIC, /classic personal access token \(ghp_\)/],
        [{ githubToken: OAUTH }, OAUTH, /OAuth app token \(gho_\)/],
        [{ token: USER_TO_SERVER }, USER_TO_SERVER, /GitHub App user token \(ghu_\)/],
        [`GITHUB_PAT_${"x".repeat(82)}`, `GITHUB_PAT_${"x".repeat(82)}`, /not a GitHub personal access token/],
        [{ apiKey: "sk-test-key" }, "sk-test-key", /not a GitHub personal access token/],
    ]) {
        assert.throws(() => normalizeCallerSecret(secret, { requireFineGrainedGitHubToken: true }), (err) => {
            assert.equal(err.code, "PROVIDER_INVALID");
            assert.match(err.message, /accepts only fine-grained personal access tokens \(github_pat_…\)/);
            assert.match(err.message, kind);
            assert.equal(err.message.includes(value), false, "the key must never be echoed");
            return true;
        });
    }
});

test("without the gate a classic token is normalized exactly as before", () => {
    assert.deepEqual(normalizeCallerSecret({ apiKey: CLASSIC }), { kind: "apiKey", value: CLASSIC });
    assert.deepEqual(normalizeCallerSecret({ githubToken: CLASSIC }), { kind: "githubToken", value: CLASSIC });
});

// ── the asynchronous half: what GitHub says ──────────────────────

test("a public-only token that expires within 30 days and holds no refused permission passes", async () => {
    const github = fakeGitHub();
    await check(github);
    assert.deepEqual(github.paths(), [
        "/user/repos?visibility=all&per_page=100&page=1",
        "/user/keys",
        "/user/gpg_keys",
        "/user/ssh_signing_keys",
        "/user/emails",
        "/user/codespaces/secrets",
    ]);
    for (const { url, init } of github.requests) {
        assert.equal(new URL(url).origin, "https://api.github.com", "the token goes to GitHub's API only");
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(init.redirect, "error");
        assert.ok(init.signal instanceof AbortSignal, "every request is bounded");
    }
});

test("every page is read, and the first repository that is not public refuses the token", async () => {
    const repositories = Array.from({ length: 250 }, () => ({ visibility: "public" }));
    repositories[130] = { visibility: "private" };
    const github = fakeGitHub({ repositories });
    await assertRefused(check(github), /can reach a repository that is not public/);
    assert.deepEqual(github.paths(), [
        "/user/repos?visibility=all&per_page=100&page=1",
        "/user/repos?visibility=all&per_page=100&page=2",
    ], "it stops at the first one, and probes nothing after a refusal");
});

test("an internal repository, or one GitHub does not label, is not public", async () => {
    for (const repository of [{ visibility: "internal" }, { private: false }]) {
        await assertRefused(check(fakeGitHub({ repositories: [{ visibility: "public" }, repository] })), /not public/);
    }
});

test("a full last page is followed by the next one", async () => {
    const github = fakeGitHub({ repositories: Array.from({ length: 100 }, () => ({ visibility: "public" })) });
    await check(github);
    assert.equal(github.paths()[1], "/user/repos?visibility=all&per_page=100&page=2");
});

test("the token must carry an expiry no more than 30 days away", async () => {
    await assertRefused(check(fakeGitHub({ expiry: null })), /reports no expiry/);
    await assertRefused(check(fakeGitHub({ expiry: "next month" })), /expiry for the token could not be read/);
    await assertRefused(
        check(fakeGitHub({ expiry: gitHubExpiry(NOW + 30 * DAY + 1000) })),
        /expires at 2026-12-10T12:00:01\.000Z, more than 30 days from now\. Create one that expires by 2026-12-10T12:00:00\.000Z/,
    );
    await check(fakeGitHub({ expiry: gitHubExpiry(NOW + 30 * DAY) }));
});

test("the expiry is read in the zone GitHub states", async () => {
    for (const expiry of ["2026-12-10 12:00:00 UTC", "2026-12-10T12:00:00Z", "2026-12-10 13:00:00 +0100", "2026-12-10 04:00:00 -08:00"]) {
        await check(fakeGitHub({ expiry }));
    }
    await assertRefused(check(fakeGitHub({ expiry: "2026-12-10 12:00:00 -0100" })), /more than 30 days/);
});

test("each refused account permission that answers refuses the token, by name", async () => {
    for (const [path, permission] of [
        ["/user/keys", "Git SSH keys"],
        ["/user/gpg_keys", "GPG keys"],
        ["/user/ssh_signing_keys", "SSH signing keys"],
        ["/user/emails", "Email addresses"],
        ["/user/codespaces/secrets", "Codespaces user secrets"],
    ]) {
        await assertRefused(check(fakeGitHub({ granted: [path] })), new RegExp(`account permission "${permission}"`));
    }
});

test("a permission GitHub could not answer for refuses the token: an unmade check is not a pass", async () => {
    const answered = (status, headers = {}) => () => Response.json({ message: "x" }, { status, headers });
    for (const answer of [answered(500), answered(429), answered(403, { "x-ratelimit-remaining": "0" }), answered(403, { "retry-after": "60" })]) {
        await assertRefused(check(fakeGitHub({ answers: { "/user/emails": answer } })), /could not be checked/);
    }
    // A plain 404 is GitHub saying the permission is not there.
    await check(fakeGitHub({ answers: { "/user/emails": answered(404) } }));
});

test("GitHub refusing the token, or failing to list its repositories, refuses it", async () => {
    const answered = (status) => ({ "/user/repos": () => Response.json({ message: "x" }, { status }) });
    await assertRefused(check(fakeGitHub({ answers: answered(401) })), /does not accept the token \(HTTP 401\)/);
    await assertRefused(check(fakeGitHub({ answers: answered(503) })), /answered HTTP 503 when listing/);
    await assertRefused(
        check(fakeGitHub({ answers: { "/user/repos": () => new Response("<html>", { headers: { "GitHub-Authentication-Token-Expiration": gitHubExpiry(NOW + DAY) } }) } })),
        /repositories could not be read/,
    );
});

test("a network failure refuses the token, with the token cut out of the reason", async () => {
    const github = fakeGitHub({
        answers: {
            "/user/repos": () => {
                throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED while sending ${TOKEN}`) });
            },
        },
    });
    await assertRefused(check(github), /could not be reached to check the token \(connect ECONNREFUSED while sending \[redacted\]\)/);
});

test("each request is bounded: one that never answers refuses the token", async () => {
    const hang = (init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
    await assertRefused(check(fakeGitHub({ answers: { "/user/repos": hang } }), { timeoutMs: 20 }), /no answer within 20 ms/);
    await assertRefused(check(fakeGitHub({ answers: { "/user/ssh_signing_keys": hang } }), { timeoutMs: 20 }), /no answer within 20 ms/);
});

// ── the store: the gate runs before any write ────────────────────

/** A pool that answers the provider procedures and remembers every query. */
function fakePool(rows = {}) {
    const queries = [];
    return {
        queries,
        writes: () => queries.filter(({ sql }) => /cms_provider_(create|update_personal_credential|update_shared_credential)/.test(sql)),
        query: async (sql, params) => {
            queries.push({ sql, params });
            const match = Object.keys(rows).find((fn) => sql.includes(fn));
            return { rows: match ? rows[match] : [] };
        },
    };
}

const STORED = [
    { name: "mine-ghcp", type_id: "github-copilot", class: "personal", owner_user_id: 7 },
    { name: "team-ghcp", type_id: "github-copilot", class: "shared", owner_user_id: null },
    { name: "team-openai", type_id: "azure-openai", class: "shared", owner_user_id: null },
];

function storeOver(github, pool = fakePool({
    cms_provider_list: STORED,
    cms_provider_create: [{ name: "created", type_id: "github-copilot", class: "personal" }],
    cms_provider_update_personal_credential: [{ name: "mine-ghcp", type_id: "github-copilot", class: "personal" }],
    cms_provider_update_shared_credential: [{ name: "team-ghcp", type_id: "github-copilot", class: "shared" }],
})) {
    return { pool, store: new ProviderStore(pool, "ps", { gitHubTokenCheck: { fetch: github.fetch, now: () => NOW } }) };
}

const GATE = { requireFineGrainedGitHubToken: true };

test("the store refuses a classic token on create and on both updates, before writing anything", async () => {
    const github = fakeGitHub();
    const { pool, store } = storeOver(github);
    await assertRefused(store.createProvider({
        name: "mine-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7,
        secretRef: { apiKey: CLASSIC }, requireFineGrainedGitHubToken: true,
    }, 7, false), /classic personal access token/, CLASSIC);
    await assertRefused(store.updatePersonalCredential("mine-ghcp", { apiKey: CLASSIC }, 7, GATE), /classic/, CLASSIC);
    await assertRefused(store.updateSharedCredential("team-ghcp", { apiKey: CLASSIC }, 1, true, GATE), /classic/, CLASSIC);
    assert.deepEqual(pool.queries, []);
    assert.deepEqual(github.requests, [], "the prefix is refused before GitHub is asked");
});

test("the store writes a token that passes, and nothing that GitHub refuses", async () => {
    const passing = fakeGitHub();
    const { pool, store } = storeOver(passing);
    await store.updatePersonalCredential("mine-ghcp", { githubToken: TOKEN }, 7, GATE);
    assert.equal(pool.writes().length, 1);
    assert.equal(JSON.parse(pool.writes()[0].params[1]).value, TOKEN);
    assert.equal(passing.paths().length, 6);

    const failing = storeOver(fakeGitHub({ repositories: [{ visibility: "internal" }] }));
    await assertRefused(failing.store.updateSharedCredential("team-ghcp", { githubToken: TOKEN }, 1, true, GATE), /not public/);
    await assertRefused(failing.store.createProvider({
        name: "team-ghcp", typeId: "github-copilot", class: "shared", secretRef: { githubToken: TOKEN },
        requireFineGrainedGitHubToken: true,
    }, 1, true), /not public/);
    assert.deepEqual(failing.pool.writes(), []);
});

test("unless the caller asks for the gate, the store writes as before and asks GitHub nothing", async () => {
    const github = fakeGitHub();
    const { pool, store } = storeOver(github);
    await store.createProvider({ name: "mine-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, secretRef: { apiKey: CLASSIC } }, 7, false);
    await store.updatePersonalCredential("mine-ghcp", { apiKey: CLASSIC }, 7);
    await store.updateSharedCredential("team-ghcp", { apiKey: CLASSIC }, 1, true);
    assert.equal(pool.writes().length, 3);
    assert.deepEqual(github.requests, []);
});

// ── manage_provider: the worker-side agent tool ──────────────────

function toolsOver(github, { isGitHubProviderType = (typeId) => typeId === "github-copilot" } = {}) {
    const { pool, store } = storeOver(github);
    const tools = new Map(createProviderTools({
        catalog: { providers: store },
        resolveViewer: () => ({ userId: 7, isAdmin: true }),
        ...(isGitHubProviderType ? { isGitHubProviderType } : {}),
    }).map((tool) => [tool.name, tool]));
    const manage = (args) => tools.get("manage_provider").handler(args);
    return { pool, manage };
}

test("manage_provider refuses a classic token on a GitHub provider: create, and both updates by the stored row's type", async () => {
    await withSetting("1", async () => {
        const github = fakeGitHub();
        const { pool, manage } = toolsOver(github);
        for (const args of [
            { action: "create", name: "new-ghcp", mine: true, type: "github-copilot", credentials: { apiKey: CLASSIC } },
            { action: "update_credential", name: "mine-ghcp", mine: true, credentials: { apiKey: CLASSIC } },
            { action: "update_credential", name: "team-ghcp", mine: false, credentials: { apiKey: CLASSIC } },
        ]) {
            const result = await manage(args);
            assert.equal(result.code, "PROVIDER_INVALID", JSON.stringify(args));
            assert.match(result.error, /classic personal access token/);
            assert.equal(result.error.includes(CLASSIC), false);
        }
        assert.deepEqual(pool.writes(), []);
        assert.deepEqual(github.requests, []);
    });
});

test("manage_provider stores another type's key as today, and a passing token on a GitHub type", async () => {
    await withSetting("1", async () => {
        const github = fakeGitHub();
        const { pool, manage } = toolsOver(github);
        // The gate follows the provider's type, not the shape of the key.
        await manage({ action: "create", name: "new-openai", mine: true, type: "azure-openai", credentials: { apiKey: CLASSIC } });
        await manage({ action: "update_credential", name: "team-openai", mine: false, credentials: { apiKey: CLASSIC } });
        assert.equal(pool.writes().length, 2);
        assert.deepEqual(github.requests, []);

        await manage({ action: "create", name: "new-ghcp", mine: true, type: "github-copilot", credentials: { githubToken: TOKEN } });
        assert.equal(pool.writes().length, 3);
        assert.equal(github.paths().length, 6);
    });
});

test("manage_provider on a host that cannot tell types apart saves no credential while the gate is on", async () => {
    await withSetting("1", async () => {
        const { pool, manage } = toolsOver(fakeGitHub(), { isGitHubProviderType: null });
        const result = await manage({ action: "create", name: "new-openai", mine: true, type: "azure-openai", credentials: { apiKey: "sk-test-key" } });
        assert.equal(result.code, "PROVIDER_INVALID");
        assert.match(result.error, /cannot tell which provider types are GitHub ones/);
        assert.deepEqual(pool.writes(), []);
    });
});

test("manage_provider with the setting off behaves as today: no lookup, no GitHub request", async () => {
    await withSetting(undefined, async () => {
        const github = fakeGitHub();
        const { pool, manage } = toolsOver(github, { isGitHubProviderType: null });
        await manage({ action: "create", name: "new-ghcp", mine: true, type: "github-copilot", credentials: { apiKey: CLASSIC } });
        await manage({ action: "update_credential", name: "mine-ghcp", mine: true, credentials: { apiKey: CLASSIC } });
        assert.deepEqual(pool.queries.map(({ sql }) => sql.match(/cms_provider_\w+/)[0]), [
            "cms_provider_create", "cms_provider_update_personal_credential",
        ]);
        assert.deepEqual(github.requests, []);
    });
});

test("manage_provider reports a malformed setting instead of saving unchecked", async () => {
    await withSetting("enabled", async () => {
        const { pool, manage } = toolsOver(fakeGitHub());
        const result = await manage({ action: "create", name: "new-ghcp", mine: true, type: "github-copilot", credentials: { githubToken: TOKEN } });
        assert.match(result.error, new RegExp(`${SETTING} must be 1 or 0`));
        assert.deepEqual(pool.writes(), []);
    });
});
