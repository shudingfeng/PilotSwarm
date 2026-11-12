/**
 * Copilot CLI hooks with the real CLI and the scripted model.
 *
 * - PILOTSWARM_CLI_DISABLE_HOOKS=1 (the SDK's bundled runtime): a hook
 *   planted in the CLI home's settings.json and one planted in the session's
 *   working folder don't run. Without the setting, both run.
 * - What the proposal observed of the Copilot CLI program: it runs hooks
 *   from its home (`settings.json`; `config.json`, whose settings it moves
 *   into `settings.json`; the `hooks` folder) and from the working folder
 *   (`.github/hooks/*.json`, `.github/copilot/settings.json`,
 *   `.github/copilot/settings.local.json`, `.claude/settings.json`), in new,
 *   resumed and tool-less sessions, with configuration discovery off. No
 *   single switch turns them all off: `disableAllHooks` covers only the
 *   home's inline hooks, a writable `config.json` overrides it, and
 *   `enableFileHooks: false` covers only the working folder. With
 *   PILOTSWARM_CLI_DISABLE_HOOKS=1 and an empty, read-only `hooks` folder,
 *   no planted hook runs; a file in that folder would.
 *
 * Needs no database. The program's tests skip, saying why, when the program
 * (an optional dependency) is not installed.
 *
 * Run: npx vitest run test/local/cli-hooks.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { cliProgramMissing } from "../helpers/cli-program.mjs";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { CLI_HOOKS_OFF_SETTINGS_TEXT } from "../../src/cli-hooks.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const TIMEOUT = 150_000;
const PROGRAM_MISSING = cliProgramMissing();

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

// ── the Copilot CLI program and every hook source ────────────────

const WORKING_FOLDER_SOURCES = ["github-hooks", "copilot-settings", "copilot-settings-local", "claude-settings"];
const CLI_CONFIG_LINES = "// User settings belong in settings.json.\n// This file is managed automatically.\n";

/**
 * A CLI home and a working folder with one hook per source, each writing
 * its own marker when a prompt is submitted. The home's inline and folder
 * hooks are planted by the test as it goes.
 */
function hookWorld() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-hook-sources-"));
    const world = {
        root,
        home: path.join(root, "home"),
        work: path.join(root, "work"),
        marks: path.join(root, "marks"),
    };
    for (const dir of [world.home, path.join(world.home, "hooks"), world.marks]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [[".github", "hooks"], [".github", "copilot"], [".claude"]]) fs.mkdirSync(path.join(world.work, ...dir), { recursive: true });
    const inline = (name) => ({ userPromptSubmitted: [hook(path.join(world.marks, name))] });
    world.inline = inline;
    world.plant = {
        settings: (extra = {}) => fs.writeFileSync(path.join(world.home, "settings.json"), JSON.stringify({ ...extra, hooks: inline("home-settings") })),
        config: (extra = {}) => fs.writeFileSync(path.join(world.home, "config.json"),
            `${CLI_CONFIG_LINES}${JSON.stringify({ firstLaunchAt: "2026-01-01T00:00:00.000Z", ...extra, hooks: inline("home-config") }, null, 2)}\n`),
        hooksFolder: () => fs.writeFileSync(path.join(world.home, "hooks", "probe.json"), JSON.stringify({ version: 1, hooks: inline("home-hooks-folder") })),
        workingFolder: () => {
            fs.writeFileSync(path.join(world.work, ".github", "hooks", "probe.json"), JSON.stringify({ version: 1, hooks: inline("github-hooks") }));
            fs.writeFileSync(path.join(world.work, ".github", "copilot", "settings.json"), JSON.stringify({ hooks: inline("copilot-settings") }));
            fs.writeFileSync(path.join(world.work, ".github", "copilot", "settings.local.json"), JSON.stringify({ hooks: inline("copilot-settings-local") }));
            fs.writeFileSync(path.join(world.work, ".claude", "settings.json"), JSON.stringify({ hooks: inline("claude-settings") }));
        },
    };
    return world;
}

