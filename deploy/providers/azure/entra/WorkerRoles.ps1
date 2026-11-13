# The portal app's roles for application identities, for the Entra scripts in
# deploy/scripts/auth: the 'worker', 'deployer' and 'coordinator' roles, the
# 'user' role open to applications, and v2.0 access tokens.
#
# It only defines functions. Setup-PortalAuth.ps1 dot-sources it with
# -WorkerRoles, and Set-PortalAuthAssignments.ps1 always, to look up a role's
# principals by the member types the role allows. Dot-sourced, the functions
# run with the script's $ErrorActionPreference and call the script's own
# functions: Invoke-GraphPatch and Build-AppRolesJson of Setup-PortalAuth.ps1,
# Resolve-Principal of Set-PortalAuthAssignments.ps1.

# ---- Setup-PortalAuth.ps1 -WorkerRoles ----

function Get-WorkerAppRoles {
    # Roles for application identities that call the deployment's own services.
    # The portal admits only 'admin' and 'user'; a service that accepts one of
    # these roles checks the roles claim itself.
    $definitions = @(
        @{ value = "worker"; displayName = "Worker"; description = "Workers that call this PilotSwarm deployment's services, such as a worker pool's managed identity." },
        @{ value = "deployer"; displayName = "Deployer"; description = "Identities that deploy and operate this PilotSwarm deployment, such as a deployment pipeline's identity." },
        @{ value = "coordinator"; displayName = "Coordinator"; description = "Coordination services that call this PilotSwarm deployment's services, such as a coordination service's managed identity." }
    )
    foreach ($d in $definitions) {
        [ordered]@{
            id                 = [System.Guid]::NewGuid().ToString()
            allowedMemberTypes = @("Application")
            description        = $d.description
            displayName        = $d.displayName
            isEnabled          = $true
            value              = $d.value
        }
    }
}

function Copy-AppRole {
    # Keeps only the properties Graph accepts on write ('origin' is read-only).
    param($Role)
    $enabled = $true
    if ($null -ne $Role.isEnabled) { $enabled = [bool]$Role.isEnabled }
    return [ordered]@{
        id                 = [string]$Role.id
        allowedMemberTypes = @(@($Role.allowedMemberTypes) | Where-Object { $_ } | ForEach-Object { [string]$_ })
        description        = $Role.description
        displayName        = $Role.displayName
        isEnabled          = $enabled
        value              = [string]$Role.value
    }
}

function Merge-AppRoles {
    <#
    Returns @{ roles; added; widened }: every role in -Existing, followed by
    each -Wanted role whose value is missing (compared case-insensitively),
    with 'user' also open to applications. Existing roles keep their IDs and
    stay in the list: role assignments refer to the IDs, and Entra refuses to
    drop an enabled role. 'widened' means an existing 'user' role changed.
    #>
    param([object[]]$Existing, [object[]]$Wanted)
    $roles = New-Object System.Collections.Generic.List[object]
    foreach ($role in @($Existing)) { if ($role) { $roles.Add((Copy-AppRole $role)) } }
    $existingCount = $roles.Count
    $added = @()
    foreach ($role in @($Wanted)) {
        if (@($roles | Where-Object { $_.value -ieq $role.value }).Count -eq 0) {
            $roles.Add((Copy-AppRole $role))
            $added += [string]$role.value
        }
    }
    $widened = $false
    for ($i = 0; $i -lt $roles.Count; $i++) {
        $role = $roles[$i]
        if ($role.value -ieq "user" -and $role.allowedMemberTypes -notcontains "Application") {
            $role.allowedMemberTypes = @($role.allowedMemberTypes) + "Application"
            if ($i -lt $existingCount) { $widened = $true }
        }
    }
    return @{ roles = $roles.ToArray(); added = $added; widened = $widened }
}

function ConvertTo-JsonText {
    param($Value)
    if ($null -eq $Value) { return "null" }
    return (ConvertTo-Json -InputObject ([string]$Value) -Compress)
}

