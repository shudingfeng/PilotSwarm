// How many worker VMs, and whose (section "Scaling the pool" of the design):
//
// 1. Demand: an owner needs a VM when a leased root of theirs has work and
//    none of their bound VMs is free. Unserved demand is served oldest first.
// 2. Bind: the ready unbound VM goes to the owner; without one the scale set
//    grows by one VM that starts bound; at the maximum, another owner's
//    longest-idle bound VM is recycled at once.
// 3. Target: min(X, max(Y, bound + ready)) active VMs, where `ready` is 1
//    while a demand signal arrived within WIN_WORKER_IDLE_RECYCLE_MINUTES, and
//    Y is at least 1 inside WIN_WORKER_WORKING_HOURS.
// 4. Scale out: a PATCH of `sku.capacity` alone, never while frozen.
// 5. Scale in: idle bound VMs, unbound VMs above the target and idle VMs on
//    another image or configuration version are drained and deleted, at most
//    WIN_WORKER_SCALE_IN_BATCH every WIN_WORKER_SCALE_IN_INTERVAL_MINUTES,
//    longest idle first, after a 15-minute minimum uptime, and never below Y:
//    a replacement starts first.
//
// `planScaling` decides from a snapshot and does nothing; `evaluateScaling`
// builds the snapshot and carries the plan out.
import { randomUUID } from "node:crypto";
import { TIMING, driveOfRoot, driveOnVm } from "./model.mjs";
import { controllerRecord, updateController } from "./controller-record.mjs";
import { bindVm, isFree, isOutdated, isServing, isSilent, startDrain, vmRuntime } from "./fleet.mjs";
import { withinWorkingHours } from "./working-hours.mjs";

const demandKey = (entry) => `${entry.ownerOid}\n${entry.rootSessionId}`;

/**
 * Input: { now, config: { max, minRunning, idleRecycleMs, scaleInBatch,
 * scaleInIntervalMs }, frozen, capacity, vms: [{ name, ownerOid, serving,
 * alive, free, starting, coming, draining, drainReason, idleSince,
 * activatedAt, outdated }], pending: [{ purpose, ownerOid }], demand:
 * [{ ownerOid, rootSessionId, excludeVm, holderVm }], lastDemandAt,
 * lastScaleInAt, withinHours }.
 *
 * Output: { binds: [{ vm, ownerOid }], scaleOuts: [{ purpose, ownerOid? }],
 * recycles: [{ vm, reason, exempt }], served: [demand keys], target }.
 */
