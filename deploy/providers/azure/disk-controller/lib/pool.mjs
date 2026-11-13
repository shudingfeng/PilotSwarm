// The drive pool: claims and the dispatcher's lease operations, attach and
// detach, release requests through heartbeat answers, and the pool's own
// upkeep on every tick: hydration, spares, resets and deletions of returned
// drives, lease expiry, online growth and the 10-minute release deadline.
//
// The drive record is the attach record too: `attach` names the VM that
// holds the drive, written before and after every attachDetachDataDisks call.
// Operations on one drive run under its mutex (`disk:<name>`), operations on
// one VM's LUN 0 under the VM's (`vm:<name>`), always in that order.
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./http.mjs";
import { GIB, MINUTE, TIMING, busy, driveOfWork, driveOnVm, isGuid, isId, leaseBusy, leaseOfRoot, leaseView, withState } from "./model.mjs";
import { controllerRecord, goldenSnapshotId, updateController } from "./controller-record.mjs";
import { inGrace, graceEnd, isServing, isSilent, startFence, vmRuntime } from "./fleet.mjs";
import { forgetDemand, recordDemand } from "./demand.mjs";

const CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DISK_NAME = /^psdrive-[0-9a-f]{12}$/;
const FULL_ALERT_REPEAT_MS = 60 * MINUTE;
const CREATION_RETRY_MS = 5 * MINUTE;

function bad(message) {
  return new HttpError(400, "BAD_REQUEST", message);
}

export function requireId(body, field) {
  if (!isId(body?.[field])) throw bad(`${field} is required: letters, digits and . _ : @ -, up to 200 characters.`);
  return body[field];
}

export function requireOwner(body, field = "ownerOid") {
  if (!isGuid(body?.[field])) throw bad(`${field} must be an object ID.`);
  return body[field].toLowerCase();
}

function requireCredential(body) {
  if (typeof body?.credential !== "string" || !CREDENTIAL.test(body.credential)) {
    throw bad("credential is required: 1 to 4096 printable characters without spaces.");
  }
  return body.credential;
}

function poolReady(ctl) {
  return Boolean(ctl.azure && ctl.runtime.scaleSet && goldenSnapshotId(ctl));
}

function newDiskName() {
  return `psdrive-${randomBytes(6).toString("hex")}`;
}

// ── dispatcher routes ────────────────────────────────────────────────

/**
 * POST /disk-pool/v1/disks/claim { workId, rootSessionId, ownerOid, credential }.
 * Idempotent per work: a repeat for the same root session returns the
 * work's lease as it is; another root session for the work gets 409.
 */
export async function claim(ctl, body) {
  const workId = requireId(body, "workId");
  const rootSessionId = requireId(body, "rootSessionId");
  const ownerOid = requireOwner(body);
  const credential = requireCredential(body);
  const answer = await ctl.locks.run("pool", async () => {
    const disks = ctl.state.all("disk");
    const existing = driveOfWork(disks, workId);
    if (existing) {
      if (existing.lease.rootSessionId !== rootSessionId || existing.lease.ownerOid !== ownerOid) {
        throw new HttpError(409, "WORK_HAS_ANOTHER_ROOT", "This work's drive is leased to another root session; only rebind moves a lease.");
      }
      return { decision: "ok", repeated: true, lease: leaseView(existing) };
    }
    if (!poolReady(ctl)) {
      return { decision: "busy", code: "NOT_READY", retryAfterMs: TIMING.notReadyRetryMs, message: "The worker pool is not ready yet: no scale set or no golden snapshot." };
    }
    const leased = disks.filter((disk) => disk.lease);
    const owned = leased.filter((disk) => !disk.lease.returningSince && disk.lease.ownerOid === ownerOid);
    if (owned.length >= ctl.config.drives.maxPerOwner) {
      return {
        decision: "deny",
        code: "OWNER_DRIVE_LIMIT",
        message: `The owner already holds ${owned.length} Dev Drives, the most allowed; return one first.`,
        leasedWorks: owned.map((disk) => ({ workId: disk.lease.workId, rootSessionId: disk.lease.rootSessionId, state: disk.state })),
      };
    }
    const spare = disks
      .filter((disk) => !disk.lease && disk.hydrated && !disk.deleting && !disk.creating)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!spare) {
      if (leased.length >= ctl.config.drives.poolCount) {
        const c = controllerRecord(ctl);
        if (!c.poolFullSince) {
          await updateController(ctl, (rec) => ({ ...rec, poolFullSince: ctl.now() }));
          ctl.log.alert("pool.full", { leased: leased.length, poolCount: ctl.config.drives.poolCount, workId, owner: ownerOid });
        }
        return { decision: "busy", code: "POOL_FULL", retryAfterMs: TIMING.poolFullRetryMs, message: "Every Dev Drive of the pool is leased; a return frees one." };
      }
      ctl.background("spares", maintainSpares(ctl));
      return { decision: "busy", code: "HYDRATING", retryAfterMs: TIMING.hydratingRetryMs, message: "No spare Dev Drive is ready yet; one is being copied." };
    }
    const now = ctl.now();
    const taken = await ctl.state.update("disk", spare.name, (disk) => {
      if (!disk || disk.lease || !disk.hydrated) return undefined;
      disk.lease = {
        workId,
        rootSessionId,
        ownerOid,
        leasedAt: now,
        lastUsedAt: now,
        credential,
        credentialSetAt: now,
        sync: null,
        parkedAt: null,
        returningSince: null,
        move: null,
        rebind: null,
        quarantined: null,
      };
      return withState(disk);
    });
    if (!taken?.lease || taken.lease.workId !== workId) throw new HttpError(503, "RETRY", "The drive changed while it was being leased; try again.");
    if (controllerRecord(ctl).poolFullSince) await updateController(ctl, (rec) => ({ ...rec, poolFullSince: null }));
    return { decision: "ok", repeated: false, lease: leaseView(taken) };
  });
  if (answer.decision === "ok" && !answer.repeated) {
    ctl.log.audit("drive.claim", { workId, root: rootSessionId, owner: ownerOid, drive: answer.lease.diskName });
    await recordDemand(ctl, { ownerOid, rootSessionId, kind: "claim" });
    ctl.background("spares", maintainSpares(ctl));
    ctl.kick();
  }
  return answer;
}

