/**
 * External personal secrets with the real Copilot CLI program: the token the
 * personal credential resolver returns reaches the CLI, which uses it for the
 * turn, and after the turn it is in no file under the session state folder,
 * the rest of the CLI's home, the working folder or the temporary folder, nor
 * in an event PilotSwarm would persist. PilotSwarm keeps it in memory only.
 *
 * The session's model is on a GitHub-type provider whose key is in the
 * deployment's store, as on a Windows worker; the fake GitHub and Copilot
 * APIs (helpers/fake-github-copilot.mjs) stand in for GitHub, so the run is
 * offline. Needs no database.
 *
 * Run: npx vitest run test/local/personal-credential-cli.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { cliProgramMissing } from "../helpers/cli-program.mjs";
import { FAKE_GITHUB_MODEL, startFakeGitHubCopilot } from "../helpers/fake-github-copilot.mjs";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { buildRuntimeRegistry } from "../../src/provider-catalog.ts";

const TIMEOUT = 150_000;
// The program is an optional dependency; without it the test skips, saying why.
const PROGRAM_MISSING = cliProgramMissing();
const TOKEN = `github_pat_${"7".repeat(22)}_${"q".repeat(59)}`;
const MODEL = `carol-ghcp:${FAKE_GITHUB_MODEL}`;
const SECRET = { kind: "externalSecret", store: "fixture-store", name: "ghcp-carol-0001", version: "v1", expiresOn: null };
const SHELL = process.platform === "win32"
    ? { name: "powershell", args: { command: "Write-Output probe-ok", description: "Print a word" } }
    : { name: "bash", args: { command: "echo probe-ok", description: "Print a word" } };

/** Every file under `dir` that holds `text`, as relative paths. */
function filesHolding(dir, text) {
    const found = [];
    const walk = (folder) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const target = path.join(folder, entry.name);
            if (entry.isDirectory()) walk(target);
            else if (entry.isFile() && fs.readFileSync(target).includes(text)) found.push(path.relative(dir, target));
        }
    };
    walk(dir);
    return found;
}

/** Set process environment variables for one run; returns the restore. */
function setEnv(values) {
    const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    return () => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    };
}

describe("a resolved personal token and the disk", () => {
    it("reaches the CLI for the turn, and no file holds it afterwards", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const github = await startFakeGitHubCopilot({
            respond: (_body, position) => (position.toolResults.length === 0 ? { tools: [SHELL] } : { content: "done" }),
        });
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-token-disk-")));
        const home = path.join(root, "copilot-home");
        const work = path.join(root, "work");
        const temp = path.join(root, "temp");
        for (const dir of [home, work, temp]) fs.mkdirSync(dir, { recursive: true });
        // The CLI is started with this process's environment: the program, as on a Windows worker,
        // GitHub's API at the stand-in, and a temporary folder of the run's own.
        const restore = setEnv({
            PILOTSWARM_CLI_SECRET_ENV_VARS: "COPILOT_SDK_AUTH_TOKEN",
            PILOTSWARM_PERSONAL_SECRETS: undefined,
            COPILOT_DEBUG_GITHUB_API_URL: github.baseUrl,
            COPILOT_HOME: undefined, COPILOT_CLI_PATH: undefined, COPILOT_PKG_CACHE_HOME: undefined,
            GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined,
            TEMP: temp, TMP: temp, TMPDIR: temp,
        });
        const types = new ModelProviderRegistry({
            providers: [{ id: "github-copilot", type: "github", models: [{ name: FAKE_GITHUB_MODEL }] }],
        }, { keepUncredentialed: true });
        const registry = buildRuntimeRegistry(types, [
            { name: "carol-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: 7, baseUrl: null, secretRef: SECRET },
        ], null);
        const manager = new SessionManager(undefined, null, { modelProviders: registry, turnTimeoutMs: 90_000 }, path.join(home, "session-state"));
        manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: 1 }) });
        const asked = [];
        manager.setPersonalCredentialResolver(async (request) => {
            asked.push(request);
            return { status: "ok", token: TOKEN };
        });
        const sessionId = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
        const config = { model: MODEL, workingDirectory: work };
        try {
            manager.setConfig(sessionId, config);
            await manager.preparePersonalCredential(sessionId, MODEL);
            const session = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            const result = await session.runTurn("Print a word, then say done.", { onEvent: (event) => events.push(event) });
            assertEqual(result.type, "completed", `the turn completed: ${JSON.stringify(result).slice(0, 300)}`);

            assertEqual(asked.length, 1, "the resolver was asked once");
            assertEqual(JSON.stringify(asked[0].secret), JSON.stringify(SECRET));
            const completions = github.requests.filter((request) => request.path.endsWith("/chat/completions"));
            assert(completions.length >= 2, "the model was asked, and called the shell, on the native transport");
            assert(completions.every((request) => request.authorization?.endsWith(` ${TOKEN}`)), "every model request carried the resolved token");
            assert(events.some((event) => event.eventType === "tool.execution_complete"), "the shell ran");
            assert(!JSON.stringify(events).includes(TOKEN), "no event PilotSwarm would persist holds the token");

            await manager.dropWarmSession(sessionId);
            assert(fs.readdirSync(path.join(home, "session-state", sessionId)).length > 0, "the session state folder holds the turn");
            assertEqual(JSON.stringify(filesHolding(root, TOKEN)), "[]", "no file under the session state folder, the CLI home, the working folder or TEMP holds the token");
        } finally {
            await manager.shutdown().catch(() => {});
            restore();
            await github.close();
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });
});
