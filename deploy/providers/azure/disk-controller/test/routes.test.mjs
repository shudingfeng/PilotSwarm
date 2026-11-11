// Who may call each controller route (Appendix C of the design): worker
// routes only with the worker role, the workers' identity and a pool VM's
// source address; dispatcher routes only for DISPATCHER_SP_OBJECT_ID's `user`
// token; the upgrade freeze only with `admin` or `deployer`, the status only
// with `admin`; the coordination route only with `coordinator`; the health
// probe with no token and no data. Every route answers only on its own port.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHarness, BASE_ENV } from "./harness.mjs";
import { OWNER_A, TOKENS } from "./fakes.mjs";

const WORKER_ROUTES = [
  ["/v1/vms/register", {}],
  ["/v1/vms/heartbeat", { phase: "running" }],
  ["/v1/vms/admit", { sessionId: "s-1", rootSessionId: "root-1", isSystem: false }],
  ["/v1/vms/demand", { ownerOid: OWNER_A, rootSessionId: "root-1" }],
  ["/v1/vms/busy", { rootSessionId: "root-1" }],
  ["/v1/leases/attach", { rootSessionId: "root-1", requestId: "r-1", purpose: "turn" }],
  ["/v1/leases/detach", { diskName: "psdrive-000000000000", rootSessionId: "root-1", requestId: "r-1" }],
  ["/v1/credentials/model", { sessionId: "s-1", rootSessionId: "root-1", provider: "ghcp-a", secretName: `ghcp-${OWNER_A}-${"0".repeat(32)}`, secretVersion: "f".repeat(32) }],
  ["/v1/credentials/work", { rootSessionId: "root-1" }],
];

const DISPATCHER_ROUTES = [
  ["POST", "/disk-pool/v1/disks/claim", { workId: "w-1", rootSessionId: "root-1", ownerOid: OWNER_A, credential: "c-1" }],
  ["POST", "/disk-pool/v1/disks/park", { workId: "w-1" }],
  ["POST", "/disk-pool/v1/disks/sync-branch", { workId: "w-1", sourceBranch: "main", headSha: "a".repeat(40), url: "https://git.example/repo", credential: "c-2" }],
  ["POST", "/disk-pool/v1/disks/rebind", { workId: "w-1", rootSessionId: "root-2", ownerOid: OWNER_A, credential: "c-3" }],
  ["POST", "/disk-pool/v1/disks/return", { workId: "w-1" }],
  ["POST", "/disk-pool/v1/disks/credential", { workId: "w-1", credential: "c-4" }],
  ["GET", `/disk-pool/v1/owners/${OWNER_A}/model-credential`, undefined],
];

// The deployer role (the deploy pipeline) reaches the upgrade freeze only:
// the status names every lease's work, root session and owner.
const ADMIN_ROUTES = [
  ["POST", "/v1/admin/upgrade-freeze", { frozen: false }, 200],
  ["GET", "/v1/admin/upgrade-freeze", undefined, 200],
  ["GET", "/v1/admin/status", undefined, 403],
];

test("worker routes need a valid v2 token with the worker role and the workers' identity", async () => {
  const h = await createHarness();
  const vm = await h.activeVm({ owner: OWNER_A });
  for (const [path, body] of WORKER_ROUTES) {
    for (const [label, token, status] of [
      ["no token", null, 401],
      ["a token that does not verify", TOKENS.invalid, 401],
      ["a v1 token", TOKENS.v1, 401],
      ["another tenant's token", TOKENS.otherTenant, 401],
      ["the worker role on another identity", TOKENS.workerWrongOid, 403],
      ["the workers' identity without the role", TOKENS.workerNoRole, 403],
      ["the dispatcher's token", TOKENS.dispatcher, 403],
      ["an admin token", TOKENS.admin, 403],
      ["the coordinator's token", TOKENS.coordinator, 403],
    ]) {
      const answer = await h.worker(vm, path, body, token);
      assert.equal(answer.status, status, `${path} with ${label}`);
    }
    const allowed = await h.worker(vm, path, body);
    assert.ok(![401, 403, 404].includes(allowed.status), `${path} with the worker token: ${allowed.status} ${allowed.text}`);
  }
});

