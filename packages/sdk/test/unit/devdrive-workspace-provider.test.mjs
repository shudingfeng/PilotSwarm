/**
 * The Dev Drive workspace extension (examples/devdrive-workspaces, README).
 * A fake disk controller, a fake attacher and a fake volume stand in for the
 * VM; the worker is a real, never-started PilotSwarmWorker, so take-backs,
 * check attaches and shutdown releases go through PilotSwarm's own
 * SessionManager. The Git tests use real repositories in temporary folders,
 * with local bare repositories, or a local server that never answers, as
 * remotes.
 *
 *   D1  startup: the settings, child workspace inheritance, the token module
 *       and the CA, the heartbeat and its take-over, the clean start
 *   D2  the LUN 0 mutex, the fast path, and the folder set
 *   D3  take-backs: tryReleaseIdleWorkspace without a WIP push, a third
 *       session, a late release, anti-ping-pong, a busy holder, another owner
 *   D4  check attaches
 *   D5  the controller's release requests (return, park, move)
 *   D6  orphans
 *   D7  shutdown
 *   D8  online growth
 *   D9  the binding restart
 *   D10 crash recovery (Git)
 *   D11 the WIP push (Git)
 *   D12 back from local work: the branch sync (Git)
 *   D13 admission, the credential broker and capacity requests
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { checkWorkspaceForSpawn } from "../../dist/workspace.js";
import { askOwnerCapacityRequester } from "../../dist/owner-routing.js";
import { PersonalCredentialError } from "../../dist/personal-secret-store.js";
import { parseWipPrefix, register, settingsFromEnv } from "../../examples/devdrive-workspaces/index.mjs";
import { createDiskPoolClient, fetchWorkCredential, loadTokenModule, useDiskPoolClient } from "../../examples/devdrive-workspaces/disk-pool-client.mjs";
import { createAttacherClient } from "../../examples/devdrive-workspaces/attacher-client.mjs";
import { CLEAN_TIPS_FILE, SYNCED_FILE, applySync, createGitRunner } from "../../examples/devdrive-workspaces/git-repos.mjs";
import { HEARTBEAT_HANDOVER } from "../../examples/devdrive-workspaces/heartbeat.mjs";

const GIB = 1024 ** 3;
const OWNER = "0b8f6c2e-4d1a-4c5e-9f3b-2a7d8e9c1f00";
const DISK = (n) => `psdrive-${String(n).padStart(12, "0")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function waitFor(check, { timeoutMs = 10_000, message = "condition" } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await check()) return;
        await sleep(10);
    }
    assert.fail(`timed out waiting for ${message}`);
}

/**
 * A disk controller for one VM: leases by root session, the VM's attach
 * record, and the heartbeat answer's fields. `once(route, fn)` lets the next
 * call of a route go through `fn` first (an undefined result falls through).
 */
function fakeController({ leases = {} } = {}) {
    const state = {
        leases: new Map(Object.entries(leases).map(([root, lease]) => [root, { takeover: false, needsFsck: false, sync: null, state: "active", ...lease }])),
        attached: null,
        ownerOid: null,
        releaseRequested: null,
        extendRequested: null,
        admit: () => ({ decision: "admit" }),
        demand: () => ({ decision: "ok" }),
        model: () => ({ status: "ok", token: "model-token-from-broker" }),
        work: () => ({ status: "ok", credential: "work-credential-from-broker" }),
    };
    const calls = [];
    const overrides = new Map();
    const ok = (body) => ({ status: 200, body });
    // A handler may answer { status, body } itself, for example a 503.
    const raw = (answer) => (typeof answer?.status === "number" && "body" in answer ? answer : ok(answer));
    const routes = {
        "/v1/vms/heartbeat": () => ok({
            ownerOid: state.ownerOid,
            attached: state.attached ? { ...state.attached, state: "attached" } : null,
            releaseRequested: state.releaseRequested,
            extendRequested: state.extendRequested,
        }),
        "/v1/leases/attach": (body) => {
            const lease = state.leases.get(body.rootSessionId);
            if (!lease) return ok({ ok: false, code: "NO_DRIVE_LEASE", retryable: false, message: "This root session holds no Dev Drive." });
            if (lease.state === "parked" || lease.state === "returning") {
                return ok({ ok: false, code: "WORKSPACE_BUSY", reason: lease.state.toUpperCase(), retryAfterMs: 900_000, message: `Dev Drive is ${lease.state}` });
            }
            if (state.attached && state.attached.diskName !== lease.diskName) {
                return ok({ ok: false, code: "WORKSPACE_BUSY", reason: "LUN_BUSY", retryAfterMs: 10_000, message: "This VM holds another drive at LUN 0." });
            }
            // The holder's own attach for the same root cancels a move.
            if (state.releaseRequested?.diskName === lease.diskName && state.releaseRequested.reason === "move") state.releaseRequested = null;
            state.attached = { diskName: lease.diskName, rootSessionId: body.rootSessionId };
            return ok({ ok: true, diskName: lease.diskName, lun: 0, takeover: lease.takeover, needsFsck: lease.needsFsck, sync: lease.sync });
        },
        "/v1/leases/detach": (body) => {
            if (state.attached?.diskName === body.diskName) state.attached = null;
            for (const lease of state.leases.values()) {
                if (lease.diskName !== body.diskName) continue;
                if (body.crashed) lease.needsFsck = true;
                else { lease.needsFsck = false; lease.takeover = false; }
            }
            if (state.releaseRequested?.diskName === body.diskName) state.releaseRequested = null;
            return ok({ ok: true, detached: true });
        },
        "/v1/vms/busy": () => ok({ decision: "ok" }),
        "/v1/vms/admit": (body) => raw(state.admit(body)),
        "/v1/vms/demand": (body) => raw(state.demand(body)),
        "/v1/credentials/model": (body) => raw(state.model(body)),
        "/v1/credentials/work": (body) => raw(state.work(body)),
    };
    async function request(url, { headers = {}, body } = {}) {
        const route = new URL(url).pathname;
        calls.push({ route, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), authorization: headers.authorization });
        const queue = overrides.get(route);
        if (queue && queue.length > 0) {
            const result = await queue.shift()(body);
            if (result !== undefined) return result;
        }
        return routes[route] ? routes[route](body) : { status: 404, body: { error: "NOT_FOUND" } };
    }
    return {
        state,
        calls,
        request,
        once(route, fn) {
            if (!overrides.has(route)) overrides.set(route, []);
            overrides.get(route).push(fn);
        },
        of: (route) => calls.filter((call) => call.route === route),
    };
}

/** The VM's attacher; `once(route, fn)` as for the controller. Tracks how many calls overlap. */
function fakeAttacher() {
    const calls = [];
    const overrides = new Map();
    let inFlight = 0;
    let maxInFlight = 0;
    async function request(url, { headers = {}, body } = {}) {
        const route = new URL(url).pathname;
        calls.push({ route, body: JSON.parse(JSON.stringify(body ?? {})), authorization: headers.authorization });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            const queue = overrides.get(route);
            if (queue && queue.length > 0) {
                const result = await queue.shift()(body);
                if (result !== undefined) return result;
            }
            return { status: 200, body: { ok: true } };
        } finally {
            inFlight -= 1;
        }
    }
    return {
        calls,
        request,
        once(route, fn) {
            if (!overrides.has(route)) overrides.set(route, []);
            overrides.get(route).push(fn);
        },
        routes: () => calls.map((call) => call.route),
        get maxInFlight() { return maxInFlight; },
    };
}

/** The drive's repositories, without Git: what the provider asked for. */
function fakeRepos() {
    const calls = [];
    const repos = {
        calls,
        recover: async () => ({ ok: true, notice: "The drive was checked after a crash." }),
        applied: null,
        ops: {
            writeCleanRecord: async () => { calls.push("record"); return { ok: true, failures: [] }; },
            pushWip: async ({ wipBranch }) => { calls.push(`push ${wipBranch}`); return { ok: true, pushed: [], failed: [], skipped: [] }; },
            recoverAfterCrash: async (args) => { calls.push("recover"); return repos.recover(args); },
            findAppliedSync: async (syncId) => (repos.applied?.syncId === syncId ? repos.applied : null),
            applySync: async ({ sync }) => {
                calls.push(`sync ${sync.syncId}`);
                repos.applied = { syncId: sync.syncId, headSha: sync.headSha };
                return { ok: true, applied: repos.applied, notice: "synced" };
            },
        },
    };
    return repos;
}

function newWorker(home) {
    return new PilotSwarmWorker({ sessionStateDir: path.join(home, "sessions"), disableManagementAgents: true, workerNodeId: "worker-1" });
}

/**
 * A registered extension on a never-started worker, with the fakes. The
 * drive's volume is a folder; its root "repos" holds the folders `folders`.
 */
