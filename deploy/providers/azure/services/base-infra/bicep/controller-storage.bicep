// ==============================================================================
// PilotSwarm BaseInfra — the disk controller's state account (Windows worker
// pool only).
//
// The controller keeps its state in the `disk-pool-state` container: the drive
// leases, each work's per-work credential and the golden snapshot's record
// (deploy/providers/azure/disk-controller/README.md, "State"). It gets a storage
// account of its own, so the main account's account-wide grants (the kubelet's
// reader role, the deploying principal's contributor role) never reach it:
//
//   * no shared key access; Entra ID only;
//   * Storage Blob Data Contributor on the container for the controller's
//     identity, and no data role for anyone else;
//   * no public access: `Disabled`, or with policyRestricted `SecuredByPerimeter`
//     in the perimeter's private-only profile (nsp.bicep). The controller
//     reaches it through its blob private endpoint (main.bicep), since its
//     requests come from inside the region;
//   * deleted blobs stay recoverable for 7 days.
//
// Its StorageBlobLogs and the alert on any other principal's access are in
// win-worker-alerts.bicep.
// ==============================================================================

@description('Azure region.')
param location string

@description('Storage account name (globally unique, 3-24 lowercase alphanumeric).')
param storageAccountName string

@description('AZURE_POLICY_RESTRICTED profile: public access decided by the network security perimeter instead of turned off.')
param policyRestricted bool = false

@description('Principal ID of the disk controller\'s identity, granted Storage Blob Data Contributor on the state container.')
param controllerPrincipalId string

var stateContainerName = 'disk-pool-state'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: policyRestricted ? 'SecuredByPerimeter' : 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource stateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: stateContainerName
  properties: {
    publicAccess: 'None'
  }
}

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource assignStateContributorToController 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(stateContainer.id, controllerPrincipalId, blobDataContributorRoleId)
  scope: stateContainer
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output stateContainerName string = stateContainer.name
// PS_DISK_POOL_STATE_URL, the controller's state container.
output stateContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}${stateContainerName}'
// The grant above, which the role assignment alerts exempt exactly
// (win-worker-alerts.bicep).
output roleGrants array = [
  {
    principalId: controllerPrincipalId
    roleId: blobDataContributorRoleId
    scope: stateContainer.id
  }
]