test("worker routes take the VM from the source address, never from the body", async () => {
  const h = await createHarness();
  const vm = await h.activeVm({ owner: OWNER_A });
  const stranger = h.cloud.addStrangerVm("10.20.32.200");
  const forwarding = await h.activeVm();
  h.cloud.vm(forwarding).ipForwarding = true;
  h.ctl.runtime.nics.at = 0;
  for (const [path, body] of WORKER_ROUTES) {
    for (const [label, from] of [
      ["a port-forward from 127.0.0.1", "127.0.0.1"],
      ["an IPv6 loopback", "::1"],
      ["an address no NIC has", "10.20.32.250"],
      ["a VM outside the scale set", "10.20.32.200"],
      ["a VM whose NIC forwards IP", h.cloud.vm(forwarding).ip],
      ["a pod address", "10.20.0.57"],
    ]) {
      const answer = await h.call("worker", "POST", path, { token: TOKENS.worker, body: { ...body, vmName: vm }, from });
      assert.equal(answer.status, 403, `${path} from ${label}`);
      assert.equal(answer.body.error, "UNKNOWN_SOURCE", `${path} from ${label}`);
    }
  }
  assert.ok(stranger);
  // The reported name is ignored: the answer is about the VM the address belongs to.
  const other = await h.activeVm();
  const answer = await h.worker(other, "/v1/vms/heartbeat", { vmName: vm, phase: "running" });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ownerOid, null, "the unbound caller, not the bound VM it named");
});

test("dispatcher routes accept only DISPATCHER_SP_OBJECT_ID's user token; a developer's own user token is refused", async () => {
  const h = await createHarness();
  for (const [method, path, body] of DISPATCHER_ROUTES) {
    for (const [label, token, status] of [
      ["no token", null, 401],
      ["a token that does not verify", TOKENS.invalid, 401],
      ["a developer's own user token", TOKENS.developer, 403],
      ["the dispatcher's identity without the user role", TOKENS.dispatcherNoRole, 403],
      ["the workers' token", TOKENS.worker, 403],
      ["an admin token", TOKENS.admin, 403],
      ["the deployer's token", TOKENS.deployer, 403],
      ["the coordinator's token", TOKENS.coordinator, 403],
    ]) {
      const answer = await h.call("dispatcher", method, path, { token, body });
      assert.equal(answer.status, status, `${method} ${path} with ${label}`);
    }
    const allowed = await h.call("dispatcher", method, path, { token: TOKENS.dispatcher, body });
    assert.ok(![401, 403].includes(allowed.status), `${method} ${path}: ${allowed.status} ${allowed.text}`);
  }
  const audited = h.log.events("dispatcher.call");
  assert.equal(audited.length, DISPATCHER_ROUTES.length, "every accepted dispatcher call is audited");
  assert.equal(h.log.events("auth.forbidden").filter((record) => record.listener === "dispatcher").length, DISPATCHER_ROUTES.length * 6);
});

test("without DISPATCHER_SP_OBJECT_ID every dispatcher route is refused", async () => {
  const h = await createHarness({ env: { DISPATCHER_SP_OBJECT_ID: "" } });
  for (const [method, path, body] of DISPATCHER_ROUTES) {
    const answer = await h.call("dispatcher", method, path, { token: TOKENS.dispatcher, body });
    assert.equal(answer.status, 403, path);
  }
});

test("admin routes take the admin role, and the upgrade freeze also the deployer role, from any source (kubectl port-forward)", async () => {
  const h = await createHarness();
  for (const [method, path, body, deployer] of ADMIN_ROUTES) {
    for (const [label, token, status] of [
      ["no token", null, 401],
      ["the workers' token", TOKENS.worker, 403],
      ["the dispatcher's token", TOKENS.dispatcher, 403],
      ["a developer's user token", TOKENS.developer, 403],
      ["the coordinator's token", TOKENS.coordinator, 403],
      ["an admin token", TOKENS.admin, 200],
      ["the deployer's token", TOKENS.deployer, deployer],
    ]) {
      const answer = await h.call("worker", method, path, { token, body, from: "127.0.0.1" });
      assert.equal(answer.status, status, `${method} ${path} with ${label}`);
    }
  }
});

