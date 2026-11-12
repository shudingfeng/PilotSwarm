/**
 * Owner routing on bare Duroxide runtimes, for owner-routing-durability.test.js:
 * the probe orchestrations every runtime registers, and a runtime in a child
 * process that a test can kill outright.
 *
 * The orchestrations schedule what orchestration 1.0.84 schedules for an
 * owner-tagged session, through PilotSwarm's own session proxies. A runtime
 * in the test process and one in a child process replay each other's
 * histories, so both load the proxies from the built dist/ code, and the
 * activities are registered by whoever starts the runtime.
 *
 * As a child (`node owner-routing-runtime.mjs --owner-routing-runtime`), the
 * module waits for a "start" message, runs one runtime and reports every
 * activity it starts to the parent ("ran" messages). Options:
 * - `block: { name, sessionId }`: that activity reports, then never settles;
 * - `turnMarker`: the "owner-turn-kill" orchestration writes this file once
 *   its "go" event arrives, then blocks inside the orchestration turn.
 */
import * as fs from "node:fs";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CHILD_FLAG = "--owner-routing-runtime";
const require = createRequire(import.meta.url);

const WORKSPACE = { schema: 1, root: "repos", folder: "app" };

/** The activities the probes schedule; a runtime registers each with its own handler. */
export const PROBE_ACTIVITIES = [
    "runTurnV5", "hydrateSession", "checkWorkspace", "releaseWorkspace", "destroySession", "requestOwnerCapacity", "probeKind",
];

/** What a probe activity answers. */
export const PROBE_ANSWERS = {
    runTurnV5: { type: "completed", content: "ok" },
    requestOwnerCapacity: { decision: "ok" },
    checkWorkspace: { ok: true, path: "/work/app" },
};

/**
 * Register the probe orchestrations on a Duroxide runtime.
 * `proxies` is dist/session-proxy.js. `hooks.afterGo(input)` runs inside the
 * orchestration turn that receives "owner-turn-kill"'s "go" event, on every
 * replay of it too.
 */
export function registerOwnerProbes(runtime, { createSessionProxy, createSessionManagerProxy }, hooks = {}) {
    const session = (ctx, input, key) => createSessionProxy(
        ctx, input.sessionId, key, { workspace: WORKSPACE }, "workflow-intake-v1", { ownerTag: input.ownerTag },
    );
    const raceIndex = (raced) => (typeof raced === "string" ? JSON.parse(raced) : raced).index;

    // An owner-tagged session's turn, its workspace check and release, and a
    // turn and a destroy under a new affinity key.
    runtime.registerOrchestration("owner-hold", function* (ctx, input) {
        const manager = createSessionManagerProxy(ctx, "workflow-intake-v1", { childResultProvenance: true });
        let current = session(ctx, input, `affinity-${input.sessionId}`);
        yield manager.requestOwnerCapacity(input.sessionId, input.ownerTag);
        yield current.runTurn("one", false, 0);
        yield current.hydrate();
        yield current.checkWorkspace({ workspace: WORKSPACE, revision: 2, turnIndex: 1 });
        yield current.releaseWorkspace({ reason: "idle", revision: 1, turnIndex: 1 });
        current = session(ctx, input, yield ctx.newGuid());
        yield current.runTurn("two", false, 1);
        yield current.destroy();
        return "ok";
    });

    // A tagged turn, then a session-scoped activity without the tag on the
    // same session: the mistake every proxy activity's owner tag prevents.
    runtime.registerOrchestration("owner-untagged-follow-up", function* (ctx, input) {
        const key = `affinity-${input.sessionId}`;
        yield session(ctx, input, key).runTurn("one", false, 0);
        yield createSessionProxy(ctx, input.sessionId, key, {}, "workflow-intake-v1").hydrate();
        return "ok";
    });

    // The capped destroy of 1.0.84, with the cap from the input.
    runtime.registerOrchestration("owner-destroy-race", function* (ctx, input) {
        const destroy = session(ctx, input, `affinity-${input.sessionId}`).destroy();
        return raceIndex(yield ctx.race(destroy, ctx.scheduleTimer(input.capMs)));
    });

    // An orchestration turn that a test kills: it starts with the "go" event.
    runtime.registerOrchestration("owner-turn-kill", function* (ctx, input) {
        const current = session(ctx, input, `affinity-${input.sessionId}`);
        yield ctx.waitForEvent("go");
        hooks.afterGo?.(input);
        yield current.runTurn("one", false, 0);
        yield current.destroy();
        return "ok";
    });

    // One plain activity per kind, each with its tag or none, all at once.
    runtime.registerOrchestration("owner-filter-kinds", function* (ctx, input) {
        yield ctx.all(input.kinds.map(({ kind, tag }) => {
            const task = ctx.scheduleActivity("probeKind", { kind });
            return tag ? task.withTag(tag) : task;
        }));
        return "ok";
    });
}