/** The work's live lease, under its drive's mutex, or 404. */
async function withWorkDrive(ctl, workId, fn) {
  const found = driveOfWork(ctl.state.all("disk"), workId);
  if (!found) throw new HttpError(404, "NO_LEASE", "This work holds no Dev Drive.");
  return ctl.locks.run(`disk:${found.name}`, async () => {
    const disk = ctl.state.get("disk", found.name);
    if (!disk?.lease || disk.lease.returningSince || disk.lease.workId !== workId) {
      throw new HttpError(404, "NO_LEASE", "This work holds no Dev Drive.");
    }
    return fn(disk);
  });
}

function checkRoot(disk, body) {
  if (body?.rootSessionId !== undefined && body.rootSessionId !== disk.lease.rootSessionId) {
    throw new HttpError(409, "WORK_HAS_ANOTHER_ROOT", "This work's drive is leased to another root session.");
  }
}

/** POST /disk-pool/v1/disks/park { workId }: parked for local work; a VM that holds the drive is asked to release it. */
export async function park(ctl, body) {
  const workId = requireId(body, "workId");
  const now = ctl.now();
  const disk = await withWorkDrive(ctl, workId, async (current) => {
    checkRoot(current, body);
    if (current.lease.parkedAt && !current.lease.syncWait) return current;
    return ctl.state.update("disk", current.name, (d) => {
      if (!d?.lease) return undefined;
      if (d.lease.parkedAt) {
        // A repeat park ends a refused sync-branch's wait: the park alone sets no release deadline.
        if (!d.lease.syncWait) return undefined;
        d.lease.syncWait = null;
        return withState(d);
      }
      d.lease.parkedAt = now;
      d.lease.credential = null;
      d.lease.sync = null;
      d.lease.handBack = null;
      d.lease.move = null;
      d.lease.lastUsedAt = now;
      return withState(d);
    });
  });
  await forgetDemand(ctl, disk.lease.rootSessionId);
  ctl.log.audit("drive.park", { workId, root: disk.lease.rootSessionId, drive: disk.name, attachedTo: disk.attach?.vmName ?? null });
  if (disk.attach) ctl.log.audit("drive.release-requested", { drive: disk.name, vm: disk.attach.vmName, reason: "park" });
  return { decision: "ok", lease: leaseView(disk) };
}

/**
 * POST /disk-pool/v1/disks/sync-branch { workId, sourceBranch, headSha, url,
 * credential }: hands a parked drive back. It unparks the drive, records the
 * branch to sync with a new syncId and sets the work's new per-work
 * credential. Only once no VM holds the parked drive: a holder's next turn
 * would reattach it without asking the controller and never get the record.
 * While one does, the call is refused like a rebind, the drive stays parked so
 * the park's release request goes on, and with no detach within 10 minutes of
 * the first refusal, the VM is fenced.
 *
 * A drive that isn't parked takes only a retry of its last hand-back, with the
 * same branch and head: the answer names that hand-back's syncId and the
 * call's credential is set, but no new sync is recorded, since a later attach
 * would apply it under the session's newer work. Anything else is refused
 * with 409 NOT_PARKED.
 */
