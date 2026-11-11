// ==============================================================================
// PilotSwarm BaseInfra — private DNS zone linked to the stamp VNet
// (SFI_COMPLIANT=true or the Windows worker pool).
//
// The link sets `resolutionPolicy: 'NxDomainRedirect'` (API 2024-06-01 or
// later). A linked privatelink zone otherwise answers NXDOMAIN for a name it
// doesn't hold, such as another organization's storage account behind that
// organization's own private endpoint. With the policy, Azure DNS resolves
// such a name publicly instead.
// ==============================================================================

@description('Private DNS zone name, e.g. privatelink.blob.core.windows.net.')
param zoneName string

@description('Resource ID of the stamp VNet the zone is linked to.')
param vnetId string

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: zoneName
  location: 'global'
}

resource vnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: 'stamp-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    resolutionPolicy: 'NxDomainRedirect'
    virtualNetwork: {
      id: vnetId
    }
  }
}

output zoneId string = zone.id
