// The weekly golden-snapshot refresh, on the controller's own timer:
//
//   1. while the pool is below X, scale out one VM that never activates;
//   2. attach a drive copied from the current golden snapshot and run
//      Seed-WorkerReposDisk.ps1 -Refresh there as a Managed Run Command;
//   3. verify the drive (-Verify answers { verified, manifestSha256, checks });
//   4. take an incremental snapshot, wait for CompletionPercent 100, record it
//      as the golden snapshot, keep the one it replaces as previousGolden
//      (GET /v1/admin/status shows it; nothing rolls back to it) and delete
//      older ones that the controller made; then delete the drive and the VM.
//
// A failed step keeps the current snapshot, deletes the drive and the VM and
// raises the refresh alert. A copy, the drive's or the snapshot's, fails its
// step as soon as Azure reports it `Failed`, or when it is still copying after
// 6 hours. The run's progress is kept in controller.json, so a controller
// restart picks it up. Nothing starts or continues while the pool is frozen
// for an upgrade.
//
// A run's end moves its drive's name to `refreshDisks` in controller.json, in
// the same write that clears the run, and every refresh check deletes the
// drives listed there until Azure confirms them gone. So a failed deletion
// never orphans a drive, and only drives of finished runs are ever deleted.
import { randomBytes } from "node:crypto";
import { MINUTE, TIMING } from "./model.mjs";
import { controllerRecord, goldenSnapshotId, updateController } from "./controller-record.mjs";
import { TERMINAL_RUN_STATES, lastJsonLine, refreshScript, verifyScript } from "./run-commands.mjs";
import { scaleOut } from "./scaling.mjs";

export const REFRESH_CHECK_MS = 5 * MINUTE;
const AWAIT_VM_MS = 30 * MINUTE;
const AWAIT_COPY_MS = 6 * 60 * MINUTE;

async function setRun(ctl, mutate) {
  await updateController(ctl, (c) => (c.refresh ? { ...c, refresh: mutate({ ...c.refresh }) } : undefined));
  return controllerRecord(ctl).refresh;
}

function due(ctl, c) {
  if (ctl.config.snapshotRefreshMs <= 0 || c.refresh || !goldenSnapshotId(ctl)) return false;
  const since = c.lastRefreshAt ?? c.golden?.recordedAt ?? c.refreshBaselineAt ?? null;
  return since !== null && ctl.now() - since >= ctl.config.snapshotRefreshMs;
}

/**
 * Why an unfinished copy, the drive's or the snapshot's, ends its run: Azure
 * reports it `Failed`, which it does not come back from, or it is still
 * copying after AWAIT_COPY_MS. Null while it may still finish. The Windows
 * image's seed script stops on `Failed` the same way.
 */
function copyFailure(resource, run, now, { failed, timedOut }) {
  if (resource?.provisioningState === "Failed") return { reason: failed, provisioningState: resource.provisioningState };
  return now - run.phaseSince > AWAIT_COPY_MS ? { reason: timedOut } : null;
}

async function finish(ctl, run, outcome, details = {}) {
  const now = ctl.now();
  if (run.vmName) {
    await ctl.state.update("vm", run.vmName, (r) => (r && !r.deleting ? { ...r, deleting: { since: now, lastAttemptAt: now, reason: "snapshot-refresh" } } : undefined));
  }
  await updateController(ctl, (c) => ({
    ...c,
    refresh: null,
    refreshDisks: run.diskName && !c.refreshDisks.some((entry) => entry.name === run.diskName)
      ? [...c.refreshDisks, { name: run.diskName, run: run.id, since: now }]
      : c.refreshDisks,
    lastRefreshAt: outcome === "aborted" ? c.lastRefreshAt : now,
    pending: c.pending.filter((entry) => entry.purpose !== "refresh"),
  }));
  ctl.background(`clean up refresh ${run.id}`, (async () => {
    // The drive detaches when its VM goes (deleteOption Detach); only then can it be deleted.
    if (run.vmName) await ctl.azure.deleteVm(run.vmName);
    if (run.diskName) deleteRefreshDisk(ctl, run.diskName);
  })());
  if (outcome === "failed") ctl.log.alert("snapshot.refresh-failed", { run: run.id, phase: run.phase, ...details });
  else ctl.log.audit(`snapshot.refresh-${outcome}`, { run: run.id, ...details });
}

