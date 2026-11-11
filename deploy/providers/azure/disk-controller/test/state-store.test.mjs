// The controller's state store: one blob per record, every write a
// compare-and-swap on the blob's ETag, one queue per record, and the drive
// operations' own per-drive mutex.
import { test } from "node:test";
import assert from "node:assert/strict";

import { StateConflictError, createBlobStateBackend, createStateStore, recordName } from "../lib/state-store.mjs";
import { KeyedMutex } from "../lib/mutex.mjs";
import { FakeContainerClient, MemoryBackend, OWNER_A } from "./fakes.mjs";
import { createHarness } from "./harness.mjs";

test("records map to one blob each: controller.json, disks/<name>.json, vms/<name>.json", () => {
  assert.equal(recordName("controller", "controller"), "controller.json");
  assert.equal(recordName("disk", "psdrive-0123456789ab"), "disks/psdrive-0123456789ab.json");
  assert.equal(recordName("vm", "vm-1"), "vms/vm-1.json");
  assert.throws(() => recordName("disk", "../escape"), /invalid ID/);
  assert.throws(() => recordName("lease", "x"), /Unknown/);
});

test("a new record is written only if its blob does not exist, and a change only on the ETag it was read with", async () => {
  const container = new FakeContainerClient();
  const store = createStateStore({ backend: createBlobStateBackend(container) });
  await store.load();
  await store.update("disk", "psdrive-0123456789ab", () => ({ name: "psdrive-0123456789ab", n: 1 }));
  const [create] = container.calls.filter((call) => call[0] === "upload");
  assert.deepEqual(create[2].conditions, { ifNoneMatch: "*" });
  assert.equal(create[2].blobHTTPHeaders.blobContentType, "application/json");

  await store.update("disk", "psdrive-0123456789ab", (disk) => ({ ...disk, n: 2 }));
  const change = container.calls.filter((call) => call[0] === "upload")[1];
  assert.deepEqual(change[2].conditions, { ifMatch: '"0x1"' });

  await store.update("disk", "psdrive-0123456789ab", () => null);
  const removal = container.calls.find((call) => call[0] === "delete");
  assert.deepEqual(removal[2].conditions, { ifMatch: '"0x2"' });
  assert.equal(container.blobs.size, 0);
});

test("a conflicting writer makes the store read the record again and apply the change to it", async () => {
  const backend = new MemoryBackend();
  const store = createStateStore({ backend });
  await store.load();
  await store.update("controller", "controller", () => ({ demand: [], counter: 1 }));
  // Another process writes behind the store's back; the cached ETag is stale.
  backend.externalWrite("controller.json", { demand: [{ ownerOid: OWNER_A }], counter: 10 });
  const seen = [];
  const result = await store.update("controller", "controller", (c) => {
    seen.push(c.counter);
    return { ...c, counter: c.counter + 1 };
  });
  assert.deepEqual(seen, [1, 10], "the change ran on the stale copy, conflicted, and ran again on the fresh one");
  assert.equal(result.counter, 11);
  assert.deepEqual(backend.value("controller.json"), { demand: [{ ownerOid: OWNER_A }], counter: 11 });
});

test("a record created behind the store's back is a conflict for a create, which then sees it", async () => {
  const container = new FakeContainerClient();
  const store = createStateStore({ backend: createBlobStateBackend(container) });
  await store.load();
  await createBlobStateBackend(container).put("vms/vm-1.json", { name: "vm-1", ownerOid: OWNER_A }, null);
  const seen = [];
  await store.update("vm", "vm-1", (vm) => {
    seen.push(vm);
    return vm ?? { name: "vm-1", ownerOid: null };
  });
  assert.deepEqual(seen, [null, { name: "vm-1", ownerOid: OWNER_A }]);
  assert.equal(store.get("vm", "vm-1").ownerOid, OWNER_A, "the other writer's record survives");
});

