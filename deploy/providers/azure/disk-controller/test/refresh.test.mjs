// The weekly golden-snapshot refresh: due a week after the last one, never
// while frozen; a VM that never activates, a drive from the current golden
// snapshot, the refresh and verify Run Commands, a new incremental snapshot
// recorded as golden with the previous one kept; a failure, including a copy
// that Azure reports Failed, keeps the current snapshot and alerts; a run's
// drive is deleted even when the first deletion fails, and never while its
// run is in progress.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHarness, MINUTES } from "./harness.mjs";
import { GOLDEN_ID, restError } from "./fakes.mjs";

const DAY = 24 * 60 * 60_000;
const VERIFIED = JSON.stringify({ verified: true, manifestSha256: "c".repeat(64), checks: { refs: true, fsck: true, hooks: true, acls: true } });

function scripted(h, { verify = VERIFIED, seedState = "Succeeded" } = {}) {
  h.cloud.autoRunCommands = (command) => {
    if (/-Refresh$/.test(command.script)) return { state: seedState, exitCode: seedState === "Succeeded" ? 0 : 1, output: "refreshed" };
    if (/-Verify$/.test(command.script)) return { state: "Succeeded", exitCode: 0, output: `fetching\n${verify}\n` };
    return { state: "Succeeded", exitCode: 0 };
  };
}

async function runRefresh(h, steps = 30) {
  for (let i = 0; i < steps; i++) {
    await h.controller.refreshTick();
    await h.ctl.settle();
    await h.tick();
    if (!h.state.get("controller", "controller")?.refresh) return i;
  }
  throw new Error(`the refresh did not finish: ${JSON.stringify(h.state.get("controller", "controller").refresh)}`);
}

const currentRun = (h) => h.state.get("controller", "controller")?.refresh ?? null;

/** Moves a due refresh on until it reaches `phase`, and returns the run. */
async function untilPhase(h, phase, steps = 30) {
  for (let i = 0; i < steps; i++) {
    if (currentRun(h)?.phase === phase) return currentRun(h);
    await h.controller.refreshTick();
    await h.ctl.settle();
    await h.tick();
  }
  throw new Error(`the refresh did not reach ${phase}: ${JSON.stringify(currentRun(h))}`);
}

test("the refresh is due a week after the last one, and never starts or continues while the pool is frozen", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY - MINUTES(1));
  await h.controller.refreshTick();
  assert.equal(h.state.get("controller", "controller").refresh, null, "not yet");
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: true });
  h.clock.advance(MINUTES(2));
  await h.controller.refreshTick();
  assert.equal(h.state.get("controller", "controller").refresh, null, "never while frozen");
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: false });
  await h.controller.refreshTick();
  const started = h.state.get("controller", "controller").refresh;
  assert.equal(started.phase, "await-vm", "started, and the scale set grew by one");
  assert.deepEqual(h.cloud.callsOf("vmss.update").at(-1)[3], { sku: { capacity: 1 } });
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: true });
  await h.controller.refreshTick();
  assert.equal(h.state.get("controller", "controller").refresh, null, "a freeze aborts a running refresh");
  assert.equal(h.log.events("snapshot.refresh-aborted").length, 1);
});

test("a refresh seeds a fresh copy on a VM that never activates, verifies it, and records the new snapshot as golden", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  await runRefresh(h);

  const [refreshVm] = h.state.all("vm").filter((record) => record.role === "refresh").map((record) => record.name);
  assert.equal(refreshVm, undefined, "the VM is gone again");
  const [, , vmName] = h.cloud.callsOf("vm.delete").at(-1);
  assert.equal(h.cloud.vms.has(vmName), false);
  const createdDrive = h.cloud.callsOf("disk.create").find((call) => call[2].startsWith("psrefresh-"));
  assert.equal(createdDrive[3].creationData.sourceResourceId, GOLDEN_ID, "a copy of the current golden snapshot");
  const attachCall = h.cloud.callsOf("vm.attachDetach").find((call) => call[3].dataDisksToAttach?.[0].diskId.endsWith(createdDrive[2]));
  assert.equal(attachCall[2], vmName);
  assert.equal(attachCall[3].dataDisksToAttach[0].lun, 0);
  const scripts = h.cloud.callsOf("runCommand.create").filter((call) => call[2] === vmName).map((call) => call[4].source.script);
  assert.deepEqual(scripts, ["& 'C:\\pilotswarm\\scripts\\Seed-WorkerReposDisk.ps1' -Refresh", "& 'C:\\pilotswarm\\scripts\\Seed-WorkerReposDisk.ps1' -Verify"]);
  assert.ok(h.cloud.callsOf("vm.attachDetach").some((call) => call[3].dataDisksToDetach?.[0].diskId.endsWith(createdDrive[2])), "detached before the snapshot");
  const [, , snapshotName, snapshot] = h.cloud.callsOf("snapshot.create")[0];
  assert.equal(snapshot.incremental, true);
  assert.ok(snapshot.creationData.sourceResourceId.endsWith(`/disks/${createdDrive[2]}`));
  assert.equal(h.cloud.disks.has(createdDrive[2]), false, "the refresh drive is deleted");

  const c = h.state.get("controller", "controller");
  assert.match(c.golden.id, new RegExp(`/snapshots/${snapshotName}$`));
  assert.equal(c.golden.manifestSha256, "c".repeat(64));
  assert.equal(c.previousGolden.id, GOLDEN_ID, "the previous snapshot is kept, as previousGolden");
  assert.ok(c.lastRefreshAt > 0 && c.lastRefreshAt <= h.clock.now(), "the run is recorded");
  assert.equal((await h.admin("GET", "/v1/admin/status")).body.goldenSnapshot, c.golden.id);
  assert.equal(h.log.events("snapshot.refresh-completed").length, 1);

  // New drives and resets copy the new snapshot.
  for (const disk of h.state.all("disk")) await h.ctl.state.update("disk", disk.name, () => null);
  await h.tick();
  assert.ok(h.cloud.callsOf("disk.create").filter((call) => call[2].startsWith("psdrive-")).at(-1)[3].creationData.sourceResourceId.endsWith(snapshotName));
});

