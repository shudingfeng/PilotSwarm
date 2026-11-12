// ==============================================================================
// PilotSwarm BaseInfra — per-region composition.
//
// Composes every per-region resource (AKS, ACR, Storage, PG Flex, AKV, UAMIs,
// VNet, AppGW with PL config, Flux configs for worker + portal) inside a
// single resource group. Deployed per region under the enterprise path; the fleet-wide AFD
// profile lives in GlobalInfra and is referenced by name/RG only (Phase 4
// wires AFD origin + route to the AppGW private frontend).
// ==============================================================================

targetScope = 'resourceGroup'

// ==============================================================================
// Parameters
// ==============================================================================

@description('Azure region. Must match the resource group region.')
param region string

@description('Naming prefix applied to every resource (e.g. "pilotswarmdev", "pilotswarmprod").')
param resourceNamePrefix string

@description('Name of the fleet-wide Front Door Premium profile provisioned by GlobalInfra. Used by Phase 4 to attach per-region origins; referenced here only as an output for downstream modules.')
param frontDoorProfileName string

@description('Resource group that holds the fleet-wide Front Door profile.')
param frontDoorProfileResourceGroup string

@description('Suffix for the TLS certificate domain (e.g. "pilotswarm.contoso.net"). Consumed by Phase 4; surfaced here as an output so the enterprise path can thread it through.')
param sslCertificateDomainSuffix string

