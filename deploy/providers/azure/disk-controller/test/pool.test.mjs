// The drive pool: claims and their answers, spares, attach and detach with
// the attach record, park, branch sync, return, reset and deletion, rebind,
// credential rotation, lease expiry and online growth.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHarness, MINUTES } from "./harness.mjs";
import { OWNER_A, OWNER_B, GOLDEN_ID, restError } from "./fakes.mjs";

const GIB = 1024 ** 3;

async function leasedVm(h, { owner = OWNER_A, workId = "work-1", rootSessionId = "root-1" } = {}) {
  const vm = await h.activeVm({ owner });
  if (!h.state.all("disk").some((disk) => disk.state === "AvailableInPool")) await h.spares();
  const claimed = await h.claim({ ownerOid: owner, workId, rootSessionId });
  assert.equal(claimed.body.decision, "ok", JSON.stringify(claimed.body));
  return { vm, disk: claimed.body.lease.diskName };
}

const attach = (h, vm, rootSessionId = "root-1", purpose = "turn") =>
  h.worker(vm, "/v1/leases/attach", { rootSessionId, requestId: `req-${Math.random()}`, purpose }).then((answer) => answer.body);

test("claims answer busy NOT_READY before the scale set exists or without a golden snapshot", async () => {
  for (const options of [{ cloud: { scaleSetExists: false } }, { env: { WIN_WORKER_SCALE_SET_ID: "" } }, { env: { WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID: "" } }]) {
    const h = await createHarness(options);
    await h.tick();
    const answer = (await h.claim({ ownerOid: OWNER_A })).body;
    assert.equal(answer.decision, "busy", JSON.stringify(options));
    assert.equal(answer.code, "NOT_READY");
    assert.ok(answer.retryAfterMs > 0);
    assert.equal(h.state.all("disk").length, 0, "no drive is copied before the pool is ready");
  }
});

test("spares: the controller keeps the spare count copied and hydrated, from the golden snapshot, as Premium SSD v2", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_SPARE_COUNT: "2", WIN_DEV_DRIVE_POOL_COUNT: "4" } });
  h.cloud.copyPercent = 40;
  await h.tick();
  const created = h.cloud.callsOf("disk.create");
  assert.equal(created.length, 2);
  const [, group, name, parameters] = created[0];
  assert.equal(group, "stamp-rg");
  assert.match(name, /^psdrive-[0-9a-f]{12}$/);
  assert.deepEqual(parameters, {
    location: "westus3",
    zones: ["1"],
    sku: { name: "PremiumV2_LRS" },
    creationData: { createOption: "Copy", sourceResourceId: GOLDEN_ID },
    diskSizeGB: 1024,
    diskIopsReadWrite: 6000,
    diskMBpsReadWrite: 250,
    tags: { "pilotswarm-disk-pool": "drive" },
  });
  await h.tick();
  assert.deepEqual(h.state.all("disk").map((disk) => disk.state), ["Hydrating", "Hydrating"], "a drive joins the pool only at 100 percent");
  const busy = (await h.claim({ ownerOid: OWNER_A })).body;
  assert.equal(busy.decision, "busy");
  assert.equal(busy.code, "HYDRATING");
  for (const disk of h.cloud.disks.values()) disk.completionPercent = 100;
  await h.tick();
  assert.deepEqual(h.state.all("disk").map((disk) => disk.state), ["AvailableInPool", "AvailableInPool"]);
  await h.tick();
  assert.equal(h.cloud.callsOf("disk.create").length, 2, "no copy beyond the spare target");
});

test("at most four drive copies run at once, and the pool never holds more than WIN_DEV_DRIVE_POOL_COUNT drives", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_SPARE_COUNT: "6", WIN_DEV_DRIVE_POOL_COUNT: "6" } });
  h.cloud.copyPercent = 10;
  await h.tick();
  assert.equal(h.cloud.callsOf("disk.create").length, 4);
  for (const disk of h.cloud.disks.values()) disk.completionPercent = 100;
  await h.tick();
  await h.tick();
  assert.equal(h.state.all("disk").length, 6, "two more, up to the pool's size");
});

