// The VM lifecycle: the activation gate, owner binding, crash detection and
// fencing before a drive moves, release requests through heartbeat answers,
// the upgrade freeze and rollouts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAzure } from "../lib/azure.mjs";
import { createController } from "../lib/controller.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import { scaleOut } from "../lib/scaling.mjs";
import { syncAzureView } from "../lib/fleet.mjs";
import { createHarness, MINUTES } from "./harness.mjs";
import { OWNER_A, OWNER_B, SCALE_SET_ID, createMemoryLogger, fakeVerifier, restError } from "./fakes.mjs";

const SECONDS = (n) => n * 1000;

async function attachedDrive(h, { owner = OWNER_A, workId = "work-1", rootSessionId = "root-1" } = {}) {
  const vm = await h.activeVm({ owner });
  await h.spares();
  assert.equal((await h.claim({ ownerOid: owner, workId, rootSessionId })).body.decision, "ok");
  const attached = await h.worker(vm, "/v1/leases/attach", { rootSessionId, requestId: "r-1", purpose: "turn" });
  assert.equal(attached.body.ok, true, JSON.stringify(attached.body));
  return { vm, disk: attached.body.diskName };
}

test("register: a standby VM, a frozen pool and a draining VM never get `active`", async () => {
  const h = await createHarness({ cloud: { standby: 1 } });
  const [standby] = [...h.cloud.vms.values()].filter((vm) => vm.standby).map((vm) => vm.name);
  assert.deepEqual((await h.worker(standby, "/v1/vms/register")).body, { status: "inactive", reason: "STANDBY" });
  assert.equal(h.vmRecord(standby), null, "a standby VM is not taken into the fleet");

  const vm = await h.activeVm();
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: true });
  assert.deepEqual((await h.worker(vm, "/v1/vms/register")).body, { status: "inactive", reason: "FROZEN" });
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: false });

  const { startDrain } = await import("../lib/fleet.mjs");
  const other = await h.activeVm();
  await startDrain(h.ctl, other, "test", { deleteAfter: true });
  assert.deepEqual((await h.worker(other, "/v1/vms/register")).body, { status: "inactive", reason: "DRAINING" });
});

test("register: the data collection rule association comes before the first `active`, once; a bound VM is told its owner", async () => {
  const h = await createHarness();
  await scaleOut(h.ctl, [{ purpose: "owner", ownerOid: OWNER_A }]);
  const [vm] = h.cloud.activeVmNames();
  const original = h.cloud.monitor.dataCollectionRuleAssociations.create;
  h.cloud.monitor.dataCollectionRuleAssociations.create = async () => {
    throw new Error("association failed");
  };
  assert.equal((await h.worker(vm, "/v1/vms/register")).status, 500, "no association, no activation");
  assert.equal(h.vmRecord(vm).activatedAt, null);
  h.cloud.monitor.dataCollectionRuleAssociations.create = original;
  assert.deepEqual((await h.worker(vm, "/v1/vms/register")).body, { status: "active", ownerOid: OWNER_A });
  assert.deepEqual((await h.worker(vm, "/v1/vms/register")).body, { status: "active", ownerOid: OWNER_A });
  const created = h.cloud.callsOf("dcr.create");
  assert.equal(created.length, 1);
  assert.match(created[0][1], /\/virtualMachines\/vm-1$/);
  assert.deepEqual(created[0][3], { body: { dataCollectionRuleId: h.config.dcrId } });
  await h.ctl.settle();
  assert.deepEqual(h.cloud.callsOf("vmssvm.update")[0].slice(3), [vm, { protectionPolicy: { protectFromScaleSetActions: true } }], "a bound VM is protected from scale-set actions");
});

test("the snapshot refresh's VM never activates", async () => {
  const h = await createHarness();
  await scaleOut(h.ctl, [{ purpose: "refresh" }]);
  const [vm] = h.cloud.activeVmNames();
  assert.deepEqual((await h.worker(vm, "/v1/vms/register")).body, { status: "inactive", reason: "RESERVED" });
  assert.equal(h.vmRecord(vm).role, "refresh");
});