export function planScaling(input) {
  const { now, config: cfg, frozen, capacity, vms, pending, demand, lastDemandAt, lastScaleInAt, withinHours } = input;
  const plan = { binds: [], scaleOuts: [], recycles: [], served: [], target: null };
  const floor = Math.max(cfg.minRunning, withinHours ? 1 : 0);
  let planned = capacity;
  const matched = new Set();
  const waitingOwners = new Set(demand.map((entry) => entry.ownerOid));
  const pendingForOwner = new Map();
  for (const entry of pending) {
    if (entry.purpose === "owner") pendingForOwner.set(entry.ownerOid, (pendingForOwner.get(entry.ownerOid) ?? 0) + 1);
  }
  const usable = (vm, entry) => !matched.has(vm.name) && vm.name !== entry.excludeVm;

  // 1. Demand an owner's own VMs already cover.
  const unserved = [];
  for (const entry of demand) {
    const holder = entry.holderVm && vms.find((vm) => vm.name === entry.holderVm && vm.serving && vm.ownerOid === entry.ownerOid && usable(vm, entry));
    const free = holder || vms.find((vm) => vm.ownerOid === entry.ownerOid && vm.free && usable(vm, entry));
    if (free) {
      matched.add(free.name);
      plan.served.push(demandKey(entry));
      continue;
    }
    const coming = vms.find((vm) => vm.ownerOid === entry.ownerOid && (vm.starting || vm.coming) && usable(vm, entry));
    if (coming) {
      matched.add(coming.name);
      continue;
    }
    if ((pendingForOwner.get(entry.ownerOid) ?? 0) > 0) {
      pendingForOwner.set(entry.ownerOid, pendingForOwner.get(entry.ownerOid) - 1);
      continue;
    }
    unserved.push(entry);
  }

  // 2. Bind a ready VM, scale out, or recycle another owner's idle VM at the maximum.
  let recyclingForWaiting = vms.filter((vm) => vm.draining && vm.drainReason === "waiting-owner").length;
  for (const entry of unserved) {
    const ready = vms.find((vm) => vm.serving && !vm.ownerOid && vm.alive && usable(vm, entry));
    if (ready) {
      matched.add(ready.name);
      plan.binds.push({ vm: ready.name, ownerOid: entry.ownerOid });
      plan.served.push(demandKey(entry));
      continue;
    }
    if (frozen) continue;
    if (planned < cfg.max) {
      planned++;
      plan.scaleOuts.push({ purpose: "owner", ownerOid: entry.ownerOid });
      plan.served.push(demandKey(entry));
      continue;
    }
    if (recyclingForWaiting > 0) {
      recyclingForWaiting--;
      continue;
    }
    const victim = vms
      .filter((vm) => vm.serving && vm.ownerOid && vm.ownerOid !== entry.ownerOid && vm.idleSince !== null
        && !matched.has(vm.name) && !waitingOwners.has(vm.ownerOid))
      .sort((a, b) => a.idleSince - b.idleSince)[0];
    if (victim) {
      matched.add(victim.name);
      plan.recycles.push({ vm: victim.name, reason: "waiting-owner", exempt: true });
    }
  }

  // 3. The target.
  const active = vms.filter((vm) => vm.serving || vm.coming);
  const pendingOwners = pending.filter((entry) => entry.purpose === "owner").length;
  const pendingOthers = pending.length - pendingOwners;
  const newOwners = plan.scaleOuts.filter((entry) => entry.purpose === "owner").length;
  const bound = active.filter((vm) => vm.ownerOid).length + plan.binds.length + pendingOwners + newOwners;
  let activeCount = active.length + pending.length + plan.scaleOuts.length
    - plan.recycles.length;
  const ready = lastDemandAt && now - lastDemandAt <= cfg.idleRecycleMs ? 1 : 0;
  const target = Math.min(cfg.max, Math.max(floor, bound + ready));
  plan.target = target;
  if (!frozen && activeCount < target && planned < cfg.max) {
    const add = Math.min(target - activeCount, cfg.max - planned);
    for (let i = 0; i < add; i++) plan.scaleOuts.push({ purpose: "ready" });
    planned += add;
    activeCount += add;
  }

  // 4. Scale in, in steps.
  if (!frozen && now - lastScaleInAt >= cfg.scaleInIntervalMs) {
    let aboveTarget = activeCount - target;
    const candidates = [];
    for (const vm of vms) {
      if (!vm.serving || vm.idleSince === null || matched.has(vm.name) || now - vm.activatedAt < TIMING.minUptimeMs) continue;
      if (vm.ownerOid && now - vm.idleSince >= cfg.idleRecycleMs) candidates.push({ vm, reason: "idle" });
      else if (!vm.ownerOid && aboveTarget > 0) {
        aboveTarget--;
        candidates.push({ vm, reason: "above-target" });
      } else if (vm.outdated) candidates.push({ vm, reason: "outdated" });
    }
    candidates.sort((a, b) => a.vm.idleSince - b.vm.idleSince);
    const replacementPending = pendingOthers > 0 || plan.scaleOuts.some((entry) => entry.purpose === "replacement");
    // Only VMs that run now count toward Y: a replacement still on its way does not.
    let remaining = vms.filter((vm) => vm.serving).length - plan.recycles.length;
    for (const candidate of candidates.slice(0, cfg.scaleInBatch)) {
      if (remaining - 1 < floor) {
        if (!replacementPending && planned < cfg.max) {
          plan.scaleOuts.push({ purpose: "replacement" });
          planned++;
        }
        break;
      }
      remaining--;
      plan.recycles.push({ vm: candidate.vm.name, reason: candidate.reason, exempt: false });
    }
  }
  return plan;
}

