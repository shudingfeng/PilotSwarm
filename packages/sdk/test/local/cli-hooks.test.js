/**
 * PILOTSWARM_CLI_DISABLE_HOOKS=1 with the real Copilot CLI and the scripted
 * model: a hook planted in the CLI home's settings.json and one planted in
 * the session's working folder don't run. Without the setting, both run.
 * Needs no database.
 *
 * Run: npx vitest run test/local/cli-hooks.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { CLI_HOOKS_OFF_SETTINGS_TEXT } from "../../src/cli-hooks.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const TIMEOUT = 150_000;

const hook = (marker) => ({
    type: "command",
    powershell: `Set-Content -LiteralPath '${marker}' -Value ran`,
    bash: `echo ran > '${marker}'`,
    timeoutSec: 20,
});

/** The CLI's environment: this process's, without Copilot settings it may have inherited. */
function cliEnv(home) {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.startsWith("COPILOT_")) env[name] = value;
    }
    return { ...env, COPILOT_HOME: home };
}

async function waitFor(check, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return check();
}

async function runSession(setting) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-hooks-"));
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const homeMarker = path.join(root, "home-hook-ran.txt");
    const repoMarker = path.join(root, "repo-hook-ran.txt");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repo, ".github", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ hooks: { sessionStart: [hook(homeMarker)] } }));
    fs.writeFileSync(path.join(repo, ".github", "hooks", "probe.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [hook(repoMarker)] } }));
    const model = await startScriptedModel({ respond: () => ({ content: "ok" }) });
    const saved = process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
    if (setting === undefined) delete process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
    else process.env.PILOTSWARM_CLI_DISABLE_HOOKS = setting;
    const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" };
    const client = createCopilotClient({ env: cliEnv(home), workingDirectory: repo }, provider);
    try {
        await client.start();
        const session = await client.createSession({
            model: "fixture-model", provider, workingDirectory: repo, onPermissionRequest: approvePermissionForSession,
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the turn did not finish")), 90_000);
            session.on("session.idle", () => { clearTimeout(timer); resolve(); });
            session.on("session.error", (event) => { clearTimeout(timer); reject(new Error(event.data?.message ?? "session error")); });
            session.send({ prompt: "hello" });
        });
        const expectRun = setting === undefined;
        await waitFor(() => fs.existsSync(homeMarker) && fs.existsSync(repoMarker), expectRun ? 20_000 : 5_000);
        return {
            homeRan: fs.existsSync(homeMarker),
            repoRan: fs.existsSync(repoMarker),
            settings: fs.readFileSync(path.join(home, "settings.json"), "utf8"),
        };
    } finally {
        if (saved === undefined) delete process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
        else process.env.PILOTSWARM_CLI_DISABLE_HOOKS = saved;
        await client.stop().catch(() => {});
        await model.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe("CLI hooks", () => {
    it("without the setting, the CLI runs a hook from its home and one from the working folder", { timeout: TIMEOUT }, async () => {
        const { homeRan, repoRan } = await runSession(undefined);
        assert(homeRan, "the home's settings.json hook ran");
        assert(repoRan, "the working folder's hook ran");
    });

    it("with PILOTSWARM_CLI_DISABLE_HOOKS=1, neither runs, and the home's settings turn hooks off", { timeout: TIMEOUT }, async () => {
        const { homeRan, repoRan, settings } = await runSession("1");
        assert(!homeRan, "the home's settings.json hook did not run");
        assert(!repoRan, "the working folder's hook did not run");
        assertEqual(settings, CLI_HOOKS_OFF_SETTINGS_TEXT);
    });
});