test("a record that keeps conflicting fails the write after a few attempts", async () => {
  const backend = new MemoryBackend();
  const store = createStateStore({ backend, maxAttempts: 3 });
  await store.load();
  await store.update("vm", "vm-1", () => ({ n: 0 }));
  let calls = 0;
  await assert.rejects(store.update("vm", "vm-1", (vm) => {
    calls++;
    backend.externalWrite("vms/vm-1.json", { n: 100 + calls });
    return { ...vm, n: vm.n + 1 };
  }), StateConflictError);
  assert.equal(calls, 3);
});

test("writes to one record queue behind each other; a change must be synchronous", async () => {
  const store = createStateStore({ backend: new MemoryBackend() });
  await store.load();
  await Promise.all(Array.from({ length: 20 }, () => store.update("disk", "psdrive-0123456789ab", (disk) => ({ n: (disk?.n ?? 0) + 1 }))));
  assert.equal(store.get("disk", "psdrive-0123456789ab").n, 20);
  await assert.rejects(store.update("disk", "psdrive-0123456789ab", async (disk) => disk), /synchronous/);
});

test("reads are copies: changing one changes nothing in the store", async () => {
  const store = createStateStore({ backend: new MemoryBackend() });
  await store.load();
  await store.update("disk", "psdrive-0123456789ab", () => ({ lease: { workId: "w" } }));
  store.get("disk", "psdrive-0123456789ab").lease.workId = "changed";
  store.all("disk")[0].lease.workId = "changed";
  assert.equal(store.get("disk", "psdrive-0123456789ab").lease.workId, "w");
});

test("the blob backend reads every record with its ETag and maps a missing blob to null", async () => {
  const container = new FakeContainerClient();
  const backend = createBlobStateBackend(container);
  await backend.put("controller.json", { upgradeFrozen: true }, null);
  await backend.put("disks/psdrive-0123456789ab.json", { name: "psdrive-0123456789ab" }, null);
  const records = await backend.list();
  assert.deepEqual(records.map((record) => [record.name, record.etag]), [["controller.json", '"0x1"'], ["disks/psdrive-0123456789ab.json", '"0x2"']]);
  assert.equal(await backend.get("vms/none.json"), null);
  await assert.rejects(backend.put("controller.json", {}, '"0x9"'), StateConflictError);
  await assert.rejects(backend.put("controller.json", {}, null), StateConflictError);
  await backend.remove("vms/none.json", '"0x1"');
});

test("the keyed mutex runs one call per key at a time and never blocks another key", async () => {
  const mutex = new KeyedMutex();
  const order = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = mutex.run("disk:a", async () => {
    order.push("a1 start");
    await held;
    order.push("a1 end");
  });
  const second = mutex.run("disk:a", async () => order.push("a2"));
  const other = mutex.run("disk:b", async () => order.push("b"));
  await other;
  assert.deepEqual(order, ["a1 start", "b"]);
  assert.ok(mutex.isLocked("disk:a"));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1 start", "b", "a1 end", "a2"]);
  assert.equal(mutex.isLocked("disk:a"), false);
  await assert.rejects(mutex.run("disk:c", async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(await mutex.run("disk:c", async () => "after"), "after", "a failure releases the key");
});

test("two attaches of one drive from two VMs at once: the drive's mutex lets one attach and refuses the other", async () => {
  const h = await createHarness();
  const vm1 = await h.activeVm({ owner: OWNER_A });
  const vm2 = await h.activeVm({ owner: OWNER_A });
  await h.spares();
  assert.equal((await h.claim({ ownerOid: OWNER_A })).body.decision, "ok");
  const [one, two] = await Promise.all([
    h.worker(vm1, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r1", purpose: "check" }),
    h.worker(vm2, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r2", purpose: "check" }),
  ]);
  const answers = [one.body, two.body];
  assert.equal(answers.filter((answer) => answer.ok).length, 1, JSON.stringify(answers));
  assert.equal(answers.find((answer) => !answer.ok).reason, "HELD_ELSEWHERE");
  assert.equal(h.cloud.callsOf("vm.attachDetach").length, 1, "Azure saw one attach");
});
