// Scaling the pool: the target min(X, max(Y, bound + ready)), demand served
// by binding or scaling out, scale-in in steps down to zero, the working-hours
// floor, replacements before a recycle at Y, recycling for a waiting owner at
// X, nothing while frozen, and the scale set's capacity changed only with a
// PATCH of `sku.capacity`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { planScaling } from "../lib/scaling.mjs";
import { createHarness, MINUTES } from "./harness.mjs";
import { OWNER_A, OWNER_B } from "./fakes.mjs";

const NOW = Date.parse("2026-11-02T16:00:00Z");
const CONFIG = { max: 3, minRunning: 0, idleRecycleMs: MINUTES(15), scaleInBatch: 1, scaleInIntervalMs: MINUTES(5) };

function vm(name, props = {}) {
  return {
    name,
    ownerOid: null,
    serving: true,
    alive: true,
    free: false,
    starting: false,
    coming: false,
    draining: false,
    drainReason: null,
    idleSince: null,
    activatedAt: NOW - MINUTES(60),
    outdated: false,
    ...props,
  };
}

function plan(input) {
  return planScaling({
    now: NOW,
    config: CONFIG,
    frozen: false,
    capacity: input.vms?.length ?? 0,
    vms: [],
    pending: [],
    demand: [],
    lastDemandAt: 0,
    lastScaleInAt: 0,
    withinHours: false,
    ...input,
    config: { ...CONFIG, ...input.config },
  });
}

const demand = (ownerOid, rootSessionId, extra = {}) => ({ ownerOid, rootSessionId, at: NOW - 1000, lastAt: NOW - 1000, ...extra });

test("the target: one ready VM while demand is recent, none after; never above X", () => {
  const bound = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(1) })];
  assert.equal(plan({ vms: bound, lastDemandAt: NOW - MINUTES(14) }).target, 2);
  assert.deepEqual(plan({ vms: bound, lastDemandAt: NOW - MINUTES(14) }).scaleOuts, [{ purpose: "ready" }]);
  assert.equal(plan({ vms: bound, lastDemandAt: NOW - MINUTES(16) }).target, 1);
  assert.deepEqual(plan({ vms: bound, lastDemandAt: NOW - MINUTES(16) }).scaleOuts, []);
  const full = ["vm-1", "vm-2", "vm-3"].map((name, i) => vm(name, { ownerOid: [OWNER_A, OWNER_B, "cccccccc-cccc-cccc-cccc-cccccccccccc"][i] }));
  assert.equal(plan({ vms: full, lastDemandAt: NOW }).target, 3, "min(X, ...)");
  assert.deepEqual(plan({ vms: full, lastDemandAt: NOW }).scaleOuts, []);
});

test("demand: the owner's free VM serves it; otherwise the ready VM is bound, or the scale set grows by a VM that starts bound", () => {
  const free = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A, free: true })], demand: [demand(OWNER_A, "r1")] });
  assert.deepEqual(free.served, [`${OWNER_A}\nr1`]);
  assert.deepEqual(free.binds, []);

  const holder = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A })], demand: [demand(OWNER_A, "r1", { holderVm: "vm-1" })] });
  assert.deepEqual(holder.served, [`${OWNER_A}\nr1`], "the VM that holds the root's drive serves its turns");
  assert.deepEqual(holder.scaleOuts, []);

  const bind = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A }), vm("vm-2")], demand: [demand(OWNER_A, "r2")] });
  assert.deepEqual(bind.binds, [{ vm: "vm-2", ownerOid: OWNER_A }], "a busy own VM does not serve another root; the ready VM is bound");

  const grow = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A })], demand: [demand(OWNER_A, "r2")] });
  assert.deepEqual(grow.scaleOuts, [{ purpose: "owner", ownerOid: OWNER_A }]);

  const coming = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A, starting: true })], demand: [demand(OWNER_A, "r1")] });
  assert.deepEqual([coming.binds, coming.scaleOuts], [[], []], "a VM still starting for the owner covers it");
  const pending = plan({ pending: [{ purpose: "owner", ownerOid: OWNER_A }], demand: [demand(OWNER_A, "r1")], capacity: 1 });
  assert.deepEqual(pending.scaleOuts, [], "so does a scale-out that has not delivered its VM yet");

  const excluded = plan({ vms: [vm("vm-1", { ownerOid: OWNER_A, free: true })], demand: [demand(OWNER_A, "r1", { excludeVm: "vm-1" })] });
  assert.deepEqual(excluded.scaleOuts, [{ purpose: "owner", ownerOid: OWNER_A }], "a busy call needs a VM other than its own");
});

