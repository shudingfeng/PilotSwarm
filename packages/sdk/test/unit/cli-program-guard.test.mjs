/**
 * With PILOTSWARM_PERSONAL_SECRETS=external a worker refuses to start unless
 * every CLI is the Copilot CLI program that keeps the token from agents'
 * shells (PILOTSWARM_CLI_SECRET_ENV_VARS names COPILOT_SDK_AUTH_TOKEN), the
 * program is the version the Copilot SDK pins and runs its own code (no
 * COPILOT_CLI_DIST_DIR), and COPILOT_PKG_CACHE_HOME holds that version's
 * complete unpacked copy, which the worker can neither write nor make
 * writable.
 *
 * The program and its copy are built in a temporary folder, and the real
 * checks run against it. Write access is taken away with icacls on Windows
 * and chmod elsewhere. On Linux and macOS the account that owns a folder can
 * always give itself write access back, so a copy that passes needs another
 * owner, and that case runs on Windows only.
 *
 * Run: node --test test/unit/cli-program-guard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertCliProgramForExternalSecrets, pinnedCopilotCliVersion, writableProblem } from "../../dist/cli-program-guard.js";
import { PilotSwarmWorker } from "../../dist/index.js";

const PLATFORM = `${process.platform}-${process.arch}`;
const PINNED = pinnedCopilotCliVersion();
const LOADER_FILES = [".extraction-complete", "index.js", "app.js", join("prebuilds", PLATFORM, "runtime.node")];
const NOT_WRITABLE = () => null;

/** A Copilot CLI program of `version`, and an unpacked copy of `copyVersion` in a package cache. */
function fixture(t, { version = PINNED, copyVersion = PINNED, omit = null } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-guard-"));
    t.after(() => {
        makeWritable(root);
        rmSync(root, { recursive: true, force: true });
    });
    const programDir = join(root, "node_modules", "@github", `copilot-${PLATFORM}`);
    mkdirSync(programDir, { recursive: true });
    const program = join(programDir, process.platform === "win32" ? "copilot.exe" : "copilot");
    writeFileSync(program, "");
    writeFileSync(join(programDir, "package.json"), JSON.stringify({ name: `@github/copilot-${PLATFORM}`, version }));
    const home = join(root, "copilot-pkg");
    const copy = join(home, "pkg", PLATFORM, copyVersion);
    for (const file of LOADER_FILES) {
        if (file === omit) continue;
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        writeFileSync(join(copy, file), "");
    }
    mkdirSync(join(copy, "sdk"), { recursive: true });
    writeFileSync(join(copy, "sdk", "index.js"), "");
    const settings = {
        PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN",
        COPILOT_CLI_PATH: program,
        COPILOT_PKG_CACHE_HOME: home,
    };
    return { root, program, home, copy, settings };
}

/**
 * Take write access to `dir` and everything in it away from this account.
 * With `permissions`, also the right to change their permissions, which only
 * Windows can take from the owner.
 */
function makeReadOnly(dir, { permissions = false } = {}) {
    try {
        if (process.platform === "win32") {
            // Inherited by everything below: no file may be added or written,
            // and with WA no attribute, such as read-only, may be changed.
            const rights = permissions ? "(WD,AD,WA)" : "(WD,AD)";
            execFileSync("icacls", [dir, "/deny", `${process.env.USERNAME}:(OI)(CI)${rights}`, "/Q"], { stdio: "ignore" });
            return true;
        }
        if (permissions || process.getuid?.() === 0) return false;
        const walk = (target) => {
            for (const entry of readdirSync(target, { withFileTypes: true })) {
                const child = join(target, entry.name);
                if (entry.isDirectory()) walk(child);
                else chmodSync(child, 0o444);
            }
            chmodSync(target, 0o555);
        };
        walk(dir);
        return true;
    } catch {
        return false;
    }
}

