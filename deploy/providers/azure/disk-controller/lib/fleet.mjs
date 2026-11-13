// The worker VMs: which are ours, activation, heartbeats, binding, crash
// detection and fencing, drains, the upgrade freeze and image rollouts.
//
// A VM record lives in the state container from the moment the controller
// first sees the VM active until Azure confirms its deletion. Heartbeat
// times, phases and launch IDs stay in memory: after a restart the controller
// counts every VM's silence from the end of its startup grace, so a restart
// fences no VM.
import { peerIPv4 } from "./auth.mjs";
import { TIMING, MINUTE, driveOnVm, withState } from "./model.mjs";
import { TERMINAL_RUN_STATES, START_WORKER_SCRIPT, drainScript } from "./run-commands.mjs";
import { controllerRecord, updateController } from "./controller-record.mjs";
import { onHeartbeatForDrive, releaseReason, finishDetachedReturns } from "./pool.mjs";

const NIC_REFRESH_MS = 10_000;
const FENCE_RETRY_MS = 2 * MINUTE;

export function vmRuntime(ctl, name) {
  let rt = ctl.runtime.vms.get(name);
  if (!rt) {
    rt = {
      lastHeartbeatAt: null,
      lastRunningAt: null,
      phase: null,
      launches: [],
      expectedRestarts: [],
      bindingRestartSince: null,
      activeWorkloadCount: null,
      reportedDraining: false,
      configVersion: null,
      report: null,
      idleSince: null,
    };
    ctl.runtime.vms.set(name, rt);
  }
  return rt;
}

/** An activated worker VM that can run turns: not draining, fenced, deleted or stopped for an upgrade. */
export function isServing(record) {
  return Boolean(record && record.role === "worker" && record.activatedAt && !record.drain && !record.fence
    && !record.deleting && !record.stoppedForUpgrade && !record.start);
}

export function graceEnd(ctl) {
  return ctl.startedAt + ctl.config.startupGraceMs;
}

export function inGrace(ctl) {
  return ctl.now() < graceEnd(ctl);
}

function silenceWindow(record, rt) {
  if (rt.bindingRestartSince !== null) return TIMING.bindingWindowMs;
  if (record.unfreezeAt && (rt.lastHeartbeatAt ?? 0) < record.unfreezeAt) return TIMING.unfreezeWindowMs;
  return TIMING.silenceMs;
}

/** True when the VM has sent no heartbeat for its window, counted from the later of its last heartbeat and the startup grace's end. */
export function isSilent(ctl, record) {
  const rt = vmRuntime(ctl, record.name);
  const since = Math.max(rt.lastHeartbeatAt ?? 0, record.unfreezeAt ?? 0, record.activatedAt ?? 0, graceEnd(ctl));
  return ctl.now() - since > silenceWindow(record, rt);
}

function crashLoop(ctl, record, rt) {
  const now = ctl.now();
  const launches = rt.launches.filter((launch) => now - launch.at <= TIMING.launchWindowMs).length;
  const asked = rt.expectedRestarts.filter((at) => now - at <= TIMING.launchWindowMs).length;
  if (launches - asked >= TIMING.maxLaunches) return "launches";
  if (record.ownerOid) {
    const anchor = Math.max(record.boundAt ?? 0, record.unfreezeAt ?? 0, rt.lastRunningAt ?? 0, graceEnd(ctl));
    if (now - anchor > TIMING.startWindowMs) return "start-window";
  }
  return null;
}

/** A VM that can take an owner's turn now: serving, heard from, running and without work. */
export function isFree(ctl, record) {
  if (!isServing(record) || isSilent(ctl, record)) return false;
  const rt = vmRuntime(ctl, record.name);
  return rt.phase === "running" && rt.activeWorkloadCount === 0 && !rt.reportedDraining && rt.bindingRestartSince === null;
}

