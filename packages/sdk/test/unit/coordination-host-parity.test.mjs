/**
 * The coordination host loads only the deployment plugin's definitions:
 * plugin.json, session-policy.json and agents/, without the deployment's
 * tool module and MCP servers. Owner-only workers send getWorkerSessionPolicy
 * and resolveAgentConfig there, so both must answer there exactly as on a
 * worker that loads the whole plugin.
 *
 * Each worker loads its plugin folder with the real loader (the worker's
 * constructor), the full worker's tool module goes through the real extension
 * module loader, and the activities are the real ones, registered with the
 * values start() passes to registerActivities.
 *
 * Run: node --test test/unit/coordination-host-parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionModules } from "../../dist/extension-modules.js";
import { registerActivities } from "../../dist/session-proxy.js";
import { PilotSwarmWorker } from "../../dist/worker.js";

const SESSION_POLICY = {
    version: 1,
    creation: { mode: "allowlist", allowGeneric: false, defaultAgent: "builder" },
    deletion: { protectSystem: true },
};

const AGENTS = {
    "default.agent.md": `---
schemaVersion: 1
version: 1.0.0
name: default
tools:
  - deploy_status
---

You work for this deployment. Check a deployment's status before you change it.
`,
    "builder.agent.md": `---
schemaVersion: 2
version: 1.2.0
name: builder
title: Builder
id: builder
description: Builds and ships the deployment's services.
tools:
  - deploy_status
  - start_build
mcpServers:
  - docs
inheritDefaultMcpServers: true
initialPrompt: >
  Say which services you can build, then ask which one to ship.
splash: "{bold}Builder{/bold}"
---

# Builder

You build the deployment's services and report each build's result.
`,
    "reviewer.agent.md": `---
schemaVersion: 1
version: 1.0.0
name: reviewer
title: Reviewer
description: Reviews a build before it ships.
tools:
  - deploy_status
---

You review builds. Never ship one yourself.
`,
    "watcher.agent.md": `---
schemaVersion: 1
version: 1.0.0
name: watcher
title: Watcher
id: watcher
system: true
parent: pilotswarm
description: Watches the deployment's services.
tools:
  - deploy_status
---

You watch the deployment's services and report outages.
`,
};

const TOOL_MODULE = `export function register(worker) {
    worker.registerTools([{
        name: "deploy_status",
        description: "The status of a deployment.",
        parameters: { type: "object", properties: { service: { type: "string" } } },
        handler: async () => "healthy",
    }]);
}
`;

const MCP_SERVERS = {
    docs: { type: "http", url: "https://docs.example.test/mcp", tools: ["*"] },
    search: { command: "node", args: ["search-server.js"], tools: ["*"], default: true },
};

/** The deployment plugin as a worker that runs its tools has it, and the definitions alone, as the coordination host has them. */
function writePlugins(root) {
    const full = join(root, "full");
    mkdirSync(join(full, "agents"), { recursive: true });
    writeFileSync(join(full, "plugin.json"), JSON.stringify({ name: "deployment-plugin", version: "1.0.0", agents: "agents/" }, null, 2));
    writeFileSync(join(full, "session-policy.json"), JSON.stringify(SESSION_POLICY, null, 2));
    for (const [file, text] of Object.entries(AGENTS)) writeFileSync(join(full, "agents", file), text);
    writeFileSync(join(full, ".mcp.json"), JSON.stringify(MCP_SERVERS, null, 2));
    writeFileSync(join(full, "tools.mjs"), TOOL_MODULE);

    const definitions = join(root, "definitions");
    mkdirSync(definitions);
    for (const entry of ["plugin.json", "session-policy.json", "agents"]) {
        cpSync(join(full, entry), join(definitions, entry), { recursive: true });
    }
    return { full, definitions };
}

/** The worker's getWorkerSessionPolicy and resolveAgentConfig activities, registered with what start() passes them. */
function activitiesOf(worker) {
    assert.ok(Array.isArray(worker._rawLoadedAgents), "start() registers the activities with the worker's loaded agents");
    const handlers = new Map();
    const catalog = { getSession: async (sessionId) => ({ sessionId, owner: { provider: "test", subject: "alice" }, parentSessionId: null }) };
    registerActivities(
        { registerActivity: (name, handler) => handlers.set(name, handler) },
        worker.sessionManager, null, undefined, catalog, undefined, undefined, undefined, undefined,
        worker.systemAgents, worker.sessionPolicy, worker.allowedAgentNames, worker._rawLoadedAgents,
    );
    const ctx = { traceInfo() {} };
    return (name, input) => handlers.get(name)(ctx, input);
}

