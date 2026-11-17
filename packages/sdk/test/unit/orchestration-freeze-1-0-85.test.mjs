/**
 * Freezing 1.0.85 and opening 1.0.86 (owner routing; docs/proposals/windows-worker-pool.md, U18).
 *
 * 1.0.86 adds yields for owner-tagged sessions (a capacity request before each turn and before a
 * set-workspace check, a capped destroy and a capped workspace check), changes the busy policy for
 * sessions that ask for the fast one, and routes an owner-tagged session's activities with its owner
 * tag. So 1.0.85 (durable session titles) is frozen in orchestration_1_0_85/ and in-flight 1.0.85
 * sessions keep replaying on it. The frozen copy is the live tree of v0.8.12 with two kinds of
 * literal only, as 1.0.84's freeze: its version ("1.0.85") and its proxy routing contract
 * ("tool-composition-v1").
 *
 * Freeze obligation (formal binding): the frozen copy never imports the live contract constant
 * (orchestration/proxy-contract.ts). If the constant changes for a later version, the frozen 1.0.85
 * histories must keep routing exactly as they were recorded.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-85.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const SRC = new URL("../../src/", import.meta.url);
const FROZEN = "orchestration_1_0_85";
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const sha256 = text => createHash("sha256").update(text).digest("hex");
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

test("the registry keeps 1.0.85 frozen and registers 1.0.86 from the live tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.86");
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.85");
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].handler.name, "durableSessionOrchestration_1_0_85");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.deepEqual([latest.version, latest.handler.name], ["1.0.86", "durableSessionOrchestration_1_0_86"]);
    assert.notEqual(latest.handler, frozen[0].handler);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_85 \} from "\.\/orchestration_1_0_85\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_86 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.85", handler: durableSessionOrchestration_1_0_85 \}/);
    assert.match(registry, /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_86 \}/);
    assert.match(read("orchestration-version.ts"), /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.86";/);
});

test("frozen 1.0.85 names its version as a literal and continues as new to the live latest", () => {
    assert.match(read(`${FROZEN}/runtime.ts`), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.85";$/m);
    const index = read(`${FROZEN}/index.ts`);
    assert.match(index, /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    assert.match(index, /export function\* durableSessionOrchestration_1_0_85\(/);
});

test("freeze obligation: frozen 1.0.85 routes every proxy with the literal contract and never imports the live constant", () => {
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
                        assert.equal(node.arguments.length, 5, `${name}: a frozen 1.0.85 proxy takes no owner routing`);
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
    "agents.ts": "e9c916e083e747bd2c41298620f26152b15d2066a2d3e248b1847876a807742b",
    "index.ts": "7e629230c704423563c42a52097f2a6f2b96e261bc94611884c0b67a1abd1684",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "abc05df28b46e9f4bad90f57bb86734ab087512ba80885d4971e422979799b4d",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "630a8e805d53fd4d6b40f3b247048719e9ce28e374267ddc82f88beef3b8cb63",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "092f314f276ffa48d907d47a3225c8ed195d9af1b0a16d4261a97103e30e4b92",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a",
};

test("frozen 1.0.85 has exactly its files", () => {
    assert.deepEqual(tsFiles(FROZEN), Object.keys(frozenHashes).sort());
});

for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.85 ${name} remains unchanged`, () => {
        assert.equal(sha256(read(`${FROZEN}/${name}`)), hash);
    });
}

test("frozen 1.0.85 is frozen 1.0.84 but for the title lock (agents.ts), its header (index.ts) and its version (runtime.ts)", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_84"), tsFiles(FROZEN));
    const differing = tsFiles(FROZEN).filter(name => read(`orchestration_1_0_84/${name}`) !== read(`${FROZEN}/${name}`));
    assert.deepEqual(differing, ["agents.ts", "index.ts", "runtime.ts"]);
    assert.match(read(`${FROZEN}/agents.ts`), /\[result\.workspace \? true : undefined, result\.lockTitle\]/);
    assert.doesNotMatch(read("orchestration_1_0_84/agents.ts"), /lockTitle/);
});

/** The modules the frozen copy imports: shared ones and its own files, never the live orchestration or another version. */
const frozenImports = [
    "../activity-routing.js", "../child-notifications.js", "../cron-at.js", "../message-sender.js", "../orchestration-version.js",
    "../prompt-system-context.js", "../provider-budgets.js", "../session-list-timestamps.js", "../session-proxy.js",
    "../turn-control-contract.js", "../types.js", "../wait-affinity.js", "../workflow/agent-ids.js", "../workflow/intake.js",
    "../workspace-check.js",
    "./agents.js", "./intake-machine.js", "./intake-state.js", "./intake-wiring.js", "./lifecycle.js", "./queue.js",
    "./runtime.js", "./state.js", "./turn.js", "./utils.js", "./workflow-turn-failure.js",
    "node:crypto",
];

test("frozen 1.0.85 imports only shared modules and its own files", () => {
    const seen = new Set();
    for (const name of tsFiles(FROZEN)) {
        for (const specifier of importsOf(read(`${FROZEN}/${name}`))) {
            assert.ok(frozenImports.includes(specifier), `${name} imports ${specifier}`);
            seen.add(specifier);
        }
    }
    assert.deepEqual([...seen].sort(), [...frozenImports].sort());
});

test("only the registry imports the frozen 1.0.85 copy", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith(`${FROZEN}/`)) continue;
        for (const specifier of importsOf(read(path))) {
            if (specifier.includes(FROZEN)) assert.equal(path, "orchestration-registry.ts", `${path} imports ${specifier}`);
        }
    }
});

test("frozen 1.0.85 keeps the 1.0.85 routing and busy policy; 1.0.86 carries owner routing", () => {
    for (const name of Object.keys(frozenHashes)) {
        assert.doesNotMatch(read(`${FROZEN}/${name}`), /ownerTag|requestOwnerCapacity|workspaceBusyFastRelease|sessionRouting/, name);
    }
    const agents = read(`${FROZEN}/agents.ts`);
    assert.equal(agents.match(/yield runtime\.session\.destroy\(\);/g)?.length, 3, "complete, cancel and the failed shutdown destroy without a cap");
    assert.match(read(`${FROZEN}/turn.ts`), /if \(failures\.count >= 2 && state\.blobEnabled\) \{/);
    assert.match(read("orchestration/runtime.ts"),
        /createSessionProxy\(ctx, input\.sessionId, state\.affinityKey, state\.config, LIVE_SESSION_PROXY_CONTRACT, sessionRouting\(options\)\);/);
    assert.match(read("orchestration/turn.ts"), /const capacity = yield\* requestOwnerCapacity\(runtime\);/);
    assert.match(read("orchestration/agents.ts"), /\[result\.workspace \? true : undefined, result\.lockTitle, childRouting\]/);
});
