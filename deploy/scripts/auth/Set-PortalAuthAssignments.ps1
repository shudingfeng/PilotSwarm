<#
.SYNOPSIS
    Assigns users, groups and service principals to the app roles on a
    PilotSwarm portal Entra app registration.

.DESCRIPTION
    Companion to Setup-PortalAuth.ps1. Where Setup-PortalAuth creates the
    app + service principal + roles, this script just manages role
    assignments — list, add, remove. It can be re-run any time to grant
    or revoke access without touching the app itself.

    Identifiers can be:
      - User Principal Name (e.g. alice@contoso.com)
      - User or Group object id (GUID)
      - Group display name
      - Service principal object id or application (client) id, for a
        role that applications can hold: 'worker', 'deployer',
        'coordinator', and 'user' on an app set up with
        Setup-PortalAuth.ps1 -WorkerRoles

    The script resolves each identifier to a principal via Microsoft
    Graph, looks up the role IDs from the app's appRoles collection,
    and POSTs to /servicePrincipals/{sp-id}/appRoleAssignedTo. Already-
    assigned principals are treated as no-ops (idempotent). It looks up
    only the principal kinds the role allows: users and groups for
    allowedMemberTypes "User", service principals for "Application".

.PARAMETER AppId
    The clientId (appId) of the portal app. Required unless -EnvName
    auto-discovers it from deploy/envs/local/<env>/entra-app.json.

.PARAMETER EnvName
    Auto-discover -AppId from deploy/envs/local/<env>/entra-app.json
    (the summary file Setup-PortalAuth writes).

.PARAMETER AdminAssignments
    Identifiers to assign to the 'admin' role. Comma-separated when
    passed via command line, e.g.
        -AdminAssignments alice@contoso.com,bob@contoso.com

.PARAMETER UserAssignments
    Identifiers to assign to the 'user' role. Service principals are
    accepted when the role allows applications (Setup-PortalAuth.ps1
    -WorkerRoles), for example an automation service principal that
    creates sessions for users.

.PARAMETER List
    Lists current assignments instead of modifying anything. Implies
    no other action.

.PARAMETER Remove
    With -AdminAssignments / -UserAssignments (or any of the
    application-role parameters below), removes those assignments
    instead of adding them.

.PARAMETER AdminRoleValue
    Override the role 'value' the script treats as admin. Default: admin

.PARAMETER UserRoleValue
    Override the role 'value' the script treats as user. Default: user

.PARAMETER WorkerAssignments
    Service principals to assign to the 'worker' role, such as a worker
    pool's managed identity: object id or application (client) id,
    comma-separated. The role comes from Setup-PortalAuth.ps1 -WorkerRoles.

.PARAMETER DeployerAssignments
    Service principals to assign to the 'deployer' role, such as a
    deployment pipeline's identity.

.PARAMETER CoordinatorAssignments
    Service principals to assign to the 'coordinator' role, such as a
    coordination service's identity.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName myentra `
        -AdminAssignments admin@example.com

    Adds admin@example.com to the admin role on the myentra
    stamp's portal app.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName myentra `
        -AdminAssignments alice@contoso.com,bob@contoso.com `
        -UserAssignments "Portal Beta Users"

    Adds two users to admin and one group (by display name) to user.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName myentra -List

    Prints current admin/user assignments without modifying anything.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName myentra `
        -AdminAssignments alice@contoso.com -Remove

    Removes alice@contoso.com from the admin role.

.EXAMPLE
    .\Set-PortalAuthAssignments.ps1 -EnvName myentra `
        -WorkerAssignments <worker-identity-object-id> `
        -DeployerAssignments <pipeline-identity-object-id>

    Assigns the 'worker' and 'deployer' roles to two service principals.
    Run it as a Cloud Application Administrator or Application
    Administrator.

.NOTES
    Prerequisites:
    - Azure CLI installed and logged in (az login). The signed-in user
      must be an owner of the app/SP or hold a directory role that
      permits app-role assignment management (e.g. Application
      Administrator, Cloud Application Administrator, or the SP's
      Owner role).
    - Assigning a role to a service principal needs an Entra
      administrator: Cloud Application Administrator or Application
      Administrator. Owning the app is not enough.
    - The app must already have the 'admin' / 'user' app roles. Run
      Setup-PortalAuth.ps1 with -CreateAppRoles first if it doesn't, and
      with -WorkerRoles for 'worker', 'deployer' and 'coordinator'.
#>