function makeWritable(dir) {
    try {
        if (process.platform === "win32") {
            execFileSync("icacls", [dir, "/remove:d", process.env.USERNAME, "/T", "/Q"], { stdio: "ignore" });
            return;
        }
        const walk = (target) => {
            chmodSync(target, 0o755);
            for (const entry of readdirSync(target, { withFileTypes: true })) {
                const child = join(target, entry.name);
                if (entry.isDirectory()) walk(child);
                else chmodSync(child, 0o644);
            }
        };
        walk(dir);
    } catch {
        // Nothing was made read-only.
    }
}

const refused = (settings, pattern, options = { writableProblem: NOT_WRITABLE }) =>
    assert.throws(() => assertCliProgramForExternalSecrets(settings, options), pattern);

test("the pinned version is the one the Copilot SDK declares", async () => {
    const sdkEntry = fileURLToPath(import.meta.resolve("@github/copilot-sdk"));
    const { COPILOT_CLI_VERSION } = await import(pathToFileURL(join(dirname(sdkEntry), "cliVersion.js")).href);
    assert.equal(PINNED, COPILOT_CLI_VERSION);
});

test("it refuses unless PILOTSWARM_CLI_SECRET_ENV_VARS names COPILOT_SDK_AUTH_TOKEN", (t) => {
    const { settings } = fixture(t);
    for (const value of [undefined, "", "OTHER_SECRET"]) {
        refused({ ...settings, PILOTSWARM_CLI_SECRET_ENV_VARS: value }, /needs PILOTSWARM_CLI_SECRET_ENV_VARS to name COPILOT_SDK_AUTH_TOKEN/);
    }
    assert.doesNotThrow(() => assertCliProgramForExternalSecrets(
        { ...settings, PILOTSWARM_CLI_SECRET_ENV_VARS: "OTHER_SECRET,COPILOT_SDK_AUTH_TOKEN" }, { writableProblem: NOT_WRITABLE }));
});

test("it refuses a missing program, one of another version, and one it cannot identify", (t) => {
    const { settings, root } = fixture(t);
    refused({ ...settings, COPILOT_CLI_PATH: join(root, "no-such-copilot") }, /needs the Copilot CLI program, and there is none at/);

    const older = fixture(t, { version: "0.0.1" });
    refused(older.settings, new RegExp(`is version 0\\.0\\.1, and the Copilot SDK pins ${PINNED.replaceAll(".", "\\.")}`));

    const bare = join(root, "copilot-elsewhere");
    writeFileSync(bare, "");
    refused({ ...settings, COPILOT_CLI_PATH: bare }, /cannot tell which Copilot CLI program/);
});

test("it refuses when the CLI would get COPILOT_CLI_DIST_DIR, which makes the program run another folder's code", (t) => {
    const { settings, root } = fixture(t);
    const elsewhere = { ...settings, COPILOT_CLI_DIST_DIR: root };
    refused(elsewhere, /COPILOT_CLI_DIST_DIR would make the Copilot CLI program run the code in/);
    refused({ ...elsewhere, PILOTSWARM_SCRUB_CLI_ENV: "1", PILOTSWARM_CLI_ENV_ALLOWLIST: "COPILOT_*" }, /COPILOT_CLI_DIST_DIR would make/);
    assert.doesNotThrow(() => assertCliProgramForExternalSecrets({ ...elsewhere, PILOTSWARM_SCRUB_CLI_ENV: "1" }, { writableProblem: NOT_WRITABLE }));
    assert.doesNotThrow(() => assertCliProgramForExternalSecrets({ ...settings, COPILOT_CLI_DIST_DIR: "" }, { writableProblem: NOT_WRITABLE }));
});

