// The VM that builds the Windows worker image (README.md, "Building the
// image"), in a resource group of its own: Gen2 Windows Server 2025 with the
// Standard security type, since the gallery's image definition has no security
// type and takes no Trusted Launch VM's image. It has no public IP address and
// no inbound rule, and reaches the internet through a NAT gateway; reach it
// through Run Command or Azure Bastion.
//
// How a VM gets the Standard type depends on the Compute API version. Below
// 2025-11-01, a VM that names no securityProfile gets it, in a subscription
// not registered for Trusted Launch as default (the preview feature
// Microsoft.Compute/TrustedLaunchByDefaultPreview), while an explicit
// `securityType: 'Standard'` needs the subscription feature
// Microsoft.Compute/UseStandardSecurityType there. From 2025-11-01, Trusted
// Launch is the default for the images and sizes that support it, and the VM
// must name `securityType: 'Standard'`. A test keeps the VM in step with its
// API version.
//
//   az deployment group create --resource-group <build-rg> --template-file build-vm.bicep `
//     --parameters vmName=<build-vm> adminUsername=<admin>
//
// The Azure CLI asks for adminPassword, so no file or command line holds it.

@description('The region: the stamp\'s, where the image version is created.')
param location string = resourceGroup().location

@description('The VM\'s name; its first 15 characters are its computer name.')
param vmName string

@description('The VM size.')
param vmSize string = 'Standard_D4ds_v5'

@description('The local administrator\'s name.')
param adminUsername string

@secure()
@description('The local administrator\'s password.')
param adminPassword string

@description('The OS disk size in GiB. The image keeps it, and the scale set\'s VMs have 256 GiB OS disks, which can\'t be smaller than the image\'s.')
@maxValue(256)
param osDiskSizeGB int = 256

resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${vmName}-nat-ip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${vmName}-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [
      {
        id: natIp.id
      }
    ]
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${vmName}-nsg'
  location: location
  properties: {
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'build'
        properties: {
          addressPrefix: '10.0.0.0/24'
          defaultOutboundAccess: false
          natGateway: {
            id: nat.id
          }
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'build-ip'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: vnet.properties.subnets[0].id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-11-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: take(vmName, 15)
      adminUsername: adminUsername
      adminPassword: adminPassword
      windowsConfiguration: {
        provisionVMAgent: true
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2025-datacenter-g2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}
