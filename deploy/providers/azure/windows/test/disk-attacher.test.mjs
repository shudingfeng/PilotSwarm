// disk-attacher.mjs: authentication, request checks, the LUN 0 routes with a
// fake PowerShell runner, the loopback-only listener, the embedded disk
// script, zip checks and /sync-release against a fake release container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import {
    AttacherError, attacherSettings, checkArchiveEntries, createAttacherApp, createAuthorizer, createBlobClient, createDiskOps,
    createReleaseSync, createZipExtractor, decodeAttacherUserData, DISK_OPS_SCRIPT, diskOpsEnv, findLinks, lastJsonObject, newToken,
    preparePrivateTemp, privateFolderProblems, readZipEntries, releaseFolderName, runProcess, serviceSid, startServer, validateReleaseManifest,
    windowsPowerShell, writeTokenFile,
} from "../disk-attacher.mjs";
import { requestJson } from "../launcher.mjs";
import { BAD_CA_BUNDLES, CA_PEM, CA2_PEM, CLIENT_ID, LEAF_PEM, psQuote, pwsh, runDriver, tempDir, userData, WINDOWS_DIR } from "./fixtures.mjs";

const DISK = "psdrive-0000000000b2";
const SID = "S-1-5-80-3872531353-3733398320-4078817223-2862367190-1897339925";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

test("the worker service's SID derives from its name, as the scripts and sc.exe have it", () => {
    assert.equal(serviceSid("PilotSwarmWorker"), SID);
    const module = fs.readFileSync(path.join(WINDOWS_DIR, "PilotSwarm.WinWorker.psm1"), "utf8");
    assert.match(module, new RegExp(`\\$script:WorkerServiceSid = '${SID}'`));
    if (process.platform === "win32") {
        const shown = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "sc.exe"), ["showsid", "PilotSwarmWorker"], { encoding: "utf8", windowsHide: true });
        assert.match(shown.stdout, new RegExp(SID));
    }
});

test("settings: the attacher URL must be http://127.0.0.1, and its files stay inside C:\\pilotswarm", () => {
    assert.deepEqual(attacherSettings({}), {
        port: 3099,
        tokenFile: "C:\\pilotswarm\\run\\attacher.token",
        caFile: "C:\\pilotswarm\\disk-controller-ca.crt",
        catalogFile: "C:\\pilotswarm\\model_providers.json",
        container: "win-worker-releases",
    });
    for (const url of ["http://localhost:3099", "http://0.0.0.0:3099", "https://127.0.0.1:3099", "http://127.0.0.1", "http://127.0.0.1:3099/api", "http://[::1]:3099"]) {
        assert.throws(() => attacherSettings({ PS_DISK_ATTACHER_URL: url }), /127\.0\.0\.1/, url);
    }
    assert.throws(() => attacherSettings({ PS_DISK_ATTACHER_TOKEN_FILE: "C:\\Users\\Public\\token" }), /inside C:\\pilotswarm/);
    assert.throws(() => attacherSettings({ PS_MODEL_PROVIDERS_PATH: "C:\\pilotswarm\\..\\x.json" }), /inside C:\\pilotswarm/);
    assert.throws(() => attacherSettings({ PS_WORKER_RELEASES_CONTAINER: "Bad_Name" }), /container/);
});

test("userData: the storage account, the client ID and a CA certificate", () => {
    assert.deepEqual(decodeAttacherUserData(userData()), { accountUrl: "https://example.blob.core.windows.net/", clientId: CLIENT_ID, controllerCaCert: CA_PEM });
    assert.throws(() => decodeAttacherUserData(userData({ env: { AZURE_STORAGE_ACCOUNT_URL: "http://example.blob.core.windows.net/" } })), /https/);
    assert.throws(() => decodeAttacherUserData(userData({ env: { AZURE_CLIENT_ID: "x" } })), /GUID/);
    assert.throws(() => decodeAttacherUserData(userData({ controllerCaCert: LEAF_PEM })), /not a CA/);
    assert.throws(() => decodeAttacherUserData(userData({ version: 2 })), /version 1/);
    assert.throws(() => decodeAttacherUserData(""), /missing/);
});

test("userData: during a CA rotation the attacher takes both CAs whole, and checks every certificate", () => {
    const two = `${CA_PEM}${CA2_PEM}`;
    for (const bundle of [two, two.replace(/\n/g, "\r\n")]) {
        assert.equal(decodeAttacherUserData(userData({ controllerCaCert: bundle })).controllerCaCert, bundle);
    }
    for (const [label, bundle, message] of BAD_CA_BUNDLES) {
        assert.throws(() => decodeAttacherUserData(userData({ controllerCaCert: bundle })), (error) => {
            assert.match(error.message, /^userData: controllerCaCert /, label);
            assert.match(error.message, message, label);
            return true;
        }, label);
    }
    assert.throws(() => decodeAttacherUserData(userData({ controllerCaCert: 42 })), /controllerCaCert is not a PEM certificate/);
});

test("the token is compared in constant time, and anything else is refused", () => {
    const token = newToken();
    assert.ok(token.length >= 43);
    const authorize = createAuthorizer(token);
    assert.equal(authorize(`Bearer ${token}`), true);
    assert.equal(authorize(`Bearer ${token}x`), false);
    assert.equal(authorize(`Bearer ${"a".repeat(token.length)}`), false);
    assert.equal(authorize("Bearer short"), false);
    assert.equal(authorize(`Basic ${token}`), false);
    assert.equal(authorize(`bearer ${token}`), false);
    assert.equal(authorize(undefined), false);
    assert.equal(authorize(""), false);
    assert.throws(() => createAuthorizer("short"), /too short/);
});