@description('ACR SKU (Basic/Standard/Premium). Dev uses Basic; prod uses Premium.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param acrSku string = 'Basic'

@description('WAF mode on the App Gateway. Dev uses Detection; prod uses Prevention.')
@allowed([
  'Detection'
  'Prevention'
])
param wafMode string = 'Prevention'

@description('Static private IP for the App Gateway private frontend. Must sit within the App Gateway subnet range.')
param appGatewayPrivateIpAddress string = '10.20.16.10'

@description('Availability zones. Empty array disables zone placement (useful for dev in regions without 3 zones).')
param availabilityZones array = []

@description('Unique suffix appended to nested module names so repeated deployments do not collide.')
param dTime string = utcNow()

@description('Log Analytics workspace retention in days. Up to 30 is included free; longer is billed. Workspace receives AKS Container Insights telemetry (pods/nodes/events/ContainerLogV2 stream).')
@minValue(30)
@maxValue(730)
param logAnalyticsRetentionDays int = 30

@description('Edge topology mode. afd = Front Door + AppGw in a dedicated VNet. private = internal NGINX LoadBalancer in a dedicated VNet. public = public NGINX LoadBalancer with an AKS-managed network and no dedicated VNet, AppGw, or Front Door.')
@allowed([
  'afd'
  'private'
  'public'
])
param edgeMode string = 'afd'

@description('Optional deployment principal object ID for Blob Data Contributor, Key Vault Secrets Officer and AcrPush on stamp resources. Defaults to empty for the enterprise path. The OSS deployer supplies a signed-in user ID or an explicit OIDC service principal ID.')
param localDeploymentPrincipalId string = ''

@description('Principal type for localDeploymentPrincipalId.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param localDeploymentPrincipalType string = 'User'

@description('Kubernetes namespace hosting the worker + portal service accounts. MUST match the NAMESPACE env-var that drives the Kustomize overlay (deploy/envs/local/<env>/env). Used to build federated identity credential subjects.')
param serviceAccountNamespace string = 'pilotswarm'

@description('Whether to provision the stamp PostgreSQL flexible server. Set false to bring your own database: skip the module and supply DATABASE_URL (and PILOTSWARM_CMS_FACTS_DATABASE_URL) in the environment instead. When false, postgresFqdn / postgresAadAdminPrincipalName are emitted empty and deploy/scripts/lib/compose-env.mjs leaves the supplied connection strings untouched.')
param deployPostgres bool = true

@description('Provision HorizonDB after base infrastructure. Public mode reserves a stable AKS egress IP so the HorizonDB firewall can allow only this cluster.')
param horizonDbEnabled bool = false

@description('Autoscaler minimum of the user node pool. The session-workspaces tests need two agent nodes (docs/proposals/session-workspaces.md, section 12.1).')
@minValue(1)
@maxValue(10)
param userPoolMinCount int = 1

@description('Add the `repocache` node pool: one node, no autoscaling, tainted so only the session-workspaces repo pod (the repo-cache service) runs there. Follows WORKSPACES_ENABLED. Turning it off later does not delete the pool; delete it with `az aks nodepool delete`.')
param repoCachePoolEnabled bool = false

@description('Whether to provision an Azure AI Foundry (Cognitive Services AIServices) account in this stamp. When true, foundry.bicep emits FOUNDRY_ENDPOINT and configures the selected Entra or key-auth path. When false, no Foundry resource is provisioned and Foundry catalog providers remain non-loadable.')
param foundryEnabled bool = false

@description('SKU for the Foundry account. S0 is the only generally-available paid SKU. Ignored when foundryEnabled=false.')
@allowed([
  'S0'
])
param foundrySku string = 'S0'

@description('Array of Foundry model deployments to provision. Each entry: { name, model: { format, name, version }, sku: { name, capacity } }. Threaded by the deploy orchestrator from a per-stamp JSON file (deploy/envs/local/<env>/foundry-deployments.json) via `--parameters foundryDeployments=@<file>`. Empty array → account is provisioned with no deployments, useful for incremental opt-in. Ignored when foundryEnabled=false.')
param foundryDeployments array = []

@description('Foundry data-plane auth mode. `entra` uses the worker workload identity and disables local auth; `key` retains the legacy account-key path.')
@allowed([
  'key'
  'entra'
])
param foundryAuthMode string = 'key'

@description('Optional Azure region for the Foundry account, decoupled from the stamp region. Empty keeps the account co-located with the stamp.')
param foundryLocation string = ''

// ----- VPN P2S ingress (additive, optional) ---------------------------------
// All defaults preserve byte-equivalent param shape for non-VPN stamps.

@description('Whether to provision the Azure VPN Gateway (P2S, AAD-authenticated) as an additive ingress alongside AFD. False by default.')
param vpnGatewayEnabled bool = false

@description('VPN Gateway SKU. See vpn-gateway.bicep for allowed values; only AZ variants on Generation2 are supported (VpnGw1AZ is Generation1-only and has been observed to silently drop OpenVPN+AAD control-channel handshakes on new deployments). Basic is excluded (no OpenVPN/AAD support).')
param vpnGatewaySku string = 'VpnGw2AZ'

@description('VPN client address pool (must not overlap the VNet or any reachable on-prem range).')
param vpnClientAddressPool string = '172.16.200.0/24'

@description('AAD application audience for VPN client tokens. Default is the public Azure VPN client app ID; override only if you have registered a custom Azure VPN app.')
param vpnAadAudience string = 'c632b3df-fb67-4d84-bdcf-b95ad541b5c8'

@description('Operator-supplied AppGw WAF custom rules (priority >= 100). Threaded by deploy-bicep.mjs from APPGW_WAF_CUSTOM_RULES_FILE; empty by default. The auto-seeded AFD/VPN guard rules at priorities 90-92 are added by application-gateway.bicep when vpnGatewayEnabled=true.')
param appgwWafCustomRules array = []

@description('AFD frontDoorId GUID emitted by global-infra/bicep/main.bicep, threaded as FRONT_DOOR_ID via the deploy-bicep.mjs aliasFor() pipeline. Used by the AllowAfd WAF guard rule when VPN ingress is enabled.')
param frontDoorId string = ''

@description('Microsoft Entra (AAD) tenant ID threaded from the deploy-time AZURE_TENANT_ID env var via the base-infra params template. Currently consumed only by the VPN gateway module; the keyvault/postgres modules keep their own subscription().tenantId defaults. Empty default keeps non-VPN stamps byte-equivalent at the param layer.')
param tenantId string = ''

@description('Portal short hostname (e.g. psmystamp-wus3-portal), threaded from the deploy-time PORTAL_RESOURCE_NAME env var. Used as the A-record label in the VPN-mode private DNS zone so VPN clients resolve the SAME hostname the AppGw listener serves (matching the AKV cert subject portalResourceName.sslCertificateDomainSuffix set in portal/bicep/main.bicep). Empty default keeps non-VPN stamps byte-equivalent.')
param portalResourceName string = ''

// ----- AZURE_POLICY_RESTRICTED profile (additive, optional) ----------------------------
// For subscriptions whose Azure Policy requires a network security perimeter
// and denies Storage shared keys and deployment scripts. deploy/scripts/lib/
// render-params.mjs passes these parameters only with AZURE_POLICY_RESTRICTED=true;
// their defaults leave the stamp unchanged.

@description('AZURE_POLICY_RESTRICTED profile (EDGE_MODE=afd): a network security perimeter for the stamp Key Vault and storage account, explicit subnet NSGs, a blob private endpoint, the pinned cluster egress IP in every edge mode, Entra-only PostgreSQL behind an egress-only firewall, no shared-key Storage access, and no deployment script: deploy/providers/azure/deploy-steps/policy-restricted.mjs probes for the App Gateway instead.')
param policyRestricted bool = false

@description('AZURE_POLICY_RESTRICTED profile: public IPv4 CIDR prefixes that the perimeter admits besides the cluster egress IP and the stamp subscription (PERIMETER_OPERATOR_IP_PREFIXES).')
param perimeterOperatorIpPrefixes array = []

@description('AZURE_POLICY_RESTRICTED profile: whether the App Gateway already exists, from the deploy step\'s probe. Without the profile, check-appgw-exists.bicep answers this.')
param appGwExists bool = false

// ----- Windows worker pool (additive, optional) ------------------------------
// deploy/scripts/lib/render-params.mjs passes these parameters only with
// WIN_WORKERS_ENABLED=true, from the env file and from the Windows worker
// deploy step (deploy/providers/azure/deploy-steps/win-workers.mjs); their
// defaults leave the stamp unchanged.

@description('Windows worker pool (EDGE_MODE afd or private): the gallery, the scale set and its standby pool, the disk controller\'s identity, vaults and state account, the worker subnet with its NAT gateway and NSG, private endpoints, Entra-only PostgreSQL behind an egress-only firewall, container-scoped blob grants and the pool\'s security alerts.')
param winWorkersEnabled bool = false

@description('Windows worker pool: X, the most VMs (WIN_WORKER_COUNT).')
@minValue(1)
param winWorkerCount int = 5

@description('Windows worker pool: Y, the scale set\'s capacity when it is created (WIN_WORKER_MIN_RUNNING).')
@minValue(0)
param winWorkerMinRunning int = 1

@description('Windows worker pool: deallocated VMs the standby pool keeps ready (WIN_WORKER_STANDBY_MIN).')
@minValue(0)
param winWorkerStandbyMin int = 1

@description('Windows worker pool: the VMs\' size (WIN_WORKER_VM_SIZE).')
param winWorkerVmSize string = 'Standard_D16ds_v5'

@description('Windows worker pool: the gallery image version (WIN_WORKER_IMAGE_VERSION). Empty: no scale set or standby pool yet.')
param winWorkerImageVersion string = ''

@description('Windows worker pool: whether the scale set exists, from the deploy step. True leaves it to the deploy step\'s model PATCH, so a deploy never writes its capacity.')
param winWorkerScaleSetExists bool = false

@description('Windows worker pool: the VMs\' shared local administrator password, from the deploy-only vault; passed only when the scale set is created.')
@secure()
param winWorkerAdminPassword string = ''

@description('Windows worker pool: the VMs\' userData (base64), rendered by render-params.mjs.')
param winWorkerUserData string = ''

@description('Windows worker pool: the configuration version in that userData, for the disk controller.')
param winWorkerConfigVersion string = ''

@description('Windows worker pool: email receivers of the pool\'s alerts (WIN_WORKER_ALERT_EMAILS).')
param winWorkerAlertEmails array = []

@description('Windows worker pool: name (GUID) of the custom role definition "PilotSwarm Disk Pool Controller", which the subscription owner creates.')
param diskPoolControllerRoleId string = ''

@description('Windows worker pool: name (GUID) of the custom role definition "PilotSwarm Worker Subnet Join".')
param workerSubnetJoinRoleId string = ''

@description('Windows worker pool: name (GUID) of the custom role definition "PilotSwarm Personal Secret Writer".')
param personalVaultWriterRoleId string = ''

@description('Windows worker pool: object ID of the standby pool resource provider\'s service principal.')
param standbyPoolPrincipalId string = ''

@description('Windows worker pool: the Linux worker becomes the coordination host (WIN_WORKER_COORDINATION_HOST=true). It gets its own identity, federated with the worker\'s service account instead of the portal\'s identity, with container-scoped Blob and Foundry grants, and the alert on capacity requests the disk controller leaves unanswered.')
param winWorkerCoordinationHost bool = false

// ==============================================================================
// Derived names
// ==============================================================================

var location = toLower(region)

// Resource naming conventions.
//
// All resources are named deterministically from `resourceNamePrefix`, which
// the caller is expected to encode with whatever uniqueness their scope needs
// (e.g. `<env><regionShortName><stamp>`, like `pilotswarmdevwus31`). Several
// of the resources below — ACR, Storage Account, Key Vault, and the Postgres
// server's public DNS name — live in **globally unique** Azure namespaces, so
// the caller is responsible for choosing a `resourceNamePrefix` that does not
// collide with any other tenant's resources of the same type. The `npm run
// deploy:new-env` scaffolder enforces this in practice by deriving prefixes
// from a per-developer env name (`ps<envname>`), and higher-level orchestrators
// compose `<env><regionShort><stamp>` which is unique by construction. No
// random hashes are added here so that external tooling (e.g. higher-level
// deployment orchestrators that wrap this module) can compose resource names
// by convention without runtime lookups against the deployment outputs.
//
// Length / charset constraints to keep in mind when picking the prefix:
//   * Storage Account, Key Vault: 3–24 chars, lowercase alphanumeric only
//     (the `alphaPrefix` strip below handles dashes/underscores; the length
//     budget is split between prefix + the `sa`/`kv` suffix below).
//   * ACR: 5–50 chars, lowercase alphanumeric only.
//   * Postgres flexible-server: 3–63 chars, lowercase alphanumeric and dashes.
//
// `alphaPrefix` strips dashes/underscores to satisfy the alphanumeric naming
// constraints of ACR / Storage / Key Vault. When the caller already supplies a
// dashless `resourceNamePrefix`, this is a no-op and `alphaPrefix ==
// resourceNamePrefix`.
var alphaPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))