/** The planner's snapshot of the pool. */
export function scalingInput(ctl) {
  const now = ctl.now();
  const c = controllerRecord(ctl);
  const disks = ctl.state.all("disk");
  const vms = ctl.state.all("vm").filter((record) => record.role === "worker" && !record.fence).map((record) => {
    const rt = vmRuntime(ctl, record.name);
    const serving = isServing(record);
    const alive = serving && !isSilent(ctl, record);
    const free = serving && isFree(ctl, record);
    return {
      name: record.name,
      ownerOid: record.ownerOid,
      serving,
      alive,
      free,
      coming: !record.activatedAt && !record.drain && !record.deleting && !record.stoppedForUpgrade,
      starting: serving && Boolean(record.ownerOid) && !free && (rt.activeWorkloadCount ?? 0) === 0
        && (rt.phase !== "running" || rt.bindingRestartSince !== null),
      draining: Boolean(record.drain || record.deleting),
      drainReason: record.drain?.reason ?? record.deleting?.reason ?? null,
      idleSince: alive && !driveOnVm(disks, record.name) ? rt.idleSince : null,
      activatedAt: record.activatedAt ?? record.firstSeenAt,
      outdated: isOutdated(ctl, record),
    };
  });
  return {
    now,
    config: ctl.config.vms,
    frozen: Boolean(c.upgradeFrozen),
    capacity: ctl.runtime.scaleSet?.capacity ?? 0,
    vms,
    pending: c.pending.filter((entry) => now - entry.at <= TIMING.pendingScaleOutMs),
    demand: c.demand
      .filter((entry) => now - entry.lastAt <= TIMING.demandMs)
      .sort((a, b) => a.at - b.at)
      .map((entry) => ({ ...entry, holderVm: driveOfRoot(disks, entry.rootSessionId)?.attach?.vmName ?? null })),
    lastDemandAt: c.lastDemandAt,
    lastScaleInAt: c.lastScaleInAt,
    withinHours: withinWorkingHours(ctl.config.vms.workingHours, now),
  };
}

/** Raises the scale set's capacity with a PATCH of `sku.capacity` alone, never while frozen and never above X. */
export async function scaleOut(ctl, entries) {
  return ctl.locks.run("scale-set", async () => {
    if (controllerRecord(ctl).upgradeFrozen || entries.length === 0) return 0;
    const scaleSet = await ctl.azure.scaleSet();
    if (!scaleSet) return 0;
    const capacity = Math.min(ctl.config.vms.max, scaleSet.capacity + entries.length);
    const added = capacity - scaleSet.capacity;
    if (added <= 0) return 0;
    const now = ctl.now();
    const delivered = entries.slice(0, added).map((entry) => ({ ...entry, id: randomUUID(), at: now }));
    const ids = new Set(delivered.map((entry) => entry.id));
    await updateController(ctl, (c) => ({ ...c, pending: [...c.pending, ...delivered] }));
    try {
      await ctl.azure.setCapacity(capacity);
    } catch (err) {
      await updateController(ctl, (c) => ({ ...c, pending: c.pending.filter((entry) => !ids.has(entry.id)) }));
      throw err;
    }
    ctl.runtime.scaleSet = { ...scaleSet, capacity };
    // New VMs bring new addresses: the next unknown source refreshes the NIC map at once.
    ctl.runtime.nics.at = 0;
    ctl.log.audit("pool.scale-out", { from: scaleSet.capacity, to: capacity, purposes: delivered.map((entry) => entry.ownerOid ? `owner:${entry.ownerOid}` : entry.purpose) });
    return added;
  });
}

/** Plans and carries out one scaling round. */
export async function evaluateScaling(ctl) {
  if (!ctl.azure || !ctl.runtime.scaleSet) return null;
  return ctl.locks.run("scaling", async () => {
    const input = scalingInput(ctl);
    const plan = planScaling(input);
    for (const bind of plan.binds) await bindVm(ctl, bind.vm, bind.ownerOid);
    if (plan.scaleOuts.length) await scaleOut(ctl, plan.scaleOuts);
    for (const recycle of plan.recycles) await startDrain(ctl, recycle.vm, recycle.reason, { deleteAfter: true });
    const steppedIn = plan.recycles.some((recycle) => !recycle.exempt);
    const served = new Set(plan.served);
    await updateController(ctl, (c) => ({
      ...c,
      demand: c.demand.filter((entry) => !served.has(demandKey(entry)) && input.now - entry.lastAt <= TIMING.demandMs),
      pending: c.pending.filter((entry) => input.now - entry.at <= TIMING.pendingScaleOutMs),
      lastScaleInAt: steppedIn ? input.now : c.lastScaleInAt,
    }));
    return plan;
  });
}
