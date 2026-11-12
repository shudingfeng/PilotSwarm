// The coordination host's module (capacity-requester.mjs): the capacity
// requester it sets on the Linux worker, and no other hook, its settings,
// its token source and its TLS, and the requester against the disk controller
// itself, in this process. Node's standard library only, as
// test:deploy-scripts requires.
//
// Run individually:
//   node --test deploy/providers/azure/linux-worker/test/capacity-requester.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as moduleExports from "../capacity-requester.mjs";
import {
  DEMAND_ROUTE, createCoordinationRequester,
  createWorkloadIdentityTokenSource, ownerSubjectFromTag, parseCoordinationUrl, register, requestJson,
} from "../capacity-requester.mjs";
import { createHarness } from "../../disk-controller/test/harness.mjs";
import { OWNER_A, OWNER_B, TOKENS } from "../../disk-controller/test/fakes.mjs";
import { createTestPki } from "../../disk-controller/test/x509.mjs";

const MODULE = new URL("../capacity-requester.mjs", import.meta.url);
const COORDINATION_URL = "https://pilotswarm-disk-controller-coordination.pilotswarm.svc:3005";
const SCOPE = "11111111-1111-1111-1111-111111111111/.default";
const OWNER_TAG = `owner.${OWNER_A}`;
const REQUEST = { sessionId: "child-1", rootSessionId: "root-1", ownerTag: OWNER_TAG };
const IDENTITY_ENV = {
  AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  AZURE_TENANT_ID: "99999999-9999-9999-9999-999999999999",
  AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/azure-identity-token",
};
const ENV = { PS_COORDINATION_URL: COORDINATION_URL, PS_COORDINATION_TOKEN_SCOPE: SCOPE, ...IDENTITY_ENV };
const HOUR = 3_600_000;

const ok = (body) => ({ status: 200, body });
const signal = () => new AbortController().signal;

/** An HTTP client that answers in turn from `answers` (a function is called, an Error thrown) and records each call. */
function scripted(answers) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    const answer = typeof next === "function" ? await next(options, calls.length) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, calls };
}

/** Timers that fire at once and record each wait. */
function instantTimers() {
  const waits = [];
  return {
    waits,
    setTimeout(fn, ms) {
      waits.push(ms);
      return setImmediate(fn);
    },
    clearTimeout: (id) => clearImmediate(id),
  };
}

/**
 * A stand-in for @azure/identity: its WorkloadIdentityCredential answers
 * getToken from `answers`. It records each credential's options, each
 * getToken call and every export the module reads.
 */
function fakeIdentity(answers, { failImports = 0 } = {}) {
  const made = [];
  const asked = [];
  const read = new Set();
  class WorkloadIdentityCredential {
    constructor(options) {
      this.index = made.length;
      made.push(options);
    }

    async getToken(scope, options) {
      asked.push({ credential: this.index, scope, abortSignal: options?.abortSignal });
      const next = answers.shift();
      if (typeof next === "function") return next(options);
      if (next instanceof Error) throw next;
      return next;
    }
  }
  const exports = new Proxy({ WorkloadIdentityCredential }, {
    get(target, name) {
      if (typeof name === "string") read.add(name);
      return target[name];
    },
  });
  let imports = 0;
  return {
    made,
    asked,
    // A promise resolution also reads `then`.
    exportsRead: () => [...read].filter((name) => name !== "then"),
    imports: () => imports,
    importIdentity: async () => {
      imports += 1;
      if (imports <= failImports) throw new Error("Cannot find package '@azure/identity'");
      return exports;
    },
  };
}

function fakeWorker() {
  return {
    requester: null,
    admission: null,
    setOwnerCapacityRequester(fn) {
      this.requester = fn;
    },
    setSessionAdmission(fn) {
      this.admission = fn;
    },
  };
}

