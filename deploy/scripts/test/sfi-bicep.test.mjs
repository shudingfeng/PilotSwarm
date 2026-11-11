// The SFI_COMPLIANT profile's Bicep: what it adds is conditional on the
// setting, so a stamp without it deploys as before, and the addresses,
// rules and modes match the profile's design. Read as text, like
// frontdoor-waf-policy-name.test.mjs; the deploy step's own tests are in
// deploy-steps.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, "../../providers/azure/services", path), "utf8");
const main = read("base-infra/bicep/main.bicep");
const vnet = read("base-infra/bicep/vnet.bicep");
const nsp = read("base-infra/bicep/nsp.bicep");
const portal = read("portal/bicep/main.bicep");

// `resource|module <symbol> '<target>' = if (<condition>) {` → condition.
function conditionOf(source, symbol) {
  const match = new RegExp(`^(?:resource|module) ${symbol} '[^']+' = (?:if \\((.*)\\) )?[{[]`, "m").exec(source);
  assert.ok(match, `${symbol} is declared`);
  return match[1];
}

// The text of a top-level declaration, up to the next one.
function blockOf(source, symbol) {
  const start = source.search(new RegExp(`^(?:resource|module|var|output) ${symbol}\\b`, "m"));
  assert.ok(start >= 0, `${symbol} is declared`);
  const next = source.slice(start + 1).search(/^(?:resource|module|var|output|param|@)/m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function cidr(value) {
  const [address, bits] = value.split("/");
  const number = address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  return { first: number - (number % size), last: number - (number % size) + size - 1 };
}
const ip = (value) => cidr(`${value}/32`).first;
const overlaps = (a, b) => a.first <= b.last && b.first <= a.last;
const paramDefault = (source, name) => {
  const match = new RegExp(`^param ${name} string = '([^']+)'`, "m").exec(source);
  assert.ok(match, `param ${name} has a default`);
  return match[1];
};

test("everything the profile adds is conditional on sfiCompliant", () => {
  for (const symbol of ["LogAnalyticsNsp", "Nsp"]) {
    assert.equal(conditionOf(main, symbol), "sfiCompliant", symbol);
  }
  // The blob private endpoint comes with the profile or the Windows worker pool.
  for (const symbol of ["BlobPrivateDnsZone", "StorageBlobPrivateEndpoint"]) {
    assert.equal(conditionOf(main, symbol), "privateEndpointsEnabled", symbol);
  }
  assert.match(main, /^var privateEndpointsEnabled = sfiCompliant \|\| winWorkersEnabled\s*$/m);
  for (const symbol of ["aksSubnetNsg", "appGatewaySubnetNsg", "appGatewayPrivateLinkSubnetNsg", "privateEndpointSubnetNsg"]) {
    assert.equal(conditionOf(vnet, symbol), "sfiCompliant", symbol);
  }
  // The deployment-script modules are the ones the profile turns off.
  assert.equal(conditionOf(main, "ApplicationGatewayExistsCheck"), "edgeMode == 'afd' && !sfiCompliant");
  assert.match(main, /appGwExists: sfiCompliant \? appGwExists : ApplicationGatewayExistsCheck!\.outputs\.exists/);
  assert.equal(conditionOf(portal, "plApprove"), "approvesPrivateEndpointHere");
  assert.match(portal, /^var approvesPrivateEndpointHere = edgeMode == 'afd' && !sfiCompliant\s*$/m);
  // Reading a skipped module fails the deployment (DeploymentNotFound), so the
  // output reads it under the module's own condition.
  assert.match(portal, /^output ApprovedPrivateEndpointCount int = approvesPrivateEndpointHere \? plApprove\.outputs\.approvedCount : 0\s*$/m);
});

test("Key Vault and Storage are SecuredByPerimeter, and Storage refuses shared keys, only with the setting", () => {
  for (const [file, expected] of [
    ["base-infra/bicep/keyvault.bicep", ["publicNetworkAccess: 'SecuredByPerimeter'"]],
    ["base-infra/bicep/storage.bicep", [
      "allowSharedKeyAccess: false",
      "defaultToOAuthAuthentication: true",
      "publicNetworkAccess: 'SecuredByPerimeter'",
    ]],
  ]) {
    const source = read(file);
    const branch = /\}, sfiCompliant \? \{([^}]*)\} : \{\}\)/.exec(source);
    assert.ok(branch, `${file} adds its properties in a sfiCompliant branch`);
    const added = branch[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(added, expected, file);
    assert.equal(source.split("SecuredByPerimeter").length - 1, 1, `${file} names SecuredByPerimeter once`);
  }
});