/** Deletes a finished run's drive and drops it from `refreshDisks` once Azure confirms it gone; a failure waits for the next check. */
function deleteRefreshDisk(ctl, name) {
  if (ctl.runtime.deleting.has(name)) return;
  ctl.runtime.deleting.add(name);
  ctl.background(`delete refresh drive ${name}`, (async () => {
    try {
      const disk = await ctl.azure.getDisk(name);
      // Still on its VM, whose deletion (retried with the drains) detaches it.
      if (disk?.managedBy) return;
      if (disk) {
        await ctl.azure.deleteDisk(name);
        ctl.log.audit("snapshot.refresh-drive-deleted", { drive: name });
      }
      await updateController(ctl, (c) => (c.refreshDisks.some((entry) => entry.name === name)
        ? { ...c, refreshDisks: c.refreshDisks.filter((entry) => entry.name !== name) }
        : undefined));
    } finally {
      ctl.runtime.deleting.delete(name);
    }
  })());
}

/** Every check: the drives of finished runs that are still there, never the live run's. */
function cleanUpRefreshDisks(ctl) {
  const c = controllerRecord(ctl);
  for (const entry of c.refreshDisks) {
    if (entry.name !== c.refresh?.diskName) deleteRefreshDisk(ctl, entry.name);
  }
}

async function runCommandStep(ctl, run, script, next) {
  if (!run.command) {
    const command = `pilotswarm-refresh-${run.phase}-${ctl.now()}`;
    await ctl.azure.startRunCommand(run.vmName, command, script, { location: ctl.runtime.scaleSet?.location, timeoutSeconds: TIMING.runCommandTimeoutSeconds });
    await setRun(ctl, (r) => ({ ...r, command }));
    return null;
  }
  const result = await ctl.azure.runCommandResult(run.vmName, run.command);
  if (!result || !TERMINAL_RUN_STATES.has(result.state)) return null;
  ctl.background(`delete run command on ${run.vmName}`, ctl.azure.deleteRunCommand(run.vmName, run.command));
  await setRun(ctl, (r) => ({ ...r, command: null, phase: next, phaseSince: ctl.now() }));
  return result;
}