test("at X, another owner's waiting demand recycles the longest-idle bound VM at once, but not one its own owner waits for", () => {
  const vms = [
    vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(2) }),
    vm("vm-2", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(9) }),
    vm("vm-3", { ownerOid: "cccccccc-cccc-cccc-cccc-cccccccccccc", idleSince: NOW - MINUTES(30) }),
  ];
  const result = plan({ vms, demand: [demand(OWNER_B, "rb"), demand("cccccccc-cccc-cccc-cccc-cccccccccccc", "rc", { excludeVm: "vm-3" })], lastScaleInAt: NOW });
  assert.deepEqual(result.recycles, [
    { vm: "vm-2", reason: "waiting-owner", exempt: true },
    { vm: "vm-1", reason: "waiting-owner", exempt: true },
  ], "without waiting for the interval or the idle limit, longest idle first, and never vm-3, which its own owner waits for");
  const again = plan({ vms: [...vms.slice(0, 1), { ...vms[1], serving: false, draining: true, drainReason: "waiting-owner" }, vms[2]], demand: [demand(OWNER_B, "rb")] });
  assert.deepEqual(again.recycles.filter((recycle) => recycle.exempt), [], "one recycle per waiting demand");
});

test("scale-in steps: at most the batch per interval, longest idle first, after the minimum uptime, down to zero", () => {
  const idle = [
    vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(20) }),
    vm("vm-2", { ownerOid: OWNER_B, idleSince: NOW - MINUTES(40) }),
    vm("vm-3", { idleSince: NOW - MINUTES(60) }),
  ];
  const first = plan({ vms: idle });
  assert.deepEqual(first.recycles, [{ vm: "vm-3", reason: "above-target", exempt: false }]);
  assert.deepEqual(plan({ vms: idle, lastScaleInAt: NOW - MINUTES(4) }).recycles, [], "not before the interval");
  assert.deepEqual(plan({ vms: idle, config: { scaleInBatch: 2 } }).recycles.map((recycle) => recycle.vm), ["vm-3", "vm-2"]);
  const young = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(20), activatedAt: NOW - MINUTES(10) })];
  assert.deepEqual(plan({ vms: young }).recycles, [], "15 minutes of uptime first");
  const recent = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(10) })];
  assert.deepEqual(plan({ vms: recent }).recycles, [], "a bound VM goes only after the idle limit");
  const last = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(16) })];
  assert.deepEqual(plan({ vms: last }).recycles, [{ vm: "vm-1", reason: "idle", exempt: false }], "Y=0: the last VM goes too");
  assert.deepEqual(plan({ vms: [vm("vm-1", { ownerOid: OWNER_A })] }).recycles, [], "a VM with a drive or a turn is never idle");
});

test("never below Y: a replacement starts first, and the idle VM goes once it is active", () => {
  const idle = vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(16) });
  const first = plan({ vms: [idle], config: { minRunning: 1 } });
  assert.deepEqual(first.recycles, []);
  assert.deepEqual(first.scaleOuts, [{ purpose: "replacement" }]);
  const waiting = plan({ vms: [idle], config: { minRunning: 1 }, pending: [{ purpose: "replacement" }], capacity: 2 });
  assert.deepEqual([waiting.recycles, waiting.scaleOuts], [[], []], "one replacement at a time");
  const replaced = plan({ vms: [idle, vm("vm-2", { idleSince: NOW, activatedAt: NOW })], config: { minRunning: 1 } });
  assert.deepEqual(replaced.recycles, [{ vm: "vm-1", reason: "idle", exempt: false }]);
});

