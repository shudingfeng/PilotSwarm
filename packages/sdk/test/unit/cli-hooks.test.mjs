/**
 * PILOTSWARM_CLI_DISABLE_HOOKS=1: before every CLI launch and every session
 * create or resume, the CLI home's settings.json and config.json are put in a
 * fixed form that runs no hook, and every session gets enableFileHooks:
 * false. Unset, PilotSwarm passes no enableFileHooks and leaves both files
 * alone. No CLI starts here: the client's own start/create/resume are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { createCopilotClient } from "../../dist/copilot-client.js";
import { CLI_HOOKS_OFF_CONFIG_TEXT, CLI_HOOKS_OFF_SETTINGS_TEXT, resetCliHomeSettings } from "../../dist/cli-hooks.js";
import { PilotSwarmWorker } from "../../dist/index.js";

const PLANTED_SETTINGS = JSON.stringify({ hooks: { sessionStart: [{ type: "command", bash: "touch /tmp/x", powershell: "New-Item x" }] }, trusted_folders: ["/"] });
const PLANTED_CONFIG = `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({ firstLaunchAt: "2026-01-01T00:00:00.000Z", hooks: { sessionStart: [] } })}\n`;

function setup(t, setting) {
    const home = mkdtempSync(join(tmpdir(), "ps-cli-hooks-"));
    const saved = process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
    if (setting === undefined) delete process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
    else process.env.PILOTSWARM_CLI_DISABLE_HOOKS = setting;
    const calls = [];
    const original = { start: CopilotClient.prototype.start, createSession: CopilotClient.prototype.createSession, resumeSession: CopilotClient.prototype.resumeSession };
    // What the CLI would read at each call: the two files as they are then.
    const files = () => ({ settingsFile: readOrNull(join(home, "settings.json")), configFile: readOrNull(join(home, "config.json")) });
    CopilotClient.prototype.start = async function () { calls.push({ call: "start", ...files() }); };
    CopilotClient.prototype.createSession = async function (config) { calls.push({ call: "create", config, ...files() }); return {}; };
    CopilotClient.prototype.resumeSession = async function (id, config) { calls.push({ call: "resume", id, config, ...files() }); return {}; };
    t.after(() => {
        Object.assign(CopilotClient.prototype, original);
        if (saved === undefined) delete process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
        else process.env.PILOTSWARM_CLI_DISABLE_HOOKS = saved;
        rmSync(home, { recursive: true, force: true });
    });
    return { home, calls };
}

function readOrNull(file) {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
}

test("unset, sessions get no enableFileHooks and the CLI home is left alone", async (t) => {
    const { home, calls } = setup(t, undefined);
    writeFileSync(join(home, "settings.json"), PLANTED_SETTINGS);
    const client = createCopilotClient({ env: { COPILOT_HOME: home } });
    await client.start();
    await client.createSession({ model: "m" });
    await client.resumeSession("s1", { model: "m" });
    assert.deepEqual(calls.map((c) => c.call), ["start", "create", "resume"]);
    for (const call of calls.slice(1)) assert.equal("enableFileHooks" in call.config, false);
    assert.equal(readFileSync(join(home, "settings.json"), "utf8"), PLANTED_SETTINGS);
    assert.equal(existsSync(join(home, "config.json")), false);
});

test("set, every launch, create and resume sees both files in their fixed form, and sessions get enableFileHooks false", async (t) => {
    const { home, calls } = setup(t, "1");
    writeFileSync(join(home, "settings.json"), PLANTED_SETTINGS);
    writeFileSync(join(home, "config.json"), PLANTED_CONFIG);
    const client = createCopilotClient({ env: { COPILOT_HOME: home } });
    await client.start();
    writeFileSync(join(home, "settings.json"), PLANTED_SETTINGS);
    await client.createSession({ model: "m", enableFileHooks: true });
    writeFileSync(join(home, "config.json"), PLANTED_CONFIG);
    await client.resumeSession("s1", { model: "m" });
    assert.deepEqual(calls.map((c) => c.call), ["start", "create", "resume"]);
    for (const call of calls) {
        assert.equal(call.settingsFile, CLI_HOOKS_OFF_SETTINGS_TEXT, `${call.call} saw the fixed settings.json`);
        assert.equal(call.configFile, CLI_HOOKS_OFF_CONFIG_TEXT, `${call.call} saw the fixed config.json`);
    }
    assert.deepEqual(calls[1].config, { model: "m", enableFileHooks: false });
    assert.deepEqual(calls[2].config, { model: "m", enableFileHooks: false });
    assert.deepEqual(JSON.parse(CLI_HOOKS_OFF_SETTINGS_TEXT), { disableAllHooks: true });
});

test("a file already in its form is not written, also with CRLF, no final newline or another firstLaunchAt, so a read-only one passes", async (t) => {
    const { home } = setup(t, "1");
    const settings = '{"disableAllHooks":true}';
    const config = '// User settings belong in settings.json.\r\n// This file is managed automatically.\r\n{\r\n  "firstLaunchAt": "2025-02-03T04:05:06.007Z"\r\n}';
    writeFileSync(join(home, "settings.json"), settings);
    writeFileSync(join(home, "config.json"), config);
    for (const name of ["settings.json", "config.json"]) chmodSync(join(home, name), 0o444);
    const before = ["settings.json", "config.json"].map((name) => statSync(join(home, name)).mtimeMs);
    await resetCliHomeSettings(home);
    assert.equal(readFileSync(join(home, "settings.json"), "utf8"), settings);
    assert.equal(readFileSync(join(home, "config.json"), "utf8"), config);
    assert.deepEqual(["settings.json", "config.json"].map((name) => statSync(join(home, name)).mtimeMs), before);
    for (const name of ["settings.json", "config.json"]) chmodSync(join(home, name), 0o644);
});

test("a missing file, one with other keys or one that doesn't parse is rewritten", async (t) => {
    const { home } = setup(t, "1");
    for (const [settings, config] of [[null, null], ['{"disableAllHooks":true,"hooks":{}}', '{"firstLaunchAt":"x"}'], ["{not json", "// User settings belong in settings.json.\n// This file is managed automatically.\n{"]]) {
        for (const [name, text] of [["settings.json", settings], ["config.json", config]]) {
            rmSync(join(home, name), { force: true });
            if (text !== null) writeFileSync(join(home, name), text);
        }
        await resetCliHomeSettings(home);
        assert.equal(readFileSync(join(home, "settings.json"), "utf8"), CLI_HOOKS_OFF_SETTINGS_TEXT);
        assert.equal(readFileSync(join(home, "config.json"), "utf8"), CLI_HOOKS_OFF_CONFIG_TEXT);
    }
});

test("when a file can't be put in form, the launch fails and the CLI doesn't start", async (t) => {
    const { home, calls } = setup(t, "1");
    mkdirSync(join(home, "config.json"));
    const client = createCopilotClient({ env: { COPILOT_HOME: home } });
    await assert.rejects(client.start(), /PILOTSWARM_CLI_DISABLE_HOOKS/);
    await assert.rejects(client.createSession({ model: "m" }), /PILOTSWARM_CLI_DISABLE_HOOKS/);
    assert.deepEqual(calls, []);
});

test("with PILOTSWARM_CLI_SECRET_ENV_VARS too, the hooks-off client starts the program with the flag and the caller's environment", async (t) => {
    const { home, calls } = setup(t, "1");
    const saved = Object.fromEntries(["PILOTSWARM_CLI_SECRET_ENV_VARS", "PILOTSWARM_SCRUB_CLI_ENV"].map((name) => [name, process.env[name]]));
    process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = "COPILOT_SDK_AUTH_TOKEN";
    delete process.env.PILOTSWARM_SCRUB_CLI_ENV;
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    writeFileSync(join(home, "settings.json"), PLANTED_SETTINGS);
    const env = { COPILOT_HOME: home, COPILOT_CLI_PATH: join(home, "copilot"), PS_EXTRA: "kept" };
    const client = createCopilotClient({ gitHubToken: "made-up-sdk-token", env });
    assert.equal(client.resolvedCliPath, env.COPILOT_CLI_PATH, "the program");
    assert.deepEqual(client.connectionExtraArgs, ["--secret-env-vars=COPILOT_SDK_AUTH_TOKEN"]);
    assert.deepEqual(client.resolvedEnv, env, "the caller's environment, on the connection");
    await client.start();
    await client.createSession({ model: "m" });
    assert.deepEqual(calls.map((c) => c.call), ["start", "create"]);
    assert.equal(calls[0].settingsFile, CLI_HOOKS_OFF_SETTINGS_TEXT, "the launch saw the fixed settings.json");
    assert.deepEqual(calls[1].config, { model: "m", enableFileHooks: false });
});

test("set, a CLI needs COPILOT_HOME, and the worker needs its session state folder inside it", (t) => {
    const { home } = setup(t, "1");
    assert.throws(() => createCopilotClient({ env: {} }), /COPILOT_HOME/);
    const saved = process.env.COPILOT_HOME;
    t.after(() => {
        if (saved === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = saved;
    });
    delete process.env.COPILOT_HOME;
    assert.throws(() => new PilotSwarmWorker({ sessionStateDir: join(home, "session-state"), disableManagementAgents: true }), /COPILOT_HOME/);
    process.env.COPILOT_HOME = home;
    assert.throws(() => new PilotSwarmWorker({ sessionStateDir: join(home, "elsewhere"), disableManagementAgents: true }), /session-state/);
    assert.doesNotThrow(() => new PilotSwarmWorker({ sessionStateDir: join(home, "session-state"), disableManagementAgents: true }));
});
