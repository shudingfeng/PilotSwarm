// The SFI_COMPLIANT deploy step (deploy/providers/azure/deploy-steps/sfi.mjs):
// the App Gateway probe, the Front Door Private Link approval and the removal
// of PostgreSQL's AllowAllAzureServices rule, each against an Azure CLI that
// the test answers, then the step's wiring into deploy.mjs's bicep stage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  appGatewayExists,
  approveFrontDoorPrivateLink,
  deleteAllowAllAzureServicesRule,
  beforeBicep,
  afterBicep,
  stampResourceNames,
  FRONT_DOOR_REQUEST_MESSAGE,
  PRIVATE_LINK_APPROVAL_TIMEOUT_MS,
  PRIVATE_LINK_POLL_INTERVAL_MS,
} from "../../providers/azure/deploy-steps/sfi.mjs";
import { REPO_ROOT, parseEnvFile, templateEnvPath } from "../lib/common.mjs";
import { DATABASE_INPUT_KEYS } from "../lib/database-env.mjs";

const BASE_INFRA = join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep/main.bicep");
const ORIGIN_ROUTE = join(REPO_ROOT, "deploy/providers/azure/services/common/bicep/frontdoor-origin-route.bicep");

// Records every Azure CLI call and answers it with `answer(args)`.
function fakeAz(answer) {
  const calls = [];
  const runFn = (name, args) => {
    assert.equal(name, "az");
    calls.push(args);
    return { status: 0, stdout: "", stderr: "", ...answer(args) };
  };
  return { calls, runFn };
}

const notFound = (type) => ({
  status: 3,
  stderr: `ERROR: (ResourceNotFound) The Resource '${type}' under resource group 'stamp-rg' was not found.`,
});

// A clock the approval's sleeps move forward, so nothing really waits.
function fakeClock() {
  let time = 0;
  return { now: () => time, sleepFn: async (ms) => { time += ms; }, elapsed: () => time };
}

const stampEnv = (extra = {}) => ({
  SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
  RESOURCE_GROUP: "stamp-rg",
  RESOURCE_PREFIX: "psstamp",
  EDGE_MODE: "afd",
  DEPLOY_POSTGRES: "true",
  ...extra,
});

// ─── App Gateway probe ───

test("App Gateway probe: exists, absent (gateway or group), or an error that stops the deploy", () => {
  const target = { resourceGroup: "stamp-rg", name: "psstamp-appgw" };
  const present = fakeAz(() => ({ stdout: "/subscriptions/x/applicationGateways/psstamp-appgw\n" }));
  assert.equal(appGatewayExists(target, { runFn: present.runFn }), true);
  assert.deepEqual(present.calls[0].slice(0, 7),
    ["network", "application-gateway", "show", "--resource-group", "stamp-rg", "--name", "psstamp-appgw"]);

  assert.equal(appGatewayExists(target, { runFn: fakeAz(() => notFound("Microsoft.Network/applicationGateways/psstamp-appgw")).runFn }), false);
  const noGroup = fakeAz(() => ({ status: 3, stderr: "ERROR: (ResourceGroupNotFound) Resource group 'stamp-rg' could not be found." }));
  assert.equal(appGatewayExists(target, { runFn: noGroup.runFn }), false);

  const denied = fakeAz(() => ({ status: 1, stderr: "ERROR: (AuthorizationFailed) The client has no access.\nmore" }));
  assert.throws(() => appGatewayExists(target, { runFn: denied.runFn }),
    /Cannot check whether App Gateway 'psstamp-appgw' exists: ERROR: \(AuthorizationFailed\) The client has no access\.$/);
});

test("before base-infra the probe sets APP_GATEWAY_EXISTS; other modules and edge modes skip it", () => {
  for (const [answer, expected] of [[{}, "true"], [notFound("gateway"), "false"]]) {
    const env = stampEnv();
    const az = fakeAz(() => answer);
    beforeBicep({ env, modules: ["base-infra", "portal"] }, { runFn: az.runFn });
    assert.equal(env.APP_GATEWAY_EXISTS, expected);
    assert.equal(az.calls.length, 1);
  }
  for (const [env, modules] of [[stampEnv(), ["worker"]], [stampEnv({ EDGE_MODE: "private" }), ["base-infra"]]]) {
    const az = fakeAz(() => ({}));
    beforeBicep({ env, modules }, { runFn: az.runFn });
    assert.equal(env.APP_GATEWAY_EXISTS, undefined);
    assert.deepEqual(az.calls, []);
  }
});

