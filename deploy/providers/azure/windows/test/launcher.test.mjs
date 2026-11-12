// launcher.mjs: the worker service's start, from the Node.js check to the
// hand-over to worker.js. IMDS, the controller, the attacher, az and the
// worker are fakes; the heartbeat hand-over uses the Dev Drive extension's
// own takeOverHeartbeat().
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
    applyEnv, buildWorkerEnv, checkNodeVersion, checkPersonalSecretsOwnerOnly, clearFolderContents, createAttacherClient, createAzSignIn,
    decodeUserData, EXPECTED_NODE_VERSION, HEARTBEAT_HANDOVER, LaunchError, LAUNCHER_SETTINGS, parseEnvFile, pinReleasePaths, runLauncher,
    syncReleaseWithRetry, tokenObjectId, USER_DATA_SETTINGS, waitForActive,
} from "../launcher.mjs";
import { takeOverHeartbeat } from "../../../../../packages/sdk/examples/devdrive-workspaces/heartbeat.mjs";
import {
    BAD_CA_BUNDLES, CA_PEM, CA2_PEM, CLIENT_ID, encodeUserData, fakeJwt, LEAF_PEM, OWNER_OID, REPO_ROOT, tempDir, userData, userDataEnv, WINDOWS_DIR, WORKER_OID,
} from "./fixtures.mjs";

const DISK = "psdrive-0000000000a1";
const quick = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15)));

// ── Node.js and settings ────────────────────────────────────────────────

test("the launcher runs only on the image's Node.js, the version the Linux worker image pins", () => {
    assert.doesNotThrow(() => checkNodeVersion("24.22.1"));
    assert.throws(() => checkNodeVersion("24.22.0"), (error) => error instanceof LaunchError && /24\.22\.1.*24\.22\.0/.test(error.message));
    assert.throws(() => checkNodeVersion("26.13.0"), LaunchError);
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "deploy", "Dockerfile.worker"), "utf8");
    const pinned = [...dockerfile.matchAll(/^FROM\s+node:(\d+\.\d+\.\d+)-/gm)].map((match) => match[1]);
    assert.ok(pinned.length > 0);
    for (const version of pinned) assert.equal(version, EXPECTED_NODE_VERSION, "deploy/Dockerfile.worker");
    for (const script of ["Build-WorkerOsImage.ps1", "Pack-WinWorkerRelease.ps1"]) {
        const source = fs.readFileSync(path.join(WINDOWS_DIR, script), "utf8");
        assert.match(source, new RegExp(`\\[string\\]\\$NodeVersion = '${EXPECTED_NODE_VERSION.replace(/\./g, "\\.")}'`), script);
    }
});

test("worker.env: NAME=VALUE lines, comments, values taken literally, a name only once", () => {
    const entries = parseEnvFile("\uFEFF# comment\r\n\r\nA=1\r\nPATHS=C:\\x;D:\\y\nEQ=a=b=c\n  SPACED = kept as is \nEMPTY=\n");
    assert.deepEqual(entries, [
        { name: "A", value: "1" },
        { name: "PATHS", value: "C:\\x;D:\\y" },
        { name: "EQ", value: "a=b=c" },
        { name: "SPACED", value: " kept as is " },
        { name: "EMPTY", value: "" },
    ]);
    assert.throws(() => parseEnvFile("A=1\na=2\n"), /twice/);
    assert.throws(() => parseEnvFile("NOEQUALS\n"), /NAME=VALUE/);
    assert.throws(() => parseEnvFile("1BAD=x\n"), /not a valid setting name/);
});

// ── userData ────────────────────────────────────────────────────────────

test("userData decodes to every required value, the extra pairs and the controller's CA", () => {
    const decoded = decodeUserData(userData({ extraEnv: { EXAMPLE_API_URL: "https://api.example.test" } }));
    assert.deepEqual(decoded.env, userDataEnv());
    assert.deepEqual(decoded.extraEnv, { EXAMPLE_API_URL: "https://api.example.test" });
    assert.equal(decoded.controllerCaCert, CA_PEM);
    assert.deepEqual(Object.keys(decoded.env).sort(), [...USER_DATA_SETTINGS].sort());
});

