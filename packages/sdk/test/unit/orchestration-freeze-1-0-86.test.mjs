/**
 * Freezing upstream's 1.0.86 and opening this fork's 1.0.1000.
 *
 * Upstream's 1.0.86 (a spawned child's workspace selection, release 0.8.13) is frozen in
 * orchestration_1_0_86/, so in-flight 1.0.86 sessions keep replaying on it. The live tree,
 * orchestration/, is this fork's 1.0.1000: upstream's 1.0.86 plus owner routing, with
 * FORK_ORCHESTRATION_BASES naming 1.0.86 as its base. This fork ran its owner routing under
 * the provisional number 1.0.86 before upstream took that number; only throwaway test data
 * ran it, and it is no longer registered, so no fork handler keeps a number upstream uses.
 *
 * The frozen copy is upstream's live tree of release 0.8.13 (tag v0.8.13), frozen the way
 * upstream froze 1.0.85: only its version ("1.0.86") and its proxy routing contract
 * ("tool-composition-v1") are literals, its header says it is frozen, and it has no
 * proxy-contract.ts.
 *
 * Freeze obligation (formal binding): the frozen copy never imports the live contract
 * constant (orchestration/proxy-contract.ts). If the constant changes for a later
 * version, the frozen 1.0.86 histories must keep routing exactly as they were recorded.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-86.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { FORK_ORCHESTRATION_BASES } from "../../dist/orchestration-version.js";
import { handleSubAgentAction as frozenSpawn } from "../../dist/orchestration_1_0_86/agents.js";
import { handleSubAgentAction as liveSpawn } from "../../dist/orchestration/agents.js";
import * as frozenTree from "../../dist/orchestration_1_0_86/index.js";
import * as liveTree from "../../dist/orchestration/index.js";

const SRC = new URL("../../src/", import.meta.url);
const FROZEN = "orchestration_1_0_86";
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const tsFiles = dir => readdirSync(new URL(`${dir}/`, SRC)).filter(name => name.endsWith(".ts")).sort();

function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

test("the registry keeps upstream's 1.0.86 frozen and registers this fork's 1.0.1000, on 1.0.86, from the live tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.1000");
    assert.deepEqual({ ...FORK_ORCHESTRATION_BASES }, { "1.0.1000": "1.0.86" });
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.86");
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].handler, frozenTree.durableSessionOrchestration_1_0_86);
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.deepEqual([latest.version, latest.handler.name], ["1.0.1000", "durableSessionOrchestration_1_0_1000"]);
    assert.equal(latest.handler, liveTree.durableSessionOrchestration_1_0_1000);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-2), frozen[0], "1.0.86 is the version before the latest");
    // The provisional 1.0.86 (owner routing on 1.0.85) is gone: the live tree exports no 1.0.86 handler.
    assert.equal("durableSessionOrchestration_1_0_86" in liveTree, false);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_86 \} from "\.\/orchestration_1_0_86\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_1000 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.86", handler: durableSessionOrchestration_1_0_86 \}/);
    assert.match(registry, /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_1000 \}/);
    assert.ok(read("orchestration-version.ts").includes('export const DURABLE_SESSION_LATEST_VERSION = "1.0.1000";'));
});

test("frozen 1.0.86 names its version as a literal and continues as new to the live latest", () => {
    assert.match(read(`${FROZEN}/runtime.ts`), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.86";$/m);
    const index = read(`${FROZEN}/index.ts`);
    assert.match(index, /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    assert.match(index, /export function\* durableSessionOrchestration_1_0_86\(/);
    assert.match(index, / \* Frozen: this is the 1\.0\.86 tree of release 0\.8\.13\.\n/);
});

test("freeze obligation: frozen 1.0.86 routes every proxy with the literal contract and never imports the live constant", () => {
    let proxies = 0;
    for (const name of tsFiles(FROZEN)) {
        const text = read(`${FROZEN}/${name}`);
        assert.doesNotMatch(text, /LIVE_SESSION_PROXY_CONTRACT/, `${name} names the live contract constant`);
        assert.ok(!importsOf(text).some(specifier => specifier.includes("proxy-contract")), `${name} imports proxy-contract`);
        const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const argumentIndex = node.expression.text === "createSessionProxy" ? 4
                    : node.expression.text === "createSessionManagerProxy" ? 1 : null;
                if (argumentIndex !== null) {
                    proxies++;
                    assert.equal(node.arguments[argumentIndex]?.getText(source), "\"tool-composition-v1\"",
                        `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
                    if (node.expression.text === "createSessionProxy") {
                        assert.equal(node.arguments.length, 5, `${name}: a frozen 1.0.86 proxy takes no owner routing`);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    assert.equal(proxies, 8, "seven session proxies and one manager proxy");
});

const frozenHashes = {
    "agents.ts": "7f70aad5f7a690e735a7d89a279080a9aa4eb1f43bfd62dc294eab89489fad9c",
    "index.ts": "475aacba58f7439dbf8c4b8e67aed2fcf839ef520ae24956e3c2c2263e7a4435",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "abc05df28b46e9f4bad90f57bb86734ab087512ba80885d4971e422979799b4d",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "81c0a8e9a7149a99f1a83305ad773dda67bf0b70d2ec8b3e7fa4a232d03f0cf9",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "092f314f276ffa48d907d47a3225c8ed195d9af1b0a16d4261a97103e30e4b92",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a",
};

test("frozen 1.0.86 has exactly its files", () => {
    assert.deepEqual(tsFiles(FROZEN), Object.keys(frozenHashes).sort());
    assert.deepEqual(tsFiles("orchestration"), [...tsFiles(FROZEN), "proxy-contract.ts"].sort());
});

for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.86 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`${FROZEN}/${name}`)).digest("hex"), hash);
    });
}

test("frozen 1.0.86 is frozen 1.0.85 but for the spawn's workspace selection (agents.ts), its header (index.ts) and its version (runtime.ts)", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_85"), tsFiles(FROZEN));
    const differing = tsFiles(FROZEN).filter(name => read(`orchestration_1_0_85/${name}`) !== read(`${FROZEN}/${name}`));
    assert.deepEqual(differing, ["agents.ts", "index.ts", "runtime.ts"]);
    assert.match(read(`${FROZEN}/agents.ts`), /childConfig = applySessionWorkspaceSelection\(childConfig, result\.workspace, result\.workspaceInherited === true\);/);
    assert.doesNotMatch(read("orchestration_1_0_85/agents.ts"), /applySessionWorkspaceSelection/);
});

test("frozen 1.0.86 keeps upstream's routing and busy policy; only the live 1.0.1000 has this fork's owner routing", () => {
    for (const name of Object.keys(frozenHashes)) {
        assert.doesNotMatch(read(`${FROZEN}/${name}`), /ownerTag|requestOwnerCapacity|workspaceBusyFastRelease|sessionRouting/, name);
    }
    const agents = read(`${FROZEN}/agents.ts`);
    assert.equal(agents.match(/yield runtime\.session\.destroy\(\);/g)?.length, 3, "complete, cancel and the failed shutdown destroy without a cap");
    assert.match(read(`${FROZEN}/turn.ts`), /if \(failures\.count >= 2 && state\.blobEnabled\) \{/);
    // The live tree is where owner routing lives.
    assert.match(read("orchestration/turn.ts"), /requestOwnerCapacity/);
    assert.match(read("orchestration/state.ts"), /export function sessionRouting\(/);
    assert.match(read("orchestration/agents.ts"), /const childRouting = agentIsSystem \? undefined : createdSessionRouting\(runtime\.options\);/);
});

/** The modules the frozen copy imports: shared ones and its own files, never the live orchestration or another version. */
const frozenImports = [
    "../activity-routing.js", "../child-notifications.js", "../cron-at.js", "../message-sender.js", "../orchestration-version.js",
    "../prompt-system-context.js", "../provider-budgets.js", "../session-list-timestamps.js", "../session-proxy.js",
    "../turn-control-contract.js", "../types.js", "../wait-affinity.js", "../workflow/agent-ids.js", "../workflow/intake.js",
    "../workspace-check.js", "../workspace.js",
    "./agents.js", "./intake-machine.js", "./intake-state.js", "./intake-wiring.js", "./lifecycle.js", "./queue.js",
    "./runtime.js", "./state.js", "./turn.js", "./utils.js", "./workflow-turn-failure.js",
    "node:crypto",
];