[CmdletBinding(DefaultParameterSetName='Assign')]
param(
    [Parameter(Mandatory=$false)][string]$AppId,
    [Parameter(Mandatory=$false)][string]$EnvName,
    [Parameter(Mandatory=$false)][string[]]$AdminAssignments = @(),
    [Parameter(Mandatory=$false)][string[]]$UserAssignments = @(),
    [Parameter(Mandatory=$false)][switch]$List,
    [Parameter(Mandatory=$false)][switch]$Remove,
    [Parameter(Mandatory=$false)][string]$AdminRoleValue = "admin",
    [Parameter(Mandatory=$false)][string]$UserRoleValue = "user",
    [Parameter(Mandatory=$false)][string[]]$WorkerAssignments = @(),
    [Parameter(Mandatory=$false)][string[]]$DeployerAssignments = @(),
    [Parameter(Mandatory=$false)][string[]]$CoordinatorAssignments = @()
)

$ErrorActionPreference = "Stop"

function Test-AzureCliReady {
    try {
        $null = az version 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Azure CLI is not installed or not in PATH"; return $false }
        $null = az account show 2>$null
        if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run 'az login' first."; return $false }
        return $true
    } catch { Write-Error "Error checking az CLI: $_"; return $false }
}

function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
}

function Resolve-AppIdFromEnv {
    param([string]$Env)
    $repo = Get-RepoRoot
    $summary = Join-Path $repo "deploy/envs/local/$Env/entra-app.json"
    if (-not (Test-Path $summary)) {
        throw "No entra-app.json found for env '$Env' at $summary. Pass -AppId explicitly, or run Setup-PortalAuth.ps1 first."
    }
    $j = Get-Content $summary -Raw | ConvertFrom-Json
    if (-not $j.clientId) { throw "$summary has no clientId field" }
    return $j.clientId
}

function Resolve-Principal {
    <#
    Resolves a user-supplied identifier to @{ id; type; display } where
    type is "User", "Group" or "ServicePrincipal". Returns $null if nothing
    matches. -MemberTypes is the role's allowedMemberTypes: "User" looks up
    users and groups, "Application" looks up service principals.

    Lookup order:
      - GUID  → User first, then Group, then ServicePrincipal (object id or application id)
      - UPN-like (contains '@') → User by UPN
      - Otherwise → User by UPN (in case bare alias), then Group by displayName,
        then ServicePrincipal by service principal name
    #>
    param([string]$Identifier, [string[]]$MemberTypes = @("User"))
    if ([string]::IsNullOrWhiteSpace($Identifier)) { return $null }
    $id = $Identifier.Trim()
    $isGuid = $id -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    if ($MemberTypes -contains "User") {
        $u = az ad user show --id $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $u) {
            $obj = $u | ConvertFrom-Json
            return @{ id = $obj.id; type = "User"; display = $obj.userPrincipalName }
        }
        if ($isGuid) {
            $g = az ad group show --group $id 2>$null
            if ($LASTEXITCODE -eq 0 -and $g) {
                $obj = $g | ConvertFrom-Json
                return @{ id = $obj.id; type = "Group"; display = $obj.displayName }
            }
        } else {
            $g = az ad group list --display-name $id --query "[0]" 2>$null
            if ($LASTEXITCODE -eq 0 -and $g -and "$g".Trim() -ne "null" -and "$g".Trim() -ne "") {
                $obj = $g | ConvertFrom-Json
                if ($obj) { return @{ id = $obj.id; type = "Group"; display = $obj.displayName } }
            }
        }
    }
    if ($MemberTypes -contains "Application") {
        $sp = az ad sp show --id $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $sp) {
            $obj = $sp | ConvertFrom-Json
            return @{ id = $obj.id; type = "ServicePrincipal"; display = $obj.displayName }
        }
    }
    return $null
}

function Get-PrincipalKinds {
    param([string[]]$MemberTypes)
    if ($MemberTypes -notcontains "Application") { return "User or Group" }
    if ($MemberTypes -contains "User") { return "User, Group or ServicePrincipal" }
    return "ServicePrincipal"
}

function Get-RoleMemberTypes {
    # A role without allowedMemberTypes is treated as users-only, as before.
    param([hashtable]$Ctx, [string]$RoleValue)
    $types = @(@($Ctx.roleMemberTypes[$RoleValue]) | Where-Object { $_ })
    if ($types.Count -eq 0) { $types = @("User") }
    return ,$types
}

