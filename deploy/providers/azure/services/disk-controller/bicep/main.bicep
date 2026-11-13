// ==============================================================================
// PilotSwarm disk-controller — manifest container + Flux configuration.
// ==============================================================================
// Scope: resource group (BaseInfra RG — same RG that owns the storage account
// and AKS cluster).
//
// The disk controller and credential broker for the Windows worker pool
// (deploy/providers/azure/disk-controller/README.md). Like the portal, its
// Kubernetes objects are reconciled by Flux from a manifest blob container that
// this module owns (deploy/providers/azure/gitops/disk-controller/).
//
// Deployed by the deploy tool's `disk-controller` service (its deploy.json),
// which deploy.mjs runs only with WIN_WORKERS_ENABLED=true. Base-infra creates
// the controller's identity, its state storage and the scale set; the
// Windows worker deploy step (deploy-steps/win-workers.mjs) runs the TLS step
// (tls.mjs) before the controller's manifests are published.
//
// What this module does:
//   1. Creates the `disk-controller-manifests` blob container in the BaseInfra
//      storage account.
//   2. Configures Flux on the BaseInfra AKS cluster to reconcile from that
//      container, with the overlay that matches the portal's edge and TLS
//      source (`overlays/<edgeMode>-<tls variant>`, as for the portal).
//
// Pre-requisites (delivered by BaseInfra):
//   - Storage account exists.
//   - AKS cluster exists with the `microsoft.flux` extension installed and
//     `useKubeletIdentity: 'true'`.
//   - The AKS kubelet UAMI has `Storage Blob Data Reader` on the storage
//     account (account-scope grant in storage.bicep).
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name (Flux source for the disk-controller-manifests container).')
param storageAccountName string

@description('BaseInfra AKS cluster name (parent of the Flux extension).')
param aksClusterName string

@description('Edge topology mode. The Windows worker pool needs afd or private: both run classic Azure CNI, which keeps the workers\' source addresses.')
@allowed([
  'afd'
  'private'
])
param edgeMode string = 'afd'

@description('The portal\'s TLS source. The dispatcher Ingress joins the portal\'s listener, so it takes the same overlay variant; akv-selfsigned shares the akv overlay. private + letsencrypt is not a supported combination.')
@allowed([
  'letsencrypt'
  'akv'
  'akv-selfsigned'
])
param tlsSource string = 'letsencrypt'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource diskControllerManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'disk-controller-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module DiskControllerFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'disk-controller-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'disk-controller'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: diskControllerManifestsContainer.name
    kustomizationPath: 'overlays/${edgeMode}-${tlsSource == 'akv-selfsigned' ? 'akv' : tlsSource}'
  }
}

@description('disk-controller manifest container name (consumed by the OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = diskControllerManifestsContainer.name
