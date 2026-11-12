/**
 * PILOTSWARM_CLI_SECRET_ENV_VARS with the real Copilot CLI and the scripted
 * model, showing what the proposal observed of the Copilot CLI program:
 *
 * - with the setting, the program keeps every named variable, the SDK's own
 *   COPILOT_SDK_AUTH_TOKEN included, from the agent's shell, an MCP server
 *   and a hook, while a variable it doesn't name reaches all three; the
 *   session offers none of the program's bundled skills, which the program
 *   offers without `includedBuiltinSkills: []`;
 * - the SDK's bundled runtime refuses `--secret-env-vars`, and without the
 *   setting it gives the shell, the MCP server and the hook the token;
 * - the flag hides but doesn't redact: a named variable's value that a tool
 *   reads from a file is in the tool's result, the reply, `events.jsonl` and
 *   the CLI's session store.
 *
 * The CLI gets a made-up token, and GitHub's API is a local stand-in that
 * refuses it (helpers/fake-github-copilot.mjs), so nothing leaves the
 * machine; the sessions run on the scripted model. Needs no database.
 *
 * Run: npx vitest run test/local/cli-program-secret-env.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { assert, assertEqual } from "../helpers/assertions.js";
import { cliProgramMissing } from "../helpers/cli-program.mjs";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { startFakeGitHubCopilot } from "../helpers/fake-github-copilot.mjs";
import { createCopilotClient, withCliProgramSessionOptions } from "../../src/copilot-client.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const TIMEOUT = 150_000;
// The program is an optional dependency; its tests skip, saying why, without it.
const PROGRAM_MISSING = cliProgramMissing();
const SECRET = "made-up-secret-7f3a9c";
const VISIBLE = "made-up-visible-2b4d";
const TOKEN = "made-up-sdk-token-91e0";
const MCP_PROBE = fileURLToPath(new URL("../helpers/env-probe-mcp.mjs", import.meta.url));
const NAMES = ["PS_PROBE_SECRET", "PS_PROBE_VISIBLE", "COPILOT_SDK_AUTH_TOKEN"];
const PROBE = process.platform === "win32"
    ? { name: "powershell", args: { command: 'Write-Output "sec=[$env:PS_PROBE_SECRET] vis=[$env:PS_PROBE_VISIBLE] tok=[$env:COPILOT_SDK_AUTH_TOKEN]"', description: "Print the probe variables" } }
    : { name: "bash", args: { command: 'echo "sec=[$PS_PROBE_SECRET] vis=[$PS_PROBE_VISIBLE] tok=[$COPILOT_SDK_AUTH_TOKEN]"', description: "Print the probe variables" } };
const SEEN = (secret, token) => `sec=[${secret ? SECRET : ""}] vis=[${VISIBLE}] tok=[${token ? TOKEN : ""}]`;

/** A hook that writes the probe variables it gets to `file`. */
const envHook = (file) => ({
    type: "command",
    powershell: `Set-Content -LiteralPath '${file}' -Value ('sec=[' + $env:PS_PROBE_SECRET + '] vis=[' + $env:PS_PROBE_VISIBLE + '] tok=[' + $env:COPILOT_SDK_AUTH_TOKEN + ']')`,
    bash: `echo "sec=[$PS_PROBE_SECRET] vis=[$PS_PROBE_VISIBLE] tok=[$COPILOT_SDK_AUTH_TOKEN]" > '${file}'`,
    timeoutSec: 20,
});

/** The CLI's environment: this process's, without Copilot settings it may have inherited, so each run picks its own CLI. */
function cliEnv(home, extra = {}) {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.startsWith("COPILOT_")) env[name] = value;
    }
    return { ...env, COPILOT_HOME: home, PS_PROBE_SECRET: SECRET, PS_PROBE_VISIBLE: VISIBLE, ...extra };
}

function withSecretNames(secretNames) {
    const saved = process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
    if (secretNames) process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = secretNames;
    else delete process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
    return () => {
        if (saved === undefined) delete process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
        else process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = saved;
    };
}

