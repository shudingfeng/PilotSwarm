// The controller's vocabulary: drive states, timings and the pure helpers
// that the drive pool, the VM fleet and the routes share.

export const DRIVE = Object.freeze({
  HYDRATING: "Hydrating",
  AVAILABLE: "AvailableInPool",
  ASSIGNED: "AssignedUnattached",
  ATTACHED: "AttachedActive",
  PARKED: "Parked",
  RETURNING: "Returning",
});

export const MINUTE = 60_000;
export const GIB = 1024 ** 3;

export const TIMING = Object.freeze({
  tickMs: 15_000,
  parkedRetryMs: 900_000,
  quarantineRetryMs: 900_000,
  frozenRetryMs: 30_000,
  holderSilentRetryMs: 30_000,
  moveRetryMs: 10_000,
  busyRetryMs: 10_000,
  hydratingRetryMs: 30_000,
  poolFullRetryMs: 60_000,
  notReadyRetryMs: 60_000,
  releaseDeadlineMs: 10 * MINUTE,
  silenceMs: 60_000,
  bindingWindowMs: 3 * MINUTE,
  unfreezeWindowMs: 3 * MINUTE,
  startWindowMs: 10 * MINUTE,
  launchWindowMs: 15 * MINUTE,
  maxLaunches: 4,
  minUptimeMs: 15 * MINUTE,
  fenceConfirmMs: 15 * MINUTE,
  growthAlertMs: 15 * MINUTE,
  maxConcurrentCopies: 4,
  pendingScaleOutMs: 20 * MINUTE,
  demandMs: 30 * MINUTE,
  runCommandTimeoutSeconds: 7200,
});

const ID = /^[0-9A-Za-z][0-9A-Za-z._:@-]{0,199}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (value) => typeof value === "string" && ID.test(value);
export const isGuid = (value) => typeof value === "string" && GUID.test(value);

/** The state a drive record's fields describe. */
export function driveState(disk) {
  const lease = disk.lease;
  if (!lease) return disk.hydrated ? DRIVE.AVAILABLE : DRIVE.HYDRATING;
  if (lease.returningSince) return DRIVE.RETURNING;
  if (lease.parkedAt) return DRIVE.PARKED;
  return disk.attach?.state === "attached" ? DRIVE.ATTACHED : DRIVE.ASSIGNED;
}

/** The record with its `state` recomputed; every write goes through it. */
export function withState(disk) {
  disk.state = driveState(disk);
  return disk;
}

/** Why a lease can't be used now, or null: parked, returning or quarantined. */
export function leaseBusy(disk) {
  const lease = disk?.lease;
  if (!lease) return null;
  if (lease.returningSince) return { reason: "RETURNING", retryAfterMs: TIMING.parkedRetryMs, message: "Dev Drive is being returned" };
  if (lease.parkedAt) return { reason: "PARKED", retryAfterMs: TIMING.parkedRetryMs, message: "Dev Drive is parked for local work" };
  if (lease.quarantined) return { reason: "QUARANTINED", retryAfterMs: TIMING.quarantineRetryMs, message: "Dev Drive is quarantined until its last VM is confirmed deleted" };
  return null;
}

export function busy(reason, retryAfterMs, message) {
  return { code: "WORKSPACE_BUSY", reason, retryAfterMs, message };
}

/** The live (not returning) lease of a root session, as its drive record, or null. */
export function driveOfRoot(disks, rootSessionId) {
  return disks.find((disk) => disk.lease && !disk.lease.returningSince && disk.lease.rootSessionId === rootSessionId) ?? null;
}

/**
 * The lease a root session's requests are answered from, as its drive record,
 * or null: its live lease, else one still Returning, which answers busy until
 * the return completes. Only then does the root hold no lease.
 */
export function leaseOfRoot(disks, rootSessionId) {
  return driveOfRoot(disks, rootSessionId)
    ?? disks.find((disk) => disk.lease?.returningSince && disk.lease.rootSessionId === rootSessionId)
    ?? null;
}

/** The live (not returning) lease of a work, as its drive record, or null. */
export function driveOfWork(disks, workId) {
  return disks.find((disk) => disk.lease && !disk.lease.returningSince && disk.lease.workId === workId) ?? null;
}

/** The drive the attach record has on a VM, or null. */
export function driveOnVm(disks, vmName) {
  return disks.find((disk) => disk.attach?.vmName === vmName) ?? null;
}

/** A drive's lease without its credential, for answers and logs. */
export function leaseView(disk) {
  const lease = disk.lease;
  return {
    diskName: disk.name,
    state: disk.state,
    sizeGb: disk.sizeGb,
    attachedTo: disk.attach?.vmName ?? null,
    ...(lease
      ? {
        workId: lease.workId,
        rootSessionId: lease.rootSessionId,
        ownerOid: lease.ownerOid,
        leasedAt: new Date(lease.leasedAt).toISOString(),
        hasCredential: Boolean(lease.credential),
        quarantined: Boolean(lease.quarantined),
      }
      : {}),
  };
}
