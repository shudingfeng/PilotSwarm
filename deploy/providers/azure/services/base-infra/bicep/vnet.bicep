// ==============================================================================
// PilotSwarm BaseInfra — VNet.
//
// Three subnets:
//   1. AKS subnet — node pool networking (Azure CNI).
//   2. App Gateway subnet — hosts the WAF_v2 Standard_v2 ingress.
//   3. App Gateway Private Link subnet — dedicated subnet for the Private
//      Link Service backing the AppGW private frontend. MUST have
//      `privateLinkServiceNetworkPolicies: 'Disabled'`.
//
// With sfiCompliant (SFI_COMPLIANT=true) the VNet also gets `pe-subnet` for
// private endpoints, and each of these four subnets gets its own NSG.
//
// With winWorkersEnabled (WIN_WORKERS_ENABLED=true) it gets `pe-subnet` too
// (its NSG only with sfiCompliant), and `win-workers-subnet` for the Windows
// worker VMs: a NAT gateway with a static public IP gives them outbound access
// (a Flexible scale set's VMs have no default outbound access), and its NSG
// keeps them from reaching each other and the rest of the VNet.
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix (VNet and subnet names derive from this).')
param resourceNamePrefix string

@description('VNet address space.')
param addressSpace string = '10.20.0.0/16'

@description('AKS node subnet prefix.')
param aksSubnetPrefix string = '10.20.0.0/20'

@description('Application Gateway subnet prefix.')
param appGatewaySubnetPrefix string = '10.20.16.0/24'

@description('Application Gateway Private Link subnet prefix (must be distinct from the App Gateway subnet).')
param appGatewayPrivateLinkSubnetPrefix string = '10.20.17.0/24'

@description('Whether to provision a GatewaySubnet (required for the Azure VPN Gateway). False by default — VPN is an additive, optional ingress.')
param vpnGatewayEnabled bool = false

@description('GatewaySubnet prefix. Azure requires this subnet to be literally named "GatewaySubnet"; the name is fixed and not configurable. /27 minimum for VpnGw1+ (RouteBased).')
param gatewaySubnetPrefix string = '10.20.18.0/27'

@description('Azure Private DNS Resolver inbound endpoint subnet prefix. Co-provisioned with the VPN gateway: P2S clients are pushed the resolver inbound IP via `customDnsServers` so they can resolve Private DNS Zones (e.g. dev.pilotswarm.azure.com) through the tunnel. /28 minimum per Microsoft.Network/dnsResolvers contract. Subnet is dedicated and delegated to Microsoft.Network/dnsResolvers — no other resource may live in it.')
param dnsResolverInboundSubnetPrefix string = '10.20.19.0/28'

@description('DNS server IPs to advertise via the VNet `dhcpOptions.dnsServers` block. P2S VPN clients connecting through the gateway inherit these (this is the supported mechanism — the classic `virtualNetworkGateways` resource has no DNS push field of its own). Leave empty for non-VPN stamps so the VNet uses Azure-provided DNS. When VPN is enabled, main.bicep passes the Private DNS Resolver inbound endpoint static IP so clients can resolve Private DNS Zone records through the tunnel.')
param dnsServers array = []

@description('SFI_COMPLIANT profile: add the private endpoint subnet and give the AKS, App Gateway, App Gateway Private Link and private endpoint subnets explicit NSGs. False keeps the VNet unchanged.')
param sfiCompliant bool = false

@description('Private endpoint subnet prefix. Created only with sfiCompliant.')
param privateEndpointSubnetPrefix string = '10.20.33.0/26'

@description('Windows worker pool: add the private endpoint subnet and the worker subnet with its NAT gateway and NSG. False keeps the VNet unchanged.')
param winWorkersEnabled bool = false

@description('Windows worker subnet prefix. Created only with winWorkersEnabled.')
param winWorkersSubnetPrefix string = '10.20.32.0/24'

@description('The disk controller\'s worker port address: its internal load balancer in the AKS subnet, the only VNet address besides the blob private endpoint that the worker subnet\'s NSG lets the workers reach.')
param diskControllerWorkerPortIp string = '10.20.15.250'

@description('The main storage account\'s blob private endpoint address in pe-subnet, which the worker subnet\'s NSG lets the workers reach on 443.')
param storageBlobPrivateEndpointIp string = '10.20.33.4'

@description('With vpnGatewayEnabled, the VNet\'s DNS server (the Private DNS Resolver\'s inbound endpoint), which the workers then need on port 53.')
param dnsResolverInboundIp string = '10.20.19.4'

@description('With vpnGatewayEnabled, the VPN client address pool. It lies outside the VNet, so the worker subnet\'s NSG denies it separately.')
param vpnClientAddressPool string = '172.16.200.0/24'

var vnetName = '${resourceNamePrefix}-vnet'
var aksSubnetName = 'aks-subnet'
var appGatewaySubnetName = 'appgw-subnet'
var appGatewayPrivateLinkSubnetName = 'appgw-pls-subnet'
var privateEndpointSubnetName = 'pe-subnet'
// Azure requirement: VPN Gateway only attaches to a subnet named exactly
// "GatewaySubnet". Do not parameterise this name.
var gatewaySubnetName = 'GatewaySubnet'
var dnsResolverInboundSubnetName = 'dns-resolver-inbound-subnet'
var winWorkersSubnetName = 'win-workers-subnet'
var privateEndpointSubnetEnabled = sfiCompliant || winWorkersEnabled

