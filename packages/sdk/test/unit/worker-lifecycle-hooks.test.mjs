/**
 * Worker lifecycle hooks: onShutdown, requestExit and waitForShutdown, and
 * the budgets that gracefulShutdown passes on. The worker is never started;
 * the duroxide runtime and the workspace release are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PilotSwarmWorker } from "../../dist/worker.js";

function fixture(t) {
    const home = mkdtempSync(join(tmpdir(), "ps-worker-hooks-"));
    const worker = new PilotSwarmWorker({ sessionStateDir: join(home, "sessions"), disableManagementAgents: true });
    const drains = [];
    const releases = [];
    worker.runtime = { shutdown: async (ms) => { drains.push(ms); } };
    worker._runtimeStartup = Promise.resolve();
    worker.sessionManager.releaseIdleWorkspaces = async (opts) => { releases.push(opts); return 0; };
    t.mock.method(console, "error", () => {});
    t.after(() => rmSync(home, { recursive: true, force: true }));
    return { worker, drains, releases };
}

test("onShutdown hooks run in order after the drain; a failing hook does not stop the next", async (t) => {
    const { worker, drains } = fixture(t);
    const warn = t.mock.method(console, "warn", () => {});
    const ran = [];
    worker.onShutdown(async () => { ran.push(["first", drains.length]); });
    worker.onShutdown(() => { throw new Error("hook failed"); });
    const remove = worker.onShutdown(() => { ran.push(["removed"]); });
    worker.onShutdown(async () => { ran.push(["last"]); });
    remove();
    await worker.gracefulShutdown();
    assert.deepEqual(ran, [["first", 1], ["last"]]);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /hook failed/);
    assert.equal(await worker.waitForShutdown(), 0, "the exit code is 0 without requestExit");
});

test("requestExit drains with its own budget, and the host gets its code", async (t) => {
    const { worker, drains } = fixture(t);
    const waiting = worker.waitForShutdown();
    await worker.requestExit(75, "bind", { drainTimeoutMs: 120_000 });
    assert.deepEqual(drains, [120_000]);
    assert.equal(await waiting, 75);
});

test("a shutdown in progress is joined with its own budget, and the first exit code wins", async (t) => {
    const { worker, drains } = fixture(t);
    let finish;
    worker.runtime = { shutdown: (ms) => { drains.push(ms); return new Promise((resolve) => { finish = resolve; }); } };
    let hooks = 0;
    worker.onShutdown(() => { hooks += 1; });
    const first = worker.requestExit(75, "bind", { drainTimeoutMs: 120_000 });
    const signal = worker.gracefulShutdown();
    const second = worker.requestExit(3, "another", { drainTimeoutMs: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await Promise.all([first, signal, second]);
    assert.deepEqual(drains, [120_000], "one drain, with the first budget");
    assert.equal(hooks, 1);
    assert.equal(await worker.waitForShutdown(), 75);
});

test("gracefulShutdown passes releaseTimeoutMs to each workspace release, and leaves the default without it", async (t) => {
    const { worker, releases } = fixture(t);
    await worker.gracefulShutdown({ releaseTimeoutMs: 90_000 });
    await worker.gracefulShutdown();
    assert.deepEqual(releases.map((opts) => [opts.reason, opts.releaseTimeoutMs]), [["worker_shutdown", 90_000], ["worker_shutdown", undefined]]);
});

test("a failed shutdown step is logged and the shutdown goes on; a shutdown that fails still runs the hooks, and waitForShutdown rejects", async (t) => {
    // FU-11: each step is bounded, and its failure is the step's own to report.
    const { worker } = fixture(t);
    const warn = t.mock.method(console, "warn", () => {});
    worker.runtime = { shutdown: async () => { throw new Error("drain failed"); } };
    let hooked = 0;
    worker.onShutdown(() => { hooked += 1; });
    await worker.gracefulShutdown();
    assert.equal(hooked, 1);
    assert.equal(await worker.waitForShutdown(), 0);
    assert.ok(warn.mock.calls.some((call) => /shutdown: the runtime drain failed: drain failed/.test(String(call.arguments[0]))));

    // A failure outside the bounded steps fails the shutdown.
    const failing = fixture(t).worker;
    failing._stopProviderPolling = () => { throw new Error("polling did not stop"); };
    let ran = false;
    failing.onShutdown(() => { ran = true; });
    const waiting = failing.waitForShutdown();
    await assert.rejects(failing.gracefulShutdown(), /polling did not stop/);
    assert.equal(ran, true);
    await assert.rejects(waiting, /polling did not stop/);
});

test("requestExit refuses a code the host cannot exit with", async (t) => {
    const { worker, drains } = fixture(t);
    for (const code of [-1, 1.5, 256]) await assert.rejects(worker.requestExit(code, "bad"), RangeError);
    assert.deepEqual(drains, [], "nothing was drained");
});