test("a claim leases a hydrated spare to the work; a repeat returns it; another root session for the work gets 409", async () => {
  const h = await createHarness();
  await h.spares();
  const first = await h.claim({ ownerOid: OWNER_A, workId: "work-1", rootSessionId: "root-1", credential: "per-work-1" });
  assert.equal(first.status, 200);
  assert.equal(first.body.decision, "ok");
  const lease = first.body.lease;
  assert.equal(lease.state, "AssignedUnattached");
  assert.equal(lease.workId, "work-1");
  assert.equal(lease.ownerOid, OWNER_A);
  assert.equal(lease.hasCredential, true);
  assert.equal(JSON.stringify(first.body).includes("per-work-1"), false, "the answer never carries the credential");
  assert.equal(h.drive(lease.diskName).lease.credential, "per-work-1");

  const repeat = await h.claim({ ownerOid: OWNER_A, workId: "work-1", rootSessionId: "root-1", credential: "per-work-1" });
  assert.equal(repeat.body.decision, "ok");
  assert.equal(repeat.body.lease.diskName, lease.diskName);
  assert.equal(h.state.all("disk").filter((disk) => disk.lease).length, 1);

  const other = await h.claim({ ownerOid: OWNER_A, workId: "work-1", rootSessionId: "root-other" });
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "WORK_HAS_ANOTHER_ROOT");
  await h.tick();
  assert.equal(h.state.all("disk").filter((disk) => !disk.lease).length, 2, "the taken spare is replaced");
});

test("deny OWNER_DRIVE_LIMIT at WIN_DEV_DRIVE_MAX_PER_USER leases, parked ones included", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_MAX_PER_USER: "2", WIN_DEV_DRIVE_POOL_COUNT: "6", WIN_DEV_DRIVE_SPARE_COUNT: "3" } });
  await h.spares();
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "w1", rootSessionId: "r1" })).body.decision, "ok");
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "w2", rootSessionId: "r2" })).body.decision, "ok");
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/park", { workId: "w2" })).body.decision, "ok");
  const denied = (await h.claim({ ownerOid: OWNER_A, workId: "w3", rootSessionId: "r3" })).body;
  assert.equal(denied.decision, "deny");
  assert.equal(denied.code, "OWNER_DRIVE_LIMIT");
  assert.deepEqual(denied.leasedWorks.map((work) => [work.workId, work.state]).sort(), [["w1", "AssignedUnattached"], ["w2", "Parked"]]);
  assert.equal((await h.claim({ ownerOid: OWNER_B, workId: "w4", rootSessionId: "r4" })).body.decision, "ok", "another owner is not limited");
});

test("busy POOL_FULL when every drive of the pool is leased, with one pool-full alert", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_POOL_COUNT: "2", WIN_DEV_DRIVE_SPARE_COUNT: "2", WIN_DEV_DRIVE_MAX_PER_USER: "5" } });
  await h.spares();
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "w1", rootSessionId: "r1" })).body.decision, "ok");
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "w2", rootSessionId: "r2" })).body.decision, "ok");
  for (const workId of ["w3", "w4"]) {
    const answer = (await h.claim({ ownerOid: OWNER_B, workId, rootSessionId: `root-${workId}` })).body;
    assert.equal(answer.decision, "busy");
    assert.equal(answer.code, "POOL_FULL");
    assert.ok(answer.retryAfterMs > 0);
  }
  assert.equal(h.log.events("pool.full").length, 1);
  assert.equal(h.log.events("pool.full")[0].level, "alert");
});