// Explicit subnet NSGs (sfiCompliant only). A policy-managed subscription's
// network automation may otherwise attach its own NSG to a subnet that has
// none, without the inbound rules App Gateway v2 requires; with these NSGs in
// place it adds its rules to them instead. Apart from the App Gateway rules
// below, Azure's default rules apply.
resource aksSubnetNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (sfiCompliant) {
  name: '${resourceNamePrefix}-${aksSubnetName}-nsg'
  location: location
}

resource appGatewaySubnetNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (sfiCompliant) {
  name: '${resourceNamePrefix}-${appGatewaySubnetName}-nsg'
  location: location
  properties: {
    securityRules: [
      {
        // App Gateway v2 infrastructure traffic; the SKU requires this rule.
        name: 'AllowGatewayManagerInbound'
        properties: {
          priority: 200
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'GatewayManager'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '65200-65535'
        }
      }
      {
        name: 'AllowAzureLoadBalancerInbound'
        properties: {
          priority: 210
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        // Let's Encrypt's HTTP-01 challenge reaches the public frontend on 80.
        name: 'AllowAcmeHttpChallengeInbound'
        properties: {
          priority: 220
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
    ]
  }
}

resource appGatewayPrivateLinkSubnetNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (sfiCompliant) {
  name: '${resourceNamePrefix}-${appGatewayPrivateLinkSubnetName}-nsg'
  location: location
}

resource privateEndpointSubnetNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (sfiCompliant) {
  name: '${resourceNamePrefix}-${privateEndpointSubnetName}-nsg'
  location: location
}

// ─── Windows worker subnet (winWorkersEnabled only) ───

// Outbound access for the workers: a Flexible scale set's VMs have no default
// outbound access. In zone 1, with the scale set. Its address is one of the
// stamp's egress addresses that the PostgreSQL firewall admits.
resource winWorkersNatIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-worker-nat-ip'
  location: location
  zones: [
    '1'
  ]
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource winWorkersNat 'Microsoft.Network/natGateways@2024-05-01' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-win-worker-nat'
  location: location
  zones: [
    '1'
  ]
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [
      {
        id: winWorkersNatIp.id
      }
    ]
  }
}

// The workers accept no connection and reach nothing in the VNet but the
// controller's worker port and the main storage account's blob private
// endpoint. Every worker is an administrator of its own VM, and all of them
// share the scale set's local administrator account, so without these rules
// Azure's default AllowVnetInBound would let one worker reach another, and the
// cluster's pods and nodes. The inbound deny comes at priority 100, ahead of
// the defaults and of any rule that network automation may add at a later
// priority. Rules name address ranges, not the VirtualNetwork service tag.
// DHCP, DNS and IMDS (168.63.129.16, 169.254.169.254) are not subject to NSG
// rules; with the VPN gateway the VNet's DNS is the Private DNS Resolver, so
// the workers then get port 53 to it, and the VPN client pool, outside the
// VNet, is denied too.
var winWorkersNsgRules = concat([
  {
    name: 'DenyAllInboundFirst'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Deny'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '*'
    }
  }
  {
    name: 'AllowDiskControllerOutbound'
    properties: {
      priority: 100
      direction: 'Outbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: diskControllerWorkerPortIp
      destinationPortRange: '3003'
    }
  }
  {
    name: 'AllowBlobPrivateEndpointOutbound'
    properties: {
      priority: 105
      direction: 'Outbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: storageBlobPrivateEndpointIp
      destinationPortRange: '443'
    }
  }
], vpnGatewayEnabled ? [
  {
    name: 'AllowVnetDnsOutbound'
    properties: {
      priority: 106
      direction: 'Outbound'
      access: 'Allow'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: dnsResolverInboundIp
      destinationPortRange: '53'
    }
  }
] : [], [
  {
    name: 'DenyVnetOutbound'
    properties: {
      priority: 110
      direction: 'Outbound'
      access: 'Deny'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: addressSpace
      destinationPortRange: '*'
    }
  }
], vpnGatewayEnabled ? [
  {
    name: 'DenyVpnClientsOutbound'
    properties: {
      priority: 111
      direction: 'Outbound'
      access: 'Deny'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: vpnClientAddressPool
      destinationPortRange: '*'
    }
  }
] : [])

resource winWorkersSubnetNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (winWorkersEnabled) {
  name: '${resourceNamePrefix}-${winWorkersSubnetName}-nsg'
  location: location
  properties: {
    securityRules: winWorkersNsgRules
  }
}