export function isOutdated(ctl, record) {
  const azureVm = ctl.runtime.azureVms.get(record.name);
  const rt = vmRuntime(ctl, record.name);
  if (ctl.config.imageVersion && azureVm?.imageVersion && azureVm.imageVersion !== ctl.config.imageVersion) return true;
  return Boolean(ctl.config.configVersion && rt.configVersion && rt.configVersion !== ctl.config.configVersion);
}

function isActiveInAzure(vm) {
  return !vm.inStandbyPool && vm.provisioningState !== "Deleting" && (vm.powerState === null || ["running", "starting"].includes(vm.powerState));
}

async function refreshNics(ctl) {
  ctl.runtime.nics.loading ??= (async () => {
    try {
      ctl.runtime.nics.addresses = await ctl.azure.nicAddresses();
      ctl.runtime.nics.at = ctl.now();
    } finally {
      ctl.runtime.nics.loading = null;
    }
  })();
  await ctl.runtime.nics.loading;
}

/**
 * The scale set VM that a request's source address belongs to, or null. The
 * address maps to a NIC, the NIC to its VM, and the VM must be a member of
 * this pool's scale set. A NIC with IP forwarding on is never trusted, since
 * only IP forwarding lets a VM send from an address that is not its own.
 */
export async function resolveVm(ctl, remoteAddress) {
  const ip = peerIPv4(remoteAddress);
  if (!ip || !ctl.azure) return null;
  const lookup = async () => {
    const entry = ctl.runtime.nics.addresses.get(ip);
    if (!entry?.vmName || entry.ipForwarding) return null;
    let vm = ctl.runtime.azureVms.get(entry.vmName) ?? null;
    if (!vm) {
      vm = await ctl.azure.getVm(entry.vmName);
      if (vm) ctl.runtime.azureVms.set(vm.name, vm);
    }
    return vm ? { name: vm.name } : null;
  };
  let found = await lookup();
  if (!found && ctl.now() - ctl.runtime.nics.at >= NIC_REFRESH_MS) {
    await refreshNics(ctl);
    found = await lookup();
  }
  return found;
}

function newVmRecord(name, now, assigned) {
  const owner = assigned?.purpose === "owner" ? assigned.ownerOid : null;
  return {
    name,
    firstSeenAt: now,
    role: assigned?.purpose === "refresh" ? "refresh" : "worker",
    ownerOid: owner,
    boundAt: owner ? now : null,
    activatedAt: null,
    dcrAssociated: false,
    protected: false,
    drain: null,
    fence: null,
    deleting: null,
    stoppedForUpgrade: false,
    stopFailed: false,
    start: null,
    unfreezeAt: null,
  };
}

/**
 * Takes a VM that just became active into the fleet. It serves the oldest
 * scale-out still waiting for a VM: an owner's (it starts bound), the
 * snapshot refresh's (it never activates) or a ready VM's (unbound).
 */
export async function adoptVm(ctl, name) {
  return ctl.locks.run("adopt", async () => {
    const existing = ctl.state.get("vm", name);
    if (existing) return existing;
    const now = ctl.now();
    let assigned = null;
    await updateController(ctl, (c) => {
      const pending = (c.pending ?? []).filter((entry) => now - entry.at <= TIMING.pendingScaleOutMs);
      assigned = pending.shift() ?? null;
      c.pending = pending;
      return c;
    });
    const record = await ctl.state.update("vm", name, (r) => r ?? newVmRecord(name, now, assigned));
    ctl.log.audit("vm.adopted", { vm: name, role: record.role, owner: record.ownerOid, purpose: assigned?.purpose ?? "none" });
    if (record.ownerOid) protectInBackground(ctl, name);
    return record;
  });
}

function protectInBackground(ctl, name) {
  ctl.background(`protect ${name}`, (async () => {
    await ctl.azure.protectVm(name);
    await ctl.state.update("vm", name, (r) => (r ? { ...r, protected: true } : undefined));
  })());
}