test("attach puts the drive at LUN 0 with deleteOption Detach, recording the attach before and after the Azure call", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  const seen = [];
  const original = h.cloud.compute.virtualMachines.attachDetachDataDisks;
  h.cloud.compute.virtualMachines.attachDetachDataDisks = async (...args) => {
    seen.push(structuredClone(h.state.get("disk", disk).attach));
    return original(...args);
  };
  const answer = await attach(h, vm);
  assert.deepEqual(answer, { ok: true, diskName: disk, lun: 0, rootSessionId: "root-1", ownerOid: OWNER_A, takeover: false, needsFsck: false, sync: null });
  assert.equal(seen[0].vmName, vm);
  assert.equal(seen[0].state, "attaching", "the record names the VM before Azure is asked");
  assert.equal(h.drive(disk).attach.state, "attached");
  assert.equal(h.drive(disk).state, "AttachedActive");
  const [call] = h.cloud.callsOf("vm.attachDetach");
  assert.deepEqual(call[3], { dataDisksToAttach: [{ diskId: `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/stamp-rg/providers/Microsoft.Compute/disks/${disk}`, lun: 0, caching: "None", deleteOption: "Detach" }] });
  assert.equal(h.log.events("drive.attach")[0].purpose, "turn");

  const again = await attach(h, vm);
  assert.equal(again.ok, true);
  assert.equal(h.cloud.callsOf("vm.attachDetach").length, 1, "the holder's own attach makes no Azure call");
});

test("a failed attach clears the attach record and answers busy", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  h.cloud.failAttach = restError(409, "Conflict", "busy");
  const answer = await attach(h, vm);
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "ATTACH_FAILED");
  assert.equal(h.drive(disk).attach, null);
  assert.equal((await attach(h, vm)).ok, true, "a retry attaches");
});

test("attach refusals: no lease, an unbound VM, another owner's VM, and a VM with another drive at LUN 0", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_POOL_COUNT: "4", WIN_DEV_DRIVE_SPARE_COUNT: "3" } });
  const { vm } = await leasedVm(h);
  const none = await attach(h, vm, "root-without-lease");
  assert.deepEqual({ ok: none.ok, code: none.code, retryable: none.retryable }, { ok: false, code: "NO_DRIVE_LEASE", retryable: false });
  const unbound = await h.activeVm();
  assert.equal((await attach(h, unbound)).reason, "VM_UNBOUND");
  const other = await h.activeVm({ owner: OWNER_B });
  assert.equal((await attach(h, other)).reason, "OWNER_MISMATCH");
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "work-2", rootSessionId: "root-2" })).body.decision, "ok");
  assert.equal((await attach(h, vm, "root-1")).ok, true);
  const second = await attach(h, vm, "root-2");
  assert.equal(second.code, "WORKSPACE_BUSY");
  assert.equal(second.reason, "LUN_BUSY");
});

test("detach is idempotent, detaches only what Azure shows on the caller, and flags a crashed detach for checks", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  const other = await h.activeVm({ owner: OWNER_A });
  const foreign = await h.worker(other, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "x" });
  assert.deepEqual(foreign.body, { ok: true, detached: false });
  assert.equal(h.drive(disk).attach.vmName, vm, "another VM cannot detach the drive");

  const first = await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d1", crashed: true });
  assert.deepEqual(first.body, { ok: true, detached: true });
  assert.equal(h.drive(disk).attach, null);
  assert.equal(h.drive(disk).needsFsck, true);
  assert.equal(h.drive(disk).state, "AssignedUnattached");
  const repeat = await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d1", crashed: true });
  assert.deepEqual(repeat.body, { ok: true, detached: false });
  assert.equal(h.cloud.callsOf("vm.attachDetach").filter((call) => call[3].dataDisksToDetach).length, 1);
  assert.deepEqual(h.cloud.callsOf("vm.attachDetach").at(-1)[3], { dataDisksToDetach: [{ diskId: `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/stamp-rg/providers/Microsoft.Compute/disks/${disk}` }] });

  const next = await attach(h, vm);
  assert.equal(next.needsFsck, true, "the next attach is told to check the repositories");
  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d2" });
  assert.equal(h.drive(disk).needsFsck, false, "a clean detach clears the flag");
});