export async function syncBranch(ctl, body) {
  const workId = requireId(body, "workId");
  const credential = requireCredential(body);
  if (typeof body.sourceBranch !== "string" || !BRANCH.test(body.sourceBranch)) throw bad("sourceBranch must be a branch name.");
  if (typeof body.headSha !== "string" || !SHA.test(body.headSha)) throw bad("headSha must be a full commit ID in lowercase hex.");
  let url;
  try {
    url = new URL(body.url);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || String(body.url).length > 2048) {
    throw bad("url must be an https URL without credentials.");
  }
  const now = ctl.now();
  const syncId = randomUUID();
  const result = await withWorkDrive(ctl, workId, async (current) => {
    checkRoot(current, body);
    if (!current.lease.parkedAt) {
      const handBack = current.lease.handBack;
      if (handBack?.sourceBranch !== body.sourceBranch || handBack?.headSha !== body.headSha) {
        throw new HttpError(409, "NOT_PARKED", "Only a parked drive takes a branch sync; park it first.");
      }
      const retried = await ctl.state.update("disk", current.name, (d) => {
        if (!d?.lease) return undefined;
        d.lease.credential = credential;
        d.lease.credentialSetAt = now;
        d.lease.lastUsedAt = now;
        return withState(d);
      });
      return { refused: null, disk: retried, repeatOf: handBack.syncId };
    }
    if (current.attach) {
      let first = false;
      await ctl.state.update("disk", current.name, (d) => {
        first = false;
        if (!d?.lease || d.lease.syncWait) return undefined;
        first = true;
        d.lease.syncWait = { since: now };
        return withState(d);
      });
      return { refused: { drive: current.name, vm: current.attach.vmName, first } };
    }
    const synced = await ctl.state.update("disk", current.name, (d) => {
      if (!d?.lease) return undefined;
      d.lease.parkedAt = null;
      d.lease.syncWait = null;
      d.lease.sync = { syncId, sourceBranch: body.sourceBranch, headSha: body.headSha, url: url.href, recordedAt: now };
      d.lease.handBack = { syncId, sourceBranch: body.sourceBranch, headSha: body.headSha };
      d.lease.credential = credential;
      d.lease.credentialSetAt = now;
      d.lease.lastUsedAt = now;
      return withState(d);
    });
    return { refused: null, disk: synced };
  });
  if (result.refused) {
    const { drive, vm, first } = result.refused;
    if (first) ctl.log.audit("drive.release-requested", { drive, vm, reason: "sync-branch" });
    return {
      decision: "busy",
      code: "DRIVE_ATTACHED",
      retryAfterMs: TIMING.moveRetryMs,
      message: "A VM still holds the drive; it has been asked to release it.",
    };
  }
  const disk = result.disk;
  if (result.repeatOf) {
    ctl.log.audit("drive.sync-branch", { workId, root: disk.lease.rootSessionId, drive: disk.name, syncId: result.repeatOf, headSha: body.headSha, host: url.host, repeat: true });
    return { decision: "ok", syncId: result.repeatOf, lease: leaseView(disk) };
  }
  ctl.log.audit("drive.sync-branch", { workId, root: disk.lease.rootSessionId, drive: disk.name, syncId, headSha: body.headSha, host: url.host });
  await recordDemand(ctl, { ownerOid: disk.lease.ownerOid, rootSessionId: disk.lease.rootSessionId, kind: "sync-branch" });
  ctl.kick();
  return { decision: "ok", syncId, lease: leaseView(disk) };
}

/**
 * POST /disk-pool/v1/disks/rebind { workId, rootSessionId, ownerOid, credential }:
 * moves the lease to the work's replacement root session, only while no VM
 * holds the drive. While one does, the call is refused and that VM is asked
 * to release the drive; with no detach within 10 minutes of the first
 * refusal, the VM is fenced.
 */
export async function rebind(ctl, body) {
  const workId = requireId(body, "workId");
  const rootSessionId = requireId(body, "rootSessionId");
  const ownerOid = requireOwner(body);
  const credential = requireCredential(body);
  const now = ctl.now();
  let previousRoot = null;
  const result = await withWorkDrive(ctl, workId, async (current) => {
    if (current.lease.ownerOid !== ownerOid) throw new HttpError(409, "OWNER_MISMATCH", "This work's drive belongs to another owner.");
    previousRoot = current.lease.rootSessionId;
    if (current.attach && current.lease.rootSessionId !== rootSessionId) {
      const refused = await ctl.state.update("disk", current.name, (d) => {
        if (!d?.lease || d.lease.rebind) return undefined;
        d.lease.rebind = { since: now, toRoot: rootSessionId };
        return withState(d);
      });
      return { refused, disk: refused };
    }
    const moved = await ctl.state.update("disk", current.name, (d) => {
      if (!d?.lease || (d.attach && d.lease.rootSessionId !== rootSessionId)) return undefined;
      d.lease.rootSessionId = rootSessionId;
      d.lease.credential = credential;
      d.lease.credentialSetAt = now;
      d.lease.rebind = null;
      d.lease.move = null;
      d.lease.lastUsedAt = now;
      return withState(d);
    });
    return { refused: null, disk: moved };
  });
  if (result.refused) {
    if (result.refused.lease.rebind?.since === now) {
      ctl.log.audit("drive.release-requested", { drive: result.refused.name, vm: result.refused.attach.vmName, reason: "rebind" });
    }
    return {
      decision: "busy",
      code: "DRIVE_ATTACHED",
      retryAfterMs: TIMING.moveRetryMs,
      message: "A VM still holds the drive; it has been asked to release it.",
    };
  }
  if (previousRoot !== rootSessionId) {
    await forgetDemand(ctl, previousRoot);
    ctl.log.audit("drive.rebind", { workId, from: previousRoot, to: rootSessionId, owner: ownerOid, drive: result.disk.name });
  }
  return { decision: "ok", lease: leaseView(result.disk) };
}

/**
 * POST /disk-pool/v1/disks/return { workId }: the lease turns Returning; the
 * drive is reset or deleted once no VM holds it. Idempotent: a work with no
 * live lease has nothing to return.
 */