test("getWorkerSessionPolicy and resolveAgentConfig answer from the plugin's definitions alone as from the whole plugin", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-coordination-parity-"));
    const workers = [];
    t.after(async () => {
        for (const worker of workers) await worker.sessionManager.shutdown();
        rmSync(root, { recursive: true, force: true });
    });
    const plugins = writePlugins(root);
    const full = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions-full"), pluginDirs: [plugins.full] });
    const definitions = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions-definitions"), pluginDirs: [plugins.definitions] });
    workers.push(full, definitions);

    // The whole plugin: its tool module and MCP servers are loaded, and the
    // coordination host has neither.
    const registered = [];
    const registerTools = full.registerTools.bind(full);
    full.registerTools = (tools) => {
        registered.push(...tools.map((tool) => tool.name));
        registerTools(tools);
    };
    await loadExtensionModules(full, [join(plugins.full, "tools.mjs")]);
    assert.deepEqual(registered, ["deploy_status"]);
    assert.deepEqual(Object.keys(full.loadedMcpServers).sort(), ["docs", "search"]);
    assert.deepEqual(Object.keys(definitions.loadedMcpServers), []);
    assert.deepEqual(Object.keys(full.loadedAgents.find((agent) => agent.name === "builder").mcpServers ?? {}).sort(), ["docs", "search"]);
    assert.equal(definitions.loadedAgents.find((agent) => agent.name === "builder").mcpServers, undefined);

    const onFull = activitiesOf(full);
    const onHost = activitiesOf(definitions);

    const policy = await onHost("getWorkerSessionPolicy", {});
    assert.deepEqual(policy, await onFull("getWorkerSessionPolicy", {}));
    assert.deepEqual(policy.policy, SESSION_POLICY);
    for (const name of ["builder", "reviewer"]) assert.ok(policy.allowedAgentNames.includes(name), name);
    assert.ok(!policy.allowedAgentNames.includes("watcher"), "a system agent is not created by name");

    const names = new Set([
        ...full.allowedAgentNames, ...full.systemAgents.map((agent) => agent.name),
        ...definitions.allowedAgentNames, ...definitions.systemAgents.map((agent) => agent.name),
        "Builder", "builder agent", "deployment-plugin:builder", "__shared:builder", "Watcher", "sweeper", "missing-agent",
    ]);
    let resolved = 0;
    for (const agentName of names) {
        for (const activity of ["resolveAgentConfig", "resolveAgentConfigV2"]) {
            for (const binding of [undefined, { source: "deployment" }]) {
                const input = { agentName, callerSessionId: "caller", ...(binding ? { binding } : {}) };
                const answer = await onHost(activity, input);
                assert.deepEqual(answer, await onFull(activity, input), `${activity} ${JSON.stringify(input)}`);
                if (answer) resolved += 1;
            }
        }
    }
    assert.ok(resolved > 0);
    const builder = await onHost("resolveAgentConfig", { agentName: "builder", callerSessionId: "caller" });
    assert.equal(builder.namespace, "deployment-plugin");
    assert.deepEqual(builder.tools, ["deploy_status", "start_build"], "the definition's tools, whether or not this worker registers them");
    assert.match(builder.prompt, /report each build's result/);
    assert.equal((await onHost("resolveAgentConfig", { agentName: "watcher", callerSessionId: "caller" })).creatable, false);
    assert.equal(await onHost("resolveAgentConfig", { agentName: "missing-agent", callerSessionId: "caller" }), null);

    for (const activity of ["resolveAgentForRequiredTool", "resolveAgentForRequiredToolV2"]) {
        for (const requiredTool of ["start_build", "deploy_status", "missing_tool"]) {
            const input = { requiredTool, callerSessionId: "caller" };
            assert.deepEqual(await onHost(activity, input), await onFull(activity, input), `${activity} ${requiredTool}`);
        }
    }
});

test("a skills folder is part of the definitions: without it, an agent that declares a skill resolves to another prompt, and nothing else differs", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-coordination-parity-skills-"));
    const workers = [];
    t.after(async () => {
        for (const worker of workers) await worker.sessionManager.shutdown();
        rmSync(root, { recursive: true, force: true });
    });
    const plugins = writePlugins(root);
    const skill = join(plugins.full, "skills", "release-notes");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: release-notes\ndescription: Writes a build's release notes.\n---\n\nList every change since the last build.\n");
    writeFileSync(join(plugins.full, "agents", "builder.agent.md"), AGENTS["builder.agent.md"].replace("inheritDefaultMcpServers: true\n", "inheritDefaultMcpServers: true\nskills:\n  - release-notes\n"));
    cpSync(join(plugins.full, "agents"), join(plugins.definitions, "agents"), { recursive: true });

    const full = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions-full"), pluginDirs: [plugins.full] });
    const definitions = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions-definitions"), pluginDirs: [plugins.definitions] });
    workers.push(full, definitions);
    const input = { agentName: "builder", callerSessionId: "caller" };
    const withSkill = await activitiesOf(full)("resolveAgentConfig", input);
    assert.match(withSkill.prompt, /List every change since the last build/);
    const { prompt: promptWithout, ...without } = await activitiesOf(definitions)("resolveAgentConfig", input);
    const { prompt: promptWith, ...rest } = withSkill;
    assert.notEqual(promptWithout, promptWith);
    assert.deepEqual(without, rest, "the tools, names and first prompt the orchestration reads stay the same");

    cpSync(join(plugins.full, "skills"), join(plugins.definitions, "skills"), { recursive: true });
    const withSkills = new PilotSwarmWorker({ sessionStateDir: join(root, "sessions-skills"), pluginDirs: [plugins.definitions] });
    workers.push(withSkills);
    assert.deepEqual(await activitiesOf(withSkills)("resolveAgentConfig", input), withSkill);
});