var aksClusterName = '${resourceNamePrefix}-aks'
var acrName = '${alphaPrefix}acr'
var storageAccountName = '${alphaPrefix}sa'
var postgresServerName = '${resourceNamePrefix}-pg'
var keyVaultName = '${alphaPrefix}kv'
var applicationGatewayName = '${resourceNamePrefix}-appgw'
var logAnalyticsName = '${resourceNamePrefix}-log'
var foundryAccountName = '${resourceNamePrefix}-aif'
var perimeterName = '${resourceNamePrefix}-nsp'
var logAnalyticsNspName = '${resourceNamePrefix}-log-nsp'
// Windows worker pool. Key Vault and storage account names stay within 24
// characters for any prefix the scaffolder makes (ps + up to 15).
var personalKeyVaultName = '${alphaPrefix}kvpers'
var deployKeyVaultName = '${alphaPrefix}kvdep'
var controllerStorageAccountName = '${alphaPrefix}poolsa'
var winWorkerDcrName = '${resourceNamePrefix}-win-worker-dcr'

// The cluster's pinned egress IP. HorizonDB's firewall (public mode) and the
// AZURE_POLICY_RESTRICTED profile's perimeter and PostgreSQL firewall admit only it, and
// so does the Windows worker pool's PostgreSQL firewall.
var clusterEgressIpEnabled = (edgeMode == 'public' && horizonDbEnabled) || policyRestricted || winWorkersEnabled

// PostgreSQL takes Entra sign-in only from the stamp's egress addresses with
// the AZURE_POLICY_RESTRICTED profile or the Windows worker pool.
var postgresEgressOnly = policyRestricted || winWorkersEnabled

// The private endpoint subnet and the main storage account's blob private
// endpoint: the AZURE_POLICY_RESTRICTED profile and the Windows worker pool.
var privateEndpointsEnabled = policyRestricted || winWorkersEnabled

// The main storage account's blob private endpoint, at a fixed address in
// pe-subnet (vnet.bicep) so network rules can name it.
var storageBlobPrivateEndpointIp = '10.20.33.4'

// Windows worker pool: the controller's state account's blob private endpoint
// and the personal vault's, beside it; and the controller's worker port, the
// internal load balancer address that its manifests pin in aks-subnet.
var controllerStorageBlobPrivateEndpointIp = '10.20.33.5'
var personalKeyVaultPrivateEndpointIp = '10.20.33.6'
var diskControllerWorkerPortIp = '10.20.15.250'

// ==============================================================================
// UAMIs (must exist before AKS so kubelet identity can be bound).
// ==============================================================================

module Uami './uami.bicep' = {
  name: '${resourceNamePrefix}-uami-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    winWorkersEnabled: winWorkersEnabled
    coordinationHostEnabled: winWorkerCoordinationHost
  }
}

// ==============================================================================
// VNet
// ==============================================================================

module Vnet './vnet.bicep' = if (edgeMode != 'public') {
  name: '${resourceNamePrefix}-vnet-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    vpnGatewayEnabled: vpnGatewayEnabled
    // When VPN ingress is enabled, advertise the Private DNS Resolver inbound
    // endpoint static IP via the VNet's dhcpOptions. P2S clients connecting
    // through the VPN gateway inherit this DNS server list (the classic
    // Microsoft.Network/virtualNetworkGateways resource has no DNS-push field
    // of its own — see vpn-gateway.bicep). The IP is the static address
    // hardcoded in dns-resolver.bicep `inboundIpAddress` default (10.20.19.4)
    // and is reachable from P2S clients via the tunnel.
    dnsServers: vpnGatewayEnabled ? [
      '10.20.19.4'
    ] : []
    policyRestricted: policyRestricted
    winWorkersEnabled: winWorkersEnabled
    diskControllerWorkerPortIp: diskControllerWorkerPortIp
    storageBlobPrivateEndpointIp: storageBlobPrivateEndpointIp
    vpnClientAddressPool: vpnClientAddressPool
  }
}

// ==============================================================================
// Approver UAMI gets Reader on the parent RG up-front, so the
// `check-appgw-exists` deployment script (next module) can probe a
// non-existent AppGw with a clean 404 instead of a 403.
// ==============================================================================

module ApproverRgReaderRbac './approver-rg-reader-rbac.bicep' = {
  name: '${resourceNamePrefix}-approver-rg-reader-${dTime}'
  params: {
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// ==============================================================================
// Probe whether the AppGw already exists in the RG. Drives the AGIC config
// preservation flag in `application-gateway.bicep`. Skipped in private
// mode — there is no AppGw. Skipped with AZURE_POLICY_RESTRICTED too: the probe is a
// deployment script, which needs Storage shared keys, so the deploy step
// probes instead and passes `appGwExists`.
// ==============================================================================

module ApplicationGatewayExistsCheck './check-appgw-exists.bicep' = if (edgeMode == 'afd' && !policyRestricted) {
  name: '${resourceNamePrefix}-check-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    userAssignedIdentityId: Uami.outputs.approverIdentityResourceId
  }
  dependsOn: [
    ApproverRgReaderRbac
  ]
}

// ==============================================================================
// App Gateway (AGIC addon on AKS requires the AppGW to exist first).
// Skipped in private mode — the portal uses the AKS web-app-routing addon
// (NGINX) on an internal LoadBalancer; no AppGw is provisioned.
// ==============================================================================

module AppGateway './application-gateway.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-appgw-${dTime}'
  params: {
    location: location
    applicationGatewayName: applicationGatewayName
    subnetId: Vnet!.outputs.appGatewaySubnetId
    privateLinkSubnetId: Vnet!.outputs.appGatewayPrivateLinkSubnetId
    privateIpAddress: appGatewayPrivateIpAddress
    wafMode: wafMode
    availabilityZones: availabilityZones
    userAssignedIdentityId: Uami.outputs.appGwIdentityResourceId
    appGwExists: policyRestricted ? appGwExists : ApplicationGatewayExistsCheck!.outputs.exists
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
    appgwWafCustomRules: appgwWafCustomRules
    vpnGatewayEnabled: vpnGatewayEnabled
    vpnClientAddressPool: vpnClientAddressPool
    frontDoorId: frontDoorId
  }
}