test("passes the controller's ok, deny and busy on, with a valid code and a positive whole retryAfterMs", async () => {
  const cases = [
    [{ decision: "ok", extra: true }, { decision: "ok" }],
    [{ decision: "deny", code: "NO_DRIVE_LEASE", message: "  No lease.  " }, { decision: "deny", message: "No lease.", code: "NO_DRIVE_LEASE" }],
    [{ decision: "deny", code: "no lease", message: " " }, { decision: "deny" }],
    [
      { decision: "busy", code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000.9, message: "Parked." },
      { decision: "busy", message: "Parked.", code: "WORKSPACE_BUSY", retryAfterMs: 900_000 },
    ],
    [{ decision: "busy", retryAfterMs: "60000" }, { decision: "busy", retryAfterMs: 60_000 }],
    [{ decision: "busy", code: "Busy", retryAfterMs: -1 }, { decision: "busy" }],
    [{ decision: "busy", code: `A${"B".repeat(64)}`, retryAfterMs: 0.5 }, { decision: "busy" }],
  ];
  for (const [body, expected] of cases) {
    const { request, calls } = scripted([ok(body)]);
    const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => "coordinator-token", request });
    const fired = signal();
    assert.deepEqual(await requester(REQUEST, fired), expected, JSON.stringify(body));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${COORDINATION_URL}${DEMAND_ROUTE}`);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].headers, { authorization: "Bearer coordinator-token" });
    assert.deepEqual(calls[0].body, { ownerOid: OWNER_A, rootSessionId: "root-1" });
    assert.equal(calls[0].signal, fired, "the request ends when the activity's signal fires");
    assert.equal(calls[0].timeoutMs, 10_000);
  }
});

test("retries a network failure, a 5xx, a 408, a 429 and an answer without a decision, with backoff, until the controller answers", async () => {
  const timers = instantTimers();
  const { request, calls } = scripted([
    new Error("connect ECONNREFUSED"),
    { status: 500, body: { error: "INTERNAL" } },
    { status: 503, body: { error: "STARTING" } },
    { status: 408, body: null },
    { status: 429, body: null },
    ok({ decision: "maybe" }),
    ok(null),
    ok({ decision: "busy", code: "WORKSPACE_BUSY", retryAfterMs: 60_000 }),
  ]);
  let tokens = 0;
  const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => `token-${++tokens}`, request, timers });
  assert.deepEqual(await requester(REQUEST, signal()), { decision: "busy", code: "WORKSPACE_BUSY", retryAfterMs: 60_000 });
  assert.equal(calls.length, 8);
  assert.deepEqual(timers.waits, [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000]);
  assert.deepEqual(calls.map((call) => call.headers.authorization), Array.from({ length: 8 }, (_, i) => `Bearer token-${i + 1}`),
    "each attempt asks the token source, which keeps the token");
});

test("a token source that fails or returns no token is asked again on the next attempt", async () => {
  const timers = instantTimers();
  const { request, calls } = scripted([ok({ decision: "ok" })]);
  const answers = [() => { throw new Error("token exchange failed"); }, () => "", () => "coordinator-token"];
  const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => answers.shift()(), request, timers });
  assert.deepEqual(await requester(REQUEST, signal()), { decision: "ok" });
  assert.equal(calls.length, 1, "no request without a token");
  assert.deepEqual(timers.waits, [250, 500]);
});

test("keeps asking until the activity's signal fires, then stops with the signal's reason", async () => {
  const timers = instantTimers();
  const controller = new AbortController();
  const reason = new Error("no answer within 15000 ms");
  const { request, calls } = scripted([(_, n) => {
    if (n === 3) controller.abort(reason);
    return { status: 503, body: null };
  }]);
  const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => "token", request, timers });
  await assert.rejects(requester(REQUEST, controller.signal), (error) => error === reason);
  assert.equal(calls.length, 3, "nothing is sent after the signal fired");
});

test("stops waiting for a token or an answer when the signal fires, and sends nothing once it has", async () => {
  const hungToken = new AbortController();
  const waitingForToken = createCoordinationRequester({
    url: COORDINATION_URL,
    getToken: () => new Promise(() => {}),
    request: async () => assert.fail("no request without a token"),
  })(REQUEST, hungToken.signal);
  setTimeout(() => hungToken.abort(new Error("time is up")), 10);
  await assert.rejects(waitingForToken, /time is up/);

  // An HTTP client that ignores the signal still releases the requester.
  const hungAnswer = new AbortController();
  const waitingForAnswer = createCoordinationRequester({
    url: COORDINATION_URL,
    getToken: async () => "token",
    request: () => new Promise(() => {}),
  })(REQUEST, hungAnswer.signal);
  setTimeout(() => hungAnswer.abort(new Error("time is up")), 10);
  await assert.rejects(waitingForAnswer, /time is up/);

  const { request, calls } = scripted([ok({ decision: "ok" })]);
  const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => "token", request });
  await assert.rejects(requester(REQUEST, AbortSignal.abort(new Error("already fired"))), /already fired/);
  assert.equal(calls.length, 0);
});

test("a refusal of the route itself throws at once, without a retry, and drops a refused token", async () => {
  const cases = [
    [400, "BAD_REQUEST"], [401, "UNAUTHENTICATED"], [403, "FORBIDDEN"], [403, "COORDINATION_HOST"],
    [404, "NOT_FOUND"], [405, "METHOD_NOT_ALLOWED"], [413, "TOO_LARGE"], [403, "not a code"],
  ];
  for (const [status, error] of cases) {
    const timers = instantTimers();
    const { request, calls } = scripted([{ status, body: { error, message: "Refused." } }]);
    let discarded = 0;
    const getToken = Object.assign(async () => "token", { discard: () => { discarded += 1; } });
    const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken, request, timers });
    const code = /^[A-Z_]+$/.test(error) ? ` ${error}` : "";
    await assert.rejects(requester(REQUEST, signal()), { message: `the disk controller refused the capacity request: HTTP ${status}${code}` });
    assert.equal(calls.length, 1, `HTTP ${status} is not retried`);
    assert.deepEqual(timers.waits, []);
    assert.equal(discarded, status === 401 || status === 403 ? 1 : 0);
  }
});

test("sends the owner's object ID from the tag owner.<object ID> as it is", async () => {
  assert.equal(ownerSubjectFromTag(`owner.${OWNER_B}`), OWNER_B);
  assert.equal(ownerSubjectFromTag("owner.alice"), "alice");
  const { request, calls } = scripted([ok({ decision: "ok" })]);
  const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => "token", request });
  assert.deepEqual(await requester({ ...REQUEST, ownerTag: `owner.${OWNER_B.toUpperCase()}` }, signal()), { decision: "ok" });
  assert.deepEqual(calls[0].body, { ownerOid: OWNER_B.toUpperCase(), rootSessionId: "root-1" });
});

test("an owner whose subject is not an object ID is denied as OWNER_NOT_SUPPORTED, without a token or a request", async () => {
  const subjects = ["alice", "alice@example.test", "12345", ` ${OWNER_A}`, `${OWNER_A} `, `${OWNER_A}.x`, `{${OWNER_A}}`, OWNER_A.slice(1)];
  for (const subject of subjects) {
    const { request, calls } = scripted([ok({ decision: "ok" })]);
    let tokens = 0;
    const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => { tokens += 1; return "token"; }, request });
    assert.deepEqual(await requester({ ...REQUEST, ownerTag: `owner.${subject}` }, signal()), {
      decision: "deny",
      code: "OWNER_NOT_SUPPORTED",
      message: "This session's owner has no Microsoft Entra object ID, so the disk controller can give it no Windows worker. "
        + "Sign in with Microsoft Entra ID to use this deployment's Windows workers.",
    }, subject);
    assert.equal(tokens, 0, "no token is fetched");
    assert.equal(calls.length, 0, "the controller is not asked");
  }
});

test("a missing or malformed owner tag throws, without a token or a request", async () => {
  for (const ownerTag of [undefined, null, 42, "", "owner.", OWNER_A, `Owner.${OWNER_A}`, `group.${OWNER_A}`]) {
    const { request, calls } = scripted([ok({ decision: "ok" })]);
    let tokens = 0;
    const requester = createCoordinationRequester({ url: COORDINATION_URL, getToken: async () => { tokens += 1; return "token"; }, request });
    await assert.rejects(requester({ ...REQUEST, ownerTag }, signal()), /no owner routing tag of the form owner\.<subject>/, String(ownerTag));
    assert.equal(tokens, 0);
    assert.equal(calls.length, 0);
  }
});

test("the token comes from the pod's workload identity for the configured scope, cached until five minutes before it expires", async () => {
  let now = 1_000_000;
  const identity = fakeIdentity([
    { token: "first", expiresOnTimestamp: now + HOUR },
    { token: "second", expiresOnTimestamp: now + 2 * HOUR },
  ]);
  const getToken = createWorkloadIdentityTokenSource({
    scope: SCOPE,
    env: { ...IDENTITY_ENV, AZURE_AUTHORITY_HOST: "https://login.example.test/" },
    importIdentity: identity.importIdentity,
    now: () => now,
  });
  assert.equal(identity.imports(), 0, "nothing loads before the first token");
  assert.deepEqual(await Promise.all([getToken(), getToken()]), ["first", "first"], "one fetch serves concurrent callers");
  assert.deepEqual(identity.made, [{
    clientId: IDENTITY_ENV.AZURE_CLIENT_ID,
    tenantId: IDENTITY_ENV.AZURE_TENANT_ID,
    tokenFilePath: IDENTITY_ENV.AZURE_FEDERATED_TOKEN_FILE,
    authorityHost: "https://login.example.test/",
  }]);
  assert.equal(identity.asked.length, 1);
  assert.equal(identity.asked[0].scope, SCOPE);
  assert.ok(identity.asked[0].abortSignal instanceof AbortSignal);

  now += HOUR - 5 * 60_000 - 1;
  assert.equal(await getToken(), "first");
  assert.equal(identity.asked.length, 1, "cached until five minutes before it expires");
  now += 1;
  assert.equal(await getToken(), "second");
  assert.equal(identity.asked.length, 2);
  assert.equal(identity.made.length, 1, "the credential is kept");
  assert.deepEqual(identity.exportsRead(), ["WorkloadIdentityCredential"], "never managed identity or a credential chain");
});

test("a failed sign-in is not kept, a slow one gives up, and a refused token is dropped for a new credential at most once a minute", async () => {
  let now = 0;
  const identity = fakeIdentity([
    new Error("token exchange failed"),
    { token: "" },
    { token: "first", expiresOnTimestamp: HOUR, refreshAfterTimestamp: HOUR / 2 },
    { token: "second", expiresOnTimestamp: 2 * HOUR },
  ], { failImports: 1 });
  const getToken = createWorkloadIdentityTokenSource({ scope: SCOPE, env: IDENTITY_ENV, importIdentity: identity.importIdentity, now: () => now });
  await assert.rejects(getToken(), /Cannot find package/);
  await assert.rejects(getToken(), /token exchange failed/);
  await assert.rejects(getToken(), /returned no token/);
  assert.equal(await getToken(), "first");
  assert.equal(identity.imports(), 2, "a failed import is tried again");
  getToken.discard();
  assert.equal(await getToken(), "first", "a token younger than a minute stays");
  now += 60_000;
  getToken.discard();
  assert.equal(await getToken(), "second");
  assert.equal(identity.made.length, 2, "a new credential, whose own cache cannot hand the old token back");
  assert.equal(identity.asked.at(-1).credential, 1);

  const refreshing = fakeIdentity([
    { token: "early", expiresOnTimestamp: HOUR, refreshAfterTimestamp: HOUR / 2 },
    { token: "later", expiresOnTimestamp: 2 * HOUR },
  ]);
  now = 0;
  const early = createWorkloadIdentityTokenSource({ scope: SCOPE, env: IDENTITY_ENV, importIdentity: refreshing.importIdentity, now: () => now });
  assert.equal(await early(), "early");
  now = HOUR / 2;
  assert.equal(await early(), "later", "a token is fetched again at its refreshAfterTimestamp");

  let aborted = null;
  const slow = fakeIdentity([(options) => new Promise(() => {
    options.abortSignal.addEventListener("abort", () => { aborted = options.abortSignal.reason; });
  })]);
  const hung = createWorkloadIdentityTokenSource({ scope: SCOPE, env: IDENTITY_ENV, importIdentity: slow.importIdentity, fetchTimeoutMs: 20 });
  await assert.rejects(hung(), /gave no token within 20 ms/);
  assert.match(String(aborted?.message), /within 20 ms/, "the sign-in request is cancelled");
});

test("the token source needs the pod's workload identity settings and a token scope of the controller's app", () => {
  for (const name of Object.keys(IDENTITY_ENV)) {
    assert.throws(
      () => createWorkloadIdentityTokenSource({ scope: SCOPE, env: { ...IDENTITY_ENV, [name]: " " }, importIdentity: () => assert.fail("no import") }),
      new RegExp(`${name} is not set`),
    );
  }
  for (const scope of ["", "11111111-1111-1111-1111-111111111111", "https://management.example.test/.default", `${SCOPE} extra`]) {
    assert.throws(() => createWorkloadIdentityTokenSource({ scope, env: IDENTITY_ENV }), /PS_COORDINATION_TOKEN_SCOPE/, scope);
  }
  assert.doesNotThrow(() => createWorkloadIdentityTokenSource({ scope: "api://11111111-1111-1111-1111-111111111111/.default", env: IDENTITY_ENV }));
});

test("reaches the controller only over https, at an origin and nothing more", async () => {
  const refused = [
    "", "http://pilotswarm-disk-controller-coordination.pilotswarm.svc:3005", "ftp://controller.test", "https://",
    "https://user:secret@controller.test:3005", "https://controller.test:3005/v1", "https://controller.test:3005/?x=1",
    "https://controller.test:3005?", "https://controller.test:3005#top", "controller.test:3005",
  ];
  for (const url of refused) {
    assert.throws(() => createCoordinationRequester({ url, getToken: async () => "token" }), /PS_COORDINATION_URL/, url);
  }
  assert.equal(parseCoordinationUrl(`${COORDINATION_URL}/`), COORDINATION_URL);
  assert.equal(parseCoordinationUrl(" https://10.20.15.250:3005 "), "https://10.20.15.250:3005");
  await assert.rejects(requestJson("http://127.0.0.1:9/v1/coordination/demand", { body: {} }), /only over https/);
});

/** Runs an ES module script in a new Node process with these settings; resolves with its output. */
function runNode(script, settings) {
  const env = { ...process.env };
  for (const name of ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_TEST_CONTEXT"]) delete env[name];
  Object.assign(env, settings);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`node exited with ${code}: ${err}`))));
  });
}

test("checks the controller's certificate: refused without its CA, trusted through NODE_EXTRA_CA_CERTS, and never unchecked", { timeout: 60_000 }, async (t) => {
  const pki = createTestPki();
  const leaf = pki.issueLeaf();
  const seen = [];
  const server = createServer({ cert: leaf.pem, key: leaf.keyPem }, (req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(text || "null") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "ok" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "ps-coordination-tls-"));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const caFile = join(dir, "ca.crt");
  writeFileSync(caFile, pki.caPem);
  const base = `https://127.0.0.1:${server.address().port}`;
  const certificateError = /CERT|VERIFY|SIGNATURE|ISSUER/;

  await assert.rejects(requestJson(`${base}${DEMAND_ROUTE}`, { body: {} }), (error) => certificateError.test(String(error.code)));
  assert.equal(seen.length, 0, "this process does not know the CA");

  const answer = await runNode([
    `import { createCoordinationRequester } from ${JSON.stringify(MODULE.href)};`,
    `const requester = createCoordinationRequester({ url: ${JSON.stringify(base)}, getToken: async () => "coordinator-token" });`,
    `const answer = await requester(${JSON.stringify(REQUEST)}, AbortSignal.timeout(20000));`,
    "console.log(JSON.stringify(answer));",
  ].join("\n"), { NODE_EXTRA_CA_CERTS: caFile });
  assert.deepEqual(JSON.parse(answer), { decision: "ok" });
  assert.deepEqual(seen, [{
    method: "POST",
    url: DEMAND_ROUTE,
    authorization: "Bearer coordinator-token",
    body: { ownerOid: OWNER_A, rootSessionId: "root-1" },
  }]);

  const unchecked = await runNode([
    `import { requestJson } from ${JSON.stringify(MODULE.href)};`,
    "try {",
    `  await requestJson(${JSON.stringify(`${base}${DEMAND_ROUTE}`)}, { body: {} });`,
    "  console.log(\"ANSWERED\");",
    "} catch (error) {",
    "  console.log(String(error.code ?? error.message));",
    "}",
  ].join("\n"), { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  assert.match(unchecked, certificateError, "NODE_TLS_REJECT_UNAUTHORIZED=0 does not turn the check off");
  assert.equal(seen.length, 1);
});

test("loads only Node's built-ins, and @azure/identity only inside the default token source", () => {
  const source = readFileSync(MODULE, "utf8");
  const imported = [
    ...source.matchAll(/^import\s+(?:[^"';]+\s+from\s+)?["']([^"']+)["']/gm),
    ...source.matchAll(/^export\s+[^"';]*\sfrom\s+["']([^"']+)["']/gm),
  ].map((match) => match[1]);
  assert.ok(imported.length > 0);
  for (const specifier of imported) assert.match(specifier, /^node:/, `${specifier} would load with the module`);
  const dynamic = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)];
  assert.deepEqual(dynamic.map((match) => match[1]), ["@azure/identity"]);
  const tokenSource = source.indexOf("export function createWorkloadIdentityTokenSource");
  const next = source.indexOf("\nexport ", tokenSource + 1);
  assert.ok(dynamic[0].index > tokenSource && dynamic[0].index < next, "imported by the default token source, when it first signs in");
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/);
  assert.doesNotMatch(source, /ManagedIdentityCredential|DefaultAzureCredential|169\.254\.169\.254/);
});

test("register() sets only the capacity requester, from the worker's settings: every turn runs here, Portal sessions' too", async () => {
  const worker = fakeWorker();
  const lines = [];
  const { request, calls } = scripted([ok({ decision: "deny", code: "NO_DRIVE_LEASE", message: "No lease." })]);
  const result = await register(worker, { env: { ...ENV, PILOTSWARM_WORKER_OWNER_ONLY: "0" }, log: (line) => lines.push(line) }, {
    getToken: async () => "coordinator-token",
    request,
  });
  assert.equal(worker.requester, result.requester);
  assert.equal(worker.admission, null, "no admission hook: the SDK refuses an owner-routed session's untagged turn itself");
  assert.deepEqual(Object.keys(result).sort(), ["requester", "settings"]);
  assert.ok(!("createSystemOnlyAdmission" in moduleExports) && !("SYSTEM_ONLY_MESSAGE" in moduleExports));
  assert.deepEqual(result.settings, { url: COORDINATION_URL, scope: SCOPE });
  assert.deepEqual(await worker.requester(REQUEST, signal()), { decision: "deny", message: "No lease.", code: "NO_DRIVE_LEASE" });
  assert.equal(calls[0].url, `${COORDINATION_URL}${DEMAND_ROUTE}`);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pilotswarm-disk-controller-coordination\.pilotswarm\.svc:3005\/v1\/coordination\/demand/);
  assert.doesNotMatch(lines[0], /coordinator-token|only system sessions/);
});