test("the step's resource names follow base-infra's naming", () => {
  const bicep = readFileSync(BASE_INFRA, "utf8");
  assert.match(bicep, /^var applicationGatewayName = '\$\{resourceNamePrefix\}-appgw'\s*$/m);
  assert.match(bicep, /^var postgresServerName = '\$\{resourceNamePrefix\}-pg'\s*$/m);
  assert.deepEqual(stampResourceNames(stampEnv()), {
    subscriptionId: "00000000-0000-0000-0000-000000000003",
    resourceGroup: "stamp-rg",
    applicationGatewayName: "psstamp-appgw",
    postgresServerName: "psstamp-pg",
  });
  assert.throws(() => stampResourceNames(stampEnv({ RESOURCE_GROUP: "" })), /needs RESOURCE_GROUP/);
});

// ─── Front Door Private Link approval ───

const gateway = { resourceGroup: "stamp-rg", applicationGatewayName: "psstamp-appgw" };
const connection = (name, status, description = FRONT_DOOR_REQUEST_MESSAGE) => ({
  id: `/subscriptions/x/resourceGroups/stamp-rg/providers/Microsoft.Network/applicationGateways/psstamp-appgw/privateEndpointConnections/${name}`,
  name,
  properties: { privateLinkServiceConnectionState: { status, description } },
});

// Answers each `list` with the next connection list (the last one repeats).
function privateLinkApi(lists) {
  return fakeAz((args) => {
    if (args[2] !== "list") return {};
    return { stdout: JSON.stringify(lists.length > 1 ? lists.shift() : lists[0]) };
  });
}

test("the request message the step looks for is the one Front Door's origin sends", () => {
  const route = readFileSync(ORIGIN_ROUTE, "utf8");
  assert.ok(route.includes(`requestMessage: '${FRONT_DOOR_REQUEST_MESSAGE}'`));
});

test("Private Link approval: a pending Front Door connection is approved, then confirmed", async () => {
  const az = privateLinkApi([[connection("fd", "Pending")], [connection("fd", "Approved", "Approved by the deploy step")]]);
  const clock = fakeClock();
  assert.equal(await approveFrontDoorPrivateLink(gateway, { runFn: az.runFn, ...clock }), 1);
  const approvals = az.calls.filter((args) => args[2] === "approve");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0][approvals[0].indexOf("--id") + 1], connection("fd", "Pending").id);
  assert.deepEqual(az.calls[0].slice(0, 9), [
    "network", "private-endpoint-connection", "list", "--resource-group", "stamp-rg",
    "--name", "psstamp-appgw", "--type", "Microsoft.Network/applicationGateways",
  ]);
  assert.equal(clock.elapsed(), 0);
});

test("Private Link approval: an approved connection needs no call", async () => {
  const az = privateLinkApi([[connection("fd", "Approved", "Approved earlier")]]);
  assert.equal(await approveFrontDoorPrivateLink(gateway, { runFn: az.runFn, ...fakeClock() }), 0);
  assert.equal(az.calls.length, 1);
});

test("Private Link approval: waits for the connection Front Door has not requested yet", async () => {
  const az = privateLinkApi([[], [], [connection("fd", "Pending")], [connection("fd", "Approved")]]);
  const clock = fakeClock();
  assert.equal(await approveFrontDoorPrivateLink(gateway, { runFn: az.runFn, ...clock }), 1);
  assert.equal(clock.elapsed(), 2 * PRIVATE_LINK_POLL_INTERVAL_MS);
});

test("Private Link approval: gives up after 15 minutes, approving nothing it doesn't recognize", async () => {
  const other = connection("other", "Pending", "Another requester");
  const az = privateLinkApi([[other]]);
  const clock = fakeClock();
  await assert.rejects(approveFrontDoorPrivateLink(gateway, { runFn: az.runFn, ...clock }),
    /was not approved within 15 minutes \(connections: other: Pending\)/);
  assert.equal(PRIVATE_LINK_APPROVAL_TIMEOUT_MS, 15 * 60 * 1000);
  assert.ok(clock.elapsed() >= PRIVATE_LINK_APPROVAL_TIMEOUT_MS);
  assert.equal(az.calls.filter((args) => args[2] === "approve").length, 0);
  assert.equal(az.calls.length, PRIVATE_LINK_APPROVAL_TIMEOUT_MS / PRIVATE_LINK_POLL_INTERVAL_MS + 1);
});

