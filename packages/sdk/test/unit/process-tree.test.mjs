/**
 * Session workspaces: process-tree.ts, the helpers that stop background
 * shells the Copilot CLI will not cancel (docs/proposals/session-workspaces.md
 * 4.5), on every platform. session-workspace-release.test.mjs tests the kill
 * through releaseWorkspace.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killProcessTree, processAlive, processStartTimeMs, taskProcessAlive, windowsChildrenByParent } from "../../dist/process-tree.js";

// Runs for 30 seconds unless killed, on every platform.
const SLEEPER = ["-e", "setTimeout(() => {}, 30_000)"];

test("a process's start time is read from the host, to within a couple of seconds", async (t) => {
    const before = Date.now();
    const child = spawn(process.execPath, SLEEPER, { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = processStartTimeMs(child.pid);
    assert.equal(typeof started, "number");
    assert.ok(Math.abs(started - before) < 2_500, `${started - before} ms off`);
});

test("a task's pid counts only while it runs the process the task started (review R4)", async (t) => {
    const child = spawn(process.execPath, SLEEPER, { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    assert.equal(taskProcessAlive(child.pid, iso(0)), true, "started with the task");
    assert.equal(taskProcessAlive(child.pid, iso(-60_000)), false, "the task is a minute older than the process: the pid was reused");
    assert.equal(taskProcessAlive(child.pid), true, "without a start time, a live pid counts");
    assert.equal(taskProcessAlive(child.pid, "not a date"), true);
    assert.equal(taskProcessAlive(process.pid, iso(0)), false, "never this process");
    assert.equal(taskProcessAlive(1, iso(0)), false, "never pid 1");
    assert.equal(taskProcessAlive("123", iso(0)), false);
    process.kill(child.pid, "SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(taskProcessAlive(child.pid, iso(0)), false, "a dead pid does not count");
});

test("a process and every process below it are killed, and never this process", async (t) => {
    // Like a shell running a server: a parent with a child of its own. The
    // child is detached: on Windows, Node ends a child that is not when its
    // parent dies, which would hide a missed child.
    const parent = spawn(process.execPath, ["-e", [
        `const child = require("node:child_process").spawn(process.execPath, ${JSON.stringify(SLEEPER)}, { stdio: "ignore", detached: true });`,
        "console.log(child.pid);",
        "setTimeout(() => {}, 30_000);",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
    t.after(() => { for (const pid of [parent.pid, childPid]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    assert.equal(processAlive(childPid), true);
    assert.equal(killProcessTree(process.pid), false, "never this process");
    assert.equal(killProcessTree(parent.pid), true);
    const deadline = Date.now() + 5_000;
    while ((processAlive(parent.pid) || processAlive(childPid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(processAlive(parent.pid), false, "the parent is dead");
    assert.equal(processAlive(childPid), false, "its child is dead too");
    assert.equal(killProcessTree(parent.pid), false, "nothing is left to kill");
});

test("Windows: a process that started before its listed parent is not that parent's child", () => {
    // Windows keeps a parent pid after the parent ends and may give the pid
    // to a new process, so 100 below is not the parent of 400.
    const children = windowsChildrenByParent([
        "100 8 1000",
        "200 100 1500",
        "300 200 1600",
        "400 100 900",
        "500 999 2000",
        "600 100",
        "",
    ].join("\r\n"));
    assert.deepEqual(children.get(100), [200], "400 started before 100; 600 has no start time");
    assert.deepEqual(children.get(200), [300]);
    assert.equal(children.has(999), false, "a parent that is not listed has no children");
});
