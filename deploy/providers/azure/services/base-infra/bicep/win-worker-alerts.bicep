// ==============================================================================
// PilotSwarm BaseInfra — the Windows worker pool's security logs and alerts
// (Windows worker pool only).
//
// Logs:
//   * the AKS cluster's `kube-audit` log to the main workspace (AKSAudit). Not
//     `kube-audit-admin`, which leaves out `get` requests: kubectl opens an
//     exec as a WebSocket, an HTTP GET;
//   * StorageBlobLogs of the main storage account and the disk controller's
//     state account, and the AuditEvent log of the stamp vault, the
//     deploy-only vault and the personal vault, to the security workspace: the
//     perimeter's own workspace with AZURE_POLICY_RESTRICTED=true (a perimeter
//     resource's logs must stay in the perimeter), the main one otherwise.
//
// Alerts: each a scheduled query on one workspace, every 5 minutes, on the rows
// ingested since the last run (a late row still counts once), all to one
// action group that emails WIN_WORKER_ALERT_EMAILS. Queries run even before
// their tables have data. The Activity Log rules read the subscription's
// Activity Log, which the subscription owner sends to the main workspace.
//
//   security workspace
//     personal-vault-read          a secret read in the personal vault by
//                                  anyone but the disk controller
//     deploy-vault-ca-key-read     any read of a key of the controller's CA,
//                                  the current one or a rotation's next one
//     controller-state-access      any access to disk-pool-state by anyone but
//                                  the disk controller
//     release-or-manifest-write    a write or delete in win-worker-releases or
//                                  a Flux manifest container by anyone but the
//                                  deploying principal
//   main workspace, Activity Log
//     sensitive-role-assignment    a role assignment on the personal vault or
//                                  the state account, other than the grants
//                                  this deployment makes there itself
//     data-role-assignment         a role that reads or writes Key Vault
//                                  secrets or blobs (or a pool custom role)
//                                  assigned on the subscription, the resource
//                                  group or those two resources, other than
//                                  the grants this deployment makes itself
//     run-command                  Run Command by anyone but the controller
//     federated-credential-write   a federated credential written on a stamp
//                                  identity by anyone but the deploying
//                                  principal
//   main workspace, kube-audit (the controller's, the portal's and the Linux
//   worker's service accounts, in the stamp namespace)
//     pod-exec                     exec or attach into any pod in the stamp
//                                  namespace, as the session opens
//     pod-created-directly         a pod created with one of those service
//                                  accounts by anyone but a ReplicaSet or Job
//     service-account-token        a token requested for one of them by
//                                  anyone but a node
//   main workspace, container logs
//     forced-session-delete        the portal's forced delete of a delegated
//                                  session
//     drive-quarantined, vm-crash-loop, vm-mass-silence,
//     snapshot-refresh-failed, pool-full, drive-full
//                                  the controller's `alert` records
//     attach-without-turn          a drive attached to a VM without an
//                                  admission of its root session on that VM:
//                                  in the 30 minutes before a turn's attach,
//                                  or from 23 hours before to 15 minutes after
//                                  a workspace check's
//     capacity-request-unanswered  with the coordination host only: none of
//                                  its capacity requests answered by the
//                                  controller for 5 minutes
//
// The role assignment rules exempt only the grants this deployment makes
// itself, each by its principal, role and scope together (ownRoleGrants).
// They see a role by its ID, not its actions, which the Activity Log doesn't
// carry: a custom role other than the pool's own that reads secrets or blobs
// is not recognized when it is assigned. Reads of the personal vault's
// secrets and any access to the controller's state still alert, whatever the
// role (personal-vault-read, controller-state-access).
// ==============================================================================

@description('Azure region.')
param location string

@description('Naming prefix (resource names derive from it).')
param resourceNamePrefix string

@description('The main Log Analytics workspace: AKS, container logs and the Activity Log.')
param mainWorkspaceId string

@description('The workspace for the vaults\' and storage accounts\' logs: the perimeter\'s with AZURE_POLICY_RESTRICTED=true, else the main one.')
param securityWorkspaceId string

@description('Email receivers of every alert.')
param alertEmails array

@description('The Kubernetes namespace of the portal, the controller and the Linux worker.')
param namespace string

@description('The AKS cluster.')
param aksClusterName string

@description('The main storage account.')
param storageAccountName string

@description('The disk controller\'s state account.')
param controllerStorageAccountName string

@description('The stamp Key Vault.')
param stampKeyVaultName string