test("register() signs in with the pod's workload identity by default, at the first capacity request", async () => {
  const worker = fakeWorker();
  const identity = fakeIdentity([{ token: "workload-token", expiresOnTimestamp: Date.now() + HOUR }]);
  const { request, calls } = scripted([ok({ decision: "ok" })]);
  await register(worker, { env: ENV, log: () => {} }, { importIdentity: identity.importIdentity, request });
  assert.equal(identity.imports(), 0);
  assert.deepEqual(await worker.requester(REQUEST, signal()), { decision: "ok" });
  assert.equal(calls[0].headers.authorization, "Bearer workload-token");
  assert.equal(identity.asked[0].scope, SCOPE);
  assert.equal(identity.made[0].clientId, IDENTITY_ENV.AZURE_CLIENT_ID);
});

test("register() refuses before it sets a hook: a missing or bad URL or scope, an owner's worker, an older worker, or no workload identity", async () => {
  const cases = [
    [{ PS_COORDINATION_URL: "" }, /PS_COORDINATION_URL is required/],
    [{ PS_COORDINATION_URL: "http://pilotswarm-disk-controller-coordination.pilotswarm.svc:3005" }, /PS_COORDINATION_URL must be an https/],
    [{ PS_COORDINATION_URL: `${COORDINATION_URL}${DEMAND_ROUTE}` }, /PS_COORDINATION_URL must be/],
    [{ PS_COORDINATION_TOKEN_SCOPE: undefined }, /PS_COORDINATION_TOKEN_SCOPE is required/],
    [{ PS_COORDINATION_TOKEN_SCOPE: "11111111-1111-1111-1111-111111111111" }, /PS_COORDINATION_TOKEN_SCOPE must be/],
    [{ PILOTSWARM_WORKER_OWNER_TAG: OWNER_TAG }, /PILOTSWARM_WORKER_OWNER_TAG/],
    [{ PILOTSWARM_WORKER_OWNER_ONLY: "1" }, /PILOTSWARM_WORKER_OWNER_ONLY=1/],
    [{ PILOTSWARM_WORKER_OWNER_ONLY: "true" }, /PILOTSWARM_WORKER_OWNER_ONLY=true/],
    [{ AZURE_FEDERATED_TOKEN_FILE: "" }, /AZURE_FEDERATED_TOKEN_FILE is not set/],
    [{ AZURE_CLIENT_ID: undefined, AZURE_TENANT_ID: undefined }, /AZURE_CLIENT_ID, AZURE_TENANT_ID are not set/],
  ];
  for (const [overrides, message] of cases) {
    const env = { ...ENV, ...overrides };
    for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
    const worker = fakeWorker();
    await assert.rejects(register(worker, { env, log: () => {} }), message, JSON.stringify(overrides));
    assert.equal(worker.requester, null);
    assert.equal(worker.admission, null);
  }
  const older = { setSessionAdmission: () => assert.fail("no hook on a worker it cannot fully set up") };
  await assert.rejects(register(older, { env: ENV, log: () => {} }, { getToken: async () => "token" }), /needs a PilotSwarm worker with setOwnerCapacityRequester/);
});