test("binding: demand binds the ready VM; its heartbeat answer names the owner", async () => {
  const h = await createHarness({ env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  const vm = await h.activeVm();
  assert.equal((await h.heartbeat(vm, { phase: "starting" })).ownerOid, null);
  await h.spares();
  await h.claim({ ownerOid: OWNER_A });
  await h.ctl.settle();
  assert.equal(h.vmRecord(vm).ownerOid, OWNER_A, "the claim's demand bound the ready VM");
  assert.equal((await h.heartbeat(vm, { phase: "starting" })).ownerOid, OWNER_A);
  assert.equal(h.log.events("vm.bind").length, 1);
});

test("crash detection waits out the startup grace, so a controller restart fences no VM", async () => {
  const h = await createHarness();
  const vm = await h.activeVm({ owner: OWNER_A });
  // The controller restarts 5 minutes later; the VM sends nothing to the new one.
  h.clock.advance(MINUTES(5));
  const log = createMemoryLogger();
  const controller = createController({
    config: h.config,
    azure: createAzure({ compute: h.cloud.compute, network: h.cloud.network, monitor: h.cloud.monitor, scaleSet: h.config.scaleSet, dcrId: h.config.dcrId }),
    state: createStateStore({ backend: h.backend }),
    log,
    clock: h.clock,
    verifyToken: fakeVerifier,
  });
  await controller.start();
  h.clock.advance(h.config.startupGraceMs + SECONDS(59));
  await controller.tick();
  await controller.ctl.settle();
  assert.equal(h.cloud.vms.has(vm), true, "the grace plus 59 seconds of silence: not fenced");
  h.clock.advance(SECONDS(2));
  await controller.tick();
  await controller.ctl.settle();
  assert.equal(h.cloud.vms.has(vm), false, "61 seconds after the grace: fenced");
  assert.equal(log.events("vm.fence")[0].reason, "silent");
});

test("a single silent VM is fenced, even when it is the only active one; many silent at once only raise an alert", async () => {
  const lone = await createHarness();
  const vm = await lone.activeVm({ owner: OWNER_A });
  lone.clock.advance(SECONDS(61));
  await lone.tick();
  assert.equal(lone.cloud.vms.has(vm), false);
  assert.equal(lone.vmRecord(vm), null, "the deletion is confirmed and the record gone");

  const h = await createHarness();
  const vms = [await h.activeVm({ owner: OWNER_A }), await h.activeVm({ owner: OWNER_B }), await h.activeVm()];
  h.clock.advance(SECONDS(61));
  await h.heartbeat(vms[2]);
  await h.tick();
  assert.deepEqual(vms.map((name) => h.cloud.vms.has(name)), [true, true, true], "two of three silent: no fencing");
  assert.equal(h.log.events("vms.mass-silence").length, 1);
  assert.equal(h.log.events("vms.mass-silence")[0].level, "alert");
  await h.heartbeat(vms[1]);
  await h.tick();
  assert.equal(h.cloud.vms.has(vms[0]), false, "one of three silent: fenced");
});

test("a fenced VM's data collection rule association is removed with it, and again with each retried deletion", async () => {
  const h = await createHarness();
  const associationOf = (name) => h.cloud.vm(name).id.slice(1).toLowerCase();
  const vm = await h.activeVm({ owner: OWNER_A });
  const first = associationOf(vm);
  assert.equal(h.cloud.dcr.has(first), true);
  h.clock.advance(SECONDS(61));
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "fenced");
  assert.equal(h.cloud.dcr.has(first), false, "its association went too");

  const stuck = await h.activeVm({ owner: OWNER_B });
  const second = associationOf(stuck);
  const removal = h.cloud.monitor.dataCollectionRuleAssociations.delete;
  h.cloud.monitor.dataCollectionRuleAssociations.delete = async () => {
    throw restError(503, "ServiceUnavailable", "try again");
  };
  h.cloud.failDeletes.add(stuck);
  h.clock.advance(SECONDS(61));
  await h.tick();
  assert.ok(h.vmRecord(stuck).fence, "fenced, but neither the deletion nor the removal went through");
  assert.equal(h.cloud.dcr.has(second), true);
  h.cloud.monitor.dataCollectionRuleAssociations.delete = removal;
  h.cloud.failDeletes.delete(stuck);
  h.clock.advance(MINUTES(2));
  await h.tick();
  assert.equal(h.cloud.vms.has(stuck), false, "the retried deletion");
  assert.equal(h.cloud.dcr.has(second), false, "and the retried removal");
});

test("crash loops: a fourth launch ID within 15 minutes, or a bound VM with no running heartbeat for the start window", async () => {
  const h = await createHarness();
  const looping = await h.activeVm({ owner: OWNER_A });
  for (let i = 0; i < 3; i++) {
    h.clock.advance(MINUTES(2));
    h.relaunch(looping);
    await h.heartbeat(looping, { phase: "starting" });
    await h.tick();
  }
  assert.equal(h.cloud.vms.has(looping), false, "the fourth launch ID within 15 minutes fences it");
  assert.equal(h.log.events("vms.crash-loop")[0].reason, "crash-loop:launches");

  const stuck = await createHarness();
  const vm = await stuck.activeVm({ owner: OWNER_A });
  for (let minute = 1; minute <= 10; minute++) {
    stuck.clock.advance(MINUTES(1));
    if (minute === 4 || minute === 8) stuck.relaunch(vm);
    await stuck.heartbeat(vm, { phase: "starting" });
    await stuck.tick();
  }
  assert.equal(stuck.cloud.vms.has(vm), true, "within the start window");
  stuck.clock.advance(MINUTES(1));
  await stuck.heartbeat(vm, { phase: "starting" });
  await stuck.tick();
  assert.equal(stuck.cloud.vms.has(vm), false, "restarts do not reset the start window");
  assert.equal(stuck.log.events("vm.fence")[0].reason, "crash-loop:start-window");
});

test("an unbound VM of an owner-only pool waits in `starting` without a window; binding restarts get 3 minutes and do not count", async () => {
  const ownerOnly = await createHarness({ env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  const waiting = await ownerOnly.activeVm();
  for (let i = 0; i < 15; i++) {
    ownerOnly.clock.advance(MINUTES(1));
    await ownerOnly.heartbeat(waiting, { phase: "starting" });
    await ownerOnly.tick();
  }
  assert.equal(ownerOnly.cloud.vms.has(waiting), true);

  const h = await createHarness();
  const vm = await h.activeVm();
  await h.spares();
  await h.claim({ ownerOid: OWNER_A });
  await h.ctl.settle();
  assert.equal(h.vmRecord(vm).ownerOid, OWNER_A);
  // The worker drains and restarts bound: 2.5 minutes without a heartbeat.
  h.clock.advance(SECONDS(150));
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true, "the binding window is 3 minutes");
  h.relaunch(vm);
  await h.heartbeat(vm, { phase: "running" });
  for (let i = 0; i < 2; i++) {
    h.clock.advance(MINUTES(2));
    h.relaunch(vm);
    await h.heartbeat(vm, { phase: "running" });
    await h.tick();
  }
  assert.equal(h.cloud.vms.has(vm), true, "the restart the controller asked for is not part of a crash loop");
  h.clock.advance(SECONDS(61));
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "after the restart, silence is back to 60 seconds");
});

test("the mass guard also holds for VMs that stay `starting` or keep restarting: two of three only raise the alert; one alone is fenced", async () => {
  const h = await createHarness();
  const stuck = [await h.activeVm({ owner: OWNER_A }), await h.activeVm({ owner: OWNER_B })];
  const healthy = await h.activeVm();
  for (let minute = 1; minute <= 11; minute++) {
    h.clock.advance(MINUTES(1));
    for (const vm of stuck) await h.heartbeat(vm, { phase: "starting" });
    await h.heartbeat(healthy);
    await h.tick();
  }
  assert.deepEqual([...stuck, healthy].map((name) => h.cloud.vms.has(name)), [true, true, true], "past the start window, but two of three");
  const [alert] = h.log.events("vms.mass-silence");
  assert.equal(alert.level, "alert");
  assert.deepEqual(alert.suspects.sort(), stuck.map((name) => `${name}:crash-loop:start-window`).sort());
  await h.heartbeat(stuck[1]);
  await h.tick();
  assert.equal(h.cloud.vms.has(stuck[0]), false, "one of three: fenced");
  assert.equal(h.log.events("vms.crash-loop")[0].reason, "crash-loop:start-window");

  const r = await createHarness();
  const restarting = [await r.activeVm({ owner: OWNER_A }), await r.activeVm({ owner: OWNER_B })];
  const steady = await r.activeVm();
  for (let i = 0; i < 3; i++) {
    r.clock.advance(MINUTES(2));
    for (const vm of restarting) {
      r.relaunch(vm);
      await r.heartbeat(vm, { phase: "starting" });
    }
    await r.heartbeat(steady);
    await r.tick();
  }
  assert.deepEqual([...restarting, steady].map((name) => r.cloud.vms.has(name)), [true, true, true], "a fourth launch ID on two of three");
  assert.deepEqual(r.log.events("vms.mass-silence")[0].suspects.sort(), restarting.map((name) => `${name}:crash-loop:launches`).sort());
  assert.equal(r.log.events("vm.fence").length, 0);
});

test("a drive moves only after its silent holder is fenced and Azure confirms the deletion; an unconfirmed deletion quarantines the lease", async () => {
  const h = await createHarness();
  const { vm, disk } = await attachedDrive(h);
  const other = await h.activeVm({ owner: OWNER_A });
  h.cloud.failDeletes.add(vm);
  h.clock.advance(SECONDS(61));
  await h.heartbeat(other);
  const early = (await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r-2", purpose: "turn" })).body;
  assert.deepEqual({ reason: early.reason, retryAfterMs: early.retryAfterMs }, { reason: "HOLDER_SILENT", retryAfterMs: 30_000 });
  await h.tick();
  assert.ok(h.vmRecord(vm).fence, "fenced");
  assert.equal(h.cloud.vms.has(vm), true, "but the deletion failed");
  assert.equal((await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r-3", purpose: "turn" })).body.reason, "HOLDER_SILENT", "while the deletion is not confirmed");
  assert.equal(h.cloud.callsOf("vm.attachDetach").length, 1, "no attach elsewhere yet");
  h.cloud.failDeletes.delete(vm);
  h.clock.advance(MINUTES(2));
  await h.heartbeat(other);
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "the fence retried the deletion");
  await h.tick();
  assert.equal(h.vmRecord(vm), null);
  const moved = (await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r-4", purpose: "turn" })).body;
  assert.equal(moved.ok, true);
  assert.equal(moved.takeover, true, "the new holder runs the crash checks");
  assert.equal(moved.diskName, disk);

  const q = await createHarness();
  const held = await attachedDrive(q);
  q.cloud.failDeletes.add(held.vm);
  q.clock.advance(SECONDS(61));
  await q.tick();
  q.clock.advance(MINUTES(16));
  await q.tick();
  assert.equal(q.drive(held.disk).lease.quarantined.reason, "fence-unconfirmed");
  assert.equal(q.log.events("drive.quarantine")[0].level, "alert");
  const other2 = await q.activeVm({ owner: OWNER_A });
  const refused = (await q.worker(other2, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r", purpose: "turn" })).body;
  assert.deepEqual({ reason: refused.reason, retryAfterMs: refused.retryAfterMs }, { reason: "QUARANTINED", retryAfterMs: 900_000 });
});

test("move: a turn attach from another VM asks the holder to release; a check never does; the holder's own attach cancels it; 10 minutes without a detach fences the holder", async () => {
  const h = await createHarness();
  const { vm, disk } = await attachedDrive(h);
  const other = await h.activeVm({ owner: OWNER_A });
  const check = (await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "c", purpose: "check" })).body;
  assert.deepEqual({ reason: check.reason, retryAfterMs: check.retryAfterMs }, { reason: "HELD_ELSEWHERE", retryAfterMs: 10_000 });
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, null, "a check never moves a drive");

  const turn = (await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "t", purpose: "turn" })).body;
  assert.equal(turn.retryAfterMs, 10_000);
  assert.deepEqual((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, { diskName: disk, reason: "move" });
  assert.equal((await h.worker(vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "own", purpose: "turn" })).body.ok, true);
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, null, "cancelled by the holder");

  await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "t2", purpose: "turn" });
  for (let minute = 0; minute < 10; minute++) {
    h.clock.advance(MINUTES(1));
    await h.heartbeat(vm, { attachedDisk: disk });
    await h.heartbeat(other);
    await h.tick();
  }
  assert.equal(h.cloud.vms.has(vm), true, "10 minutes are allowed");
  h.clock.advance(SECONDS(30));
  await h.heartbeat(other);
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "then the holder is fenced");
  assert.equal(h.log.events("vm.fence")[0].reason, "release-deadline:move");
  await h.heartbeat(other);
  await h.tick();
  assert.equal((await h.worker(other, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "t3", purpose: "turn" })).body.ok, true);
});

