// ==============================================================================
// PilotSwarm BaseInfra — the Windows worker pool's own resource group (Windows
// worker pool only).
//
// win-workers.bicep deploys this module to the pool's resource group:
// WIN_WORKER_RESOURCE_GROUP, a group of the pool's own that the subscription
// owner creates with an "Allowed resource types" policy listing only the
// pool's types (docs/developer/deploy/windows-workers.md), or the stamp's group
// when that is unset. Every VM of the pool, with its OS disk and NIC, and every
// Dev Drive and snapshot the disk controller makes, is in this group. The
// gallery, the worker subnet, the workers' identity and data collection rule,
// the vaults and the controller's state account stay in the stamp's group.
//
// On every deploy with the pool:
//   * the disk controller's grants on the group: the custom role "PilotSwarm
//     Disk Pool Controller", or with WIN_WORKER_CONTROLLER_ACCESS=built-in-roles,
//     Virtual Machine Contributor, Elastic SAN Snapshot Exporter and Azure
//     Connected Machine Onboarding (win-workers.bicep chooses them).
//
// Once WIN_WORKER_IMAGE_VERSION is set (the model needs an image version):
//   * the Flexible scale set, created with capacity `initialCapacity` (Y) and
//     never touched by Bicep again. A deploy that wrote a capacity back would
//     add or remove VMs behind the disk controller, which owns the capacity.
//     The Windows worker deploy step (deploy/providers/azure/deploy-steps/win-workers.mjs)
//     tells this module whether the scale set exists, and changes the model of
//     an existing one with a PATCH that never names sku.capacity;
//   * its standby pool of deallocated VMs, with Virtual Machine Contributor and
//     Network Contributor on the group for the standby pool resource provider.
//     Its other grants, on the subnet, the gallery and the workers' identity,
//     are in win-workers.bicep.
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

@description('Whether to deploy the scale set and its standby pool: once an image version is set.')
param deployScaleSet bool = false

@description('The gallery image version the VMs boot, by resource ID. Empty without deployScaleSet.')
param imageVersionId string = ''

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

@description('Resource ID of the workers\' user-assigned identity, the only identity of every VM.')
param workerIdentityId string

@description('Resource ID of the worker subnet.')
param workerSubnetId string

@description('Principal ID of the disk controller\'s identity.')
param controllerPrincipalId string

@description('Names (GUIDs) of the role definitions the disk controller gets on this resource group.')
param controllerRoleIds array

@description('Object ID of the standby pool resource provider\'s service principal in the tenant. Needed with deployScaleSet.')
param standbyPoolPrincipalId string = ''

var scaleSetName = '${resourceNamePrefix}-win-workers'
var standbyPoolName = '${resourceNamePrefix}-win-worker-standby'
var scaleSetId = resourceId('Microsoft.Compute/virtualMachineScaleSets', scaleSetName)
// What the standby pool resource provider needs in this group to create,
// deallocate and delete VMs with their NICs.
var standbyPoolRoleIds = [
  '9980e02c-c2be-4d73-94e8-173b1dc7cf3c' // Virtual Machine Contributor
  '4d97b98b-1d4f-4787-a291-c67834d212e7' // Network Contributor
]

// ─── The grants on the group ───

resource controllerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in controllerRoleIds: {
    name: guid(resourceGroup().id, controllerPrincipalId, roleId)
    properties: {
      principalId: controllerPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

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

// ─── Scale set and standby pool (once an image version is set) ───

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
          'identifier-value': workerIdentityId
        }
      }
    }
  }
}

// How a VM gets the Standard security type depends on the Compute API version.
// Below 2025-11-01, a model that names no securityProfile gets it, in a
// subscription not registered for Trusted Launch as default (the preview
// feature Microsoft.Compute/TrustedLaunchByDefaultPreview), while an explicit
// `securityType: 'Standard'` needs the subscription feature
// Microsoft.Compute/UseStandardSecurityType there. From 2025-11-01, Trusted
// Launch is the default for the images and sizes that support it, and the
// model must name `securityType: 'Standard'`, the documented opt-out. Every
// write to the scale set's model or capacity uses this version: the Windows
// worker deploy step's PATCH (SCALE_SET_API_VERSION in win-workers.mjs) and the
// disk controller's capacity PATCH (lib/azure.mjs). Tests keep the model and
// those versions in step with this one.
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
      '${workerIdentityId}': {}
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
          id: imageVersionId
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
                      id: workerSubnetId
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

output scaleSetName string = scaleSetName
output scaleSetId string = deployScaleSet ? scaleSetId : ''
output standbyPoolId string = deployScaleSet ? standbyPool.id : ''
// Every grant on this group, which the role assignment alerts watch and
// exempt exactly (win-worker-alerts.bicep).
output roleGrants array = concat(map(controllerRoleIds, roleId => {
  principalId: controllerPrincipalId
  roleId: roleId
  scope: resourceGroup().id
}), deployScaleSet ? map(standbyPoolRoleIds, roleId => {
  principalId: standbyPoolPrincipalId
  roleId: roleId
  scope: resourceGroup().id
}) : [])