test("working hours keep at least one active VM; outside them the pool scales to Y", () => {
  const empty = plan({ withinHours: true });
  assert.equal(empty.target, 1);
  assert.deepEqual(empty.scaleOuts, [{ purpose: "ready" }]);
  assert.equal(plan({ withinHours: false }).target, 0);
  const idle = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(16) })];
  assert.deepEqual(plan({ vms: idle, withinHours: true }).recycles, [], "inside the hours the last VM stays until a replacement runs");
  assert.deepEqual(plan({ vms: idle, withinHours: false }).recycles.map((recycle) => recycle.vm), ["vm-1"]);
});

test("idle VMs on another image or configuration version are recycled in steps", () => {
  const outdated = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(1), outdated: true }), vm("vm-2", { ownerOid: OWNER_B, outdated: true })];
  assert.deepEqual(plan({ vms: outdated, lastDemandAt: NOW }).recycles, [{ vm: "vm-1", reason: "outdated", exempt: false }], "the busy one waits until it is idle");
});

test("frozen: nothing scales out or in", () => {
  const vms = [vm("vm-1", { ownerOid: OWNER_A, idleSince: NOW - MINUTES(60) }), vm("vm-2", { idleSince: NOW - MINUTES(60) })];
  const result = plan({ vms, frozen: true, demand: [demand(OWNER_B, "rb")], lastDemandAt: NOW, withinHours: true });
  assert.deepEqual([result.scaleOuts, result.recycles], [[], []]);
});

test("the controller changes the capacity only with a PATCH of sku.capacity, and scales out from zero on a coordination request", async () => {
  const h = await createHarness({ env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  await h.spares();
  assert.deepEqual(h.cloud.activeVmNames(), [], "zero VMs");
  await h.claim({ ownerOid: OWNER_A });
  h.clock.advance(MINUTES(20));
  await h.tick();
  const answer = await h.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" });
  assert.deepEqual(answer.body, { decision: "ok" });
  const updates = h.cloud.callsOf("vmss.update");
  assert.ok(updates.length >= 1);
  for (const [, group, name, parameters] of updates) {
    assert.equal(group, "stamp-rg");
    assert.equal(name, "win-workers");
    assert.deepEqual(Object.keys(parameters), ["sku"], "nothing but the SKU");
    assert.deepEqual(Object.keys(parameters.sku), ["capacity"], "and of it only the capacity");
  }
  await h.tick();
  const bound = h.state.all("vm").filter((record) => record.ownerOid === OWNER_A);
  assert.equal(bound.length, 1, "the new VM starts bound to the waiting owner");
  assert.deepEqual((await h.worker(bound[0].name, "/v1/vms/register")).body, { status: "active", ownerOid: OWNER_A });
});

test("an idle pool shrinks one VM per interval down to zero", async () => {
  const h = await createHarness({ env: { WIN_WORKER_SCALE_IN_INTERVAL_MINUTES: "5", WIN_WORKER_IDLE_RECYCLE_MINUTES: "15" } });
  const vms = [await h.activeVm({ owner: OWNER_A }), await h.activeVm({ owner: OWNER_B })];
  h.cloud.autoRunCommands = () => ({ state: "Succeeded", exitCode: 0 });
  const beat = async () => {
    for (const name of vms) if (h.cloud.vms.has(name)) await h.heartbeat(name);
  };
  for (let minute = 0; minute < 16; minute++) {
    h.clock.advance(MINUTES(1));
    await beat();
    await h.tick();
  }
  const drained = () => h.log.events("vm.drain").map((record) => record.vm);
  assert.equal(drained().length, 1, "one VM in the first step");
  for (let minute = 0; minute < 3; minute++) {
    h.clock.advance(MINUTES(1));
    await beat();
    await h.tick();
  }
  assert.equal(drained().length, 1, "none before the interval");
  for (let minute = 0; minute < 2; minute++) {
    h.clock.advance(MINUTES(1));
    await beat();
    await h.tick();
  }
  assert.equal(drained().length, 2, "the next after it");
  await h.tick();
  assert.deepEqual(h.cloud.activeVmNames(), [], "scaled to zero");
  for (const name of vms) assert.match(h.cloud.callsOf("runCommand.create").find((call) => call[2] === name)[4].source.script, /Drain-And-StopWorker\.ps1/);
  assert.equal(h.cloud.callsOf("dcr.delete").length, 2, "each drained VM's association goes with it");
});
