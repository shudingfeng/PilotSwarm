// ==============================================================================
// PilotSwarm BaseInfra — Federated identity credentials for workload identity.
//
// Attaches two federated credentials to the CSI SPC UAMI so the
// copilot-runtime-worker and pilotswarm-portal Kubernetes service
// accounts can exchange their projected SA tokens for Azure AD tokens.
// With the Windows worker pool, the disk controller's own identity gets one
// for the controller's service account too, and the CSI identity gets no
// `worker-fedcred`: the Linux worker then either runs as the coordination
// host, federated with the host's own identity, or runs no pod at all. So no
// pod of the worker's service account can sign in as the portal's identity,
// the database's administrator, also while the host is being turned off.
// An incremental deployment leaves a `worker-fedcred` an earlier deploy
// created; the Windows worker deploy step deletes it before the coordination
// host's manifests (deploy/providers/azure/deploy-steps/win-workers.mjs).
//
// Invoked after `aks.bicep` because the OIDC issuer URL is read from the
// cluster output.
// ==============================================================================

@description('Name of the CSI SPC user-assigned managed identity (parent of the federated credentials).')
param csiIdentityName string

@description('AKS cluster OIDC issuer URL (from aks.bicep output).')
param oidcIssuerUrl string

@description('Kubernetes namespace hosting both service accounts. MUST match the NAMESPACE env-var that drives the Kustomize overlay so the federated credential subjects align with the actual SAs that Flux applies.')
param serviceAccountNamespace string = 'pilotswarm'

@description('Worker service account name.')
param workerServiceAccountName string = 'copilot-runtime-worker'

@description('Portal service account name.')
param portalServiceAccountName string = 'pilotswarm-portal'

@description('Windows worker pool: name of the disk controller\'s user-assigned identity, federated with the controller\'s service account. Empty adds no credential.')
param diskControllerIdentityName string = ''

@description('The disk controller\'s service account, in the same namespace as the portal\'s.')
param diskControllerServiceAccountName string = 'pilotswarm-disk-controller'

@description('Windows worker pool: the CSI identity gets no credential for the worker\'s service account. False keeps worker-fedcred.')
param winWorkersEnabled bool = false

@description('The coordination host: name of its user-assigned identity, which the worker\'s service account is federated with. Empty adds no credential.')
param coordinationHostIdentityName string = ''

resource csiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: csiIdentityName
}

resource workerFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (!winWorkersEnabled) {
  parent: csiIdentity
  name: 'worker-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${workerServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource portalFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: csiIdentity
  name: 'portal-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${portalServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
  dependsOn: [
    workerFederation
  ]
}

// The disk controller's own identity (Windows worker pool only). It is a
// different identity from the one above, so its credential needs no ordering
// against theirs.
resource diskControllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(diskControllerIdentityName)) {
  name: diskControllerIdentityName
}

resource diskControllerFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (!empty(diskControllerIdentityName)) {
  parent: diskControllerIdentity
  name: 'disk-controller-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${diskControllerServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// The coordination host's own identity (WIN_WORKER_COORDINATION_HOST=true),
// for the worker's service account. Another identity again, so no ordering.
resource coordinationHostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(coordinationHostIdentityName)) {
  name: coordinationHostIdentityName
}

resource coordinationHostFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (!empty(coordinationHostIdentityName)) {
  parent: coordinationHostIdentity
  name: 'coordination-host-fedcred'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${workerServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}