// Second call to the approver RBAC module — this time scoped post-AppGw to
// grant Contributor on the AppGw resource (used by per-service deploys that
// push KV-referenced TLS certs onto the AppGw via
// `Common/bicep/appgw-add-ssl-certificate.bicep`). The Reader-on-RG grant
// is idempotent (same role-assignment guid). Skipped in private mode.
module ApproverAppGwRbac './approver-rg-reader-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-approver-appgw-rbac-${dTime}'
  params: {
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    appGatewayManagedIdentityName: Uami.outputs.appGwIdentityName
    vnetName: Vnet!.outputs.vnetName
    appGatewaySubnetName: Vnet!.outputs.appGatewaySubnetName
  }
}

// ==============================================================================
// AKS
// ==============================================================================

// Grant the control-plane UAMI Network Contributor on the AKS subnet and
// Contributor on the AppGW BEFORE creating the cluster — required for
// UserAssigned identity (SystemAssigned would auto-grant these).
module AksControlPlaneRbac './aks-controlplane-rbac.bicep' = if (edgeMode != 'public') {
  name: '${resourceNamePrefix}-aks-cp-rbac-${dTime}'
  params: {
    controlPlaneIdentityPrincipalId: Uami.outputs.aksControlPlaneIdentityPrincipalId
    vnetId: Vnet!.outputs.vnetId
    aksSubnetName: Vnet!.outputs.aksSubnetName
  }
}

// The cluster's pinned egress IP (clusterEgressIpEnabled): HorizonDB in public
// mode, and the AZURE_POLICY_RESTRICTED profile and the Windows worker pool in every edge
// mode. The IP is owned by
// the stamp resource group, not by the AKS node resource group. It keeps its
// first name, so a stamp that already has it keeps its address.
resource horizonEgressIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (clusterEgressIpEnabled) {
  name: '${resourceNamePrefix}-hdb-egress'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource networkContributorRoleDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: '4d97b98b-1d4f-4787-a291-c67834d212e7'
}

resource horizonEgressIpRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (clusterEgressIpEnabled) {
  name: guid(horizonEgressIp!.id, 'hdb-egress-network-contributor')
  scope: horizonEgressIp!
  properties: {
    principalId: Uami.outputs.aksControlPlaneIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: networkContributorRoleDef.id
  }
}

// ==============================================================================
// Log Analytics workspace. Provisioned before AKS so the cluster's
// omsAgent addon can be wired with the workspace resource ID at create
// time. Single workspace per stamp (per-region RG).
// ==============================================================================

module LogAnalytics '../../common/bicep/log-analytics.bicep' = {
  name: '${resourceNamePrefix}-log-${dTime}'
  params: {
    location: location
    workspaceName: logAnalyticsName
    retentionInDays: logAnalyticsRetentionDays
  }
}

// ==============================================================================
// VPN P2S Gateway (optional, additive ingress). Provisioned after VNet +
// LogAnalytics so the GatewaySubnet exists and diagnostic logs have a sink.
// Skipped entirely when vpnGatewayEnabled=false (default).
// ==============================================================================

// Private DNS Resolver — provisioned in lockstep with the VPN gateway so P2S
// clients have a reachable DNS server (the Resolver inbound IP) pushed via
// vpnClientConfiguration.customDnsServers. Without this, P2S clients cannot
// resolve Private DNS Zone records (e.g. portal hostname) through the tunnel
// because 168.63.129.16 is only reachable from inside Azure VMs.
module DnsResolver './dns-resolver.bicep' = if (vpnGatewayEnabled) {
  name: '${resourceNamePrefix}-dns-resolver-${dTime}'
  params: {
    location: location
    resourceName: resourceNamePrefix
    vnetId: Vnet!.outputs.vnetId
    inboundSubnetId: Vnet!.outputs.dnsResolverInboundSubnetId
  }
}

module VpnGateway './vpn-gateway.bicep' = if (vpnGatewayEnabled) {
  name: '${resourceNamePrefix}-vpngw-${dTime}'
  params: {
    location: location
    resourceName: resourceNamePrefix
    gatewaySubnetId: Vnet!.outputs.gatewaySubnetId
    vpnGatewaySku: vpnGatewaySku
    vpnClientAddressPool: vpnClientAddressPool
    // tenantId is threaded from AZURE_TENANT_ID via the base-infra params
    // template (deploy-bicep.mjs render pipeline). This aligns the VPN
    // gateway's Entra ID authentication with the rest of the stamp's tenant
    // assumption. The keyvault/postgres modules continue to default to
    // subscription().tenantId — same value today, but their bicep contract
    // is unchanged.
    tenantId: tenantId
    vpnAadAudience: vpnAadAudience
    logAnalyticsWorkspaceId: LogAnalytics.outputs.workspaceId
  }
}

// ==============================================================================
// Private DNS zone for portal resolution over the VPN tunnel (managed-only).
// Provisioned after AppGw so the AppGw private FE IP is available.
// Skipped when vpnGatewayEnabled=false or edgeMode != 'afd' (no AppGw to point to).
// ==============================================================================

module PortalPrivateDns './private-dns-portal.bicep' = if (vpnGatewayEnabled && edgeMode == 'afd') {
  name: '${resourceNamePrefix}-portal-pdns-${dTime}'
  params: {
    vpnGatewayEnabled: vpnGatewayEnabled
    dnsZoneName: sslCertificateDomainSuffix
    // Must match the AppGw HTTPS listener hostname (= portal AKV cert
    // subject), composed in portal/bicep/main.bicep as
    // `${resourceName}.${sslCertificateDomainSuffix}` where `resourceName`
    // is the portal short name (`<env>-<regionShort>-portal`). Threaded
    // here as PORTAL_RESOURCE_NAME from the deploy env. Fallback to bare
    // resourceNamePrefix is intentionally preserved for older stamps that
    // pre-date this thread (cert/DNS would mismatch, but build won't break).
    recordName: empty(portalResourceName) ? resourceNamePrefix : portalResourceName
    appGatewayPrivateIp: appGatewayPrivateIpAddress
    vnetId: Vnet!.outputs.vnetId
  }
}

