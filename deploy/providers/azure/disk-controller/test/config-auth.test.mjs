// Settings, working hours and token claims.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadConfig, tokenAudience } from "../lib/config.mjs";
import { parseWorkingHours, withinWorkingHours } from "../lib/working-hours.mjs";
import { bearerToken, callerFromClaims, createTokenVerifier, peerIPv4, refusal } from "../lib/auth.mjs";
import { BASE_ENV } from "./harness.mjs";
import { APP, TENANT, WORKER_OID } from "./fakes.mjs";

test("defaults follow the stamp settings' upstream defaults", () => {
  const minimal = Object.fromEntries(Object.entries(BASE_ENV).filter(([key]) => !key.startsWith("WIN_")));
  const config = loadConfig(minimal);
  assert.deepEqual(
    { max: config.vms.max, minRunning: config.vms.minRunning, idle: config.vms.idleRecycleMs, batch: config.vms.scaleInBatch, interval: config.vms.scaleInIntervalMs, ownerOnly: config.vms.ownerOnly },
    { max: 5, minRunning: 1, idle: 30 * 60_000, batch: 1, interval: 5 * 60_000, ownerOnly: false },
  );
  assert.deepEqual(
    { ...config.drives },
    { poolCount: 10, spareCount: 2, maxPerOwner: 3, leaseExpiryMs: 7 * 86_400_000, sizeGb: 1024, growFreePercent: 20, growStepGb: 256, maxGb: 2048, iops: 6000, mbps: 250 },
  );
  assert.equal(config.scaleSet, null, "no scale set until one is configured");
  assert.equal(config.startupGraceMs, 60_000);
  assert.equal(config.snapshotRefreshMs, 7 * 86_400_000);
  assert.equal(config.tokens.audience, APP);
  assert.equal(config.tokens.authorityHost, "https://login.microsoftonline.com/");
});

test("the deploy tool's unset sentinel and empty values mean unset; set values must be valid", () => {
  const config = loadConfig({ ...BASE_ENV, DISPATCHER_SP_OBJECT_ID: "__PS_UNSET__", WIN_WORKER_COUNT: "", PILOTSWARM_PERSONAL_SECRET_VAULT_URI: "__PS_UNSET__" });
  assert.equal(config.tokens.dispatcherOid, null);
  assert.equal(config.vms.max, 5);
  assert.equal(config.personalVaultUri, null);
  for (const [name, bad] of [
    ["PS_DISK_POOL_STATE_URL", "http://placeholder.blob.core.windows.net/disk-pool-state"],
    ["PS_DISK_POOL_STATE_URL", "https://placeholder.blob.core.windows.net/disk-pool-state?sv=1"],
    ["PS_DISK_CONTROLLER_TOKEN_SCOPE", "https://graph.example/.default"],
    ["EXPECTED_WIN_WORKER_OID", "not-a-guid"],
    ["WIN_WORKER_COUNT", "0"],
    ["WIN_WORKER_COUNT", "five"],
    ["WIN_WORKER_COORDINATION_HOST", "yes"],
    ["WIN_WORKER_WORKING_HOURS", "weekdays"],
    ["WIN_WORKER_SCALE_SET_ID", "/subscriptions/x/resourceGroups/y"],
    ["WIN_DEV_DRIVE_MAX_GB", "512"],
    ["PS_DISK_CONTROLLER_VM_SCRIPTS_DIR", "C:\\pilotswarm; Remove-Item"],
  ]) {
    assert.throws(() => loadConfig({ ...BASE_ENV, [name]: bad }), (err) => err instanceof ConfigError && err.message.includes(name), `${name}=${bad}`);
  }
  assert.throws(() => loadConfig({}), (err) => err.problems.length === 4, "every required setting is named at once");
  assert.throws(() => loadConfig({ ...BASE_ENV, WIN_WORKER_MIN_RUNNING: "4", WIN_WORKER_COUNT: "3" }), /MIN_RUNNING must not be above/);
});

test("the token audience is the app's client ID, with or without api://", () => {
  assert.equal(tokenAudience(`${APP}/.default`), APP);
  assert.equal(tokenAudience(`api://${APP}/.default`), APP);
  assert.equal(tokenAudience("api://contoso/app/.default"), null);
});