async function harness(t, {
    leases = {}, env = {}, repos = null, runGit = null, folders = ["app", "lib"], providerOptions = {},
    heartbeatIntervalMs = 3_600_000, attached = null, home: givenHome = null, worker: givenWorker = null, timers = null,
} = {}) {
    const home = givenHome ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-")));
    const reposRoot = path.join(home, "Q", "Repos");
    for (const folder of folders) fs.mkdirSync(path.join(reposRoot, folder), { recursive: true });
    // A path with a space: the token module is imported by its file URL.
    const tokenModule = path.join(home, "controller token.mjs");
    fs.writeFileSync(tokenModule, "let n = 0;\nexport async function getToken() { n += 1; return `controller-token-${n}`; }\n");
    const attacherTokenFile = path.join(home, "attacher.token");
    fs.writeFileSync(attacherTokenFile, "attacher-token-1\n");
    const controller = fakeController({ leases });
    if (attached) controller.state.attached = attached;
    const attacher = fakeAttacher();
    const fake = repos ?? fakeRepos();
    const worker = givenWorker ?? newWorker(home);
    const logs = [];
    const fullEnv = {
        PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE: "1",
        PS_DISK_POOL_CONTROLLER_URL: "https://controller.test:3003",
        PS_DISK_CONTROLLER_TOKEN_MODULE: tokenModule,
        PS_DISK_ATTACHER_TOKEN_FILE: attacherTokenFile,
        PS_WORKSPACE_ROOTS: `repos=${reposRoot}`,
        PS_LAUNCH_ID: "launch-1",
        WIN_WORKER_CONFIG_VERSION: "cfg-7",
        ...env,
    };
    for (const [key, value] of Object.entries(fullEnv)) if (value === undefined) delete fullEnv[key];
    const ext = await register(worker, { env: fullEnv, log: (message) => logs.push(message) }, {
        platform: "win32",
        controllerOptions: { request: controller.request },
        attacherOptions: { request: attacher.request },
        ...(runGit ? { runGit } : { repos: fake.ops }),
        volumeInfo: async () => ({ sizeBytes: 1024 * GIB, freeBytes: 700 * GIB }),
        heartbeatIntervalMs,
        providerOptions: { freeBackoffMs: [5, 10, 20], onlineRetryMs: 1, shutdownWaitMs: 2_000, ...providerOptions },
        ...(timers ? { timers } : {}),
    });
    t.after(async () => {
        await ext.heartbeat.stop();
        await ext.drive.shutdown();
        // A test that failed may leave a fake blocked; the teardown never waits for it.
        await Promise.race([ext.drive.settle(), sleep(3_000)]);
        useDiskPoolClient(null);
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const h = {
        home, reposRoot, controller, attacher, repos: fake, worker, ext, logs, env: fullEnv,
        provider: ext.drive.provider,
        req(sessionId, folder, extra = {}) {
            return {
                sessionId,
                rootSessionId: extra.rootSessionId ?? sessionId,
                workspace: { schema: 1, root: "repos", ...(folder ? { folder } : {}) },
                revision: 1,
                workerNodeId: "worker-1",
                turnIndex: extra.turnIndex ?? 1,
                purpose: extra.purpose ?? "turn",
                ...(extra.attachment ? { attachment: extra.attachment } : {}),
            };
        },
        admit(rootSessionId, sessionId = rootSessionId) {
            return worker.sessionManager.getSessionAdmission()({ sessionId, rootSessionId, isSystem: false });
        },
        /** A turn's attach, after which PilotSwarm holds the folder, as the turn preamble does. */
        async turn(sessionId, folder, extra = {}) {
            const req = h.req(sessionId, folder, extra);
            const result = await h.provider.ensureAttached(req);
            worker.sessionManager.holdWorkspaceFolders(sessionId, [{
                root: "repos", ...(folder ? { folder } : {}), ...(extra.attachment ? { attachment: extra.attachment } : {}),
                rootSessionId: req.rootSessionId, revision: 1, turnIndex: req.turnIndex,
            }]);
            return result;
        },
        /** A running turn or task holds the session: tryReleaseIdleWorkspace answers busy. */
        busySession(sessionId) {
            worker.sessionManager.sessionLocks.set(sessionId, new Promise(() => {}));
            return () => worker.sessionManager.sessionLocks.delete(sessionId);
        },
        async heartbeat() {
            const answer = await ext.heartbeat.beat();
            await ext.drive.settle();
            return answer;
        },
        mounted: () => ext.drive.state().mounted,
        detaches: () => controller.of("/v1/leases/detach").map((call) => call.body),
    };
    return h;
}

describe("D1 startup", () => {
    it("register() refuses to load without PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1, and on another platform", async (t) => {
        const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-reg-")));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const controller = fakeController();
        const env = {
            PS_DISK_POOL_CONTROLLER_URL: "https://controller.test:3003",
            PS_DISK_CONTROLLER_TOKEN_MODULE: path.join(home, "missing.mjs"),
            PS_WORKSPACE_ROOTS: `repos=${path.join(home, "Q", "Repos")}`,
        };
        const deps = { platform: "win32", controllerOptions: { request: controller.request }, repos: fakeRepos().ops };
        for (const value of [undefined, "0", "true"]) {
            const worker = newWorker(home);
            await assert.rejects(
                register(worker, { env: { ...env, ...(value === undefined ? {} : { PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE: value }) }, log: () => {} }, deps),
                /PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1/,
            );
            assert.equal(worker.sessionManager.getWorkspaceProvider(), null, "no provider is set");
            assert.equal(worker.sessionManager.getSessionAdmission(), null, "no admission hook is set");
        }
        assert.equal(controller.calls.length, 0, "nothing reached the controller");
        await assert.rejects(
            register(newWorker(home), { env: { ...env, PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE: "1" }, log: () => {} }, { ...deps, platform: "linux" }),
            /Windows workers only/,
        );
        await assert.rejects(
            register({ setWorkspaceProvider() {} }, { env: { ...env, PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE: "1" }, log: () => {} }, deps),
            /needs a PilotSwarm worker with setSessionAdmission, .*tryReleaseIdleWorkspace/,
        );
    });

    it("the settings: defaults, one volume, adopt and a WIP prefix that makes a valid branch", () => {
        const settings = settingsFromEnv({});
        assert.deepEqual(settings.roots, [{ name: "repos", path: "Q:\\Repos" }]);
        assert.deepEqual(settings.adopt, { agents: true, skills: true, instructions: true });
        assert.equal(settings.wipPrefix, "pilotswarm/wip/");
        assert.equal(settings.attacherUrl, "http://127.0.0.1:3099");
        assert.equal(settings.ownerOnly, false);
        assert.match(settings.launchId, /^[0-9a-f-]{36}$/, "a new launch ID when PS_LAUNCH_ID is unset");
        assert.equal(settingsFromEnv({ PS_WORKSPACE_ADOPT: "none" }).adopt, null);
        assert.equal(settingsFromEnv({ PS_WIP_BRANCH_PREFIX: "team/wip/" }).wipPrefix, "team/wip/");
        assert.equal(settings.attachBudgetMs, null, "the provider's own 10 minutes");
        assert.equal(settingsFromEnv({ PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS: "600000" }).attachBudgetMs, 600_000, "the worker's attach deadline");
        for (const bad of ["../x/", "-x/", "a//b/", "a b/", "a..b/"]) assert.throws(() => parseWipPrefix(bad), /not a valid branch name prefix/, bad);
        assert.throws(() => settingsFromEnv({ PS_WORKSPACE_ADOPT: "hooks" }), /PS_WORKSPACE_ADOPT/);
        if (process.platform === "win32") {
            assert.throws(() => settingsFromEnv({ PS_WORKSPACE_ROOTS: "a=Q:\\A,b=C:\\B" }), /Dev Drive's volume/);
        }
    });

    it("every controller call gets a token from the token module, imported by its file URL", async (t) => {
        const h = await harness(t);
        // Node's ESM loader refuses a bare Windows path; the module loaded through its file URL.
        if (process.platform === "win32") await assert.rejects(import(h.env.PS_DISK_CONTROLLER_TOKEN_MODULE));
        const getToken = await loadTokenModule(h.env.PS_DISK_CONTROLLER_TOKEN_MODULE);
        assert.equal(typeof getToken, "function");
        await h.heartbeat();
        await h.admit("R1");
        const tokens = h.controller.calls.map((call) => call.authorization);
        assert.equal(tokens.length, 3);
        assert.deepEqual(tokens, ["Bearer controller-token-1", "Bearer controller-token-2", "Bearer controller-token-3"], "asked before each call");
    });

    it("each TLS agent trusts only the CA file, read again for every agent", async (t) => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-ca-"));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const caFile = path.join(home, "ca.crt");
        const agents = [];
        const client = createDiskPoolClient({
            url: "https://10.0.0.1:3003",
            getToken: () => "t",
            caCertPath: caFile,
            request: async (url, { agent }) => { agents.push(agent); return { status: 200, body: {} }; },
        });
        fs.writeFileSync(caFile, "CA ONE");
        await client.heartbeat({});
        fs.writeFileSync(caFile, "CA TWO");
        await client.heartbeat({});
        assert.equal(agents.length, 2);
        assert.notEqual(agents[0], agents[1], "a new agent per call");
        assert.equal(String(agents[0].options.ca), "CA ONE");
        assert.equal(String(agents[1].options.ca), "CA TWO", "a rotated CA is used at the next call");
        assert.throws(() => createDiskPoolClient({ url: "http://10.0.0.1:3003", getToken: () => "t" }), /https/);
    });

    it("the attacher is reached only on a loopback address, and its token file is read again after a 401", async (t) => {
        assert.throws(() => createAttacherClient({ url: "http://10.0.0.5:3099" }), /loopback/);
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-att-"));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const tokenFile = path.join(home, "attacher.token");
        fs.writeFileSync(tokenFile, "first\n");
        let accepted = "Bearer first";
        const seen = [];
        const client = createAttacherClient({
            tokenFile,
            request: async (url, { headers }) => {
                seen.push(headers.authorization);
                return headers.authorization === accepted ? { status: 200, body: { ok: true } } : { status: 401, body: {} };
            },
        });
        await client.offlineLun0({ diskName: DISK(1) });
        // The attacher started again with a new token.
        fs.writeFileSync(tokenFile, "second\n");
        accepted = "Bearer second";
        await client.onlineLun0({ diskName: DISK(1) });
        assert.deepEqual(seen, ["Bearer first", "Bearer first", "Bearer second"]);
    });

    it("the heartbeat carries PS_LAUNCH_ID and the VM's state, and takes over the launcher's heartbeat", async (t) => {
        const order = [];
        globalThis[HEARTBEAT_HANDOVER] = { stop: async () => { order.push("launcher stopped"); } };
        t.after(() => { delete globalThis[HEARTBEAT_HANDOVER]; });
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        const first = h.controller.of("/v1/vms/heartbeat");
        assert.equal(first.length, 1, "the first heartbeat is sent in register()");
        assert.deepEqual(order, ["launcher stopped"], "the launcher's heartbeat stops after the extension's first");
        assert.equal(globalThis[HEARTBEAT_HANDOVER], undefined, "the hand-over slot is emptied");
        assert.deepEqual(first[0].body, {
            vmName: os.hostname(), launchId: "launch-1", phase: "running", attachedDisk: null, attachedDiskSizeBytes: null,
            attachedDiskFreeBytes: null, activeWorkloadCount: 0, draining: false, configVersion: "cfg-7", syncId: null, syncedHeadSha: null,
        });
        await h.admit("R1");
        assert.equal((await h.turn("R1", "app")).ok, true);
        const done = h.busySession("other");
        await h.heartbeat();
        done();
        const body = h.controller.of("/v1/vms/heartbeat").at(-1).body;
        assert.equal(body.attachedDisk, DISK(1));
        assert.equal(body.attachedDiskSizeBytes, 1024 * GIB);
        assert.equal(body.attachedDiskFreeBytes, 700 * GIB);
        assert.equal(body.activeWorkloadCount, 1, "worker.getActiveWorkloadCount()");
    });

    it("without PS_LAUNCH_ID, the heartbeat carries a new launch ID for this start", async (t) => {
        const h = await harness(t, { env: { PS_LAUNCH_ID: undefined } });
        const launchId = h.controller.of("/v1/vms/heartbeat")[0].body.launchId;
        assert.match(launchId, /^[0-9a-f-]{36}$/);
        await h.heartbeat();
        assert.equal(h.controller.of("/v1/vms/heartbeat")[1].body.launchId, launchId, "the same ID for the whole start");
    });

    it("a clean start frees a drive at LUN 0 as an orphan: offline, then a crashed detach, before any attach and with no record", async (t) => {
        const leases = { R1: { diskName: DISK(1) } };
        const h = await harness(t, { leases, attached: { diskName: DISK(9), rootSessionId: "gone" } });
        // An attach right away waits for the cleanup that the first heartbeat started.
        await h.admit("R1");
        const attached = await h.turn("R1", "app");
        assert.equal(attached.ok, true);
        assert.deepEqual(h.attacher.routes(), ["/offline-lun0", "/online-lun0"]);
        assert.deepEqual(h.detaches(), [{ diskName: DISK(9), rootSessionId: "gone", requestId: h.detaches()[0].requestId, crashed: true }]);
        assert.equal(h.attacher.calls[0].body.workerPid, process.pid, "the attacher spares the worker's own process");
        assert.deepEqual(h.repos.calls, [], "an orphan cleanup writes no clean-detach record and pushes nothing");
    });
});

describe("D2 the LUN 0 mutex, the fast path and the folder set", () => {
    it("attaches and releases on LUN 0 never overlap", async (t) => {
        const leases = { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } };
        const h = await harness(t, { leases });
        await h.admit("R1");
        await h.admit("R2");
        const online = deferred();
        h.attacher.once("/online-lun0", () => online.promise);
        const first = h.provider.ensureAttached(h.req("R1", "app"));
        await flush();
        const second = h.provider.ensureAttached(h.req("R2", "app"));
        await sleep(30);
        assert.equal(h.controller.of("/v1/leases/attach").length, 1, "the second attach waits for the first");
        online.resolve();
        assert.equal((await first).ok, true);
        // R1 is held by nothing here (no turn followed): R2 frees it as an orphan, then attaches.
        assert.equal((await second).ok, true);
        assert.deepEqual(h.attacher.routes(), ["/online-lun0", "/offline-lun0", "/online-lun0"]);
        assert.equal(h.attacher.maxInFlight, 1, "one LUN 0 call at a time");
        assert.equal(h.mounted().rootSessionId, "R2");
    });

    it("an attach that waited for LUN 0 past its deadline starts nothing", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } }, providerOptions: { attachBudgetMs: 100 } });
        await h.turn("R1", "app");
        const offline = deferred();
        h.attacher.once("/offline-lun0", () => offline.promise);
        const releasing = h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        await waitFor(() => h.attacher.routes().includes("/offline-lun0"), { message: "the offline" });
        const waiting = h.provider.ensureAttached(h.req("R2", "app"));
        await sleep(200);
        offline.resolve();
        await releasing;
        const result = await waiting;
        assert.deepEqual([result.ok, result.code], [false, "WORKSPACE_ATTACH_TIMEOUT"]);
        assert.equal(h.controller.of("/v1/leases/attach").length, 1, "only R1's attach reached the controller");
    });

    it("a turn of the session that holds the drive reattaches at once, without the controller or the attacher", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        await h.turn("R1", "app");
        const before = [h.controller.calls.length, h.attacher.calls.length];
        const started = performance.now();
        const again = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }));
        const elapsed = performance.now() - started;
        assert.deepEqual(again, { ok: true, path: path.join(h.reposRoot, "app"), adopt: { agents: true, skills: true, instructions: true } });
        assert.deepEqual([h.controller.calls.length, h.attacher.calls.length], before);
        assert.ok(elapsed < 50, `the fast path took ${elapsed} ms`);
        assert.equal(h.controller.of("/v1/leases/attach")[0].body.purpose, "turn", "every attach passes its purpose");
    });

    it("releasing one of two held folders keeps the drive; releasing the last one pushes, records, takes LUN 0 offline and detaches", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        await h.turn("R1", "app");
        await h.turn("R1", "lib", { attachment: "lib" });
        await h.provider.release({ ...h.req("R1", "lib", { attachment: "lib" }), reason: "changed" });
        assert.equal(h.mounted().diskName, DISK(1), "one folder is still held");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0"]);
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        assert.equal(h.mounted(), null);
        assert.deepEqual(h.repos.calls, ["push pilotswarm/wip/R1", "record"], "the WIP push, then the record right before the offline");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0", "/offline-lun0"]);
        assert.equal(h.detaches()[0].crashed, false);
        assert.equal(h.detaches()[0].rootSessionId, "R1");
    });
});

