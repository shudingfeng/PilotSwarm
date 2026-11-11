// The credential broker's release rules. The model token: the worker role
// and identity (route), an active non-draining VM by source address, a live
// lease of the session's root, the VM bound to the lease's owner, and the
// owner's own enabled, unexpired secret by name and tag. The per-work
// credential: only to the VM that holds the work's drive. Every answer is
// audited, never with the value.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startDrain } from "../lib/fleet.mjs";
import { createHarness } from "./harness.mjs";
import { OWNER_A, OWNER_B, TOKENS, createMemoryLogger, restError } from "./fakes.mjs";

const TOKEN_VALUE = "github_pat_" + "0".repeat(82);
const secretName = (owner, id = "1".repeat(32)) => `ghcp-${owner}-${id}`;

async function setup(options = {}) {
  const h = await createHarness(options);
  const vm = await h.activeVm({ owner: OWNER_A });
  await h.spares();
  assert.equal((await h.claim({ ownerOid: OWNER_A, workId: "work-1", rootSessionId: "root-1", credential: "per-work-Qx7" })).body.decision, "ok");
  const version = h.secrets.set(secretName(OWNER_A), TOKEN_VALUE, { ownerOid: OWNER_A, expiresOn: new Date("2026-12-01T00:00:00Z") });
  const ask = (from, extra = {}) => h.worker(from, "/v1/credentials/model", {
    sessionId: "child-1", rootSessionId: "root-1", provider: "ghcp-a", secretName: secretName(OWNER_A), secretVersion: version, ...extra,
  });
  return { h, vm, version, ask };
}

test("the model token goes to the owner's bound VM for a leased root, audited without its value", async () => {
  const { h, vm, version, ask } = await setup();
  const answer = await ask(vm);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { status: "ok", token: TOKEN_VALUE });
  assert.equal(answer.headers["cache-control"], "no-store");
  assert.deepEqual(h.secrets.reads, [[secretName(OWNER_A), version]], "exactly the referenced version");
  const [audit] = h.log.events("credential.model");
  assert.deepEqual(
    { vm: audit.vm, owner: audit.owner, root: audit.root, session: audit.session, secretName: audit.secretName, outcome: audit.outcome },
    { vm, owner: OWNER_A, root: "root-1", session: "child-1", secretName: secretName(OWNER_A), outcome: "ok" },
  );
  assert.equal(h.log.text().includes(TOKEN_VALUE), false, "the value is in no log record");
  assert.equal(JSON.stringify(h.backend.blobs).includes(TOKEN_VALUE), false, "nor in the controller's state");
});

test("the log drops fields named like a secret, whatever a caller passes", () => {
  const log = createMemoryLogger();
  log.audit("credential.model", { token: TOKEN_VALUE, Credential: "c", value: "v", password: "p", authorization: "Bearer x", SECRET: "s", outcome: "ok" });
  const [record] = log.records();
  assert.deepEqual(Object.keys(record).sort(), ["event", "level", "outcome", "time"]);
  assert.equal(log.text().includes(TOKEN_VALUE), false);
});

test("rule 1: only the worker role on the workers' identity", async () => {
  const { h, vm, version } = await setup();
  for (const token of [TOKENS.workerWrongOid, TOKENS.workerNoRole, TOKENS.dispatcher, TOKENS.coordinator]) {
    const answer = await h.worker(vm, "/v1/credentials/model", { sessionId: "s", rootSessionId: "root-1", provider: "p", secretName: secretName(OWNER_A), secretVersion: version }, token);
    assert.equal(answer.status, 403);
  }
  assert.equal(h.secrets.reads.length, 0);
});

test("rule 2: only an active, non-draining VM of the pool, by source address", async () => {
  const { h, vm, ask } = await setup();
  const stranger = h.cloud.addStrangerVm("10.20.32.201");
  h.ctl.runtime.nics.at = 0;
  const fromStranger = await h.call("worker", "POST", "/v1/credentials/model", { token: TOKENS.worker, from: "10.20.32.201", body: {} });
  assert.equal(fromStranger.status, 403);
  assert.ok(stranger);
  await startDrain(h.ctl, vm, "test", { deleteAfter: true });
  const draining = await ask(vm);
  assert.deepEqual({ status: draining.body.status, code: draining.body.code }, { status: "refused", code: "VM_NOT_ACTIVE" });
  assert.equal(h.secrets.reads.length, 0);
});

