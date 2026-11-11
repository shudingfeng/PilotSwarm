// The Entra helper scripts in deploy/scripts/auth against a stub `az`.
//
// Each test runs a script in pwsh with a global `az` function, which
// PowerShell resolves before the Azure CLI on PATH. The stub records every
// call, with the contents of the `@file` arguments the scripts pass (request
// bodies, app roles), and answers from canned JSON, so a test sees exactly
// what the script would send and nothing reaches Azure. AZURE_CONFIG_DIR
// points at an empty folder, so a call the stub missed has no sign-in.
// Without pwsh the tests skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const AUTH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "auth");
const pwshWorks = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;

// A rule answers the first call whose arguments start with `match`; any other
// call succeeds with no output.
const DRIVER = `param([string]$Rules, [string]$Log, [string]$Script, [string]$Params)
$ErrorActionPreference = "Stop"
$parsedRules = Get-Content -LiteralPath $Rules -Raw | ConvertFrom-Json
$global:AzStubRules = @($parsedRules)
$global:AzStubLog = $Log
function global:az {
    $callArgs = @($args | ForEach-Object { [string]$_ })
    $files = [ordered]@{}
    foreach ($a in $callArgs) {
        if ($a.StartsWith("@") -and (Test-Path -LiteralPath $a.Substring(1))) {
            $files[$a] = [System.IO.File]::ReadAllText($a.Substring(1))
        }
    }
    $line = ConvertTo-Json -InputObject ([ordered]@{ args = $callArgs; files = $files }) -Compress -Depth 5
    [System.IO.File]::AppendAllText($global:AzStubLog, $line + [char]10)
    foreach ($rule in $global:AzStubRules) {
        $match = @($rule.match)
        if ($match.Count -gt $callArgs.Count) { continue }
        $hit = $true
        for ($i = 0; $i -lt $match.Count; $i++) {
            if ($match[$i] -cne $callArgs[$i]) { $hit = $false; break }
        }
        if ($hit) {
            $global:LASTEXITCODE = [int]$rule.exit
            if ([string]$rule.stdout) { return [string]$rule.stdout }
            return
        }
    }
    $global:LASTEXITCODE = 0
}
if ((Get-Command az).CommandType -ne "Function") { throw "The az stub is not in effect." }
$splat = @{}
$parsedParams = Get-Content -LiteralPath $Params -Raw | ConvertFrom-Json
foreach ($p in $parsedParams.PSObject.Properties) { $splat[$p.Name] = $p.Value }
& $Script @splat
`;