test("park: busy everywhere for 15 minutes, credential wiped, the holder asked to release; sync-branch unparks with a record until it is applied", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  const parked = await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal(parked.body.lease.state, "Parked");
  assert.equal(h.drive(disk).lease.credential, null);
  const beat = await h.heartbeat(vm, { attachedDisk: disk });
  assert.deepEqual(beat.releaseRequested, { diskName: disk, reason: "park" });
  assert.deepEqual(beat.attached, { diskName: disk, rootSessionId: "root-1", state: "attached" });
  const refused = await attach(h, vm);
  assert.deepEqual({ code: refused.code, reason: refused.reason, retryAfterMs: refused.retryAfterMs }, { code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000 });
  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d" });
  assert.equal(h.drive(disk).state, "Parked");
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" })).body.decision, "ok", "a repeated park is fine");

  const synced = await h.dispatcher("/disk-pool/v1/disks/sync-branch", {
    workId: "work-1", sourceBranch: "feature/x", headSha: "b".repeat(40), url: "https://git.example/repo", credential: "per-work-2",
  });
  assert.equal(synced.body.decision, "ok");
  assert.equal(synced.body.lease.state, "AssignedUnattached");
  assert.equal(h.drive(disk).lease.credential, "per-work-2");
  const { syncId } = synced.body;
  const first = await attach(h, vm);
  assert.deepEqual(first.sync, { syncId, sourceBranch: "feature/x", headSha: "b".repeat(40), url: "https://git.example/repo" });
  assert.equal((await attach(h, vm)).sync.syncId, syncId, "every attach names the record until it is applied");
  await h.heartbeat(vm, { attachedDisk: disk, syncId: "something-else" });
  assert.equal((await attach(h, vm)).sync.syncId, syncId);
  await h.heartbeat(vm, { attachedDisk: disk, syncId, syncedHeadSha: "b".repeat(40) });
  assert.equal((await attach(h, vm)).sync, null, "and never after");
});

test("return: the holder releases, then the drive is reset while the pool is below its spare target", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_SPARE_COUNT: "2", WIN_DEV_DRIVE_POOL_COUNT: "3" } });
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  // Take the other spare too, so that the pool is below its spare target when the drive comes back.
  await h.claim({ ownerOid: OWNER_B, workId: "work-b", rootSessionId: "root-b" });
  const before = h.cloud.callsOf("disk.create").length;
  const returned = await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  assert.equal(returned.body.decision, "ok");
  assert.equal(returned.body.lease.state, "Returning");
  assert.equal(h.drive(disk).lease.credential, null);
  assert.deepEqual((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, { diskName: disk, reason: "return" });
  const returning = await attach(h, vm);
  assert.deepEqual(
    { ok: returning.ok, code: returning.code, reason: returning.reason, retryAfterMs: returning.retryAfterMs },
    { ok: false, code: "WORKSPACE_BUSY", reason: "RETURNING", retryAfterMs: 900_000 },
    "a returning lease is busy for attaches, even its holder's",
  );
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" })).body.changed, false, "idempotent");
  await h.tick();
  assert.ok(h.cloud.disks.has(disk), "nothing happens to the drive while a VM holds it");

  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d" });
  await h.tick();
  const reset = h.drive(disk);
  assert.equal(reset.lease, null);
  assert.ok(["Hydrating", "AvailableInPool"].includes(reset.state));
  assert.ok(h.cloud.callsOf("disk.delete").some((call) => call[2] === disk), "reset: the old drive is deleted");
  assert.ok(h.cloud.callsOf("disk.create").slice(before).some((call) => call[2] === disk && call[3].creationData.sourceResourceId === GOLDEN_ID), "and copied again from the golden snapshot");
  const completed = await attach(h, vm);
  assert.deepEqual({ ok: completed.ok, code: completed.code }, { ok: false, code: "NO_DRIVE_LEASE" }, "once the return completes, the root holds no lease");
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" })).body.changed, false, "back in the pool: still idempotent");
});

test("return: a drive above the spare target, or one that grew, is deleted, not reset", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_SPARE_COUNT: "1", WIN_DEV_DRIVE_POOL_COUNT: "4" } });
  await h.spares();
  await h.claim({ ownerOid: OWNER_A, workId: "w1", rootSessionId: "r1" });
  await h.tick();
  await h.tick();
  const disk = h.driveOf("w1").name;
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "w1" });
  await h.tick();
  assert.equal(h.drive(disk), null, "deleted: the pool already has its spare");
  assert.equal(h.cloud.disks.has(disk), false);
});