test("Private Link approval: a failed list stops the deploy at once", async () => {
  const az = fakeAz(() => ({ status: 1, stderr: "ERROR: (AuthorizationFailed) no access" }));
  const clock = fakeClock();
  await assert.rejects(approveFrontDoorPrivateLink(gateway, { runFn: az.runFn, ...clock }),
    /Cannot list the Private Link connections of App Gateway 'psstamp-appgw': ERROR: \(AuthorizationFailed\)/);
  assert.equal(clock.elapsed(), 0);
});

// ─── PostgreSQL AllowAllAzureServices rule ───

const ruleId = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/stamp-rg" +
  "/providers/Microsoft.DBforPostgreSQL/flexibleServers/psstamp-pg/firewallRules/AllowAllAzureServices";
const server = { subscriptionId: "00000000-0000-0000-0000-000000000003", resourceGroup: "stamp-rg", serverName: "psstamp-pg" };

test("an existing AllowAllAzureServices rule is deleted; an absent one needs no call", () => {
  const present = fakeAz(() => ({ stdout: "{}" }));
  assert.equal(deleteAllowAllAzureServicesRule(server, { runFn: present.runFn }), true);
  assert.deepEqual(present.calls, [
    ["postgres", "flexible-server", "firewall-rule", "show", "--ids", ruleId, "--output", "none"],
    ["postgres", "flexible-server", "firewall-rule", "delete", "--ids", ruleId, "--yes", "--output", "none"],
  ]);

  const absent = fakeAz(() => notFound("Microsoft.DBforPostgreSQL/flexibleServers/psstamp-pg/firewallRules/AllowAllAzureServices"));
  assert.equal(deleteAllowAllAzureServicesRule(server, { runFn: absent.runFn }), false);
  assert.equal(absent.calls.length, 1);

  const denied = fakeAz(() => ({ status: 1, stderr: "ERROR: (AuthorizationFailed) no access" }));
  assert.throws(() => deleteAllowAllAzureServicesRule(server, { runFn: denied.runFn }),
    /Cannot read the AllowAllAzureServices firewall rule of PostgreSQL server 'psstamp-pg'/);
});

test("after the modules: base-infra removes the rule from a provisioned server, portal approves", async () => {
  const baseInfra = fakeAz(() => ({ stdout: "{}" }));
  await afterBicep({ env: stampEnv(), modules: ["base-infra"] }, { runFn: baseInfra.runFn });
  assert.deepEqual(baseInfra.calls.map((args) => args.slice(0, 4).join(" ")), [
    "postgres flexible-server firewall-rule show",
    "postgres flexible-server firewall-rule delete",
  ]);

  const byoDatabase = fakeAz(() => ({}));
  await afterBicep({ env: stampEnv({ DEPLOY_POSTGRES: "false" }), modules: ["base-infra"] }, { runFn: byoDatabase.runFn });
  assert.deepEqual(byoDatabase.calls, []);

  const portal = privateLinkApi([[connection("fd", "Approved")]]);
  await afterBicep({ env: stampEnv(), modules: ["portal"] }, { runFn: portal.runFn, ...fakeClock() });
  assert.deepEqual(portal.calls.map((args) => args.slice(0, 3).join(" ")), ["network private-endpoint-connection list"]);
});

// ─── Wiring into deploy.mjs ───