/** Hooks that ran for one prompt; `expected` ends the wait early when every one of them ran. */
async function promptHooks(world, session, expected) {
    for (const name of fs.readdirSync(world.marks)) fs.rmSync(path.join(world.marks, name));
    await session.sendAndWait({ prompt: "hello" }, 90_000);
    const ran = () => fs.readdirSync(world.marks).sort();
    await waitFor(() => expected.length > 0 && expected.every((name) => ran().includes(name)), expected.length > 0 ? 20_000 : 3_000);
    return ran();
}

/** Clients of the Copilot CLI program on `world`'s home, with the scripted model; `disableHooks` sets PILOTSWARM_CLI_DISABLE_HOOKS. */
async function programClients(world, { disableHooks = false } = {}) {
    const model = await startScriptedModel({ respond: () => ({ content: "ok" }) });
    const saved = Object.fromEntries(["PILOTSWARM_CLI_SECRET_ENV_VARS", "PILOTSWARM_CLI_DISABLE_HOOKS"].map((name) => [name, process.env[name]]));
    process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = "COPILOT_SDK_AUTH_TOKEN";
    if (disableHooks) process.env.PILOTSWARM_CLI_DISABLE_HOOKS = "1";
    else delete process.env.PILOTSWARM_CLI_DISABLE_HOOKS;
    const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" };
    const clients = [];
    return {
        options: { model: "fixture-model", provider, workingDirectory: world.work, onPermissionRequest: approvePermissionForSession },
        async start() {
            const client = createCopilotClient({ env: cliEnv(world.home), workingDirectory: world.work }, provider);
            clients.push(client);
            await client.start();
            return client;
        },
        async close() {
            for (const client of clients) await client.stop().catch(() => {});
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            await model.close();
        },
    };
}

/** Take this account's right to add files to `dir` away; false when it can't be (root on Linux). */
function makeFolderReadOnly(dir) {
    try {
        if (process.platform === "win32") {
            execFileSync("icacls", [dir, "/deny", `${process.env.USERNAME}:(OI)(CI)(WD,AD)`, "/Q"], { stdio: "ignore" });
            return true;
        }
        if (process.getuid?.() === 0) return false;
        fs.chmodSync(dir, 0o555);
        return true;
    } catch {
        return false;
    }
}

function makeFolderWritable(dir) {
    try {
        if (process.platform === "win32") execFileSync("icacls", [dir, "/remove:d", process.env.USERNAME, "/T", "/Q"], { stdio: "ignore" });
        else fs.chmodSync(dir, 0o755);
    } catch {
        // It was never made read-only.
    }
}

