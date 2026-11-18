/**
 * Formal audit R1 (pse/wfv2/formal/latest-1083): every registered session orchestration version resolves to its own
 * module, exactly. 1.0.82 is a frozen copy (orchestration_1_0_82/, which names itself "1.0.82" and stamps that literal
 * as a continue-as-new's source version; audit R2), and so are 1.0.83, 1.0.84 and 1.0.85 (orchestration_1_0_83/ to
 * orchestration_1_0_85/, each frozen when the next version opened); 1.0.86, the latest (1.0.85 plus owner routing), is
 * the live tree (orchestration/). Registering the live tree's code under a frozen version, or a frozen copy's under the
 * latest, would hand in-flight histories the wrong handler.
 *
 * Run: node --test test/unit/orchestration-registry-modules.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";

const DIST = new URL("../../dist/", import.meta.url);
const SRC = new URL("../../src/", import.meta.url);
const FROZEN = ["1.0.82", "1.0.83", "1.0.84", "1.0.85", "1.0.86"];

/** The module a version's code lives in: the live tree for the latest; else its own file (to 1.0.51) or directory. */
function moduleOf(version) {
    if (version === DURABLE_SESSION_LATEST_VERSION) return "orchestration/index.js";
    const name = `orchestration_${version.replaceAll(".", "_")}`;
    return existsSync(new URL(`${name}/index.js`, DIST)) ? `${name}/index.js` : `${name}.js`;
}

test("each registered version is its own module's handler, exactly; the latest (1.0.87) is the live tree; 1.0.82 to 1.0.86 frozen copies", async () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.87");
    const versions = DURABLE_SESSION_ORCHESTRATION_REGISTRY.map(entry => entry.version);
    assert.equal(new Set(versions).size, versions.length, "no version is registered twice");
    assert.equal(versions.at(-1), DURABLE_SESSION_LATEST_VERSION);
    for (const { version, handler } of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        const name = `durableSessionOrchestration_${version.replaceAll(".", "_")}`;
        const mod = await import(new URL(moduleOf(version), DIST).href);
        assert.equal(handler, mod[name], `${version} is ${moduleOf(version)}'s ${name}`);
        assert.equal(handler.name, name, version);
    }
    const live = await import(new URL("orchestration/index.js", DIST).href);
    for (const version of FROZEN) {
        const name = version.replaceAll(".", "_");
        const frozen = await import(new URL(`orchestration_${name}/index.js`, DIST).href);
        assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === version).handler,
            frozen[`durableSessionOrchestration_${name}`], version);
        assert.equal(`durableSessionOrchestration_${name}` in live, false, `the live tree is not ${version}`);
    }
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).handler, live.durableSessionOrchestration_1_0_87);
});

test("audit R2: frozen 1.0.82 to 1.0.86 name themselves with their literal and stamp it as a continue-as-new's source version", () => {
    for (const version of FROZEN) {
        const dir = `orchestration_${version.replaceAll(".", "_")}`;
        const runtime = readFileSync(new URL(`${dir}/runtime.ts`, SRC), "utf8").replace(/\r\n/g, "\n");
        assert.ok(runtime.split("\n").includes(`export const CURRENT_ORCHESTRATION_VERSION = "${version}";`), dir);
        assert.match(readFileSync(new URL(`${dir}/lifecycle.ts`, SRC), "utf8"), /canInput\.sourceOrchestrationVersion = runtime\.versions\.currentVersion;/, dir);
        assert.match(readFileSync(new URL(`${dir}/index.ts`, SRC), "utf8"), /currentVersion: CURRENT_ORCHESTRATION_VERSION,/, dir);
    }
});
