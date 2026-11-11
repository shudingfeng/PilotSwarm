// Capacity demand (/v1/vms/demand, /v1/coordination/demand, /v1/vms/busy):
// counted only for a root with a live lease of the owner, `deny` without one,
// `busy` (uncounted) for a parked or returning one, in the answer shape the
// orchestration's capacity requester expects. And admission before every
// turn, by the table in the design.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAzure } from "../lib/azure.mjs";
import { createController } from "../lib/controller.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import { createHarness, MINUTES } from "./harness.mjs";
import { OWNER_A, OWNER_B, TOKENS, createMemoryLogger, fakeVerifier } from "./fakes.mjs";

async function leased(h, { owner = OWNER_A, workId = "work-1", rootSessionId = "root-1" } = {}) {
  if (!h.state.all("disk").some((disk) => disk.state === "AvailableInPool")) await h.spares();
  assert.equal((await h.claim({ ownerOid: owner, workId, rootSessionId })).body.decision, "ok");
}

const controllerRecord = (h) => h.state.get("controller", "controller");

test("a capacity request for a root without a live lease of that owner is denied and not counted", async () => {
  const h = await createHarness();
  await leased(h);
  const before = controllerRecord(h).lastDemandAt;
  h.clock.advance(1000);
  for (const body of [{ ownerOid: OWNER_A, rootSessionId: "no-lease" }, { ownerOid: OWNER_B, rootSessionId: "root-1" }]) {
    const answer = (await h.coordination(body)).body;
    assert.deepEqual({ decision: answer.decision, code: answer.code }, { decision: "deny", code: "NO_DRIVE_LEASE" });
  }
  assert.equal(controllerRecord(h).lastDemandAt, before);
  assert.equal(controllerRecord(h).demand.some((entry) => entry.rootSessionId === "no-lease"), false);
});

test("a parked or returning lease answers busy for 15 minutes, uncounted", async () => {
  const h = await createHarness();
  await leased(h, { workId: "parked", rootSessionId: "r-parked" });
  await leased(h, { workId: "returning", rootSessionId: "r-returning", owner: OWNER_B });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "parked" });
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "returning" });
  await h.ctl.settle();
  const before = controllerRecord(h).lastDemandAt;
  h.clock.advance(1000);
  for (const [owner, root, reason] of [[OWNER_A, "r-parked", "PARKED"], [OWNER_B, "r-returning", null]]) {
    const answer = (await h.coordination({ ownerOid: owner, rootSessionId: root })).body;
    if (reason) {
      assert.deepEqual(answer, { decision: "busy", code: "WORKSPACE_BUSY", reason, retryAfterMs: 900_000, message: "Dev Drive is parked for local work" });
    } else {
      assert.equal(answer.decision, "deny", "with no VM holding it, the return completes at once, and the root holds no lease");
    }
  }
  assert.equal(controllerRecord(h).lastDemandAt, before, "neither counts as demand");
});

test("a returning lease that a VM still holds answers busy on admission and both demand routes, then deny once the return completes", async () => {
  const h = await createHarness();
  const vm = await h.activeVm({ owner: OWNER_A });
  await leased(h);
  const attached = (await h.worker(vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "a-1", purpose: "turn" })).body;
  assert.equal(attached.ok, true, JSON.stringify(attached));
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  const before = controllerRecord(h).lastDemandAt;
  h.clock.advance(1000);
  const answers = async () => [
    (await h.worker(vm, "/v1/vms/admit", { sessionId: "child-1", rootSessionId: "root-1", isSystem: false })).body,
    (await h.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" })).body,
    (await h.worker(vm, "/v1/vms/busy", { rootSessionId: "root-1" })).body,
  ];
  for (const answer of await answers()) {
    assert.deepEqual(
      { decision: answer.decision, code: answer.code, reason: answer.reason, retryAfterMs: answer.retryAfterMs },
      { decision: "busy", code: "WORKSPACE_BUSY", reason: "RETURNING", retryAfterMs: 900_000 },
    );
  }
  assert.equal(controllerRecord(h).lastDemandAt, before, "not counted as demand");
  assert.equal(controllerRecord(h).demand.some((entry) => entry.rootSessionId === "root-1"), false);

  await h.worker(vm, "/v1/leases/detach", { diskName: attached.diskName, rootSessionId: "root-1", requestId: "d-1" });
  await h.tick();
  assert.equal(h.driveOf("work-1"), null, "the return completed");
  for (const answer of await answers()) {
    assert.deepEqual({ decision: answer.decision, code: answer.code }, { decision: "deny", code: "NO_DRIVE_LEASE" });
  }
});