describe("D3 take-backs", () => {
    async function heldBy(t, holder = "R1", extra = {}) {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) }, R3: { diskName: DISK(3) } }, ...extra });
        for (const root of ["R1", "R2", "R3"]) await h.admit(root);
        assert.equal((await h.turn(holder, "app")).ok, true);
        return h;
    }

    it("takes the drive back from an idle holder through tryReleaseIdleWorkspace, with no WIP push", async (t) => {
        const h = await heldBy(t);
        const tries = t.mock.method(h.worker, "tryReleaseIdleWorkspace");
        const result = await h.turn("R2", "app");
        assert.equal(result.ok, true);
        assert.deepEqual(tries.mock.calls.map((call) => call.arguments), [["R1", { reason: "moved", releaseTimeoutMs: 60_000 }]]);
        assert.deepEqual(h.repos.calls, ["record"], "the record, but no WIP push");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0", "/offline-lun0", "/online-lun0"]);
        assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(1), false]]);
        assert.equal(h.mounted().rootSessionId, "R2");
        assert.equal(h.ext.drive.state().lastPreemptedSessionId, "R1");
    });

    it("a third session arriving during a take-back is busy, and the taken session still pushes nothing", async (t) => {
        const h = await heldBy(t);
        const offline = deferred();
        h.attacher.once("/offline-lun0", () => offline.promise);
        const taking = h.turn("R2", "app");
        await waitFor(() => h.attacher.routes().includes("/offline-lun0"), { message: "the holder's offline" });
        const third = h.provider.ensureAttached(h.req("R3", "app"));
        offline.resolve();
        const [taken, refused] = await Promise.all([taking, third]);
        assert.equal(taken.ok, true);
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "WORKSPACE_BUSY");
        assert.ok(refused.retryAfterMs > 0);
        assert.equal(h.mounted().rootSessionId, "R2", "the taking session got the drive");
        assert.ok(!h.repos.calls.some((call) => call.startsWith("push")), "no WIP push");
    });

    it("a late release of the taken session does nothing while the new one works on the drive", async (t) => {
        const h = await heldBy(t);
        await h.turn("R2", "app");
        const before = [h.attacher.calls.length, h.controller.calls.length, h.repos.calls.length];
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        assert.deepEqual([h.attacher.calls.length, h.controller.calls.length, h.repos.calls.length], before);
        assert.equal(h.mounted().rootSessionId, "R2");
    });

    it("a late release of the taken session never detaches the next drive, even one that holds no folder yet", async (t) => {
        const h = await heldBy(t);
        // R2's drive is mounted, but its first attach failed its crash check: no folder of it is held.
        h.controller.state.leases.get("R2").takeover = true;
        h.repos.recover = async () => ({ ok: false, message: "the check ran out of time", retryAfterMs: 1_000 });
        const failed = await h.turn("R2", "app");
        assert.equal(failed.code, "WORKSPACE_ATTACH_FAILED");
        assert.deepEqual(h.mounted().folders, []);
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        assert.equal(h.mounted()?.diskName, DISK(2), "R1's release does not touch R2's drive");
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(1)]);
    });

    it("anti-ping-pong: the session just taken back gets busy and asks for another VM through /v1/vms/busy", async (t) => {
        const h = await heldBy(t);
        await h.turn("R2", "app");
        const result = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }));
        assert.equal(result.code, "WORKSPACE_BUSY");
        await waitFor(() => h.controller.of("/v1/vms/busy").length === 1, { message: "/v1/vms/busy" });
        assert.deepEqual(h.controller.of("/v1/vms/busy")[0].body, { rootSessionId: "R1" });
        assert.equal(h.mounted().rootSessionId, "R2", "no ping-pong");
    });

    it("a busy holder keeps its drive; the newcomer gets busy and asks for another VM", async (t) => {
        const h = await heldBy(t);
        const done = h.busySession("R1");
        const result = await h.turn("R2", "app");
        done();
        assert.equal(result.code, "WORKSPACE_BUSY");
        await waitFor(() => h.controller.of("/v1/vms/busy").length === 1, { message: "/v1/vms/busy" });
        assert.deepEqual(h.controller.of("/v1/vms/busy")[0].body, { rootSessionId: "R2" });
        assert.equal(h.mounted().rootSessionId, "R1");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0"]);
    });

    it("a session this VM did not admit (another owner's) never takes the drive", async (t) => {
        const h = await heldBy(t);
        const tries = t.mock.method(h.worker, "tryReleaseIdleWorkspace");
        const result = await h.provider.ensureAttached(h.req("R9", "app"));
        assert.equal(result.code, "WORKSPACE_BUSY");
        assert.equal(tries.mock.callCount(), 0, "no take-back");
        await flush();
        assert.equal(h.controller.of("/v1/vms/busy").length, 0);
        assert.equal(h.mounted().rootSessionId, "R1");
    });

    it("renaming an extra folder, then a take-back, still detaches the drive", async (t) => {
        const h = await heldBy(t);
        await h.turn("R1", "lib", { attachment: "docs" });
        await h.turn("R1", "lib", { attachment: "notes" });
        assert.equal(h.mounted().folders.length, 2, "a rename keeps the folder's key");
        assert.equal((await h.turn("R2", "app")).ok, true);
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(1)]);
    });

    it("a parked or returning drive answers WORKSPACE_BUSY with retryAfterMs 900000", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1), state: "parked" }, R2: { diskName: DISK(2), state: "returning" } } });
        for (const root of ["R1", "R2"]) {
            const result = await h.provider.ensureAttached(h.req(root, "app"));
            assert.deepEqual([result.ok, result.code, result.retryAfterMs], [false, "WORKSPACE_BUSY", 900_000], root);
        }
        assert.equal(h.attacher.calls.length, 0);
    });
});

