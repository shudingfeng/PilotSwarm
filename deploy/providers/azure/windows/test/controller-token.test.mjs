// controller-token.mjs: the extension's controller token module on Windows
// workers, an IMDS token for the controller's scope and the VM's identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createControllerTokenSource, getToken, imdsGet, IMDS_TOKEN_URL, scopeToResource } from "../controller-token.mjs";
import { CLIENT_ID } from "./fixtures.mjs";

function fakeImds(answers) {
    const urls = [];
    const request = async (url) => {
        urls.push(url);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
    };
    return { request, urls };
}

const ok = (token, expiresOnSeconds) => ({ status: 200, text: JSON.stringify({ access_token: token, expires_on: String(expiresOnSeconds), token_type: "Bearer" }) });

test("the scope becomes the IMDS resource", () => {
    assert.equal(scopeToResource("api://controller-app/.default"), "api://controller-app");
    assert.equal(scopeToResource(" 00000000-0000-0000-0000-000000000001/.default "), "00000000-0000-0000-0000-000000000001");
    assert.equal(scopeToResource("api://controller-app"), "api://controller-app");
    assert.throws(() => scopeToResource(""), /PS_DISK_CONTROLLER_TOKEN_SCOPE/);
    assert.throws(() => scopeToResource("/.default"), /PS_DISK_CONTROLLER_TOKEN_SCOPE/);
    assert.throws(() => scopeToResource("api://a b/.default"), /PS_DISK_CONTROLLER_TOKEN_SCOPE/);
});

test("the token comes from IMDS for the controller's resource and the VM's client ID", async () => {
    const imds = fakeImds([ok("token-1", 2_000_000_000)]);
    const source = createControllerTokenSource({ scope: "api://controller-app/.default", clientId: CLIENT_ID, request: imds.request, now: () => 1_000_000_000_000 });
    assert.equal(await source.getToken(), "token-1");
    const url = new URL(imds.urls[0]);
    assert.equal(`${url.origin}${url.pathname}`, IMDS_TOKEN_URL);
    assert.equal(url.searchParams.get("resource"), "api://controller-app");
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("api-version"), "2018-02-01");
});

test("a token is cached until five minutes before it expires, and one request serves concurrent callers", async () => {
    let now = 1_000_000_000_000;
    const expires = now / 1000 + 3600;
    const imds = fakeImds([ok("first", expires), ok("second", expires + 3600)]);
    const source = createControllerTokenSource({ scope: "api://c/.default", clientId: CLIENT_ID, request: imds.request, now: () => now });
    const [a, b] = await Promise.all([source.getToken(), source.getToken()]);
    assert.deepEqual([a, b], ["first", "first"]);
    assert.equal(imds.urls.length, 1);
    now += 54 * 60_000;
    assert.equal(await source.getToken(), "first", "still more than five minutes left");
    now += 2 * 60_000;
    assert.equal(await source.getToken(), "second", "renewed within five minutes of expiry");
    assert.equal(imds.urls.length, 2);
});

test("IMDS that is not ready yet is retried; a refusal is not, and no error carries a token", async () => {
    const waits = [];
    const retried = fakeImds([{ status: 410, text: "" }, new Error("socket hang up"), ok("ready", 2_000_000_000)]);
    const source = createControllerTokenSource({ scope: "api://c/.default", clientId: CLIENT_ID, request: retried.request, wait: async (ms) => waits.push(ms), now: () => 0 });
    assert.equal(await source.getToken(), "ready");
    assert.deepEqual(waits, [1000, 2000]);

    const refused = fakeImds([{ status: 400, text: JSON.stringify({ error: "invalid_request", error_description: "Identity not found" }) }]);
    const failing = createControllerTokenSource({ scope: "api://c/.default", clientId: CLIENT_ID, request: refused.request, wait: async () => {} });
    await assert.rejects(failing.getToken(), (error) => /HTTP 400.*Identity not found/.test(error.message));
    assert.equal(refused.urls.length, 1);

    const garbled = fakeImds([{ status: 200, text: "not json" }]);
    const parsing = createControllerTokenSource({ scope: "api://c/.default", clientId: CLIENT_ID, request: garbled.request });
    await assert.rejects(parsing.getToken(), /other than JSON/);
});

test("the client ID must be a GUID", () => {
    assert.throws(() => createControllerTokenSource({ scope: "api://c/.default", clientId: "worker" }), /AZURE_CLIENT_ID/);
    assert.throws(() => createControllerTokenSource({ scope: "api://c/.default" }), /AZURE_CLIENT_ID/);
});

test("getToken() without the scope or the client ID fails without calling IMDS", async () => {
    const saved = { scope: process.env.PS_DISK_CONTROLLER_TOKEN_SCOPE, client: process.env.AZURE_CLIENT_ID };
    delete process.env.PS_DISK_CONTROLLER_TOKEN_SCOPE;
    delete process.env.AZURE_CLIENT_ID;
    try {
        await assert.rejects(getToken(), /PS_DISK_CONTROLLER_TOKEN_SCOPE/);
    } finally {
        if (saved.scope !== undefined) process.env.PS_DISK_CONTROLLER_TOKEN_SCOPE = saved.scope;
        if (saved.client !== undefined) process.env.AZURE_CLIENT_ID = saved.client;
    }
});

test("imdsGet sends the Metadata header and reads the answer", async () => {
    let seen = null;
    const server = http.createServer((req, res) => {
        seen = { metadata: req.headers.metadata, url: req.url };
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"access_token":"t"}');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const answer = await imdsGet(`http://127.0.0.1:${server.address().port}/metadata/identity/oauth2/token?x=1`);
        assert.equal(answer.status, 200);
        assert.equal(answer.text, '{"access_token":"t"}');
        assert.deepEqual(seen, { metadata: "true", url: "/metadata/identity/oauth2/token?x=1" });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