/** Lists the scale set's VMs, adopts new active ones and clears records of VMs that are gone. */
export async function syncAzureView(ctl) {
  if (!ctl.azure) return;
  const scaleSet = await ctl.azure.scaleSet();
  ctl.runtime.scaleSet = scaleSet;
  if (!scaleSet) {
    ctl.runtime.azureVms = new Map();
    return;
  }
  const vms = await ctl.azure.listVms();
  ctl.runtime.azureVms = new Map(vms.map((vm) => [vm.name, vm]));
  const known = new Set([...ctl.runtime.nics.addresses.values()].map((entry) => entry.vmName));
  if (vms.some((vm) => isActiveInAzure(vm) && !known.has(vm.name))) ctl.runtime.nics.at = 0;
  for (const vm of vms) {
    if (isActiveInAzure(vm) && !ctl.state.get("vm", vm.name)) await adoptVm(ctl, vm.name);
  }
  for (const record of ctl.state.all("vm")) {
    if (ctl.runtime.azureVms.has(record.name) || record.fence || record.deleting) continue;
    if (!(await ctl.azure.getVm(record.name))) await vmGone(ctl, record.name, { crashed: true });
  }
}

/** POST /v1/vms/register: `active` only for an activated, non-standby, non-draining VM while the pool is not frozen. */
export async function register(ctl, vmRef) {
  const azureVm = await ctl.azure.getVm(vmRef.name);
  if (!azureVm) return { status: "inactive", reason: "UNKNOWN" };
  ctl.runtime.azureVms.set(azureVm.name, azureVm);
  if (azureVm.inStandbyPool) return { status: "inactive", reason: "STANDBY" };
  if (controllerRecord(ctl).upgradeFrozen) return { status: "inactive", reason: "FROZEN" };
  let record = ctl.state.get("vm", vmRef.name) ?? (await adoptVm(ctl, vmRef.name));
  if (record.role === "refresh") return { status: "inactive", reason: "RESERVED" };
  if (record.drain || record.fence || record.deleting || record.stoppedForUpgrade || record.start) {
    return { status: "inactive", reason: "DRAINING" };
  }
  if (ctl.config.dcrId && !record.dcrAssociated) {
    await ctl.azure.associateDcr(vmRef.name);
    record = await ctl.state.update("vm", vmRef.name, (r) => (r ? { ...r, dcrAssociated: true } : undefined));
    ctl.log.audit("vm.dcr-associated", { vm: vmRef.name });
  }
  if (!record.activatedAt) {
    const now = ctl.now();
    record = await ctl.state.update("vm", vmRef.name, (r) => (r && !r.activatedAt ? { ...r, activatedAt: now } : undefined));
    ctl.log.audit("vm.activated", { vm: vmRef.name, owner: record.ownerOid });
  }
  return { status: "active", ownerOid: record.ownerOid ?? null };
}

const PHASES = new Set(["starting", "running"]);

function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** POST /v1/vms/heartbeat. Records what the VM reports and answers with the controller's view of it. */
export async function heartbeat(ctl, vmRef, body) {
  const now = ctl.now();
  const name = vmRef.name;
  const rt = vmRuntime(ctl, name);
  const launchId = typeof body.launchId === "string" && body.launchId.length <= 128 ? body.launchId : null;
  rt.launches = rt.launches.filter((launch) => now - launch.at <= TIMING.launchWindowMs);
  rt.expectedRestarts = rt.expectedRestarts.filter((at) => now - at <= TIMING.launchWindowMs);
  if (launchId && !rt.launches.some((launch) => launch.id === launchId)) {
    rt.bindingRestartSince = null;
    rt.launches.push({ id: launchId, at: now });
  }
  rt.lastHeartbeatAt = now;
  rt.phase = PHASES.has(body.phase) ? body.phase : rt.phase;
  if (body.phase === "running") rt.lastRunningAt = now;
  rt.activeWorkloadCount = nonNegative(body.activeWorkloadCount) ?? (body.phase === "starting" ? 0 : rt.activeWorkloadCount);
  rt.reportedDraining = body.draining === true;
  if (typeof body.configVersion === "string" && body.configVersion.length <= 128) rt.configVersion = body.configVersion;

  let held = driveOnVm(ctl.state.all("disk"), name);
  const sizeBytes = nonNegative(body.attachedDiskSizeBytes);
  const freeBytes = nonNegative(body.attachedDiskFreeBytes);
  rt.report = held && body.attachedDisk === held.name && sizeBytes !== null && freeBytes !== null
    ? { diskName: held.name, sizeBytes, freeBytes, at: now }
    : null;
  const idle = !held && (rt.activeWorkloadCount ?? 0) === 0;
  rt.idleSince = idle ? (rt.idleSince ?? now) : null;
  if (held) held = await onHeartbeatForDrive(ctl, held, body, rt.report);

  const record = ctl.state.get("vm", name);
  const reason = held ? releaseReason(record, held) : null;
  return {
    ownerOid: record?.ownerOid ?? null,
    attached: held ? { diskName: held.name, rootSessionId: held.lease?.rootSessionId ?? null, state: held.attach.state } : null,
    releaseRequested: reason ? { diskName: held.name, reason } : null,
    extendRequested: held?.growth ? { diskName: held.name, sizeGb: held.growth.targetGb } : null,
    draining: Boolean(record?.drain),
    frozen: Boolean(controllerRecord(ctl).upgradeFrozen),
  };
}

