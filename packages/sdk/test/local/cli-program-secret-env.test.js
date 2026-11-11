/**
 * PILOTSWARM_CLI_SECRET_ENV_VARS with the real Copilot CLI program and the
 * scripted model: the agent's shell does not get a named variable, and the
 * session offers none of the program's bundled skills. Without the setting,
 * the SDK's bundled runtime gives the shell the variable. Needs no database.
 *
 * Run: npx vitest run test/local/cli-program-secret-env.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { assert } from "../helpers/assertions.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { createCopilotClient, withCliProgramSessionOptions } from "../../src/copilot-client.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const TIMEOUT = 150_000;
const SECRET = "made-up-secret-7f3a9c";
const PROBE = process.platform === "win32"
    ? { name: "powershell", args: { command: 'Write-Output "env=[$env:PS_PROBE_SECRET]"', description: "Print the probe variable" } }
    : { name: "bash", args: { command: 'echo "env=[$PS_PROBE_SECRET]"', description: "Print the probe variable" } };

/** The CLI's environment: this process's, without Copilot settings it may have inherited, so each run picks its own CLI. */
function cliEnv(home) {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.startsWith("COPILOT_")) env[name] = value;
    }
    return { ...env, COPILOT_HOME: home, PS_PROBE_SECRET: SECRET };
}

async function runProbe(secretNames) {
    const model = await startScriptedModel({
        respond: (_body, position) => (position.toolResults.length === 0 ? { tools: [PROBE] } : { content: "probed" }),
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-secret-"));
    const saved = process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
    if (secretNames) process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = secretNames;
    else delete process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
    const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" };
    const client = createCopilotClient({ env: cliEnv(home) }, provider);
    try {
        await client.start();
        const session = await client.createSession(withCliProgramSessionOptions({
            model: "fixture-model", provider, onPermissionRequest: approvePermissionForSession,
        }));
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the probe turn did not finish")), 90_000);
            session.on("session.idle", () => { clearTimeout(timer); resolve(); });
            session.on("session.error", (event) => { clearTimeout(timer); reject(new Error(event.data?.message ?? "session error")); });
            session.send({ prompt: "Run the probe." });
        });
        return {
            cliPath: String(client.resolvedCliPath ?? ""),
            output: model.requests.find((r) => r.position.toolResults.length > 0)?.position.toolResults.join("\n") ?? "",
            tools: (model.requests.find((r) => r.session)?.body.tools ?? []).map((t) => t.function?.name),
        };
    } finally {
        if (saved === undefined) delete process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
        else process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = saved;
        await client.stop().catch(() => {});
        await model.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

describe("CLI program secret environment variables", () => {
    it("with the setting, the program's shell gets no named variable, and no bundled skill is offered", { timeout: TIMEOUT }, async () => {
        const { cliPath, output, tools } = await runProbe("COPILOT_SDK_AUTH_TOKEN,PS_PROBE_SECRET");
        assert(/@github[\\/]copilot-[a-z0-9]+-[a-z0-9]+[\\/]copilot(\.exe)?$/.test(cliPath), `the CLI program ran: ${cliPath}`);
        assert(output.includes("env=[]"), `the shell had no PS_PROBE_SECRET: ${output}`);
        assert(!output.includes(SECRET), `nothing printed the value: ${output}`);
        assert(!tools.includes("skill"), `no bundled skill is offered: ${tools.join(", ")}`);
    });

    it("without it, the bundled runtime's shell gets the variable", { timeout: TIMEOUT }, async () => {
        const { cliPath, output } = await runProbe(undefined);
        assert(!/@github[\\/]copilot-[a-z0-9]+-[a-z0-9]+[\\/]copilot/.test(cliPath), `the bundled runtime ran: ${cliPath}`);
        assert(output.includes(`env=[${SECRET}]`), `the shell had PS_PROBE_SECRET: ${output}`);
    });
});