test("each refresh keeps the previous snapshot and deletes older ones the controller made, never the configured one", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  const made = [];
  for (let week = 0; week < 3; week++) {
    h.clock.advance(7 * DAY + MINUTES(1));
    await runRefresh(h);
    made.push(h.state.get("controller", "controller").golden.id);
  }
  const deleted = h.cloud.callsOf("snapshot.delete").map((call) => call[2]);
  assert.deepEqual(deleted, [made[0].slice(made[0].lastIndexOf("/") + 1)], "the third refresh deletes the first one it made");
  assert.equal(h.cloud.snapshots.has("golden-0"), true);
  assert.equal(h.state.get("controller", "controller").previousGolden.id, made[1]);
});

test("a drive that fails verification keeps the current snapshot, deletes the VM and drive, and raises the refresh alert", async () => {
  const h = await createHarness();
  scripted(h, { verify: JSON.stringify({ verified: false, manifestSha256: "c".repeat(64), checks: { fsck: false } }) });
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  await runRefresh(h);
  const c = h.state.get("controller", "controller");
  assert.equal(c.golden, null, "the configured snapshot stays golden");
  assert.equal(h.cloud.callsOf("snapshot.create").length, 0);
  assert.equal(h.cloud.activeVmNames().length, 0);
  assert.equal([...h.cloud.disks.keys()].some((name) => name.startsWith("psrefresh-")), false);
  const [alert] = h.log.events("snapshot.refresh-failed");
  assert.equal(alert.level, "alert");
  assert.deepEqual(alert.checks, { fsck: false });
  assert.ok(c.lastRefreshAt > 0, "the next attempt waits a week");

  const failedSeed = await createHarness();
  scripted(failedSeed, { seedState: "Failed" });
  await failedSeed.controller.refreshTick();
  failedSeed.clock.advance(7 * DAY);
  await runRefresh(failedSeed);
  assert.equal(failedSeed.log.events("snapshot.refresh-failed")[0].reason, "the refresh script failed");
});

test("a drive that Azure reports Failed ends the refresh at once, never attached; the VM and the drive are deleted", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  h.cloud.copyPercent = 40;
  const run = await untilPhase(h, "await-disk");
  await h.controller.refreshTick();
  assert.equal(currentRun(h)?.phase, "await-disk", "a copy in progress is waited for");
  h.cloud.disks.get(run.diskName).provisioningState = "Failed";
  await h.controller.refreshTick();
  await h.ctl.settle();
  const c = h.state.get("controller", "controller");
  assert.equal(c.refresh, null, "the next check ends the run, hours before the copy's time is up");
  const [alert] = h.log.events("snapshot.refresh-failed");
  assert.deepEqual(
    { level: alert.level, phase: alert.phase, reason: alert.reason, provisioningState: alert.provisioningState, drive: alert.drive },
    { level: "alert", phase: "await-disk", reason: "the drive failed to provision", provisioningState: "Failed", drive: run.diskName },
  );
  assert.equal(c.golden, null, "the configured snapshot stays golden");
  assert.ok(c.lastRefreshAt > 0, "the next attempt waits a week");
  assert.equal(h.cloud.callsOf("vm.attachDetach").some((call) => call[3].dataDisksToAttach?.[0].diskId.endsWith(run.diskName)), false);
  assert.equal(h.cloud.vms.has(run.vmName), false, "the refresh VM is deleted");
  assert.equal(h.cloud.disks.has(run.diskName), false, "and the failed drive, through the list of refresh drives");
  assert.deepEqual(c.refreshDisks, []);
});