// ── against the disk controller ──────────────────────────────────────

/** The requester's HTTP client, answered by the controller's coordination listener in this process. */
function throughController(h) {
  const calls = [];
  const request = async (url, { method, headers, body }) => {
    const { origin, pathname } = new URL(url);
    calls.push({ origin, pathname });
    const token = /^Bearer (.+)$/.exec(headers?.authorization ?? "")?.[1];
    const answer = await h.call("coordination", method, pathname, { token, body });
    return { status: answer.status, body: answer.body };
  };
  return { request, calls };
}

async function leased(h, { owner = OWNER_A, workId, rootSessionId }) {
  if (!h.state.all("disk").some((disk) => disk.state === "AvailableInPool")) await h.spares();
  assert.equal((await h.claim({ ownerOid: owner, workId, rootSessionId })).body.decision, "ok");
}

test("against the disk controller: ok for a leased root, deny without a lease, busy for a parked one, no request for an owner it cannot serve, and a token without the coordinator role is refused", async () => {
  const h = await createHarness();
  await leased(h, { workId: "work-1", rootSessionId: "root-1" });
  await leased(h, { workId: "parked", rootSessionId: "root-parked" });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "parked" });
  const { request, calls } = throughController(h);
  let token = TOKENS.coordinator;
  const worker = fakeWorker();
  await register(worker, { env: ENV, log: () => {} }, { getToken: async () => token, request });
  const ask = (rootSessionId, ownerTag = OWNER_TAG) => worker.requester({ sessionId: rootSessionId, rootSessionId, ownerTag }, signal());

  assert.deepEqual(await ask("root-1"), { decision: "ok" });
  const counted = h.state.get("controller", "controller").demand.find((entry) => entry.rootSessionId === "root-1");
  assert.deepEqual({ owner: counted?.ownerOid, kind: counted?.kind }, { owner: OWNER_A, kind: "coordination" }, "counted as the coordination host's demand");

  const unleased = { decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive of this owner." };
  assert.deepEqual(await ask("no-lease"), unleased);
  assert.deepEqual(await ask("root-1", `owner.${OWNER_B}`), unleased, "another owner's root");
  assert.deepEqual(await ask("root-parked"), { decision: "busy", code: "WORKSPACE_BUSY", message: "Dev Drive is parked for local work", retryAfterMs: 900_000 });

  // The controller refuses an owner that is not an object ID; the requester denies it without asking.
  assert.equal((await h.coordination({ ownerOid: "alice", rootSessionId: "root-1" })).status, 400);
  const asked = calls.length;
  assert.deepEqual(await ask("root-1", "owner.alice"), {
    decision: "deny",
    code: "OWNER_NOT_SUPPORTED",
    message: "This session's owner has no Microsoft Entra object ID, so the disk controller can give it no Windows worker. "
      + "Sign in with Microsoft Entra ID to use this deployment's Windows workers.",
  });
  assert.equal(calls.length, asked);

  const sent = calls.length;
  token = TOKENS.worker;
  await assert.rejects(ask("root-1"), /refused the capacity request: HTTP 403 FORBIDDEN/);
  token = TOKENS.invalid;
  await assert.rejects(ask("root-1"), /refused the capacity request: HTTP 401 UNAUTHENTICATED/);
  assert.equal(calls.length, sent + 2, "one call each, no retry");
  assert.ok(calls.every((call) => call.origin === COORDINATION_URL && call.pathname === DEMAND_ROUTE));
});