test("a return whose holder sends no detach within 10 minutes fences the holder, then resets the drive", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_POOL_COUNT: "3" } });
  const { vm, disk } = await attachedDrive(h);
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  h.clock.advance(MINUTES(9));
  await h.heartbeat(vm, { attachedDisk: disk });
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true);
  h.clock.advance(MINUTES(2));
  await h.heartbeat(vm, { attachedDisk: disk });
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false);
  assert.equal(h.log.events("vm.fence")[0].reason, "release-deadline:return");
  await h.tick();
  assert.equal(h.drive(disk)?.lease ?? null, null, "reset or deleted after the fence");
});

test("a rebind whose holder sends no detach within 10 minutes of the first refusal fences the holder; then the lease moves", async () => {
  const h = await createHarness();
  const { vm, disk } = await attachedDrive(h);
  const body = { workId: "work-1", rootSessionId: "root-2", ownerOid: OWNER_A, credential: "per-work-new" };
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body.code, "DRIVE_ATTACHED");
  h.clock.advance(MINUTES(9));
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body.code, "DRIVE_ATTACHED", "a repeat keeps the first refusal's time");
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested?.reason, "rebind");
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true, "9 minutes are allowed");
  h.clock.advance(MINUTES(1) + SECONDS(1));
  await h.heartbeat(vm, { attachedDisk: disk });
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "then the holder is fenced");
  assert.equal(h.log.events("vm.fence")[0].reason, "release-deadline:rebind");
  await h.tick();
  const moved = (await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body;
  assert.equal(moved.decision, "ok", JSON.stringify(moved));
  assert.equal(moved.lease.rootSessionId, "root-2");
  assert.equal(h.drive(disk).takeover, true, "the next holder runs the crash checks");
});

