/**
 * PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS with the real Copilot CLI and the
 * scripted model. With the setting, a system session, the session it spawns
 * (owned by the system user, not marked system) and PilotSwarm's own system
 * agents offer the model exactly the tools PilotSwarm declares plus the CLI's
 * skill tool, and their Copilot sessions are created and resumed without the
 * CLI's cross-session store and embedding retrieval. Without the setting they
 * keep the CLI's built-in tools. An ordinary session keeps them either way.
 *
 * Run: npx vitest run test/local/system-session-tools.test.js
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from "../../src/index.ts";
import { SessionManager } from "../../src/session-manager.ts";

const TIMEOUT = 240_000;
const SETTING = "PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS";
const LIMITS = { availableTools: ["custom:*", "builtin:skill"], enableSessionStore: false, skipEmbeddingRetrieval: true };
const USER = { provider: "test", subject: "tool-limit-user", email: null, displayName: null };
const SHELLS = ["bash", "powershell"];
const MGMT_AGENTS_DIR = fileURLToPath(new URL("../../plugins/mgmt/agents", import.meta.url));

const getEnv = useSuiteEnv(import.meta.url);

async function withSetting(value, fn) {
    const previous = process.env[SETTING];
    if (value === undefined) delete process.env[SETTING];
    else process.env[SETTING] = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env[SETTING];
        else process.env[SETTING] = previous;
    }
}

/**
 * Record, per session, what SessionManager gives the Copilot SDK when it
 * creates or resumes the session: the names of the tools PilotSwarm declares,
 * and the options of LIMITS it sets. The patch is on the prototype so that
 * the system agents a worker starts at once are recorded too.
 */
async function recordingSessionConfigs(fn) {
    const configs = new Map();
    const record = (sessionId, config) => configs.set(sessionId, {
        tools: config.tools.map((tool) => tool.name),
        limits: Object.fromEntries(Object.keys(LIMITS).filter((key) => key in config).map((key) => [key, config[key]])),
    });
    const proto = SessionManager.prototype;
    const { _createCopilotSession: create, _resumeCopilotSession: resume } = proto;
    proto._createCopilotSession = function (client, config) {
        record(config.sessionId, config);
        return create.call(this, client, config);
    };
    proto._resumeCopilotSession = function (client, sessionId, config) {
        record(sessionId, config);
        return resume.call(this, client, sessionId, config);
    };
    try {
        return await fn(configs);
    } finally {
        proto._createCopilotSession = create;
        proto._resumeCopilotSession = resume;
    }
}

const hasUserText = (body, text) => (body.messages ?? []).some((m) => m?.role === "user" && messageText(m).includes(text));
const toolNames = (request) => request.body.tools.map((tool) => tool?.function?.name);