test("rebind moves the lease only while no VM holds the drive; the old root can no longer attach", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  const body = { workId: "work-1", rootSessionId: "root-2", ownerOid: OWNER_A, credential: "per-work-new" };
  const refused = (await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body;
  assert.deepEqual({ decision: refused.decision, code: refused.code }, { decision: "busy", code: "DRIVE_ATTACHED" });
  assert.deepEqual((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, { diskName: disk, reason: "rebind" });
  assert.equal(h.log.events("drive.release-requested").filter((record) => record.reason === "rebind").length, 1);
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/rebind", { ...body, ownerOid: OWNER_B })).status, 409, "only for the same owner");

  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d" });
  const moved = (await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body;
  assert.equal(moved.decision, "ok");
  assert.equal(moved.lease.rootSessionId, "root-2");
  assert.equal(h.drive(disk).lease.credential, "per-work-new");
  assert.equal(h.drive(disk).lease.rebind, null);
  assert.equal((await attach(h, vm, "root-1")).code, "NO_DRIVE_LEASE");
  assert.equal((await attach(h, vm, "root-2")).ok, true);
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/rebind", body)).body.decision, "ok", "a repeat while the new root holds the drive is fine");
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, null, "and asks for no release");
});

test("sync-branch waits like a rebind while a VM holds the parked drive: busy, nothing recorded, still parked; after the detach it unparks", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  const parkedAt = h.drive(disk).lease.parkedAt;
  const body = { workId: "work-1", sourceBranch: "feature/x", headSha: "b".repeat(40), url: "https://git.example/repo", credential: "per-work-2" };
  const refused = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", body)).body;
  assert.deepEqual(refused, { decision: "busy", code: "DRIVE_ATTACHED", retryAfterMs: 10_000, message: "A VM still holds the drive; it has been asked to release it." });
  const waiting = h.drive(disk);
  assert.deepEqual(
    { state: waiting.state, parkedAt: waiting.lease.parkedAt, credential: waiting.lease.credential, sync: waiting.lease.sync },
    { state: "Parked", parkedAt, credential: null, sync: null },
    "no sync, no credential, no unpark",
  );
  assert.deepEqual((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, { diskName: disk, reason: "park" }, "the park's release request goes on");
  assert.equal((await attach(h, vm)).reason, "PARKED", "and the holder's turns still wait");
  const since = waiting.lease.syncWait.since;
  h.clock.advance(MINUTES(1));
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/sync-branch", body)).body.code, "DRIVE_ATTACHED");
  assert.equal(h.drive(disk).lease.syncWait.since, since, "a refused retry keeps the first refusal's time");
  assert.deepEqual(h.log.events("drive.release-requested").filter((record) => record.reason === "sync-branch").map((record) => record.vm), [vm]);

  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d" });
  const synced = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", body)).body;
  assert.equal(synced.decision, "ok");
  assert.equal(synced.lease.state, "AssignedUnattached");
  const lease = h.drive(disk).lease;
  assert.deepEqual(
    { parkedAt: lease.parkedAt, syncWait: lease.syncWait, credential: lease.credential, syncId: lease.sync.syncId },
    { parkedAt: null, syncWait: null, credential: "per-work-2", syncId: synced.syncId },
  );
  assert.equal((await attach(h, vm)).sync.syncId, synced.syncId, "the next attach reaches the controller and gets the sync");
});

const HAND_BACK = { workId: "work-1", sourceBranch: "feature/x", headSha: "b".repeat(40), url: "https://git.example/repo", credential: "per-work-2" };

test("a hand-back retried on the unparked drive answers its syncId and takes the new credential, but records no new sync, pending or applied", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  const first = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", HAND_BACK)).body;
  const pending = h.drive(disk).lease.sync;
  h.clock.advance(MINUTES(1));
  // The caller lost the answer: it retries with the same branch and head, and may send a new one-off URL and credential.
  const retried = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", { ...HAND_BACK, url: "https://git.example/other", credential: "per-work-3" })).body;
  assert.deepEqual({ decision: retried.decision, syncId: retried.syncId }, { decision: "ok", syncId: first.syncId });
  const lease = h.drive(disk).lease;
  assert.deepEqual(lease.sync, pending, "the pending record stays as it was");
  assert.deepEqual({ credential: lease.credential, credentialSetAt: lease.credentialSetAt }, { credential: "per-work-3", credentialSetAt: h.clock.now() });
  assert.deepEqual(h.log.events("drive.sync-branch").map((record) => [record.syncId, record.repeat ?? false]), [[first.syncId, false], [first.syncId, true]]);

  assert.equal((await attach(h, vm)).sync.syncId, first.syncId);
  await h.heartbeat(vm, { attachedDisk: disk, syncId: first.syncId, syncedHeadSha: HAND_BACK.headSha });
  assert.equal(h.drive(disk).lease.sync, null, "the turn applied it");
  const late = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", { ...HAND_BACK, credential: "per-work-4" })).body;
  assert.deepEqual({ decision: late.decision, syncId: late.syncId }, { decision: "ok", syncId: first.syncId });
  const after = h.drive(disk).lease;
  assert.deepEqual({ sync: after.sync, credential: after.credential }, { sync: null, credential: "per-work-4" }, "nothing for a later attach to apply under newer work");
  assert.equal((await attach(h, vm)).sync, null);
  assert.equal((await h.heartbeat(vm, { attachedDisk: disk })).releaseRequested, null, "and the holder keeps the drive");
});