/** Binds a ready, unbound VM to an owner; its next heartbeat answer names the owner. */
export async function bindVm(ctl, name, ownerOid) {
  const now = ctl.now();
  let bound = false;
  await ctl.state.update("vm", name, (r) => {
    bound = false;
    if (!r || r.ownerOid || !isServing(r)) return undefined;
    bound = true;
    return { ...r, ownerOid, boundAt: now };
  });
  if (!bound) return false;
  if (!ctl.config.vms.ownerOnly) {
    const rt = vmRuntime(ctl, name);
    rt.bindingRestartSince = now;
    rt.expectedRestarts.push(now);
  }
  ctl.log.audit("vm.bind", { vm: name, owner: ownerOid });
  protectInBackground(ctl, name);
  return true;
}

/** Fences silent and crash-looping VMs, unless so many go quiet at once that the fault is more likely the controller's own path. */
export async function checkCrashes(ctl) {
  if (inGrace(ctl)) return;
  const active = ctl.state.all("vm").filter((r) => r.role === "worker" && r.activatedAt && !r.fence && !r.deleting
    && !r.stoppedForUpgrade && !r.start && !r.drain);
  const suspects = [];
  for (const record of active) {
    const rt = vmRuntime(ctl, record.name);
    if (isSilent(ctl, record)) suspects.push({ record, reason: "silent" });
    else {
      const loop = crashLoop(ctl, record, rt);
      if (loop) suspects.push({ record, reason: `crash-loop:${loop}` });
    }
  }
  if (suspects.length >= 2 && suspects.length > active.length / 2) {
    if (!ctl.runtime.massSilence) {
      ctl.log.alert("vms.mass-silence", { suspects: suspects.map((s) => `${s.record.name}:${s.reason}`), active: active.length });
    }
    ctl.runtime.massSilence = true;
    return;
  }
  ctl.runtime.massSilence = false;
  for (const { record, reason } of suspects) {
    await startFence(ctl, record.name, reason, reason.startsWith("crash-loop") ? "vms.crash-loop" : null);
  }
}

/**
 * Fences a VM: deletes it without a drain and keeps the fence in the state
 * until Azure confirms the deletion. Only then can its drive move.
 */
export async function startFence(ctl, name, reason, alertEvent = null) {
  const now = ctl.now();
  let started = false;
  const record = await ctl.state.update("vm", name, (r) => {
    started = false;
    if (!r || r.fence) return undefined;
    started = true;
    return { ...r, fence: { reason, startedAt: now, lastAttemptAt: now, quarantined: false } };
  });
  if (!started) return false;
  const drive = driveOnVm(ctl.state.all("disk"), name);
  ctl.log.audit("vm.fence", { vm: name, reason, owner: record.ownerOid, drive: drive?.name ?? null });
  if (alertEvent) ctl.log.alert(alertEvent, { vm: name, reason, owner: record.ownerOid });
  deleteFencedVm(ctl, name);
  return true;
}