function ConvertTo-AppRolesJson {
    param([object[]]$Roles)
    # Literal JSON, as in Build-OptionalClaimsJson: ConvertTo-Json writes empty
    # and one-element arrays differently in PowerShell 5.1 and 7.
    $items = foreach ($role in $Roles) {
        $types = @(@($role.allowedMemberTypes) | ForEach-Object { ConvertTo-JsonText $_ }) -join ", "
        $enabled = if ($role.isEnabled) { "true" } else { "false" }
        $fields = @(
            "`"id`": $(ConvertTo-JsonText $role.id)",
            "`"allowedMemberTypes`": [$types]",
            "`"description`": $(ConvertTo-JsonText $role.description)",
            "`"displayName`": $(ConvertTo-JsonText $role.displayName)",
            "`"isEnabled`": $enabled",
            "`"value`": $(ConvertTo-JsonText $role.value)"
        )
        "  {`n    " + ($fields -join ",`n    ") + "`n  }"
    }
    return "[`n" + (@($items) -join ",`n") + "`n]"
}

function Update-AppWorkerRoles {
    # -ExistingAppId -WorkerRoles: one Graph PATCH adds the roles the app lacks,
    # lets applications hold 'user' and sets v2.0 access tokens; an app that
    # has them all is left as it is.
    param($Existing, $ObjectId)
    $merged = Merge-AppRoles -Existing @($existing.appRoles) -Wanted @(Get-WorkerAppRoles)
    $patchParts = @()
    if ($existing.api.requestedAccessTokenVersion -ne 2) {
        Write-Host "  Setting requestedAccessTokenVersion = 2 (v2.0 access tokens)"
        $patchParts += '"api":{"requestedAccessTokenVersion":2}'
    }
    if ($merged.added.Count -gt 0 -or $merged.widened) {
        if ($merged.added.Count -gt 0) { Write-Host "  Adding app role(s): $($merged.added -join ', ')" }
        if ($merged.widened) { Write-Host "  Letting applications hold the 'user' role" }
        $patchParts += "`"appRoles`":" + (ConvertTo-AppRolesJson -Roles $merged.roles)
    }
    if ($patchParts.Count -eq 0) {
        Write-Host "Worker roles and v2.0 access tokens already present - no change." -ForegroundColor Yellow
    } else {
        Invoke-GraphPatch -ObjectId $objectId -BodyJson ("{" + ($patchParts -join ",") + "}") -Description "Apply worker roles and v2.0 access tokens"
    }
}

function Build-WorkerAppRolesJson {
    # -WorkerRoles on a new app: the app roles to create it with, as JSON.
    param([string]$DisplayName, [switch]$CreateAppRoles)
    # az ad app create updates an app that already has this display name
    # instead of creating a second one, so that app's roles keep their IDs.
    $sameNameJson = az ad app list --display-name $DisplayName 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not look up apps named '$DisplayName' (az ad app list)." }
    $sameNameApps = @()
    if ($sameNameJson) { $sameNameApps = $sameNameJson | ConvertFrom-Json }
    $sameName = @(@($sameNameApps) | Where-Object { $_ -and $_.displayName -ceq $DisplayName })
    $existingRoles = @()
    if ($sameName.Count -eq 1) {
        Write-Host "  An app named '$DisplayName' already exists (appId $($sameName[0].appId)); updating it, existing roles keep their IDs." -ForegroundColor Yellow
        $existingRoles = @($sameName[0].appRoles)
    }
    $wantedRoles = @()
    if ($CreateAppRoles) {
        $portalRoles = Build-AppRolesJson | ConvertFrom-Json
        $wantedRoles += @($portalRoles)
    }
    $wantedRoles += @(Get-WorkerAppRoles)
    $merged = Merge-AppRoles -Existing $existingRoles -Wanted $wantedRoles
    return (ConvertTo-AppRolesJson -Roles $merged.roles)
}

# ---- Set-PortalAuthAssignments.ps1 ----

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

function Resolve-RolePrincipal {
    <#
    Resolves an identifier to @{ id; type; display } for a role whose
    allowedMemberTypes are -MemberTypes: "User" looks up users and groups
    (Resolve-Principal), "Application" service principals by object id or
    application (client) id. Returns $null if nothing matches.
    #>
    param([string]$Identifier, [string[]]$MemberTypes = @("User"))
    if ([string]::IsNullOrWhiteSpace($Identifier)) { return $null }
    $id = $Identifier.Trim()
    if ($MemberTypes -contains "User") {
        $p = Resolve-Principal -Identifier $id
        if ($p) { return $p }
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
