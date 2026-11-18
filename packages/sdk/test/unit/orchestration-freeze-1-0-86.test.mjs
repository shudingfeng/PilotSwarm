import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const root = new URL("../../src/", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8").replace(/\r\n/g, "\n");
const frozen = "orchestration_1_0_86";
// The released live tree, frozen before edits. Only runtime.ts changes:
// its own version becomes a literal, while the entry's CAN target stays latest.
const hashes = {
    "agents.ts": "18f2a89cf008ed09051f7b6d6302d5552944123de6448815e6dd161290bdaad5",
    "index.ts": "99183756ba618cffb9e09ce4eccaafe5b0c01e3e1584ec3564370f94934dc905",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "905298141d1d675194e62adb2cb71ffaa6b9f025a406d32bf829712c4d566d86",
    "proxy-contract.ts": "ba30ecb4405e568da4de5ee171ae8e84d0f4ff9384386547934025ff0d82f851",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "b99b2cc9a4a860b4b70778cb688cf8a659a6e0792805c72f65e74a150c5cbe4d",
    "state.ts": "a578f3ff49f7bd5e2cdbd1dd84ceaec27a9e1dd56d6ddaf673a8ba3905f1a1e4",
    "turn.ts": "fc642835bbcc3d312795233d662e528d764957ed119793d9d351ee8dfd34d66e",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a",
};

test("1.0.86 remains a distinct frozen handler and provisional 1.0.87 is the live latest", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.87");
    const old = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.86");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.equal(old.handler.name, "durableSessionOrchestration_1_0_86");
    assert.equal(latest.handler.name, "durableSessionOrchestration_1_0_87");
    assert.notEqual(old.handler, latest.handler);
    assert.match(read("orchestration-registry.ts"), /from "\.\/orchestration_1_0_86\/index\.js"/);
    assert.match(read("orchestration.ts"), /durableSessionOrchestration_1_0_87/);
    assert.match(read(`${frozen}/runtime.ts`), /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.86";/);
    assert.match(read(`${frozen}/index.ts`), /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
});

test("frozen 1.0.86 owns its complete replay-sensitive closure, including the proxy contract", () => {
    assert.deepEqual(readdirSync(new URL(`${frozen}/`, root)).filter(name => name.endsWith(".ts")).sort(), Object.keys(hashes).sort());
    for (const name of Object.keys(hashes)) {
        const source = read(`${frozen}/${name}`);
        assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*\/orchestration\//, name);
        assert.doesNotMatch(source, /question-answer-v1|conditionalRequest|questionAnswerReceipt/, name);
    }
    assert.equal(read(`${frozen}/proxy-contract.ts`), 'export const LIVE_SESSION_PROXY_CONTRACT = "tool-composition-v1";\n');
});

for (const [name, hash] of Object.entries(hashes)) {
    test(`frozen 1.0.86 ${name} retains its pre-change source`, () => {
        assert.equal(createHash("sha256").update(read(`${frozen}/${name}`), "utf8").digest("hex"), hash);
    });
}

test("the conditional version leaves unrelated orchestration helpers unchanged", () => {
    for (const name of ["agents.ts", "state.ts", "utils.ts", "intake-machine.ts", "intake-state.ts",
        "intake-wiring.ts", "workflow-turn-failure.ts", "proxy-contract.ts"]) {
        assert.equal(read(`orchestration/${name}`), read(`${frozen}/${name}`), name);
    }
    assert.equal(read("orchestration/runtime.ts")
        .replace('import { DURABLE_SESSION_LATEST_VERSION } from "../orchestration-version.js";\n', "")
        .replace("export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;",
            'export const CURRENT_ORCHESTRATION_VERSION = "1.0.86";'),
    read(`${frozen}/runtime.ts`));
});