/**
 * Azure does not document removing a VM's data collection rule association
 * with the VM, and it documents that diagnostic settings, another Azure
 * Monitor extension resource, outlive theirs. So a fence removes the
 * association as a drained deletion does, but beside the deletion rather than
 * before it: a slow or failed answer there must not hold up the fence that
 * frees the drive. Each retry of the deletion retries the removal too.
 */
function deleteFencedVm(ctl, name) {
  ctl.background(`dissociate ${name}`, ctl.azure.dissociateDcr(name));
  ctl.background(`fence ${name}`, ctl.azure.deleteVm(name));
}

/** Confirms fenced VMs' deletions, retries them, and quarantines the leases of drives whose VM is not confirmed gone in time. */
export async function progressFences(ctl) {
  for (const record of ctl.state.all("vm").filter((r) => r.fence)) {
    if (!(await ctl.azure.getVm(record.name))) {
      await vmGone(ctl, record.name, { crashed: true });
      continue;
    }
    const now = ctl.now();
    if (!record.fence.quarantined && now - record.fence.startedAt > TIMING.fenceConfirmMs) {
      for (const disk of ctl.state.all("disk").filter((d) => d.attach?.vmName === record.name && d.lease)) {
        await ctl.state.update("disk", disk.name, (d) => {
          if (!d?.lease || d.attach?.vmName !== record.name) return undefined;
          d.lease.quarantined = { since: now, reason: "fence-unconfirmed", vm: record.name };
          return withState(d);
        });
        ctl.log.alert("drive.quarantine", { drive: disk.name, vm: record.name, owner: disk.lease.ownerOid, workId: disk.lease.workId });
      }
      await ctl.state.update("vm", record.name, (r) => (r?.fence ? { ...r, fence: { ...r.fence, quarantined: true } } : undefined));
    }
    if (now - record.fence.lastAttemptAt >= FENCE_RETRY_MS) {
      await ctl.state.update("vm", record.name, (r) => (r?.fence ? { ...r, fence: { ...r.fence, lastAttemptAt: now } } : undefined));
      deleteFencedVm(ctl, record.name);
    }
  }
}

/** Azure confirmed the VM gone: its drives are detached (deleteOption Detach) and may move. */
export async function vmGone(ctl, name, { crashed }) {
  for (const disk of ctl.state.all("disk").filter((d) => d.attach?.vmName === name)) {
    await ctl.state.update("disk", disk.name, (d) => {
      if (!d || d.attach?.vmName !== name) return undefined;
      d.attach = null;
      d.needsFsck = true;
      if (crashed) d.takeover = true;
      if (d.lease) {
        d.lease.move = null;
        d.lease.quarantined = null;
      }
      return withState(d);
    });
    ctl.log.audit("drive.detached", { drive: disk.name, vm: name, by: crashed ? "fence" : "delete" });
  }
  await ctl.state.update("vm", name, () => null);
  ctl.runtime.vms.delete(name);
  ctl.runtime.azureVms.delete(name);
  ctl.log.audit("vm.deleted", { vm: name, crashed });
  await finishDetachedReturns(ctl);
}

/**
 * Drains a VM with the Managed Run Command Drain-And-StopWorker.ps1. With
 * `deleteAfter`, the VM is deleted once the command ends (recycling);
 * without it, the VM stays stopped for an upgrade.
 */
export async function startDrain(ctl, name, reason, { deleteAfter }) {
  const now = ctl.now();
  const command = `pilotswarm-drain-${now}`;
  let started = false;
  const record = await ctl.state.update("vm", name, (r) => {
    started = false;
    if (!r || r.drain || r.fence || r.deleting) return undefined;
    started = true;
    return { ...r, drain: { reason, startedAt: now, command, deleteAfter, issued: false, restartAfter: false } };
  });
  if (!started) return false;
  ctl.log.audit("vm.drain", { vm: name, reason, owner: record.ownerOid, deleteAfter });
  issueRunCommand(ctl, name, command, drainScript(ctl.config.vmScriptsDir), "drain");
  return true;
}

