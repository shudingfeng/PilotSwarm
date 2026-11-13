// ==============================================================================
// PilotSwarm BaseInfra — User-assigned managed identities.
//
// Four UAMIs are created here:
//   1. kubelet UAMI — bound to the AKS kubelet so pods can pull images from
//      ACR without an imagePullSecret (FR-004 / GitOps-friendly).
//   2. CSI SPC UAMI — used by the AKV Secrets Store CSI Provider to read
//      secrets out of Key Vault on behalf of the worker + portal pods
//      (FR-005). Federated identity credentials for the worker and portal
//      service accounts are materialised by `uami-federation.bicep` after
//      the AKS cluster's OIDC issuer URL is known.
//   4. AppGW PE approver UAMI — runs the Portal deployment script that
//      auto-approves the Front Door → AppGW Private Link connection
//      (`approve-private-endpoint.bicep`). RBAC (Network Contributor on the
//      AppGW) is wired in `appgw-pe-approval-rbac.bicep`. Created in
//      BaseInfra so the AppGW exists before the role assignment runs.
//   5. AppGW UAMI — attached to the Application Gateway resource itself.
//      Mirrors reference deployment's `appGatewayManagedIdName`. Exists
//      primarily so the AGIC addon identity can hold "Managed Identity
//      Operator" on it (required by AGIC docs to mutate AppGw config that
//      references a UAMI). Wired in `agic-rbac.bicep`.
//
// With winWorkersEnabled (WIN_WORKERS_ENABLED=true) two more:
//   6. Windows worker UAMI — the only identity of every Windows worker VM
//      (win-workers.bicep). A second identity on the VMs would break the
//      database sign-in, which cannot choose between identities.
//   7. Disk controller UAMI — the controller's workload identity, federated
//      with its service account in `uami-federation.bicep`.
//
// With coordinationHostEnabled too (WIN_WORKER_COORDINATION_HOST=true), one
// more:
//   8. Coordination host UAMI — the Linux worker's workload identity. Its
//      service account is federated with this identity instead of the CSI
//      identity (`uami-federation.bicep`), so the Linux worker no longer
//      signs in as the portal's identity.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix applied to every UAMI.')
param resourceNamePrefix string

@description('Windows worker pool: add the workers\' and the disk controller\'s identities. False keeps the identities as they are.')
param winWorkersEnabled bool = false

@description('Windows worker pool with the coordination host: add the Linux worker\'s own identity. False adds none.')
param coordinationHostEnabled bool = false

var coordinationHost = winWorkersEnabled && coordinationHostEnabled
var kubeletIdentityName = '${resourceNamePrefix}-kubelet-mid'
var csiIdentityName = '${resourceNamePrefix}-csi-mid'
var approverIdentityName = '${resourceNamePrefix}-pe-approver-mid'
var aksControlPlaneIdentityName = '${resourceNamePrefix}-aks-cp-mid'
// Application Gateway UAMI. Mirrors reference deployment's `appGatewayManagedIdName`
// pattern. Required so the AGIC addon can call `assignUserAssignedIdentity` on the
// AppGw (granted via the Managed Identity Operator role on this UAMI in
// `agic-rbac.bicep`). System-assigned / addon-only identities don't satisfy
// AGIC's role requirements per Microsoft AGIC docs.
var appGwIdentityName = '${resourceNamePrefix}-appgw-mid'

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: kubeletIdentityName
  location: location
}

// AKS control-plane identity. Required to be UserAssigned (not SystemAssigned)
// because the cluster uses a custom kubelet identity (Azure constraint:
// CustomKubeletIdentityOnlySupportedOnUserAssignedMSICluster).
resource aksControlPlaneIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: aksControlPlaneIdentityName
  location: location
}

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: csiIdentityName
  location: location
}

resource approverIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: approverIdentityName
  location: location
}

resource appGwIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: appGwIdentityName
  location: location
}

resource winWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-worker-mid'
  location: location
}

resource diskControllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-disk-pool-mid'
  location: location
}

resource coordinationHostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (coordinationHost) {
  name: '${resourceNamePrefix}-linux-worker-mid'
  location: location
}

output kubeletIdentityName string = kubeletIdentity.name
output kubeletIdentityResourceId string = kubeletIdentity.id
output kubeletIdentityPrincipalId string = kubeletIdentity.properties.principalId
output kubeletIdentityClientId string = kubeletIdentity.properties.clientId

output csiIdentityName string = csiIdentity.name
output csiIdentityResourceId string = csiIdentity.id
output csiIdentityPrincipalId string = csiIdentity.properties.principalId
output csiIdentityClientId string = csiIdentity.properties.clientId

output approverIdentityName string = approverIdentity.name
output approverIdentityResourceId string = approverIdentity.id
output approverIdentityPrincipalId string = approverIdentity.properties.principalId
output approverIdentityClientId string = approverIdentity.properties.clientId

output aksControlPlaneIdentityName string = aksControlPlaneIdentity.name
output aksControlPlaneIdentityResourceId string = aksControlPlaneIdentity.id
output aksControlPlaneIdentityPrincipalId string = aksControlPlaneIdentity.properties.principalId
output aksControlPlaneIdentityClientId string = aksControlPlaneIdentity.properties.clientId

output appGwIdentityName string = appGwIdentity.name
output appGwIdentityResourceId string = appGwIdentity.id
output appGwIdentityPrincipalId string = appGwIdentity.properties.principalId
output appGwIdentityClientId string = appGwIdentity.properties.clientId

// Empty without the Windows worker pool.
output winWorkerIdentityName string = winWorkersEnabled ? winWorkerIdentity.name : ''
output winWorkerIdentityResourceId string = winWorkersEnabled ? winWorkerIdentity.id : ''
output winWorkerIdentityPrincipalId string = winWorkersEnabled ? winWorkerIdentity!.properties.principalId : ''
output winWorkerIdentityClientId string = winWorkersEnabled ? winWorkerIdentity!.properties.clientId : ''

output diskControllerIdentityName string = winWorkersEnabled ? diskControllerIdentity.name : ''
output diskControllerIdentityPrincipalId string = winWorkersEnabled ? diskControllerIdentity!.properties.principalId : ''
output diskControllerIdentityClientId string = winWorkersEnabled ? diskControllerIdentity!.properties.clientId : ''

// Empty without the coordination host.
output coordinationIdentityName string = coordinationHost ? coordinationHostIdentity.name : ''
output coordinationIdentityPrincipalId string = coordinationHost ? coordinationHostIdentity!.properties.principalId : ''
output coordinationIdentityClientId string = coordinationHost ? coordinationHostIdentity!.properties.clientId : ''
