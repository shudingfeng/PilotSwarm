// ==============================================================================
// PilotSwarm BaseInfra — the Windows worker pool's compute (Windows worker pool
// only).
//
// On every deploy with the pool:
//   * the stamp's Azure Compute Gallery and its image definition
//     `pilotswarm-win-worker` (Windows, generalized, Gen2), which the image
//     build publishes each version to. Output as WIN_WORKER_GALLERY_IMAGE_ID;
//   * win-worker-pool.bicep on the pool's resource group (poolResourceGroupName,
//     WIN_WORKER_RESOURCE_GROUP, else this group), with the disk controller's
//     grants there and, once WIN_WORKER_IMAGE_VERSION is set, the Flexible
//     scale set and its standby pool;
//   * the disk controller's grants outside that group: Windows 365 Network
//     User on the worker subnet only (a NIC write can't be scoped to a subnet,
//     so its NIC writes stay on the pool's group) and Managed Identity Operator
//     on the workers' identity only; with a pool group of its own, its role on
//     the workers' data collection rule, which it associates each VM with, and
//     on the image definition: the custom role "PilotSwarm Disk Pool
//     Controller", or with WIN_WORKER_CONTROLLER_ACCESS=built-in-roles, Reader
//     and Compute Gallery Image Reader. The subscription owner creates the
//     custom role definition once; this only assigns it;
//   * Cognitive Services OpenAI User on the stamp's Foundry account, when it
//     has one, for the workers' identity and the coordination host's.
//
// Once WIN_WORKER_IMAGE_VERSION is set, the standby pool resource provider's
// grants outside the pool's group: Network Contributor on the worker subnet,
// Compute Gallery Sharing Admin and Compute Gallery Artifacts Publisher on the
// gallery, and Managed Identity Operator on the workers' identity.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix (resource names derive from it).')
param resourceNamePrefix string

@description('The gallery image version the VMs boot (Major.Minor.Patch). Empty: no scale set or standby pool yet.')
param imageVersion string = ''

@description('The VMs\' size; it needs nested virtualization.')
param vmSize string = 'Standard_D16ds_v5'

@description('X: the most VMs, and the standby pool\'s ready capacity.')
@minValue(1)
param maxVms int = 5

@description('Y: the scale set\'s capacity when this module creates it.')
@minValue(0)
param initialCapacity int = 1

@description('Deallocated VMs the standby pool keeps ready.')
@minValue(0)
param standbyMin int = 1

@description('Whether the scale set exists. True: this module leaves it alone, so its capacity stays the controller\'s.')
param scaleSetExists bool = false

@description('The local administrator\'s user name, which a Windows model requires. Nobody signs in with it.')
param adminUsername string = 'pilotswarm'

@description('The local administrator\'s password, needed only when the scale set is created.')
@secure()
param adminPassword string = ''

@description('The VMs\' userData (base64): the stamp\'s values and the controller\'s CA certificate, no secret.')
param userData string = ''

@description('Name of the workers\' user-assigned identity, the only identity of every VM.')
param workerIdentityName string

@description('Principal ID of the disk controller\'s identity.')
param controllerPrincipalId string

@description('Name of the stamp VNet.')
param vnetName string

@description('Name of the worker subnet in it.')
param workerSubnetName string

@description('The pool\'s own resource group (WIN_WORKER_RESOURCE_GROUP), which holds the scale set, the standby pool and every VM, disk, NIC and snapshot of the pool. Empty: this resource group.')
param poolResourceGroupName string = ''

@description('Name (GUID) of the custom role definition "PilotSwarm Disk Pool Controller". Empty with controllerBuiltInRoles.')
param diskPoolControllerRoleId string = ''

@description('WIN_WORKER_CONTROLLER_ACCESS=built-in-roles: the controller gets built-in roles instead of "PilotSwarm Disk Pool Controller". The deploy allows it only with a pool resource group other than this one.')
param controllerBuiltInRoles bool = false

@description('Resource ID of the workers\' data collection rule, in this resource group, which the controller associates each VM with.')
param dataCollectionRuleId string

