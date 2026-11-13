/**
 * PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS=1: the title generator's session, which
 * reads any user's conversation, offers the model no tool, refuses every
 * permission request and stays out of the CLI's cross-session store and
 * embedding cache. Runs the title activity with the real Copilot CLI against
 * the scripted model; needs no database.
 *
 * Run: npx vitest run test/local/title-session-tools.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, vi } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import { assert, assertEqual } from "../helpers/assertions.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerActivities } from "../../src/session-proxy.ts";

const TIMEOUT = 120_000;
const TITLE_PROMPT = "Write a short, specific title";

async function generateTitle(limitSetting) {
    const model = await startScriptedModel({
        respond: () => ({ content: "Billing Retry Refactor" }),
        respondAuxiliary: () => ({ content: "Billing Retry Refactor" }),
    });
    // The title client's CLI inherits this process's environment: keep its state out of the user's profile.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-title-tools-"));
    const saved = { limit: process.env.PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS, home: process.env.COPILOT_HOME };
    process.env.COPILOT_HOME = home;
    if (limitSetting === undefined) delete process.env.PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS;
    else process.env.PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS = limitSetting;
    const created = vi.spyOn(CopilotClient.prototype, "createSession");
    try {
        const handlers = new Map();
        const titles = [];
        const catalog = {
            getSession: async (sessionId) => ({ sessionId, title: "", isSystem: false }),
            getSessionEvents: async () => [{ eventType: "user.message", data: { content: "Refactor the retry logic of the billing service" } }],
            updateSession: async (_sessionId, patch) => { titles.push(patch.title); },
        };
        const sessionManager = {
            resolveDefaultProvider: () => ({
                modelName: "fixture-model",
                sdkProvider: { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic" },
            }),
        };
        registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) }, sessionManager, null, undefined, catalog);
        await handlers.get("summarizeSession")({ traceInfo() {} }, { sessionId: "title-tools-session" });
        const requests = model.requests.filter((r) => JSON.stringify(r.body.messages ?? []).includes(TITLE_PROMPT));
        return { titles, requests, sessionOptions: created.mock.calls.map(([options]) => options) };
    } finally {
        created.mockRestore();
        for (const [name, value] of [["PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS", saved.limit], ["COPILOT_HOME", saved.home]]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        await model.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

describe("title session tools", () => {
    it("with the limit, the title model is offered no tool and still writes the title", { timeout: TIMEOUT }, async () => {
        const { titles, requests, sessionOptions } = await generateTitle("1");
        assert(requests.length >= 1, "the title prompt reached the model");
        for (const request of requests) {
            assertEqual((request.body.tools ?? []).length, 0, `no tool offered: ${JSON.stringify((request.body.tools ?? []).map((t) => t.function?.name))}`);
        }
        assertEqual(sessionOptions.length, 1, "one title session");
        const [options] = sessionOptions;
        assertEqual(JSON.stringify(options.availableTools), "[]");
        assertEqual(options.enableSessionStore, false, "no cross-session store");
        assertEqual(options.skipEmbeddingRetrieval, true, "no shared embedding retrieval");
        for (const request of [{ kind: "shell", commands: [{ identifier: "ls" }] }, { kind: "write" }, { kind: "url" }]) {
            assertEqual(options.onPermissionRequest(request).kind, "reject", `refuses ${request.kind}`);
        }
        assertEqual(JSON.stringify(titles), JSON.stringify(["Billing Retry Refactor"]));
    });

    it("without it, the title session keeps the CLI's built-in tools", { timeout: TIMEOUT }, async () => {
        const { titles, requests, sessionOptions } = await generateTitle(undefined);
        assert(requests.length >= 1, "the title prompt reached the model");
        const names = (requests[0].body.tools ?? []).map((t) => t.function?.name);
        assert(names.length > 0, "the CLI offers its tools");
        const [options] = sessionOptions;
        for (const key of ["availableTools", "enableSessionStore", "skipEmbeddingRetrieval"]) {
            assert(!(key in options), `${key} is not passed`);
        }
        assertEqual(JSON.stringify(titles), JSON.stringify(["Billing Retry Refactor"]));
    });
});