test("sync-branch on a drive that isn't parked gets 409 NOT_PARKED and changes nothing, unless it repeats the last hand-back", async () => {
  const h = await createHarness();
  const { disk } = await leasedVm(h);
  const claimed = h.drive(disk);
  const never = await h.dispatcher("/disk-pool/v1/disks/sync-branch", HAND_BACK);
  assert.deepEqual([never.status, never.body.error], [409, "NOT_PARKED"], "a lease that was never parked");
  assert.deepEqual(h.drive(disk), claimed);

  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/sync-branch", HAND_BACK)).body.decision, "ok");
  const handedBack = h.drive(disk);
  for (const other of [{ headSha: "c".repeat(40) }, { sourceBranch: "feature/y" }]) {
    const answer = await h.dispatcher("/disk-pool/v1/disks/sync-branch", { ...HAND_BACK, ...other, credential: "per-work-9" });
    assert.deepEqual([answer.status, answer.body.error], [409, "NOT_PARKED"], JSON.stringify(other));
  }
  assert.deepEqual(h.drive(disk), handedBack, "no sync, no credential, no change at all");
  assert.equal(h.log.events("drive.sync-branch").length, 1);
});

test("a park or a return forgets the hand-back: after a new park, a hand-back with the same head records a new sync", async () => {
  const h = await createHarness();
  const { vm, disk } = await leasedVm(h);
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  const first = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", HAND_BACK)).body;
  assert.deepEqual(h.drive(disk).lease.handBack, { syncId: first.syncId, sourceBranch: HAND_BACK.sourceBranch, headSha: HAND_BACK.headSha });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal(h.drive(disk).lease.handBack, null);
  const second = (await h.dispatcher("/disk-pool/v1/disks/sync-branch", HAND_BACK)).body;
  assert.equal(second.decision, "ok");
  assert.notEqual(second.syncId, first.syncId);
  assert.equal(h.drive(disk).lease.sync.syncId, second.syncId);
  await attach(h, vm);
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  assert.equal(h.drive(disk).lease.handBack, null, "nor does a returning lease keep it");
});

test("the per-work credential: set by claim, rotated by the dispatcher, refused while parked", async () => {
  const h = await createHarness();
  const { disk } = await leasedVm(h);
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/credential", { workId: "work-1", credential: "Zq9-rotation-value" })).body.decision, "ok");
  assert.equal(h.drive(disk).lease.credential, "Zq9-rotation-value");
  assert.equal(h.log.text().includes("Zq9-rotation-value"), false, "never logged");
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/credential", { workId: "work-1", credential: "x" })).status, 409);
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/credential", { workId: "nope", credential: "x" })).status, 404);
});