export async function returnDrive(ctl, body) {
  const workId = requireId(body, "workId");
  const found = driveOfWork(ctl.state.all("disk"), workId);
  if (!found) return { decision: "ok", changed: false };
  const now = ctl.now();
  const disk = await ctl.locks.run(`disk:${found.name}`, () => ctl.state.update("disk", found.name, (d) => {
    if (!d?.lease || d.lease.returningSince || d.lease.workId !== workId) return undefined;
    d.lease.returningSince = now;
    d.lease.credential = null;
    d.lease.sync = null;
    d.lease.move = null;
    d.lease.rebind = null;
    d.lease.syncWait = null;
    d.lease.handBack = null;
    return withState(d);
  }));
  if (!disk?.lease || disk.lease.returningSince !== now) return { decision: "ok", changed: false };
  await forgetDemand(ctl, disk.lease.rootSessionId);
  ctl.log.audit("drive.return", { workId, root: disk.lease.rootSessionId, owner: disk.lease.ownerOid, drive: disk.name, attachedTo: disk.attach?.vmName ?? null });
  if (disk.attach) ctl.log.audit("drive.release-requested", { drive: disk.name, vm: disk.attach.vmName, reason: "return" });
  else ctl.background("returns", finishDetachedReturns(ctl));
  return { decision: "ok", changed: true, lease: leaseView(disk) };
}

/** POST /disk-pool/v1/disks/credential { workId, credential }: rotates the work's per-work credential. */
export async function rotateCredential(ctl, body) {
  const workId = requireId(body, "workId");
  const credential = requireCredential(body);
  const now = ctl.now();
  const disk = await withWorkDrive(ctl, workId, async (current) => {
    checkRoot(current, body);
    if (current.lease.parkedAt) throw new HttpError(409, "LEASE_PARKED", "The drive is parked; sync-branch sets the next credential.");
    return ctl.state.update("disk", current.name, (d) => {
      if (!d?.lease) return undefined;
      d.lease.credential = credential;
      d.lease.credentialSetAt = now;
      d.lease.lastUsedAt = now;
      return withState(d);
    });
  });
  ctl.log.audit("drive.credential-rotated", { workId, root: disk.lease.rootSessionId, drive: disk.name });
  return { decision: "ok", lease: leaseView(disk) };
}

// ── worker routes ────────────────────────────────────────────────────

function attachAnswer(disk) {
  const sync = disk.lease.sync;
  return {
    ok: true,
    diskName: disk.name,
    lun: 0,
    rootSessionId: disk.lease.rootSessionId,
    ownerOid: disk.lease.ownerOid,
    takeover: Boolean(disk.takeover),
    needsFsck: Boolean(disk.needsFsck),
    sync: sync ? { syncId: sync.syncId, sourceBranch: sync.sourceBranch, headSha: sync.headSha, url: sync.url } : null,
  };
}

const refusedAttach = (answer) => ({ ok: false, ...answer });

function holderUnavailable(ctl, holderName) {
  const holder = ctl.state.get("vm", holderName);
  return !holder || Boolean(holder.fence || holder.deleting) || (isServing(holder) && isSilent(ctl, holder));
}

/**
 * POST /v1/leases/attach { rootSessionId, requestId, purpose }: attaches the
 * work's drive at LUN 0 of the calling VM.
 */