test("frozen 1.0.86 imports only shared modules and its own files", () => {
    const seen = new Set();
    for (const name of tsFiles(FROZEN)) {
        for (const specifier of importsOf(read(`${FROZEN}/${name}`))) {
            assert.ok(frozenImports.includes(specifier), `${name} imports ${specifier}`);
            seen.add(specifier);
        }
    }
    assert.deepEqual([...seen].sort(), [...frozenImports].sort());
});

test("only the registry imports the frozen 1.0.86 copy", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith(`${FROZEN}/`)) continue;
        for (const specifier of importsOf(read(path))) {
            if (specifier.includes(FROZEN)) assert.equal(path, "orchestration-registry.ts", `${path} imports ${specifier}`);
        }
    }
});

// ─── Replay: what a spawn passes to its activities ───────────────────────────
//
// A spawn handled by the orchestration schedules captureSpawnTools and then
// spawnChildSession, whose arguments Duroxide compares on replay. The digests below
// were recorded with frozen 1.0.86, whose agents.ts is byte-identical to upstream's
// live agents.ts at tag v0.8.13, in the cases of orchestration-freeze-1-0-85.test.mjs.
// For an untagged session the live 1.0.1000 schedules the same bytes; for an
// owner-tagged one, the child's routing is added after the title lock.

