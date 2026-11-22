/**
 * Every version gate answers for each of this fork's orchestration versions as it does for the upstream version that
 * fork version is built on (FORK_ORCHESTRATION_BASES), and everything that orders versions puts a fork version (a patch
 * number from 1000 up) after every upstream one: the three numbers are compared as numbers, never as text, so 1.0.1000
 * follows 1.0.86. An upstream sync adds each version gate that upstream's new commits bring (a new *_MIN_VERSION
 * constant, a three-number pattern, a read of sourceOrchestrationVersion or of an activity's orchestration version) to
 * GATES below.
 *
 * Run: node --test test/unit/orchestration-gate-parity.test.mjs (after npm run build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
    DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_ORCHESTRATION_REGISTRY,
} from "../../dist/orchestration-registry.js";
import { FORK_ORCHESTRATION_BASES } from "../../dist/orchestration-version.js";
import { orchestrationSupportsWorkspaces } from "../../dist/workspace.js";
import { intakeCapableVersion } from "../../dist/workflow/runtime.js";
import { assertIntakeContinueAsNewTarget } from "../../dist/orchestration/intake-state.js";
import { createInitialState, deriveOptions } from "../../dist/orchestration/state.js";

const { Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");

const REGISTERED = DURABLE_SESSION_ORCHESTRATION_REGISTRY.map(entry => entry.version);
const isFork = version => Number(version.split(".")[2]) >= 1000;
const FORK = REGISTERED.filter(isFork);
const UPSTREAM = REGISTERED.filter(version => !isFork(version));

/** Whether a call throws: the gates that refuse a version throw, with the versions in their message. */
function throws(fn) {
    try {
        fn();
        return false;
    } catch {
        return true;
    }
}

/** What createInitialState makes of a thrown turn's retry carried as the prompt of an input that `version` wrote. */
function ownedRetryOfSource(version) {
    const input = {
        sessionId: "s-1", config: { model: "test:model" }, prompt: "RETRY", retryCount: 1, thrownTurnKey: "turn-key-1",
        clientMessageIds: ["c-1"], sourceOrchestrationVersion: version,
    };
    const state = createInitialState(input, deriveOptions(input));
    return { ownedRetry: state.ownedRetry, pendingPrompt: state.pendingPrompt ?? null };
}

/** Each version gate: its name, and its answer for a version (compared with deepEqual). */
const GATES = [
    ["session workspaces (orchestrationSupportsWorkspaces, from 1.0.80): an activity's orchestration version", orchestrationSupportsWorkspaces],
    ["the Workflow intake's recipient (intakeCapableVersion, from 1.0.83)", intakeCapableVersion],
    ["a carried retry (writtenWithOwnedRetry, from 1.0.83): an input's sourceOrchestrationVersion", ownedRetryOfSource],
    ["the continue-as-new floor (assertIntakeContinueAsNewTarget), as the source", version => throws(() => assertIntakeContinueAsNewTarget(version, DURABLE_SESSION_LATEST_VERSION))],
];

test("the fork's versions are registered after upstream's, each with a registered upstream base", () => {
    assert.ok(FORK.length > 0);
    assert.deepEqual(REGISTERED.slice(-FORK.length), FORK, "the fork's versions come last");
    assert.deepEqual(Object.keys(FORK_ORCHESTRATION_BASES).sort(), [...FORK].sort());
    for (const version of FORK) assert.ok(UPSTREAM.includes(FORK_ORCHESTRATION_BASES[version]), `${version}'s base is registered`);
});

for (const [name, gate] of GATES) {
    test(`gate parity: ${name}`, () => {
        for (const version of FORK) {
            const base = FORK_ORCHESTRATION_BASES[version];
            assert.deepEqual(gate(version), gate(base), `${version} answers as its base ${base}`);
        }
    });
}

test("gate parity: the continue-as-new floor, as the target: a version that may move to a fork version's base may move to it", () => {
    for (const version of FORK) {
        const base = FORK_ORCHESTRATION_BASES[version];
        for (const source of UPSTREAM) {
            if (throws(() => assertIntakeContinueAsNewTarget(source, base))) continue;
            assert.equal(throws(() => assertIntakeContinueAsNewTarget(source, version)), false, `${source} to ${version}`);
        }
        assert.ok(throws(() => assertIntakeContinueAsNewTarget(version, base)), `${version} never moves down to ${base}`);
    }
});

test("the gates order a fork version after every upstream version, as numbers", () => {
    for (const version of FORK) {
        for (const upstream of UPSTREAM) {
            assert.equal(throws(() => assertIntakeContinueAsNewTarget(upstream, version)), false, `${upstream} to ${version}`);
            assert.equal(throws(() => assertIntakeContinueAsNewTarget(version, upstream)), true, `${version} to ${upstream}`);
        }
        assert.equal(orchestrationSupportsWorkspaces(version), true);
        assert.equal(intakeCapableVersion(version), true);
    }
    // As text, "1.0.1000" sorts before "1.0.86": a gate that compared strings would fail here.
    assert.ok("1.0.1000" < "1.0.86");
    assert.equal(throws(() => assertIntakeContinueAsNewTarget("1.0.86", "1.0.1000")), false);
});

test("duroxide orders the registry's versions as numbers: it registers them in order and starts an unversioned run at the latest", async () => {
    const provider = await SqliteProvider.inMemory();
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 20, orchestrationConcurrency: 1, workerConcurrency: 1, logLevel: "error" });
    // As the worker does (worker.ts): every registered version, in the registry's order, which duroxide requires to rise.
    for (const version of REGISTERED) {
        runtime.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, version, function* (ctx, input) {
            if (input === "continue") {
                yield ctx.continueAsNew("done");
                return "not reached";
            }
            return version;
        });
    }
    await runtime.start();
    try {
        await client.startOrchestration("unversioned", DURABLE_SESSION_ORCHESTRATION_NAME, "start");
        assert.equal((await client.waitForOrchestration("unversioned", 10_000)).output, DURABLE_SESSION_LATEST_VERSION);
        for (const version of FORK) {
            const base = FORK_ORCHESTRATION_BASES[version];
            await client.startOrchestrationVersioned(`from-${base}`, DURABLE_SESSION_ORCHESTRATION_NAME, "continue", base);
            assert.equal((await client.waitForOrchestration(`from-${base}`, 10_000)).output, DURABLE_SESSION_LATEST_VERSION,
                `an unversioned continue-as-new from ${base} goes to the latest`);
        }
    } finally {
        await runtime.shutdown(1_000);
    }
});