test("it refuses without COPILOT_PKG_CACHE_HOME, with a relative one, and with an incomplete copy", (t) => {
    const { settings } = fixture(t);
    refused({ ...settings, COPILOT_PKG_CACHE_HOME: undefined }, /needs COPILOT_PKG_CACHE_HOME/);
    refused({ ...settings, COPILOT_PKG_CACHE_HOME: "copilot-pkg" }, /must be an absolute path/);
    for (const omit of LOADER_FILES) {
        const incomplete = fixture(t, { omit });
        refused(incomplete.settings, new RegExp(`no complete copy of Copilot CLI .*${omit.replaceAll("\\", "\\\\").replaceAll(".", "\\.")} is missing`));
    }
    const otherVersion = fixture(t, { copyVersion: "0.0.1" });
    refused(otherVersion.settings, /no complete copy/);
});

test("it refuses a copy the worker can write, by actually writing a probe file, and leaves none behind", (t) => {
    const { settings, home, copy } = fixture(t);
    refused(settings, /this worker can change the Copilot CLI program's copy in COPILOT_PKG_CACHE_HOME: .* can be written/, {});
    assert.deepEqual(readdirSync(home).filter((name) => name.includes("probe")), []);
    assert.deepEqual(readdirSync(copy).filter((name) => name.includes("probe")), []);
});

test("it refuses a writable file inside a copy whose folders the worker cannot write", (t) => {
    const { settings, copy } = fixture(t);
    const foldersProtected = (target, kind) => (kind === "directory" ? null : writableProblem(target, kind));
    refused(settings, /\.extraction-complete can be written|index\.js can be written|app\.js can be written|runtime\.node can be written/,
        { writableProblem: foldersProtected });
    assert.equal(statSync(join(copy, "index.js")).size, 0, "the check writes nothing into the file");
});

test("it refuses a copy the worker cannot write but can make writable", (t) => {
    const { settings, home, copy } = fixture(t);
    if (!makeReadOnly(home)) {
        t.skip("this account cannot take its own write access away");
        return;
    }
    const app = join(copy, "app.js");
    const before = statSync(app).mode;
    assert.match(writableProblem(home, "directory"), /the permissions of .* can be changed/);
    assert.match(writableProblem(app, "file"), /the permissions of .*app\.js can be changed/);
    refused(settings, /this worker can change the Copilot CLI program's copy in COPILOT_PKG_CACHE_HOME: the permissions of .* can be changed/, {});
    assert.equal(statSync(app).mode, before, "the check changes no permission");
});

test("it refuses a link inside the copy", (t) => {
    const { settings, root, copy } = fixture(t);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(copy, "sdk", "linked"), "junction");
    refused(settings, /linked is a link or other special file/);
});

test("a complete copy of the pinned version that the worker can neither write nor make writable passes", (t) => {
    const { settings, home } = fixture(t);
    assert.doesNotThrow(() => assertCliProgramForExternalSecrets(settings, { writableProblem: NOT_WRITABLE }));
    if (!makeReadOnly(home, { permissions: true })) {
        t.skip("only another account can own a copy this account cannot make writable");
        return;
    }
    assert.equal(writableProblem(home, "directory"), null);
    assert.doesNotThrow(() => assertCliProgramForExternalSecrets(settings));
});

test("a worker in external mode refuses to start unless the guard passes; without the setting it starts as before", (t) => {
    const { root, settings } = fixture(t);
    const saved = Object.fromEntries(["PILOTSWARM_PERSONAL_SECRETS", ...Object.keys(settings)].map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    const start = () => new PilotSwarmWorker({ sessionStateDir: join(root, "sessions"), disableManagementAgents: true });

    for (const name of Object.keys(saved)) delete process.env[name];
    assert.doesNotThrow(start);

    process.env.PILOTSWARM_PERSONAL_SECRETS = "external";
    assert.throws(start, /PILOTSWARM_PERSONAL_SECRETS=external needs PILOTSWARM_CLI_SECRET_ENV_VARS/);
    Object.assign(process.env, settings);
    assert.throws(start, /can change the Copilot CLI program's copy/);
});