test("rule 3: a session whose root holds no lease is refused; a parked or returning lease is busy for 15 minutes", async () => {
  const { h, vm, ask } = await setup();
  const none = (await ask(vm, { rootSessionId: "root-without-lease" })).body;
  assert.deepEqual({ status: none.status, code: none.code }, { status: "refused", code: "NO_DRIVE_LEASE" });
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  const parked = (await ask(vm)).body;
  assert.deepEqual({ status: parked.status, code: parked.code, reason: parked.reason, retryAfterMs: parked.retryAfterMs }, { status: "busy", code: "WORKSPACE_BUSY", reason: "PARKED", retryAfterMs: 900_000 });
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  assert.equal((await ask(vm)).body.code, "NO_DRIVE_LEASE", "a returned lease is gone");
  assert.equal(h.secrets.reads.length, 0);
});

test("rule 3: a returning lease that a VM still holds is busy on both routes until the return completes", async () => {
  const { h, vm, ask } = await setup();
  const attached = (await h.worker(vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "a-1", purpose: "turn" })).body;
  assert.equal(attached.ok, true, JSON.stringify(attached));
  await h.dispatcher("/disk-pool/v1/disks/return", { workId: "work-1" });
  const work = async () => (await h.worker(vm, "/v1/credentials/work", { rootSessionId: "root-1" })).body;
  for (const answer of [(await ask(vm)).body, await work()]) {
    assert.deepEqual(
      { status: answer.status, code: answer.code, reason: answer.reason, retryAfterMs: answer.retryAfterMs },
      { status: "busy", code: "WORKSPACE_BUSY", reason: "RETURNING", retryAfterMs: 900_000 },
    );
  }
  await h.worker(vm, "/v1/leases/detach", { diskName: attached.diskName, rootSessionId: "root-1", requestId: "d-1" });
  await h.tick();
  assert.equal(h.driveOf("work-1"), null, "the return completed");
  assert.equal((await ask(vm)).body.code, "NO_DRIVE_LEASE");
  assert.equal((await work()).code, "NO_DRIVE_LEASE");
  assert.equal(h.secrets.reads.length, 0);
});

test("rule 4: a VM bound to another owner, or to none, is refused", async () => {
  const { h, ask } = await setup();
  const other = await h.activeVm({ owner: OWNER_B });
  assert.equal((await ask(other)).body.code, "VM_NOT_BOUND_TO_OWNER");
  const unbound = await h.activeVm();
  assert.equal((await ask(unbound)).body.code, "VM_NOT_BOUND_TO_OWNER");
  assert.equal(h.secrets.reads.length, 0);
});

test("rule 5: owner A's VM never gets owner B's secret, a secret tagged for someone else, a disabled one or an expired one", async () => {
  const { h, vm, ask } = await setup();
  const theirs = h.secrets.set(secretName(OWNER_B), "github_pat_B", { ownerOid: OWNER_B });
  const crossOwner = (await ask(vm, { secretName: secretName(OWNER_B), secretVersion: theirs })).body;
  assert.deepEqual({ status: crossOwner.status, code: crossOwner.code }, { status: "refused", code: "SECRET_NOT_OWNERS" });
  assert.equal(h.secrets.reads.length, 0, "refused by name, before any vault read");
  assert.equal((await ask(vm, { secretName: "ghcp-other-name" })).body.code, "SECRET_NOT_OWNERS");

  const misTagged = h.secrets.set(secretName(OWNER_A, "2".repeat(32)), "github_pat_planted", { ownerOid: OWNER_B });
  assert.equal((await ask(vm, { secretName: secretName(OWNER_A, "2".repeat(32)), secretVersion: misTagged })).body.code, "SECRET_TAG_MISMATCH");
  const disabled = h.secrets.set(secretName(OWNER_A, "3".repeat(32)), "github_pat_off", { ownerOid: OWNER_A, enabled: false });
  assert.equal((await ask(vm, { secretName: secretName(OWNER_A, "3".repeat(32)), secretVersion: disabled })).body.code, "SECRET_DISABLED");
  const expired = h.secrets.set(secretName(OWNER_A, "4".repeat(32)), "github_pat_old", { ownerOid: OWNER_A, expiresOn: new Date(h.clock.now() - 1000) });
  assert.equal((await ask(vm, { secretName: secretName(OWNER_A, "4".repeat(32)), secretVersion: expired })).body.code, "SECRET_EXPIRED");
  assert.equal((await ask(vm, { secretVersion: "e".repeat(32) })).body.code, "SECRET_NOT_FOUND");
  const text = h.log.text();
  for (const value of ["github_pat_B", "github_pat_planted", "github_pat_off", "github_pat_old"]) assert.equal(text.includes(value), false);
  assert.deepEqual(h.log.events("credential.model").map((record) => record.code), ["SECRET_NOT_OWNERS", "SECRET_NOT_OWNERS", "SECRET_TAG_MISMATCH", "SECRET_DISABLED", "SECRET_EXPIRED", "SECRET_NOT_FOUND"]);
});