test("the coordination route takes the coordinator role only", async () => {
  const h = await createHarness();
  const body = { ownerOid: OWNER_A, rootSessionId: "root-1" };
  for (const [label, token, status] of [
    ["no token", null, 401],
    ["the workers' token", TOKENS.worker, 403],
    ["the dispatcher's token", TOKENS.dispatcher, 403],
    ["an admin token", TOKENS.admin, 403],
    ["the deployer's token", TOKENS.deployer, 403],
    ["the coordinator's token", TOKENS.coordinator, 200],
  ]) {
    assert.equal((await h.coordination(body, token)).status, status, label);
  }
});

test("the health probe takes no token and answers 200 without data, and only on the dispatcher port", async () => {
  const h = await createHarness();
  for (const headers of [{}, { authorization: "Bearer nonsense" }]) {
    const answer = await h.controller.apps.dispatcher.handle({ method: "GET", url: "/disk-pool/v1/healthz", headers, remoteAddress: "10.20.16.5" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "");
  }
  assert.equal((await h.call("worker", "GET", "/disk-pool/v1/healthz")).status, 404);
  assert.equal((await h.call("coordination", "GET", "/disk-pool/v1/healthz")).status, 404);
  assert.equal((await h.call("dispatcher", "POST", "/disk-pool/v1/healthz")).status, 405);
  assert.equal(h.log.events("dispatcher.call").length, 0, "the probe is not a dispatcher call");
});

test("the health probe answers 503 until the controller has loaded its state", async () => {
  const { createController } = await import("../lib/controller.mjs");
  const { loadConfig } = await import("../lib/config.mjs");
  const { createStateStore } = await import("../lib/state-store.mjs");
  const { MemoryBackend, createMemoryLogger, fakeVerifier } = await import("./fakes.mjs");
  const controller = createController({
    config: loadConfig(BASE_ENV),
    state: createStateStore({ backend: new MemoryBackend() }),
    log: createMemoryLogger(),
    verifyToken: fakeVerifier,
  });
  const answer = await controller.apps.dispatcher.handle({ method: "GET", url: "/disk-pool/v1/healthz", headers: {} });
  assert.equal(answer.status, 503);
  assert.equal(answer.body, "");
  await controller.start();
  assert.equal((await controller.apps.dispatcher.handle({ method: "GET", url: "/disk-pool/v1/healthz", headers: {} })).status, 200);
});

test("each listener serves only its own routes", async () => {
  const h = await createHarness();
  for (const [path] of WORKER_ROUTES) {
    assert.equal((await h.call("dispatcher", "POST", path, { token: TOKENS.worker })).status, 404, `${path} on the dispatcher port`);
    assert.equal((await h.call("coordination", "POST", path, { token: TOKENS.worker })).status, 404, `${path} on the coordination port`);
  }
  for (const [method, path] of [...DISPATCHER_ROUTES, ["POST", "/v1/coordination/demand"]]) {
    assert.equal((await h.call("worker", method, path, { token: TOKENS.dispatcher })).status, 404, `${path} on the worker port`);
  }
  for (const [method, path] of DISPATCHER_ROUTES) {
    assert.equal((await h.call("coordination", method, path, { token: TOKENS.dispatcher })).status, 404, `${path} on the coordination port`);
  }
  for (const [method, path] of ADMIN_ROUTES) {
    assert.equal((await h.call("dispatcher", method, path, { token: TOKENS.deployer })).status, 404, `${path} on the dispatcher port`);
    assert.equal((await h.call("coordination", method, path, { token: TOKENS.deployer })).status, 404, `${path} on the coordination port`);
  }
});

test("bodies must be JSON objects, and a route's own checks answer 400", async () => {
  const h = await createHarness();
  const vm = await h.activeVm({ owner: OWNER_A });
  assert.equal((await h.worker(vm, "/v1/vms/admit", "not json")).status, 400);
  assert.equal((await h.worker(vm, "/v1/vms/admit", "[1,2]")).status, 400);
  assert.equal((await h.worker(vm, "/v1/vms/admit", { sessionId: "s", rootSessionId: "r" })).status, 400, "isSystem is required");
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/claim", { workId: "w", rootSessionId: "r", ownerOid: "not-a-guid", credential: "c" })).status, 400);
  assert.equal((await h.dispatcher("/disk-pool/v1/disks/claim", { workId: "w", rootSessionId: "r", ownerOid: OWNER_A, credential: "has space" })).status, 400);
});