module Aks './aks.bicep' = {
  name: '${resourceNamePrefix}-aks-${dTime}'
  params: {
    location: location
    clusterName: aksClusterName
    aksSubnetId: edgeMode == 'public' ? '' : Vnet!.outputs.aksSubnetId
    edgeMode: edgeMode
    applicationGatewayId: edgeMode == 'afd' ? AppGateway!.outputs.applicationGatewayId : ''
    kubeletIdentityResourceId: Uami.outputs.kubeletIdentityResourceId
    kubeletIdentityClientId: Uami.outputs.kubeletIdentityClientId
    kubeletIdentityPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
    aksControlPlaneIdentityResourceId: Uami.outputs.aksControlPlaneIdentityResourceId
    aksControlPlaneIdentityPrincipalId: Uami.outputs.aksControlPlaneIdentityPrincipalId
    outboundPublicIpId: clusterEgressIpEnabled ? horizonEgressIp!.id : ''
    availabilityZones: availabilityZones
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
    userPoolMinCount: userPoolMinCount
    repoCachePoolEnabled: repoCachePoolEnabled
  }
  dependsOn: edgeMode == 'public'
    ? (clusterEgressIpEnabled ? [horizonEgressIpRole] : [])
    : (clusterEgressIpEnabled ? [AksControlPlaneRbac, horizonEgressIpRole] : [AksControlPlaneRbac])
}

// ==============================================================================
// Container Insights Data Collection Rule (ContainerLogV2 schema). The
// in-cluster omsAgent (provisioned by aks.bicep addonProfiles) discovers
// the DCRA and uses it to route pod/node/event telemetry to the workspace.
// Legacy `ContainerLog` table retires 2026-09-30, so opt into V2 from
// day one.
// ==============================================================================

module ContainerInsightsDcr './aks-container-insights-dcr.bicep' = {
  name: '${resourceNamePrefix}-ci-dcr-${dTime}'
  params: {
    clusterName: aksClusterName
    location: location
    logAnalyticsWorkspaceResourceId: LogAnalytics.outputs.workspaceId
  }
  dependsOn: [
    Aks
  ]
}

// ==============================================================================
// Federated identity credentials (run after AKS so OIDC issuer is known).
// ==============================================================================

module UamiFederation './uami-federation.bicep' = {
  name: '${resourceNamePrefix}-uami-fed-${dTime}'
  params: {
    csiIdentityName: Uami.outputs.csiIdentityName
    oidcIssuerUrl: Aks.outputs.oidcIssuerUrl
    serviceAccountNamespace: serviceAccountNamespace
    // Empty without the Windows worker pool: no credential is added.
    diskControllerIdentityName: Uami.outputs.diskControllerIdentityName
    // With the pool, the CSI identity gets no worker-fedcred.
    winWorkersEnabled: winWorkersEnabled
    // Empty without the coordination host.
    coordinationHostIdentityName: Uami.outputs.coordinationIdentityName
  }
}

// ==============================================================================
// ACR + AcrPull role assignment on kubelet UAMI.
// ==============================================================================

module Acr './acr.bicep' = {
  name: '${resourceNamePrefix}-acr-${dTime}'
  params: {
    location: location
    registryName: acrName
    skuName: acrSku
    aksKubeletPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
    deploymentPrincipalId: localDeploymentPrincipalId
    deploymentPrincipalType: localDeploymentPrincipalType
  }
}

// ==============================================================================
// Storage (session + manifest containers) + Blob Data Reader for kubelet.
// ==============================================================================

module Storage './storage.bicep' = {
  name: '${resourceNamePrefix}-sa-${dTime}'
  params: {
    location: location
    storageAccountName: storageAccountName
    aksKubeletPrincipalId: Uami.outputs.kubeletIdentityPrincipalId
    workerWorkloadPrincipalId: Uami.outputs.csiIdentityPrincipalId
    localDeploymentPrincipalId: localDeploymentPrincipalId
    localDeploymentPrincipalType: localDeploymentPrincipalType
    policyRestricted: policyRestricted
    winWorkersEnabled: winWorkersEnabled
    winWorkerPrincipalId: Uami.outputs.winWorkerIdentityPrincipalId
    coordinationHostPrincipalId: Uami.outputs.coordinationIdentityPrincipalId
  }
}

// ==============================================================================
// PostgreSQL Flexible Server (worker runs its own migrations).
// ==============================================================================

module Postgres './postgres.bicep' = if (deployPostgres) {
  name: '${resourceNamePrefix}-pg-${dTime}'
  params: {
    location: location
    serverName: postgresServerName
    aadAdminPrincipalId: Uami.outputs.csiIdentityPrincipalId
    aadAdminPrincipalName: Uami.outputs.csiIdentityName
    aadAdminPrincipalType: 'ServicePrincipal'
    aadOnly: edgeMode == 'public' || postgresEgressOnly
    clusterEgressIpAddress: postgresEgressOnly ? horizonEgressIp!.properties.ipAddress : ''
    winWorkerEgressIpAddress: winWorkersEnabled ? Vnet!.outputs.winWorkersNatIpAddress : ''
  }
}

// ==============================================================================
// Key Vault + KV Secrets User for CSI SPC UAMI.
// ==============================================================================

module KeyVault './keyvault.bicep' = {
  name: '${resourceNamePrefix}-akv-${dTime}'
  params: {
    location: location
    keyVaultName: keyVaultName
    csiPrincipalId: Uami.outputs.csiIdentityPrincipalId
    appGwPrincipalId: Uami.outputs.appGwIdentityPrincipalId
    localDeploymentPrincipalId: localDeploymentPrincipalId
    localDeploymentPrincipalType: localDeploymentPrincipalType
    templateDeploymentEnabled: horizonDbEnabled
    policyRestricted: policyRestricted
  }
}

// ==============================================================================
// AZURE_POLICY_RESTRICTED profile: the network security perimeter around the stamp Key
// Vault and the main storage account, and the perimeter's log workspace.
// Skipped without the profile. The account's blob private endpoint comes with
// the profile or the Windows worker pool.
// ==============================================================================

// A perimeter resource's diagnostic logs must go to a destination in the same
// perimeter, so the perimeter gets its own workspace. The main workspace stays
// outside the perimeter, unchanged.
module LogAnalyticsNsp '../../common/bicep/log-analytics.bicep' = if (policyRestricted) {
  name: '${resourceNamePrefix}-log-nsp-${dTime}'
  params: {
    location: location
    workspaceName: logAnalyticsNspName
    retentionInDays: logAnalyticsRetentionDays
  }
}