/** The first request of a session turn whose user messages carry `text`. */
async function firstRequestWith(model, text, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const request = model.sessionRequests().find((r) => hasUserText(r.body, text));
        if (request) return request;
        if (Date.now() > deadline) throw new Error(`no model request carried "${text}"`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

/**
 * For each [prompt, task] pair, the first step after the prompt spawns a
 * child with that task. Every other request answers "ok".
 */
function spawnAfter(pairs) {
    return (body) => {
        const messages = body.messages ?? [];
        for (const [prompt, task] of pairs) {
            const at = messages.findLastIndex((m) => m?.role === "user" && messageText(m).includes(prompt));
            if (at >= 0 && !messages.slice(at + 1).some((m) => m?.role === "assistant")) {
                return { tools: [{ name: "spawn_agent", args: { task } }] };
            }
        }
        return { content: "ok" };
    };
}

/** The limits set on create or resume, and exactly PilotSwarm's declared tools plus skill offered. */
function expectLimited({ offered, tools, limits }, label) {
    expect(limits, label).toEqual(LIMITS);
    expect(tools.length, `${label}: PilotSwarm declared its tools`).toBeGreaterThan(0);
    expect([...offered].sort(), label).toEqual([...new Set([...tools, "skill"])].sort());
}

/** No limit set, and PilotSwarm's tools plus the CLI's own offered. */
function expectBuiltIns({ offered, tools, limits }, label) {
    expect(limits, label).toEqual({});
    expect(offered, label).toEqual(expect.arrayContaining(tools));
    expect(offered.some((name) => SHELLS.includes(name)), `${label}: a shell tool`).toBe(true);
    expect(offered, label).toEqual(expect.arrayContaining(["view", "create", "edit", "web_fetch"]));
}

describe("system session tool limit", () => {
    it("limits a system session and the session it spawns, and leaves an ordinary session alone", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const phases = ["off", "on"].map((phase) => ({
            phase,
            setting: phase === "on" ? "1" : undefined,
            systemPrompt: `system session prompt ${phase}-${env.runId}`,
            childTask: `child session task ${phase}-${env.runId}`,
            userPrompt: `user session prompt ${phase}-${env.runId}`,
        }));
        const runs = {};
        let systemSessionId;
        await recordingSessionConfigs((configs) => withScriptedModel(env, {
            respond: spawnAfter(phases.map((p) => [p.systemPrompt, p.childTask])),
        }, async ({ client, model, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            try {
                const system = await client.createSystemSession({ model: qualifiedModel, title: "Tool limit system session" });
                const user = await client.createSession({ model: qualifiedModel, owner: USER });
                systemSessionId = system.sessionId;
                const seen = (sessionId, request) => ({ offered: toolNames(request), ...configs.get(sessionId) });
                // The same system and user sessions run a turn in each phase.
                for (const p of phases) {
                    await withSetting(p.setting, async () => {
                        await system.sendAndWait(p.systemPrompt, TIMEOUT);
                        const systemRequest = await firstRequestWith(model, p.systemPrompt);
                        const childRequest = await firstRequestWith(model, p.childTask);
                        const childRow = (await catalog.listSessions()).find((row) => row.parentSessionId === system.sessionId
                            && !Object.values(runs).some((run) => run.childRow.sessionId === row.sessionId));
                        await user.sendAndWait(p.userPrompt, TIMEOUT);
                        const userRequest = await firstRequestWith(model, p.userPrompt);
                        runs[p.phase] = {
                            childRow,
                            system: seen(system.sessionId, systemRequest),
                            child: seen(childRow.sessionId, childRequest),
                            user: seen(user.sessionId, userRequest),
                        };
                    });
                    for (const kind of ["system", "child", "user"]) {
                        console.log(`[tool-limit] setting ${p.phase}, ${kind} offered: ${runs[p.phase][kind].offered.join(", ")}`);
                    }
                }
            } finally {
                await catalog.close();
            }
        }));

        const { off, on } = runs;
        for (const run of [off, on]) {
            expect(run.childRow).toMatchObject({ isSystem: false, owner: { provider: "system", subject: "system" }, rootSessionId: systemSessionId });
        }
        expectBuiltIns(off.system, "system session without the setting");
        expectBuiltIns(off.child, "child without the setting");
        expect(off.child.offered, "the child has native tasks without the setting").toContain("task");
        expectLimited(on.system, "system session with the setting");
        expectLimited(on.child, "child with the setting");
        for (const run of [off, on]) {
            expectBuiltIns(run.user, "ordinary session");
            expect(run.user.offered).toContain("task");
        }
        expect(on.user.offered).toEqual(off.user.offered);
    });

    it("with the setting, PilotSwarm's own system agents get only their PilotSwarm tools and skill", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const agents = loadAgentFiles(MGMT_AGENTS_DIR).filter((agent) => agent.system);
        expect(agents.map((agent) => agent.id).sort()).toEqual(["facts-manager", "pilotswarm", "resourcemgr", "sweeper", "token-manager"]);
        const rootId = systemAgentUUID("pilotswarm");
        await withSetting("1", () => recordingSessionConfigs((configs) => withScriptedModel(env, {
            worker: { disableManagementAgents: false },
        }, async ({ model }) => {
            for (const agent of agents) {
                const opening = agent.initialPrompt.replace(/\s+/g, " ").trim().slice(0, 60);
                const offered = toolNames(await firstRequestWith(model, opening));
                const sessionId = agent.id === "pilotswarm" ? rootId : systemChildAgentUUID(rootId, agent.id);
                console.log(`[tool-limit] ${agent.id} offered: ${offered.join(", ")}`);
                expectLimited({ offered, ...configs.get(sessionId) }, agent.id);
            }
        })));
    });
});
