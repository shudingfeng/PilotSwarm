/**
 * A worker with a personal credential resolver
 * (`worker.setPersonalCredentialResolver`) holds people's GitHub tokens,
 * whatever PILOTSWARM_PERSONAL_SECRETS says. So, in database mode too, it
 * starts only when the Copilot CLI program passes the checks that external
 * mode makes, and it redacts GitHub tokens from what it persists and logs.
 * A resolver set before start() is checked there, one set once start() was
 * called when it is set. Without a resolver nothing changes.
 *
 * The program and its unpacked copy are built in a temporary folder, as in
 * cli-program-guard.test.mjs. A copy the worker can neither write nor make
 * writable needs another owner on Linux and macOS, so the case that passes
 * the check runs on Windows only; the redaction itself runs everywhere.
 *
 * Run: node --test test/unit/personal-credential-resolver-guard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PilotSwarmWorker } from "../../dist/worker.js";
import { pinnedCopilotCliVersion } from "../../dist/cli-program-guard.js";
import { redactSecrets, secretRedactionEnabled } from "../../dist/secret-redaction.js";

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM = `${process.platform}-${process.arch}`;
const CLASSIC = `ghp_${"x".repeat(36)}`;
const RESOLVER_SUBJECT = /A personal credential resolver \(worker\.setPersonalCredentialResolver\)/;
const SETTINGS = [
    "PILOTSWARM_PERSONAL_SECRETS", "PILOTSWARM_REDACT_SECRET_PREFIXES", "PILOTSWARM_CLI_SECRET_ENV_VARS",
    "PILOTSWARM_SCRUB_CLI_ENV", "PILOTSWARM_CLI_DISABLE_HOOKS", "COPILOT_CLI_PATH", "COPILOT_PKG_CACHE_HOME", "COPILOT_CLI_DIST_DIR",
];

/** Clears the settings that matter here, then applies `settings`; restores them after the test. */
function withSettings(t, settings = {}) {
    const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
    for (const name of SETTINGS) delete process.env[name];
    Object.assign(process.env, settings);
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

/** A Copilot CLI program of the pinned version and its complete unpacked copy, in a temporary folder. */
function programFixture(t) {
    const root = mkdtempSync(join(tmpdir(), "ps-resolver-guard-"));
    const home = join(root, "copilot-pkg");
    t.after(() => {
        if (process.platform === "win32") {
            try {
                execFileSync("icacls", [home, "/remove:d", process.env.USERNAME, "/T", "/Q"], { stdio: "ignore" });
            } catch {
                // Nothing was denied.
            }
        }
        rmSync(root, { recursive: true, force: true });
    });
    const programDir = join(root, "node_modules", "@github", `copilot-${PLATFORM}`);
    mkdirSync(programDir, { recursive: true });
    const program = join(programDir, process.platform === "win32" ? "copilot.exe" : "copilot");
    writeFileSync(program, "");
    writeFileSync(join(programDir, "package.json"), JSON.stringify({ name: `@github/copilot-${PLATFORM}`, version: pinnedCopilotCliVersion() }));
    const copy = join(home, "pkg", PLATFORM, pinnedCopilotCliVersion());
    for (const file of [".extraction-complete", "index.js", "app.js", join("prebuilds", PLATFORM, "runtime.node")]) {
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        writeFileSync(join(copy, file), "");
    }
    const settings = { PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN", COPILOT_CLI_PATH: program, COPILOT_PKG_CACHE_HOME: home };
    return { root, home, settings };
}

const worker = (root) => new PilotSwarmWorker({ sessionStateDir: join(root, "sessions"), disableManagementAgents: true });
const resolver = async () => ({ status: "ok", token: "made-up" });

test("without a resolver a worker starts as before and redacts no GitHub token; removing one changes nothing", (t) => {
    withSettings(t);
    const root = mkdtempSync(join(tmpdir(), "ps-resolver-guard-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const plain = worker(root);
    plain.setPersonalCredentialResolver(null);
    assert.equal(plain.sessionManager.getPersonalCredentialResolver(), null);
    assert.equal(secretRedactionEnabled(), false);
    assert.equal(redactSecrets(`token ${CLASSIC}`), `token ${CLASSIC}`);
});

test("in database mode a worker with a resolver refuses to start unless the Copilot CLI program passes external mode's checks", async (t) => {
    withSettings(t);
    const { root, settings } = programFixture(t);
    const plain = worker(root);
    plain.setPersonalCredentialResolver(resolver);
    const refusal = new RegExp(`${RESOLVER_SUBJECT.source} needs PILOTSWARM_CLI_SECRET_ENV_VARS to name COPILOT_SDK_AUTH_TOKEN`);
    await assert.rejects(plain.start(), refusal);
    assert.equal(plain.isStarted, false);
    assert.equal(redactSecrets(CLASSIC), CLASSIC, "nor was redaction turned on");
    assert.throws(() => plain.setPersonalCredentialResolver(resolver), refusal, "once start() was called, a resolver is checked when it is set");

    Object.assign(process.env, settings);
    const writable = worker(root);
    writable.setPersonalCredentialResolver(resolver);
    await assert.rejects(writable.start(),
        new RegExp(`${RESOLVER_SUBJECT.source}: this worker can change the Copilot CLI program's copy in COPILOT_PKG_CACHE_HOME`));
    assert.equal(writable.isStarted, false);
});

/** Run `body` in a fresh Node process with the redaction module, and the worker when asked, imported; returns its output. */
function inChild(body, { env = {}, withWorker = false } = {}) {
    const dist = (name) => JSON.stringify(pathToFileURL(join(SDK_DIR, "dist", name)).href);
    const script = [
        ...(withWorker ? [`const { PilotSwarmWorker } = await import(${dist("worker.js")});`] : []),
        `const { redactGitHubTokens, redactSecrets, redactSecretsIn, installLogRedaction } = await import(${dist("secret-redaction.js")});`,
        body,
    ].join("\n");
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SETTINGS.includes(name)));
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: SDK_DIR, encoding: "utf8", env: { ...clean, ...env } });
}