module Nsp './nsp.bicep' = if (policyRestricted) {
  name: '${resourceNamePrefix}-nsp-${dTime}'
  params: {
    location: location
    perimeterName: perimeterName
    enforcedResourceIds: [
      KeyVault.outputs.keyVaultId
      Storage.outputs.storageAccountId
    ]
    logAnalyticsWorkspaceId: LogAnalyticsNsp!.outputs.workspaceId
    // union() also drops an operator prefix that repeats the egress /32.
    inboundAddressPrefixes: union([
      '${horizonEgressIp!.properties.ipAddress}/32'
    ], perimeterOperatorIpPrefixes)
    // Windows worker pool: the deploy-only vault joins the stamp profile like
    // the stamp vault; the personal vault and the controller's state account
    // admit nothing from outside the perimeter.
    additionalEnforcedResourceIds: winWorkersEnabled ? [
      DeployKeyVault!.outputs.keyVaultId
    ] : []
    privateOnlyResourceIds: winWorkersEnabled ? [
      PersonalKeyVault!.outputs.keyVaultId
      ControllerStorage!.outputs.storageAccountId
    ] : []
  }
}

// Requests from inside the region reach Storage from private addresses that
// the perimeter's IP rules can't match, so the cluster (Flux and the workers)
// reaches Blob through this private endpoint. The Windows workers reach Blob
// only through it: their subnet's NSG admits no other VNet address.
module BlobPrivateDnsZone './private-dns-zone.bicep' = if (privateEndpointsEnabled) {
  name: '${resourceNamePrefix}-blob-pdns-${dTime}'
  params: {
    zoneName: 'privatelink.blob.${environment().suffixes.storage}'
    vnetId: Vnet!.outputs.vnetId
  }
}

module StorageBlobPrivateEndpoint './private-endpoint.bicep' = if (privateEndpointsEnabled) {
  name: '${resourceNamePrefix}-sa-blob-pe-${dTime}'
  params: {
    location: location
    name: '${storageAccountName}-blob-pe'
    subnetId: Vnet!.outputs.privateEndpointSubnetId
    privateLinkResourceId: Storage.outputs.storageAccountId
    groupId: 'blob'
    memberName: 'blob'
    privateIpAddress: storageBlobPrivateEndpointIp
    privateDnsZoneId: BlobPrivateDnsZone!.outputs.zoneId
  }
}

// ==============================================================================
// Windows worker pool: vaults, the disk controller's state account and their
// private endpoints. Skipped without the pool.
// ==============================================================================

// The disk controller's CA key and the workers' administrator password, for
// the deploying principal only.
module DeployKeyVault './deploy-keyvault.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-akv-deploy-${dTime}'
  params: {
    location: location
    keyVaultName: deployKeyVaultName
    policyRestricted: policyRestricted
    deployPrincipalId: localDeploymentPrincipalId
    deployPrincipalType: localDeploymentPrincipalType
  }
}

// Owners' personal tokens: the portal writes, only the controller reads.
module PersonalKeyVault './personal-keyvault.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-akv-personal-${dTime}'
  params: {
    location: location
    keyVaultName: personalKeyVaultName
    policyRestricted: policyRestricted
    controllerPrincipalId: Uami.outputs.diskControllerIdentityPrincipalId
    portalPrincipalId: Uami.outputs.csiIdentityPrincipalId
    personalVaultWriterRoleId: personalVaultWriterRoleId
  }
}

module VaultPrivateDnsZone './private-dns-zone.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-vault-pdns-${dTime}'
  params: {
    // privatelink.vaultcore.azure.net in the public cloud.
    zoneName: 'privatelink${replace(environment().suffixes.keyvaultDns, '.vault.', '.vaultcore.')}'
    vnetId: Vnet!.outputs.vnetId
  }
}

module PersonalKeyVaultPrivateEndpoint './private-endpoint.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-akv-personal-pe-${dTime}'
  params: {
    location: location
    name: '${personalKeyVaultName}-pe'
    subnetId: Vnet!.outputs.privateEndpointSubnetId
    privateLinkResourceId: PersonalKeyVault!.outputs.keyVaultId
    groupId: 'vault'
    memberName: 'default'
    privateIpAddress: personalKeyVaultPrivateEndpointIp
    privateDnsZoneId: VaultPrivateDnsZone!.outputs.zoneId
  }
  // One private endpoint at a time in pe-subnet.
  dependsOn: [
    ControllerStorageBlobPrivateEndpoint
  ]
}

// The controller's state, apart from the main account's account-wide grants.
module ControllerStorage './controller-storage.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-sa-pool-${dTime}'
  params: {
    location: location
    storageAccountName: controllerStorageAccountName
    policyRestricted: policyRestricted
    controllerPrincipalId: Uami.outputs.diskControllerIdentityPrincipalId
  }
}

module ControllerStorageBlobPrivateEndpoint './private-endpoint.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-sa-pool-blob-pe-${dTime}'
  params: {
    location: location
    name: '${controllerStorageAccountName}-blob-pe'
    subnetId: Vnet!.outputs.privateEndpointSubnetId
    privateLinkResourceId: ControllerStorage!.outputs.storageAccountId
    groupId: 'blob'
    memberName: 'blob'
    privateIpAddress: controllerStorageBlobPrivateEndpointIp
    privateDnsZoneId: BlobPrivateDnsZone!.outputs.zoneId
  }
  // One private endpoint at a time in pe-subnet.
  dependsOn: [
    StorageBlobPrivateEndpoint
  ]
}

// ==============================================================================
// Azure AI Foundry — optional, gated by foundryEnabled.
// ==============================================================================
//
// Provisions a single Cognitive Services AIServices account plus N model
// deployments. The data-plane key flows into KV via auto-secrets.bicep
// below. The endpoint flows out via the `foundryEndpoint` output, which
// the OSS deploy orchestrator aliases to FOUNDRY_ENDPOINT and substitutes
// into the worker base `model_providers.json` at manifest-staging time.

module Foundry './foundry.bicep' = if (foundryEnabled) {
  name: '${resourceNamePrefix}-foundry-${dTime}'
  params: {
    location: empty(foundryLocation) ? location : toLower(foundryLocation)
    accountName: foundryAccountName
    sku: foundrySku
    deployments: foundryDeployments
    keyVaultName: KeyVault.outputs.keyVaultName
    authMode: foundryAuthMode
    workloadIdentityPrincipalId: Uami.outputs.csiIdentityPrincipalId
  }
}

