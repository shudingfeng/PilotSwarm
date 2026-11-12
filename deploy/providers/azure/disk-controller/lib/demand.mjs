// Owner demand: the capacity requests (/v1/coordination/demand),
// /v1/vms/busy, claims and branch syncs. Only a root session that holds a
// live drive lease of the owner counts. Each counted request is a demand
// signal, which keeps one unbound VM ready for a while, and enters the queue
// of unserved demand, which the scaler serves oldest first and which survives
// a controller restart in controller.json.
import { HttpError } from "./http.mjs";
import { TIMING, busy, isGuid, isId, leaseBusy, leaseOfRoot } from "./model.mjs";
import { controllerRecord, updateController } from "./controller-record.mjs";
import { isServing, isSilent } from "./fleet.mjs";

export async function recordDemand(ctl, { ownerOid, rootSessionId, kind, excludeVm = null }) {
  const now = ctl.now();
  await updateController(ctl, (c) => {
    const demand = c.demand.filter((entry) => now - entry.lastAt <= TIMING.demandMs);
    const existing = demand.find((entry) => entry.ownerOid === ownerOid && entry.rootSessionId === rootSessionId);
    if (existing) Object.assign(existing, { lastAt: now, kind, excludeVm });
    else demand.push({ ownerOid, rootSessionId, kind, excludeVm, at: now, lastAt: now });
    return { ...c, demand, lastDemandAt: now };
  });
}

/** The root's demand is served (its drive attached) or gone (returned, parked or rebound). */
export async function forgetDemand(ctl, rootSessionId) {
  if (!controllerRecord(ctl).demand.some((entry) => entry.rootSessionId === rootSessionId)) return;
  await updateController(ctl, (c) => ({ ...c, demand: c.demand.filter((entry) => entry.rootSessionId !== rootSessionId) }));
}

function refusalAnswer(refusal) {
  return { decision: "busy", ...busy(refusal.reason, refusal.retryAfterMs, refusal.message) };
}

/** Whether the owner can get a VM now or soon: one of theirs, a ready one to bind, room to scale out, or an idle VM to recycle at the maximum. */
function capacityAnswer(ctl, ownerOid, excludeVm) {
  const c = controllerRecord(ctl);
  if (c.upgradeFrozen) return refusalAnswer({ reason: "UPGRADE_FROZEN", retryAfterMs: TIMING.frozenRetryMs, message: "The pool is frozen for an upgrade." });
  if (!ctl.azure || !ctl.runtime.scaleSet) return refusalAnswer({ reason: "NOT_READY", retryAfterMs: TIMING.notReadyRetryMs, message: "The worker pool is not ready yet." });
  const serving = ctl.state.all("vm").filter((record) => isServing(record) && record.name !== excludeVm);
  if (serving.some((record) => record.ownerOid === ownerOid)) return { decision: "ok" };
  if (c.pending.some((entry) => entry.purpose === "owner" && entry.ownerOid === ownerOid)) return { decision: "ok" };
  if (serving.some((record) => !record.ownerOid && !isSilent(ctl, record))) return { decision: "ok" };
  if ((ctl.runtime.scaleSet.capacity ?? 0) + c.pending.length < ctl.config.vms.max) return { decision: "ok" };
  const waiting = new Set(c.demand.map((entry) => entry.ownerOid));
  const recyclable = serving.some((record) => record.ownerOid && !waiting.has(record.ownerOid)
    && ctl.runtime.vms.get(record.name)?.idleSince != null);
  if (recyclable) return { decision: "ok" };
  return refusalAnswer({ reason: "POOL_FULL", retryAfterMs: TIMING.poolFullRetryMs, message: "Every worker VM is busy; the session waits for one." });
}

/**
 * A capacity request for `{ ownerOid, rootSessionId }`: `deny` for a root
 * without a live lease of that owner, `busy` (uncounted) for a parked,
 * returning or quarantined one, and otherwise counted, with `ok` while the
 * owner has or can get a VM.
 */
export async function capacityRequest(ctl, body, { kind }) {
  if (!isGuid(body?.ownerOid)) throw new HttpError(400, "BAD_REQUEST", "ownerOid must be an object ID.");
  if (!isId(body?.rootSessionId)) throw new HttpError(400, "BAD_REQUEST", "rootSessionId is required.");
  const ownerOid = body.ownerOid.toLowerCase();
  const disk = leaseOfRoot(ctl.state.all("disk"), body.rootSessionId);
  if (!disk || disk.lease.ownerOid !== ownerOid) {
    return { decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive of this owner." };
  }
  const refusal = leaseBusy(disk);
  if (refusal) return refusalAnswer(refusal);
  await recordDemand(ctl, { ownerOid, rootSessionId: body.rootSessionId, kind });
  ctl.kick();
  return capacityAnswer(ctl, ownerOid, null);
}

/** POST /v1/vms/busy { rootSessionId }: the calling VM needs another VM for its owner. */
export async function busyRequest(ctl, vm, body) {
  if (!isId(body?.rootSessionId)) throw new HttpError(400, "BAD_REQUEST", "rootSessionId is required.");
  const record = ctl.state.get("vm", vm.name);
  const disk = leaseOfRoot(ctl.state.all("disk"), body.rootSessionId);
  if (!record?.ownerOid || !disk || disk.lease.ownerOid !== record.ownerOid) {
    return { decision: "deny", code: "NO_DRIVE_LEASE", message: "This session's root holds no Dev Drive of this VM's owner." };
  }
  const refusal = leaseBusy(disk);
  if (refusal) return refusalAnswer(refusal);
  await recordDemand(ctl, { ownerOid: record.ownerOid, rootSessionId: body.rootSessionId, kind: "busy", excludeVm: vm.name });
  ctl.kick();
  return capacityAnswer(ctl, record.ownerOid, vm.name);
}