function issueRunCommand(ctl, name, command, script, field) {
  ctl.background(`run ${command} on ${name}`, (async () => {
    await ctl.azure.startRunCommand(name, command, script, {
      location: ctl.runtime.scaleSet?.location,
      timeoutSeconds: TIMING.runCommandTimeoutSeconds,
    });
    await ctl.state.update("vm", name, (r) => (r?.[field]?.command === command ? { ...r, [field]: { ...r[field], issued: true } } : undefined));
  })());
}

async function deleteDrainedVm(ctl, name) {
  await ctl.azure.dissociateDcr(name);
  await ctl.azure.deleteVm(name);
}

/** Follows drains, deletions and the freeze's service starts to their end. */
export async function progressDrains(ctl) {
  const now = ctl.now();
  for (const record of ctl.state.all("vm")) {
    if (record.drain) {
      const result = await ctl.azure.runCommandResult(record.name, record.drain.command);
      if (!result) {
        if (record.drain.issued || now - record.drain.startedAt > MINUTE) {
          issueRunCommand(ctl, record.name, record.drain.command, drainScript(ctl.config.vmScriptsDir), "drain");
        }
        continue;
      }
      if (!TERMINAL_RUN_STATES.has(result.state)) continue;
      ctl.log.audit("vm.drained", { vm: record.name, outcome: result.state, exitCode: result.exitCode, reason: record.drain.reason });
      ctl.background(`delete run command on ${record.name}`, ctl.azure.deleteRunCommand(record.name, record.drain.command));
      if (record.drain.deleteAfter) {
        await ctl.state.update("vm", record.name, (r) => (r ? { ...r, drain: null, deleting: { since: now, lastAttemptAt: now, reason: record.drain.reason } } : undefined));
        ctl.background(`delete ${record.name}`, deleteDrainedVm(ctl, record.name));
      } else if (record.drain.restartAfter) {
        await ctl.state.update("vm", record.name, (r) => (r ? { ...r, drain: null, stoppedForUpgrade: true, stopFailed: result.state !== "Succeeded" } : undefined));
        await startWorkerService(ctl, record.name);
      } else {
        await ctl.state.update("vm", record.name, (r) => (r ? { ...r, drain: null, stoppedForUpgrade: true, stopFailed: result.state !== "Succeeded" } : undefined));
      }
    } else if (record.deleting) {
      if (!(await ctl.azure.getVm(record.name))) await vmGone(ctl, record.name, { crashed: false });
      else if (now - record.deleting.lastAttemptAt >= FENCE_RETRY_MS) {
        await ctl.state.update("vm", record.name, (r) => (r?.deleting ? { ...r, deleting: { ...r.deleting, lastAttemptAt: now } } : undefined));
        ctl.background(`delete ${record.name}`, deleteDrainedVm(ctl, record.name));
      }
    } else if (record.start) {
      const result = await ctl.azure.runCommandResult(record.name, record.start.command);
      if (!result) {
        if (record.start.issued || now - record.start.startedAt > MINUTE) issueRunCommand(ctl, record.name, record.start.command, START_WORKER_SCRIPT, "start");
        continue;
      }
      if (!TERMINAL_RUN_STATES.has(result.state)) continue;
      // The VM's heartbeat window starts when the command ends; a VM that
      // stays silent then is handled as a crash.
      await ctl.state.update("vm", record.name, (r) => (r ? { ...r, start: null, stoppedForUpgrade: false, stopFailed: false, unfreezeAt: now } : undefined));
      vmRuntime(ctl, record.name).expectedRestarts.push(now);
      ctl.log.audit("vm.started", { vm: record.name, outcome: result.state, exitCode: result.exitCode });
      ctl.background(`delete run command on ${record.name}`, ctl.azure.deleteRunCommand(record.name, record.start.command));
    }
  }
}