// ==============================================================================
// Auto-populated Key Vault secrets.
// ==============================================================================
//
// Earlier revisions wrote `azure-storage-connection-string` here from
// `listKeys()` so the worker pod could mount it via CSI. With the storage
// managed-identity path (PILOTSWARM_USE_MANAGED_IDENTITY=1, worker UAMI
// granted Storage Blob Data Contributor on the account) the worker no
// longer needs a shared key — `DefaultAzureCredential` exchanges the
// projected SA token for an AAD token. The connection-string secret is
// dropped entirely from the bicep-deploy flow.
//
// What does run here: when foundryEnabled=false, write the
// SEED_SECRETS_UNSET_SENTINEL placeholder for `azure-oai-key` so the
// stamp-invariant worker SPC mount succeeds. When foundryEnabled=true,
// foundry.bicep writes either the real key (key mode) or the same sentinel
// (Entra mode), so this sentinel module is skipped.
//
// Human-provided secrets (github-token, anthropic-api-key) are still
// seeded into Key Vault by the `seed-secrets` step in deploy.mjs, sourced
// from the gitignored deploy/envs/local/<env>/env file populated by
// `npm run deploy:new-env`.
//
// The legacy `scripts/deploy-aks.sh` flow continues to use connection
// strings (no MI flag set) and is unaffected by this change.

module AutoSecretsSentinel './auto-secrets-sentinel.bicep' = if (!foundryEnabled) {
  name: '${resourceNamePrefix}-auto-secrets-sentinel-${dTime}'
  params: {
    keyVaultName: KeyVault.outputs.keyVaultName
  }
}

// AppGW Private Link approver UAMI needs Network Contributor on the AppGW
// so the Portal deployment script can approve the Front Door PE connection.
// Skipped in private mode — no AppGw, no PE.
module AppGwPeApprovalRbac './appgw-pe-approval-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-pe-approver-rbac-${dTime}'
  params: {
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// AGIC addon RBAC. The AGIC addon creates its own UAMI in the AKS node RG;
// that identity (NOT the AKS control-plane UAMI) is what the AGIC pod uses,
// so it needs explicit role grants on the AppGw + AppGw subnet + AppGw UAMI.
// Mirrors reference deployment patterns: `agic-vnet-rbac`.
// Skipped in private mode — AGIC addon is not enabled (web-app-routing is).
module AgicRbac './agic-rbac.bicep' = if (edgeMode == 'afd') {
  name: '${resourceNamePrefix}-agic-rbac-${dTime}'
  params: {
    location: location
    applicationGatewayName: AppGateway!.outputs.applicationGatewayName
    appGatewayManagedIdentityName: Uami.outputs.appGwIdentityName
    virtualNetworkName: Vnet!.outputs.vnetName
    appGatewaySubnetName: Vnet!.outputs.appGatewaySubnetName
    agicAddonIdentityName: Aks.outputs.agicAddonIdentityName
    agicAddonIdentityResourceGroup: Aks.outputs.nodeResourceGroup
  }
}

// Same approver UAMI also runs the AKV cert-creation deployment script
// (Portal/akv-ssl-certificate.bicep) so it needs Key Vault Certificates
// Officer on the BaseInfra AKV. Reusing one deployment-script identity
// keeps role-grant churn low and matches the reference deployment
// `infraDeployManagedIdName` pattern.
module KvCertOfficerRbac './kv-cert-officer-rbac.bicep' = {
  name: '${resourceNamePrefix}-kv-certofficer-rbac-${dTime}'
  params: {
    keyVaultName: KeyVault.outputs.keyVaultName
    approverPrincipalId: Uami.outputs.approverIdentityPrincipalId
  }
}

// ==============================================================================
// Windows worker pool: the workers' data collection rule, the gallery, the
// scale set with its standby pool, the controller's grants, and the pool's
// logs and alerts. Skipped without the pool.
// ==============================================================================

module WinWorkerDcr './win-worker-dcr.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-worker-dcr-${dTime}'
  params: {
    location: location
    name: winWorkerDcrName
    logAnalyticsWorkspaceId: LogAnalytics.outputs.workspaceId
  }
}

module WinWorkers './win-workers.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-workers-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    imageVersion: winWorkerImageVersion
    vmSize: winWorkerVmSize
    maxVms: winWorkerCount
    initialCapacity: winWorkerMinRunning
    standbyMin: winWorkerStandbyMin
    scaleSetExists: winWorkerScaleSetExists
    adminPassword: winWorkerAdminPassword
    userData: winWorkerUserData
    workerIdentityName: Uami.outputs.winWorkerIdentityName
    controllerPrincipalId: Uami.outputs.diskControllerIdentityPrincipalId
    vnetName: Vnet!.outputs.vnetName
    workerSubnetName: Vnet!.outputs.winWorkersSubnetName
    diskPoolControllerRoleId: diskPoolControllerRoleId
    workerSubnetJoinRoleId: workerSubnetJoinRoleId
    standbyPoolPrincipalId: standbyPoolPrincipalId
    foundryAccountName: foundryEnabled ? Foundry!.outputs.accountName : ''
    coordinationHostPrincipalId: Uami.outputs.coordinationIdentityPrincipalId
  }
}

module WinWorkerAlerts './win-worker-alerts.bicep' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-worker-alerts-${dTime}'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    mainWorkspaceId: LogAnalytics.outputs.workspaceId
    // A perimeter resource's diagnostic logs must stay in the perimeter.
    securityWorkspaceId: policyRestricted ? LogAnalyticsNsp!.outputs.workspaceId : LogAnalytics.outputs.workspaceId
    alertEmails: winWorkerAlertEmails
    namespace: serviceAccountNamespace
    aksClusterName: Aks.outputs.aksClusterName
    storageAccountName: Storage.outputs.storageAccountName
    controllerStorageAccountName: ControllerStorage!.outputs.storageAccountName
    stampKeyVaultName: KeyVault.outputs.keyVaultName
    deployKeyVaultName: DeployKeyVault!.outputs.keyVaultName
    personalKeyVaultName: PersonalKeyVault!.outputs.keyVaultName
    controllerPrincipalId: Uami.outputs.diskControllerIdentityPrincipalId
    // The controller's and the portal's grants on the scopes the role
    // assignment rules watch; the rules exempt exactly these.
    ownRoleGrants: concat(PersonalKeyVault!.outputs.roleGrants, ControllerStorage!.outputs.roleGrants, WinWorkers!.outputs.roleGrants)
    deployPrincipalId: localDeploymentPrincipalId
    customRoleIds: [
      diskPoolControllerRoleId
      workerSubnetJoinRoleId
      personalVaultWriterRoleId
    ]
    coordinationHost: winWorkerCoordinationHost
  }
}

// ==============================================================================
// FluxConfigs — owned per-service.
// ==============================================================================
//
// Per-deployable Flux configurations (worker, portal) are now owned by each
// service's own bicep (deploy/providers/azure/services/worker/bicep/main.bicep,
// deploy/providers/azure/services/portal/bicep/main.bicep) — matching the
// reference deployment pattern. BaseInfra installs the
// `microsoft.flux` extension via aks.bicep but does not configure any
// per-service `fluxConfigurations` resources.
//
// The shared module deploy/providers/azure/services/common/bicep/flux-config.bicep is consumed by
// the Worker and Portal bicep main.bicep files.

