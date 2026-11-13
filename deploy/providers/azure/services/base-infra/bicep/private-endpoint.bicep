// ==============================================================================
// PilotSwarm BaseInfra — private endpoint at a static address, with its A
// record in a private DNS zone (AZURE_POLICY_RESTRICTED=true or the Windows worker pool).
//
// A static address lets network rules name the endpoint. The zone group keeps
// the A record in step with the endpoint.
// ==============================================================================

@description('Azure region.')
param location string

@description('Private endpoint name.')
param name string

@description('Subnet that holds the endpoint.')
param subnetId string

@description('Resource ID of the resource the endpoint connects to.')
param privateLinkResourceId string

@description('Target sub-resource (group ID), e.g. blob.')
param groupId string

@description('Member name of the static IP configuration. For a Storage sub-resource it equals the group ID.')
param memberName string

@description('Static private IP address of the endpoint, inside the subnet.')
param privateIpAddress string

@description('Resource ID of the private DNS zone that holds the endpoint\'s A record.')
param privateDnsZoneId string

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: name
  location: location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: privateLinkResourceId
          groupIds: [
            groupId
          ]
        }
      }
    ]
    ipConfigurations: [
      {
        name: '${groupId}-ip'
        properties: {
          groupId: groupId
          memberName: memberName
          privateIPAddress: privateIpAddress
        }
      }
    ]
  }
}

resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: groupId
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output privateEndpointId string = privateEndpoint.id