test("userData fails closed: empty, not base64, not JSON, another version or unknown fields", () => {
    assert.throws(() => decodeUserData(""), /empty/);
    assert.throws(() => decodeUserData("not base64!"), /not base64/);
    assert.throws(() => decodeUserData(encodeUserData("{not json")), /not a JSON document/);
    assert.throws(() => decodeUserData(encodeUserData("[1]")), /JSON object/);
    assert.throws(() => decodeUserData(userData({ version: 2 })), /version 2 is not supported/);
    assert.throws(() => decodeUserData(userData({ extra: { secrets: {} } })), /unknown fields: secrets/);
    assert.throws(() => decodeUserData(userData({ env: { EXAMPLE_API_URL: "x" } })), /not a userData setting/);
});

test("userData fails closed when any required value is missing or empty", () => {
    for (const name of USER_DATA_SETTINGS) {
        const env = userDataEnv();
        delete env[name];
        assert.throws(() => decodeUserData(encodeUserData({ version: 1, env, controllerCaCert: CA_PEM })), new RegExp(`missing ${name}`), name);
        assert.throws(() => decodeUserData(userData({ env: { [name]: " " } })), new RegExp(`missing ${name}`), `${name} empty`);
    }
    assert.throws(() => decodeUserData(encodeUserData({ version: 1, env: userDataEnv() })), /controllerCaCert/);
});