describe("D4 check attaches", () => {
    it("reattach a mounted drive, attach only on a free LUN 0, and otherwise answer busy at once without a take-back", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } } });
        await h.admit("R1");
        await h.admit("R2");
        const free = await h.provider.ensureAttached(h.req("R1", "app", { purpose: "check" }));
        assert.equal(free.ok, true, "a free LUN 0 is attached for a check");
        assert.equal(h.controller.of("/v1/leases/attach")[0].body.purpose, "check");
        h.worker.sessionManager.holdWorkspaceFolders("R1", [{ root: "repos", folder: "app", rootSessionId: "R1", revision: 1, turnIndex: 1 }]);
        const again = await h.provider.ensureAttached(h.req("R1", "lib", { purpose: "check", attachment: "lib" }));
        assert.equal(again.ok, true, "a mounted drive is reattached for a check");
        assert.equal(h.controller.of("/v1/leases/attach").length, 1, "without the controller");
        const tries = t.mock.method(h.worker, "tryReleaseIdleWorkspace");
        const other = await h.provider.ensureAttached(h.req("R2", "app", { purpose: "check" }));
        assert.deepEqual([other.ok, other.code, other.retryAfterMs], [false, "WORKSPACE_BUSY", 10_000]);
        assert.equal(tries.mock.callCount(), 0, "a check never takes a drive back");
        assert.equal(h.mounted().rootSessionId, "R1");
    });

    it("a check of a session held here joins its folders: a take-back still detaches the drive", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } } });
        await h.admit("R1");
        await h.admit("R2");
        await h.turn("R1", "app");
        const check = h.req("R1", "lib", { purpose: "check", attachment: "lib" });
        assert.equal((await h.provider.ensureAttached(check)).ok, true);
        const settled = await h.worker.sessionManager.settleCheckAttaches("R1", [{ root: "repos", folder: "lib", attachment: "lib", rootSessionId: "R1", revision: 1, turnIndex: 1 }], { workerNodeId: "worker-1" });
        assert.equal(settled, "held", "PilotSwarm holds the check's folder with the session's own");
        assert.equal((await h.turn("R2", "app")).ok, true);
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(1)]);
    });

    it("a check of a session held here, then a shutdown, still detaches the drive, without a WIP push", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        await h.turn("R1", "app");
        assert.equal((await h.provider.ensureAttached(h.req("R1", "lib", { purpose: "check", attachment: "lib" }))).ok, true);
        await h.worker.sessionManager.settleCheckAttaches("R1", [{ root: "repos", folder: "lib", attachment: "lib", rootSessionId: "R1", revision: 1, turnIndex: 1 }], { workerNodeId: "worker-1" });
        const released = await h.worker.sessionManager.releaseIdleWorkspaces({ reason: "worker_shutdown", workerNodeId: "worker-1", releaseTimeoutMs: 5_000 });
        assert.equal(released, 1);
        assert.equal(h.mounted(), null);
        assert.deepEqual(h.repos.calls, ["record"], "a shutdown release records but pushes nothing");
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(1)]);
    });

    it("a spawn check for a new child never removes the parent's folder", async (t) => {
        const h = await harness(t, { leases: { P: { diskName: DISK(1) } } });
        await h.turn("P", "app");
        const checked = await checkWorkspaceForSpawn(h.provider, {
            sessionId: "child-1", rootSessionId: "P", workspace: { schema: 1, root: "repos", folder: "app" },
            revision: 1, workerNodeId: "worker-1", turnIndex: 0,
        });
        assert.equal(checked.ok, true);
        assert.deepEqual(h.mounted().folders, ["P\0repos\0app"], "the parent's folder stays");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0"], "the drive stays mounted");
    });
});

describe("D5 the controller's release requests", () => {
    async function idleHold(t) {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        await h.admit("R1");
        assert.equal((await h.turn("R1", "app")).ok, true);
        return h;
    }

    for (const reason of ["return", "park"]) {
        it(`${reason}: the idle holder is released without a WIP push; until then a turn of the session gets the controller's busy, not the drive`, async (t) => {
            const h = await idleHold(t);
            h.controller.state.leases.get("R1").state = reason === "park" ? "parked" : "returning";
            h.controller.state.releaseRequested = { diskName: DISK(1), reason };
            // A turn runs: the drive cannot be released yet.
            const done = h.busySession("R1");
            await h.heartbeat();
            assert.equal(h.mounted()?.diskName, DISK(1), "a busy holder keeps the drive");
            done();
            // The next turn of that session: no reattach, the controller's answer.
            const turn = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }));
            assert.deepEqual([turn.ok, turn.code, turn.retryAfterMs], [false, "WORKSPACE_BUSY", 900_000]);
            assert.equal(h.controller.of("/v1/leases/attach").at(-1).body.purpose, "turn");
            // Idle again: the next heartbeat releases it.
            await h.heartbeat();
            assert.equal(h.mounted(), null);
            assert.deepEqual(h.repos.calls, ["record"], "the record, but no WIP push");
            assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(1), false]]);
        });
    }

    it("move: the idle holder is released without a WIP push", async (t) => {
        const h = await idleHold(t);
        h.controller.state.releaseRequested = { diskName: DISK(1), reason: "move" };
        await h.heartbeat();
        assert.equal(h.mounted(), null);
        assert.deepEqual(h.repos.calls, ["record"]);
        assert.deepEqual(h.attacher.routes(), ["/online-lun0", "/offline-lun0"]);
    });

    it("move: a turn of the same root on the holder attaches through the controller, which cancels the move, and keeps the drive", async (t) => {
        const h = await idleHold(t);
        h.controller.state.releaseRequested = { diskName: DISK(1), reason: "move" };
        const done = h.busySession("R1");
        await h.heartbeat();
        done();
        const attaches = h.controller.of("/v1/leases/attach").length;
        const turn = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }));
        assert.equal(turn.ok, true);
        assert.equal(h.controller.of("/v1/leases/attach").length, attaches + 1, "not the fast path");
        assert.equal(h.controller.of("/v1/leases/attach").at(-1).body.purpose, "turn");
        assert.equal(h.controller.state.releaseRequested, null, "the move is cancelled");
        assert.deepEqual(h.attacher.routes(), ["/online-lun0"], "the drive stayed mounted");
        // The next turn takes the fast path again.
        await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 3 }));
        assert.equal(h.controller.of("/v1/leases/attach").length, attaches + 1);
        await h.heartbeat();
        assert.equal(h.mounted()?.diskName, DISK(1));
    });

    it("a check never cancels a release request", async (t) => {
        const h = await idleHold(t);
        h.controller.state.releaseRequested = { diskName: DISK(1), reason: "move" };
        const done = h.busySession("R1");
        await h.heartbeat();
        done();
        const check = await h.provider.ensureAttached(h.req("R1", "lib", { purpose: "check", attachment: "lib" }));
        assert.equal(check.code, "WORKSPACE_BUSY");
        assert.equal(h.controller.state.releaseRequested?.reason, "move");
    });
});

