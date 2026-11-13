/**
 * A fine-grained GitHub token, live, as the proposal observed: GitHub reports
 * its expiry (`GitHub-Authentication-Token-Expiration`), the gate that
 * PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT turns on accepts it, and a turn on
 * GitHub Copilot completes with it through the Copilot CLI program, as on a
 * Windows worker.
 *
 * Create the token with only the Copilot Requests account permission, access
 * to public repositories only, and an expiry within 30 days, then put it in
 * PS_TEST_FINE_GRAINED_GH_PAT. The test is skipped without it: a variable of
 * its own, so a full test run never sends a token by accident. It never
 * prints the token. The model is the test catalog's default GitHub Copilot
 * model, or PS_TEST_FINE_GRAINED_GH_MODEL.
 *
 * Run: PS_TEST_FINE_GRAINED_GH_PAT=github_pat_... npx vitest run test/local/fine-grained-token-live.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { assert } from "../helpers/assertions.js";
import { cliProgramMissing } from "../helpers/cli-program.mjs";
import { createCopilotClient, withCliProgramSessionOptions } from "../../src/copilot-client.ts";
import { checkFineGrainedGitHubToken } from "../../src/provider-store.ts";
import { approvePermissionForSession } from "../../src/permissions.ts";

const TIMEOUT = 240_000;
const TOKEN = process.env.PS_TEST_FINE_GRAINED_GH_PAT?.trim() ?? "";
const SKIP = !TOKEN
    ? "PS_TEST_FINE_GRAINED_GH_PAT is not set"
    : cliProgramMissing();
const DAY_MS = 24 * 60 * 60 * 1000;

/** The test catalog's default model when it is a GitHub Copilot one, else its first GitHub Copilot model. */
function githubModel() {
    if (process.env.PS_TEST_FINE_GRAINED_GH_MODEL?.trim()) return process.env.PS_TEST_FINE_GRAINED_GH_MODEL.trim();
    const catalogFile = process.env.PS_MODEL_PROVIDERS_PATH
        || fileURLToPath(new URL("../fixtures/model-providers.test.json", import.meta.url));
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    const github = catalog.providers.filter((provider) => provider.type === "github");
    const [providerId, modelName] = String(catalog.defaultModel ?? "").split(/:(.*)/s);
    if (github.some((provider) => provider.id === providerId) && modelName) return modelName;
    const first = github[0]?.models?.[0];
    return typeof first === "string" ? first : first?.name;
}

/** Text with the token cut out, for messages. */
const hidden = (text) => String(text).split(TOKEN).join("<token>");

describe("a fine-grained GitHub token, live", () => {
    it("GitHub reports its expiry, the gate accepts it, and a turn on GitHub Copilot completes with it", { timeout: TIMEOUT }, async (ctx) => {
        ctx.skip(Boolean(SKIP), SKIP);
        assert(TOKEN.startsWith("github_pat_"), "PS_TEST_FINE_GRAINED_GH_PAT holds a fine-grained token (github_pat_)");

        const user = await fetch("https://api.github.com/user", {
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}`, "User-Agent": "PilotSwarm-test" },
        });
        await user.body?.cancel();
        assert(user.ok, `GET /user answered HTTP ${user.status}`);
        assert(user.headers.get("github-authentication-token-expiration"), "GET /user reports the token's expiry");

        let expiresOn;
        try {
            ({ expiresOn } = await checkFineGrainedGitHubToken(TOKEN));
        } catch (error) {
            assert(false, `the fine-grained token gate refused the token: ${hidden(error?.message ?? error)}`);
        }
        const left = Date.parse(expiresOn) - Date.now();
        assert(left > 0 && left <= 30 * DAY_MS, `the token expires within 30 days: ${expiresOn}`);

        const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-fine-grained-live-"));
        const env = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined && !name.startsWith("COPILOT_") && !["GITHUB_TOKEN", "GH_TOKEN"].includes(name)) env[name] = value;
        }
        const saved = process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
        process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = "COPILOT_SDK_AUTH_TOKEN";
        const client = createCopilotClient({ gitHubToken: TOKEN, env: { ...env, COPILOT_HOME: home } });
        try {
            await client.start();
            const session = await client.createSession(withCliProgramSessionOptions({
                model: githubModel(), availableTools: [], onPermissionRequest: approvePermissionForSession,
            }));
            const reply = await session.sendAndWait({ prompt: "Reply with the single word: ready." }, 180_000);
            assert(String(reply?.data?.content ?? "").trim().length > 0, "the turn completed with a reply");
        } catch (error) {
            assert(false, `the turn failed: ${hidden(error?.message ?? error)}`);
        } finally {
            if (saved === undefined) delete process.env.PILOTSWARM_CLI_SECRET_ENV_VARS;
            else process.env.PILOTSWARM_CLI_SECRET_ENV_VARS = saved;
            await client.stop().catch(() => {});
            fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });
});
