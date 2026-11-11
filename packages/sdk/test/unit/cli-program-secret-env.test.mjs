/**
 * PILOTSWARM_CLI_SECRET_ENV_VARS: every CLI starts as the Copilot CLI program
 * with --secret-env-vars, the caller's environment moves to the connection,
 * and sessions get none of the program's bundled skills. Unset, the SDK's
 * bundled runtime starts as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    cliSecretEnvVars, copilotCliProgramPath, createCopilotClient, withCliProgramSessionOptions,
} from "../../dist/copilot-client.js";
import { PilotSwarmWorker } from "../../dist/index.js";

const CALLER_ENV = { PATH: "/usr/bin", HOME: "/home/w", COPILOT_HOME: "/state", PS_EXTRA: "kept" };

function withSettings(t, settings) {
    const saved = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(settings)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

test("unset, the bundled runtime starts as before and sessions keep their options", (t) => {
    withSettings(t, { PILOTSWARM_CLI_SECRET_ENV_VARS: undefined, PILOTSWARM_SCRUB_CLI_ENV: undefined });
    assert.equal(cliSecretEnvVars(), undefined);
    assert.equal(cliSecretEnvVars({ PILOTSWARM_CLI_SECRET_ENV_VARS: " , " }), undefined);
    const client = createCopilotClient({ env: CALLER_ENV });
    assert.equal(client.resolvedCliPath, undefined, "the SDK resolves its bundled runtime at start");
    assert.deepEqual(client.connectionExtraArgs, []);
    assert.equal(client.resolvedEnv, CALLER_ENV);
    const config = { model: "m" };
    assert.equal(withCliProgramSessionOptions(config), config);
});

test("names are environment variable names, without repeats", () => {
    assert.deepEqual(cliSecretEnvVars({ PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN, MY_KEY,COPILOT_SDK_AUTH_TOKEN" }),
        ["COPILOT_SDK_AUTH_TOKEN", "MY_KEY"]);
    for (const bad of ["A B", "1X", "X;Y", "X*", "X=1"]) {
        assert.throws(() => cliSecretEnvVars({ PILOTSWARM_CLI_SECRET_ENV_VARS: bad }), /PILOTSWARM_CLI_SECRET_ENV_VARS/, bad);
    }
});

test("set, every CLI starts as the program with --secret-env-vars, and the environment rides on the connection", (t) => {
    withSettings(t, { PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN,PS_EXTRA", PILOTSWARM_SCRUB_CLI_ENV: undefined });
    const program = copilotCliProgramPath();
    assert.match(program.replace(/\\/g, "/"), /@github\/copilot-[a-z0-9]+-[a-z0-9]+\/copilot(\.exe)?$/);
    const client = createCopilotClient({ gitHubToken: "made-up-sdk-token", env: CALLER_ENV });
    assert.equal(client.resolvedCliPath, program);
    assert.deepEqual(client.connectionExtraArgs, ["--secret-env-vars=COPILOT_SDK_AUTH_TOKEN,PS_EXTRA"]);
    assert.deepEqual(client.resolvedEnv, CALLER_ENV, "the caller's environment, moved to the connection");
    assert.equal(client.buildRuntimeEnv().COPILOT_SDK_AUTH_TOKEN, "made-up-sdk-token", "the SDK still hands the CLI its token");
    assert.deepEqual(withCliProgramSessionOptions({ model: "m" }), { model: "m", includedBuiltinSkills: [] });

    const pinned = createCopilotClient({ env: { ...CALLER_ENV, COPILOT_CLI_PATH: "/opt/copilot/copilot" } });
    assert.equal(pinned.resolvedCliPath, "/opt/copilot/copilot", "COPILOT_CLI_PATH still names the program");
});

test("the started program's command line has --secret-env-vars and the SDK's --no-auto-update", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ps-cli-argv-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // Stands in for the program: records its arguments and exits.
    const program = join(dir, "copilot.js");
    writeFileSync(program, 'require("node:fs").writeFileSync(require("node:path").join(__dirname, "argv.json"), JSON.stringify(process.argv.slice(2)));\n');
    withSettings(t, { PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN", PILOTSWARM_SCRUB_CLI_ENV: undefined });
    const client = createCopilotClient({ gitHubToken: "made-up-sdk-token", env: { ...CALLER_ENV, PATH: process.env.PATH, COPILOT_CLI_PATH: program } });
    t.after(() => client.forceStop().catch(() => {}));
    // It is not a CLI, so start fails once it exits; only its arguments matter.
    client.start().catch(() => {});
    const argvFile = join(dir, "argv.json");
    for (const deadline = Date.now() + 15_000; !existsSync(argvFile) && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal(argv[0], "--secret-env-vars=COPILOT_SDK_AUTH_TOKEN", argv.join(" "));
    assert.ok(argv.includes("--no-auto-update"), argv.join(" "));
    assert.ok(argv.includes("--headless"), argv.join(" "));
});

test("with a scrubbed environment, the connection carries only the scrubbed names", (t) => {
    withSettings(t, { PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN", PILOTSWARM_SCRUB_CLI_ENV: "1", PILOTSWARM_CLI_ENV_ALLOWLIST: undefined });
    const client = createCopilotClient({ env: { ...CALLER_ENV, DATABASE_URL: "postgresql://made-up" } });
    assert.equal(client.resolvedEnv.DATABASE_URL, undefined);
    assert.equal(client.resolvedEnv.COPILOT_HOME, "/state");
});

test("a worker refuses to start with a bad name", (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-secret-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    withSettings(t, { PILOTSWARM_CLI_SECRET_ENV_VARS: "NOT A NAME" });
    assert.throws(
        () => new PilotSwarmWorker({ sessionStateDir: join(root, "sessions"), disableManagementAgents: true }),
        /PILOTSWARM_CLI_SECRET_ENV_VARS/,
    );
});

test("the installed CLI program is the version the SDK pins", async () => {
    const require = createRequire(import.meta.url);
    const launcher = JSON.parse(readFileSync(require.resolve("@github/copilot/package.json"), "utf8"));
    const sdkEntry = fileURLToPath(import.meta.resolve("@github/copilot-sdk"));
    const { COPILOT_CLI_VERSION } = await import(pathToFileURL(join(dirname(sdkEntry), "cliVersion.js")).href);
    const program = JSON.parse(readFileSync(join(dirname(copilotCliProgramPath()), "package.json"), "utf8"));
    assert.equal(launcher.version, COPILOT_CLI_VERSION, "@github/copilot matches the SDK's pinned CLI");
    assert.equal(program.version, COPILOT_CLI_VERSION, "and so does its platform program");
});