describe("D6 orphans", () => {
    it("a holder that PilotSwarm no longer holds (notHeld) is freed with one offline and detach, and no record", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } } });
        await h.admit("R1");
        await h.admit("R2");
        assert.equal((await h.provider.ensureAttached(h.req("R1", "app"))).ok, true, "attached, but no turn holds it");
        const tries = t.mock.method(h.worker, "tryReleaseIdleWorkspace");
        assert.equal((await h.turn("R2", "app")).ok, true);
        assert.deepEqual(await tries.mock.calls[0].result, { released: false, notHeld: true });
        assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(1), false]]);
        assert.deepEqual(h.repos.calls, [], "an orphan cleanup writes no record and pushes nothing");
    });

    it("a failed offline or detach is retried with backoff until the controller confirms, one request ID, and LUN 0 counts as taken meanwhile", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } }, providerOptions: { freeBackoffMs: [20, 40, 80] } });
        await h.admit("R1");
        await h.admit("R2");
        await h.turn("R1", "app");
        h.attacher.once("/offline-lun0", () => ({ status: 500, body: { ok: false, message: "the disk is busy" } }));
        // A controller restart: two refusals while it starts.
        h.controller.once("/v1/leases/detach", () => ({ status: 503, body: { error: "STARTING", message: "The disk controller is starting." } }));
        h.controller.once("/v1/leases/detach", () => { throw new Error("connection reset"); });
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        assert.equal(h.mounted(), null);
        assert.equal(h.ext.drive.state().freeing.length, 1, "still being freed");
        const busy = await h.provider.ensureAttached(h.req("R2", "app"));
        assert.equal(busy.code, "WORKSPACE_BUSY", "LUN 0 counts as taken");
        await waitFor(() => h.ext.drive.state().freeing.length === 0, { message: "the detach" });
        assert.deepEqual(h.attacher.routes().filter((route) => route === "/offline-lun0").length, 2, "the offline is retried, then not repeated");
        const detaches = h.detaches();
        assert.equal(detaches.length, 3);
        assert.equal(new Set(detaches.map((body) => body.requestId)).size, 1, "every attempt is the same detach");
        assert.equal(h.controller.state.attached, null);
        assert.equal((await h.turn("R2", "app")).ok, true);
    });

    it("a drive in the controller's record that differs from the mounted one is detached, and the mounted one stays online", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        await h.turn("R1", "app");
        h.controller.state.attached = { diskName: DISK(7), rootSessionId: "R7" };
        await h.heartbeat();
        assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(7), true]]);
        assert.deepEqual(h.attacher.routes(), ["/online-lun0"], "LUN 0 holds the mounted drive: no offline");
        assert.equal(h.mounted().diskName, DISK(1));
    });

    it("an attach record from a heartbeat sent before an attach is never used to free a drive", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } } });
        const answer = deferred();
        h.controller.once("/v1/vms/heartbeat", () => answer.promise);
        const beat = h.ext.heartbeat.beat();
        await flush();
        await h.turn("R1", "app");
        answer.resolve({ status: 200, body: { ownerOid: null, attached: { diskName: DISK(8), rootSessionId: "x" }, releaseRequested: { diskName: DISK(8), reason: "return" } } });
        await beat;
        await h.ext.drive.settle();
        assert.deepEqual(h.detaches(), [], "stale: nothing is freed");
        h.controller.state.attached = { diskName: DISK(8), rootSessionId: "x" };
        await h.heartbeat();
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(8)], "the next, fresh record is used");
        assert.equal(h.mounted().diskName, DISK(1), "a drive a session holds is never an orphan");
    });

    it("a release request for a drive no session here holds frees it", async (t) => {
        const h = await harness(t);
        h.controller.state.releaseRequested = { diskName: DISK(5), reason: "return" };
        await h.heartbeat();
        assert.deepEqual(h.attacher.routes(), ["/offline-lun0"]);
        assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(5), true]]);
    });
});

describe("D7 shutdown", () => {
    it("the shutdown hook waits for a release in flight before it stops the heartbeat; a shutdown release pushes nothing", async (t) => {
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } }, heartbeatIntervalMs: 20 });
        t.mock.method(console, "error", () => {});
        await h.turn("R1", "app");
        h.worker.runtime = { shutdown: async () => {} };
        h.worker._runtimeStartup = Promise.resolve();
        const offline = deferred();
        h.attacher.once("/offline-lun0", () => offline.promise);
        // PilotSwarm stops waiting for the release after 50 ms; the release keeps running.
        const shutdown = h.worker.gracefulShutdown({ releaseTimeoutMs: 50 });
        await waitFor(() => h.attacher.routes().includes("/offline-lun0"), { message: "the offline" });
        await sleep(150);
        assert.equal(h.ext.heartbeat.running, true, "the heartbeat runs while the release is in flight");
        const beats = h.controller.of("/v1/vms/heartbeat").length;
        await sleep(60);
        assert.ok(h.controller.of("/v1/vms/heartbeat").length > beats, "and keeps beating");
        offline.resolve();
        await shutdown;
        assert.equal(h.ext.heartbeat.running, false, "stopped after the release");
        assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(1), false]]);
        assert.deepEqual(h.repos.calls, ["record"], "no WIP push on shutdown");
        assert.equal(await h.worker.waitForShutdown(), 0);
    });
});

describe("D8 online growth", () => {
    it("extendRequested calls /extend-lun0 only for the mounted drive, retries a minute later until it is done, then does nothing", async (t) => {
        let now = 1_000_000;
        const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), now: () => now };
        const h = await harness(t, { leases: { R1: { diskName: DISK(1) } }, timers });
        h.controller.state.extendRequested = { diskName: DISK(4), sizeGb: 1280 };
        await h.heartbeat();
        assert.equal(h.attacher.calls.length, 0, "not the mounted drive");
        await h.turn("R1", "app");
        h.controller.state.extendRequested = { diskName: DISK(1), sizeGb: 1280 };
        h.attacher.once("/extend-lun0", () => ({ status: 200, body: { ok: false, retry: true, message: "Windows still sees 1024 GB" } }));
        await h.heartbeat();
        const extends_ = () => h.attacher.calls.filter((call) => call.route === "/extend-lun0");
        assert.deepEqual(extends_().map((call) => call.body), [{ diskName: DISK(1), sizeGb: 1280 }]);
        now += 15_000;
        await h.heartbeat();
        assert.equal(extends_().length, 1, "not again within the minute");
        now += 45_000;
        await h.heartbeat();
        assert.equal(extends_().length, 2, "a minute later, again");
        now += 60_000;
        await h.heartbeat();
        assert.equal(extends_().length, 2, "a repeated request after success does nothing");
    });
});

describe("D9 the binding restart", () => {
    it("binding an unbound worker during a long untagged turn exits with code 75 within the 2-minute drain, heartbeating until then", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        t.mock.method(console, "error", () => {});
        const h = await harness(t, { heartbeatIntervalMs: 15_000 });
        const worker = h.worker;
        worker._started = true;
        const drains = [];
        // duroxide's drain: waits for the in-flight turn, at most the budget.
        worker.runtime = { shutdown: (ms) => { drains.push(ms); return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 100 * 60_000))); } };
        worker._runtimeStartup = Promise.resolve();
        h.busySession("untagged-turn");
        const exited = { code: null };
        worker.waitForShutdown().then((code) => { exited.code = code; });
        const start = Date.now();
        h.controller.state.ownerOid = OWNER;
        await h.ext.heartbeat.beat();
        const beforeDrain = h.controller.of("/v1/vms/heartbeat").length;
        for (let i = 0; i < 5; i += 1) await flush();
        assert.deepEqual(drains, [120_000], "the drain budget is 2 minutes, not the maintenance one");
        for (let elapsed = 0; elapsed < 119_000; elapsed += 1_000) {
            t.mock.timers.tick(1_000);
            for (let i = 0; i < 3; i += 1) await flush();
        }
        assert.equal(exited.code, null, "still draining at 119 s");
        const during = h.controller.of("/v1/vms/heartbeat").slice(beforeDrain);
        assert.ok(during.length >= 7, `heartbeats continued (${during.length})`);
        assert.ok(during.every((call) => call.body.draining === true), "with draining: true");
        t.mock.timers.tick(1_000);
        for (let i = 0; i < 20 && exited.code === null; i += 1) await flush();
        assert.equal(exited.code, 75);
        assert.ok(Date.now() - start <= 120_000);
        assert.equal(h.ext.heartbeat.running, false, "the heartbeat stopped at the end of the drain");
    });

    it("no restart for a worker started with an owner tag, an owner-only worker, or before start()", async (t) => {
        for (const env of [{ PILOTSWARM_WORKER_OWNER_TAG: `owner.${OWNER}` }, { PILOTSWARM_WORKER_OWNER_ONLY: "1" }, {}]) {
            const h = await harness(t, { env });
            const exits = t.mock.method(h.worker, "requestExit", async () => {});
            if (Object.keys(env).length > 0) h.worker._started = true;
            h.controller.state.ownerOid = OWNER;
            await h.heartbeat();
            await flush();
            assert.equal(exits.mock.callCount(), 0, JSON.stringify(env));
        }
    });
});

// ── Git on the drive ─────────────────────────────────────────────────