const SYNC = { workId: "work-1", sourceBranch: "main", headSha: "c".repeat(40), url: "https://git.example/repo", credential: "per-work-2" };

test("a sync-branch whose holder sends no detach within 10 minutes of the first refusal fences the holder; a detach ends the wait", async () => {
  const h = await createHarness();
  const { vm, disk } = await attachedDrive(h);
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.code, "DRIVE_ATTACHED");
  h.clock.advance(MINUTES(9));
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.code, "DRIVE_ATTACHED", "a repeat keeps the first refusal's time");
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested?.reason, "park");
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true, "9 minutes are allowed");
  h.clock.advance(MINUTES(1) + SECONDS(1));
  await h.heartbeat(vm, { attachedDisk: disk });
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "then the holder is fenced");
  assert.equal(h.log.events("vm.fence")[0].reason, "release-deadline:sync-branch");
  await h.tick();
  const synced = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body;
  assert.equal(synced.decision, "ok", JSON.stringify(synced));
  assert.equal(h.drive(disk).takeover, true, "the next holder runs the crash checks, then the sync");

  const d = await createHarness();
  const held = await attachedDrive(d);
  await d.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await d.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.code, "DRIVE_ATTACHED");
  d.clock.advance(MINUTES(2));
  await d.worker(held.vm, "/v1/leases/detach", { diskName: held.disk, rootSessionId: "root-1", requestId: "d" });
  assert.equal((await d.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.decision, "ok");
  const turn = (await d.worker(held.vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "t", purpose: "turn" })).body;
  assert.equal(turn.sync?.headSha, SYNC.headSha, "the turn's attach gets the sync");
  d.clock.advance(MINUTES(9));
  assert.equal((await d.heartbeat(held.vm, { attachedDisk: held.disk })).releaseRequested, null);
  await d.tick();
  assert.equal(d.cloud.vms.has(held.vm), true, "11 minutes after the first refusal, the drive mounted again: no fence");
  assert.equal(d.log.events("vm.fence").length, 0);
});

