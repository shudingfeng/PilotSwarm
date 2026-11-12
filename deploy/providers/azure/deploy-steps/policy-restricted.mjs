// AZURE_POLICY_RESTRICTED deploy step for the Azure provider. deploy/scripts/deploy.mjs
// calls it around the bicep step's modules, and only with AZURE_POLICY_RESTRICTED=true.
//
// A subscription whose Azure Policy denies Storage shared keys can't run ARM
// deployment scripts: each one keeps its files in a storage account that it
// reaches with the account's keys. Under the profile the Bicep skips its
// script modules, and this step does their work with the Azure CLI as the
// deploying principal:
//
//   before base-infra  probe whether the App Gateway exists, for the AGIC
//                      configuration that application-gateway.bicep keeps
//                      (instead of check-appgw-exists.bicep);
//   after base-infra   delete an AllowAllAzureServices firewall rule left on
//                      the stamp's PostgreSQL server. The template no longer
//                      declares it, and an incremental deployment never
//                      deletes a resource it no longer declares;
//   after portal       approve Front Door's Private Link connection on the
//                      App Gateway, polling for up to 15 minutes (instead of
//                      approve-private-endpoint.bicep).
//
// Every Azure CLI call goes through `runFn`, so tests can answer it.

import { log, run } from "../../../scripts/lib/common.mjs";
import { deploysPostgres } from "../../../scripts/lib/database-env.mjs";

// The request message that frontdoor-origin-route.bicep gives the Private
// Link connection. Approval replaces the description, so an approved
// connection no longer carries it.
export const FRONT_DOOR_REQUEST_MESSAGE = "Front Door Private Link request for the service";
export const PRIVATE_LINK_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
export const PRIVATE_LINK_POLL_INTERVAL_MS = 15 * 1000;
export const ALLOW_ALL_AZURE_SERVICES_RULE = "AllowAllAzureServices";

const NOT_FOUND = /ResourceNotFound|ResourceGroupNotFound|ParentResourceNotFound|was not found|could not be found/i;

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0].slice(0, 300);
}

function edgeMode(env) {
  return String(env.EDGE_MODE || "afd").trim().toLowerCase();
}

// Resource names, by the conventions in base-infra/bicep/main.bicep: the
// App Gateway probe runs before base-infra has reported any output.
export function stampResourceNames(env) {
  for (const key of ["SUBSCRIPTION_ID", "RESOURCE_GROUP", "RESOURCE_PREFIX"]) {
    if (!env[key]) throw new Error(`The AZURE_POLICY_RESTRICTED deploy step needs ${key}.`);
  }
  return {
    subscriptionId: env.SUBSCRIPTION_ID,
    resourceGroup: env.RESOURCE_GROUP,
    applicationGatewayName: `${env.RESOURCE_PREFIX}-appgw`,
    postgresServerName: `${env.RESOURCE_PREFIX}-pg`,
  };
}

// True when the App Gateway exists, false when Azure says that it, or its
// resource group, is not there. Any other failure stops the deploy: taking
// it for "absent" would reset the configuration that AGIC wrote.
export function appGatewayExists({ resourceGroup, name }, { runFn = run } = {}) {
  const result = runFn("az", [
    "network", "application-gateway", "show",
    "--resource-group", resourceGroup, "--name", name,
    "--query", "id", "--output", "tsv",
  ], { capture: true, allowFail: true });
  if (result.status === 0) return true;
  if (NOT_FOUND.test(String(result.stderr ?? ""))) return false;
  throw new Error(
    `Cannot check whether App Gateway '${name}' exists: ${firstLine(result.stderr) || `exit ${result.status}`}`,
  );
}

function listPrivateLinkConnections({ resourceGroup, applicationGatewayName }, runFn) {
  const result = runFn("az", [
    "network", "private-endpoint-connection", "list",
    "--resource-group", resourceGroup, "--name", applicationGatewayName,
    "--type", "Microsoft.Network/applicationGateways", "--output", "json",
  ], { capture: true, allowFail: true });
  if (result.status !== 0) {
    throw new Error(
      `Cannot list the Private Link connections of App Gateway '${applicationGatewayName}': ` +
        `${firstLine(result.stderr) || `exit ${result.status}`}`,
    );
  }
  let connections;
  try {
    connections = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error(`Listing the Private Link connections of App Gateway '${applicationGatewayName}' returned no JSON.`);
  }
  return Array.isArray(connections) ? connections : [];
}

function connectionState(connection) {
  return connection?.properties?.privateLinkServiceConnectionState ?? {};
}

