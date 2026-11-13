// ==============================================================================
// PilotSwarm BaseInfra — the Windows worker pool's compute (Windows worker pool
// only).
//
// On every deploy with the pool:
//   * the stamp's Azure Compute Gallery and its image definition
//     `pilotswarm-win-worker` (Windows, generalized, Gen2), which the image
//     build publishes each version to. Output as WIN_WORKER_GALLERY_IMAGE_ID;
//   * the disk controller's grants: the custom role "PilotSwarm Disk Pool
//     Controller" on the resource group, the custom role "PilotSwarm Worker
//     Subnet Join" on the worker subnet only (a NIC write can't be scoped to a
//     subnet, so the controller's NIC writes stay at resource-group scope) and
//     Managed Identity Operator on the workers' identity only. The
//     subscription owner creates both custom role definitions once; this only
//     assigns them;
//   * Cognitive Services OpenAI User on the stamp's Foundry account, when it
//     has one, for the workers' identity and the coordination host's.
//
// Once WIN_WORKER_IMAGE_VERSION is set (the model needs an image version):
//   * the Flexible scale set, created with capacity `initialCapacity` (Y) and
//     never touched by Bicep again. A deploy that wrote a capacity back would
//     add or remove VMs behind the disk controller, which owns the capacity.
//     The Windows worker deploy step (deploy/providers/azure/deploy-steps/win-workers.mjs)
//     tells this module whether the scale set exists, and changes the model of
//     an existing one with a PATCH that never names sku.capacity;
//   * its standby pool of deallocated VMs, with the five roles the standby
//     pool resource provider needs on the resource group.
//
// The model: one zone (Premium SSD v2 Dev Drives are zonal), one fault domain,
// Standard security (nested virtualization), a managed 256 GiB OS disk
// (standby pools cannot deallocate ephemeral OS disks), the OS disk and NIC
// deleted with the VM, a NIC in the worker subnet without IP forwarding,
// exactly one user-assigned identity (a second would break the workers'
// database sign-in, which cannot choose between identities), userData with
// the stamp's values (render-params.mjs, renderWinWorkerUserData), the Azure
// Monitor Agent signed in as that identity, manual upgrades and no automatic
// repairs. The local administrator account that a Windows model requires
// shares one generated password, kept only in the deploy-only vault; nobody
// signs in with it (operators use Run Command), and the worker subnet's NSG
// keeps VMs from reaching each other.
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

@description('Name (GUID) of the custom role definition "PilotSwarm Disk Pool Controller".')
param diskPoolControllerRoleId string

@description('Name (GUID) of the custom role definition "PilotSwarm Worker Subnet Join".')
param workerSubnetJoinRoleId string

@description('Object ID of the standby pool resource provider\'s service principal in the tenant. Needed once the standby pool is deployed.')
param standbyPoolPrincipalId string = ''

@description('The stamp\'s Foundry account, when it has one; the workers\' identity gets Cognitive Services OpenAI User on it.')
param foundryAccountName string = ''

@description('Principal ID of the coordination host\'s identity (WIN_WORKER_COORDINATION_HOST=true); it gets Cognitive Services OpenAI User on the Foundry account too. Empty grants nothing.')
param coordinationHostPrincipalId string = ''

var alphaPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))
var galleryName = '${alphaPrefix}gallery'
var imageDefinitionName = 'pilotswarm-win-worker'
var scaleSetName = '${resourceNamePrefix}-win-workers'
var standbyPoolName = '${resourceNamePrefix}-win-worker-standby'
var deployScaleSet = !empty(imageVersion)
var scaleSetId = resourceId('Microsoft.Compute/virtualMachineScaleSets', scaleSetName)

var managedIdentityOperatorRoleId = 'f1a07417-d97a-45cb-824c-7a7467783830'
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
// What the standby pool resource provider needs to create, deallocate and
// delete VMs from the gallery image, with their NICs and the workers' identity.
var standbyPoolRoleIds = [
  '9980e02c-c2be-4d73-94e8-173b1dc7cf3c' // Virtual Machine Contributor
  '4d97b98b-1d4f-4787-a291-c67834d212e7' // Network Contributor
  managedIdentityOperatorRoleId // Managed Identity Operator
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

// ─── The disk controller's grants ───

resource controllerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, controllerPrincipalId, diskPoolControllerRoleId)
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', diskPoolControllerRoleId)
  }
}