test("once a process turns GitHub token redaction on, it redacts them in database mode, from text and logs", () => {
    const run = inChild([
        `console.log("before ${CLASSIC}", redactSecrets("${CLASSIC}"));`,
        "redactGitHubTokens();",
        "if (!installLogRedaction()) throw new Error(\"log redaction did not install\");",
        `console.log("after ${CLASSIC}");`,
        `console.error(JSON.stringify(redactSecretsIn({ said: "${CLASSIC}" })));`,
    ].join("\n"));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), [`before ${CLASSIC} ${CLASSIC}`, "after ghp_[REDACTED]"]);
    assert.equal(run.stderr.trim(), JSON.stringify({ said: "ghp_[REDACTED]" }));
});

test("in database mode a worker passes the check with a protected copy, takes the resolver, and then redacts GitHub tokens", (t) => {
    if (process.platform !== "win32") {
        t.skip("only another account can own a copy this account cannot make writable");
        return;
    }
    const { root, home, settings } = programFixture(t);
    // Inherited by everything below: no file may be added, written or have its attributes changed.
    execFileSync("icacls", [home, "/deny", `${process.env.USERNAME}:(OI)(CI)(WD,AD,WA)`, "/Q"], { stdio: "ignore" });
    const run = inChild([
        `const worker = new PilotSwarmWorker({ sessionStateDir: ${JSON.stringify(join(root, "sessions"))}, disableManagementAgents: true });`,
        // As once start() was called, so the resolver is checked when it is set, without a database.
        "worker._startCalled = true;",
        `console.log("before ${CLASSIC}");`,
        "worker.setPersonalCredentialResolver(async () => ({ status: \"ok\", token: \"made-up\" }));",
        `console.log("after ${CLASSIC}");`,
        `console.log(JSON.stringify({ taken: worker.sessionManager.getPersonalCredentialResolver() !== null, text: redactSecrets("${CLASSIC}") }));`,
    ].join("\n"), { env: settings, withWorker: true });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines.slice(-3, -1), [`before ${CLASSIC}`, "after ghp_[REDACTED]"]);
    assert.deepEqual(JSON.parse(lines.at(-1)), { taken: true, text: "ghp_[REDACTED]" });
});