// An Azure CLI on PATH that logs each call (with the rendered parameters of
// a deployment) and answers just what a base-infra bicep step asks.
const FAKE_AZ = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (extra = {}) => fs.appendFileSync(process.env.SFI_TEST_CALLS, JSON.stringify({ args, ...extra }) + "\n");
const is = (...words) => words.every((word, i) => args[i] === word);
if (is("--version")) { console.log("azure-cli (test)"); process.exit(0); }
if (is("account", "show")) { console.log(process.env.SFI_TEST_SUBSCRIPTION); process.exit(0); }
if (is("ad", "signed-in-user", "show")) process.exit(1);
if (is("group", "show")) process.exit(0);
if (is("deployment", "group", "create")) {
  const file = args[args.indexOf("--parameters") + 1].slice(1);
  record({ parameters: JSON.parse(fs.readFileSync(file, "utf8")).parameters });
  process.exit(0);
}
if (is("deployment", "group", "show")) {
  console.log(JSON.stringify({
    postgresFqdn: { value: "stamp-pg.postgres.database.azure.com" },
    postgresAadAdminPrincipalName: { value: "psstamp-csi-mid" },
  }));
  process.exit(0);
}
record();
if (is("network", "application-gateway", "show")) {
  console.error("ERROR: (ResourceNotFound) The Resource 'psstamp-appgw' was not found.");
  process.exit(3);
}
if (is("postgres", "flexible-server", "firewall-rule")) process.exit(0);
console.error("unexpected az call");
process.exit(9);
`;

function writeFakeAz(dir) {
  writeFileSync(join(dir, "az.cjs"), FAKE_AZ);
  if (process.platform === "win32") {
    writeFileSync(join(dir, "az.cmd"), `@"${process.execPath}" "%~dp0az.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, "az"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/az.cjs" "$@"\n`, { mode: 0o755 });
  }
}

let sequence = 0;
function deployBaseInfraBicep(t, settings) {
  const name = `sfi${process.pid.toString(36)}${sequence++}`;
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  const dir = mkdtempSync(join(tmpdir(), "ps-sfi-step-"));
  t.after(() => {
    for (const path of [local, dir, join(REPO_ROOT, "deploy/.tmp", name), join(REPO_ROOT, "deploy/.tmp", `base-infra-${name}`)]) {
      rmSync(path, { recursive: true, force: true });
    }
  });
  const env = {
    ...parseEnvFile(templateEnvPath()),
    SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002",
    RESOURCE_PREFIX: "psstamp", RESOURCE_GROUP: "stamp-rg", PORTAL_RESOURCE_NAME: "psstamp-portal",
    GLOBAL_RESOURCE_PREFIX: "psstampglobal", GLOBAL_RESOURCE_GROUP: "psstampglobal",
    FRONT_DOOR_ID: "fixture", FRONT_DOOR_PROFILE_NAME: "fixture", FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture",
    ACME_EMAIL: "operator@example.invalid",
    ...settings,
  };
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  writeFakeAz(dir);
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");

  const childEnv = { ...process.env };
  const ambient = [...Object.keys(env), ...DATABASE_INPUT_KEYS, "SFI_COMPLIANT", "PERIMETER_OPERATOR_IP_PREFIXES",
    "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  for (const key of ambient) delete childEnv[key];
  const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  childEnv[pathKey] = `${dir}${delimiter}${childEnv[pathKey] ?? ""}`;
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "deploy/scripts/deploy.mjs"), "base-infra", name, "--steps", "bicep", "--image-tag", "fixture",
  ], { cwd: REPO_ROOT, encoding: "utf8", env: { ...childEnv, SFI_TEST_CALLS: calls, SFI_TEST_SUBSCRIPTION: env.SUBSCRIPTION_ID } });
  const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, logged };
}

test("deploy.mjs runs the step around base-infra's Bicep only with SFI_COMPLIANT=true", (t) => {
  // Off: no profile call, and no profile parameter in the rendered file.
  const off = deployBaseInfraBicep(t, {});
  assert.equal(off.result.status, 0, off.result.stderr);
  assert.deepEqual(off.logged.map(({ args }) => args.slice(0, 3).join(" ")), ["deployment group create"]);
  const rendered = Object.keys(off.logged[0].parameters);
  for (const name of ["sfiCompliant", "perimeterOperatorIpPrefixes", "appGwExists"]) assert.ok(!rendered.includes(name), name);

  // On: the probe before the deployment, the rule cleanup after it.
  const on = deployBaseInfraBicep(t, {
    SFI_COMPLIANT: "true",
    PERIMETER_OPERATOR_IP_PREFIXES: "203.0.113.7, 198.51.100.0/24",
  });
  assert.equal(on.result.status, 0, on.result.stderr);
  assert.deepEqual(on.logged.map(({ args }) => args.slice(0, 4).join(" ")), [
    "network application-gateway show --resource-group",
    "deployment group create --name",
    "postgres flexible-server firewall-rule show",
    "postgres flexible-server firewall-rule delete",
  ]);
  const { parameters } = on.logged[1];
  assert.deepEqual(parameters.sfiCompliant, { value: true });
  assert.deepEqual(parameters.appGwExists, { value: false });
  assert.deepEqual(parameters.perimeterOperatorIpPrefixes, { value: ["203.0.113.7/32", "198.51.100.0/24"] });
});