function isPendingFrontDoor(connection) {
  const state = connectionState(connection);
  return state.status === "Pending" && String(state.description ?? "").includes(FRONT_DOOR_REQUEST_MESSAGE);
}

// The App Gateway's Private Link configuration serves only Front Door, so an
// approved connection is Front Door's. Returns the number of connections this
// call approved.
export async function approveFrontDoorPrivateLink({ resourceGroup, applicationGatewayName }, {
  runFn = run,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = PRIVATE_LINK_APPROVAL_TIMEOUT_MS,
  intervalMs = PRIVATE_LINK_POLL_INTERVAL_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  const approved = new Set();
  log("info", `[policy-restricted] waiting for Front Door's Private Link connection on App Gateway ${applicationGatewayName}`);
  for (;;) {
    const connections = listPrivateLinkConnections({ resourceGroup, applicationGatewayName }, runFn);
    const pending = connections.filter(isPendingFrontDoor);
    if (pending.length === 0 && connections.some((c) => connectionState(c).status === "Approved")) {
      log("ok", `[policy-restricted] Front Door's Private Link connection on App Gateway ${applicationGatewayName} is approved.`);
      return approved.size;
    }
    // A connection is approved once; while its state catches up, the loop waits.
    const fresh = pending.filter((c) => !approved.has(c.id));
    for (const connection of fresh) {
      runFn("az", [
        "network", "private-endpoint-connection", "approve",
        "--id", connection.id, "--description", "Approved by the deploy step", "--output", "none",
      ], { capture: true });
      approved.add(connection.id);
      log("info", `[policy-restricted] approved Private Link connection ${connection.name}`);
    }
    if (fresh.length > 0) continue;
    if (now() >= deadline) {
      const states = connections.map((c) => `${c.name}: ${connectionState(c).status}`).join(", ") || "none";
      throw new Error(
        `Front Door's Private Link connection on App Gateway '${applicationGatewayName}' was not approved ` +
          `within ${Math.round(timeoutMs / 60000)} minutes (connections: ${states}).`,
      );
    }
    await sleepFn(intervalMs);
  }
}

// Deletes the rule when the server has it; returns whether it did.
export function deleteAllowAllAzureServicesRule({ subscriptionId, resourceGroup, serverName }, { runFn = run } = {}) {
  const ruleId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}/firewallRules/${ALLOW_ALL_AZURE_SERVICES_RULE}`;
  const show = runFn("az", [
    "postgres", "flexible-server", "firewall-rule", "show", "--ids", ruleId, "--output", "none",
  ], { capture: true, allowFail: true });
  if (show.status !== 0) {
    if (NOT_FOUND.test(String(show.stderr ?? ""))) return false;
    throw new Error(
      `Cannot read the ${ALLOW_ALL_AZURE_SERVICES_RULE} firewall rule of PostgreSQL server '${serverName}': ` +
        `${firstLine(show.stderr) || `exit ${show.status}`}`,
    );
  }
  runFn("az", [
    "postgres", "flexible-server", "firewall-rule", "delete", "--ids", ruleId, "--yes", "--output", "none",
  ], { capture: true });
  log("ok", `[policy-restricted] deleted the ${ALLOW_ALL_AZURE_SERVICES_RULE} firewall rule of PostgreSQL server ${serverName}.`);
  return true;
}

// Before the bicep step's modules: base-infra renders the probe result as its
// `appGwExists` parameter (deploy/scripts/lib/render-params.mjs).
export function beforeBicep({ env, modules }, { runFn = run } = {}) {
  if (!modules.includes("base-infra") || edgeMode(env) !== "afd") return;
  const { resourceGroup, applicationGatewayName } = stampResourceNames(env);
  const exists = appGatewayExists({ resourceGroup, name: applicationGatewayName }, { runFn });
  env.APP_GATEWAY_EXISTS = String(exists);
  log("info", `[policy-restricted] App Gateway ${applicationGatewayName} ${exists ? "exists" : "does not exist yet"}.`);
}

// After the bicep step's modules. Each check is cheap, so it also runs when
// a deploy marker skipped the module.
export async function afterBicep({ env, modules }, options = {}) {
  if (modules.includes("base-infra") && deploysPostgres(env)) {
    const { subscriptionId, resourceGroup, postgresServerName } = stampResourceNames(env);
    deleteAllowAllAzureServicesRule({ subscriptionId, resourceGroup, serverName: postgresServerName }, options);
  }
  if (modules.includes("portal") && edgeMode(env) === "afd") {
    const { resourceGroup, applicationGatewayName } = stampResourceNames(env);
    await approveFrontDoorPrivateLink({ resourceGroup, applicationGatewayName }, options);
  }
}