async function startWorkerService(ctl, name) {
  const now = ctl.now();
  const command = `pilotswarm-start-${now}`;
  let started = false;
  await ctl.state.update("vm", name, (r) => {
    started = false;
    if (!r?.stoppedForUpgrade || r.start) return undefined;
    started = true;
    return { ...r, start: { startedAt: now, command, issued: false } };
  });
  if (started) issueRunCommand(ctl, name, command, START_WORKER_SCRIPT, "start");
}

/**
 * POST /v1/admin/upgrade-freeze. Freezing stops scale-out, activation and
 * attaches, and stops the worker service on every active VM; the VMs keep
 * running. Unfreezing starts the service again on them.
 */
export async function setFrozen(ctl, frozen, by) {
  const now = ctl.now();
  await updateController(ctl, (c) => ({ ...c, upgradeFrozen: frozen, frozenAt: frozen ? (c.upgradeFrozen ? c.frozenAt : now) : null }));
  ctl.log.audit("pool.upgrade-freeze", { frozen, by });
  for (const record of ctl.state.all("vm").filter((r) => r.role === "worker" && r.activatedAt && !r.fence && !r.deleting)) {
    if (frozen) {
      if (record.start) continue;
      if (record.drain?.reason === "upgrade-freeze" && record.drain.restartAfter) {
        await ctl.state.update("vm", record.name, (r) => (r?.drain ? { ...r, drain: { ...r.drain, restartAfter: false } } : undefined));
      } else if (!record.drain && !record.stoppedForUpgrade) {
        await startDrain(ctl, record.name, "upgrade-freeze", { deleteAfter: false });
      }
    } else if (record.drain?.reason === "upgrade-freeze") {
      await ctl.state.update("vm", record.name, (r) => (r?.drain ? { ...r, drain: { ...r.drain, restartAfter: true } } : undefined));
    } else if (record.stoppedForUpgrade) {
      await startWorkerService(ctl, record.name);
    }
  }
  return freezeStatus(ctl);
}

/** GET /v1/admin/upgrade-freeze: the freeze and each active VM's stop. */
export function freezeStatus(ctl) {
  const c = controllerRecord(ctl);
  const vms = ctl.state.all("vm").filter((r) => r.role === "worker" && r.activatedAt && !r.fence && !r.deleting)
    .map((r) => ({
      name: r.name,
      ownerOid: r.ownerOid,
      stoppedForUpgrade: r.stoppedForUpgrade,
      stopping: r.drain?.reason === "upgrade-freeze",
      draining: Boolean(r.drain && r.drain.reason !== "upgrade-freeze"),
      stopFailed: Boolean(r.stopFailed),
      starting: Boolean(r.start),
    }));
  return {
    frozen: Boolean(c.upgradeFrozen),
    frozenAt: c.frozenAt ? new Date(c.frozenAt).toISOString() : null,
    allStopped: Boolean(c.upgradeFrozen) && vms.every((vm) => (vm.stoppedForUpgrade && !vm.stopFailed) || vm.draining),
    vms,
  };
}

/** After a deploy changes the image or configuration version, deletes the standby VMs so the pool refills from the new model. */
export async function checkRollout(ctl) {
  if (!ctl.runtime.scaleSet) return;
  const want = { imageVersion: ctl.config.imageVersion, configVersion: ctl.config.configVersion };
  const recorded = controllerRecord(ctl).rollout;
  if (recorded && recorded.imageVersion === want.imageVersion && recorded.configVersion === want.configVersion) return;
  if (recorded) {
    const standby = [...ctl.runtime.azureVms.values()].filter((vm) => vm.inStandbyPool);
    for (const vm of standby) ctl.background(`delete standby ${vm.name}`, ctl.azure.deleteVm(vm.name));
    ctl.log.audit("pool.rollout", { from: recorded, to: want, standbyDeleted: standby.map((vm) => vm.name) });
  }
  await updateController(ctl, (c) => ({ ...c, rollout: want }));
}