export async function attach(ctl, vm, body) {
  const rootSessionId = requireId(body, "rootSessionId");
  if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128) throw bad("requestId is required.");
  if (body.purpose !== "turn" && body.purpose !== "check") throw bad("purpose must be turn or check.");
  if (inGrace(ctl)) {
    return refusedAttach(busy("CONTROLLER_STARTING", Math.max(5_000, graceEnd(ctl) - ctl.now()), "The disk controller is starting."));
  }
  if (controllerRecord(ctl).upgradeFrozen) return refusedAttach(busy("UPGRADE_FROZEN", TIMING.frozenRetryMs, "The pool is frozen for an upgrade."));
  const record = ctl.state.get("vm", vm.name);
  if (!record || record.drain || record.fence || record.deleting || record.stoppedForUpgrade || !record.activatedAt) {
    return refusedAttach(busy("VM_DRAINING", TIMING.frozenRetryMs, "This VM is draining or not active."));
  }
  const found = leaseOfRoot(ctl.state.all("disk"), rootSessionId);
  if (!found) return refusedAttach({ code: "NO_DRIVE_LEASE", retryable: false, message: "This root session holds no Dev Drive." });
  return ctl.locks.run(`disk:${found.name}`, async () => {
    const disk = ctl.state.get("disk", found.name);
    if (!disk?.lease || disk.lease.rootSessionId !== rootSessionId) {
      return refusedAttach({ code: "NO_DRIVE_LEASE", retryable: false, message: "This root session holds no Dev Drive." });
    }
    const leaseRefusal = leaseBusy(disk);
    if (leaseRefusal) return refusedAttach(busy(leaseRefusal.reason, leaseRefusal.retryAfterMs, leaseRefusal.message));
    const owner = disk.lease.ownerOid;
    if (!record.ownerOid) return refusedAttach(busy("VM_UNBOUND", TIMING.busyRetryMs, "This VM is not bound to an owner."));
    if (record.ownerOid !== owner) return refusedAttach(busy("OWNER_MISMATCH", TIMING.busyRetryMs, "This VM is bound to another owner."));
    const now = ctl.now();

    if (disk.attach && disk.attach.vmName !== vm.name) {
      const holder = disk.attach.vmName;
      if (holderUnavailable(ctl, holder)) {
        return refusedAttach(busy("HOLDER_SILENT", TIMING.holderSilentRetryMs, "The VM that holds the drive is silent or being fenced."));
      }
      if (body.purpose === "turn") {
        const moved = await ctl.state.update("disk", disk.name, (d) => {
          if (!d?.lease || d.lease.move) return undefined;
          d.lease.move = { since: now, toVm: vm.name };
          return withState(d);
        });
        if (moved?.lease?.move?.since === now) {
          ctl.log.audit("drive.release-requested", { drive: disk.name, vm: holder, reason: "move", requester: vm.name });
        }
      }
      return refusedAttach(busy("HELD_ELSEWHERE", TIMING.moveRetryMs, "Another VM holds the drive."));
    }

    if (disk.attach?.vmName === vm.name && disk.attach.state === "attached") {
      const cancelledMove = Boolean(disk.lease.move);
      const kept = await ctl.state.update("disk", disk.name, (d) => {
        if (!d?.lease) return undefined;
        d.lease.move = null;
        d.lease.lastUsedAt = now;
        return withState(d);
      });
      if (cancelledMove) ctl.log.audit("drive.move-cancelled", { drive: disk.name, vm: vm.name });
      await forgetDemand(ctl, rootSessionId);
      return attachAnswer(kept);
    }

    return ctl.locks.run(`vm:${vm.name}`, async () => {
      const other = driveOnVm(ctl.state.all("disk"), vm.name);
      if (other && other.name !== disk.name) {
        return refusedAttach(busy("LUN_BUSY", TIMING.busyRetryMs, "This VM holds another drive at LUN 0."));
      }
      await ctl.state.update("disk", disk.name, (d) => {
        if (!d?.lease) return undefined;
        d.attach = { vmName: vm.name, state: "attaching", since: now, requestId: body.requestId, purpose: body.purpose };
        return withState(d);
      });
      try {
        await ctl.azure.attachDisk(vm.name, disk.name);
      } catch (err) {
        const view = await ctl.azure.getVm(vm.name).catch(() => null);
        const onLun0 = view?.dataDisks?.some((d) => d.lun === 0 && String(d.diskName).toLowerCase() === disk.name.toLowerCase());
        if (!onLun0) {
          await ctl.state.update("disk", disk.name, (d) => {
            if (d?.attach?.vmName !== vm.name) return undefined;
            d.attach = null;
            return withState(d);
          });
          ctl.log.error("drive.attach-failed", { drive: disk.name, vm: vm.name, error: err });
          return refusedAttach(busy("ATTACH_FAILED", TIMING.busyRetryMs, "Azure could not attach the drive; try again."));
        }
      }
      const attached = await ctl.state.update("disk", disk.name, (d) => {
        if (!d?.lease) return undefined;
        d.attach = { vmName: vm.name, state: "attached", since: now, requestId: body.requestId, purpose: body.purpose };
        d.lease.move = null;
        d.lease.lastUsedAt = now;
        return withState(d);
      });
      vmRuntime(ctl, vm.name).idleSince = null;
      await forgetDemand(ctl, rootSessionId);
      ctl.log.audit("drive.attach", {
        drive: disk.name, vm: vm.name, root: rootSessionId, owner, purpose: body.purpose, requestId: body.requestId,
        takeover: Boolean(attached.takeover), needsFsck: Boolean(attached.needsFsck),
      });
      return attachAnswer(attached);
    });
  });
}

/**
 * POST /v1/leases/detach { diskName, rootSessionId, requestId, crashed? }.
 * Idempotent: only a drive that Azure shows on the calling VM is detached,
 * and a repeat changes nothing.
 */
export async function detach(ctl, vm, body) {
  if (typeof body.diskName !== "string" || !DISK_NAME.test(body.diskName)) throw bad("diskName must name a drive of this pool.");
  if (body.crashed !== undefined && typeof body.crashed !== "boolean") throw bad("crashed must be true or false.");
  const diskName = body.diskName;
  const crashed = body.crashed === true;
  const detached = await ctl.locks.run(`disk:${diskName}`, () => ctl.locks.run(`vm:${vm.name}`, async () => {
    const view = await ctl.azure.getVm(vm.name);
    const onVm = Boolean(view?.dataDisks?.some((d) => String(d.diskName).toLowerCase() === diskName.toLowerCase()));
    const disk = ctl.state.get("disk", diskName);
    if (onVm) {
      if (disk?.attach?.vmName === vm.name) {
        await ctl.state.update("disk", diskName, (d) => (d?.attach?.vmName === vm.name ? withState({ ...d, attach: { ...d.attach, state: "detaching" } }) : undefined));
      }
      await ctl.azure.detachDisk(vm.name, diskName);
    }
    if (disk) {
      await ctl.state.update("disk", diskName, (d) => {
        if (!d) return undefined;
        const heldHere = d.attach?.vmName === vm.name;
        if (!heldHere && !onVm) return undefined;
        if (heldHere) d.attach = null;
        if (crashed) d.needsFsck = true;
        else if (heldHere) {
          d.needsFsck = false;
          d.takeover = false;
        }
        if (d.lease) d.lease.move = null;
        return withState(d);
      });
    }
    return onVm;
  }));
  ctl.log.audit("drive.detach", { drive: diskName, vm: vm.name, root: typeof body.rootSessionId === "string" ? body.rootSessionId : null, crashed, detached });
  vmRuntime(ctl, vm.name).report = null;
  ctl.background("returns", finishDetachedReturns(ctl));
  return { ok: true, detached };
}