// ==============================================================================
// Outputs (consumed by Phase 4 / enterprise / OSS deploy scripts).
// ==============================================================================

output applicationGatewayName string = edgeMode == 'afd' ? AppGateway!.outputs.applicationGatewayName : ''
output privateLinkConfigurationName string = edgeMode == 'afd' ? AppGateway!.outputs.privateLinkConfigurationName : ''
output privateLinkConfigurationId string = edgeMode == 'afd' ? AppGateway!.outputs.privateLinkConfigurationId : ''
output acrLoginServer string = Acr.outputs.loginServer
output acrName string = acrName
output keyVaultName string = KeyVault.outputs.keyVaultName
output blobContainerEndpoint string = Storage.outputs.blobContainerEndpoint
output aksClusterName string = Aks.outputs.aksClusterName
output postgresFqdn string = deployPostgres ? Postgres!.outputs.fullyQualifiedDomainName : ''
output postgresAadAdminPrincipalName string = deployPostgres ? Postgres!.outputs.aadAdminPrincipalName : ''
output frontDoorProfileName string = frontDoorProfileName
output frontDoorProfileResourceGroup string = frontDoorProfileResourceGroup
output sslCertificateDomainSuffix string = sslCertificateDomainSuffix
// Shared `csiIdentity` UAMI clientId — worker and portal both federate
// against this identity (uami-federation.bicep). Captured by the OSS
// deploy script (deploy-bicep.mjs OUTPUT_ALIAS) into env key
// WORKLOAD_IDENTITY_CLIENT_ID for downstream overlay `.env` substitution.
output csiIdentityClientId string = Uami.outputs.csiIdentityClientId
// Storage account name (consumed by Worker/Portal bicep + OSS deploy script
// FR-022 alias map). Per-service container names are emitted by each
// service's own bicep, not BaseInfra.
output deploymentStorageAccountName string = Storage.outputs.storageAccountName

// AppGW PE approver UAMI resource ID — consumed by Portal Bicep
// (`approvalManagedIdentityId` param). Captured by the OSS deploy script
// (deploy-bicep.mjs OUTPUT_ALIAS) into env key APPROVAL_MANAGED_IDENTITY_ID.
output approverIdentityResourceId string = Uami.outputs.approverIdentityResourceId

// AKS VNet resource id — consumed by Portal Bicep in private mode for
// the Private DNS Zone vnet link (`aksVnetId` param). Empty in public mode.
output aksVnetId string = edgeMode == 'public' ? '' : Vnet!.outputs.vnetId
output aksOutboundIp string = clusterEgressIpEnabled ? horizonEgressIp!.properties.ipAddress : ''

// Edge topology mode — echoed back so the orchestrator (deploy.mjs / the enterprise path)
// can fan it into per-service params + skip AFD origin wiring in private.
output edgeMode string = edgeMode

// Log Analytics workspace — consumed by the OSS deploy script (output
// alias map) and operators running KQL queries against ContainerLogV2.
output logAnalyticsWorkspaceId string = LogAnalytics.outputs.workspaceId
output logAnalyticsWorkspaceName string = LogAnalytics.outputs.workspaceName

// Foundry account endpoint. Empty when foundryEnabled=false, otherwise the
// account's data-plane URL (e.g. `https://example-foundry.cognitiveservices.azure.com/`).
// Aliased into FOUNDRY_ENDPOINT by deploy/scripts/lib/deploy-bicep.mjs and
// substituted into deploy/providers/azure/gitops/worker/base/model_providers.json at
// manifest-staging time (placeholder `__FOUNDRY_ENDPOINT__`).
output foundryEndpoint string = foundryEnabled ? Foundry!.outputs.endpoint : ''
output foundryAccountName string = foundryEnabled ? Foundry!.outputs.accountName : ''

// ----- VPN P2S ingress outputs (empty strings when disabled) ---------------
output vpnGatewayId string = vpnGatewayEnabled ? VpnGateway!.outputs.vpnGatewayId : ''
output vpnGatewayPublicIp string = vpnGatewayEnabled ? VpnGateway!.outputs.vpnGatewayPublicIp : ''
output vpnClientAddressPool string = vpnGatewayEnabled ? vpnClientAddressPool : ''
output vpnPrivateDnsZoneId string = (vpnGatewayEnabled && edgeMode == 'afd') ? PortalPrivateDns!.outputs.dnsZoneId : ''

// ----- Windows worker pool outputs (empty strings when disabled) -----------
// deploy-bicep.mjs aliases them for the disk controller's overlay and the
// Windows worker deploy step.
output winWorkerGalleryImageId string = winWorkersEnabled ? WinWorkers!.outputs.galleryImageId : ''
output winWorkerScaleSetId string = winWorkersEnabled ? WinWorkers!.outputs.scaleSetId : ''
output winWorkerStandbyPoolId string = winWorkersEnabled ? WinWorkers!.outputs.standbyPoolId : ''
output winWorkerDcrId string = winWorkersEnabled ? WinWorkerDcr!.outputs.dataCollectionRuleId : ''
output winWorkerConfigVersion string = winWorkersEnabled ? winWorkerConfigVersion : ''
output winWorkerIdentityName string = Uami.outputs.winWorkerIdentityName
output winWorkerIdentityClientId string = Uami.outputs.winWorkerIdentityClientId
output winWorkerIdentityPrincipalId string = Uami.outputs.winWorkerIdentityPrincipalId
output diskControllerIdentityClientId string = Uami.outputs.diskControllerIdentityClientId
output diskControllerIdentityPrincipalId string = Uami.outputs.diskControllerIdentityPrincipalId
output diskPoolStateUrl string = winWorkersEnabled ? ControllerStorage!.outputs.stateContainerUrl : ''
output personalKeyVaultUri string = winWorkersEnabled ? PersonalKeyVault!.outputs.keyVaultUri : ''
output deployKeyVaultName string = winWorkersEnabled ? DeployKeyVault!.outputs.keyVaultName : ''
output winWorkerEgressIp string = winWorkersEnabled ? Vnet!.outputs.winWorkersNatIpAddress : ''

// The coordination host's identity (empty without it): the Linux worker's
// workload identity and database user, and the database job's member.
output coordinationIdentityName string = Uami.outputs.coordinationIdentityName
output coordinationIdentityClientId string = Uami.outputs.coordinationIdentityClientId
output coordinationIdentityPrincipalId string = Uami.outputs.coordinationIdentityPrincipalId