/**
 * Fork a child process that runs one Duroxide runtime against the test's
 * schema. Resolves `ready` once the runtime polls. `onRan(record)` gets each
 * activity the child starts.
 */
export function forkOwnerRuntime(env, label, { filter, runtimeOptions = {}, block, turnMarker, onRan }) {
    const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], {
        execArgv: [],
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const logs = [];
    for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (data) => logs.push(...data.toString().split("\n").filter((line) => line.trim())));
    }
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`runtime ${label} did not start in 60 s:\n${logs.join("\n")}`)), 60_000);
        child.on("message", (message) => {
            if (message?.type === "ran") onRan?.(message.record);
            if (message?.type === "ready") {
                clearTimeout(timer);
                resolve();
            }
            if (message?.type === "error") {
                clearTimeout(timer);
                reject(new Error(`runtime ${label} failed: ${message.error}`));
            }
        });
        exited.then(({ code, signal }) => {
            clearTimeout(timer);
            reject(new Error(`runtime ${label} exited (code ${code}, signal ${signal}):\n${logs.join("\n")}`));
        });
    });
    // A test that never awaits ready (it failed earlier) must not leave an unhandled rejection.
    ready.catch(() => {});
    child.send({
        type: "start",
        store: env.store,
        schema: env.duroxideSchema,
        label,
        workerNodeId: `${env.runId}-${label}`,
        filter,
        runtimeOptions,
        block,
        turnMarker,
    });
    return {
        label,
        ready,
        exited,
        logs,
        /** Kill the process outright: no shutdown, no lock release. */
        async kill() {
            child.kill("SIGKILL");
            return exited;
        },
    };
}

async function runChild(message) {
    const { PostgresProvider, Runtime } = require("duroxide");
    const proxies = await import("../../dist/session-proxy.js");
    const provider = await PostgresProvider.connectWithSchema(message.store, message.schema);
    const runtime = new Runtime(provider, {
        workerNodeId: message.workerNodeId,
        workerTagFilter: message.filter,
        logLevel: "error",
        ...message.runtimeOptions,
    });
    registerOwnerProbes(runtime, proxies, {
        afterGo: () => {
            if (!message.turnMarker) return;
            fs.writeFileSync(message.turnMarker, String(Date.now()));
            // Hold the orchestration turn until the test kills this process.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
        },
    });
    for (const name of PROBE_ACTIVITIES) {
        runtime.registerActivity(name, async (ctx, input) => {
            const record = { worker: message.label, name, tag: ctx.tag(), sessionId: input?.sessionId, kind: input?.kind, at: Date.now() };
            process.send({ type: "ran", record });
            if (message.block && message.block.name === name && message.block.sessionId === input?.sessionId) {
                await new Promise(() => {});
            }
            return PROBE_ANSWERS[name] ?? null;
        });
    }
    await runtime.start();
    process.send({ type: "ready" });
}

if (process.argv.includes(CHILD_FLAG)) {
    process.on("message", (message) => {
        if (message?.type !== "start") return;
        runChild(message).catch((error) => {
            process.send({ type: "error", error: error?.stack ?? String(error) });
            process.exit(1);
        });
    });
}