/** Git with a configuration of its own: no system or user settings (credential helpers) apply. */
function gitEnvFor(home) {
    const config = path.join(home, "gitconfig");
    fs.writeFileSync(config, [
        "[user]", "\tname = Test", "\temail = test@example.com",
        "[protocol \"file\"]", "\tallow = always",
        "[init]", "\tdefaultBranch = main",
        "[core]", "\tautocrlf = false",
        "[advice]", "\tdetachedHead = false",
        "",
    ].join("\n"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_|COMMITTER_|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
    return env;
}

function gitIn(env, cwd, ...args) {
    return execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A drive whose root "repos" holds one clone, app, of a local bare origin,
 * with a.txt and a .gitignore that ignores bin/. `wrap` sees every git call
 * of the extension.
 */
async function gitDrive(t, { leases = { R1: { diskName: DISK(1) } }, providerOptions = {}, env = {}, wrap = null, submodule = false } = {}) {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-git-")));
    const gitEnv = gitEnvFor(home);
    const g = (cwd, ...args) => gitIn(gitEnv, cwd, ...args);
    const origin = path.join(home, "origin.git");
    g(home, "init", "-q", "--bare", origin);
    const seed = path.join(home, "seed");
    g(home, "init", "-q", "-b", "main", seed);
    fs.writeFileSync(path.join(seed, ".gitignore"), "bin/\n");
    fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
    let lib = null;
    if (submodule) {
        lib = path.join(home, "lib.git");
        g(home, "init", "-q", "--bare", lib);
        const libSeed = path.join(home, "lib-seed");
        g(home, "init", "-q", "-b", "main", libSeed);
        fs.writeFileSync(path.join(libSeed, "lib.txt"), "lib one\n");
        g(libSeed, "add", "-A");
        g(libSeed, "commit", "-q", "-m", "l1");
        g(libSeed, "push", "-q", lib, "main");
        g(seed, "submodule", "add", "-q", lib, "lib");
    }
    g(seed, "add", "-A");
    g(seed, "commit", "-q", "-m", "c1");
    g(seed, "push", "-q", origin, "main");
    const reposRoot = path.join(home, "Q", "Repos");
    fs.mkdirSync(reposRoot, { recursive: true });
    g(reposRoot, "clone", "-q", ...(submodule ? ["--recurse-submodules"] : []), origin, "app");
    const real = createGitRunner({ env: gitEnv });
    const calls = [];
    const runGit = async (args, opts) => {
        calls.push(args);
        return wrap ? wrap(args, opts, real) : real(args, opts);
    };
    const h = await harness(t, { home, folders: [], runGit, leases, providerOptions, env });
    const app = path.join(reposRoot, "app");
    return {
        ...h, gitEnv, g, origin, lib, app, gitCalls: calls,
        head: (cwd = app) => g(cwd, "rev-parse", "HEAD"),
        gitDir: (cwd = app) => g(cwd, "rev-parse", "--absolute-git-dir"),
        commit(file, text, message, cwd = app) {
            fs.writeFileSync(path.join(cwd, file), text);
            g(cwd, "add", "-A");
            g(cwd, "commit", "-q", "-m", message);
            return g(cwd, "rev-parse", "HEAD");
        },
        /** A turn, then PilotSwarm's release of it: the drive is pushed, recorded and detached. */
        async cleanCycle(turnIndex = 1) {
            assert.equal((await h.turn("R1", "app", { turnIndex })).ok, true);
            const released = await h.worker.sessionManager.releaseWorkspace("R1", { reason: "moved", workerNodeId: "worker-1" });
            assert.equal(released.released, true);
            assert.equal(h.mounted(), null);
        },
    };
}

const hasRevList = (calls) => calls.some((args) => args[0] === "rev-list" && args.includes("--indexed-objects"));

describe("D10 crash recovery", () => {
    it("a takeover removes a stale index.lock, checks only what came after the clean-detach record, and a commit then succeeds", async (t) => {
        const h = await gitDrive(t);
        await h.cleanCycle();
        const record = fs.readFileSync(path.join(h.gitDir(), CLEAN_TIPS_FILE), "utf8");
        assert.ok(record.includes(h.head()), "the release recorded HEAD");
        // Another VM wrote a commit, then died with the index locked; the controller fenced it.
        h.commit("b.txt", "two\n", "c2");
        fs.writeFileSync(path.join(h.gitDir(), "index.lock"), "");
        h.controller.state.leases.get("R1").takeover = true;
        h.gitCalls.length = 0;
        const attached = await h.turn("R1", "app", { turnIndex: 2 });
        assert.equal(attached.ok, true, attached.message);
        assert.match(attached.notice, /1 stale Git lock file was removed \(index\.lock\)/);
        assert.match(attached.notice, /passed Git's connectivity check/);
        assert.equal(fs.existsSync(path.join(h.gitDir(), "index.lock")), false);
        assert.ok(hasRevList(h.gitCalls), "the scoped rev-list check");
        assert.ok(!h.gitCalls.some((args) => args[0] === "fsck"), "not the full fsck");
        assert.ok(h.gitCalls.some((args) => args[0] === "status"));
        fs.writeFileSync(path.join(h.app, "c.txt"), "three\n");
        h.g(h.app, "add", "c.txt");
        h.g(h.app, "commit", "-q", "-m", "after the takeover");
        // The notice is said once.
        const later = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 3 }));
        assert.equal(later.notice, undefined);
    });

    it("a loose object lost after the record fails the scoped check, and the repository comes back from its WIP branch", async (t) => {
        const h = await gitDrive(t);
        await h.cleanCycle();
        const c1 = h.head();
        h.commit("b.txt", "two\n", "c2");
        const blob = h.g(h.app, "rev-parse", "HEAD:b.txt");
        fs.rmSync(path.join(h.gitDir(), "objects", blob.slice(0, 2), blob.slice(2)));
        h.controller.state.leases.get("R1").takeover = true;
        const attached = await h.turn("R1", "app", { turnIndex: 2 });
        assert.equal(attached.ok, true, attached.message);
        assert.match(attached.notice, /had lost objects\. It was restored from its WIP backup branch pilotswarm\/wip\/R1/);
        assert.match(attached.notice, /refs\/heads\/main/);
        assert.equal(h.head(), c1, "the branch is at the backup's parent");
        assert.match(fs.readFileSync(path.join(h.gitDir(), "pilotswarm-broken-refs"), "utf8"), /refs\/heads\/main/);
        h.g(h.app, "fsck", "--connectivity-only", "--no-dangling", "--no-reflogs");
    });

    it("without a record, the full git fsck --connectivity-only --no-dangling runs", async (t) => {
        const h = await gitDrive(t);
        await h.cleanCycle();
        fs.rmSync(path.join(h.gitDir(), CLEAN_TIPS_FILE));
        h.controller.state.leases.get("R1").needsFsck = true;
        h.gitCalls.length = 0;
        const attached = await h.turn("R1", "app", { turnIndex: 2 });
        assert.equal(attached.ok, true, attached.message);
        assert.ok(h.gitCalls.some((args) => args.join(" ") === "fsck --connectivity-only --no-dangling"));
        assert.ok(!hasRevList(h.gitCalls));
    });

    it("an orphan cleanup leaves the record as it was", async (t) => {
        const h = await gitDrive(t, { leases: { R1: { diskName: DISK(1) }, R2: { diskName: DISK(2) } } });
        await h.admit("R1");
        await h.admit("R2");
        await h.cleanCycle();
        const record = fs.readFileSync(path.join(h.gitDir(), CLEAN_TIPS_FILE), "utf8");
        // Attached, but no session holds it; then a new commit.
        assert.equal((await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }))).ok, true);
        const c2 = h.commit("b.txt", "two\n", "c2");
        assert.equal((await h.turn("R2", "app")).ok, true, "R2 takes LUN 0 after freeing the orphan");
        assert.equal(fs.readFileSync(path.join(h.gitDir(), CLEAN_TIPS_FILE), "utf8"), record);
        assert.ok(!record.includes(c2));
    });

    it("an ownership error fails the attach without the WIP fallback, and the drive keeps its crash flag", async (t) => {
        let ownership = false;
        const h = await gitDrive(t, {
            wrap: (args, opts, real) => (ownership && args[0] === "status"
                ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at 'Q:/Repos/app'", timedOut: false })
                : real(args, opts)),
        });
        await h.cleanCycle();
        const record = fs.readFileSync(path.join(h.gitDir(), CLEAN_TIPS_FILE), "utf8");
        h.controller.state.leases.get("R1").takeover = true;
        ownership = true;
        h.gitCalls.length = 0;
        const attached = await h.turn("R1", "app", { turnIndex: 2 });
        assert.equal(attached.ok, false);
        assert.equal(attached.code, "WORKSPACE_ATTACH_FAILED");
        assert.match(attached.message, /belongs to another account/);
        assert.ok(!h.gitCalls.some((args) => args[0] === "ls-remote" || args[0] === "fetch"), "no WIP fallback");
        assert.equal(h.mounted().checkPending, true);
        await h.provider.release({ ...h.req("R1", "app", { turnIndex: 2 }), reason: "moved" });
        assert.equal(h.detaches().at(-1).crashed, true, "the next attach checks again");
        assert.equal(fs.readFileSync(path.join(h.gitDir(), CLEAN_TIPS_FILE), "utf8"), record, "no record from an unchecked drive");
    });
});

/** A local HTTP server for a remote that never answers, or that asks for credentials. */
async function localRemote(t, mode) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (mode === "credentials") {
            res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"test\"" });
            res.end();
        }
        // "stall": no answer at all.
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
    });
    return { url: `http://127.0.0.1:${server.address().port}/app.git`, sockets };
}

const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