function readIfThere(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

async function untilIdle(session, prompt) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the probe turn did not finish")), 90_000);
        session.on("session.idle", () => { clearTimeout(timer); resolve(); });
        session.on("session.error", (event) => { clearTimeout(timer); reject(new Error(event.data?.message ?? "session error")); });
        session.send({ prompt });
    });
}

/**
 * One session that runs the shell probe, with an MCP server and a working
 * folder hook that record the probe variables. `sessionOptions` replace the
 * CLI program's own session options when given.
 */
async function runProbe(secretNames, { sessionOptions } = {}) {
    const model = await startScriptedModel({
        respond: (_body, position) => (position.toolResults.length === 0 ? { tools: [PROBE] } : { content: "probed" }),
    });
    const github = await startFakeGitHubCopilot({ refuse: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-secret-"));
    const home = path.join(root, "home");
    const work = path.join(root, "work");
    const hookFile = path.join(root, "hook-env.txt");
    const mcpFile = path.join(root, "mcp-env.json");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(work, ".github", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(work, ".github", "hooks", "probe.json"), JSON.stringify({ version: 1, hooks: { userPromptSubmitted: [envHook(hookFile)] } }));
    const restore = withSecretNames(secretNames);
    const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" };
    const client = createCopilotClient({
        gitHubToken: TOKEN, env: cliEnv(home, { COPILOT_DEBUG_GITHUB_API_URL: github.baseUrl }), workingDirectory: work,
    }, provider);
    try {
        await client.start();
        const base = {
            model: "fixture-model", provider, workingDirectory: work, onPermissionRequest: approvePermissionForSession,
            mcpServers: { probe: { type: "local", command: process.execPath, args: [MCP_PROBE, mcpFile, ...NAMES], tools: ["*"] } },
        };
        const session = await client.createSession(sessionOptions ? { ...base, ...sessionOptions } : withCliProgramSessionOptions(base));
        await untilIdle(session, "Run the probe.");
        return {
            cliPath: String(client.resolvedCliPath ?? ""),
            shell: model.requests.find((r) => r.position.toolResults.length > 0)?.position.toolResults.join("\n") ?? "",
            hook: readIfThere(hookFile),
            mcp: JSON.parse(readIfThere(mcpFile) ?? "null"),
            tools: (model.requests.find((r) => r.session)?.body.tools ?? []).map((t) => t.function?.name),
            tokenSent: github.requests.some((r) => r.authorization?.endsWith(` ${TOKEN}`)),
        };
    } finally {
        restore();
        await client.stop().catch(() => {});
        await model.close();
        await github.close();
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

describe("CLI program secret environment variables", () => {
    it("with the setting, the program keeps each named variable from the shell, an MCP server and a hook, and offers no bundled skill", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const { cliPath, shell, hook, mcp, tools, tokenSent } = await runProbe("COPILOT_SDK_AUTH_TOKEN,PS_PROBE_SECRET");
        assert(/@github[\\/]copilot-[a-z0-9]+-[a-z0-9]+[\\/]copilot(\.exe)?$/.test(cliPath), `the CLI program ran: ${cliPath}`);
        assert(tokenSent, "the program itself had the token: it sent it to GitHub's API");
        assert(shell.includes(SEEN(false, false)), `the shell had neither named variable, and the unnamed one: ${shell}`);
        assertEqual(hook, SEEN(false, false), "the hook had neither named variable, and the unnamed one");
        assertEqual(JSON.stringify(mcp), JSON.stringify({ PS_PROBE_SECRET: null, PS_PROBE_VISIBLE: VISIBLE, COPILOT_SDK_AUTH_TOKEN: null }),
            "the MCP server had neither named variable, and the unnamed one");
        assert(!tools.includes("skill"), `no bundled skill is offered: ${tools.join(", ")}`);
    });

    it("without includedBuiltinSkills: [], the program offers its bundled skills", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const { tools } = await runProbe("COPILOT_SDK_AUTH_TOKEN", { sessionOptions: {} });
        assert(tools.includes("skill"), `the program's bundled skills are offered: ${tools.join(", ")}`);
    });

    it("without it, the bundled runtime gives the shell, the MCP server and the hook the token and every variable", { timeout: TIMEOUT }, async () => {
        const { cliPath, shell, hook, mcp, tokenSent } = await runProbe(undefined);
        assert(!/@github[\\/]copilot-[a-z0-9]+-[a-z0-9]+[\\/]copilot/.test(cliPath), `the bundled runtime ran: ${cliPath}`);
        assert(tokenSent, "the runtime had the token");
        assert(shell.includes(SEEN(true, true)), `the shell had every variable: ${shell}`);
        assertEqual(hook, SEEN(true, true), "the hook had every variable");
        assertEqual(JSON.stringify(mcp), JSON.stringify({ PS_PROBE_SECRET: SECRET, PS_PROBE_VISIBLE: VISIBLE, COPILOT_SDK_AUTH_TOKEN: TOKEN }),
            "the MCP server had every variable");
    });

    it("the bundled runtime refuses --secret-env-vars", { timeout: TIMEOUT }, async () => {
        // This changes when the SDK's runtime takes the flag (the proposal's open question 8).
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-secret-"));
        const client = new CopilotClient({
            gitHubToken: TOKEN,
            connection: RuntimeConnection.forStdio({ args: ["--secret-env-vars=COPILOT_SDK_AUTH_TOKEN"], env: cliEnv(home) }),
        });
        try {
            const failure = await client.start().then(() => null, (error) => String(error?.message ?? error));
            assert(failure !== null, "the bundled runtime started with --secret-env-vars");
            assert(/unsupported argument '--secret-env-vars/.test(failure), `it refused the flag: ${failure}`);
        } finally {
            await client.forceStop().catch(() => {});
            fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    it("the flag redacts nothing: a named variable's value read from a file is in the tool result, the reply, events.jsonl and the session store", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(PROGRAM_MISSING), PROGRAM_MISSING);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-secret-"));
        const home = path.join(root, "home");
        const work = path.join(root, "work");
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(work, { recursive: true });
        const file = path.join(work, "probe.txt");
        fs.writeFileSync(file, `value=${SECRET}\n`);
        const model = await startScriptedModel({
            respond: (_body, position) => (position.toolResults.length === 0
                ? { tools: [{ name: "view", args: { path: file } }] }
                : { content: `The file says: ${position.toolResults.join(" ")}` }),
        });
        const github = await startFakeGitHubCopilot({ refuse: true });
        const restore = withSecretNames("COPILOT_SDK_AUTH_TOKEN,PS_PROBE_SECRET");
        const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" };
        const client = createCopilotClient({ env: cliEnv(home, { COPILOT_DEBUG_GITHUB_API_URL: github.baseUrl }), workingDirectory: work }, provider);
        try {
            await client.start();
            const session = await client.createSession(withCliProgramSessionOptions({
                model: "fixture-model", provider, workingDirectory: work, onPermissionRequest: approvePermissionForSession,
            }));
            const events = [];
            session.on((event) => events.push(event));
            const reply = await session.sendAndWait({ prompt: "Read probe.txt." }, 90_000);
            const sessionId = session.sessionId;
            await session.disconnect();
            await client.stop();
            const toolResult = model.requests.find((r) => r.position.toolResults.length > 0)?.position.toolResults.join("\n") ?? "";
            assert(toolResult.includes(SECRET), `the tool result holds the value: ${toolResult}`);
            assert(events.some((event) => event.type === "tool.execution_complete" && JSON.stringify(event.data).includes(SECRET)),
                "so does the tool's completion event");
            assert(String(reply?.data?.content).includes(SECRET), "the reply holds it");
            assert(fs.readFileSync(path.join(home, "session-state", sessionId, "events.jsonl"), "utf8").includes(SECRET), "events.jsonl holds it");
            const store = fs.readdirSync(home).filter((name) => name.startsWith("session-store.db"));
            assert(store.length > 0, `the program keeps a session store: ${fs.readdirSync(home).join(", ")}`);
            assert(store.some((name) => fs.readFileSync(path.join(home, name)).includes(SECRET)), "the session store holds it");
        } finally {
            restore();
            await client.stop().catch(() => {});
            await model.close();
            await github.close();
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });
});