/**
 * POST /v1/vms/admit { sessionId, rootSessionId, isSystem }: admission before
 * every turn. Every decision is audited: the attach alert matches each drive
 * attach with an admission of its root on the same VM.
 */
export async function admit(ctl, vm, body) {
  const sessionId = requireId(body, "sessionId");
  const rootSessionId = requireId(body, "rootSessionId");
  if (typeof body.isSystem !== "boolean") throw bad("isSystem must be true or false.");
  const answer = await admission(ctl, vm, rootSessionId, body.isSystem);
  ctl.log.audit("vm.admit", {
    vm: vm.name, session: sessionId, root: rootSessionId, isSystem: body.isSystem,
    decision: answer.decision, code: answer.code ?? null, reason: answer.reason ?? null,
  });
  return answer;
}

async function admission(ctl, vm, rootSessionId, isSystem) {
  if (isSystem) {
    if (ctl.config.vms.ownerOnly) {
      return { decision: "busy", code: "WORKSPACE_BUSY", reason: "SYSTEM_SESSION", retryAfterMs: TIMING.poolFullRetryMs, message: "System sessions run on the coordination host." };
    }
    return { decision: "admit" };
  }
  const disk = leaseOfRoot(ctl.state.all("disk"), rootSessionId);
  if (!disk) return { decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive." };
  const refusal = leaseBusy(disk);
  if (refusal) return { decision: "busy", ...busy(refusal.reason, refusal.retryAfterMs, refusal.message) };
  const record = ctl.state.get("vm", vm.name);
  if (!record?.ownerOid) {
    await recordDemand(ctl, { ownerOid: disk.lease.ownerOid, rootSessionId, kind: "admit" });
    ctl.kick();
    return { decision: "busy", ...busy("VM_UNBOUND", TIMING.busyRetryMs, "This VM is not bound to the session's owner.") };
  }
  if (record.ownerOid !== disk.lease.ownerOid) {
    return { decision: "busy", ...busy("OWNER_MISMATCH", TIMING.busyRetryMs, "This VM is bound to another owner.") };
  }
  return { decision: "admit" };
}

// ── heartbeat answers ────────────────────────────────────────────────

/** Why the VM that holds a drive should release it, or null. */
export function releaseReason(record, disk) {
  const lease = disk.lease;
  if (!lease || lease.returningSince) return "return";
  if (lease.parkedAt) return "park";
  if (lease.rebind) return "rebind";
  if (lease.move) return "move";
  if (record?.drain) return "drain";
  return null;
}

/** A heartbeat from the VM that holds the drive: the applied branch sync and the growth's progress. */
export async function onHeartbeatForDrive(ctl, held, body, report) {
  let disk = held;
  if (disk.lease?.sync && typeof body.syncId === "string" && body.syncId === disk.lease.sync.syncId) {
    const syncId = body.syncId;
    disk = await ctl.state.update("disk", disk.name, (d) => {
      if (d?.lease?.sync?.syncId !== syncId) return undefined;
      d.lease.sync = null;
      return withState(d);
    });
    ctl.log.audit("drive.sync-applied", { drive: disk.name, syncId, headSha: typeof body.syncedHeadSha === "string" ? body.syncedHeadSha : null });
  }
  if (disk.growth && report && report.sizeBytes >= disk.growth.targetGb * GIB - GIB) {
    const target = disk.growth.targetGb;
    disk = await ctl.state.update("disk", disk.name, (d) => {
      if (d?.growth?.targetGb !== target) return undefined;
      d.sizeGb = target;
      d.growth = null;
      return withState(d);
    });
    ctl.log.audit("drive.grown", { drive: disk.name, sizeGb: target });
  }
  return disk;
}

// ── upkeep ───────────────────────────────────────────────────────────

/** Keeps WIN_DEV_DRIVE_SPARE_COUNT drives hydrated or hydrating, within the pool's size and four copies at a time. */
export async function maintainSpares(ctl) {
  if (!poolReady(ctl)) return;
  await ctl.locks.run("pool", async () => {
    const disks = ctl.state.all("disk");
    const unleased = disks.filter((disk) => !disk.lease && !disk.deleting);
    const copies = unleased.filter((disk) => !disk.hydrated).length;
    const need = Math.min(
      ctl.config.drives.spareCount - unleased.length,
      ctl.config.drives.poolCount - disks.length,
      TIMING.maxConcurrentCopies - copies,
    );
    for (let i = 0; i < need; i++) await createSpare(ctl);
  });
}

async function createSpare(ctl) {
  const name = newDiskName();
  const now = ctl.now();
  const snapshotId = goldenSnapshotId(ctl);
  await ctl.state.update("disk", name, () => withState({
    name,
    createdAt: now,
    sizeGb: ctl.config.drives.sizeGb,
    grown: false,
    hydrated: false,
    creating: { since: now, kind: "new" },
    sourceSnapshotId: snapshotId,
    lease: null,
    attach: null,
    needsFsck: false,
    takeover: false,
    growth: null,
    deleting: null,
  }));
  ctl.log.audit("drive.create", { drive: name, snapshot: snapshotId, sizeGb: ctl.config.drives.sizeGb });
  startCreation(ctl, name);
}

function startCreation(ctl, name) {
  if (ctl.runtime.creating.has(name)) return;
  ctl.runtime.creating.add(name);
  ctl.background(`create ${name}`, (async () => {
    try {
      const disk = ctl.state.get("disk", name);
      if (!disk?.creating) return;
      if (disk.creating.kind === "reset") await ctl.azure.deleteDisk(name);
      if (!(await ctl.azure.getDisk(name))) {
        const scaleSet = ctl.runtime.scaleSet ?? (await ctl.azure.scaleSet());
        await ctl.azure.createDisk(name, {
          snapshotId: disk.sourceSnapshotId,
          sizeGb: disk.sizeGb,
          iops: ctl.config.drives.iops,
          mbps: ctl.config.drives.mbps,
          location: scaleSet.location,
          zones: scaleSet.zones,
        });
      }
      const now = ctl.now();
      await ctl.state.update("disk", name, (d) => (d?.creating ? withState({ ...d, creating: null, hydratingSince: now }) : undefined));
    } finally {
      ctl.runtime.creating.delete(name);
    }
  })());
}

/** Hydrating drives join the pool once both the golden snapshot and the drive report CompletionPercent 100. */
export async function checkHydration(ctl) {
  const snapshots = new Map();
  for (const disk of ctl.state.all("disk").filter((d) => !d.lease && !d.hydrated && !d.deleting)) {
    if (disk.creating) {
      if (ctl.now() - disk.creating.since > CREATION_RETRY_MS) startCreation(ctl, disk.name);
      continue;
    }
    const info = await ctl.azure.getDisk(disk.name);
    if (!info) {
      await ctl.state.update("disk", disk.name, (d) => (d && !d.creating ? withState({ ...d, creating: { since: ctl.now(), kind: "new" } }) : undefined));
      startCreation(ctl, disk.name);
      continue;
    }
    if (!snapshots.has(disk.sourceSnapshotId)) snapshots.set(disk.sourceSnapshotId, await ctl.azure.getSnapshot(disk.sourceSnapshotId));
    const snapshot = snapshots.get(disk.sourceSnapshotId);
    const complete = (percent) => percent === null || percent === undefined || percent >= 100;
    if (info.provisioningState === "Succeeded" && complete(info.completionPercent) && snapshot && complete(snapshot.completionPercent)) {
      await ctl.state.update("disk", disk.name, (d) => (d && !d.lease ? withState({ ...d, hydrated: true }) : undefined));
      ctl.log.audit("drive.hydrated", { drive: disk.name });
    }
  }
}

/**
 * Returned drives that no VM holds: reset from the golden snapshot while the
 * pool is below its spare target, otherwise, or after a growth, deleted.
 */
export async function finishDetachedReturns(ctl) {
  for (const found of ctl.state.all("disk").filter((d) => d.lease?.returningSince && !d.attach && !d.deleting)) {
    await ctl.locks.run("pool", async () => {
      const disk = ctl.state.get("disk", found.name);
      if (!disk?.lease?.returningSince || disk.attach || disk.deleting) return;
      const disks = ctl.state.all("disk");
      const spares = disks.filter((d) => !d.lease && !d.deleting).length;
      const copies = disks.filter((d) => !d.lease && !d.deleting && !d.hydrated).length;
      const snapshotId = goldenSnapshotId(ctl);
      const remove = disk.grown || spares >= ctl.config.drives.spareCount || !snapshotId;
      if (!remove && copies >= TIMING.maxConcurrentCopies) return;
      const now = ctl.now();
      const lease = disk.lease;
      await ctl.state.update("disk", disk.name, (d) => {
        if (!d?.lease?.returningSince || d.attach) return undefined;
        d.lease = null;
        d.growth = null;
        d.needsFsck = false;
        d.takeover = false;
        if (remove) d.deleting = { since: now };
        else {
          d.hydrated = false;
          d.sizeGb = ctl.config.drives.sizeGb;
          d.sourceSnapshotId = snapshotId;
          d.creating = { since: now, kind: "reset" };
        }
        return withState(d);
      });
      ctl.log.audit(remove ? "drive.delete" : "drive.reset", { drive: disk.name, workId: lease.workId, grown: Boolean(disk.grown) });
      if (remove) startDeletion(ctl, disk.name);
      else startCreation(ctl, disk.name);
    });
  }
  for (const disk of ctl.state.all("disk").filter((d) => d.deleting && ctl.now() - d.deleting.since > CREATION_RETRY_MS)) {
    startDeletion(ctl, disk.name);
  }
}

function startDeletion(ctl, name) {
  if (ctl.runtime.deleting.has(name)) return;
  ctl.runtime.deleting.add(name);
  ctl.background(`delete ${name}`, (async () => {
    try {
      await ctl.azure.deleteDisk(name);
      await ctl.state.update("disk", name, (d) => (d?.deleting ? null : undefined));
    } finally {
      ctl.runtime.deleting.delete(name);
    }
  })());
}

/** A lease that no VM holds and that nothing used for WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS is returned; a parked one never expires. */
export async function expireLeases(ctl) {
  const now = ctl.now();
  for (const disk of ctl.state.all("disk")) {
    const lease = disk.lease;
    if (!lease || lease.returningSince || lease.parkedAt || disk.attach) continue;
    if (now - lease.lastUsedAt <= ctl.config.drives.leaseExpiryMs) continue;
    const expired = await ctl.locks.run(`disk:${disk.name}`, () => ctl.state.update("disk", disk.name, (d) => {
      const l = d?.lease;
      if (!l || l.returningSince || l.parkedAt || d.attach || now - l.lastUsedAt <= ctl.config.drives.leaseExpiryMs) return undefined;
      l.returningSince = now;
      l.credential = null;
      l.sync = null;
      l.move = null;
      l.rebind = null;
      return withState(d);
    }));
    if (expired?.lease?.returningSince === now) {
      await forgetDemand(ctl, lease.rootSessionId);
      ctl.log.audit("drive.expired", { drive: disk.name, workId: lease.workId, root: lease.rootSessionId, owner: lease.ownerOid });
    }
  }
}

/**
 * Online growth: a mounted drive whose volume, as its VM reports it, has
 * less than WIN_DEV_DRIVE_GROW_FREE_PERCENT free grows by
 * WIN_DEV_DRIVE_GROW_STEP_GB up to WIN_DEV_DRIVE_MAX_GB, one growth at a time.
 */
export async function checkGrowth(ctl) {
  const now = ctl.now();
  const cfg = ctl.config.drives;
  for (const disk of ctl.state.all("disk")) {
    if (disk.attach?.state !== "attached" || !disk.lease || disk.lease.returningSince) continue;
    if (disk.growth) {
      if (!disk.growth.alertedAt && now - disk.growth.startedAt > TIMING.growthAlertMs) {
        ctl.log.alert("drive.full", { drive: disk.name, reason: "growth-not-visible", targetGb: disk.growth.targetGb, vm: disk.attach.vmName });
        await ctl.state.update("disk", disk.name, (d) => (d?.growth ? { ...d, growth: { ...d.growth, alertedAt: now } } : undefined));
      }
      continue;
    }
    const report = vmRuntime(ctl, disk.attach.vmName).report;
    if (!report || report.diskName !== disk.name || report.sizeBytes <= 0) continue;
    if ((report.freeBytes / report.sizeBytes) * 100 >= cfg.growFreePercent) continue;
    if (disk.sizeGb >= cfg.maxGb) {
      if (!disk.fullAlertAt || now - disk.fullAlertAt > FULL_ALERT_REPEAT_MS) {
        ctl.log.alert("drive.full", { drive: disk.name, reason: "at-maximum", sizeGb: disk.sizeGb, vm: disk.attach.vmName, owner: disk.lease.ownerOid });
        await ctl.state.update("disk", disk.name, (d) => (d ? { ...d, fullAlertAt: now } : undefined));
      }
      continue;
    }
    const target = Math.min(disk.sizeGb + cfg.growStepGb, cfg.maxGb);
    await ctl.locks.run(`disk:${disk.name}`, async () => {
      const current = ctl.state.get("disk", disk.name);
      if (!current || current.growth || current.sizeGb !== disk.sizeGb) return;
      await ctl.azure.growDisk(disk.name, target);
      await ctl.state.update("disk", disk.name, (d) => (d ? withState({ ...d, grown: true, growth: { targetGb: target, startedAt: now, alertedAt: null } }) : undefined));
      ctl.log.audit("drive.grow", { drive: disk.name, fromGb: disk.sizeGb, toGb: target, vm: disk.attach.vmName });
    });
  }
}

/**
 * A VM that keeps a drive for 10 minutes after a return, a refused rebind or
 * sync-branch, or a move asked for it is fenced; the first request starts the
 * 10 minutes.
 */
export async function checkReleaseDeadlines(ctl) {
  const now = ctl.now();
  for (const disk of ctl.state.all("disk")) {
    if (!disk.attach || !disk.lease) continue;
    const pending = [
      ["return", disk.lease.returningSince],
      ["rebind", disk.lease.rebind?.since],
      ["sync-branch", disk.lease.syncWait?.since],
      ["move", disk.lease.move?.since],
    ].filter(([, since]) => since);
    const due = pending.find(([, since]) => now - since > TIMING.releaseDeadlineMs);
    if (due) await startFence(ctl, disk.attach.vmName, `release-deadline:${due[0]}`);
  }
}

/** Every tick: the pool's upkeep. */
export async function maintainPool(ctl) {
  await checkHydration(ctl);
  await expireLeases(ctl);
  await finishDetachedReturns(ctl);
  await checkGrowth(ctl);
  await checkReleaseDeadlines(ctl);
  await maintainSpares(ctl);
}