@description('The deploy-only Key Vault.')
param deployKeyVaultName string

@description('The personal Key Vault.')
param personalKeyVaultName string

@description('Principal ID of the disk controller\'s identity.')
param controllerPrincipalId string

@description('The disk controller\'s and the portal\'s role assignments that this deployment makes on the scopes the role assignment rules watch, each { principalId, roleId, scope }. The rules exempt exactly these; an empty list exempts nothing.')
param ownRoleGrants array = []

@description('The deploying principal; empty alerts on every writer it would be exempt from.')
param deployPrincipalId string = ''

@description('Names (GUIDs) of the pool\'s custom role definitions; the personal secret writer has data actions.')
param customRoleIds array = []

@description('Whether the Linux worker runs as the coordination host (WIN_WORKER_COORDINATION_HOST=true), which sends every capacity request to the controller. Adds the alert on requests the controller leaves unanswered.')
param coordinationHost bool = false

// ─── Logs ───

resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-05-01' existing = {
  name: aksClusterName
}

resource aksAuditLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'kube-audit'
  scope: aksCluster
  properties: {
    workspaceId: mainWorkspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'kube-audit'
        enabled: true
      }
    ]
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource storageBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource controllerStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: controllerStorageAccountName
}

resource controllerBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: controllerStorageAccount
  name: 'default'
}

var blobLogs = [
  {
    category: 'StorageRead'
    enabled: true
  }
  {
    category: 'StorageWrite'
    enabled: true
  }
  {
    category: 'StorageDelete'
    enabled: true
  }
]

resource storageBlobLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'blob-audit'
  scope: storageBlobService
  properties: {
    workspaceId: securityWorkspaceId
    logs: blobLogs
  }
}

resource controllerBlobLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'blob-audit'
  scope: controllerBlobService
  properties: {
    workspaceId: securityWorkspaceId
    logs: blobLogs
  }
}

resource stampKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: stampKeyVaultName
}

resource deployKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: deployKeyVaultName
}

resource personalKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: personalKeyVaultName
}

var auditEventLogs = [
  {
    category: 'AuditEvent'
    enabled: true
  }
]

resource stampKeyVaultLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'vault-audit'
  scope: stampKeyVault
  properties: {
    workspaceId: securityWorkspaceId
    logs: auditEventLogs
  }
}

resource deployKeyVaultLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'vault-audit'
  scope: deployKeyVault
  properties: {
    workspaceId: securityWorkspaceId
    logs: auditEventLogs
  }
}

resource personalKeyVaultLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'vault-audit'
  scope: personalKeyVault
  properties: {
    workspaceId: securityWorkspaceId
    logs: auditEventLogs
  }
}