test("a later park or a return ends a refused sync-branch's wait: its deadline fences nothing", async () => {
  const p = await createHarness();
  const parked = await attachedDrive(p);
  await p.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await p.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.code, "DRIVE_ATTACHED");
  p.clock.advance(MINUTES(5));
  assert.equal((await p.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" })).body.decision, "ok");
  assert.equal(p.drive(parked.disk).lease.syncWait, null);
  p.clock.advance(MINUTES(6));
  assert.deepEqual((await p.heartbeat(parked.vm, { attachedDisk: parked.disk })).releaseRequested, { diskName: parked.disk, reason: "park" });
  await p.tick();
  assert.equal(p.cloud.vms.has(parked.vm), true, "still asked to release for the park, which sets no deadline");

  const r = await createHarness();
  const returned = await attachedDrive(r);
  await r.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await r.dispatcher("/disk-pool/v1/disks/sync-branch", SYNC)).body.code, "DRIVE_ATTACHED");
  r.clock.advance(MINUTES(5));
  await r.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  assert.equal(r.drive(returned.disk).lease.syncWait, null);
  r.clock.advance(MINUTES(6));
  await r.heartbeat(returned.vm, { attachedDisk: returned.disk });
  await r.tick();
  assert.equal(r.cloud.vms.has(returned.vm), true, "11 minutes after the refusal, 6 after the return: no fence yet");
  r.clock.advance(MINUTES(5));
  await r.heartbeat(returned.vm, { attachedDisk: returned.disk });
  await r.tick();
  assert.equal(r.cloud.vms.has(returned.vm), false);
  assert.equal(r.log.events("vm.fence")[0].reason, "release-deadline:return", "the return's own deadline");
});