@description('Object ID of the standby pool resource provider\'s service principal in the tenant. Needed once the standby pool is deployed.')
param standbyPoolPrincipalId string = ''

@description('The stamp\'s Foundry account, when it has one; the workers\' identity gets Cognitive Services OpenAI User on it.')
param foundryAccountName string = ''

@description('Principal ID of the coordination host\'s identity (WIN_WORKER_COORDINATION_HOST=true); it gets Cognitive Services OpenAI User on the Foundry account too. Empty grants nothing.')
param coordinationHostPrincipalId string = ''

var alphaPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))
var galleryName = '${alphaPrefix}gallery'
var imageDefinitionName = 'pilotswarm-win-worker'
var deployScaleSet = !empty(imageVersion)
var poolGroupName = empty(poolResourceGroupName) ? resourceGroup().name : poolResourceGroupName
var separatePoolGroup = toLower(poolGroupName) != toLower(resourceGroup().name)

var managedIdentityOperatorRoleId = 'f1a07417-d97a-45cb-824c-7a7467783830'
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var windows365NetworkUserRoleId = '7eabc9a4-85f7-4f71-b8ab-75daaccc1033'
var networkContributorRoleId = '4d97b98b-1d4f-4787-a291-c67834d212e7'
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var computeGalleryImageReaderRoleId = 'cf7c76d2-98a3-4358-a134-615aa78bf44d'
// The controller's roles on the pool's group: the custom role, or the
// built-in roles that together grant its actions there.
var controllerPoolRoleIds = controllerBuiltInRoles ? [
  '9980e02c-c2be-4d73-94e8-173b1dc7cf3c' // Virtual Machine Contributor
  '1c4770c0-34f7-4110-a1ea-a5855cc7a939' // Elastic SAN Snapshot Exporter
  'b64e21ea-ac4e-4cdf-9dc9-5b892992bee7' // Azure Connected Machine Onboarding
] : [
  diskPoolControllerRoleId
]
var controllerDcrRoleId = controllerBuiltInRoles ? readerRoleId : diskPoolControllerRoleId
var controllerImageRoleId = controllerBuiltInRoles ? computeGalleryImageReaderRoleId : diskPoolControllerRoleId
// What the standby pool resource provider needs on the gallery to build VMs
// from its image; its roles on the pool's group are in win-worker-pool.bicep.
var standbyPoolGalleryRoleIds = [
  '1ef6a3be-d0ac-425d-8c01-acb62866290b' // Compute Gallery Sharing Admin
  '85a2d0d9-2eba-4c9c-b355-11c2cc0788ab' // Compute Gallery Artifacts Publisher
]

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource workerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: workerSubnetName
}

// ─── Gallery ───

resource gallery 'Microsoft.Compute/galleries@2024-03-03' = {
  name: galleryName
  location: location
  properties: {
    description: 'PilotSwarm Windows worker images'
  }
}

resource imageDefinition 'Microsoft.Compute/galleries/images@2024-03-03' = {
  parent: gallery
  name: imageDefinitionName
  location: location
  properties: {
    description: 'PilotSwarm Windows worker'
    osType: 'Windows'
    osState: 'Generalized'
    hyperVGeneration: 'V2'
    identifier: {
      publisher: 'PilotSwarm'
      offer: imageDefinitionName
      sku: 'windows-server'
    }
  }
}

// ─── The disk controller's grants outside the pool's group ───

// The controller's scale-outs join each new NIC to the worker subnet.
resource controllerSubnetJoin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerSubnet.id, controllerPrincipalId, windows365NetworkUserRoleId)
  scope: workerSubnet
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', windows365NetworkUserRoleId)
  }
}

// A Flexible scale set creates VMs on the caller's behalf, with its identity.
resource controllerIdentityOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerIdentity.id, controllerPrincipalId, managedIdentityOperatorRoleId)
  scope: workerIdentity
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', managedIdentityOperatorRoleId)
  }
}

resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = {
  name: last(split(dataCollectionRuleId, '/'))
}

