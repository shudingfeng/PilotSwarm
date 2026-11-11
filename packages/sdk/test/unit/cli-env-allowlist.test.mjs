/**
 * PILOTSWARM_SCRUB_CLI_ENV=1: every Copilot CLI the SDK starts gets only the
 * platform baseline, the Copilot settings and the names a deployment lists in
 * PILOTSWARM_CLI_ENV_ALLOWLIST, so agents' shells and MCP servers don't inherit
 * the worker's credentials. Unset, a CLI gets its caller's environment as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotClient, scrubbedCliEnvironment } from "../../dist/copilot-client.js";
import { PilotSwarmWorker } from "../../dist/index.js";

const WINDOWS_ENV = {
    Path: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    TEMP: "C:\\temp",
    COPILOT_HOME: "C:\\copilot",
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "C:\\instructions",
    COPILOT_PKG_CACHE_HOME: "C:\\copilot-pkg",
    COPILOT_CLI_DIST_DIR: "C:\\elsewhere",
    COPILOT_CACHE_HOME: "C:\\cache",
    NUGET_PACKAGES: "C:\\nuget",
    DOTNET_ROOT: "C:\\dotnet",
    MSBuildSDKsPath: "C:\\msbuild",
    GITHUB_TOKEN: "made-up-token",
    AZURE_CLIENT_SECRET: "made-up-secret",
    DATABASE_URL: "postgresql://user:made-up@db/x",
};

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

test("off by default: nothing is scrubbed", () => {
    assert.equal(scrubbedCliEnvironment(WINDOWS_ENV, {}, "win32"), undefined);
    assert.equal(scrubbedCliEnvironment(WINDOWS_ENV, { PILOTSWARM_SCRUB_CLI_ENV: "0" }, "win32"), undefined);
});

test("on Windows, only the baseline, the Copilot settings and the listed names stay, in any case", () => {
    const env = scrubbedCliEnvironment(WINDOWS_ENV, {
        PILOTSWARM_SCRUB_CLI_ENV: "1",
        PILOTSWARM_CLI_ENV_ALLOWLIST: "NUGET_*, dotnet_root,MSBUILD*",
    }, "win32");
    assert.deepEqual(Object.keys(env).sort(), [
        "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_HOME", "COPILOT_PKG_CACHE_HOME", "DOTNET_ROOT", "MSBuildSDKsPath", "NUGET_PACKAGES", "Path",
        "ProgramFiles(x86)", "SystemRoot", "TEMP",
    ].sort(), "other Copilot variables, such as COPILOT_CLI_DIST_DIR and COPILOT_CACHE_HOME, are dropped");
    assert.equal(env.Path, WINDOWS_ENV.Path, "names keep their case and their values");
});

test("on Linux and macOS, the POSIX baseline with every LC_ variable", () => {
    const env = scrubbedCliEnvironment({
        PATH: "/usr/bin", HOME: "/home/w", LANG: "C.UTF-8", LC_ALL: "C", TERM: "xterm",
        AWS_SECRET_ACCESS_KEY: "made-up", GH_TOKEN: "made-up",
    }, { PILOTSWARM_SCRUB_CLI_ENV: "1" }, "linux");
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TERM"]);
});

test("an allowlist entry that is not a name or a name prefix is refused, by the worker too", (t) => {
    for (const bad of ["*", "FOO BAR", "A*B", "X;Y"]) {
        assert.throws(
            () => scrubbedCliEnvironment({}, { PILOTSWARM_SCRUB_CLI_ENV: "1", PILOTSWARM_CLI_ENV_ALLOWLIST: bad }, "linux"),
            /PILOTSWARM_CLI_ENV_ALLOWLIST/, bad,
        );
    }
    const root = mkdtempSync(join(tmpdir(), "ps-cli-env-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    withSettings(t, { PILOTSWARM_SCRUB_CLI_ENV: "1", PILOTSWARM_CLI_ENV_ALLOWLIST: "*" });
    assert.throws(
        () => new PilotSwarmWorker({ store: "sqlite::memory:", disableManagementAgents: true, sessionStateDir: join(root, "sessions") }),
        /PILOTSWARM_CLI_ENV_ALLOWLIST/,
    );
});

test("a CLI client starts with the scrubbed environment plus only the SDK's own token", (t) => {
    withSettings(t, { PILOTSWARM_SCRUB_CLI_ENV: "1", PILOTSWARM_CLI_ENV_ALLOWLIST: undefined });
    const client = createCopilotClient({ gitHubToken: "made-up-sdk-token", env: { ...WINDOWS_ENV, PATH: "/usr/bin", HOME: "/home/w" } });
    const runtimeEnv = client.buildRuntimeEnv();
    for (const secret of ["GITHUB_TOKEN", "AZURE_CLIENT_SECRET", "DATABASE_URL", "NUGET_PACKAGES"]) {
        assert.equal(Object.hasOwn(runtimeEnv, secret), false, `${secret} is not passed on`);
    }
    assert.equal(runtimeEnv.COPILOT_HOME, "C:\\copilot");
    assert.equal(runtimeEnv.COPILOT_SDK_AUTH_TOKEN, "made-up-sdk-token", "the SDK still adds its own token");

    process.env.PILOTSWARM_SCRUB_CLI_ENV = "0";
    const unscrubbed = createCopilotClient({ env: { ...WINDOWS_ENV } }).buildRuntimeEnv();
    assert.equal(unscrubbed.GITHUB_TOKEN, "made-up-token", "off, the caller's environment passes as before");
});

test("a CLI client whose caller sets no env, such as the title client, gets the worker's Copilot home and instructions", (t) => {
    withSettings(t, {
        PILOTSWARM_SCRUB_CLI_ENV: "1",
        PILOTSWARM_CLI_ENV_ALLOWLIST: undefined,
        COPILOT_HOME: "/srv/copilot-home",
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/srv/instructions",
        GITHUB_TOKEN: "made-up-token",
    });
    const runtimeEnv = createCopilotClient({}).buildRuntimeEnv();
    assert.equal(runtimeEnv.COPILOT_HOME, "/srv/copilot-home");
    assert.equal(runtimeEnv.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, "/srv/instructions");
    assert.equal(Object.hasOwn(runtimeEnv, "GITHUB_TOKEN"), false);
});