test("a counted request answers ok while the owner has or can get a VM, busy POOL_FULL at X with nothing to recycle", async () => {
  const h = await createHarness({ env: { WIN_WORKER_COUNT: "1" } });
  await leased(h);
  const first = (await h.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" })).body;
  assert.deepEqual(first, { decision: "ok" });
  assert.ok(controllerRecord(h).lastDemandAt > 0, "counted");
  assert.equal(h.cloud.callsOf("vmss.update").at(-1)[3].sku.capacity, 1, "and served by a scale-out at once");
  await h.tick();
  const [vm] = h.cloud.activeVmNames();
  await h.worker(vm, "/v1/vms/register");
  await h.heartbeat(vm, { activeWorkloadCount: 1 });
  assert.deepEqual((await h.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" })).body, { decision: "ok" }, "the owner's busy VM takes it next");

  await leased(h, { owner: OWNER_B, workId: "work-b", rootSessionId: "root-b" });
  const full = (await h.coordination({ ownerOid: OWNER_B, rootSessionId: "root-b" })).body;
  assert.deepEqual({ decision: full.decision, code: full.code, reason: full.reason, retryAfterMs: full.retryAfterMs }, { decision: "busy", code: "WORKSPACE_BUSY", reason: "POOL_FULL", retryAfterMs: 60_000 });
  assert.ok(controllerRecord(h).demand.some((entry) => entry.ownerOid === OWNER_B), "the demand waits in the queue");
});

test("frozen and not-ready pools answer busy", async () => {
  const h = await createHarness();
  await leased(h);
  await h.admin("POST", "/v1/admin/upgrade-freeze", { frozen: true });
  assert.equal((await h.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" })).body.reason, "UPGRADE_FROZEN");
  const empty = await createHarness({ env: { WIN_WORKER_SCALE_SET_ID: "" } });
  const answer = (await empty.coordination({ ownerOid: OWNER_A, rootSessionId: "root-1" })).body;
  assert.equal(answer.decision, "deny", "no lease can exist before the pool is ready");
});

test("/v1/vms/demand answers like the coordination route, and 403 when the coordination host sends capacity requests", async () => {
  const h = await createHarness();
  await leased(h);
  const vm = await h.activeVm({ owner: OWNER_A });
  assert.deepEqual((await h.worker(vm, "/v1/vms/demand", { ownerOid: OWNER_A, rootSessionId: "root-1" })).body, { decision: "ok" });
  assert.equal((await h.worker(vm, "/v1/vms/demand", { ownerOid: OWNER_A, rootSessionId: "none" })).body.decision, "deny");

  const ownerOnly = await createHarness({ env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  await leased(ownerOnly);
  const other = await ownerOnly.activeVm({ owner: OWNER_A });
  const refused = await ownerOnly.worker(other, "/v1/vms/demand", { ownerOid: OWNER_A, rootSessionId: "root-1" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "COORDINATION_HOST");
});

test("/v1/vms/busy counts only a leased root of the VM's own owner, and asks for a VM other than the caller", async () => {
  const h = await createHarness();
  await leased(h, { workId: "w1", rootSessionId: "r1" });
  await leased(h, { workId: "w2", rootSessionId: "r2" });
  await leased(h, { workId: "wb", rootSessionId: "rb", owner: OWNER_B });
  const vm = await h.activeVm({ owner: OWNER_A });
  assert.equal((await h.worker(vm, "/v1/vms/busy", { rootSessionId: "rb" })).body.decision, "deny", "another owner's root");
  const unbound = await h.activeVm();
  assert.equal((await h.worker(unbound, "/v1/vms/busy", { rootSessionId: "r2" })).body.decision, "deny", "an unbound VM has no owner");
  assert.equal(controllerRecord(h).demand.some((entry) => entry.kind === "busy"), false, "refusals are not counted");
  assert.deepEqual((await h.worker(vm, "/v1/vms/busy", { rootSessionId: "r2" })).body, { decision: "ok" });
  const entry = controllerRecord(h).demand.find((candidate) => candidate.rootSessionId === "r2");
  assert.deepEqual({ kind: entry?.kind, owner: entry?.ownerOid, excludeVm: entry?.excludeVm }, { kind: "busy", owner: OWNER_A, excludeVm: vm });
});
test("admission follows the table: lease, binding, parked or returning, and system sessions", async () => {
  const h = await createHarness();
  await leased(h, { workId: "w1", rootSessionId: "r1" });
  await leased(h, { workId: "wp", rootSessionId: "rp" });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "wp" });
  const own = await h.activeVm({ owner: OWNER_A });
  const other = await h.activeVm({ owner: OWNER_B });
  const unbound = await h.activeVm();
  const admit = async (vm, sessionId, rootSessionId, isSystem = false) => (await h.worker(vm, "/v1/vms/admit", { sessionId, rootSessionId, isSystem })).body;

  for (const session of ["r1", "child-of-r1"]) {
    assert.deepEqual(await admit(own, session, "r1"), { decision: "admit" });
    assert.equal((await admit(unbound, session, "r1")).decision, "busy");
    assert.equal((await admit(other, session, "r1")).decision, "busy");
  }
  for (const vm of [own, unbound, other]) {
    const parked = await admit(vm, "child", "rp");
    assert.deepEqual({ decision: parked.decision, retryAfterMs: parked.retryAfterMs }, { decision: "busy", retryAfterMs: 900_000 });
    assert.deepEqual({ ...(await admit(vm, "s", "no-lease")), message: undefined }, { decision: "deny", code: "NO_DRIVE_LEASE", message: undefined });
    assert.deepEqual(await admit(vm, "sys", "sys-root", true), { decision: "admit" });
  }

  const ownerOnly = await createHarness({ env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  const vm = await ownerOnly.activeVm({ owner: OWNER_A });
  const system = (await ownerOnly.worker(vm, "/v1/vms/admit", { sessionId: "sys", rootSessionId: "sys", isSystem: true })).body;
  assert.equal(system.decision, "busy", "system sessions stay on the coordination host");
  assert.equal(system.reason, "SYSTEM_SESSION");
});

test("every admission decision is audited with the VM, the session, its root and the decision, never a credential", async () => {
  const h = await createHarness();
  await leased(h, { workId: "w1", rootSessionId: "r1" });
  const own = await h.activeVm({ owner: OWNER_A });
  const unbound = await h.activeVm();
  for (const [vm, body] of [
    [own, { sessionId: "child-1", rootSessionId: "r1", isSystem: false }],
    [unbound, { sessionId: "child-1", rootSessionId: "r1", isSystem: false }],
    [own, { sessionId: "s", rootSessionId: "no-lease", isSystem: false }],
    [own, { sessionId: "sys", rootSessionId: "sys", isSystem: true }],
    [own, { sessionId: "s", rootSessionId: "r1" }],
  ]) {
    await h.worker(vm, "/v1/vms/admit", body);
  }
  const records = h.log.events("vm.admit");
  assert.ok(records.every((record) => record.level === "audit"));
  assert.deepEqual(records.map(({ time, level, event, ...fields }) => fields), [
    { vm: own, session: "child-1", root: "r1", isSystem: false, decision: "admit", code: null, reason: null },
    { vm: unbound, session: "child-1", root: "r1", isSystem: false, decision: "busy", code: "WORKSPACE_BUSY", reason: "VM_UNBOUND" },
    { vm: own, session: "s", root: "no-lease", isSystem: false, decision: "deny", code: "NO_DRIVE_LEASE", reason: null },
    { vm: own, session: "sys", root: "sys", isSystem: true, decision: "admit", code: null, reason: null },
  ], "a request without isSystem is refused before any decision");
  assert.equal(h.log.text().includes("per-work-secret-1"), false, "the lease's credential never");
});

test("unserved demand survives a controller restart and is served afterwards", async () => {
  const h = await createHarness({ env: { WIN_WORKER_COUNT: "1" } });
  await leased(h);
  await h.tick();
  const [vm] = h.cloud.activeVmNames();
  assert.equal(h.vmRecord(vm).ownerOid, OWNER_A, "the claim's demand started a VM for its owner");
  await h.worker(vm, "/v1/vms/register");
  await h.heartbeat(vm, { activeWorkloadCount: 1 });
  await leased(h, { owner: OWNER_B, workId: "wb", rootSessionId: "rb" });
  assert.equal((await h.coordination({ ownerOid: OWNER_B, rootSessionId: "rb" })).body.reason, "POOL_FULL");
  assert.ok(controllerRecord(h).demand.some((entry) => entry.rootSessionId === "rb"));

  const controller = createController({
    config: h.config,
    azure: createAzure({ compute: h.cloud.compute, network: h.cloud.network, monitor: h.cloud.monitor, scaleSet: h.config.scaleSet, dcrId: h.config.dcrId }),
    state: createStateStore({ backend: h.backend }),
    log: createMemoryLogger(),
    clock: h.clock,
    verifyToken: fakeVerifier,
  });
  await controller.start();
  h.cloud.autoRunCommands = () => ({ state: "Succeeded", exitCode: 0 });
  // Owner A's VM goes idle; at X the waiting owner gets its slot.
  h.clock.advance(h.config.startupGraceMs + 1000);
  const heartbeat = await controller.apps.worker.handle({
    method: "POST",
    url: "/v1/vms/heartbeat",
    headers: { authorization: `Bearer ${TOKENS.worker}` },
    remoteAddress: h.cloud.vm(vm).ip,
    body: JSON.stringify({ phase: "running", activeWorkloadCount: 0, launchId: "l" }),
  });
  assert.equal(heartbeat.status, 200);
  for (let i = 0; i < 4; i++) {
    await controller.tick();
    await controller.ctl.settle();
    h.clock.advance(MINUTES(1));
  }
  assert.equal(h.cloud.vms.has(vm), false, "owner A's idle VM was recycled for the waiting owner");
  const bound = controller.ctl.state.all("vm").filter((record) => record.ownerOid === OWNER_B);
  assert.equal(bound.length, 1, "after the restart the waiting owner got a VM");
});