/** Drive one spawn and return the arguments of the two activities it schedules. */
function spawnInputs(handler, config, action, options = { nestingLevel: 1 }) {
    const calls = {};
    const runtime = {
        ctx: { traceInfo() {} },
        state: { config: structuredClone(config), subAgents: [], transcriptEpoch: 3, workspaceRevision: 2, iteration: 7 },
        options,
        input: { sessionId: "parent-session" },
        session: { captureSpawnTools: (...args) => { calls.captureSpawnTools = structuredClone(args); return { activity: "captureSpawnTools" }; } },
        manager: { spawnChildSession: (...args) => { calls.spawnChildSession = structuredClone(args); return { activity: "spawnChildSession" }; } },
    };
    const generator = handler(runtime, structuredClone(action));
    assert.deepEqual(generator.next().value, { activity: "captureSpawnTools" });
    assert.deepEqual(generator.next({}).value, { activity: "spawnChildSession" });
    return calls;
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const recorded = {
    "a Workflow agent step's session spawns a sub-agent that inherits the workspace": {
        config: { model: "parent:model", workflowInsideWorkflow: true, workspace: { root: "repo", folder: "main" }, systemMessage: "PARENT PERSONA" },
        action: { type: "spawn_agent", task: "Inspect the failing test", lockTitle: false },
        v0813: "8c375af491fb46f47488407bf1af93ad30d70d629b80ee68224cd92653e9c626",
    },
    "a session with a working directory spawns a sub-agent with its own workspace record": {
        config: { model: "parent:model", workingDirectory: "/work/parent", workspaceDefaults: { workingFolder: null, extra: [] } },
        action: { type: "spawn_agent", task: "Review the proposal", lockTitle: false, workspace: { root: "repo", folder: "review" } },
        v0813: "db5d4f234f139b61dce68e60e2f8d157015fd63e9cc2624aac8c193e634dc64e",
    },
    "a session with a working directory clears the record for its sub-agent": {
        config: { model: "parent:model", workingDirectory: "/work/parent", workspace: { root: "repo", folder: "main" } },
        action: { type: "spawn_agent", task: "Summarize", lockTitle: false, workspace: null },
        v0813: "4342f927b7410460bd25c80386ce241a1cce51e91258a2510009d8eb3af3bd9a",
    },
};

const OWNER = "owner.0b7c6f53-4d3e-4c0f-9f4e-2f6c1f0a9d11";

for (const [name, { config, action, v0813 }] of Object.entries(recorded)) {
    test(`replay: ${name}: frozen 1.0.86 schedules the recorded inputs, and so does 1.0.1000 for an untagged session`, () => {
        assert.equal(digest(spawnInputs(frozenSpawn, config, action)), v0813, "frozen 1.0.86 differs from its recording");
        assert.equal(digest(spawnInputs(liveSpawn, config, action)), v0813, "1.0.1000 changes an untagged session's spawn");
        const tagged = spawnInputs(liveSpawn, config, action, { nestingLevel: 1, ownerTag: OWNER, workspaceBusyFastRelease: true });
        const untagged = spawnInputs(frozenSpawn, config, action);
        assert.deepEqual(tagged.captureSpawnTools, untagged.captureSpawnTools);
        assert.deepEqual(tagged.spawnChildSession.slice(0, -1), untagged.spawnChildSession, "the child's routing comes after the title lock");
        assert.deepEqual(tagged.spawnChildSession.at(-1), { ownerTag: OWNER, workspaceBusyFastRelease: true });
    });
}
