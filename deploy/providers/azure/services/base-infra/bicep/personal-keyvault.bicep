// ==============================================================================
// PilotSwarm BaseInfra — personal Key Vault (Windows worker pool only).
//
// Holds each owner's personal GitHub token, which the portal writes through
// its Key Vault secret store (deploy/providers/azure/secret-store/) and only the
// disk controller's credential broker reads, for a VM bound to that owner
// (deploy/providers/azure/disk-controller/README.md).
//
//   * RBAC and purge protection. Soft delete keeps a removed token for the
//     minimum, 7 days; the retention is fixed when the vault is created.
//   * No public access: `Disabled`, or with sfiCompliant `SecuredByPerimeter`
//     in the perimeter's private-only profile (nsp.bicep), which has no access
//     rule. Only its private endpoint and the perimeter's own resources reach
//     it, so its RBAC grants are its data boundary:
//       - the controller's identity: Key Vault Secrets User (read);
//       - the portal's identity: the custom role "PilotSwarm Personal Secret
//         Writer" (set, delete and read metadata; no read, recover or purge),
//         which the subscription owner creates once.
//     No other identity, the deploying principal included, gets a role here.
//
// Its AuditEvent log and the alert on any read by another principal are in
// win-worker-alerts.bicep; its private endpoint is in main.bicep.
// ==============================================================================

@description('Azure region.')
param location string

@description('Key Vault name (globally unique, 3-24 chars).')
param keyVaultName string

@description('AAD tenant ID for the vault.')
param tenantId string = subscription().tenantId

@description('SFI_COMPLIANT profile: public access decided by the network security perimeter instead of turned off.')
param sfiCompliant bool = false

@description('Principal ID of the disk controller\'s identity, granted Key Vault Secrets User.')
param controllerPrincipalId string

@description('Principal ID of the portal\'s identity, granted the personal secret writer role.')
param portalPrincipalId string

@description('Name (GUID) of the custom role definition "PilotSwarm Personal Secret Writer".')
param personalVaultWriterRoleId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: sfiCompliant ? 'SecuredByPerimeter' : 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource assignSecretsUserToController 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, controllerPrincipalId, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

resource assignSecretWriterToPortal 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, portalPrincipalId, personalVaultWriterRoleId)
  scope: keyVault
  properties: {
    principalId: portalPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', personalVaultWriterRoleId)
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
// Both grants, which the role assignment alerts exempt exactly
// (win-worker-alerts.bicep).
output roleGrants array = [
  {
    principalId: controllerPrincipalId
    roleId: kvSecretsUserRoleId
    scope: keyVault.id
  }
  {
    principalId: portalPrincipalId
    roleId: personalVaultWriterRoleId
    scope: keyVault.id
  }
]