test("the token file is restricted while empty, then written and moved into place", async () => {
    const home = tempDir("ps-win-token-");
    try {
        const file = path.join(home, "run", "attacher.token");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "previous");
        const restricted = [];
        await writeTokenFile(file, "secret-token-value", { setAcl: async (temp) => restricted.push({ temp, content: fs.readFileSync(temp, "utf8") }) });
        assert.equal(restricted.length, 1);
        assert.equal(restricted[0].content, "", "the file holds nothing until its access list is set");
        assert.notEqual(restricted[0].temp, file);
        assert.equal(fs.readFileSync(file, "utf8"), "secret-token-value");
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ["attacher.token"]);
        await assert.rejects(writeTokenFile(file, "next", { setAcl: async () => { throw new Error("icacls failed"); } }), /icacls failed/);
        assert.equal(fs.readFileSync(file, "utf8"), "secret-token-value", "a failed restriction leaves the old file");
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ["attacher.token"]);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ── Routes ──────────────────────────────────────────────────────────────

/** Disk operations on a fake LUN 0; every call is recorded, and overlapping calls are caught. */
function fakeDisk({ extendAnswers = [] } = {}) {
    const calls = [];
    let online = false;
    let busy = false;
    const run = async (name, args, answer) => {
        assert.equal(busy, false, "LUN 0 operations run one at a time");
        busy = true;
        calls.push({ name, ...args });
        await new Promise((resolve) => setTimeout(resolve, 5));
        busy = false;
        return answer();
    };
    return {
        calls,
        get online() { return online; },
        online: (args) => run("online", args, () => { const changed = !online; online = true; return { ok: true, changed }; }),
        offline: (args) => run("offline", args, () => { const changed = online; online = false; return { ok: true, changed }; }),
        extend: (args) => run("extend", args, () => extendAnswers.shift() ?? { ok: true, changed: false }),
    };
}

function app({ disk = fakeDisk(), sync = async () => ({ ok: true, changed: false }) } = {}) {
    const token = newToken();
    return { token, disk, app: createAttacherApp({ authorize: createAuthorizer(token), disk, sync }) };
}

const post = (a, route, body, token = a.token) => a.app.handle({
    method: "POST", url: route, headers: { authorization: `Bearer ${token}` }, body: typeof body === "string" ? body : JSON.stringify(body),
});

test("every route needs the token, and a refused request reaches no disk operation", async () => {
    const a = app();
    for (const route of ["/online-lun0", "/offline-lun0", "/extend-lun0", "/sync-release", "/nowhere"]) {
        assert.equal((await post(a, route, { diskName: DISK }, "wrong")).status, 401, route);
        assert.equal((await a.app.handle({ method: "POST", url: route, headers: {}, body: "{}" })).status, 401, route);
    }
    assert.equal((await post(a, "/nowhere", {})).status, 404);
    assert.equal((await a.app.handle({ method: "GET", url: "/online-lun0", headers: { authorization: `Bearer ${a.token}` } })).status, 405);
    assert.deepEqual(a.disk.calls, []);
});

test("request values are checked before any disk operation", async () => {
    const a = app();
    const refused = [
        ["/online-lun0", "{not json"],
        ["/online-lun0", "[]"],
        ["/online-lun0", {}],
        ...["../x", "a b", "x;del", "\"q\"", "-start", "end.", "x".repeat(81), "q:\\x", "x\ny", 5].map((diskName) => ["/online-lun0", { diskName }]),
        ...[0, -1, "12", 1.5, 2 ** 31].map((workerPid) => ["/offline-lun0", { diskName: DISK, workerPid }]),
        ...[0, 65_537, "100", 1.5, null].map((sizeGb) => ["/extend-lun0", { diskName: DISK, sizeGb }]),
    ];
    for (const [route, body] of refused) {
        const answer = await post(a, route, body);
        assert.equal(answer.status, 400, `${route} ${JSON.stringify(body)}`);
        assert.equal(answer.body.ok, false);
    }
    assert.deepEqual(a.disk.calls, []);
});

test("the LUN 0 routes are idempotent, run one at a time, and a new drive gets a disk GUID of its own", async () => {
    const a = app({ disk: fakeDisk({ extendAnswers: [{ ok: false, retry: true, message: "Windows sees 1099511627776 bytes" }, { ok: true, changed: true }] }) });
    const answers = await Promise.all([
        post(a, "/online-lun0", { diskName: DISK }),
        post(a, "/online-lun0", { diskName: DISK }),
        post(a, "/offline-lun0", { diskName: DISK, workerPid: 4242 }),
        post(a, "/offline-lun0", { diskName: DISK, workerPid: 4242 }),
        post(a, "/online-lun0", { diskName: "psdrive-0000000000c3" }),
    ]);
    for (const answer of answers) assert.deepEqual(answer, { status: 200, body: { ok: true } });
    assert.deepEqual(a.disk.calls.map((call) => [call.name, call.diskName, call.newGuid ?? call.workerPid]), [
        ["online", DISK, true],
        ["online", DISK, false],
        ["offline", DISK, 4242],
        ["offline", DISK, 4242],
        ["online", "psdrive-0000000000c3", true],
    ]);
    assert.deepEqual(await post(a, "/extend-lun0", { diskName: DISK, sizeGb: 1280 }), { status: 200, body: { ok: false, retry: true, message: "Windows sees 1099511627776 bytes" } });
    assert.deepEqual(await post(a, "/extend-lun0", { diskName: DISK, sizeGb: 1280 }), { status: 200, body: { ok: true } });
});

