// ==============================================================================
// PilotSwarm BaseInfra — Network Security Perimeter (AZURE_POLICY_RESTRICTED=true only).
//
// A subscription whose Azure Policy requires a network security perimeter
// denies `publicNetworkAccess: 'Enabled'` and `'Disabled'` on Key Vault and
// Storage alike and accepts only `'SecuredByPerimeter'`. The public endpoints
// stay, and this perimeter's access rules decide which callers reach them. An
// admitted caller still needs an RBAC role for any data.
//
// One profile, `stamp`:
//   * the resources in `enforcedResourceIds` (the stamp Key Vault and the main
//     storage account) and `additionalEnforcedResourceIds` (with the Windows
//     worker pool, the deploy-only Key Vault) are associated in Enforced mode,
//     so only the access rules below and private endpoints reach them;
//   * the Log Analytics workspace `logAnalyticsWorkspaceId` is associated in
//     Transition mode. A perimeter resource's diagnostic logs must go to a
//     destination in the same perimeter, and Transition mode keeps the
//     workspace's own network settings, so operators still query it from
//     outside.
//
// With the Windows worker pool, a second profile, `private-only`, holds
// `privateOnlyResourceIds` (the personal Key Vault and the disk controller's
// storage account) in Enforced mode. It has no access rule, so nothing outside
// the perimeter reaches their public endpoints; their private endpoints and
// the perimeter's own resources remain, and RBAC is their data boundary.
//
// Inbound access rules:
//   * `inbound-addresses`: `inboundAddressPrefixes`, the cluster's pinned
//     egress IP as a /32 plus any operator prefixes. One rule, so removing
//     every operator prefix updates it instead of leaving a stale rule behind
//     (an incremental deployment never deletes a rule it no longer declares).
//   * `inbound-subscription`: the stamp subscription. It admits a call made
//     with any managed identity of that subscription.
//
// Requests from inside the region reach Storage from private addresses that an
// IP rule can't match. Those go through the blob private endpoint
// (private-endpoint.bicep); private endpoint traffic needs no access rule.
//
// API version 2024-07-01 is the first GA version of the perimeter API. The
// properties set here are the same in every later version.
// ==============================================================================

@description('Azure region of the perimeter.')
param location string

@description('Perimeter name.')
param perimeterName string

@description('Resource IDs associated with the stamp profile in Enforced mode.')
param enforcedResourceIds array

@description('Log Analytics workspace associated with the stamp profile in Transition mode. Receives the perimeter access logs.')
param logAnalyticsWorkspaceId string

@description('Public IPv4 CIDR prefixes that the stamp profile admits.')
param inboundAddressPrefixes array

@description('More resource IDs associated with the stamp profile in Enforced mode (the Windows worker pool\'s deploy-only Key Vault).')
param additionalEnforcedResourceIds array = []

@description('Resource IDs associated with the private-only profile in Enforced mode (the Windows worker pool\'s personal Key Vault and the disk controller\'s storage account). Empty adds no profile.')
param privateOnlyResourceIds array = []

resource perimeter 'Microsoft.Network/networkSecurityPerimeters@2024-07-01' = {
  name: perimeterName
  location: location
}

resource stampProfile 'Microsoft.Network/networkSecurityPerimeters/profiles@2024-07-01' = {
  parent: perimeter
  name: 'stamp'
}

resource inboundAddresses 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2024-07-01' = {
  parent: stampProfile
  name: 'inbound-addresses'
  properties: {
    direction: 'Inbound'
    addressPrefixes: inboundAddressPrefixes
  }
}

resource inboundSubscription 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2024-07-01' = {
  parent: stampProfile
  name: 'inbound-subscription'
  properties: {
    direction: 'Inbound'
    subscriptions: [
      {
        id: subscription().id
      }
    ]
  }
}

var associations = concat(
  map(concat(enforcedResourceIds, additionalEnforcedResourceIds), id => {
    resourceId: id
    accessMode: 'Enforced'
    profileId: stampProfile.id
  }),
  map(privateOnlyResourceIds, id => {
    resourceId: id
    accessMode: 'Enforced'
    profileId: privateOnlyProfile.id
  }),
  [
    {
      resourceId: logAnalyticsWorkspaceId
      // `Learning` is the API value of Transition mode.
      accessMode: 'Learning'
      profileId: stampProfile.id
    }
  ]
)

// No access rules: only private endpoints and the perimeter's own resources
// reach what it holds.
resource privateOnlyProfile 'Microsoft.Network/networkSecurityPerimeters/profiles@2024-07-01' = if (!empty(privateOnlyResourceIds)) {
  parent: perimeter
  name: 'private-only'
}

// One association at a time, and only once the access rules exist, so an
// Enforced resource is never in the perimeter without them.
@batchSize(1)
resource resourceAssociations 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2024-07-01' = [
  for association in associations: {
    parent: perimeter
    name: last(split(association.resourceId, '/'))
    properties: {
      privateLinkResource: {
        id: association.resourceId
      }
      profile: {
        id: association.profileId
      }
      accessMode: association.accessMode
    }
    dependsOn: [
      inboundAddresses
      inboundSubscription
    ]
  }
]

// The perimeter's own access logs, to the workspace inside the perimeter.
resource perimeterAccessLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'perimeter-access-logs'
  scope: perimeter
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
  }
  dependsOn: [
    resourceAssociations
  ]
}

output perimeterId string = perimeter.id