// ─── Receivers ───

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${resourceNamePrefix}-win-worker-alerts'
  location: 'global'
  properties: {
    groupShortName: 'pswinworker'
    enabled: true
    emailReceivers: [
      for (email, i) in alertEmails: {
        name: 'receiver-${i}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

// ─── Alerts ───

var controllerOid = toLower(controllerPrincipalId)
var deployOid = toLower(deployPrincipalId)
var subscriptionScope = toLower(subscription().id)
var resourceGroupScope = toLower(resourceGroup().id)
var personalKeyVaultScope = toLower(personalKeyVault.id)
var controllerStorageScope = toLower(controllerStorageAccount.id)
var serviceAccounts = '"pilotswarm-disk-controller", "pilotswarm-portal", "copilot-runtime-worker"'
// Built-in roles that read or write Key Vault secrets or blobs, or hand out
// such roles: every built-in role whose data actions include reading or
// setting a secret (secrets/getSecret/action, secrets/setSecret/action) or
// reading, writing or deleting a blob (blobs/read, write, delete), as
// `az role definition list` reports them; Key Vault Data Access
// Administrator, which assigns the Key Vault data roles; and two kept from
// the first list, Key Vault Certificates Officer and Storage Blob Delegator.
// A role that can assign any role (Owner, User Access Administrator) is not
// here: the data role it hands out alerts when it is assigned.
var dataRoleIds = concat([
  '00482a5a-887f-4fb3-b363-3b7fe8e74483' // Key Vault Administrator
  'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba' // Key Vault Certificate User (a certificate's secret)
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer
  '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
  'a4417e6f-fecd-4de8-b567-7b0420556985' // Key Vault Certificates Officer
  '8b54135c-b56d-4d72-a534-26097cfdc8d8' // Key Vault Data Access Administrator
  '44f0a1a8-6fea-4b35-980a-8ff50c487c97' // Operator Nexus Key Vault Writer Service Role (Preview)
  'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // Storage Blob Data Owner
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor
  '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // Storage Blob Data Reader
  'db58b8e5-c6ad-4a2a-8342-4190687cbf4a' // Storage Blob Delegator
  '4bad4d9e-2a13-4888-94bb-c8432f6f3040' // Storage Actions Blob Data Operator
  '9d819e60-1b9f-4871-b492-4e6cdee0b50a' // Storage Connector Contributor
  '35c49d44-ccc1-4b18-8267-cfb3bacdd396' // Storage DataShare Contributor
  '4f8fab4f-1852-4a58-a46a-8eaf358af14a' // Avere Contributor
  'c025889f-8102-4ebf-b32c-fc0c6f0c6bd9' // Avere Operator
  '7b0c7e81-271f-4c71-90bf-e30bdfdbc2f7' // Azure Center for SAP solutions administrator
  '8b32b316-c2f5-4ddf-b05b-83dacd2d08b5' // Azure Red Hat OpenShift Image Registry Operator
  'bf41e52e-617f-4981-8b7a-47431bd4e011' // CosmosDB Fleet Analytics Storage Data Writer
  '1e7ca9b1-60d1-4db8-a914-f2ca1ff27c40' // Defender for Storage Data Scanner
  '0b6ca2e8-2cdc-4bd6-b896-aa3d8c21fc35' // Defender Sensitive Data Discovery
  'c6c9b2d8-9a5e-4122-85e1-81612a046ab2' // Defender Storage Automated Malware Remediation
  'cd50fd1f-0421-46f2-8cce-afc587dbcc77' // Defender Storage Malware Data Scanner
  'abed7cd4-f358-4384-9d17-def9303b3b53' // MySQL User Data Reader
  '8894c184-eeb6-45cc-868a-1be782055af3' // MySQL User Data Writer
  'dfce8971-25e3-42e3-ba33-6055438e3080' // VM Restore Operator
], map(customRoleIds, id => toLower(id)))
var dataRoleList = join(map(dataRoleIds, id => '"${id}"'), ', ')
// The deployment's own grants as principal|role|scope: an assignment is exempt
// only when all three match one of them, so another role for the same
// identity, or the same role on another scope, still alerts.
var ownRoleGrantKeys = map(ownRoleGrants, grant => toLower(format('"{0}|{1}|{2}"', grant.principalId, grant.roleId, grant.scope)))
var ownRoleGrantList = empty(ownRoleGrantKeys) ? '""' : join(ownRoleGrantKeys, ', ')
// Rows ingested since the previous run, whatever their time stamp.
var newRows = 'where ingestion_time() > ago(5m)'
var roleAssignmentWrites = join([
  'AzureActivity'
  'where OperationNameValue =~ "Microsoft.Authorization/roleAssignments/write"'
  'extend scope = tostring(split(tolower(_ResourceId), "/providers/microsoft.authorization/roleassignments/")[0])'
  'extend body = parse_json(tostring(Properties_d.requestbody))'
  'extend principal = tolower(tostring(coalesce(body.Properties.PrincipalId, body.properties.principalId)))'
  'extend role = tolower(tostring(split(tostring(coalesce(body.Properties.RoleDefinitionId, body.properties.roleDefinitionId)), "/")[-1]))'
  'where isnotempty(principal)'
  'extend assignment = strcat(principal, "|", role, "|", scope)'
], '\n| ')
var controllerAlerts = join([
  'ContainerLogV2'
  'where PodNamespace == "${namespace}" and ContainerName == "disk-controller"'
  'extend entry = parse_json(tostring(LogMessage))'
  'where tostring(entry.level) == "alert"'
], '\n| ')
var auditLog = join([
  'AKSAudit'
  'where Stage == "ResponseComplete"'
  'where tostring(ObjectRef.namespace) == "${namespace}"'
], '\n| ')
// exec and attach are long-running requests: the API server writes their
// ResponseStarted stage as the session opens, and ResponseComplete only once
// it closes. So the rule takes ResponseStarted. AKS doesn't publish its
// current audit policy (the one it last published omits only
// RequestReceived), so a request without a ResponseStarted record in the
// query's hour counts at ResponseComplete instead. Each request (AuditId)
// counts once; a session open for longer than the hour alerts again as it
// closes.
var podExecLets = join([
  'let requests = AKSAudit | where tostring(ObjectRef.namespace) == "${namespace}" | where tostring(ObjectRef.resource) == "pods" and tostring(ObjectRef.subresource) in ("exec", "attach") | where Stage in ("ResponseStarted", "ResponseComplete");'
  'let started = requests | where Stage == "ResponseStarted" | distinct AuditId;'
], '\n')
var podExecPipeline = join([
  'requests'
  newRows
  'where Stage == "ResponseStarted" or AuditId !in (started)'
  'summarize arg_min(TimeGenerated, *) by AuditId'
], '\n| ')
// Drive attaches ingested 15 to 20 minutes ago, each matched with an admission
// (`vm.admit` answered admit) of its root session on the same VM. Every turn
// asks for admission before it starts, and its attach follows within the
// attach's own deadline: 30 minutes allow for that. A workspace check runs no
// turn: it matches an admission from 23 hours before (a turn in progress, or
// the session's earlier turns on that VM) to 15 minutes after (the turn that
// follows a workspace set before the prompt), which the 15-minute delay
// leaves time to arrive. A check attaches the drive in Azure as a turn does,
// and the VM that holds the drive gets the work's per-work credential, so
// both are watched.
var attachWithoutTurnLets = join([
  'let records = ContainerLogV2 | where PodNamespace == "${namespace}" and ContainerName == "disk-controller" | extend entry = parse_json(tostring(LogMessage)) | extend vm = tostring(entry.vm), root = tostring(entry.root);'
  'let attaches = records | where tostring(entry.event) == "drive.attach" | where ingestion_time() between (ago(20m) .. ago(15m)) | project attachedAt = TimeGenerated, vm, root, purpose = tostring(entry.purpose);'
  'let admissions = records | where tostring(entry.event) == "vm.admit" and tostring(entry.decision) == "admit" | project admittedAt = TimeGenerated, vm, root;'
], '\n')
var attachWithoutTurnPipeline = join([
  'attaches'
  'join kind=leftouter admissions on vm, root'
  'summarize matched = countif((purpose == "turn" and admittedAt between ((attachedAt - 30m) .. (attachedAt + 1m))) or (purpose != "turn" and admittedAt between ((attachedAt - 23h) .. (attachedAt + 15m)))) by attachedAt, vm, root, purpose'
  'where matched == 0'
], '\n| ')

var rules = [
  {
    name: 'personal-vault-read'
    description: 'A secret in the personal vault was read by a principal other than the disk controller.'
    severity: 1
    workspaceId: securityWorkspaceId
    query: join([
      'AzureDiagnostics'
      'where ResourceProvider == "MICROSOFT.KEYVAULT" and Resource =~ "${personalKeyVaultName}"'
      'where OperationName == "SecretGet"'
      'where tolower(tostring(column_ifexists("identity_claim_oid_g", ""))) != "${controllerOid}"'
      newRows
    ], '\n| ')
  }
  {
    name: 'deploy-vault-ca-key-read'
    description: 'A key of the disk controller\'s CA, the current one or the next one of a CA rotation, was read from the deploy-only vault.'
    severity: 1
    workspaceId: securityWorkspaceId
    query: join([
      'AzureDiagnostics'
      'where ResourceProvider == "MICROSOFT.KEYVAULT" and Resource =~ "${deployKeyVaultName}"'
      'where OperationName == "SecretGet"'
      'extend secretId = tostring(column_ifexists("id_s", ""))'
      'where secretId contains "/secrets/disk-controller-ca-key/" or secretId contains "/secrets/disk-controller-ca-key-next/"'
      newRows
    ], '\n| ')
  }
  {
    name: 'controller-state-access'
    description: 'The disk controller\'s state container was read or written by a principal other than the controller.'
    severity: 1
    workspaceId: securityWorkspaceId
    query: join([
      'StorageBlobLogs'
      'where AccountName =~ "${controllerStorageAccountName}"'
      'where tolower(ObjectKey) startswith "/${toLower(controllerStorageAccountName)}/disk-pool-state"'
      'where isempty(RequesterObjectId) or tolower(RequesterObjectId) != "${controllerOid}"'
      newRows
    ], '\n| ')
  }
  {
    name: 'release-or-manifest-write'
    description: 'A Windows worker release or a Flux manifest was written or deleted by a principal other than the deploying one.'
    severity: 1
    workspaceId: securityWorkspaceId
    query: join([
      'StorageBlobLogs'
      'where AccountName =~ "${storageAccountName}"'
      'where OperationName in ("PutBlob", "PutBlock", "PutBlockList", "PutBlockFromURL", "CopyBlob", "CopyBlobFromURL", "AppendBlock", "PutPage", "SetBlobMetadata", "SetBlobProperties", "SetBlobTier", "DeleteBlob", "UndeleteBlob", "CreateContainer", "DeleteContainer", "SetContainerMetadata", "SetContainerACL")'
      'extend container = tostring(split(ObjectKey, "/")[2])'
      'where container == "win-worker-releases" or container endswith "-manifests"'
      'where isempty(RequesterObjectId) or tolower(RequesterObjectId) != "${deployOid}"'
      newRows
    ], '\n| ')
  }
  {
    name: 'sensitive-role-assignment'
    description: 'A role was assigned on the personal vault or the disk controller\'s state account, other than the grants the deployment makes there itself.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      roleAssignmentWrites
      'where scope startswith "${personalKeyVaultScope}" or scope startswith "${controllerStorageScope}"'
      'where assignment !in (${ownRoleGrantList})'
      newRows
    ], '\n| ')
  }
  {
    name: 'data-role-assignment'
    description: 'A role that reads or writes Key Vault secrets or blobs was assigned on the subscription, the stamp resource group, the personal vault or the disk controller\'s state account, other than the grants the deployment makes itself.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      roleAssignmentWrites
      'where scope in ("${subscriptionScope}", "${resourceGroupScope}") or scope startswith "${personalKeyVaultScope}" or scope startswith "${controllerStorageScope}"'
      'where role in (${dataRoleList})'
      'where assignment !in (${ownRoleGrantList})'
      newRows
    ], '\n| ')
  }
  {
    name: 'run-command'
    description: 'Run Command was used on a stamp VM by a principal other than the disk controller.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      'AzureActivity'
      'where ResourceGroup =~ "${resourceGroup().name}"'
      'where OperationNameValue in~ ("Microsoft.Compute/virtualMachines/runCommand/action", "Microsoft.Compute/virtualMachines/runCommands/write", "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/runCommand/action", "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/runCommands/write")'
      'where tolower(Caller) != "${controllerOid}"'
      newRows
    ], '\n| ')
  }
  {
    name: 'federated-credential-write'
    description: 'A federated credential was written on a stamp identity by a principal other than the deploying one.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      'AzureActivity'
      'where ResourceGroup =~ "${resourceGroup().name}"'
      'where OperationNameValue =~ "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write"'
      'where tolower(Caller) != "${deployOid}"'
      newRows
    ], '\n| ')
  }
  {
    name: 'pod-exec'
    description: 'Someone opened an exec or attach session into a pod of the stamp namespace.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: '${podExecLets}\n${podExecPipeline}'
  }
  {
    name: 'pod-created-directly'
    description: 'A pod with the controller\'s, the portal\'s or the Linux worker\'s service account was created by something other than its ReplicaSet or Job.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      auditLog
      'where Verb == "create" and tostring(ObjectRef.resource) == "pods" and isempty(tostring(ObjectRef.subresource))'
      'where tostring(RequestObject.spec.serviceAccountName) in (${serviceAccounts})'
      'where tostring(User.username) !in ("system:serviceaccount:kube-system:replicaset-controller", "system:serviceaccount:kube-system:job-controller")'
      newRows
    ], '\n| ')
  }
  {
    name: 'service-account-token'
    description: 'A token for the controller\'s, the portal\'s or the Linux worker\'s service account was requested by something other than a node.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      auditLog
      'where tostring(ObjectRef.resource) == "serviceaccounts" and tostring(ObjectRef.subresource) == "token"'
      'where tostring(ObjectRef.name) in (${serviceAccounts})'
      'where not(tostring(User.username) startswith "system:node:")'
      newRows
    ], '\n| ')
  }
  {
    name: 'forced-session-delete'
    description: 'The portal force-deleted a session for the dispatcher.'
    severity: 2
    workspaceId: mainWorkspaceId
    query: join([
      'ContainerLogV2'
      'where PodNamespace == "${namespace}" and ContainerName == "portal"'
      'extend entry = parse_json(tostring(LogMessage))'
      'where tostring(entry.event) == "pilotswarm.dispatcher_delegation" and tostring(entry.action) == "deleteSession" and tobool(entry.force)'
      newRows
    ], '\n| ')
  }
  {
    name: 'drive-quarantined'
    description: 'The disk controller quarantined a drive lease: a fenced VM\'s deletion failed or could not be confirmed.'
    severity: 2
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "drive.quarantine"'
      newRows
    ], '\n| ')
  }
  {
    name: 'vm-crash-loop'
    description: 'The disk controller fenced a crash-looping Windows worker.'
    severity: 2
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "vms.crash-loop"'
      newRows
    ], '\n| ')
  }
  {
    name: 'vm-mass-silence'
    description: 'Many Windows workers went silent at once; the disk controller fenced none of them.'
    severity: 1
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "vms.mass-silence"'
      newRows
    ], '\n| ')
  }
  {
    name: 'snapshot-refresh-failed'
    description: 'The weekly golden snapshot refresh failed; drives still copy the previous snapshot.'
    severity: 3
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "snapshot.refresh-failed"'
      newRows
    ], '\n| ')
  }
  {
    name: 'pool-full'
    description: 'A drive claim was answered POOL_FULL: every drive of the pool is leased.'
    severity: 3
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "pool.full"'
      newRows
    ], '\n| ')
  }
  {
    name: 'drive-full'
    description: 'A drive is at its maximum size and still short of free space, or a growth did not show on the VM.'
    severity: 3
    workspaceId: mainWorkspaceId
    query: join([
      controllerAlerts
      'where tostring(entry.event) == "drive.full"'
      newRows
    ], '\n| ')
  }
  {
    name: 'attach-without-turn'
    description: 'A drive was attached to a Windows worker without an admission of its root session on that VM: none in the 30 minutes before a turn\'s attach, or from 23 hours before to 15 minutes after a workspace check\'s.'
    severity: 2
    workspaceId: mainWorkspaceId
    // The admissions a check matches reach back almost a day.
    windowSize: 'P1D'
    query: '${attachWithoutTurnLets}\n${attachWithoutTurnPipeline}'
  }
]