function run(t, script, params, rules) {
  if (!pwshWorks) {
    t.skip("pwsh is not installed");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "ps-portal-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const log = join(dir, "calls.jsonl");
  mkdirSync(join(dir, "az-config"));
  const result = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", write("driver.ps1", DRIVER),
    "-Rules", write("rules.json", JSON.stringify(rules)),
    "-Log", log,
    "-Script", join(AUTH_DIR, script),
    "-Params", write("params.json", JSON.stringify(params)),
  ], { encoding: "utf8", env: { ...process.env, AZURE_CONFIG_DIR: join(dir, "az-config") } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { stdout: result.stdout.replace(/\s+/g, " "), calls };
}

const reply = (match, out = "", exit = 0) => ({ match, exit, stdout: typeof out === "string" ? out : JSON.stringify(out) });
const words = (call) => call.args.slice(0, 3).join(" ");
const payload = (call, flag) => JSON.parse(call.files[call.args[call.args.indexOf(flag) + 1]]);
const patchBodies = (calls) => calls
  .filter((c) => words(c) === "rest --method PATCH")
  .map((c) => JSON.parse(c.files[c.args[c.args.indexOf("--body") + 1]]));

const NEW_APP = { appId: "22222222-2222-2222-2222-222222222222", id: "11111111-1111-1111-1111-111111111111" };
const APP_ID = "44444444-4444-4444-4444-444444444444";
const APP_OBJECT_ID = "55555555-5555-5555-5555-555555555555";
const APP_SP = "66666666-6666-6666-6666-666666666666";
const ROLE_IDS = {
  admin: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  user: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  worker: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  deployer: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  coordinator: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  auditor: "ffffffff-ffff-ffff-ffff-ffffffffffff",
};
const ALICE = "77777777-7777-7777-7777-777777777777";
const WORKER_MI = "12121212-1212-1212-1212-121212121212";
const PIPELINE_MI = "13131313-1313-1313-1313-131313131313";
const COORDINATOR_MI = "14141414-1414-1414-1414-141414141414";
const AUTOMATION_SP = "15151515-1515-1515-1515-151515151515";
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const signedIn = [
  reply(["version"], {}),
  reply(["account", "show", "--query", "tenantId"], "00000000-0000-0000-0000-000000000000"),
  reply(["account", "show"], {}),
  reply(["ad", "signed-in-user", "show"], "99999999-9999-9999-9999-999999999999"),
];
const role = (value, types, extra = {}) => ({
  allowedMemberTypes: types,
  description: `The ${value} role.`,
  displayName: value,
  id: ROLE_IDS[value],
  isEnabled: true,
  origin: "Application",
  value,
  ...extra,
});
const app = (roles, requestedAccessTokenVersion = null) => ({
  appId: APP_ID,
  id: APP_OBJECT_ID,
  displayName: "PilotSwarm Portal - prod",
  spa: { redirectUris: ["https://portal.example.com"] },
  api: { requestedAccessTokenVersion },
  appRoles: roles,
});
const createRules = (sameName = []) => [
  ...signedIn,
  reply(["ad", "app", "list"], sameName),
  reply(["ad", "app", "create"], NEW_APP),
  reply(["ad", "sp", "create"], { id: "33333333-3333-3333-3333-333333333333" }),
];
const create = (t, params, sameName) => run(t, "Setup-PortalAuth.ps1", {
  ServiceTreeId: "service-tree-id",
  DisplayName: "PilotSwarm Portal - prod",
  RedirectUri: ["https://portal.example.com"],
  ...params,
}, createRules(sameName));

test("Setup-PortalAuth.ps1: without -WorkerRoles the app keeps its current shape", (t) => {
  const r = create(t, { CreateAppRoles: true });
  if (!r) return;
  assert.ok(!r.calls.some((c) => words(c) === "ad app list"), "no lookup by display name");
  const appCreate = r.calls.find((c) => words(c) === "ad app create");
  assert.ok(!appCreate.args.includes("--requested-access-token-version"));
  const roles = payload(appCreate, "--app-roles");
  assert.deepEqual(roles.map((x) => [x.value, x.allowedMemberTypes]), [["admin", ["User"]], ["user", ["User"]]]);
});

test("Setup-PortalAuth.ps1 -CreateAppRoles -WorkerRoles: v2 access tokens and the application roles", (t) => {
  const r = create(t, { CreateAppRoles: true, WorkerRoles: true });
  if (!r) return;
  const appCreate = r.calls.find((c) => words(c) === "ad app create");
  assert.equal(appCreate.args[appCreate.args.indexOf("--requested-access-token-version") + 1], "2");
  const roles = payload(appCreate, "--app-roles");
  assert.deepEqual(roles.map((x) => [x.value, x.allowedMemberTypes]), [
    ["admin", ["User"]],
    ["user", ["User", "Application"]],
    ["worker", ["Application"]],
    ["deployer", ["Application"]],
    ["coordinator", ["Application"]],
  ]);
  assert.ok(roles.every((x) => x.isEnabled === true && GUID.test(x.id) && x.displayName && x.description));
  assert.equal(new Set(roles.map((x) => x.id)).size, roles.length);
});

test("Setup-PortalAuth.ps1 -WorkerRoles rerun of the create command keeps the role IDs of the app az updates", (t) => {
  // az ad app create updates the app that has the same display name.
  const r = create(t, { CreateAppRoles: true, WorkerRoles: true }, [app([role("admin", ["User"]), role("user", ["User"]), role("worker", ["Application"])])]);
  if (!r) return;
  const roles = payload(r.calls.find((c) => words(c) === "ad app create"), "--app-roles");
  assert.deepEqual(roles.map((x) => x.value), ["admin", "user", "worker", "deployer", "coordinator"]);
  assert.deepEqual(roles.slice(0, 3).map((x) => x.id), [ROLE_IDS.admin, ROLE_IDS.user, ROLE_IDS.worker]);
  assert.deepEqual(roles[1].allowedMemberTypes, ["User", "Application"]);
});

test("Setup-PortalAuth.ps1 -ExistingAppId -WorkerRoles adds what is missing and keeps every role", (t) => {
  const existing = app([
    role("admin", ["User"]),
    role("user", ["User"]),
    role("worker", ["Application"]),
    role("deployer", ["Application"]),
    role("auditor", ["User"], { isEnabled: false }),
  ]);
  const r = run(t, "Setup-PortalAuth.ps1", { ExistingAppId: APP_ID, WorkerRoles: true }, [
    ...signedIn,
    reply(["ad", "app", "show", "--id", APP_ID], existing),
  ]);
  if (!r) return;
  const [body, ...rest] = patchBodies(r.calls);
  assert.equal(rest.length, 0, "one PATCH, and no redirect URI change");
  assert.ok(r.calls.find((c) => words(c) === "rest --method PATCH").args.some((a) => a.endsWith(`/applications/${APP_OBJECT_ID}`)));
  assert.deepEqual(body.api, { requestedAccessTokenVersion: 2 });
  assert.deepEqual(body.appRoles.map((x) => x.value), ["admin", "user", "worker", "deployer", "auditor", "coordinator"]);
  for (const x of body.appRoles.slice(0, 5)) assert.equal(x.id, ROLE_IDS[x.value]);
  const [admin, user, , , auditor, coordinator] = body.appRoles;
  assert.deepEqual(admin.allowedMemberTypes, ["User"]);
  assert.deepEqual(user.allowedMemberTypes, ["User", "Application"]);
  assert.equal(auditor.isEnabled, false);
  assert.ok(GUID.test(coordinator.id) && !Object.values(ROLE_IDS).includes(coordinator.id));
  assert.deepEqual(coordinator.allowedMemberTypes, ["Application"]);
  assert.ok(body.appRoles.every((x) => !("origin" in x)), "origin is read-only");
});

test("Setup-PortalAuth.ps1 -ExistingAppId -WorkerRoles changes nothing when the app is already set up", (t) => {
  const existing = app([
    role("user", ["User", "Application"]),
    role("worker", ["Application"]),
    role("deployer", ["Application"]),
    role("coordinator", ["Application"]),
  ], 2);
  const r = run(t, "Setup-PortalAuth.ps1", { ExistingAppId: APP_ID, WorkerRoles: true }, [
    ...signedIn,
    reply(["ad", "app", "show", "--id", APP_ID], existing),
  ]);
  if (!r) return;
  assert.deepEqual(patchBodies(r.calls), []);
  assert.match(r.stdout, /already present - no change/);
});

const assignRules = (roles) => [
  ...signedIn,
  reply(["ad", "app", "show", "--id", APP_ID], app(roles, 2)),
  reply(["ad", "sp", "show", "--id", APP_ID], { id: APP_SP }),
  reply(["ad", "user", "show", "--id", "alice@contoso.com"], { id: ALICE, userPrincipalName: "alice@contoso.com" }),
  reply(["ad", "user", "show"], "", 3),
  reply(["ad", "group", "show"], "", 3),
  reply(["ad", "group", "list"], ""),
  ...[WORKER_MI, PIPELINE_MI, COORDINATOR_MI, AUTOMATION_SP].map((id) => reply(["ad", "sp", "show", "--id", id], { id, displayName: `identity ${id.slice(0, 2)}` })),
  reply(["ad", "sp", "show"], "", 3),
  reply(["rest", "--method", "GET"], { value: [] }),
  reply(["rest", "--method", "POST"], {}),
];
const assigned = (calls) => calls
  .filter((c) => words(c) === "rest --method POST")
  .map((c) => JSON.parse(c.files[c.args[c.args.indexOf("--body") + 1]]))
  .map((b) => [b.principalId, b.appRoleId, b.resourceId]);

test("Set-PortalAuthAssignments.ps1 assigns service principals to the roles that allow applications", (t) => {
  const r = run(t, "Set-PortalAuthAssignments.ps1", {
    AppId: APP_ID,
    UserAssignments: ["alice@contoso.com", AUTOMATION_SP],
    WorkerAssignments: [WORKER_MI, "alice@contoso.com"],
    DeployerAssignments: [PIPELINE_MI],
    CoordinatorAssignments: [COORDINATOR_MI],
  }, assignRules([
    role("admin", ["User"]),
    role("user", ["User", "Application"]),
    role("worker", ["Application"]),
    role("deployer", ["Application"]),
    role("coordinator", ["Application"]),
  ]));
  if (!r) return;
  assert.deepEqual(assigned(r.calls), [
    [ALICE, ROLE_IDS.user, APP_SP],
    [AUTOMATION_SP, ROLE_IDS.user, APP_SP],
    [WORKER_MI, ROLE_IDS.worker, APP_SP],
    [PIPELINE_MI, ROLE_IDS.deployer, APP_SP],
    [COORDINATOR_MI, ROLE_IDS.coordinator, APP_SP],
  ]);
  // An application-only role looks up service principals only.
  const workerLookups = r.calls.filter((c) => c.args.includes(WORKER_MI)).map(words);
  assert.deepEqual(workerLookups, ["ad sp show"]);
  assert.match(r.stdout, /Could not resolve 'alice@contoso.com' to a ServicePrincipal - skipping/);
});

test("Set-PortalAuthAssignments.ps1 looks up only users and groups for a users-only role", (t) => {
  const r = run(t, "Set-PortalAuthAssignments.ps1", {
    AppId: APP_ID,
    AdminAssignments: [AUTOMATION_SP],
    UserAssignments: [AUTOMATION_SP],
  }, assignRules([role("admin", ["User"]), role("user", ["User"])]));
  if (!r) return;
  assert.deepEqual(assigned(r.calls), []);
  assert.ok(!r.calls.some((c) => words(c) === "ad sp show" && c.args.includes(AUTOMATION_SP)));
  assert.match(r.stdout, /Could not resolve '15151515-1515-1515-1515-151515151515' to a User or Group - skipping/);
});