test("upgrade freeze: drains and stops every active VM, refuses attaches and scale-out; unfreezing starts the service with a 3-minute window", async () => {
  const h = await createHarness();
  const { vm } = await attachedDrive(h);
  const other = await h.activeVm({ owner: OWNER_B });
  const frozen = (await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: true })).body;
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.allStopped, false);
  for (const name of [vm, other]) {
    const [drain] = h.cloud.runCommandsOn(name);
    assert.match(drain.script, /Drain-And-StopWorker\.ps1/);
    assert.equal(drain.parameters.asyncExecution, true);
    assert.equal(drain.parameters.timeoutInSeconds, 7200);
  }
  assert.equal((await h.heartbeat(vm)).releaseRequested?.reason, "drain", "a held drive is asked back for the drain");
  const refused = (await h.worker(vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "x", purpose: "turn" })).body;
  assert.deepEqual({ reason: refused.reason, retryAfterMs: refused.retryAfterMs }, { reason: "UPGRADE_FROZEN", retryAfterMs: 30_000 });
  const patches = h.cloud.callsOf("vmss.update").length;
  await h.claim({ ownerOid: OWNER_B, workId: "w-b", rootSessionId: "root-b" });
  await h.coordination({ ownerOid: OWNER_B, rootSessionId: "root-b" });
  await h.tick();
  assert.equal(h.cloud.callsOf("vmss.update").length, patches, "never scales while frozen");
  assert.equal(await scaleOut(h.ctl, [{ purpose: "owner", ownerOid: OWNER_B }]), 0, "nor does a direct scale-out");
  assert.equal(h.cloud.callsOf("vmss.update").length, patches);

  for (const name of [vm, other]) h.cloud.completeRunCommand(name, h.cloud.runCommandsOn(name)[0].name);
  await h.tick();
  const status = (await h.admin("GET", "/v1/admin/upgrade-freeze")).body;
  assert.equal(status.allStopped, true);
  assert.deepEqual(status.vms.map((entry) => entry.stoppedForUpgrade), [true, true]);
  h.clock.advance(MINUTES(30));
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true, "a VM stopped for the upgrade is never treated as crashed");

  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: false });
  const starts = h.cloud.runCommandsOn(vm).filter((command) => /Start-Service -Name PilotSwarmWorker/.test(command.script));
  assert.equal(starts.length, 1);
  h.cloud.completeRunCommand(vm, starts[0].name);
  h.cloud.completeRunCommand(other, h.cloud.runCommandsOn(other).find((command) => /Start-Service/.test(command.script)).name);
  await h.tick();
  assert.equal(h.vmRecord(vm).stoppedForUpgrade, false);
  h.clock.advance(MINUTES(2));
  await h.heartbeat(other);
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), true, "within the 3-minute unfreeze window");
  h.clock.advance(MINUTES(2));
  await h.heartbeat(other);
  await h.tick();
  assert.equal(h.cloud.vms.has(vm), false, "silent after it: handled as a crash");
  assert.equal(h.cloud.vms.has(other), true);
});