test("a lease that no VM holds and nothing used for the expiry period is returned; a parked or held one never expires", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS: "7", WIN_DEV_DRIVE_POOL_COUNT: "6", WIN_DEV_DRIVE_SPARE_COUNT: "3" } });
  const { vm } = await leasedVm(h, { workId: "held", rootSessionId: "r-held" });
  await attach(h, vm, "r-held");
  await h.claim({ ownerOid: OWNER_B, workId: "idle", rootSessionId: "r-idle" });
  await h.claim({ ownerOid: OWNER_B, workId: "parked", rootSessionId: "r-parked" });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "parked" });
  h.clock.advance(MINUTES(7 * 24 * 60) - MINUTES(1));
  await h.heartbeat(vm, { attachedDisk: h.driveOf("held").name });
  await h.tick();
  assert.equal(h.driveOf("idle").state, "AssignedUnattached", "not yet");
  h.clock.advance(MINUTES(2));
  await h.heartbeat(vm, { attachedDisk: h.driveOf("held").name });
  await h.tick();
  assert.equal(h.driveOf("idle"), null, "returned, and its drive reset or deleted");
  assert.equal(h.log.events("drive.expired").length, 1);
  assert.equal(h.driveOf("parked").state, "Parked");
  assert.equal(h.driveOf("held").state, "AttachedActive");
});

test("online growth: below the free threshold the drive grows by a PATCH of diskSizeGB alone, one growth at a time", async () => {
  const h = await createHarness({ env: { WIN_DEV_DRIVE_SIZE_GB: "1024", WIN_DEV_DRIVE_GROW_STEP_GB: "256", WIN_DEV_DRIVE_MAX_GB: "1280" } });
  const { vm, disk } = await leasedVm(h);
  await attach(h, vm);
  const report = (sizeGb, freePercent) => ({ attachedDisk: disk, attachedDiskSizeBytes: sizeGb * GIB, attachedDiskFreeBytes: Math.floor(sizeGb * GIB * freePercent / 100) });
  await h.heartbeat(vm, report(1024, 21));
  await h.tick();
  assert.equal(h.cloud.callsOf("disk.update").length, 0, "21 percent free is enough");
  await h.heartbeat(vm, report(1024, 19));
  await h.tick();
  const patches = h.cloud.callsOf("disk.update");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].slice(1), ["stamp-rg", disk, { diskSizeGB: 1280 }]);
  const asked = await h.heartbeat(vm, report(1024, 19));
  assert.deepEqual(asked.extendRequested, { diskName: disk, sizeGb: 1280 });
  await h.tick();
  assert.equal(h.cloud.callsOf("disk.update").length, 1, "a growth in progress never starts another");
  h.clock.advance(MINUTES(16));
  await h.heartbeat(vm, report(1024, 19));
  await h.tick();
  assert.equal(h.log.events("drive.full").filter((record) => record.reason === "growth-not-visible").length, 1);
  // Windows now sees the larger disk, within a GiB of its size.
  const done = await h.heartbeat(vm, { attachedDisk: disk, attachedDiskSizeBytes: 1280 * GIB - GIB / 2, attachedDiskFreeBytes: 10 * GIB });
  assert.equal(done.extendRequested, null);
  assert.equal(h.drive(disk).sizeGb, 1280);
  await h.tick();
  assert.equal(h.cloud.callsOf("disk.update").length, 1, "at the maximum it grows no more");
  assert.equal(h.log.events("drive.full").filter((record) => record.reason === "at-maximum").length, 1, "and the drive-full alert fires");
  assert.equal(h.drive(disk).grown, true);

  await h.worker(vm, "/v1/leases/detach", { diskName: disk, rootSessionId: "root-1", requestId: "d" });
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  await h.tick();
  assert.equal(h.drive(disk), null, "a grown drive is deleted at its return, never reset");
});