function removeWorld(world) {
    makeFolderWritable(path.join(world.home, "hooks"));
    fs.rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

    it("the program runs a hook from each home and working folder source, in new, resumed and tool-less sessions", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const world = hookWorld();
        world.plant.settings();
        world.plant.hooksFolder();
        world.plant.workingFolder();
        const cli = await programClients(world);
        try {
            const first = await cli.start();
            const created = await first.createSession(cli.options);
            const fromSettings = ["home-hooks-folder", "home-settings", ...WORKING_FOLDER_SOURCES].sort();
            assertEqual(JSON.stringify(await promptHooks(world, created, fromSettings)), JSON.stringify(fromSettings), "a new session ran every hook");

            // config.json's settings move into settings.json at the program's next start, hooks included.
            world.plant.config();
            await created.disconnect();
            await first.stop();
            const second = await cli.start();
            const resumed = await second.resumeSession(created.sessionId, cli.options);
            const fromConfig = ["home-config", "home-hooks-folder", ...WORKING_FOLDER_SOURCES].sort();
            assertEqual(JSON.stringify(await promptHooks(world, resumed, fromConfig)), JSON.stringify(fromConfig), "a resumed session ran every hook");
            assert(fs.readFileSync(path.join(world.home, "settings.json"), "utf8").includes("home-config"), "config.json's hook moved into settings.json");

            const toolless = await second.createSession({ ...cli.options, availableTools: [] });
            assertEqual(JSON.stringify(await promptHooks(world, toolless, fromConfig)), JSON.stringify(fromConfig), "a tool-less session ran every hook");
        } finally {
            await cli.close();
            removeWorld(world);
        }
    });

    it("no single switch turns them all off: disableAllHooks covers the home's inline hooks, config.json overrides it, enableFileHooks: false covers the working folder", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const cases = [
            {
                name: "disableAllHooks in settings.json",
                plant: (world) => world.plant.settings({ disableAllHooks: true }),
                expected: ["home-hooks-folder", ...WORKING_FOLDER_SOURCES],
            },
            {
                name: "a config.json that sets disableAllHooks back",
                plant: (world) => {
                    fs.writeFileSync(path.join(world.home, "settings.json"), JSON.stringify({ disableAllHooks: true }));
                    world.plant.config({ disableAllHooks: false });
                },
                expected: ["home-config", "home-hooks-folder", ...WORKING_FOLDER_SOURCES],
            },
            {
                name: "enableFileHooks: false",
                plant: (world) => world.plant.settings(),
                session: { enableFileHooks: false },
                expected: ["home-hooks-folder", "home-settings"],
            },
        ];
        for (const { name, plant, session, expected } of cases) {
            const world = hookWorld();
            plant(world);
            world.plant.hooksFolder();
            world.plant.workingFolder();
            const cli = await programClients(world);
            try {
                const client = await cli.start();
                const created = await client.createSession({ ...cli.options, ...session });
                const ran = await promptHooks(world, created, expected);
                assertEqual(JSON.stringify(ran), JSON.stringify([...expected].sort()), `with ${name}`);
            } finally {
                await cli.close();
                removeWorld(world);
            }
        }
    });

    it("with PILOTSWARM_CLI_DISABLE_HOOKS=1 and an empty, read-only hooks folder, no planted hook runs; a file in that folder would", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const world = hookWorld();
        const hooksFolder = path.join(world.home, "hooks");
        const readOnly = makeFolderReadOnly(hooksFolder);
        // What a session could plant for later sessions, before every one of them.
        const plantEverything = () => {
            world.plant.settings();
            world.plant.config();
            world.plant.workingFolder();
        };
        plantEverything();
        const cli = await programClients(world, { disableHooks: true });
        try {
            if (readOnly) {
                assert(!(() => {
                    try {
                        fs.writeFileSync(path.join(hooksFolder, "planted.json"), "{}");
                        return true;
                    } catch {
                        return false;
                    }
                })(), "a session cannot add a file to the read-only hooks folder");
            }
            const first = await cli.start();
            const created = await first.createSession(cli.options);
            assertEqual(JSON.stringify(await promptHooks(world, created, [])), "[]", "a new session ran no hook");

            plantEverything();
            await created.disconnect();
            await first.stop();
            const second = await cli.start();
            const resumed = await second.resumeSession(created.sessionId, cli.options);
            assertEqual(JSON.stringify(await promptHooks(world, resumed, [])), "[]", "a resumed session ran no hook");

            plantEverything();
            const toolless = await second.createSession({ ...cli.options, availableTools: [] });
            assertEqual(JSON.stringify(await promptHooks(world, toolless, [])), "[]", "a tool-less session ran no hook");
            assertEqual(fs.readFileSync(path.join(world.home, "settings.json"), "utf8"), CLI_HOOKS_OFF_SETTINGS_TEXT);

            // The setting doesn't cover the folder: that is why it stays empty and read-only.
            makeFolderWritable(hooksFolder);
            world.plant.hooksFolder();
            const third = await cli.start();
            const later = await third.createSession(cli.options);
            assertEqual(JSON.stringify(await promptHooks(world, later, ["home-hooks-folder"])), JSON.stringify(["home-hooks-folder"]),
                "a hook file in the folder runs");
        } finally {
            await cli.close();
            removeWorld(world);
        }
    });
});