test("rollout: a new image or configuration version deletes the standby VMs once", async () => {
  const h = await createHarness({ cloud: { standby: 2 } });
  await h.tick();
  assert.equal(h.cloud.callsOf("vm.delete").length, 0, "the first versions are only recorded");
  const log = createMemoryLogger();
  const controller = createController({
    config: { ...h.config, imageVersion: "1.0.2" },
    azure: h.ctl.azure,
    state: createStateStore({ backend: h.backend }),
    log,
    clock: h.clock,
    verifyToken: fakeVerifier,
  });
  await controller.start();
  await controller.tick();
  await controller.ctl.settle();
  assert.deepEqual(h.cloud.callsOf("vm.delete").map((call) => call[2]).sort(), ["vm-1", "vm-2"]);
  await controller.tick();
  await controller.ctl.settle();
  assert.equal(h.cloud.callsOf("vm.delete").length, 2, "once");
  assert.equal(log.events("pool.rollout").length, 1);
});

test("status: each VM's image and configuration, and whether a rollout replaces it", async () => {
  const h = await createHarness();
  const current = await h.activeVm();
  const older = await h.activeVm();
  await h.heartbeat(older, { configVersion: "cfg-0" });
  const vms = Object.fromEntries((await h.admin("GET", "/v1/admin/status")).body.vms.map((vm) => [vm.name, vm]));
  assert.deepEqual(
    [current, older].map((name) => [vms[name].imageVersion, vms[name].configVersion, vms[name].outdated]),
    [[h.config.imageVersion, "cfg-1", false], [h.config.imageVersion, "cfg-0", true]],
  );
  // As after a restart of the controller: unknown until the VM's next heartbeat.
  const { vmRuntime } = await import("../lib/fleet.mjs");
  vmRuntime(h.ctl, current).configVersion = null;
  const unknown = (await h.admin("GET", "/v1/admin/status")).body.vms.find((vm) => vm.name === current);
  assert.deepEqual([unknown.configVersion, unknown.outdated], [null, null]);
});

test("a VM that disappears from the scale set is cleaned up, and its drive is flagged for the crash checks", async () => {
  const h = await createHarness();
  const { vm, disk } = await attachedDrive(h);
  h.cloud.vms.delete(vm);
  await h.tick();
  assert.equal(h.vmRecord(vm), null);
  assert.equal(h.drive(disk).attach, null);
  assert.equal(h.drive(disk).takeover, true);
  assert.equal(SCALE_SET_ID.endsWith("win-workers"), true);
  await syncAzureView(h.ctl);
});