test("a snapshot that Azure reports Failed ends the refresh at once; the current snapshot stays golden, and the failed one and the drive are deleted", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  await untilPhase(h, "snapshot");
  h.cloud.copyPercent = 50;
  const run = await untilPhase(h, "await-snapshot");
  const snapshotName = run.snapshotId.slice(run.snapshotId.lastIndexOf("/") + 1);
  await h.controller.refreshTick();
  assert.equal(currentRun(h)?.phase, "await-snapshot", "a copy in progress is waited for");
  h.cloud.snapshots.get(snapshotName).provisioningState = "Failed";
  await h.controller.refreshTick();
  await h.ctl.settle();
  const c = h.state.get("controller", "controller");
  assert.equal(c.refresh, null, "the next check ends the run, hours before the copy's time is up");
  const [alert] = h.log.events("snapshot.refresh-failed");
  assert.deepEqual(
    { level: alert.level, phase: alert.phase, reason: alert.reason, provisioningState: alert.provisioningState, snapshot: alert.snapshot },
    { level: "alert", phase: "await-snapshot", reason: "the snapshot failed to provision", provisioningState: "Failed", snapshot: run.snapshotId },
  );
  assert.deepEqual([c.golden, c.previousGolden], [null, null], "the configured snapshot stays golden");
  assert.equal((await h.admin("GET", "/v1/admin/status")).body.goldenSnapshot, GOLDEN_ID);
  assert.equal(h.cloud.snapshots.has(snapshotName), false, "the failed snapshot is deleted");
  assert.equal(h.cloud.snapshots.has("golden-0"), true);
  assert.equal(h.cloud.disks.has(run.diskName), false, "and the drive");
  assert.deepEqual(c.refreshDisks, []);
  assert.equal(h.cloud.vms.has(run.vmName), false);
});

test("a refresh drive whose deletion fails stays listed, and later checks retry it until it is gone", async () => {
  const h = await createHarness();
  scripted(h, { verify: JSON.stringify({ verified: false, manifestSha256: "c".repeat(64), checks: { fsck: false } }) });
  const remove = h.cloud.compute.disks.delete;
  let failures = 2;
  h.cloud.compute.disks.delete = (group, name) => (name.startsWith("psrefresh-") && failures-- > 0
    ? Promise.reject(restError(500, "InternalServerError", "delete failed"))
    : remove(group, name));
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  await runRefresh(h);
  const [drive] = [...h.cloud.disks.keys()].filter((name) => name.startsWith("psrefresh-"));
  assert.ok(drive, "the run's own deletion failed");
  const listed = () => h.state.get("controller", "controller").refreshDisks.map((entry) => entry.name);
  assert.deepEqual(listed(), [drive]);
  for (const expected of [true, false]) {
    h.clock.advance(MINUTES(5));
    await h.controller.refreshTick();
    await h.ctl.settle();
    assert.equal(h.cloud.disks.has(drive), expected);
  }
  assert.deepEqual(listed(), [], "gone, and off the list");
  assert.deepEqual(h.log.events("snapshot.refresh-drive-deleted").map((record) => record.drive), [drive]);
});

test("the cleanup never deletes the drive of the run in progress", async () => {
  const h = await createHarness();
  scripted(h);
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  let run = null;
  for (let i = 0; i < 10 && !run?.diskName; i++) {
    await h.controller.refreshTick();
    await h.ctl.settle();
    await h.tick();
    run = h.state.get("controller", "controller").refresh;
  }
  assert.ok(run?.diskName, "the run has made its drive");
  // Even a list that names it, which no run's end writes, leaves it alone.
  await h.ctl.state.update("controller", "controller", (c) => ({ ...c, refreshDisks: [{ name: run.diskName, run: "other", since: 0 }] }));
  await h.controller.refreshTick();
  await h.ctl.settle();
  assert.equal(h.cloud.callsOf("disk.delete").some((call) => call[2] === run.diskName), false);
  assert.equal(h.cloud.disks.has(run.diskName), true);
  await runRefresh(h);
  assert.equal(h.log.events("snapshot.refresh-completed").length, 1, "the run finished with its drive");
  assert.equal(h.cloud.disks.has(run.diskName), false, "then the drive went");
  assert.deepEqual(h.state.get("controller", "controller").refreshDisks, []);
});

test("at X the refresh waits until a VM's slot is free", async () => {
  const h = await createHarness({ env: { WIN_WORKER_COUNT: "1" } });
  scripted(h);
  await h.activeVm();
  await h.controller.refreshTick();
  h.clock.advance(7 * DAY);
  await h.controller.refreshTick();
  await h.controller.refreshTick();
  assert.equal(h.state.get("controller", "controller").refresh.phase, "scale-out");
  assert.equal(h.cloud.callsOf("vmss.update").filter((call) => call[3].sku.capacity > 1).length, 0);
});