var baseSubnets = [
  {
    name: aksSubnetName
    properties: union({
      addressPrefix: aksSubnetPrefix
    }, sfiCompliant ? {
      networkSecurityGroup: {
        id: aksSubnetNsg.id
      }
    } : {})
  }
  {
    name: appGatewaySubnetName
    properties: union({
      addressPrefix: appGatewaySubnetPrefix
    }, sfiCompliant ? {
      networkSecurityGroup: {
        id: appGatewaySubnetNsg.id
      }
    } : {})
  }
  {
    name: appGatewayPrivateLinkSubnetName
    properties: union({
      addressPrefix: appGatewayPrivateLinkSubnetPrefix
      privateLinkServiceNetworkPolicies: 'Disabled'
    }, sfiCompliant ? {
      networkSecurityGroup: {
        id: appGatewayPrivateLinkSubnetNsg.id
      }
    } : {})
  }
]

var gatewaySubnetEntry = [
  {
    name: gatewaySubnetName
    properties: {
      addressPrefix: gatewaySubnetPrefix
    }
  }
]

// Private DNS Resolver inbound endpoint subnet. Co-provisioned with the VPN
// gateway because P2S clients cannot reach the Azure-magic DNS IP
// (168.63.129.16) through the tunnel — that IP is only reachable from inside
// Azure VMs. The Resolver inbound endpoint sits on a regular VNet IP that IS
// reachable from P2S clients, and resolves Private DNS Zone records on their
// behalf.
//
// `delegations` is required: Microsoft.Network/dnsResolvers takes exclusive
// ownership of the subnet. No NSG should be applied (the resolver service
// manages its own ingress on UDP/53 + TCP/53).
var dnsResolverInboundSubnetEntry = [
  {
    name: dnsResolverInboundSubnetName
    properties: {
      addressPrefix: dnsResolverInboundSubnetPrefix
      delegations: [
        {
          name: 'Microsoft.Network.dnsResolvers'
          properties: {
            serviceName: 'Microsoft.Network/dnsResolvers'
          }
        }
      ]
    }
  }
]

// Private endpoint subnet (sfiCompliant or winWorkersEnabled), after the
// optional VPN subnets so their positions above don't move. Endpoint network
// policies stay off, so its NSG (sfiCompliant only) filters no endpoint
// traffic.
var privateEndpointSubnetEntry = [
  {
    name: privateEndpointSubnetName
    properties: union({
      addressPrefix: privateEndpointSubnetPrefix
      privateEndpointNetworkPolicies: 'Disabled'
    }, sfiCompliant ? {
      networkSecurityGroup: {
        id: privateEndpointSubnetNsg.id
      }
    } : {})
  }
]

// Windows worker subnet (winWorkersEnabled), last. The workers' NICs join it;
// IP forwarding stays off on them (win-workers.bicep).
var winWorkersSubnetEntry = [
  {
    name: winWorkersSubnetName
    properties: {
      addressPrefix: winWorkersSubnetPrefix
      networkSecurityGroup: {
        id: winWorkersSubnetNsg.id
      }
      natGateway: {
        id: winWorkersNat.id
      }
    }
  }
]

var allSubnets = concat(
  baseSubnets,
  vpnGatewayEnabled ? concat(gatewaySubnetEntry, dnsResolverInboundSubnetEntry) : [],
  privateEndpointSubnetEnabled ? privateEndpointSubnetEntry : [],
  winWorkersEnabled ? winWorkersSubnetEntry : []
)

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressSpace
      ]
    }
    // dhcpOptions only emitted when DNS servers are supplied. Empty array
    // would set "no DNS" on the VNet, which is different from "use Azure
    // default" — preserving omission keeps non-VPN stamps unchanged.
    dhcpOptions: empty(dnsServers) ? null : {
      dnsServers: dnsServers
    }
    subnets: allSubnets
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output aksSubnetId string = vnet.properties.subnets[0].id
output aksSubnetName string = aksSubnetName
output appGatewaySubnetId string = vnet.properties.subnets[1].id
output appGatewaySubnetName string = appGatewaySubnetName
output appGatewayPrivateLinkSubnetId string = vnet.properties.subnets[2].id
// GatewaySubnet ID only when VPN ingress is enabled — empty string keeps the
// output shape stable for non-VPN stamps.
output gatewaySubnetId string = vpnGatewayEnabled ? vnet.properties.subnets[3].id : ''
// DNS Resolver inbound subnet — only present when VPN is enabled (the
// resolver is exclusively here to give P2S clients a reachable DNS server).
output dnsResolverInboundSubnetId string = vpnGatewayEnabled ? vnet.properties.subnets[4].id : ''
output dnsResolverInboundSubnetName string = dnsResolverInboundSubnetName
// Private endpoint subnet — with sfiCompliant or winWorkersEnabled. By name,
// not position.
output privateEndpointSubnetId string = privateEndpointSubnetEnabled ? '${vnet.id}/subnets/${privateEndpointSubnetName}' : ''
// Windows worker subnet and its NAT gateway's address — winWorkersEnabled only.
output winWorkersSubnetId string = winWorkersEnabled ? '${vnet.id}/subnets/${winWorkersSubnetName}' : ''
output winWorkersSubnetName string = winWorkersSubnetName
output winWorkersNatIpAddress string = winWorkersEnabled ? winWorkersNatIp!.properties.ipAddress : ''