test("the perimeter: Key Vault and Storage Enforced, its workspace in Transition, egress IP and subscription admitted", () => {
  assert.match(blockOf(main, "Nsp"), /enforcedResourceIds: \[\s*KeyVault\.outputs\.keyVaultId\s*Storage\.outputs\.storageAccountId\s*\]/);
  assert.match(blockOf(main, "Nsp"), /inboundAddressPrefixes: union\(\[\s*'\$\{horizonEgressIp!\.properties\.ipAddress\}\/32'\s*\], perimeterOperatorIpPrefixes\)/);
  assert.match(main, /^var perimeterName = '\$\{resourceNamePrefix\}-nsp'\s*$/m);
  assert.match(main, /^var logAnalyticsNspName = '\$\{resourceNamePrefix\}-log-nsp'\s*$/m);
  assert.match(nsp, /resourceId: id\s*accessMode: 'Enforced'/);
  // `Learning` is the API value of Transition mode.
  assert.match(nsp, /resourceId: logAnalyticsWorkspaceId\s*\/\/[^\n]*\n\s*accessMode: 'Learning'/);
  assert.match(nsp, /name: 'stamp'/);
  assert.match(nsp, /direction: 'Inbound'\s*addressPrefixes: inboundAddressPrefixes/);
  assert.match(nsp, /subscriptions: \[\s*\{\s*id: subscription\(\)\.id\s*\}\s*\]/);
  assert.match(blockOf(nsp, "perimeterAccessLogs"), /scope: perimeter\s*properties: \{\s*workspaceId: logAnalyticsWorkspaceId/);
});

test("the blob private endpoint sits at 10.20.33.4 in pe-subnet, which overlaps nothing else in the stamp", () => {
  assert.match(main, /^var storageBlobPrivateEndpointIp = '10\.20\.33\.4'\s*$/m);
  assert.match(blockOf(main, "StorageBlobPrivateEndpoint"), /privateIpAddress: storageBlobPrivateEndpointIp/);
  const peSubnet = cidr(paramDefault(vnet, "privateEndpointSubnetPrefix"));
  assert.deepEqual(peSubnet, cidr("10.20.33.0/26"));
  // Azure keeps a subnet's first four addresses and its last one.
  const endpoint = ip("10.20.33.4");
  assert.ok(endpoint >= peSubnet.first + 4 && endpoint < peSubnet.last, "a usable pe-subnet address");

  const space = cidr(paramDefault(vnet, "addressSpace"));
  const others = ["aksSubnetPrefix", "appGatewaySubnetPrefix", "appGatewayPrivateLinkSubnetPrefix",
    "gatewaySubnetPrefix", "dnsResolverInboundSubnetPrefix"].map((name) => [name, cidr(paramDefault(vnet, name))]);
  assert.ok(peSubnet.first >= space.first && peSubnet.last <= space.last, "pe-subnet is inside the VNet");
  for (const [name, range] of others) assert.ok(!overlaps(peSubnet, range), `pe-subnet overlaps ${name}`);
  assert.ok(!overlaps(peSubnet, cidr(paramDefault(main, "vpnClientAddressPool"))), "pe-subnet overlaps the VPN client pool");
});

test("the blob zone is linked with NxDomainRedirect (API 2024-06-01 or later)", () => {
  const zone = read("base-infra/bicep/private-dns-zone.bicep");
  const link = /resource vnetLink 'Microsoft\.Network\/privateDnsZones\/virtualNetworkLinks@(\d{4}-\d{2}-\d{2})' = \{/.exec(zone);
  assert.ok(link && link[1] >= "2024-06-01", "virtualNetworkLinks API 2024-06-01 or later");
  assert.match(zone, /resolutionPolicy: 'NxDomainRedirect'/);
  assert.match(blockOf(main, "BlobPrivateDnsZone"), /zoneName: 'privatelink\.blob\.\$\{environment\(\)\.suffixes\.storage\}'/);
});

test("the App Gateway subnet's NSG allows GatewayManager, the load balancer and ACME HTTP-01 at 200, 210 and 220", () => {
  const rules = blockOf(vnet, "appGatewaySubnetNsg").split(/name: '/).slice(2).map((rule) => {
    const field = (key) => new RegExp(`${key}: '?([^'\\r\\n]+)'?`).exec(rule)?.[1];
    return [rule.slice(0, rule.indexOf("'")), field("priority"), field("direction"), field("access"),
      field("protocol"), field("sourceAddressPrefix"), field("destinationPortRange")].join(" ");
  });
  assert.deepEqual(rules, [
    "AllowGatewayManagerInbound 200 Inbound Allow Tcp GatewayManager 65200-65535",
    "AllowAzureLoadBalancerInbound 210 Inbound Allow * AzureLoadBalancer *",
    "AllowAcmeHttpChallengeInbound 220 Inbound Allow Tcp Internet 80",
  ]);
  // The other subnets keep Azure's default rules.
  for (const symbol of ["aksSubnetNsg", "appGatewayPrivateLinkSubnetNsg", "privateEndpointSubnetNsg"]) {
    assert.doesNotMatch(blockOf(vnet, symbol), /securityRules/, symbol);
  }
});

test("the cluster's pinned egress IP keeps its name and is used in every edge mode with the setting", () => {
  assert.match(main, /^var clusterEgressIpEnabled = \(edgeMode == 'public' && horizonDbEnabled\) \|\| sfiCompliant \|\| winWorkersEnabled\s*$/m);
  assert.equal(conditionOf(main, "horizonEgressIp"), "clusterEgressIpEnabled");
  assert.equal(conditionOf(main, "horizonEgressIpRole"), "clusterEgressIpEnabled");
  assert.match(blockOf(main, "horizonEgressIp"), /name: '\$\{resourceNamePrefix\}-hdb-egress'/);
  const aksModule = blockOf(main, "Aks");
  assert.match(aksModule, /outboundPublicIpId: clusterEgressIpEnabled \? horizonEgressIp!\.id : ''/);
  assert.match(aksModule, /\(clusterEgressIpEnabled \? \[AksControlPlaneRbac, horizonEgressIpRole\] : \[AksControlPlaneRbac\]\)/);
  // aks.bicep applies the IP outside the public-mode branch.
  const aks = read("base-infra/bicep/aks.bicep");
  assert.match(aks, /\} : \{\}, empty\(outboundPublicIpId\) \? \{\} : \{/);
});

test("PostgreSQL: Entra-only with an egress-only firewall under the setting, AllowAllAzureServices otherwise", () => {
  const postgres = read("base-infra/bicep/postgres.bicep");
  assert.equal(conditionOf(postgres, "allowAzureServices"), "empty(clusterEgressIpAddress)");
  assert.equal(conditionOf(postgres, "allowClusterEgress"), "!empty(clusterEgressIpAddress)");
  assert.match(blockOf(postgres, "aadPrimaryAdmin"), /dependsOn: \[\s*database\s*allowAzureServices\s*allowClusterEgress\s*\]/);
  const module = blockOf(main, "Postgres");
  assert.match(module, /aadOnly: edgeMode == 'public' \|\| postgresEgressOnly/);
  assert.match(module, /clusterEgressIpAddress: postgresEgressOnly \? horizonEgressIp!\.properties\.ipAddress : ''/);
  assert.match(main, /^var postgresEgressOnly = sfiCompliant \|\| winWorkersEnabled\s*$/m);
});