// On the stamp's group, the controller's role there covers the rule and the
// image already.
resource controllerDcrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (separatePoolGroup) {
  name: guid(dataCollectionRule.id, controllerPrincipalId, controllerDcrRoleId)
  scope: dataCollectionRule
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', controllerDcrRoleId)
  }
}

resource controllerImageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (separatePoolGroup) {
  name: guid(imageDefinition.id, controllerPrincipalId, controllerImageRoleId)
  scope: imageDefinition
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', controllerImageRoleId)
  }
}

// ─── The workers' Foundry grant ───

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(foundryAccountName)) {
  name: foundryAccountName
}

resource workerFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(foundryAccountName)) {
  name: guid(resourceId('Microsoft.CognitiveServices/accounts', foundryAccountName), workerIdentity.id, cognitiveServicesOpenAiUserRoleId)
  scope: foundryAccount
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

// The coordination host's model calls (system agents, titles) go to Foundry
// with its own identity, since it loads no Key Vault secret.
resource coordinationHostFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(foundryAccountName) && !empty(coordinationHostPrincipalId)) {
  name: guid(resourceId('Microsoft.CognitiveServices/accounts', foundryAccountName), coordinationHostPrincipalId, cognitiveServicesOpenAiUserRoleId)
  scope: foundryAccount
  properties: {
    principalId: coordinationHostPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
  }
}

// ─── The standby pool's grants outside the pool's group (once an image version is set) ───

// The standby pool resource provider creates the VMs, with their disks and
// NICs, in the pool's group, where win-worker-pool.bicep gives it Virtual
// Machine Contributor and Network Contributor. It also joins each NIC to the
// worker subnet, builds the VMs from the gallery's image and gives them the
// workers' identity, all in this group, which a role on the pool's group
// doesn't reach: hence these grants here.
resource standbyPoolSubnetRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployScaleSet) {
  name: guid(workerSubnet.id, standbyPoolPrincipalId, networkContributorRoleId)
  scope: workerSubnet
  properties: {
    principalId: standbyPoolPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', networkContributorRoleId)
  }
}

resource standbyPoolGalleryRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in standbyPoolGalleryRoleIds: if (deployScaleSet) {
    name: guid(gallery.id, standbyPoolPrincipalId, roleId)
    scope: gallery
    properties: {
      principalId: standbyPoolPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

resource standbyPoolIdentityOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployScaleSet) {
  name: guid(workerIdentity.id, standbyPoolPrincipalId, managedIdentityOperatorRoleId)
  scope: workerIdentity
  properties: {
    principalId: standbyPoolPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', managedIdentityOperatorRoleId)
  }
}

// ─── The pool's resource group ───

module pool './win-worker-pool.bicep' = {
  name: '${resourceNamePrefix}-win-worker-pool'
  scope: resourceGroup(poolGroupName)
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    deployScaleSet: deployScaleSet
    imageVersionId: deployScaleSet ? '${imageDefinition.id}/versions/${imageVersion}' : ''
    vmSize: vmSize
    maxVms: maxVms
    initialCapacity: initialCapacity
    standbyMin: standbyMin
    scaleSetExists: scaleSetExists
    adminUsername: adminUsername
    adminPassword: adminPassword
    userData: userData
    workerIdentityId: workerIdentity.id
    workerSubnetId: workerSubnet.id
    controllerPrincipalId: controllerPrincipalId
    controllerRoleIds: controllerPoolRoleIds
    standbyPoolPrincipalId: standbyPoolPrincipalId
  }
  dependsOn: [
    standbyPoolSubnetRole
    standbyPoolGalleryRoles
    standbyPoolIdentityOperator
  ]
}

output galleryImageId string = imageDefinition.id
output scaleSetName string = pool.outputs.scaleSetName
output scaleSetId string = pool.outputs.scaleSetId
output standbyPoolId string = pool.outputs.standbyPoolId
// The controller's and the standby pool resource provider's grants on the
// pool's group, which the role assignment alerts watch and exempt exactly
// (win-worker-alerts.bicep). Their other grants are on the subnet, the
// gallery, the image, the data collection rule and the workers' identity,
// which those alerts don't watch.
output roleGrants array = pool.outputs.roleGrants