function Get-AppContext {
    <#
    Loads { spObjectId, roleMap, roleMemberTypes } for the given appId.
    roleMap is value → role GUID (e.g. 'admin' → '...'); roleMemberTypes is
    value → allowedMemberTypes.
    #>
    param([string]$AppId)
    $app = az ad app show --id $AppId 2>$null | ConvertFrom-Json
    if (-not $app) { throw "Could not load app $AppId" }
    $sp = az ad sp show --id $AppId 2>$null | ConvertFrom-Json
    if (-not $sp) { throw "Could not load service principal for app $AppId. Has the SP been created?" }
    $map = @{}
    $memberTypes = @{}
    foreach ($r in @($app.appRoles)) {
        if ($r.value -and $r.id) {
            $map[$r.value] = $r.id
            $memberTypes[$r.value] = @($r.allowedMemberTypes)
        }
    }
    return @{
        appId        = $AppId
        appObjectId  = $app.id
        spObjectId   = $sp.id
        displayName  = $app.displayName
        roleMap      = $map
        roleMemberTypes = $memberTypes
    }
}

function Get-CurrentAssignments {
    param([string]$SpObjectId)
    $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo"
    $out = az rest --method GET --url $url 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to list current assignments: $out" }
    $parsed = $out | ConvertFrom-Json
    return @($parsed.value)
}

function New-AppRoleAssignment {
    param([string]$SpObjectId, [string]$PrincipalId, [string]$AppRoleId, [string]$DisplayHint)
    $body = @{ principalId = $PrincipalId; resourceId = $SpObjectId; appRoleId = $AppRoleId } | ConvertTo-Json -Compress
    $bodyFile = [System.IO.Path]::GetTempFileName()
    try {
        $body | Out-File -FilePath $bodyFile -Encoding UTF8 -NoNewline
        $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo"
        $out = az rest --method POST --url $url --headers "Content-Type=application/json" --body "@$bodyFile" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    OK: assigned $DisplayHint" -ForegroundColor Green
            return $true
        }
        $outStr = "$out"
        if ($outStr -match 'Permission being assigned was already assigned' -or $outStr -match 'already exists') {
            Write-Host "    OK: $DisplayHint already assigned (no-op)" -ForegroundColor DarkGray
            return $true
        }
        Write-Warning "    Failed to assign ${DisplayHint}: $outStr"
        return $false
    } finally {
        if (Test-Path $bodyFile) { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue }
    }
}

function Remove-AppRoleAssignment {
    param([string]$SpObjectId, [string]$AssignmentId, [string]$DisplayHint)
    $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$SpObjectId/appRoleAssignedTo/$AssignmentId"
    $out = az rest --method DELETE --url $url 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    OK: removed $DisplayHint" -ForegroundColor Green
        return $true
    }
    Write-Warning "    Failed to remove ${DisplayHint}: $out"
    return $false
}

function Invoke-AssignBatch {
    param([hashtable]$Ctx, [string]$RoleValue, [string[]]$Identifiers, [string]$SetupSwitch = "-CreateAppRoles")
    if (-not $Identifiers -or $Identifiers.Count -eq 0) { return }
    if (-not $Ctx.roleMap.ContainsKey($RoleValue)) {
        Write-Warning "App '$($Ctx.displayName)' has no role with value '$RoleValue' - skipping $($Identifiers.Count) assignment(s). Did you run Setup-PortalAuth.ps1 with ${SetupSwitch}?"
        return
    }
    $roleId = $Ctx.roleMap[$RoleValue]
    $memberTypes = Get-RoleMemberTypes -Ctx $Ctx -RoleValue $RoleValue
    Write-Host "  Assigning '$RoleValue' role to $($Identifiers.Count) principal(s)..." -ForegroundColor Yellow
    foreach ($ident in $Identifiers) {
        $p = Resolve-Principal -Identifier $ident -MemberTypes $memberTypes
        if (-not $p) {
            Write-Warning "    Could not resolve '$ident' to a $(Get-PrincipalKinds $memberTypes) - skipping"
            continue
        }
        $null = New-AppRoleAssignment -SpObjectId $Ctx.spObjectId -PrincipalId $p.id -AppRoleId $roleId -DisplayHint "$($p.display) [$($p.type)] -> $RoleValue"
    }
}