/** One step of the refresh: starts a due run, or moves the running one on. */
export async function progressRefresh(ctl) {
  if (!ctl.azure) return;
  cleanUpRefreshDisks(ctl);
  if (!ctl.runtime.scaleSet) return;
  let c = controllerRecord(ctl);
  if (!c.refreshBaselineAt && goldenSnapshotId(ctl)) {
    await updateController(ctl, (rec) => (rec.refreshBaselineAt ? undefined : { ...rec, refreshBaselineAt: ctl.now() }));
    c = controllerRecord(ctl);
  }
  if (c.upgradeFrozen) {
    if (c.refresh) await finish(ctl, c.refresh, "aborted", { reason: "upgrade-freeze" });
    return;
  }
  if (!c.refresh) {
    if (!due(ctl, c)) return;
    const id = randomBytes(4).toString("hex");
    await updateController(ctl, (rec) => (rec.refresh ? undefined : {
      ...rec,
      refresh: { id, phase: "scale-out", startedAt: ctl.now(), phaseSince: ctl.now(), sourceSnapshotId: goldenSnapshotId(ctl) },
    }));
    ctl.log.audit("snapshot.refresh-started", { run: id, snapshot: goldenSnapshotId(ctl) });
    c = controllerRecord(ctl);
  }
  const run = c.refresh;
  const now = ctl.now();
  try {
    switch (run.phase) {
      case "scale-out": {
        const added = await scaleOut(ctl, [{ purpose: "refresh" }]);
        if (added > 0) await setRun(ctl, (r) => ({ ...r, phase: "await-vm", phaseSince: now }));
        return;
      }
      case "await-vm": {
        const vm = ctl.state.all("vm").find((record) => record.role === "refresh" && !record.fence && !record.deleting);
        if (vm) {
          await setRun(ctl, (r) => ({ ...r, vmName: vm.name, phase: "create-disk", phaseSince: now }));
        } else if (now - run.phaseSince > AWAIT_VM_MS) {
          await finish(ctl, run, "failed", { reason: "no VM arrived" });
        }
        return;
      }
      case "create-disk": {
        const diskName = run.diskName ?? `psrefresh-${randomBytes(6).toString("hex")}`;
        if (!run.diskName) await setRun(ctl, (r) => ({ ...r, diskName }));
        await ctl.azure.createDisk(diskName, {
          snapshotId: run.sourceSnapshotId,
          sizeGb: ctl.config.drives.sizeGb,
          iops: ctl.config.drives.iops,
          mbps: ctl.config.drives.mbps,
          location: ctl.runtime.scaleSet.location,
          zones: ctl.runtime.scaleSet.zones,
        });
        await setRun(ctl, (r) => ({ ...r, phase: "await-disk", phaseSince: now }));
        return;
      }
      case "await-disk": {
        const disk = await ctl.azure.getDisk(run.diskName);
        if (disk?.provisioningState === "Succeeded" && (disk.completionPercent ?? 100) >= 100) {
          await ctl.azure.attachDisk(run.vmName, run.diskName);
          await setRun(ctl, (r) => ({ ...r, phase: "seed", phaseSince: now }));
          return;
        }
        const failure = copyFailure(disk, run, now, { failed: "the drive failed to provision", timedOut: "the drive did not hydrate" });
        if (failure) await finish(ctl, run, "failed", { ...failure, drive: run.diskName });
        return;
      }
      case "seed": {
        const result = await runCommandStep(ctl, run, refreshScript(ctl.config.vmScriptsDir), "verify");
        if (result && (result.state !== "Succeeded" || result.exitCode !== 0)) {
          await finish(ctl, { ...run, phase: "seed" }, "failed", { reason: "the refresh script failed", outcome: result.state, exitCode: result.exitCode });
        }
        return;
      }
      case "verify": {
        const result = await runCommandStep(ctl, run, verifyScript(ctl.config.vmScriptsDir), "detach");
        if (!result) return;
        const verdict = lastJsonLine(result.output);
        const ok = result.state === "Succeeded" && result.exitCode === 0 && verdict?.verified === true
          && typeof verdict.manifestSha256 === "string" && /^[0-9a-f]{64}$/i.test(verdict.manifestSha256);
        if (!ok) {
          await finish(ctl, { ...run, phase: "verify" }, "failed", { reason: "the drive failed verification", checks: verdict?.checks ?? null });
          return;
        }
        await setRun(ctl, (r) => ({ ...r, manifestSha256: verdict.manifestSha256.toLowerCase() }));
        return;
      }
      case "detach": {
        await ctl.azure.detachDisk(run.vmName, run.diskName);
        await setRun(ctl, (r) => ({ ...r, phase: "snapshot", phaseSince: now }));
        return;
      }
      case "snapshot": {
        const snapshotName = run.snapshotName ?? `pilotswarm-golden-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${run.id}`;
        if (!run.snapshotName) await setRun(ctl, (r) => ({ ...r, snapshotName }));
        const snapshotId = await ctl.azure.createSnapshot(snapshotName, { diskName: run.diskName, location: ctl.runtime.scaleSet.location });
        await setRun(ctl, (r) => ({ ...r, snapshotId, phase: "await-snapshot", phaseSince: now }));
        return;
      }
      case "await-snapshot": {
        const snapshot = await ctl.azure.getSnapshot(run.snapshotId);
        if (snapshot?.provisioningState === "Succeeded" && (snapshot.completionPercent ?? 100) >= 100) {
          await recordGolden(ctl, run);
          await finish(ctl, run, "completed", { snapshot: run.snapshotId, manifestSha256: run.manifestSha256 });
          return;
        }
        const failure = copyFailure(snapshot, run, now, { failed: "the snapshot failed to provision", timedOut: "the snapshot did not complete" });
        if (failure) {
          await finish(ctl, run, "failed", { ...failure, snapshot: run.snapshotId });
          ctl.background(`delete snapshot ${run.snapshotId}`, ctl.azure.deleteSnapshot(run.snapshotId));
        }
        return;
      }
      default:
        await finish(ctl, run, "failed", { reason: `unknown phase ${run.phase}` });
    }
  } catch (err) {
    ctl.log.error("snapshot.refresh-step-failed", { run: run.id, phase: run.phase, error: err?.message ?? String(err) });
    const failures = (run.failures ?? 0) + 1;
    if (failures >= 5) await finish(ctl, run, "failed", { reason: err?.message ?? String(err) });
    else await setRun(ctl, (r) => ({ ...r, failures }));
  }
}

/** The new snapshot becomes golden; the previous one stays as previousGolden; older ones the controller made are deleted. */
async function recordGolden(ctl, run) {
  const now = ctl.now();
  let older = null;
  await updateController(ctl, (c) => {
    const current = c.golden ?? (ctl.config.goldenSnapshotId ? { id: ctl.config.goldenSnapshotId, recordedAt: null, made: false } : null);
    older = c.previousGolden;
    return {
      ...c,
      previousGolden: current,
      golden: { id: run.snapshotId, recordedAt: now, made: true, manifestSha256: run.manifestSha256 },
    };
  });
  if (older?.made) ctl.background(`delete snapshot ${older.id}`, ctl.azure.deleteSnapshot(older.id));
  ctl.log.audit("snapshot.golden", { snapshot: run.snapshotId, manifestSha256: run.manifestSha256, deleted: older?.made ? older.id : null });
}