resource controllerSubnetJoin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerSubnet.id, controllerPrincipalId, workerSubnetJoinRoleId)
  scope: workerSubnet
  properties: {
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', workerSubnetJoinRoleId)
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

// ─── Scale set and standby pool (once an image version is set) ───

resource standbyPoolRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in standbyPoolRoleIds: if (deployScaleSet) {
    name: guid(resourceGroup().id, standbyPoolPrincipalId, roleId)
    properties: {
      principalId: standbyPoolPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

// The Azure Monitor Agent signs in as the workers' identity, so it adds no
// identity of its own. The disk controller associates each VM with the
// workers' data collection rule (win-worker-dcr.bicep).
var monitorAgentExtension = {
  name: 'AzureMonitorWindowsAgent'
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorWindowsAgent'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
    settings: {
      authentication: {
        managedIdentity: {
          'identifier-name': 'mi_res_id'
          'identifier-value': workerIdentity.id
        }
      }
    }
  }
}

resource scaleSet 'Microsoft.Compute/virtualMachineScaleSets@2024-11-01' = if (deployScaleSet && !scaleSetExists) {
  name: scaleSetName
  location: location
  zones: [
    '1'
  ]
  sku: {
    name: vmSize
    tier: 'Standard'
    capacity: initialCapacity
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    orchestrationMode: 'Flexible'
    platformFaultDomainCount: 1
    upgradePolicy: {
      mode: 'Manual'
    }
    automaticRepairsPolicy: {
      enabled: false
    }
    virtualMachineProfile: {
      securityProfile: {
        securityType: 'Standard'
      }
      userData: userData
      osProfile: {
        computerNamePrefix: 'pswin'
        adminUsername: adminUsername
        adminPassword: adminPassword
        windowsConfiguration: {
          provisionVMAgent: true
          enableAutomaticUpdates: false
          patchSettings: {
            patchMode: 'Manual'
          }
        }
      }
      storageProfile: {
        imageReference: {
          id: '${imageDefinition.id}/versions/${imageVersion}'
        }
        osDisk: {
          createOption: 'FromImage'
          caching: 'ReadWrite'
          diskSizeGB: 256
          deleteOption: 'Delete'
          managedDisk: {
            storageAccountType: 'Premium_LRS'
          }
        }
      }
      networkProfile: {
        networkApiVersion: '2020-11-01'
        networkInterfaceConfigurations: [
          {
            name: 'worker-nic'
            properties: {
              primary: true
              enableIPForwarding: false
              deleteOption: 'Delete'
              ipConfigurations: [
                {
                  name: 'worker-ip'
                  properties: {
                    primary: true
                    subnet: {
                      id: workerSubnet.id
                    }
                  }
                }
              ]
            }
          }
        ]
      }
      diagnosticsProfile: {
        bootDiagnostics: {
          enabled: true
        }
      }
      extensionProfile: {
        extensions: [
          monitorAgentExtension
        ]
      }
    }
  }
}

resource standbyPool 'Microsoft.StandbyPool/standbyVirtualMachinePools@2025-03-01' = if (deployScaleSet) {
  name: standbyPoolName
  location: location
  properties: {
    attachedVirtualMachineScaleSetId: scaleSetId
    virtualMachineState: 'Deallocated'
    elasticityProfile: {
      maxReadyCapacity: maxVms
      minReadyCapacity: standbyMin
    }
  }
  dependsOn: [
    scaleSet
    standbyPoolRoles
  ]
}

output galleryImageId string = imageDefinition.id
output scaleSetName string = scaleSetName
output scaleSetId string = deployScaleSet ? scaleSetId : ''
output standbyPoolId string = deployScaleSet ? standbyPool.id : ''
// The controller's grant on the resource group, which the role assignment
// alerts watch and exempt exactly (win-worker-alerts.bicep). Its other
// grants are on the subnet and the workers' identity, which they don't watch.
output roleGrants array = [
  {
    principalId: controllerPrincipalId
    roleId: diskPoolControllerRoleId
    scope: resourceGroup().id
  }
]