function Invoke-RemoveBatch {
    param([hashtable]$Ctx, [string]$RoleValue, [string[]]$Identifiers)
    if (-not $Identifiers -or $Identifiers.Count -eq 0) { return }
    if (-not $Ctx.roleMap.ContainsKey($RoleValue)) {
        Write-Warning "App '$($Ctx.displayName)' has no role with value '$RoleValue' - nothing to remove"
        return
    }
    $roleId = $Ctx.roleMap[$RoleValue]
    $memberTypes = Get-RoleMemberTypes -Ctx $Ctx -RoleValue $RoleValue
    $current = Get-CurrentAssignments -SpObjectId $Ctx.spObjectId
    Write-Host "  Removing '$RoleValue' role from $($Identifiers.Count) principal(s)..." -ForegroundColor Yellow
    foreach ($ident in $Identifiers) {
        $p = Resolve-Principal -Identifier $ident -MemberTypes $memberTypes
        if (-not $p) {
            Write-Warning "    Could not resolve '$ident' to a $(Get-PrincipalKinds $memberTypes) - skipping"
            continue
        }
        $match = $current | Where-Object { $_.principalId -eq $p.id -and $_.appRoleId -eq $roleId } | Select-Object -First 1
        if (-not $match) {
            Write-Host "    SKIP: $($p.display) [$($p.type)] is not currently assigned to '$RoleValue'" -ForegroundColor DarkGray
            continue
        }
        $null = Remove-AppRoleAssignment -SpObjectId $Ctx.spObjectId -AssignmentId $match.id -DisplayHint "$($p.display) [$($p.type)] -> $RoleValue"
    }
}

function Show-Assignments {
    param([hashtable]$Ctx)
    $current = Get-CurrentAssignments -SpObjectId $Ctx.spObjectId
    Write-Host ""
    Write-Host "Current assignments for '$($Ctx.displayName)' (appId $($Ctx.appId)):" -ForegroundColor Cyan
    if (-not $current -or $current.Count -eq 0) {
        Write-Host "  (none)" -ForegroundColor DarkGray
        return
    }
    # Reverse the role map for display
    $idToValue = @{}
    foreach ($k in $Ctx.roleMap.Keys) { $idToValue[$Ctx.roleMap[$k]] = $k }
    $rows = $current | ForEach-Object {
        $roleValue = $idToValue[$_.appRoleId]
        if (-not $roleValue) { $roleValue = $_.appRoleId }
        [pscustomobject]@{
            Role         = $roleValue
            Principal    = $_.principalDisplayName
            PrincipalType= $_.principalType
            PrincipalId  = $_.principalId
        }
    }
    $rows | Sort-Object Role, Principal | Format-Table -AutoSize
}

# --- Main ---

if (-not (Test-AzureCliReady)) { exit 1 }

if ([string]::IsNullOrWhiteSpace($AppId)) {
    if ([string]::IsNullOrWhiteSpace($EnvName)) {
        throw "Provide either -AppId or -EnvName."
    }
    $AppId = Resolve-AppIdFromEnv -Env $EnvName
    Write-Host "Resolved AppId from env '$EnvName': $AppId" -ForegroundColor DarkGray
}

$ctx = Get-AppContext -AppId $AppId
Write-Host ""
Write-Host "Target app: $($ctx.displayName)  (appId=$AppId)" -ForegroundColor Cyan
Write-Host "  Service principal object id: $($ctx.spObjectId)"
Write-Host "  Available roles: $((@($ctx.roleMap.Keys) | Sort-Object) -join ', ')"

if ($List) {
    Show-Assignments -Ctx $ctx
    exit 0
}

if ($Remove) {
    Invoke-RemoveBatch -Ctx $ctx -RoleValue $AdminRoleValue -Identifiers $AdminAssignments
    Invoke-RemoveBatch -Ctx $ctx -RoleValue $UserRoleValue -Identifiers $UserAssignments
    Invoke-RemoveBatch -Ctx $ctx -RoleValue "worker" -Identifiers $WorkerAssignments
    Invoke-RemoveBatch -Ctx $ctx -RoleValue "deployer" -Identifiers $DeployerAssignments
    Invoke-RemoveBatch -Ctx $ctx -RoleValue "coordinator" -Identifiers $CoordinatorAssignments
} else {
    Invoke-AssignBatch -Ctx $ctx -RoleValue $AdminRoleValue -Identifiers $AdminAssignments
    Invoke-AssignBatch -Ctx $ctx -RoleValue $UserRoleValue -Identifiers $UserAssignments
    Invoke-AssignBatch -Ctx $ctx -RoleValue "worker" -Identifiers $WorkerAssignments -SetupSwitch "-WorkerRoles"
    Invoke-AssignBatch -Ctx $ctx -RoleValue "deployer" -Identifiers $DeployerAssignments -SetupSwitch "-WorkerRoles"
    Invoke-AssignBatch -Ctx $ctx -RoleValue "coordinator" -Identifiers $CoordinatorAssignments -SetupSwitch "-WorkerRoles"
}

Show-Assignments -Ctx $ctx