describe("D11 the WIP push", () => {
    it("a release pushes the drive's work, committed or not, to <PS_WIP_BRANCH_PREFIX><rootSessionId>, and leaves the drive as it was", async (t) => {
        const h = await gitDrive(t, { env: { PS_WIP_BRANCH_PREFIX: "team/wip/" } });
        assert.equal((await h.turn("R1", "app")).ok, true);
        const head = h.commit("committed.txt", "unpushed\n", "an unpushed commit");
        fs.writeFileSync(path.join(h.app, "a.txt"), "changed\n");
        fs.writeFileSync(path.join(h.app, "new.txt"), "untracked\n");
        fs.mkdirSync(path.join(h.app, "bin"));
        fs.writeFileSync(path.join(h.app, "bin", "out.dll"), "build output");
        const statusBefore = h.g(h.app, "status", "--porcelain");
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        const wip = h.g(h.origin, "rev-parse", "refs/heads/team/wip/R1");
        assert.equal(h.g(h.origin, "rev-parse", `${wip}^1`), head, "on top of the drive's HEAD");
        assert.equal(h.g(h.origin, "show", `${wip}:a.txt`), "changed");
        assert.equal(h.g(h.origin, "show", `${wip}:new.txt`), "untracked");
        assert.equal(h.g(h.origin, "show", `${wip}:committed.txt`), "unpushed");
        assert.throws(() => h.g(h.origin, "show", `${wip}:bin/out.dll`), "ignored output is not pushed");
        assert.equal(h.g(h.app, "status", "--porcelain"), statusBefore, "the index and the working tree did not change");
        assert.deepEqual(h.detaches().map((body) => body.diskName), [DISK(1)]);
    });

    for (const mode of ["stall", "credentials"]) {
        it(`a ${mode === "stall" ? "stalled remote" : "credential prompt"} ends within the push's time, leaves no process, and the drive still goes offline and detaches`, async (t) => {
            const pushTimeoutMs = 2_000;
            const h = await gitDrive(t, { providerOptions: { wipPushTimeoutMs: pushTimeoutMs } });
            const remote = await localRemote(t, mode);
            h.g(h.app, "remote", "set-url", "origin", remote.url);
            const pidFile = path.join(h.home, "helper.pid");
            if (mode === "credentials") {
                // A helper that never answers, like a prompt nobody sees.
                const helper = path.join(h.home, "helper.cjs");
                fs.writeFileSync(helper, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
                const slash = (value) => value.replace(/\\/g, "/");
                h.g(h.app, "config", "credential.helper", `!"${slash(process.execPath)}" "${slash(helper)}" "${slash(pidFile)}"`);
            }
            assert.equal((await h.turn("R1", "app")).ok, true);
            fs.writeFileSync(path.join(h.app, "a.txt"), "changed\n");
            const started = Date.now();
            await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
            const elapsed = Date.now() - started;
            assert.ok(elapsed < pushTimeoutMs + 12_000, `the release took ${elapsed} ms`);
            assert.ok(elapsed >= pushTimeoutMs - 200, `the push ran until its deadline (${elapsed} ms)`);
            await waitFor(() => remote.sockets.size === 0, { timeoutMs: 5_000, message: "the push's connections to close" });
            if (mode === "credentials") {
                const pid = Number(fs.readFileSync(pidFile, "utf8"));
                assert.equal(alive(pid), false, "the credential helper was killed with the push");
            }
            assert.deepEqual(h.attacher.routes(), ["/online-lun0", "/offline-lun0"]);
            assert.deepEqual(h.detaches().map((body) => [body.diskName, body.crashed]), [[DISK(1), false]]);
            assert.ok(h.logs.some((line) => /WIP push of drive .* failed; the drive keeps every edit/.test(line)));
            assert.equal(fs.readFileSync(path.join(h.app, "a.txt"), "utf8"), "changed\n", "the drive keeps every edit");
        });
    }
});

describe("D12 back from local work: the branch sync", () => {
    /**
     * The work continued outside: a developer pushed c2 on main (with a new
     * submodule commit), while the drive has an unpushed commit, an
     * uncommitted change, an untracked file and ignored build output.
     */
    async function parked(t, options = {}) {
        const h = await gitDrive(t, { submodule: true, ...options });
        const dev = path.join(h.home, "dev");
        h.g(h.home, "clone", "-q", "--recurse-submodules", h.origin, "dev");
        const devLib = path.join(dev, "lib");
        h.g(devLib, "checkout", "-q", "main");
        const l2 = h.commit("lib.txt", "lib two\n", "l2", devLib);
        h.g(devLib, "push", "-q", "origin", "main");
        fs.writeFileSync(path.join(dev, "a.txt"), "from local work\n");
        const c2 = h.commit("b.txt", "local\n", "c2", dev);
        h.g(dev, "push", "-q", "origin", "main");
        const d1 = h.commit("drive-only.txt", "drive\n", "d1");
        fs.writeFileSync(path.join(h.app, "a.txt"), "uncommitted on the drive\n");
        fs.writeFileSync(path.join(h.app, "scratch.txt"), "untracked\n");
        fs.mkdirSync(path.join(h.app, "bin"));
        fs.writeFileSync(path.join(h.app, "bin", "out.dll"), "warm build output");
        h.controller.state.leases.get("R1").sync = { syncId: "sync-1", sourceBranch: "main", headSha: c2, url: pathToFileURL(h.origin).href };
        return { ...h, c2, l2, d1 };
    }

    it("a sync source that fails to fetch is never quoted: its URL may carry a credential", async (t) => {
        const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ps-devdrive-url-")));
        t.after(() => fs.rmSync(home, { recursive: true, force: true }));
        const app = path.join(home, "app");
        fs.mkdirSync(path.join(app, ".git"), { recursive: true });
        const seen = [];
        const runGit = async (args, opts) => {
            seen.push({ args, env: opts?.env ?? {} });
            return { code: 128, stdout: "", stderr: "fatal: unable to access 'https://worker:pw-secret@git.example/_full/sync-secret/app/': 403", timedOut: false };
        };
        const url = "https://worker:pw-secret@git.example/_full/sync-secret/app";
        const result = await applySync({
            repos: [{ path: app, gitDir: path.join(app, ".git"), parent: null }], runGit, folderPath: app, wipBranch: "pilotswarm/wip/R1",
            sync: { syncId: "sync-9", sourceBranch: "main", headSha: "a".repeat(40), url }, deadline: Date.now() + 60_000, env: {},
        });
        assert.equal(result.ok, false);
        assert.match(result.message, /fetching main from the sync source failed/);
        assert.ok(!/secret/.test(result.message), result.message);
        assert.ok(!seen[0].args.some((arg) => arg.includes("secret")), "the URL is not on the command line");
        assert.equal(seen[0].env.GIT_CONFIG_VALUE_0, url, "it reaches git through its environment");
    });

    it("the drive's work goes to the WIP branch, then the working copy and its submodules are at headSha, and ignored output stays", async (t) => {
        const h = await parked(t);
        const attached = await h.turn("R1", "app");
        assert.equal(attached.ok, true, attached.message);
        assert.match(attached.notice, /moved to branch main at/);
        assert.equal(h.head(), h.c2);
        assert.equal(h.g(h.app, "symbolic-ref", "--short", "HEAD"), "main");
        assert.equal(h.head(path.join(h.app, "lib")), h.l2, "the submodule follows");
        assert.equal(fs.readFileSync(path.join(h.app, "a.txt"), "utf8"), "from local work\n");
        assert.equal(fs.existsSync(path.join(h.app, "scratch.txt")), false, "untracked files are removed");
        assert.equal(fs.readFileSync(path.join(h.app, "bin", "out.dll"), "utf8"), "warm build output", "ignored output stays");
        const wip = h.g(h.origin, "rev-parse", "refs/heads/pilotswarm/wip/R1");
        assert.equal(h.g(h.origin, "rev-parse", `${wip}^1`), h.d1);
        assert.equal(h.g(h.origin, "show", `${wip}:drive-only.txt`), "drive");
        assert.equal(h.g(h.origin, "show", `${wip}:a.txt`), "uncommitted on the drive");
        assert.equal(h.g(h.origin, "show", `${wip}:scratch.txt`), "untracked");
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.gitDir(), SYNCED_FILE), "utf8")).syncId, "sync-1");
        await h.heartbeat();
        const body = h.controller.of("/v1/vms/heartbeat").at(-1).body;
        assert.deepEqual([body.syncId, body.syncedHeadSha], ["sync-1", h.c2]);
    });

    it("a failed WIP push resets nothing and fails the attach; the next attach retries the sync instead of the fast path", async (t) => {
        const h = await parked(t);
        h.g(h.app, "remote", "set-url", "origin", path.join(h.home, "missing.git"));
        const first = await h.turn("R1", "app");
        assert.equal(first.ok, false);
        assert.equal(first.code, "WORKSPACE_ATTACH_FAILED");
        assert.match(first.message, /nothing was reset/);
        assert.equal(h.head(), h.d1, "the drive is unchanged");
        assert.equal(fs.readFileSync(path.join(h.app, "scratch.txt"), "utf8"), "untracked\n");
        assert.equal(h.mounted().syncPending, true);
        const attaches = h.controller.of("/v1/leases/attach").length;
        const second = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 2 }));
        assert.equal(second.ok, false);
        assert.equal(h.controller.of("/v1/leases/attach").length, attaches + 1, "not the fast path");
        h.g(h.app, "remote", "set-url", "origin", h.origin);
        const third = await h.provider.ensureAttached(h.req("R1", "app", { turnIndex: 3 }));
        assert.equal(third.ok, true, third.message);
        assert.equal(h.head(), h.c2);
    });

    it("a sync the drive applied is never applied again, also after a lost heartbeat report and a detach", async (t) => {
        const h = await parked(t);
        assert.equal((await h.turn("R1", "app")).ok, true);
        await h.provider.release({ ...h.req("R1", "app"), reason: "moved" });
        // The controller never got the report and still names the sync.
        const d2 = h.commit("after.txt", "after the sync\n", "d2");
        fs.writeFileSync(path.join(h.app, "keep.txt"), "untracked work\n");
        const again = await h.turn("R1", "app", { turnIndex: 2 });
        assert.equal(again.ok, true, again.message);
        assert.equal(again.notice, undefined);
        assert.equal(h.head(), d2, "not reset again");
        assert.equal(fs.existsSync(path.join(h.app, "keep.txt")), true);
        await h.heartbeat();
        assert.equal(h.controller.of("/v1/vms/heartbeat").at(-1).body.syncId, "sync-1", "reported until the controller drops it");
    });
});

