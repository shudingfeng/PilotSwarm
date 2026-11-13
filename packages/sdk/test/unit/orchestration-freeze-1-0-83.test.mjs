/**
 * Freezing 1.0.83 and opening 1.0.84 (owner routing; docs/proposals/windows-worker-pool.md, U18).
 *
 * 1.0.83 is the durable workflow intake as v0.8.11 released it. 1.0.84 adds
 * yields for owner-tagged sessions: a capacity request before each turn and
 * before a set-workspace check, a capped destroy, and a capped workspace
 * check. It also changes the busy policy for sessions that ask for the fast
 * one, and routes an owner-tagged session's activities with its owner tag.
 * So 1.0.83 is frozen in orchestration_1_0_83/ (the released live code with
 * only its version literal), in-flight 1.0.83 sessions keep replaying on it,
 * and each moves to 1.0.84 at its next continue-as-new.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-83.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const sha256 = text => createHash("sha256").update(text).digest("hex");
const tsFiles = dir => readdirSync(new URL(`${dir}/`, SRC)).filter(name => name.endsWith(".ts")).sort();

/** Every .ts file under src, as paths relative to src. */
function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

/** The module specifiers a source file imports: import/export ... from, a closing "} from", and import("...") types. */
function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

const LIVE_VERSION_LINE = "export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;";
const FROZEN_VERSION_LINE = 'export const CURRENT_ORCHESTRATION_VERSION = "1.0.83";';

test("the registry freezes 1.0.83 on its copy and registers 1.0.84, from the live tree, as the latest version", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.83");
    assert.equal(frozen.handler.name, "durableSessionOrchestration_1_0_83");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.82").handler.name, "durableSessionOrchestration_1_0_82");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.deepEqual([latest.version, latest.handler.name], ["1.0.84", "durableSessionOrchestration_1_0_84"]);
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.83").length, 1);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_83 \} from "\.\/orchestration_1_0_83\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_84 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.83", handler: durableSessionOrchestration_1_0_83 \}/);
    assert.match(registry, /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_84 \}/);
    assert.match(read("orchestration-version.ts"), /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.84";/);
});

test("the live tree names its version as the latest, never as a literal", () => {
    assert.equal(read("orchestration/runtime.ts").split(LIVE_VERSION_LINE).length, 2, "the live version line appears once");
    assert.ok(!read("orchestration/runtime.ts").includes(FROZEN_VERSION_LINE));
    assert.match(read("orchestration/index.ts"), /export function\* durableSessionOrchestration_1_0_84\(/);
});

test("frozen 1.0.83 names its version as a literal and continues as new to the live latest", () => {
    assert.match(read("orchestration_1_0_83/runtime.ts"), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.83";$/m);
    const index = read("orchestration_1_0_83/index.ts");
    assert.match(index, /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    assert.match(index, /export function\* durableSessionOrchestration_1_0_83\(/);
});

// Each file as v0.8.11 released orchestration/; runtime.ts with only its version literal.
const frozenHashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "65a5140f3fb8e0e1a8abed66824304720dbefaba66a4a26a2e12ddee197e984e",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "f61ea33b8e6c6799b6ccbc6733df09b027ce4434da5f912b55f93c46e39e7d27",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "9428b8c8dc162fbb99158a1c27241059b3bf5d9ab525493b99e15cf0807b428a",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "d576b28621965aee5cbcf49a0d7e4741714bb9fe6a7b681bbfd6ba2290795404",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a",
};

/** orchestration/runtime.ts as v0.8.11 released it, with the live version line. */
const RELEASED_RUNTIME_SHA256 = "d90acb08d1b303a4304a464249eeda85100981f3145f2cc66ff538dccd2cdda4";

test("frozen 1.0.83 has exactly its files", () => {
    assert.deepEqual(tsFiles("orchestration_1_0_83"), Object.keys(frozenHashes).sort());
});

for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.83 ${name} remains unchanged`, () => {
        assert.equal(sha256(read(`orchestration_1_0_83/${name}`)), hash);
    });
}

test("frozen 1.0.83's runtime.ts is the released one but for its version line", () => {
    const runtime = read("orchestration_1_0_83/runtime.ts");
    assert.equal(runtime.split(FROZEN_VERSION_LINE).length, 2);
    assert.equal(sha256(runtime.replace(FROZEN_VERSION_LINE, LIVE_VERSION_LINE)), RELEASED_RUNTIME_SHA256);
});

/** The modules the frozen copy imports: shared ones and its own files, never the live orchestration or another version. */
const frozenImports = [
    "../activity-routing.js", "../child-notifications.js", "../cron-at.js", "../message-sender.js", "../orchestration-version.js",
    "../prompt-system-context.js", "../provider-budgets.js", "../session-list-timestamps.js", "../session-proxy.js",
    "../turn-control-contract.js", "../types.js", "../wait-affinity.js", "../workflow/agent-ids.js", "../workflow/intake.js",
    "../workspace-check.js", "node:crypto",
    "./agents.js", "./intake-machine.js", "./intake-state.js", "./intake-wiring.js", "./lifecycle.js", "./queue.js", "./runtime.js",
    "./state.js", "./turn.js", "./utils.js", "./workflow-turn-failure.js",
];

test("frozen 1.0.83 imports only shared modules and its own files", () => {
    const seen = new Set();
    for (const name of tsFiles("orchestration_1_0_83")) {
        for (const specifier of importsOf(read(`orchestration_1_0_83/${name}`))) {
            assert.ok(frozenImports.includes(specifier), `${name} imports ${specifier}`);
            seen.add(specifier);
        }
    }
    assert.deepEqual([...seen].sort(), [...frozenImports].sort());
});

test("only the registry imports the frozen 1.0.83 copy", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith("orchestration_1_0_83/")) continue;
        for (const specifier of importsOf(read(path))) {
            if (specifier.includes("orchestration_1_0_83")) assert.equal(path, "orchestration-registry.ts", `${path} imports ${specifier}`);
        }
    }
});

test("frozen 1.0.83 keeps the 1.0.83 routing and busy policy; 1.0.84 carries owner routing", () => {
    for (const name of Object.keys(frozenHashes)) {
        assert.doesNotMatch(read(`orchestration_1_0_83/${name}`), /ownerTag|requestOwnerCapacity|workspaceBusyFastRelease|sessionRouting/, name);
    }
    assert.match(read("orchestration_1_0_83/runtime.ts"), /createSessionProxy\(ctx, input\.sessionId, state\.affinityKey, state\.config, "workflow-intake-v1"\);/);
    const agents = read("orchestration_1_0_83/agents.ts");
    assert.equal(agents.match(/yield runtime\.session\.destroy\(\);/g)?.length, 3, "complete, cancel and the failed shutdown destroy without a cap");
    assert.match(read("orchestration_1_0_83/turn.ts"), /if \(failures\.count >= 2 && state\.blobEnabled\) \{/);
    assert.match(read("orchestration/runtime.ts"), /createSessionProxy\(ctx, input\.sessionId, state\.affinityKey, state\.config, "workflow-intake-v1", sessionRouting\(options\)\);/);
    assert.match(read("orchestration/turn.ts"), /const capacity = yield\* requestOwnerCapacity\(runtime\);/);
});