test("a failed disk operation answers 500 with its message", async () => {
    const disk = fakeDisk();
    disk.online = async () => ({ ok: false, message: "drive Q: is already in use by another volume" });
    const a = app({ disk });
    const answer = await post(a, "/online-lun0", { diskName: DISK });
    assert.equal(answer.status, 500);
    assert.equal(answer.body.code, "DISK_OPERATION_FAILED");
    assert.match(answer.body.message, /already in use/);
});

test("the listener binds 127.0.0.1 only and serves the routes", async () => {
    assert.throws(() => startServer({ handle: async () => ({}) }, { port: 0, host: "0.0.0.0" }), /127\.0\.0\.1/);
    const a = app({ sync: async () => ({ ok: true, changed: false, commitSha: "c" }) });
    const server = await startServer(a.app, { port: 0 });
    try {
        const { address, port } = server.address();
        assert.equal(address, "127.0.0.1");
        const base = `http://127.0.0.1:${port}`;
        assert.equal((await requestJson(`${base}/sync-release`, { body: {} })).status, 401);
        assert.deepEqual(await requestJson(`${base}/sync-release`, { body: {}, headers: { authorization: `Bearer ${a.token}` } }), { status: 200, body: { ok: true, changed: false, commitSha: "c" } });
        const big = await requestJson(`${base}/online-lun0`, { body: { diskName: DISK, pad: "x".repeat(20_000) }, headers: { authorization: `Bearer ${a.token}` } });
        assert.equal(big.status, 413);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("disk operations run the script with -File and the values as separate arguments", async () => {
    const runs = [];
    const run = async (file, args, options) => {
        runs.push({ file, args, options });
        return { code: 0, stdout: 'WARNING: noise\r\n{"ok":true,"changed":false}\r\n', stderr: "" };
    };
    const env = { Path: "C:\\Windows\\System32", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", SystemRoot: "C:\\Windows", TEMP: "C:\\Windows\\TEMP", tmp: "C:\\Windows\\TEMP" };
    const privateTemp = "C:\\pilotswarm\\run\\ps-temp";
    const ops = createDiskOps({ scriptPath: "C:\\pilotswarm\\run\\disk-ops.ps1", tempDir: privateTemp, powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", run, attacherPid: 7, env });
    assert.deepEqual(await ops.online({ diskName: DISK, newGuid: true }), { ok: true, changed: false });
    await ops.offline({ diskName: DISK, workerPid: 99 });
    await ops.extend({ diskName: DISK, sizeGb: 1024 });
    await ops.folderAcl(privateTemp);
    const prefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\pilotswarm\\run\\disk-ops.ps1"];
    assert.deepEqual(runs.map((entry) => entry.args), [
        [...prefix, "-Operation", "Online", "-DiskName", DISK, "-NewGuid"],
        [...prefix, "-Operation", "Offline", "-DiskName", DISK, "-WorkerPid", "99", "-AttacherPid", "7"],
        [...prefix, "-Operation", "Extend", "-DiskName", DISK, "-SizeGb", "1024"],
        [...prefix, "-Operation", "FolderAcl", "-Root", privateTemp],
    ]);
    // Every operation's TEMP and TMP are the private folder, whatever the attacher's own were, and PowerShell 7's
    // PSModulePath is gone.
    for (const entry of runs) {
        assert.deepEqual(entry.options.env, { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", TEMP: privateTemp, TMP: privateTemp });
    }
    assert.deepEqual(diskOpsEnv({ psmodulepath: "x", Temp: "y", TMP: "z", KEEP: "1" }, privateTemp), { KEEP: "1", TEMP: privateTemp, TMP: privateTemp });
    assert.throws(() => createDiskOps({ scriptPath: "x.ps1", run }), /private temporary folder/);
    assert.throws(() => createDiskOps({ scriptPath: "x.ps1", tempDir: "ps-temp", run }), /absolute path/);
    assert.equal(windowsPowerShell("C:\\Windows"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const silent = createDiskOps({ scriptPath: "x.ps1", tempDir: privateTemp, run: async () => ({ code: 1, stdout: "", stderr: "Set-Disk : Access denied" }) });
    await assert.rejects(silent.online({ diskName: DISK }), (error) => error instanceof AttacherError && /Access denied/.test(error.message));
    assert.deepEqual(lastJsonObject('{"a":1}\n{"b":2}\nnot json\n'), { b: 2 });
});

const FULL = 0x1f01ff;
/** The run folder's list as the image sets it, which run\ps-temp inherits: SYSTEM and Administrators Full, the worker Read+Execute. */
const IMAGE_RUN_ACL = {
    ok: true,
    owner: "S-1-5-32-544",
    rules: [
        { sid: "S-1-5-18", allow: true, rights: FULL, inheritOnly: false },
        { sid: "S-1-5-32-544", allow: true, rights: FULL, inheritOnly: false },
        { sid: SID, allow: true, rights: 0x1200a9, inheritOnly: false },
    ],
};

test("the private temporary folder: only SYSTEM and Administrators may own it or write in it", () => {
    const withRule = (rule) => ({ ...IMAGE_RUN_ACL, rules: [...IMAGE_RUN_ACL.rules, rule] });
    assert.deepEqual(privateFolderProblems(IMAGE_RUN_ACL), []);
    assert.deepEqual(privateFolderProblems({ ...IMAGE_RUN_ACL, owner: "S-1-5-18" }), []);
    // Reading is not writing: GENERIC_READ arrives as a negative 32-bit mask.
    assert.deepEqual(privateFolderProblems(withRule({ sid: "S-1-5-32-545", allow: true, rights: -2147483648, inheritOnly: false })), []);
    assert.deepEqual(privateFolderProblems(withRule({ sid: "S-1-1-0", allow: false, rights: FULL, inheritOnly: false })), [], "a deny rule takes nothing away");

    assert.deepEqual(privateFolderProblems(withRule({ sid: SID, allow: true, rights: 0x1301bf, inheritOnly: false })), [`${SID} may write in it`]);
    assert.deepEqual(privateFolderProblems(withRule({ sid: "S-1-5-32-545", allow: true, rights: 0x4, inheritOnly: false })), ["S-1-5-32-545 may write in it"], "creating a subfolder");
    assert.deepEqual(privateFolderProblems(withRule({ sid: "S-1-3-0", allow: true, rights: 0x10000000, inheritOnly: true })), ["S-1-3-0 may write what is created in it"]);
    assert.deepEqual(privateFolderProblems({ ...IMAGE_RUN_ACL, owner: SID }), [`it is owned by ${SID}`]);
    assert.match(privateFolderProblems({ ok: false, message: "Get-Acl: access denied" })[0], /could not be read: Get-Acl: access denied/);
    assert.match(privateFolderProblems(withRule({ sid: "S-1-5-32-545", allow: true, rights: "Modify" }))[0], /cannot read/);
    assert.match(privateFolderProblems(null)[0], /could not be read/);
});

test("the private temporary folder is created, checked before anything in it is touched, and emptied without following a link", async () => {
    const home = tempDir("ps-win-ptemp-");
    try {
        const outside = path.join(home, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "kept.txt"), "keep");

        const dir = path.join(home, "run", "ps-temp");
        fs.mkdirSync(path.dirname(dir));
        const checked = [];
        assert.deepEqual(await preparePrivateTemp(dir, { checkAcl: async (folder) => { checked.push(folder); return IMAGE_RUN_ACL; } }), { failed: [] });
        assert.deepEqual(checked, [dir]);
        assert.equal(fs.statSync(dir).isDirectory(), true);

        // What an earlier start left goes; a link goes without its target.
        fs.mkdirSync(path.join(dir, "abc123", "nested"), { recursive: true });
        fs.writeFileSync(path.join(dir, "abc123", "nested", "source.cs"), "x");
        fs.writeFileSync(path.join(dir, "__PSScriptPolicyTest.ps1"), "1");
        fs.symlinkSync(outside, path.join(dir, "link"), "junction");
        assert.deepEqual(await preparePrivateTemp(dir, { checkAcl: async () => IMAGE_RUN_ACL }), { failed: [] });
        assert.deepEqual(fs.readdirSync(dir), []);
        assert.equal(fs.readFileSync(path.join(outside, "kept.txt"), "utf8"), "keep");

        // A list that lets someone else write stops the start, and nothing in the folder is touched.
        fs.writeFileSync(path.join(dir, "planted.dll"), "x");
        const writable = { ...IMAGE_RUN_ACL, rules: [...IMAGE_RUN_ACL.rules, { sid: "S-1-5-32-545", allow: true, rights: 0x1301bf, inheritOnly: false }] };
        await assert.rejects(preparePrivateTemp(dir, { checkAcl: async () => writable }), /SYSTEM and Administrators only, but S-1-5-32-545 may write in it/);
        await assert.rejects(preparePrivateTemp(dir, { checkAcl: async () => { throw new AttacherError(500, "DISK_OPERATION_FAILED", "no answer"); } }), /no answer/);
        assert.deepEqual(fs.readdirSync(dir), ["planted.dll"]);

        // A link or a file in its place is refused before any check.
        const linked = path.join(home, "run", "linked-temp");
        fs.symlinkSync(outside, linked, "junction");
        const file = path.join(home, "run", "file-temp");
        fs.writeFileSync(file, "x");
        for (const target of [linked, file]) {
            await assert.rejects(preparePrivateTemp(target, { checkAcl: async () => assert.fail("not checked") }), /link or a file/);
        }
        assert.equal(fs.readFileSync(path.join(outside, "kept.txt"), "utf8"), "keep");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the disk script reports a folder's owner and rules as SIDs, an inherited write right included", { skip: process.platform !== "win32" && "Windows only" }, async () => {
    const home = tempDir("ps-win-acl-");
    try {
        const script = path.join(home, "disk-ops.ps1");
        fs.writeFileSync(script, DISK_OPS_SCRIPT);
        const privateTemp = path.join(home, "ps-temp");
        fs.mkdirSync(privateTemp);
        const folder = path.join(home, "checked");
        fs.mkdirSync(folder);
        // Users may write only what is created in the folder: a rule its children inherit.
        const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
        const granted = spawnSync(icacls, [folder, "/grant", "*S-1-5-32-545:(OI)(CI)(IO)(M)"], { encoding: "utf8", windowsHide: true });
        assert.equal(granted.status, 0, granted.stdout + granted.stderr);

        const ops = createDiskOps({ scriptPath: script, tempDir: privateTemp });
        const acl = await ops.folderAcl(folder);
        assert.equal(acl.ok, true, JSON.stringify(acl));
        assert.match(acl.owner, /^S-1-\d+(-\d+)+$/);
        for (const rule of acl.rules) {
            assert.match(rule.sid, /^S-1-\d+(-\d+)+$/);
            assert.equal(Number.isInteger(rule.rights), true);
            assert.equal(typeof rule.allow, "boolean");
            assert.equal(typeof rule.inheritOnly, "boolean");
        }
        assert.ok(acl.rules.some((rule) => rule.sid === "S-1-5-32-545" && rule.allow && rule.inheritOnly), JSON.stringify(acl.rules));
        assert.ok(privateFolderProblems(acl).includes("S-1-5-32-545 may write what is created in it"), JSON.stringify(privateFolderProblems(acl)));
        // The attacher's start, with the real check: refused.
        await assert.rejects(preparePrivateTemp(folder, { checkAcl: (dir) => ops.folderAcl(dir) }), /S-1-5-32-545 may write what is created in it/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

const elevated = process.platform === "win32"
    && /\bS-1-16-(12288|16384)\b/.test(spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/groups"], { encoding: "utf8", windowsHide: true }).stdout ?? "");

test("run\\ps-temp under the list the image gives C:\\pilotswarm passes the attacher's check", { skip: !elevated && "needs an elevated shell to give a folder the image's list" }, async () => {
    const home = tempDir("ps-win-runacl-");
    try {
        const script = path.join(home, "disk-ops.ps1");
        fs.writeFileSync(script, DISK_OPS_SCRIPT);
        const opsTemp = path.join(home, "ops-temp");
        fs.mkdirSync(opsTemp);
        const root = path.join(home, "pilotswarm");
        fs.mkdirSync(root);
        // Build-WorkerOsImage.ps1's list for C:\pilotswarm, by SID through .NET: icacls cannot name the worker's
        // account where its service is not installed.
        const setAcl = runDriver(home, "image-acl.ps1", [
            "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
            "$acl.SetAccessRuleProtection($true, $false)",
            `foreach ($grant in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('${SID}', 'ReadAndExecute'))) {`,
            "    $sid = New-Object System.Security.Principal.SecurityIdentifier $grant[0]",
            "    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $grant[1], 'ContainerInherit, ObjectInherit', 'None', 'Allow')))",
            "}",
            `Set-Acl -LiteralPath ${psQuote(root)} -AclObject $acl`,
            "ConvertTo-Json -Compress -InputObject @{ done = $true }",
        ].join("\n"));
        assert.deepEqual(setAcl.json, { done: true }, setAcl.stderr + setAcl.stdout);
        // run\ and run\ps-temp inherit it; the attacher, as LocalSystem, creates folders that SYSTEM or Administrators own.
        const privateTemp = path.join(root, "run", "ps-temp");
        fs.mkdirSync(privateTemp, { recursive: true });
        const owner = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), [privateTemp, "/setowner", "*S-1-5-32-544"], { encoding: "utf8", windowsHide: true });
        assert.equal(owner.status, 0, owner.stdout + owner.stderr);

        const ops = createDiskOps({ scriptPath: script, tempDir: opsTemp });
        assert.deepEqual(await preparePrivateTemp(privateTemp, { checkAcl: (dir) => ops.folderAcl(dir) }), { failed: [] });
        const acl = await ops.folderAcl(privateTemp);
        assert.deepEqual(privateFolderProblems(acl), []);
        assert.ok(acl.rules.some((rule) => rule.sid === SID && rule.allow && (rule.rights & 0x1200a9) === 0x1200a9), "the worker reads it");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the embedded disk script parses in PowerShell 7 and Windows PowerShell", { skip: !pwsh() && "PowerShell 7 is not installed" }, () => {
    const home = tempDir("ps-win-ops-");
    try {
        const script = path.join(home, "disk-ops.ps1");
        fs.writeFileSync(script, DISK_OPS_SCRIPT);
        const command = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$errors); $errors.Count`;
        for (const shell of [pwsh(), process.platform === "win32" ? windowsPowerShell() : null].filter(Boolean)) {
            const parsed = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
            assert.equal(parsed.stdout.trim(), "0", `${shell}: ${parsed.stderr}`);
        }
        assert.equal(DISK_OPS_SCRIPT.includes("`"), false);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the disk script finds the processes that use a folder, sparing the ones it must", { skip: process.platform !== "win32" && "Windows only" }, async (t) => {
    const home = tempDir("ps-win-procs-");
    const busy = path.join(home, "busy folder");
    fs.mkdirSync(busy);
    const privateTemp = path.join(home, "ps-temp");
    fs.mkdirSync(privateTemp);
    const script = path.join(home, "disk-ops.ps1");
    fs.writeFileSync(script, DISK_OPS_SCRIPT);
    const byFolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: busy, stdio: "ignore", windowsHide: true });
    const byName = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join(busy, "named.txt")], { stdio: "ignore", windowsHide: true });
    const spared = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: busy, stdio: "ignore", windowsHide: true });
    t.after(async () => {
        await Promise.all([byFolder, byName, spared].map((child) => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", resolve);
            child.kill();
        })));
        fs.rmSync(home, { recursive: true, force: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // As the attacher runs it: the current folder reader compiles in the private temporary folder.
    const result = await runProcess(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        "-Operation", "ProcessesOn", "-Root", busy, "-WorkerPid", String(spared.pid)], { timeoutMs: 120_000, env: diskOpsEnv(process.env, privateTemp) });
    const answer = lastJsonObject(result.stdout);
    assert.equal(answer?.ok, true, result.stdout + result.stderr);
    assert.equal(answer.note, null, "the current folder reader compiled");
    const found = new Map((answer.processes ?? []).map((entry) => [entry.pid, entry.reason]));
    assert.equal(found.get(byFolder.pid), "current folder");
    assert.equal(found.get(byName.pid), "command line");
    assert.equal(found.has(spared.pid), false);
    assert.equal(found.has(process.pid), false);
    assert.deepEqual(fs.readdirSync(privateTemp), [], "the compiler leaves nothing behind");
});

test("the disk script compiles its C# in the TEMP and TMP the attacher gives it, nowhere else", { skip: process.platform !== "win32" && "Windows only" }, async () => {
    const home = tempDir("ps-win-cstemp-");
    const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
    const closed = path.join(home, "closed-temp");
    fs.mkdirSync(closed);
    try {
        const script = path.join(home, "disk-ops.ps1");
        fs.writeFileSync(script, DISK_OPS_SCRIPT);
        // Nobody may add a file or a folder to this TEMP, so a compile there fails; one anywhere else would succeed.
        const denied = spawnSync(icacls, [closed, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD)"], { encoding: "utf8", windowsHide: true });
        assert.equal(denied.status, 0, denied.stdout + denied.stderr);
        const result = await runProcess(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
            "-Operation", "ProcessesOn", "-Root", home], { timeoutMs: 120_000, env: diskOpsEnv(process.env, closed) });
        const answer = lastJsonObject(result.stdout);
        assert.equal(answer?.ok, true, result.stdout + result.stderr);
        assert.match(String(answer.note), /current folders not read/);
    } finally {
        spawnSync(icacls, [closed, "/remove:d", "*S-1-1-0"], { windowsHide: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ── Zips ────────────────────────────────────────────────────────────────

/** A zip with stored (uncompressed) entries; `localName` makes the local header disagree with the directory. */
function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
        const data = Buffer.from(entry.data ?? "");
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(localName.length, 26);
        locals.push(local, localName, data);
        const mode = entry.symlink ? 0o120777 : entry.name.endsWith("/") ? 0o040755 : 0o100644;
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((mode << 16) | (entry.name.endsWith("/") ? 0x10 : 0)) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + localName.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

/** Extracts a stored zip from buildZip (the attacher checks entries before it calls this). */
async function extractStored(zipFile, dest) {
    const zip = fs.readFileSync(zipFile);
    let offset = 0;
    while (zip.readUInt32LE(offset) === 0x04034b50) {
        const size = zip.readUInt32LE(offset + 18);
        const nameLength = zip.readUInt16LE(offset + 26);
        const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
        const data = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
        const target = path.join(dest, ...name.split("/"));
        if (name.endsWith("/")) fs.mkdirSync(target, { recursive: true });
        else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
        }
        offset += 30 + nameLength + size;
    }
}

test("zip entries come from the central directory and must match their local headers", async () => {
    const home = tempDir("ps-win-zip-");
    try {
        const good = path.join(home, "good.zip");
        fs.writeFileSync(good, buildZip([{ name: "packages/" }, { name: "packages/sdk/a.js", data: "x" }, { name: "@scope/pkg (1)/ü.txt", data: "y" }]));
        assert.deepEqual(await readZipEntries(good), [
            { name: "packages/", directory: true, symlink: false },
            { name: "packages/sdk/a.js", directory: false, symlink: false },
            { name: "@scope/pkg (1)/ü.txt", directory: false, symlink: false },
        ]);
        const confused = path.join(home, "confused.zip");
        fs.writeFileSync(confused, buildZip([{ name: "safe.txt", localName: "../evil.txt", data: "x" }]));
        await assert.rejects(readZipEntries(confused), /differently in its directory/);
        const notZip = path.join(home, "not.zip");
        fs.writeFileSync(notZip, "plain text");
        await assert.rejects(readZipEntries(notZip), /not a zip/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("an archive entry that could leave its folder, or is not a plain file or folder, is refused", () => {
    const entry = (name, extra = {}) => ({ name, directory: name.endsWith("/"), symlink: false, ...extra });
    assert.doesNotThrow(() => checkArchiveEntries([entry("node_modules/"), entry("node_modules/@github/copilot/index.js"), entry("a b/c+d=(e)!.txt")]));
    for (const bad of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "C:/x.txt", "a\\b.txt", "a/./b", "a//b", "file.txt:stream", "con.txt", "dir/NUL", "trailing.", "space /x", "tab\tx"]) {
        assert.throws(() => checkArchiveEntries([entry(bad)]), (error) => error instanceof AttacherError && error.code === "UNSAFE_ARCHIVE", bad);
    }
    assert.throws(() => checkArchiveEntries([entry("link", { symlink: true })]), /is a link/);
    assert.throws(() => checkArchiveEntries([]), /empty/);
});

test("tar.exe zips that the packer makes pass the checks and extract", { skip: process.platform !== "win32" && "Windows only" }, async () => {
    const home = tempDir("ps-win-tar-");
    try {
        const source = path.join(home, "source");
        fs.mkdirSync(path.join(source, "packages", "sdk", "examples"), { recursive: true });
        fs.writeFileSync(path.join(source, "packages", "sdk", "package.json"), '{"type":"module"}');
        fs.writeFileSync(path.join(source, "packages", "sdk", "examples", "worker.js"), "export {};\n");
        fs.mkdirSync(path.join(source, "node_modules", "@scope", "pkg"), { recursive: true });
        fs.writeFileSync(path.join(source, "node_modules", "@scope", "pkg", "ü.js"), "1");
        const zip = path.join(home, "release.zip");
        const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
        const made = spawnSync(tar, ["--options", "hdrcharset=UTF-8", "-a", "-c", "-f", zip, "-C", source, "node_modules", "packages"], { encoding: "utf8", windowsHide: true });
        assert.equal(made.status, 0, made.stderr);
        const entries = await readZipEntries(zip);
        checkArchiveEntries(entries);
        assert.ok(entries.some((e) => e.name === "packages/sdk/examples/worker.js"));
        assert.ok(entries.some((e) => e.name === "node_modules/@scope/pkg/ü.js"));
        const dest = path.join(home, "dest");
        fs.mkdirSync(dest);
        await createZipExtractor()(zip, dest);
        assert.equal(fs.readFileSync(path.join(dest, "packages", "sdk", "examples", "worker.js"), "utf8"), "export {};\n");
        assert.equal(fs.readFileSync(path.join(dest, "node_modules", "@scope", "pkg", "ü.js"), "utf8"), "1");
        assert.deepEqual(await findLinks(dest), []);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("current-release.json is checked strictly", () => {
    const base = { schemaVersion: 1, commitSha: "a".repeat(40), zipSha256: "b".repeat(64) };
    assert.deepEqual(validateReleaseManifest(base), { ...base, modelCatalog: null, headlessInstructions: null, plugins: [] });
    const refused = [
        { ...base, schemaVersion: 2 },
        { ...base, commitSha: "A".repeat(40) },
        { ...base, zipSha256: "b".repeat(63) },
        { ...base, extra: 1 },
        { ...base, modelCatalog: { blob: "../x.json", sha256: "c".repeat(64) } },
        { ...base, modelCatalog: { blob: "current-release.json", sha256: "c".repeat(64) } },
        { ...base, headlessInstructions: { blob: "i.zip", sha256: "nope" } },
        { ...base, plugins: [{ name: "p", blob: "plugins/p.zip", sha256: "c".repeat(64) }, { name: "P", blob: "plugins/q.zip", sha256: "d".repeat(64) }] },
        { ...base, plugins: [{ name: "../p", blob: "plugins/p.zip", sha256: "c".repeat(64) }] },
        { ...base, plugins: [{ name: "p", blob: "plugins/p.zip", sha256: "c".repeat(64), path: "C:\\" }] },
    ];
    for (const manifest of refused) assert.throws(() => validateReleaseManifest(manifest), (error) => error.code === "BAD_RELEASE_MANIFEST", JSON.stringify(manifest));
});

// ── /sync-release ───────────────────────────────────────────────────────

const COMMIT_A = "1".repeat(40);
const COMMIT_B = "2".repeat(40);
const COMMIT_C = "3".repeat(40);

/** A release container in memory, read through the attacher's real blob client (hashing and limits included). */
function releaseContainer() {
    const blobs = new Map();
    const reads = [];
    const get = async (url, { headers }) => {
        assert.equal(headers.authorization, "Bearer storage-token");
        assert.equal(headers["x-ms-version"], "2021-08-06");
        const name = decodeURIComponent(new URL(url).pathname.replace(/^\/win-worker-releases\//, ""));
        reads.push(name);
        const body = blobs.get(name);
        const stream = Readable.from(body ? [body] : []);
        stream.statusCode = body ? 200 : 404;
        return stream;
    };
    function publish(commitSha, { files = { "packages/sdk/examples/worker.js": `// ${commitSha}\n` }, plugin = "plugin v1", instructions = "be brief", catalog = '{"defaultModel":"m"}', zipSha256 } = {}) {
        const zip = buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
        blobs.set(`worker-release-${commitSha}.zip`, zip);
        const pluginZip = buildZip([{ name: "plugin.json", data: plugin }]);
        const instructionsZip = buildZip([{ name: "headless.md", data: instructions }]);
        blobs.set(`plugins/example-${sha256(pluginZip).slice(0, 12)}.zip`, pluginZip);
        blobs.set(`headless-instructions-${sha256(instructionsZip).slice(0, 12)}.zip`, instructionsZip);
        blobs.set(`model-catalog-${sha256(catalog).slice(0, 12)}.json`, Buffer.from(catalog));
        const manifest = {
            schemaVersion: 1,
            commitSha,
            zipSha256: zipSha256 ?? sha256(zip),
            modelCatalog: { blob: `model-catalog-${sha256(catalog).slice(0, 12)}.json`, sha256: sha256(catalog) },
            headlessInstructions: { blob: `headless-instructions-${sha256(instructionsZip).slice(0, 12)}.zip`, sha256: sha256(instructionsZip) },
            plugins: [{ name: "example", blob: `plugins/example-${sha256(pluginZip).slice(0, 12)}.zip`, sha256: sha256(pluginZip) }],
        };
        blobs.set("current-release.json", Buffer.from(JSON.stringify(manifest)));
        return manifest;
    }
    return { blobs, reads, get, publish };
}

function syncHarness(t, { extract = extractStored, controllerCaCert = CA_PEM } = {}) {
    const root = tempDir("ps-win-sync-");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const container = releaseContainer();
    const instance = { pid: 100, started: "2026-01-01T00:00:00.0000000Z" };
    const settings = { caFile: path.join(root, "disk-controller-ca.crt"), catalogFile: path.join(root, "model_providers.json"), container: "win-worker-releases" };
    const userDataState = { controllerCaCert };
    const sync = createReleaseSync({
        root,
        settings,
        getUserData: async () => ({ accountUrl: "https://example.blob.core.windows.net/", clientId: CLIENT_ID, controllerCaCert: userDataState.controllerCaCert }),
        createBlob: (data) => createBlobClient({ accountUrl: data.accountUrl, container: settings.container, getToken: async () => "storage-token", get: container.get, wait: async () => {} }),
        extract,
        getWorkerInstance: async () => ({ ...instance }),
    });
    const release = (manifest) => path.join(root, "releases", releaseFolderName(manifest));
    return { root, container, instance, settings, sync, release, userData: userDataState };
}

const artifactReads = (reads) => reads.filter((name) => name !== "current-release.json");

test("a first sync installs the release, the plugin, the instructions, the catalog and the CA", async (t) => {
    const h = syncHarness(t);
    const manifest = h.container.publish(COMMIT_A);
    assert.deepEqual(await h.sync.sync(), { ok: true, changed: true, commitSha: COMMIT_A, release: releaseFolderName(manifest) });
    assert.equal(fs.realpathSync(path.join(h.root, "current")), fs.realpathSync(h.release(manifest)));
    assert.equal(fs.readFileSync(path.join(h.root, "current", "packages", "sdk", "examples", "worker.js"), "utf8"), `// ${COMMIT_A}\n`);
    assert.equal(fs.readFileSync(path.join(h.root, "plugins", "example", "plugin.json"), "utf8"), "plugin v1");
    assert.equal(fs.readFileSync(path.join(h.root, "headless-instructions", "headless.md"), "utf8"), "be brief");
    assert.equal(fs.readFileSync(h.settings.catalogFile, "utf8"), '{"defaultModel":"m"}');
    assert.equal(fs.readFileSync(h.settings.caFile, "utf8"), CA_PEM);
    assert.equal(fs.readdirSync(path.join(h.root, "releases")).filter((name) => name.startsWith(".staging")).length, 0);
    assert.equal(artifactReads(h.container.reads).length, 4);
});

test("the CA file that NODE_EXTRA_CA_CERTS names holds the whole bundle of userData, and follows a new one", async (t) => {
    const two = `${CA_PEM}${CA2_PEM}`;
    const h = syncHarness(t, { controllerCaCert: two });
    h.container.publish(COMMIT_A);
    await h.sync.sync();
    assert.equal(fs.readFileSync(h.settings.caFile, "utf8"), two);
    h.userData.controllerCaCert = CA2_PEM;
    h.instance.pid = 200;
    await h.sync.sync();
    assert.equal(fs.readFileSync(h.settings.caFile, "utf8"), CA2_PEM);
});

test("when the named release is in place, a sync downloads nothing", async (t) => {
    const h = syncHarness(t);
    h.container.publish(COMMIT_A);
    await h.sync.sync();
    h.container.reads.length = 0;
    h.instance.pid = 200;
    assert.equal((await h.sync.sync()).changed, false);
    assert.equal((await h.sync.sync()).changed, false);
    assert.deepEqual(h.container.reads, ["current-release.json", "current-release.json"], "only the manifest is read");
});

test("an artifact whose hash does not match is refused, and nothing changes", async (t) => {
    const h = syncHarness(t);
    const first = h.container.publish(COMMIT_A);
    await h.sync.sync();
    h.instance.pid = 300;
    h.container.publish(COMMIT_B, { zipSha256: "f".repeat(64) });
    await assert.rejects(h.sync.sync(), (error) => error instanceof AttacherError && error.code === "HASH_MISMATCH" && !error.retryable && error.status === 502);
    assert.equal(fs.realpathSync(path.join(h.root, "current")), fs.realpathSync(h.release(first)));
    assert.deepEqual(fs.readdirSync(path.join(h.root, "releases")).sort(), [releaseFolderName(first), `${releaseFolderName(first)}.complete.json`].sort());

    h.container.publish(COMMIT_B, { plugin: "plugin v2" });
    const plugin = [...h.container.blobs.keys()].find((name) => name.startsWith("plugins/") && h.container.blobs.get(name).includes("plugin v2"));
    h.container.blobs.set(plugin, Buffer.from("tampered"));
    await assert.rejects(h.sync.sync(), (error) => error.code === "HASH_MISMATCH");
    assert.equal(fs.realpathSync(path.join(h.root, "current")), fs.realpathSync(h.release(first)));
    assert.equal(fs.readFileSync(path.join(h.root, "plugins", "example", "plugin.json"), "utf8"), "plugin v1");
});

test("the release a running worker uses is never changed; the next start of the service gets the new one", async (t) => {
    const h = syncHarness(t);
    const first = h.container.publish(COMMIT_A);
    await h.sync.sync();
    const worker = path.join(h.release(first), "packages", "sdk", "examples", "worker.js");

    const second = h.container.publish(COMMIT_B, { plugin: "plugin v2" });
    h.container.reads.length = 0;
    await assert.rejects(h.sync.sync(), (error) => error.code === "WORKER_RUNNING" && error.status === 409);
    assert.deepEqual(artifactReads(h.container.reads), [], "nothing is downloaded for a running worker");
    assert.equal(fs.readFileSync(path.join(h.root, "plugins", "example", "plugin.json"), "utf8"), "plugin v1");

    h.instance.pid = 101;
    assert.equal((await h.sync.sync()).changed, true);
    assert.equal(fs.realpathSync(path.join(h.root, "current")), fs.realpathSync(h.release(second)));
    assert.equal(fs.readFileSync(worker, "utf8"), `// ${COMMIT_A}\n`, "the previous release stays, unchanged");
    assert.equal(fs.readFileSync(path.join(h.root, "plugins", "example", "plugin.json"), "utf8"), "plugin v2");

    h.instance.pid = 102;
    const third = h.container.publish(COMMIT_C);
    await h.sync.sync();
    await h.sync.cleanedUp();
    assert.equal(fs.existsSync(h.release(first)), false, "releases older than the previous one are removed");
    assert.equal(fs.existsSync(h.release(second)), true);
    assert.equal(fs.realpathSync(path.join(h.root, "current")), fs.realpathSync(h.release(third)));
});

test("an archive that would escape its folder, or that creates a link, is refused", async (t) => {
    const h = syncHarness(t);
    h.container.publish(COMMIT_A, { files: { "../escaped.txt": "x" } });
    await assert.rejects(h.sync.sync(), (error) => error.code === "UNSAFE_ARCHIVE");
    assert.equal(fs.existsSync(path.join(h.root, "escaped.txt")), false);
    assert.equal(fs.existsSync(path.join(h.root, "current")), false);

    const linking = syncHarness(t, {
        extract: async (zipFile, dest) => {
            await extractStored(zipFile, dest);
            const target = path.join(path.dirname(path.dirname(zipFile)), "..", "link-target");
            fs.mkdirSync(target, { recursive: true });
            fs.symlinkSync(target, path.join(dest, "planted"), "junction");
        },
    });
    linking.container.publish(COMMIT_A);
    await assert.rejects(linking.sync.sync(), (error) => error.code === "UNSAFE_ARCHIVE" && /created links/.test(error.message));
    assert.equal(fs.existsSync(path.join(linking.root, "current")), false);
});
