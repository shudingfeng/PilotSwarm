// ==============================================================================
// PilotSwarm BaseInfra — deploy-only Key Vault (Windows worker pool only).
//
// Holds what only the deploy needs: the disk controller's private CA key and
// certificate (disk-controller-ca-key, disk-controller-ca-cert, written by
// deploy/providers/azure/disk-controller/tls.mjs), during a CA rotation the
// next CA's key and certificate and the previous CA's certificate
// (disk-controller-ca-key-next, disk-controller-ca-cert-next,
// disk-controller-ca-cert-previous; a used one is disabled, never deleted),
// and the Windows workers' local administrator password
// (win-worker-admin-password, written once by
// deploy/providers/azure/deploy-steps/win-workers.mjs). The stamp vault isn't
// used for these: the portal's identity reads every secret there.
//
//   * RBAC and purge protection, with the stamp vault's 90-day soft delete.
//   * Key Vault Secrets Officer for the deploying principal only; no workload
//     identity holds any role here.
//   * Public access like the stamp vault: open to RBAC, or with policyRestricted
//     `SecuredByPerimeter` in the perimeter's stamp profile (nsp.bicep).
//
// Its AuditEvent log and the alert on reads of the CA keys are in
// win-worker-alerts.bicep.
// ==============================================================================

@description('Azure region.')
param location string

@description('Key Vault name (globally unique, 3-24 chars).')
param keyVaultName string

@description('AAD tenant ID for the vault.')
param tenantId string = subscription().tenantId

@description('AZURE_POLICY_RESTRICTED profile: public access decided by the network security perimeter.')
param policyRestricted bool = false

@description('The deploying principal, granted Key Vault Secrets Officer. Empty grants nobody; the deploy step then cannot keep its secrets here.')
param deployPrincipalId string = ''

@description('Principal type for deployPrincipalId.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param deployPrincipalType string = 'User'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: union({
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }, policyRestricted ? {
    publicNetworkAccess: 'SecuredByPerimeter'
  } : {})
}

var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource assignSecretsOfficerToDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  name: guid(keyVault.id, deployPrincipalId, kvSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    principalId: deployPrincipalId
    principalType: deployPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