// A rule's query reads the last hour unless the rule sets its own windowSize.
var rulesWithWindow = map(rules, rule => union({ windowSize: 'PT1H' }, rule))

resource alertRules 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [
  for rule in rulesWithWindow: {
    name: '${resourceNamePrefix}-${rule.name}'
    location: location
    properties: {
      displayName: '${resourceNamePrefix} ${rule.name}'
      description: rule.description
      severity: rule.severity
      enabled: true
      evaluationFrequency: 'PT5M'
      windowSize: rule.windowSize
      scopes: [
        rule.workspaceId
      ]
      skipQueryValidation: true
      autoMitigate: false
      criteria: {
        allOf: [
          {
            query: rule.query
            timeAggregation: 'Count'
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      actions: {
        actionGroups: [
          actionGroup.id
        ]
      }
    }
  }
]

// The coordination host's capacity requests. The SDK traces each answer of
// the requestOwnerCapacity activity to the worker container's log; the answer
// is `busy CAPACITY_UNAVAILABLE` when the controller didn't answer within 15
// seconds or refused the request itself, and the session asks again a minute
// later. The rule fires while requests have gone unanswered for 5 minutes
// since the last answered one.
var capacityRequestLets = join([
  'let requests = ContainerLogV2 | where PodNamespace == "${namespace}" and ContainerName == "worker" | extend line = tostring(LogMessage) | where line contains "[requestOwnerCapacity]";'
  'let answered = toscalar(requests | where not(line contains_cs "CAPACITY_UNAVAILABLE") | summarize max(TimeGenerated));'
  'let unanswered = requests | where line contains_cs "CAPACITY_UNAVAILABLE" | where isnull(answered) or TimeGenerated > answered;'
], '\n')
var capacityRequestPipeline = join([
  'unanswered'
  'where TimeGenerated >= toscalar(unanswered | summarize min(TimeGenerated)) + 5m'
  newRows
], '\n| ')

resource capacityRequestAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (coordinationHost) {
  name: '${resourceNamePrefix}-capacity-request-unanswered'
  location: location
  properties: {
    displayName: '${resourceNamePrefix} capacity-request-unanswered'
    description: 'The disk controller has answered none of the coordination host\'s capacity requests for 5 minutes: sessions whose owner has no Windows worker running wait for one.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    scopes: [
      mainWorkspaceId
    ]
    skipQueryValidation: true
    autoMitigate: false
    criteria: {
      allOf: [
        {
          query: '${capacityRequestLets}\n${capacityRequestPipeline}'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

output actionGroupId string = actionGroup.id
output alertRuleNames array = [for rule in rules: '${resourceNamePrefix}-${rule.name}']