describe("D13 admission, the credential broker and capacity requests", () => {
    const SECRET = `ghcp-${OWNER}-0123456789abcdef0123456789abcdef`;
    const secret = (version) => ({ kind: "externalSecret", store: "vault", name: SECRET, version, expiresOn: null });

    it("admission asks /v1/vms/admit before every turn and passes on admit, busy and deny; an outage fails the turn to be retried", async (t) => {
        const h = await harness(t);
        const admission = h.worker.sessionManager.getSessionAdmission();
        const request = { sessionId: "S1", rootSessionId: "R1", isSystem: false };
        assert.deepEqual(await admission(request), { decision: "admit" });
        assert.deepEqual(h.controller.of("/v1/vms/admit")[0].body, request);
        assert.equal(h.ext.admitted.has("R1"), true, "the binding cache: R1 belongs to this VM's owner");
        h.controller.state.admit = () => ({ decision: "busy", code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000, message: "Dev Drive is parked for local work" });
        assert.deepEqual(await admission(request), { decision: "busy", message: "Dev Drive is parked for local work", retryAfterMs: 900_000 });
        h.controller.state.admit = () => ({ decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive." });
        assert.deepEqual(await admission(request), { decision: "deny", message: "This session's root holds no Dev Drive." });
        assert.equal(h.ext.admitted.has("R1"), false, "a root without a lease takes no drive here");
        h.controller.state.admit = () => ({ status: 503, body: { error: "STARTING", message: "The disk controller is starting." } });
        await assert.rejects(admission(request), /HTTP 503/);
        h.controller.state.admit = () => ({ decision: "admit" });
        assert.deepEqual(await admission({ sessionId: "sys-1", rootSessionId: "sys-1", isSystem: true }), { decision: "admit" });
        assert.equal(h.controller.of("/v1/vms/admit").at(-1).body.isSystem, true);
        assert.equal(h.ext.admitted.has("sys-1"), false, "a system session takes no drive");
    });

    it("the model token comes from the broker by secret name and version; PilotSwarm keeps it per version and asks again after a 401", async (t) => {
        const h = await harness(t);
        const manager = h.worker.sessionManager;
        let issued = 0;
        h.controller.state.model = () => ({ status: "ok", token: `github_pat_issued_${issued += 1}` });
        const [v1, v2] = ["a".repeat(32), "b".repeat(32)];
        assert.equal(await manager._resolvePersonalCredential("S1", "personal", secret(v1)), "github_pat_issued_1");
        assert.equal(await manager._resolvePersonalCredential("S1", "personal", secret(v1)), "github_pat_issued_1");
        assert.equal(h.controller.of("/v1/credentials/model").length, 1, "the same version is not fetched again");
        assert.deepEqual(h.controller.of("/v1/credentials/model")[0].body, {
            sessionId: "S1", rootSessionId: "S1", provider: "personal", secretName: SECRET, secretVersion: v1,
        });
        assert.equal(await manager._resolvePersonalCredential("S1", "personal", secret(v2)), "github_pat_issued_2", "a new version is fetched");
        manager.forgetPersonalCredential("S1");
        assert.equal(await manager._resolvePersonalCredential("S1", "personal", secret(v2)), "github_pat_issued_3", "fetched again after a 401");
    });

    it("a broker refusal, a broker outage and a busy answer are reported apart", async (t) => {
        const h = await harness(t);
        const manager = h.worker.sessionManager;
        const outcome = async (version) => {
            try {
                await manager._resolvePersonalCredential("S1", "personal", secret(version));
                return "ok";
            } catch (error) {
                assert.ok(error instanceof PersonalCredentialError, String(error));
                return [error.outcome, error.retryAfterMs ?? null];
            }
        };
        h.controller.state.model = () => ({ status: "refused", code: "SECRET_EXPIRED", message: "The secret has expired." });
        assert.deepEqual(await outcome("1".repeat(32)), ["refused", null]);
        h.controller.state.model = () => ({ status: 503, body: { status: "unavailable", message: "The personal vault could not be read." } });
        assert.deepEqual(await outcome("2".repeat(32)), ["unavailable", null]);
        h.controller.once("/v1/credentials/model", () => { throw new Error("connection reset"); });
        assert.deepEqual(await outcome("3".repeat(32)), ["unavailable", null]);
        h.controller.state.model = () => ({ status: "busy", code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000, message: "Dev Drive is parked" });
        assert.deepEqual(await outcome("4".repeat(32)), ["busy", 900_000]);
    });

    it("the per-work credential reaches the deployment's tool modules through the extension's client, and no credential is written to disk or logs", async (t) => {
        const h = await harness(t);
        const writes = [];
        for (const [target, name] of [[fs, "writeFileSync"], [fs, "appendFileSync"], [fs.promises, "writeFile"], [fs.promises, "appendFile"]]) {
            const original = target[name];
            t.mock.method(target, name, function (...args) {
                writes.push(String(args[1] ?? ""));
                return original.apply(this, args);
            });
        }
        const printed = [];
        for (const name of ["log", "error", "warn", "info"]) t.mock.method(console, name, (...args) => { printed.push(args.join(" ")); });
        h.controller.state.model = () => ({ status: "ok", token: "github_pat_never_persisted" });
        await h.worker.sessionManager._resolvePersonalCredential("S1", "personal", secret("c".repeat(32)));
        assert.deepEqual(await fetchWorkCredential("R1"), { status: "ok", credential: "work-credential-from-broker" });
        assert.deepEqual(h.controller.of("/v1/credentials/work")[0].body, { rootSessionId: "R1" });
        h.controller.state.work = () => ({ status: "busy", code: "WORKSPACE_BUSY", retryAfterMs: 900_000, message: "Dev Drive is parked" });
        assert.deepEqual(await fetchWorkCredential("R1"), { status: "busy", message: "Dev Drive is parked", retryAfterMs: 900_000 });
        await h.heartbeat();
        for (const secretText of ["github_pat_never_persisted", "work-credential-from-broker"]) {
            assert.ok(!writes.some((data) => data.includes(secretText)), `${secretText} was written to a file`);
            assert.ok(![...printed, ...h.logs].some((line) => line.includes(secretText)), `${secretText} was logged`);
        }
    });

    it("the capacity requester asks /v1/vms/demand with the owner and the root, until the controller answers, and passes on deny and busy", async (t) => {
        const h = await harness(t);
        const requester = h.worker.sessionManager.getOwnerCapacityRequester();
        assert.equal(typeof requester, "function", "registered without owner-only workers");
        const request = { sessionId: "S1", rootSessionId: "R1", ownerTag: `owner.${OWNER}` };
        h.controller.once("/v1/vms/demand", () => ({ status: 503, body: { error: "STARTING" } }));
        h.controller.once("/v1/vms/demand", () => { throw new Error("connection refused"); });
        assert.deepEqual(await askOwnerCapacityRequester(requester, request), { decision: "ok" });
        assert.equal(h.controller.of("/v1/vms/demand").length, 3, "retried until the controller answered");
        assert.deepEqual(h.controller.of("/v1/vms/demand")[0].body, { ownerOid: OWNER, rootSessionId: "R1" });
        h.controller.state.demand = () => ({ decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive of this owner." });
        assert.deepEqual(await askOwnerCapacityRequester(requester, request),
            { decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive of this owner." });
        h.controller.state.demand = () => ({ decision: "busy", code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000, message: "Dev Drive is parked for local work" });
        assert.deepEqual(await askOwnerCapacityRequester(requester, request),
            { decision: "busy", code: "WORKSPACE_BUSY", message: "Dev Drive is parked for local work", retryAfterMs: 900_000 });
    });

    it("the capacity requester stops at the activity's signal, and gives up on a refused route", async (t) => {
        const h = await harness(t);
        const requester = h.worker.sessionManager.getOwnerCapacityRequester();
        const request = { sessionId: "S1", rootSessionId: "R1", ownerTag: `owner.${OWNER}` };
        h.controller.state.demand = () => ({ status: 503, body: { error: "STARTING" } });
        const unavailable = await askOwnerCapacityRequester(requester, request, 300);
        assert.equal(unavailable.code, "CAPACITY_UNAVAILABLE");
        const asked = h.controller.of("/v1/vms/demand").length;
        assert.ok(asked >= 2, "it retried");
        await sleep(1_200);
        assert.equal(h.controller.of("/v1/vms/demand").length, asked, "nothing after the signal");
        h.controller.state.demand = () => ({ status: 403, body: { error: "COORDINATION_HOST" } });
        const refused = await askOwnerCapacityRequester(requester, request, 5_000);
        assert.equal(refused.code, "CAPACITY_UNAVAILABLE");
        assert.match(refused.message, /HTTP 403/);
        assert.equal(h.controller.of("/v1/vms/demand").length, asked + 1, "a refused route is not retried");
    });

    it("the capacity requester denies an owner without an object ID at once, without asking the controller", async (t) => {
        const h = await harness(t);
        const requester = h.worker.sessionManager.getOwnerCapacityRequester();
        const answer = await askOwnerCapacityRequester(requester, { sessionId: "S1", rootSessionId: "R1", ownerTag: "owner.someone@example.com" });
        assert.equal(answer.decision, "deny");
        assert.equal(answer.code, "OWNER_NOT_SUPPORTED");
        assert.match(answer.message, /no Microsoft Entra object ID/);
        assert.equal(h.controller.of("/v1/vms/demand").length, 0);
    });

    it("with owner-only workers no capacity requester is registered", async (t) => {
        const h = await harness(t, { env: { PILOTSWARM_WORKER_OWNER_ONLY: "1", PILOTSWARM_WORKER_OWNER_TAG: `owner.${OWNER}` } });
        assert.equal(h.worker.sessionManager.getOwnerCapacityRequester(), null);
        assert.equal(typeof h.worker.sessionManager.getSessionAdmission(), "function");
    });
});