test("userData values are checked, and none may carry a secret", () => {
    const refused = [
        [{ DATABASE_URL: "postgresql://worker:hunter2@db.example.test/pilotswarm" }, /password/],
        [{ DATABASE_URL: "mysql://db.example.test/x" }, /postgres/],
        [{ AZURE_STORAGE_ACCOUNT_URL: "http://example.blob.core.windows.net/" }, /https/],
        [{ AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net/?sv=2024&sig=abc" }, /without a user, query/],
        [{ PS_DISK_POOL_CONTROLLER_URL: "not a url" }, /not a URL/],
        [{ AZURE_CLIENT_ID: "worker" }, /GUID/],
        [{ EXPECTED_WIN_WORKER_OID: "1234" }, /GUID/],
        [{ PS_DISK_CONTROLLER_TOKEN_SCOPE: "api://a b/.default" }, /scope/],
        [{ ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: "{" }, /not JSON/],
        [{ ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: '{"endpointCredentials":[{"endpoint":"https://feed.example.test","username":"u","password":"p"}]}' }, /password/],
        [{ WIN_WORKER_CONFIG_VERSION: "has space" }, /WIN_WORKER_CONFIG_VERSION/],
        [{ PILOTSWARM_WORKER_OWNER_ONLY: "true" }, /exactly "0" or "1"/],
    ];
    for (const [env, pattern] of refused) assert.throws(() => decodeUserData(userData({ env })), pattern, JSON.stringify(env));
    assert.throws(() => decodeUserData(userData({ controllerCaCert: LEAF_PEM })), /not a CA certificate/);
    assert.throws(() => decodeUserData(userData({ controllerCaCert: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" })), /not a certificate/);
});

test("controllerCaCert holds one CA certificate, or two during a CA rotation, and every certificate is checked", () => {
    const two = `${CA_PEM}${CA2_PEM}`;
    for (const bundle of [CA_PEM, two, two.replace(/\n/g, "\r\n"), `${CA_PEM.trim()}\n\n${CA2_PEM.trim()}\n`]) {
        assert.equal(decodeUserData(userData({ controllerCaCert: bundle })).controllerCaCert, bundle, "returned whole");
    }
    for (const [label, bundle, message] of BAD_CA_BUNDLES) {
        assert.throws(() => decodeUserData(userData({ controllerCaCert: bundle })), (error) => {
            assert.ok(error instanceof LaunchError, label);
            assert.match(error.message, /^userData: controllerCaCert /, label);
            assert.match(error.message, message, label);
            return true;
        }, label);
    }
});

test("extra pairs may not set platform names, userData names or the launcher's own", () => {
    for (const name of ["PATH", "Path", "NODE_OPTIONS", "COPILOT_HOME", "PILOTSWARM_AGENT_PACKAGES", "PS_WORKSPACE_ROOTS", "WIN_WORKER_ANYTHING",
        "database_url", "AZURE_CLIENT_ID", "PILOTSWARM_WORKER_OWNER_TAG", "PS_LAUNCH_ID", "GITHUB_TOKEN", "GH_TOKEN"]) {
        assert.throws(() => decodeUserData(userData({ extraEnv: { [name]: "x" } })), /may not set/, name);
    }
    assert.throws(() => decodeUserData(userData({ extraEnv: { "BAD-NAME": "x" } })), /not a valid setting name/);
    assert.throws(() => decodeUserData(userData({ extraEnv: { GOOD: 1 } })), /must be a string/);
    assert.throws(() => decodeUserData(userData({ extraEnv: { GOOD: "a", good: "b" } })), /twice/);
});

test("extra pairs may not change how sessions' Git, Azure CLI, NuGet or credentials work", () => {
    for (const name of ["AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "git_config_parameters", "NUGET_PACKAGES", "GCM_CREDENTIAL_STORE",
        "ARTIFACTS_CREDENTIALPROVIDER_SESSIONTOKENCACHE_ENABLED"]) {
        assert.throws(() => decodeUserData(userData({ extraEnv: { [name]: "x" } })), /may not set/, name);
    }
    // Only a name that starts with a reserved prefix is refused.
    const extraEnv = { EXAMPLE_TOOL_URL: "https://tool.example.test", TOOL_GIT_MIRROR_URL: "https://git.example.test" };
    assert.deepEqual(decodeUserData(userData({ extraEnv })).extraEnv, extraEnv);
});

test("the worker's environment: worker.env, then userData, then extra pairs that may not override worker.env", () => {
    const decoded = decodeUserData(userData({ extraEnv: { EXAMPLE_API_URL: "https://api.example.test" } }));
    const values = buildWorkerEnv({ workerEnv: parseEnvFile("TEMP=C:\\pilotswarm\\temp\nGIT_AUTHOR_NAME=Agent\n"), userData: decoded });
    assert.equal(values.TEMP, "C:\\pilotswarm\\temp");
    assert.equal(values.DATABASE_URL, userDataEnv().DATABASE_URL);
    assert.equal(values.EXAMPLE_API_URL, "https://api.example.test");

    const collision = decodeUserData(userData({ extraEnv: { session_state_dir: "D:\\elsewhere" } }));
    assert.throws(() => buildWorkerEnv({ workerEnv: parseEnvFile("SESSION_STATE_DIR=C:\\pilotswarm\\copilot\\session-state\n"), userData: collision }), /worker\.env already sets/);
    assert.throws(() => buildWorkerEnv({ workerEnv: parseEnvFile("DATABASE_URL=postgresql://image@db/x\n"), userData: decoded }), /only userData may set/);
    for (const name of LAUNCHER_SETTINGS) {
        assert.throws(() => buildWorkerEnv({ workerEnv: parseEnvFile(`${name}=x\n`), userData: decoded }), /only the launcher sets/);
    }
});

test("external personal secrets need an owner-only worker: worker.env's mode, else the service's, against userData", () => {
    const refused = /PILOTSWARM_PERSONAL_SECRETS=external needs PILOTSWARM_WORKER_OWNER_ONLY=1/;
    const valuesOf = (workerEnv, ownerOnly) => buildWorkerEnv({
        workerEnv: parseEnvFile(workerEnv),
        userData: decodeUserData(userData({ env: { PILOTSWARM_WORKER_OWNER_ONLY: ownerOnly } })),
    });
    for (const workerEnv of ["PILOTSWARM_PERSONAL_SECRETS=external\n", "pilotswarm_personal_secrets= External \n"]) {
        assert.throws(() => checkPersonalSecretsOwnerOnly(valuesOf(workerEnv, "0")), (error) => error instanceof LaunchError && refused.test(error.message), workerEnv);
        assert.doesNotThrow(() => checkPersonalSecretsOwnerOnly(valuesOf(workerEnv, "1")), workerEnv);
    }
    assert.throws(() => checkPersonalSecretsOwnerOnly(valuesOf("", "0"), { PILOTSWARM_PERSONAL_SECRETS: "external" }), refused, "the service's own");
    assert.doesNotThrow(() => checkPersonalSecretsOwnerOnly(valuesOf("PILOTSWARM_PERSONAL_SECRETS=database\n", "0"), { PILOTSWARM_PERSONAL_SECRETS: "external" }),
        "worker.env's value is the one the worker gets");
    for (const workerEnv of ["", "PILOTSWARM_PERSONAL_SECRETS=database\n"]) {
        assert.doesNotThrow(() => checkPersonalSecretsOwnerOnly(valuesOf(workerEnv, "0")), `database secrets: ${JSON.stringify(workerEnv)}`);
    }
});

test("environment updates replace a name that differs only in case, and remove the launcher's own names", () => {
    const target = { Path: "a", TEMP: "b", PILOTSWARM_WORKER_OWNER_TAG: "owner.stale" };
    applyEnv(target, { PATH: "c" }, ["pilotswarm_worker_owner_tag"]);
    assert.deepEqual(target, { TEMP: "b", PATH: "c" });
});

test("paths under C:\\pilotswarm\\current are pinned to the release folder, lists included", () => {
    const pinned = pinReleasePaths({
        COPILOT_PKG_CACHE_HOME: "C:\\pilotswarm\\current\\copilot-pkg",
        PILOTSWARM_EXTENSION_MODULES: "c:\\PILOTSWARM\\Current\\packages\\x.mjs,D:\\other.mjs",
        ROOTS: "C:\\pilotswarm\\temp;C:\\pilotswarm\\current",
        LOOKALIKE: "C:\\pilotswarm\\currently\\x",
        UNRELATED: "value",
    }, "C:\\pilotswarm\\current", "C:\\pilotswarm\\releases\\0123456789ab-cdef01234567");
    assert.deepEqual(pinned, {
        COPILOT_PKG_CACHE_HOME: "C:\\pilotswarm\\releases\\0123456789ab-cdef01234567\\copilot-pkg",
        PILOTSWARM_EXTENSION_MODULES: "C:\\pilotswarm\\releases\\0123456789ab-cdef01234567\\packages\\x.mjs,D:\\other.mjs",
        ROOTS: "C:\\pilotswarm\\temp;C:\\pilotswarm\\releases\\0123456789ab-cdef01234567",
        LOOKALIKE: "C:\\pilotswarm\\currently\\x",
        UNRELATED: "value",
    });
});

test("the identity check reads the token's oid", () => {
    assert.equal(tokenObjectId(fakeJwt({ oid: WORKER_OID.toUpperCase() })), WORKER_OID);
    assert.equal(tokenObjectId(fakeJwt({ sub: "x" })), null);
    assert.throws(() => tokenObjectId("opaque"), /not a JWT/);
});

// ── Parts ───────────────────────────────────────────────────────────────

test("the Azure CLI sign-in checks the client ID, runs through cmd.exe /d /s /c and retries without blocking", async () => {
    let spawned = 0;
    assert.throws(() => createAzSignIn({ clientId: "x & calc", configDir: "C:\\pilotswarm\\azure-cli", spawnProcess: () => { spawned++; } }), /not a GUID/);
    assert.equal(spawned, 0);

    const calls = [];
    const outcomes = [1, 1, 0];
    const spawnProcess = (file, args, options) => {
        calls.push({ file, args, options });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        const code = outcomes.shift();
        setImmediate(() => {
            if (code) child.stderr.emit("data", "ERROR: identity not found\n");
            child.emit("close", code);
        });
        return child;
    };
    const delays = [];
    const timers = {
        setTimeout: (fn, ms) => {
            if (ms === 120_000) return { attempt: true };
            delays.push(ms);
            setImmediate(fn);
            return { retry: true };
        },
        clearTimeout: () => {},
    };
    const logs = [];
    const az = createAzSignIn({ clientId: CLIENT_ID.toUpperCase(), configDir: "C:\\pilotswarm\\azure-cli", env: { A: "1" }, systemRoot: "C:\\Windows", spawnProcess, timers, log: (line) => logs.push(line) });
    az.start();
    for (let i = 0; i < 50 && !az.succeeded; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(az.succeeded, true);
    assert.deepEqual(delays, [30_000, 300_000]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].file, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(calls[0].args, ["/d", "/s", "/c", `"az login --identity --client-id ${CLIENT_ID} --allow-no-subscriptions --output none"`]);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.equal(calls[0].options.env.AZURE_CONFIG_DIR, "C:\\pilotswarm\\azure-cli");
    assert.ok(logs.some((line) => /sign-in failed.*identity not found/.test(line)));
});

test("clearing a folder removes what is in it, never the folder, and never follows a link", async () => {
    const home = tempDir("ps-win-clear-");
    try {
        const outside = path.join(home, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
        const temp = path.join(home, "temp");
        fs.mkdirSync(path.join(temp, "nested", "deeper"), { recursive: true });
        fs.writeFileSync(path.join(temp, "nested", "deeper", "a.txt"), "a");
        fs.writeFileSync(path.join(temp, "b.txt"), "b");
        fs.symlinkSync(outside, path.join(temp, "link"), "junction");
        const result = await clearFolderContents(temp);
        assert.deepEqual(result, { removed: 3, failed: [] });
        assert.deepEqual(fs.readdirSync(temp), []);
        assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
        assert.deepEqual(await clearFolderContents(path.join(home, "missing")), { removed: 0, failed: [] });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the attacher client: loopback only, and a 401 reads the token file again once", async () => {
    assert.throws(() => createAttacherClient({ url: "http://10.0.0.5:3099", tokenFile: "x" }), /127\.0\.0\.1/);
    assert.throws(() => createAttacherClient({ url: "https://127.0.0.1:3099", tokenFile: "x" }), /127\.0\.0\.1/);
    let tokenOnDisk = "first";
    let serverToken = "first";
    const seen = [];
    const client = createAttacherClient({
        url: "http://127.0.0.1:3099",
        tokenFile: "C:\\pilotswarm\\run\\attacher.token",
        readFile: async () => `${tokenOnDisk}\r\n`,
        request: async (url, options) => {
            seen.push(options.headers.authorization);
            return options.headers.authorization === `Bearer ${serverToken}` ? { status: 200, body: { ok: true } } : { status: 401, body: { ok: false } };
        },
    });
    await client.offlineLun0({ diskName: DISK, workerPid: 42 });
    // The attacher restarted with a new token: one 401, then the file is read again.
    tokenOnDisk = "second";
    serverToken = "second";
    await client.offlineLun0({ diskName: DISK, workerPid: 42 });
    // A token the file does not hold yet: one retry, then the 401 stands.
    serverToken = "third";
    await assert.rejects(client.offlineLun0({ diskName: DISK, workerPid: 42 }), /HTTP 401/);
    assert.deepEqual(seen, ["Bearer first", "Bearer first", "Bearer second", "Bearer second", "Bearer second"]);
});

test("the release sync is retried while it may succeed, and fails closed otherwise", async () => {
    const answers = [new Error("connect ECONNREFUSED"), { status: 503, body: { ok: false, code: "BLOB_UNAVAILABLE", retryable: true } }, { status: 200, body: { ok: true, commitSha: "abc", changed: true } }];
    const attacher = { syncRelease: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; } };
    assert.deepEqual(await syncReleaseWithRetry({ attacher, sleep: async () => {} }), { ok: true, commitSha: "abc", changed: true });

    const mismatch = { syncRelease: async () => ({ status: 502, body: { ok: false, code: "HASH_MISMATCH", message: "worker-release-x.zip has SHA-256 1, not 2", retryable: false } }) };
    await assert.rejects(syncReleaseWithRetry({ attacher: mismatch, sleep: async () => {} }), (error) => error instanceof LaunchError && /HASH_MISMATCH/.test(error.message));

    let now = 0;
    const down = { syncRelease: async () => { throw new Error("ECONNREFUSED"); } };
    await assert.rejects(syncReleaseWithRetry({ attacher: down, sleep: async (ms) => { now += ms; }, now: () => now, budgetMs: 60_000 }), /did not succeed within 1 minutes/);
});

test("register is polled until the VM is active", async () => {
    const answers = [{ status: "inactive", reason: "STANDBY" }, new Error("HTTP 503"), { status: "inactive", reason: "FROZEN" }, { status: "active", ownerOid: OWNER_OID.toUpperCase() }];
    const logs = [];
    const controller = { register: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; } };
    assert.deepEqual(await waitForActive({ controller, sleep: async () => {}, log: (line) => logs.push(line) }), { ownerOid: OWNER_OID });
    assert.equal(logs.length, 3);
    assert.deepEqual(await waitForActive({ controller: { register: async () => ({ status: "active", ownerOid: null }) }, sleep: async () => {} }), { ownerOid: null });
});

// ── The whole start ─────────────────────────────────────────────────────

/** A launcher with fake IMDS, controller, attacher, az and worker; `events` records what happened in order. */
function harness(t, {
    env: userEnv = {}, extraEnv, heartbeat = () => ({ ownerOid: null, attached: null }), register = () => ({ status: "active", ownerOid: null }),
    sync = async () => ({ status: 200, body: { ok: true, commitSha: "c0ffee", changed: false } }), offline = async () => ({ ok: true }),
    detach = async () => ({ ok: true }), importWorker, workerEnv = "", oid = WORKER_OID, nodeVersion = EXPECTED_NODE_VERSION, controllerCaCert = CA_PEM,
} = {}) {
    const root = tempDir("ps-win-launch-");
    t.after(() => {
        delete globalThis[HEARTBEAT_HANDOVER];
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(root, "worker.env"), workerEnv);
    fs.mkdirSync(path.join(root, "temp", "left-over"), { recursive: true });
    fs.writeFileSync(path.join(root, "temp", "left-over", "file.txt"), "x");
    const releaseDir = path.join(root, "releases", "0123456789ab-cdef01234567");
    const events = [];
    const counts = { heartbeat: 0, imds: 0 };
    const state = { env: {}, imported: null, az: null, controllerCreated: false, heartbeat: null };
    const deps = {
        root,
        env: state.env,
        nodeVersion,
        sleep: quick,
        signals: new EventEmitter(),
        heartbeatIntervalMs: 10,
        freerOptions: { initialDelayMs: 1, maxDelayMs: 5 },
        registerOptions: { intervalMs: 5, slowIntervalMs: 5 },
        imds: {
            userData: async () => { counts.imds++; return userData({ env: userEnv, extraEnv, controllerCaCert }); },
            token: async () => { counts.imds++; return { token: fakeJwt({ oid }), expiresAt: Date.now() + 3_600_000 }; },
        },
        createController: (options) => {
            state.controllerCreated = true;
            state.controllerOptions = options;
            return {
                heartbeat: async (body) => {
                    counts.heartbeat++;
                    events.push({ type: "heartbeat", body });
                    return heartbeat(counts.heartbeat, body);
                },
                register: async () => {
                    const answer = register();
                    events.push({ type: "register", answer });
                    return answer;
                },
                detach: async (body) => {
                    events.push({ type: "detach", body });
                    return detach(body);
                },
            };
        },
        createAttacher: () => ({
            offlineLun0: async (body) => {
                events.push({ type: "offline", body });
                return offline(body);
            },
            syncRelease: async () => {
                events.push({ type: "sync-start" });
                try {
                    return await sync(counts);
                } finally {
                    events.push({ type: "sync-end" });
                }
            },
        }),
        realpath: async () => releaseDir,
        access: async () => {},
        createAzSignIn: (options) => {
            state.az = { options, started: false, stopped: false, start() { this.started = true; events.push({ type: "az" }); }, stop() { this.stopped = true; } };
            return state.az;
        },
        importWorker: async (file) => {
            state.imported = { file, env: { ...state.env }, handover: globalThis[HEARTBEAT_HANDOVER] };
            events.push({ type: "import" });
            if (importWorker) await importWorker(file, state);
        },
        log: () => {},
    };
    return { deps, events, counts, state, root, releaseDir, run: async () => {
        const outcome = await runLauncher(deps);
        if (outcome?.heartbeat) {
            state.heartbeat = outcome.heartbeat;
            t.after(() => outcome.heartbeat.stop());
        }
        return outcome;
    } };
}

const indexOf = (events, type) => events.findIndex((event) => event.type === type);

test("a refused Node.js stops the launch before IMDS or the controller", async (t) => {
    const h = harness(t, { nodeVersion: "26.13.0" });
    await assert.rejects(h.run(), LaunchError);
    assert.equal(h.counts.imds, 0);
    assert.equal(h.state.controllerCreated, false);
});

test("a missing userData value or another identity stops the launch before the first heartbeat", async (t) => {
    const missing = harness(t, { env: { AZURE_STORAGE_ACCOUNT_URL: "" } });
    await assert.rejects(missing.run(), /missing AZURE_STORAGE_ACCOUNT_URL/);
    assert.equal(missing.counts.heartbeat, 0);

    const other = harness(t, { oid: "99999999-9999-9999-9999-999999999999" });
    await assert.rejects(other.run(), /not to the worker identity/);
    assert.equal(other.counts.heartbeat, 0);
    assert.equal(other.state.controllerCreated, false);
});

test("external personal secrets on a worker that isn't owner-only stop the launch before a token, a heartbeat or a worker", async (t) => {
    const workerEnv = "PILOTSWARM_PERSONAL_SECRETS=external\n";
    const refused = harness(t, { workerEnv });
    await assert.rejects(refused.run(), (error) => error instanceof LaunchError && /PILOTSWARM_WORKER_OWNER_ONLY=1/.test(error.message));
    assert.equal(refused.counts.imds, 1, "only userData was read");
    assert.equal(refused.counts.heartbeat, 0);
    assert.equal(refused.state.controllerCreated, false);
    assert.equal(refused.state.imported, null);

    const ownerOnly = harness(t, { workerEnv, env: { PILOTSWARM_WORKER_OWNER_ONLY: "1" }, register: () => ({ status: "active", ownerOid: OWNER_OID }) });
    assert.equal((await ownerOnly.run()).workerStarted, true);
    assert.equal(ownerOnly.state.imported.env.PILOTSWARM_PERSONAL_SECRETS, "external");
    assert.equal(ownerOnly.state.imported.env.PILOTSWARM_WORKER_OWNER_TAG, `owner.${OWNER_OID}`);
});

test("during a CA rotation the controller client trusts both CAs of userData, and a bad second certificate stops the launch", async (t) => {
    const bundle = `${CA_PEM}${CA2_PEM}`;
    const h = harness(t, { controllerCaCert: bundle });
    assert.equal((await h.run()).workerStarted, true);
    assert.equal(h.state.controllerOptions.ca, bundle, "the whole bundle reaches TLS");

    const bad = harness(t, { controllerCaCert: `${CA_PEM}${LEAF_PEM}` });
    await assert.rejects(bad.run(), /controllerCaCert certificate 2 is not a CA certificate/);
    assert.equal(bad.state.controllerCreated, false);
});

test("the heartbeat starts before the release sync and keeps going while it runs", async (t) => {
    const h = harness(t, {
        sync: async (counts) => {
            const at = counts.heartbeat;
            while (counts.heartbeat < at + 3) await quick(5);
            return { status: 200, body: { ok: true, commitSha: "c0ffee", changed: true } };
        },
    });
    fs.writeFileSync(path.join(h.root, "worker.env"), `COPILOT_PKG_CACHE_HOME=${path.join(h.root, "current", "copilot-pkg")}\n`);
    const outcome = await h.run();
    assert.equal(outcome.workerStarted, true);
    const first = indexOf(h.events, "heartbeat");
    const start = indexOf(h.events, "sync-start");
    const end = indexOf(h.events, "sync-end");
    assert.ok(first >= 0 && first < start, "the first heartbeat goes out before the sync");
    assert.ok(h.events.slice(start, end).filter((event) => event.type === "heartbeat").length >= 3, "heartbeats continue during the sync");
    const body = h.events[first].body;
    assert.equal(body.phase, "starting");
    assert.equal(body.attachedDisk, null);
    assert.equal(body.configVersion, "cfg-0001");
    assert.match(body.launchId, /^[0-9a-f-]{36}$/);
    assert.equal(h.state.imported.env.PS_LAUNCH_ID, body.launchId);
    assert.equal(h.state.imported.env.DATABASE_URL, userDataEnv().DATABASE_URL);
    assert.equal(h.state.imported.env.COPILOT_PKG_CACHE_HOME, path.join(h.releaseDir, "copilot-pkg"), "pinned to the release");
    assert.equal(h.state.imported.file, path.join(h.releaseDir, "packages", "sdk", "examples", "worker.js"));
    assert.equal("PILOTSWARM_WORKER_OWNER_TAG" in h.state.imported.env, false);
    assert.deepEqual(fs.readdirSync(path.join(h.root, "temp")), [], "temp is cleared at start");
    assert.ok(indexOf(h.events, "az") < indexOf(h.events, "import"), "az signs in before the worker loads, without waiting");
});

test("LUN 0 is freed before anything that can fail, retried with backoff while the heartbeat runs", async (t) => {
    let offlineCalls = 0;
    let detachCalls = 0;
    const h = harness(t, {
        heartbeat: (n) => ({ ownerOid: null, attached: n <= 2 ? { diskName: DISK, rootSessionId: "root-1", state: "attached" } : null }),
        offline: async () => {
            if (++offlineCalls <= 2) throw new Error("the attacher is not up yet");
            return { ok: true };
        },
        detach: async () => {
            if (++detachCalls === 1) throw new Error("HTTP 503 STARTING");
            return { ok: true, detached: true };
        },
        sync: async () => ({ status: 502, body: { ok: false, code: "HASH_MISMATCH", message: "the zip's hash is not the one named", retryable: false } }),
    });
    await assert.rejects(h.run(), /HASH_MISMATCH/);
    const start = indexOf(h.events, "sync-start");
    const before = h.events.slice(0, start);
    assert.equal(before.filter((event) => event.type === "offline").length, 4, "two failures, then once per detach attempt");
    const detaches = before.filter((event) => event.type === "detach");
    assert.equal(detaches.length, 2);
    for (const { body } of detaches) assert.deepEqual({ ...body, requestId: "x" }, { diskName: DISK, rootSessionId: "root-1", requestId: "x", crashed: true });
    assert.equal(detaches[0].body.requestId, detaches[1].body.requestId, "the same request ID on every retry");
    assert.equal(h.events.filter((event) => event.type === "offline")[0].body.workerPid, process.pid);
    assert.ok(h.events.slice(start).every((event) => event.type !== "offline"), "a stale answer does not free the drive again");
    assert.equal(h.state.imported, null);
});

test("the worker waits for register: inactive keeps polling, active imports it with the owner's tag", async (t) => {
    const answers = [{ status: "inactive", reason: "STANDBY" }, { status: "inactive", reason: "FROZEN" }, { status: "active", ownerOid: OWNER_OID.toUpperCase() }];
    const h = harness(t, { register: () => answers.shift() ?? { status: "active", ownerOid: OWNER_OID } });
    await h.run();
    const registers = h.events.filter((event) => event.type === "register");
    assert.equal(registers.length, 3);
    assert.ok(h.events.lastIndexOf(registers[2]) < indexOf(h.events, "import"));
    assert.equal(h.state.imported.env.PILOTSWARM_WORKER_OWNER_TAG, `owner.${OWNER_OID}`);
});

test("an unbound owner-only VM imports no worker until a heartbeat answer names its owner", async (t) => {
    const h = harness(t, {
        env: { PILOTSWARM_WORKER_OWNER_ONLY: "1" },
        heartbeat: (n) => {
            if (n < 6) return { ownerOid: null, attached: null };
            if (n < 8) return { ownerOid: OWNER_OID, frozen: true, attached: null };
            return { ownerOid: OWNER_OID, attached: null };
        },
    });
    await h.run();
    const imported = indexOf(h.events, "import");
    const heartbeatsBefore = h.events.slice(0, imported).filter((event) => event.type === "heartbeat").length;
    assert.ok(heartbeatsBefore >= 8, `the worker started only after the owner was named outside a freeze (${heartbeatsBefore} heartbeats)`);
    assert.equal(h.state.imported.env.PILOTSWARM_WORKER_OWNER_TAG, `owner.${OWNER_OID}`);
    assert.equal(h.events.filter((event) => event.type === "register").length, 1);
});

test("the Dev Drive extension takes the heartbeat over with its own takeOverHeartbeat()", async (t) => {
    let tookOver = null;
    const h = harness(t, {
        importWorker: async () => {
            tookOver = await takeOverHeartbeat();
        },
    });
    await h.run();
    assert.equal(tookOver, true);
    assert.equal(typeof h.state.imported.handover?.stop, "function");
    assert.equal(globalThis[HEARTBEAT_HANDOVER], undefined, "the slot is emptied");
    const sent = h.counts.heartbeat;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.counts.heartbeat, sent, "no launcher heartbeat after the hand-over");
});

test("a stop request before the worker starts stops the heartbeat and imports nothing", async (t) => {
    const h = harness(t, { register: () => ({ status: "inactive", reason: "FROZEN" }) });
    const running = h.run();
    while (h.events.filter((event) => event.type === "register").length < 2) await quick(5);
    h.deps.signals.emit("SIGINT", "SIGINT");
    assert.deepEqual(await running, { exitCode: 0, stopped: "SIGINT" });
    const sent = h.counts.heartbeat;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.counts.heartbeat, sent);
    assert.equal(h.state.imported, null);
    assert.equal(h.deps.signals.listenerCount("SIGINT"), 0);
});