test("a vault failure is `unavailable` (503) so the turn retries; no vault configured is the same; the startup grace answers busy", async () => {
  const { h, vm, ask } = await setup();
  h.secrets.failure = restError(503, "ServiceUnavailable");
  const failed = await ask(vm);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.status, "unavailable");

  const noVault = await createHarness({ withSecrets: false });
  const other = await noVault.activeVm({ owner: OWNER_A });
  const answer = await noVault.worker(other, "/v1/credentials/model", { sessionId: "s", rootSessionId: "root-1", provider: "p", secretName: secretName(OWNER_A), secretVersion: "a".repeat(32) });
  assert.equal(answer.status, 503);

  const starting = await createHarness({ graceOver: false });
  starting.clock.advance(starting.config.startupGraceMs + 1);
  const early = await starting.activeVm({ owner: OWNER_A });
  starting.ctl.startedAt = starting.clock.now();
  const busy = (await starting.worker(early, "/v1/credentials/model", { sessionId: "s", rootSessionId: "root-1", provider: "p", secretName: secretName(OWNER_A), secretVersion: "a".repeat(32) })).body;
  assert.deepEqual({ status: busy.status, reason: busy.reason }, { status: "busy", reason: "CONTROLLER_STARTING" });
});

test("the per-work credential goes only to the VM that holds the work's drive and is bound to its owner", async () => {
  const { h, vm } = await setup();
  const other = await h.activeVm({ owner: OWNER_A });
  const ask = (from) => h.worker(from, "/v1/credentials/work", { rootSessionId: "root-1" }).then((answer) => answer.body);
  assert.equal((await ask(vm)).code, "DRIVE_NOT_ON_VM", "no VM holds the drive yet");
  await h.worker(vm, "/v1/leases/attach", { rootSessionId: "root-1", requestId: "r", purpose: "turn" });
  assert.deepEqual(await ask(vm), { status: "ok", credential: "per-work-Qx7" });
  assert.equal((await ask(other)).code, "DRIVE_NOT_ON_VM", "a VM of the same owner that does not hold the drive");
  const stranger = await h.activeVm({ owner: OWNER_B });
  assert.equal((await ask(stranger)).code, "VM_NOT_BOUND_TO_OWNER");
  await h.dispatcher("/disk-pool/v1/disks/park", { workId: "work-1" });
  assert.equal((await ask(vm)).reason, "PARKED");
  assert.equal(h.log.text().includes("per-work-Qx7"), false);
  assert.deepEqual(h.log.events("credential.work").map((record) => record.outcome), ["refused", "ok", "refused", "refused", "busy"]);
});

test("the dispatcher reads a token's expiry and state, never its value", async () => {
  const { h } = await setup();
  const status = (path) => h.call("dispatcher", "GET", path, { token: TOKENS.dispatcher });
  const answer = await status(`/disk-pool/v1/owners/${OWNER_A}/model-credential`);
  assert.deepEqual(answer.body, { present: true, expiresOn: "2026-12-01T00:00:00.000Z", enabled: true });
  assert.equal(answer.text.includes(TOKEN_VALUE), false);
  h.secrets.set(secretName(OWNER_A, "5".repeat(32)), "github_pat_newer", { ownerOid: OWNER_A, expiresOn: new Date("2026-12-20T00:00:00Z"), updatedOn: new Date("2026-11-05T00:00:00Z") });
  h.secrets.set(secretName(OWNER_A, "6".repeat(32)), "github_pat_wrong_tag", { ownerOid: OWNER_B, updatedOn: new Date("2026-11-09T00:00:00Z") });
  assert.equal((await status(`/disk-pool/v1/owners/${OWNER_A}/model-credential`)).body.expiresOn, "2026-12-20T00:00:00.000Z", "the newest secret named and tagged for the owner");
  assert.deepEqual((await status(`/disk-pool/v1/owners/${OWNER_B}/model-credential`)).body, { present: false, expiresOn: null, enabled: false });
  assert.equal((await status("/disk-pool/v1/owners/not-a-guid/model-credential")).status, 400);
  assert.deepEqual(h.secrets.reads, [], "only metadata is listed");
  h.secrets.failure = restError(500, "InternalError");
  assert.equal((await status(`/disk-pool/v1/owners/${OWNER_A}/model-credential`)).status, 503);
});
