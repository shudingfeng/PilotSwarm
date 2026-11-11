/**
 * Freezing 1.0.82 and opening 1.0.83 (owner routing).
 *
 * 1.0.83 adds yields for owner-tagged sessions: a capacity request before
 * each turn and before a set-workspace check, a capped destroy, and a capped
 * workspace check. It also changes the busy policy for sessions that ask for
 * the fast one. So 1.0.82 is frozen, and in-flight 1.0.82 sessions keep
 * replaying on the frozen copy.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-82.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("registry freezes 1.0.82 and activates a separate 1.0.83 handler", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.82").handler.name, "durableSessionOrchestration_1_0_82");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.83");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler.name, "durableSessionOrchestration_1_0_83");
    assert.match(read("orchestration-registry.ts"), /from "\.\/orchestration_1_0_82\/index\.js"/);
    assert.match(read("orchestration_1_0_82/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.82"/);
    assert.match(read("orchestration_1_0_82/index.ts"), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
});

const frozenHashes = {
    "agents.ts": "86c55f4f576d661b79858c11c0eff08d5652bb2152d18f19ef4123c656494250",
    "index.ts": "f10da54f1ce7785f0929fd6cf681bcf6489e225cc08866ce97fe4175bd9a4075",
    "lifecycle.ts": "bc3b61dc15eab0fd981bcbd8fd8c0a5e9ec9a7c1dddd23d0001e0c1b4a708417",
    "queue.ts": "7fe401187e31759022eca1ab1d29dcbd11e42084896ef924d54eb88d59296a83",
    "runtime.ts": "02fe84eccf301d28c76157af8f4b54fd1bfbdd155c9a3860250d32feca51654d",
    "state.ts": "b58bbdbec9debfd1e28cc1f1bd359aba33139478b2154c7005c3190627924986",
    "turn.ts": "9c11110bc861eea2109da120becaf4a58256bb761b811a204d2367ad23a5dbd6",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.82 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`orchestration_1_0_82/${name}`)).digest("hex"), hash);
    });
}

test("frozen 1.0.82 keeps the 1.0.82 routing and busy policy", () => {
    for (const name of Object.keys(frozenHashes)) {
        assert.doesNotMatch(read(`orchestration_1_0_82/${name}`), /ownerTag|requestOwnerCapacity|workspaceBusyFastRelease/, name);
    }
    const agents = read("orchestration_1_0_82/agents.ts");
    assert.equal(agents.match(/yield runtime\.session\.destroy\(\);/g)?.length, 3, "complete, cancel and the failed shutdown destroy without a cap");
    assert.match(read("orchestration_1_0_82/lifecycle.ts"), /const raw: any = yield runtime\.session\.checkWorkspace\(/);
    assert.match(read("orchestration_1_0_82/turn.ts"), /if \(failures\.count >= 2 && state\.blobEnabled\) \{/);
});