test("working hours: days, a time range and a time zone, evaluated in that zone", () => {
  const hours = parseWorkingHours("Mon-Fri 08:00-18:00 America/Los_Angeles");
  // 2026-11-02 is a Monday; Los Angeles is UTC-8 in November.
  assert.equal(withinWorkingHours(hours, Date.parse("2026-11-02T16:00:00Z")), true, "Monday 08:00");
  assert.equal(withinWorkingHours(hours, Date.parse("2026-11-02T15:59:00Z")), false, "Monday 07:59");
  assert.equal(withinWorkingHours(hours, Date.parse("2026-11-03T01:59:00Z")), true, "Monday 17:59");
  assert.equal(withinWorkingHours(hours, Date.parse("2026-11-03T02:00:00Z")), false, "Monday 18:00");
  assert.equal(withinWorkingHours(hours, Date.parse("2026-11-07T18:00:00Z")), false, "Saturday 10:00");
  const weekend = parseWorkingHours("Sat,Sun 00:00-24:00 UTC");
  assert.equal(withinWorkingHours(weekend, Date.parse("2026-11-08T23:59:00Z")), true);
  assert.equal(withinWorkingHours(weekend, Date.parse("2026-11-09T00:00:00Z")), false);
  const wrap = parseWorkingHours("Fri-Mon 09:00-17:00 UTC");
  assert.deepEqual([...wrap.days].sort(), [0, 1, 5, 6]);
  for (const bad of ["Mon-Fri 18:00-08:00 UTC", "Mon-Fri 08:00-18:00", "Funday 08:00-18:00 UTC", "Mon 8:00-18:00 UTC", "Mon 08:00-18:00 Mars/Olympus"]) {
    assert.throws(() => parseWorkingHours(bad), Error, bad);
  }
  assert.equal(withinWorkingHours(null, Date.now()), false);
});

test("a caller needs a v2 token of the tenant with an object ID; roles come from the token", () => {
  const caller = callerFromClaims({ ver: "2.0", tid: TENANT, oid: WORKER_OID.toUpperCase(), roles: ["worker", 7] }, { tenantId: TENANT });
  assert.equal(caller.oid, WORKER_OID);
  assert.deepEqual([...caller.roles], ["worker"]);
  assert.equal(caller.app, true);
  assert.throws(() => callerFromClaims({ ver: "1.0", tid: TENANT, oid: WORKER_OID }, { tenantId: TENANT }), /v2/);
  assert.throws(() => callerFromClaims({ ver: "2.0", tid: "other", oid: WORKER_OID }, { tenantId: TENANT }), /tenant/);
  assert.throws(() => callerFromClaims({ ver: "2.0", tid: TENANT }, { tenantId: TENANT }), /object ID/);
  const tokens = { workerOid: WORKER_OID, dispatcherOid: null };
  assert.match(refusal("dispatcher", caller, tokens), /no dispatcher/);
  assert.equal(refusal("worker", caller, tokens), null);
  assert.match(refusal("nobody", caller, tokens), /unknown policy/);
});

test("the verifier checks the signature, issuer, audience and algorithm through jose, and only imports it when used", async () => {
  const calls = [];
  const jose = {
    createRemoteJWKSet: (url, options) => {
      calls.push(["keys", url.href, options.cacheMaxAge > 0]);
      return "key-set";
    },
    jwtVerify: async (jwt, keys, options) => {
      calls.push(["verify", jwt, keys, options]);
      return { payload: { ver: "2.0", tid: TENANT, oid: WORKER_OID, roles: ["worker"] } };
    },
  };
  let imported = 0;
  const verify = createTokenVerifier(
    { tenantId: TENANT, audience: APP, authorityHost: "https://login.microsoftonline.com/" },
    { importModule: async (name) => (imported++, assert.equal(name, "jose"), jose) },
  );
  assert.equal(imported, 0);
  const caller = await verify("a.b.c");
  await verify("d.e.f");
  assert.equal(caller.oid, WORKER_OID);
  assert.equal(imported, 1);
  assert.deepEqual(calls[0], ["keys", `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`, true]);
  assert.deepEqual(calls[1][3], { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, audience: APP, algorithms: ["RS256"], clockTolerance: 60 });
});

test("bearer tokens and peer addresses are parsed strictly", () => {
  assert.equal(bearerToken("Bearer a.b.c"), "a.b.c");
  assert.equal(bearerToken("bearer a.b.c"), null);
  assert.equal(bearerToken("Bearer a.b"), null);
  assert.equal(bearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(peerIPv4("::ffff:10.20.32.4"), "10.20.32.4");
  assert.equal(peerIPv4("10.20.32.4"), "10.20.32.4");
  assert.equal(peerIPv4("::1"), null);
  assert.equal(peerIPv4("10.20.32.256"), null);
  assert.equal(peerIPv4(undefined), null);
});
