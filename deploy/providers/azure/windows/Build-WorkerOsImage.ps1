<#
.SYNOPSIS
Builds the generalized Windows Server 2025 image every worker VM boots from.

.DESCRIPTION
Run as an administrator on a fresh Windows Server 2025 VM, from a copy of this
folder (deploy/providers/azure/windows). In order, it:

  1. checks the host: an administrator, and no C:\ProgramData\GitHub yet;
  2. installs Node.js -NodeVersion (the version deploy/Dockerfile.worker pins)
     from its MSI, only after the MSI's SHA-256 matches both the pinned value
     and the one Node.js publishes for that release;
  3. creates C:\pilotswarm and installs launcher.mjs, disk-attacher.mjs,
     controller-token.mjs, the scripts (C:\pilotswarm\scripts), the seed
     manifest and the Git configuration;
  4. installs the toolchain manifest's installers and commands, or its steps
     in order (installers, commands, Windows features, restarts, a pinned
     Visual Studio, a partition grown to its disk, hash-checked packages and
     the docker service), then its MCP servers and Defender exclusions;
  5. downloads WinSW -WinSWVersion (pinned SHA-256) and runs
     Install-WinWorkerService.ps1 (worker.env and both services), then gives
     the worker's account the manifest's workerAccount user rights and local
     groups;
  6. turns off crash dumps (Windows Error Reporting Disabled=1, no LocalDumps
     key) and turns on long paths;
  7. locks the folders down (README, "Folders and access"): C:\, C:\pilotswarm
     and its writable folders, the Copilot CLI home's placeholders and settings
     files, C:\ProgramData\GitHub\Copilot\policy.d, C:\ProgramData\Git and a
     C:\node_modules guard; then audits every top-level folder on C:\;
  8. turns off the Remote Desktop, Windows Remote Management and File and
     Printer Sharing firewall rule groups;
  9. with -Generalize, runs Sysprep, which shuts the VM down for capture
     (README, "Capturing it into the gallery").

A manifest with steps can stop the build for a restart: at each restart step,
and after the steps when one of them asked for a restart (exit code 3010 from
an installer, a command or Visual Studio, or a Windows feature that needs
one) or Windows still has servicing to finish, so the services and Sysprep
always follow a restart. The script then exits with code 3010: restart the
VM and run the same command again. It keeps what it finished in
C:\pilotswarm\toolchain\image-build-state.json and goes on from there,
skipping each step whose definition has not changed; after a failure, the
same command goes on the same way. A finished build deletes the file.

The image holds no secret, stamp value or identity: the deployment's per-stamp
values reach each VM through the scale set's userData.

.PARAMETER ToolchainManifest
The toolchain manifest (README, "The toolchain manifest").

.PARAMETER WorkerSettingsFile
The deployment's worker settings, NAME=VALUE lines (README, "The worker settings file").

.PARAMETER SeedManifest
The seed manifest; installed as C:\pilotswarm\seed-manifest.json, where
Seed-WorkerReposDisk.ps1 -Refresh and -Verify find it.

.PARAMETER GitConfigFile
The workers' global Git configuration (GIT_CONFIG_GLOBAL); a minimal one when omitted.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ToolchainManifest,
    [string]$WorkerSettingsFile,
    [string]$SeedManifest,
    [string]$GitConfigFile,
    [string]$Root = 'C:\pilotswarm',
    [string]$NodeVersion = '24.22.1',
    [string]$NodeMsiSha256 = '3bda4baf1ee709b33cf920dd633106ddb23951e322bff9c03ec9f64ab8981b01',
    [string]$WinSWVersion = '2.12.0',
    [string]$WinSWSha256 = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f',
    [string[]]$CopilotHomeFiles = @('copilot-instructions.md', 'mcp-config.json', 'lsp-config.json', 'permissions-config.json', 'mcp-oauth-config.json', 'providers.json'),
    [string[]]$CopilotHomeFolders = @('instructions', 'skills', 'agents', 'extensions', 'pkg', 'hooks', 'installed-plugins', 'mcp-oauth-config', 'mcp-secrets'),
    [string[]]$TopLevelWritableAllowlist = @('$Recycle.Bin', 'ProgramData'),
    [switch]$Generalize
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

$script:NodeExe = 'C:\Program Files\nodejs\node.exe'
# Where the Visual Studio Installer keeps vswhere, which lists the installed instances and their versions.
$script:VsWhere = [string]${env:ProgramFiles(x86)} + '\Microsoft Visual Studio\Installer\vswhere.exe'
# 3010 when the build stopped for a restart: run the same command again once the VM has restarted.
$script:ExitCode = 0
# Folders the worker's account may change; everything else under the root it can only read.
$script:ModifyFolders = @('copilot', 'copilot\session-state', 'copilot\logs', 'logs', 'temp', 'azure-cli')
$script:ReadOnlyFolders = @('work', 'az-extensions', 'run', 'scripts', 'services', 'attacher-logs', 'empty-hooks', 'mcp', 'releases', 'plugins', 'toolchain')
$script:ServiceFiles = @('launcher.mjs', 'disk-attacher.mjs', 'controller-token.mjs')
# The scripts a VM runs (the controller's Run Commands among them), in C:\pilotswarm\scripts.
$script:VmScripts = @('Drain-And-StopWorker.ps1', 'Seed-WorkerReposDisk.ps1', 'Initialize-WinWorkerDisk.ps1', 'Clear-StaleWorkspaces.ps1', 'PilotSwarm.WinWorker.psm1')
# What a file placeholder holds where "{}" (any other .json) or an empty file (anything else) would not do: the
# Copilot CLI rejects {} as an MCP or LSP configuration ("mcpServers: Required", "lspServers must be an object"),
# and reads an empty providers.json as no file at all (README, "C:\pilotswarm").
$script:CopilotHomeFileText = [ordered]@{
    'mcp-config.json' = '{"mcpServers":{}}'
    'lsp-config.json' = '{"lspServers":{}}'
    'providers.json' = ''
}

function Get-CopilotSettingsText {
    <#
    The Copilot CLI home's two settings files in the fixed form the worker checks
    with PILOTSWARM_CLI_DISABLE_HOOKS=1 (packages/sdk/src/cli-hooks.ts).
    #>
    $settings = (@('{', '  "disableAllHooks": true', '}') -join "`n") + "`n"
    $config = (@('// User settings belong in settings.json.', '// This file is managed automatically.', '{', '  "firstLaunchAt": "1970-01-01T00:00:00.000Z"', '}') -join "`n") + "`n"
    return @{ Settings = $settings; Config = $config }
}

# The kinds of toolchain step and the fields each takes besides step, name and notes.
$script:StepFields = [ordered]@{
    installer       = @('url', 'sha256', 'type', 'arguments', 'successExitCodes', 'destination', 'addToPath')
    command         = @('command', 'successExitCodes')
    windowsFeatures = @('features', 'includeManagementTools')
    restart         = @('reason')
    visualStudio    = @('bootstrapper', 'layout', 'vsconfig', 'version', 'arguments', 'successExitCodes')
    extendPartition = @('driveLetter')
    package         = @('url', 'sha256', 'sha512', 'format', 'destination')
    dockerService   = @('dockerd', 'pipeGroup', 'dataRoot')
}
# User rights that would make the worker as strong as an administrator: workerAccount refuses them.
$script:RefusedUserRights = @('SeAssignPrimaryTokenPrivilege', 'SeBackupPrivilege', 'SeCreateTokenPrivilege', 'SeDebugPrivilege', 'SeEnableDelegationPrivilege',
    'SeImpersonatePrivilege', 'SeLoadDriverPrivilege', 'SeManageVolumePrivilege', 'SeRelabelPrivilege', 'SeRestorePrivilege', 'SeSecurityPrivilege',
    'SeSyncAgentPrivilege', 'SeSystemEnvironmentPrivilege', 'SeTakeOwnershipPrivilege', 'SeTcbPrivilege', 'SeTrustedCredManAccessPrivilege')

function Test-ToolchainManifest {
    <# Checks a toolchain manifest (schemaVersion 1) and returns it; throws on the first problem. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $known = @('schemaVersion', 'installers', 'commands', 'steps', 'mcpServers', 'npmRegistry', 'defenderExclusions', 'workerAccount', 'notes')
    foreach ($name in $Manifest.PSObject.Properties.Name) { if ($known -notcontains $name) { throw ('toolchain manifest: unknown field ' + $name) } }
    if (-not (Test-JsonProperty $Manifest 'schemaVersion') -or $Manifest.schemaVersion -ne 1) { throw 'toolchain manifest: schemaVersion must be 1' }
    $names = @{}
    $checkName = {
        param($Value, $Where)
        if ($Value -isnot [string] -or $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw ('toolchain manifest: ' + $Where + ' needs a name of letters, digits, _ . -') }
        if ($names.ContainsKey($Value.ToLowerInvariant())) { throw ('toolchain manifest: the name ' + $Value + ' is used twice') }
        $names[$Value.ToLowerInvariant()] = $true
    }
    $checkStrings = {
        param($Value, $Where)
        foreach ($item in @($Value)) { if ($item -isnot [string]) { throw ('toolchain manifest: ' + $Where + ' must be a list of strings') } }
    }
    $checkCodes = {
        param($Object, $Where)
        if (-not (Test-JsonProperty $Object 'successExitCodes')) { return }
        foreach ($code in @($Object.successExitCodes)) { if ($code -isnot [int] -and $code -isnot [long]) { throw ('toolchain manifest: ' + $Where + ' successExitCodes must be a list of integers') } }
    }
    $checkSha = {
        param($Value, [int]$Length, $Where)
        if ($Value -isnot [string] -or $Value -cnotmatch ('^[0-9a-f]{' + $Length + '}$')) { throw ('toolchain manifest: ' + $Where) }
    }
    $checkNotes = {
        param($Object, $Where)
        if ((Test-JsonProperty $Object 'notes') -and $Object.notes -isnot [string]) { throw ('toolchain manifest: ' + $Where + ': notes must be a string') }
    }
    $checkInstaller = {
        param($Installer, $Where)
        if (-not (Test-JsonProperty $Installer 'url') -or $Installer.url -notmatch '^https://') { throw ('toolchain manifest: ' + $Where + ' needs an https:// url') }
        if (-not (Test-JsonProperty $Installer 'sha256')) { throw ('toolchain manifest: ' + $Where + ' needs a lowercase sha256') }
        & $checkSha $Installer.sha256 64 ($Where + ' needs a lowercase sha256')
        if (-not (Test-JsonProperty $Installer 'type') -or @('exe', 'msi', 'zip') -notcontains $Installer.type) { throw ('toolchain manifest: ' + $Where + ' needs a type: exe, msi or zip') }
        if (Test-JsonProperty $Installer 'arguments') { & $checkStrings $Installer.arguments ($Where + ' arguments') }
        if ($Installer.type -eq 'zip' -and (-not (Test-JsonProperty $Installer 'destination') -or [string]$Installer.destination -notmatch '^[A-Za-z]:\\')) {
            throw ('toolchain manifest: zip ' + $Where + ' needs an absolute destination')
        }
    }
    $hasSteps = Test-JsonProperty $Manifest 'steps'
    if ($hasSteps -and ((Test-JsonProperty $Manifest 'installers') -or (Test-JsonProperty $Manifest 'commands'))) {
        throw 'toolchain manifest: steps replaces installers and commands; list each installer and command as a step'
    }
    if (Test-JsonProperty $Manifest 'installers') {
        foreach ($installer in @($Manifest.installers)) {
            & $checkName $installer.name 'an installer'
            foreach ($field in $installer.PSObject.Properties.Name) {
                if (@('name', 'url', 'sha256', 'type', 'arguments', 'successExitCodes', 'destination', 'addToPath', 'notes') -notcontains $field) { throw ('toolchain manifest: installer ' + $installer.name + ' has an unknown field ' + $field) }
            }
            & $checkInstaller $installer ('installer ' + $installer.name)
            & $checkNotes $installer ('installer ' + $installer.name)
        }
    }
    if (Test-JsonProperty $Manifest 'commands') {
        foreach ($command in @($Manifest.commands)) {
            & $checkName $command.name 'a command'
            if (-not (Test-JsonProperty $command 'command') -or @($command.command).Count -lt 1) { throw ('toolchain manifest: command ' + $command.name + ' needs a command list') }
            & $checkStrings $command.command ('command ' + $command.name)
        }
    }
    if ($hasSteps) {
        if (@($Manifest.steps).Count -eq 0) { throw 'toolchain manifest: steps lists no step' }
        foreach ($step in @($Manifest.steps)) {
            if ($step -isnot [System.Management.Automation.PSCustomObject]) { throw 'toolchain manifest: each step is an object' }
            $kind = $null
            if (Test-JsonProperty $step 'step') { $kind = $step.step }
            if ($kind -isnot [string] -or -not $script:StepFields.Contains($kind)) { throw ('toolchain manifest: every step names its kind in step: ' + (@($script:StepFields.Keys) -join ', ')) }
            $stepName = $null
            if (Test-JsonProperty $step 'name') { $stepName = $step.name }
            & $checkName $stepName ('every ' + $kind + ' step')
            $where = $kind + ' step ' + $stepName
            foreach ($field in $step.PSObject.Properties.Name) {
                if (@('step', 'name', 'notes') -notcontains $field -and $script:StepFields[$kind] -cnotcontains $field) { throw ('toolchain manifest: ' + $where + ' has an unknown field ' + $field) }
            }
            & $checkNotes $step $where
            & $checkCodes $step $where
            switch ($kind) {
                'installer' { & $checkInstaller $step $where }
                'command' {
                    if (-not (Test-JsonProperty $step 'command') -or @($step.command).Count -lt 1) { throw ('toolchain manifest: ' + $where + ' needs a command list') }
                    & $checkStrings $step.command $where
                }
                'windowsFeatures' {
                    if (-not (Test-JsonProperty $step 'features') -or @($step.features).Count -lt 1 -or @($step.features | Where-Object { $_ -isnot [string] -or $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$' }).Count) {
                        throw ('toolchain manifest: ' + $where + ' needs a list of feature names')
                    }
                    if ((Test-JsonProperty $step 'includeManagementTools') -and $step.includeManagementTools -isnot [bool]) { throw ('toolchain manifest: ' + $where + ': includeManagementTools is true or false') }
                }
                'restart' {
                    if ((Test-JsonProperty $step 'reason') -and $step.reason -isnot [string]) { throw ('toolchain manifest: ' + $where + ': reason must be a string') }
                }
                'visualStudio' {
                    # The version is pinned: a fixed-version bootstrapper or a layout, each by its SHA-256, never the
                    # evergreen aka.ms link, which installs whatever is current.
                    if ((Test-JsonProperty $step 'bootstrapper') -eq (Test-JsonProperty $step 'layout')) { throw ('toolchain manifest: ' + $where + ' needs either a bootstrapper or a layout') }
                    if (Test-JsonProperty $step 'bootstrapper') {
                        $source = $step.bootstrapper
                        if ($source -isnot [System.Management.Automation.PSCustomObject] -or @($source.PSObject.Properties.Name | Where-Object { @('url', 'sha256') -cnotcontains $_ }).Count) { throw ('toolchain manifest: ' + $where + ': bootstrapper is { url, sha256 }') }
                        if (-not (Test-JsonProperty $source 'url') -or $source.url -notmatch '^https://') { throw ('toolchain manifest: ' + $where + ' needs an https:// bootstrapper url') }
                        if ($source.url -match '^https://aka\.ms/') { throw ('toolchain manifest: ' + $where + ': aka.ms links to whatever version is current; use the fixed-version bootstrapper of the version to pin, or a layout') }
                        if (-not (Test-JsonProperty $source 'sha256')) { throw ('toolchain manifest: ' + $where + ' needs the bootstrapper''s lowercase sha256') }
                        & $checkSha $source.sha256 64 ($where + ' needs the bootstrapper''s lowercase sha256')
                    } else {
                        $source = $step.layout
                        if ($source -isnot [System.Management.Automation.PSCustomObject] -or @($source.PSObject.Properties.Name | Where-Object { @('path', 'bootstrapper', 'sha256') -cnotcontains $_ }).Count) { throw ('toolchain manifest: ' + $where + ': layout is { path, bootstrapper, sha256 }') }
                        if (-not (Test-JsonProperty $source 'path') -or [string]$source.path -notmatch '^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+|\{manifestDir\})') { throw ('toolchain manifest: ' + $where + ' needs the layout''s absolute path') }
                        if (-not (Test-JsonProperty $source 'bootstrapper') -or $source.bootstrapper -notmatch '^[A-Za-z0-9._-]+\.exe$') { throw ('toolchain manifest: ' + $where + ' needs the file name of the layout''s bootstrapper') }
                        if (-not (Test-JsonProperty $source 'sha256')) { throw ('toolchain manifest: ' + $where + ' needs the layout bootstrapper''s lowercase sha256') }
                        & $checkSha $source.sha256 64 ($where + ' needs the layout bootstrapper''s lowercase sha256')
                    }
                    if (-not (Test-JsonProperty $step 'vsconfig') -or $step.vsconfig -isnot [string] -or $step.vsconfig -notmatch '\.vsconfig$') { throw ('toolchain manifest: ' + $where + ' needs the path of its .vsconfig') }
                    if (-not (Test-JsonProperty $step 'version') -or $step.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw ('toolchain manifest: ' + $where + ' needs the exact version it installs, such as 17.14.7') }
                    if (Test-JsonProperty $step 'arguments') { & $checkStrings $step.arguments ($where + ' arguments') }
                }
                'extendPartition' {
                    if (-not (Test-JsonProperty $step 'driveLetter') -or $step.driveLetter -notmatch '^[A-Za-z]$') { throw ('toolchain manifest: ' + $where + ' needs a driveLetter') }
                }
                'package' {
                    if (-not (Test-JsonProperty $step 'url') -or $step.url -notmatch '^https://') { throw ('toolchain manifest: ' + $where + ' needs an https:// url') }
                    if ((Test-JsonProperty $step 'sha512') -eq (Test-JsonProperty $step 'sha256')) { throw ('toolchain manifest: ' + $where + ' needs either a sha512 or a sha256') }
                    if (Test-JsonProperty $step 'sha512') { & $checkSha $step.sha512 128 ($where + ' needs a lowercase sha512') } else { & $checkSha $step.sha256 64 ($where + ' needs a lowercase sha256') }
                    if (-not (Test-JsonProperty $step 'format') -or @('nupkg', 'zip') -cnotcontains $step.format) { throw ('toolchain manifest: ' + $where + ' needs a format: nupkg or zip') }
                    if (-not (Test-JsonProperty $step 'destination') -or [string]$step.destination -notmatch '^[A-Za-z]:\\[^\\]') { throw ('toolchain manifest: ' + $where + ' needs an absolute destination folder below a drive''s root') }
                }
                'dockerService' {
                    if (-not (Test-JsonProperty $step 'dockerd') -or [string]$step.dockerd -notmatch '^[A-Za-z]:\\.*\\dockerd\.exe$') { throw ('toolchain manifest: ' + $where + ' needs the absolute path of dockerd.exe') }
                    if (-not (Test-JsonProperty $step 'pipeGroup') -or $step.pipeGroup -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') { throw ('toolchain manifest: ' + $where + ' needs the name of the local group that may use the engine''s pipe') }
                    if ((Test-JsonProperty $step 'dataRoot') -and [string]$step.dataRoot -notmatch '^[A-Za-z]:\\') { throw ('toolchain manifest: ' + $where + ': dataRoot must be an absolute folder') }
                }
            }
        }
    }
    if (Test-JsonProperty $Manifest 'mcpServers') {
        foreach ($server in @($Manifest.mcpServers)) {
            & $checkName $server.name 'an MCP server'
            if (-not (Test-JsonProperty $server 'package') -or $server.package -cnotmatch '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$') { throw ('toolchain manifest: MCP server ' + $server.name + ' needs an npm package name') }
            if (-not (Test-JsonProperty $server 'version') -or $server.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw ('toolchain manifest: MCP server ' + $server.name + ' needs an exact version') }
        }
    }
    if ((Test-JsonProperty $Manifest 'npmRegistry') -and $Manifest.npmRegistry -notmatch '^https://') { throw 'toolchain manifest: npmRegistry must be an https:// URL' }
    if (Test-JsonProperty $Manifest 'defenderExclusions') {
        foreach ($field in $Manifest.defenderExclusions.PSObject.Properties.Name) {
            if (@('paths', 'processes') -notcontains $field) { throw ('toolchain manifest: defenderExclusions has an unknown field ' + $field) }
            & $checkStrings $Manifest.defenderExclusions.$field ('defenderExclusions.' + $field)
        }
    }
    if (Test-JsonProperty $Manifest 'workerAccount') {
        # What the worker's own account gets once its service exists: user rights and local groups.
        $account = $Manifest.workerAccount
        if ($account -isnot [System.Management.Automation.PSCustomObject]) { throw 'toolchain manifest: workerAccount is an object' }
        foreach ($field in $account.PSObject.Properties.Name) {
            if (@('userRights', 'groups', 'notes') -cnotcontains $field) { throw ('toolchain manifest: workerAccount has an unknown field ' + $field) }
        }
        & $checkNotes $account 'workerAccount'
        $seen = @{}
        if (Test-JsonProperty $account 'userRights') {
            foreach ($right in @($account.userRights)) {
                if ($right -isnot [string] -or $right -cnotmatch '^Se[A-Za-z]+(Privilege|Right)$') { throw ('toolchain manifest: workerAccount.userRights holds user right names such as SeCreateSymbolicLinkPrivilege, not ' + $right) }
                if ($script:RefusedUserRights -contains $right) { throw ('toolchain manifest: workerAccount may not grant ' + $right + ', which would make the worker as strong as an administrator') }
                if ($seen.ContainsKey('right:' + $right.ToLowerInvariant())) { throw ('toolchain manifest: workerAccount lists ' + $right + ' twice') }
                $seen['right:' + $right.ToLowerInvariant()] = $true
            }
        }
        if (Test-JsonProperty $account 'groups') {
            foreach ($group in @($account.groups)) {
                if ($group -isnot [string] -or $group -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') { throw ('toolchain manifest: workerAccount.groups holds local group names, not ' + $group) }
                if ($seen.ContainsKey('group:' + $group.ToLowerInvariant())) { throw ('toolchain manifest: workerAccount lists the group ' + $group + ' twice') }
                $seen['group:' + $group.ToLowerInvariant()] = $true
            }
        }
    }
    return $Manifest
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Assert-BuildHost {
    if (-not (Test-WindowsHost)) { throw 'the worker image is built on Windows Server 2025' }
    if (-not (Test-IsAdministrator)) { throw 'run Build-WorkerOsImage.ps1 as an administrator' }
    # A new image has no C:\ProgramData\GitHub: one that exists could already hold a policy hook.
    if (Test-Path -LiteralPath 'C:\ProgramData\GitHub') { throw 'C:\ProgramData\GitHub already exists: build the image on a fresh VM' }
    foreach ($file in @($ToolchainManifest, $WorkerSettingsFile)) {
        if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw '-ToolchainManifest and -WorkerSettingsFile are required' }
    }
    if ($SeedManifest -and -not (Test-Path -LiteralPath $SeedManifest -PathType Leaf)) { throw ('missing seed manifest: ' + $SeedManifest) }
    if ($GitConfigFile -and -not (Test-Path -LiteralPath $GitConfigFile -PathType Leaf)) { throw ('missing Git configuration: ' + $GitConfigFile) }
}

function Install-NodeRuntime {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-node-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $work)
    try {
        $name = 'node-v' + $NodeVersion + '-x64.msi'
        $sums = Join-Path $work 'SHASUMS256.txt'
        Invoke-WebRequest -Uri ('https://nodejs.org/dist/v' + $NodeVersion + '/SHASUMS256.txt') -OutFile $sums -UseBasicParsing
        $published = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match ('^([0-9a-f]{64})\s+' + [regex]::Escape($name) + '$') } | ForEach-Object { ($_ -split '\s+')[0] })
        if ($published.Count -ne 1) { throw ('Node.js publishes no SHA-256 for ' + $name) }
        if ($published[0] -ne $NodeMsiSha256) { throw ('Node.js publishes ' + $published[0] + ' for ' + $name + ', not the pinned ' + $NodeMsiSha256) }
        $msi = Join-Path $work $name
        Save-VerifiedDownload -Uri ('https://nodejs.org/dist/v' + $NodeVersion + '/' + $name) -Sha256 $NodeMsiSha256 -Destination $msi
        [void](Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList @('/i', $msi, '/qn', '/norestart') -SuccessExitCode @(0, 3010))
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    $version = (Invoke-NativeCommand -FilePath $script:NodeExe -ArgumentList @('--version')).StdOut.Trim()
    if ($version -ne ('v' + $NodeVersion)) { throw ($script:NodeExe + ' is ' + $version + ', not v' + $NodeVersion) }
    Update-SessionPath
    Write-Host ('Node.js ' + $version + ' installed at ' + $script:NodeExe)
}

function New-WorkerLayout {
    [void](New-Item -ItemType Directory -Force -Path $Root)
    foreach ($folder in ($script:ModifyFolders + $script:ReadOnlyFolders)) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root $folder)) }
    foreach ($file in $script:ServiceFiles) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $Root $file) -Force }
    foreach ($file in $script:VmScripts) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $Root ('scripts\' + $file)) -Force }
    # A checkout that came from a download marks its files; the default execution policy would block the copies.
    foreach ($file in $script:VmScripts) { Unblock-File -LiteralPath (Join-Path $Root ('scripts\' + $file)) }
    if ($SeedManifest) {
        Copy-Item -LiteralPath $SeedManifest -Destination (Join-Path $Root 'seed-manifest.json') -Force
    } else {
        Write-Warning 'No -SeedManifest: Seed-WorkerReposDisk.ps1 -Refresh and -Verify on this image need one at C:\pilotswarm\seed-manifest.json'
    }
    $gitConfig = Join-Path $Root 'gitconfig-global'
    if ($GitConfigFile) {
        Copy-Item -LiteralPath $GitConfigFile -Destination $gitConfig -Force
    } else {
        Write-Utf8File -Path $gitConfig -Content ((@('[core]', '	fsmonitor = false', '	longpaths = true', '[credential]', '	interactive = never') -join "`n") + "`n")
    }
}

function Install-ToolchainInstaller {
    <# Downloads an installer, runs it only when its SHA-256 matches, and returns its exit code. #>
    param([Parameter(Mandatory = $true)]$Installer, [Parameter(Mandatory = $true)][scriptblock]$Expand)
    $leaf = [System.IO.Path]::GetFileName(([uri]$Installer.url).AbsolutePath)
    $file = Join-Path (Join-Path $Root 'toolchain') ($Installer.name + '-' + $leaf)
    Write-Host ('Installing ' + $Installer.name)
    Save-VerifiedDownload -Uri $Installer.url -Sha256 $Installer.sha256 -Destination $file
    $arguments = @()
    if (Test-JsonProperty $Installer 'arguments') { $arguments = @($Installer.arguments | ForEach-Object { & $Expand $_ }) }
    $codes = @(0)
    if (Test-JsonProperty $Installer 'successExitCodes') { $codes = @($Installer.successExitCodes | ForEach-Object { [int]$_ }) }
    $exitCode = 0
    switch ($Installer.type) {
        'exe' { $exitCode = (Invoke-NativeCommand -FilePath $file -ArgumentList $arguments -SuccessExitCode $codes).ExitCode }
        'msi' {
            if (-not (Test-JsonProperty $Installer 'successExitCodes')) { $codes = @(0, 3010) }
            $exitCode = (Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList (@('/i', $file, '/qn', '/norestart') + $arguments) -SuccessExitCode $codes).ExitCode
        }
        'zip' {
            $destination = & $Expand ([string]$Installer.destination)
            [void](New-Item -ItemType Directory -Force -Path $destination)
            Expand-Archive -LiteralPath $file -DestinationPath $destination -Force
            if ((Test-JsonProperty $Installer 'addToPath') -and $Installer.addToPath -eq $true) {
                $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
                if (-not (($machine -split ';') -contains $destination)) { [Environment]::SetEnvironmentVariable('Path', ($machine.TrimEnd(';') + ';' + $destination), 'Machine') }
            }
        }
    }
    Remove-Item -LiteralPath $file -Force
    Update-SessionPath
    return $exitCode
}

function Invoke-ToolchainCommand {
    <# Runs a command (a program and its arguments, no shell) and returns its exit code. #>
    param([Parameter(Mandatory = $true)]$Command, [Parameter(Mandatory = $true)][scriptblock]$Expand)
    Write-Host ('Running ' + $Command.name)
    $parts = @($Command.command | ForEach-Object { & $Expand $_ })
    $codes = @(0)
    if (Test-JsonProperty $Command 'successExitCodes') { $codes = @($Command.successExitCodes | ForEach-Object { [int]$_ }) }
    $rest = @()
    if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    $exitCode = (Invoke-NativeCommand -FilePath $parts[0] -ArgumentList $rest -SuccessExitCode $codes).ExitCode
    Update-SessionPath
    return $exitCode
}

function Install-WorkerWindowsFeature {
    <# Installs Windows features (Install-WindowsFeature); returns whether Windows needs a restart to finish. #>
    param([Parameter(Mandatory = $true)]$Step)
    $arguments = @{ Name = @($Step.features) }
    if ((Test-JsonProperty $Step 'includeManagementTools') -and $Step.includeManagementTools -eq $true) { $arguments['IncludeManagementTools'] = $true }
    Write-Host ('Installing the Windows features ' + (@($Step.features) -join ', '))
    $result = Install-WindowsFeature @arguments
    if (-not $result.Success) { throw ('Install-WindowsFeature failed for ' + (@($Step.features) -join ', ')) }
    return ([string]$result.RestartNeeded -ne 'No')
}

function Get-VisualStudioInstance {
    <# The installed Visual Studio whose display version (such as 17.14.7) or installation version (all four parts) is Version, from vswhere; $null when none is. #>
    param([Parameter(Mandatory = $true)][string]$Version)
    if (-not (Test-Path -LiteralPath $script:VsWhere -PathType Leaf)) { return $null }
    $listed = Invoke-NativeCommand -FilePath $script:VsWhere -ArgumentList @('-all', '-prerelease', '-products', '*', '-format', 'json', '-utf8')
    # Assigned first: Windows PowerShell 5.1's ConvertFrom-Json writes a JSON array as one object.
    $instances = $listed.StdOut | ConvertFrom-Json
    foreach ($instance in @($instances)) {
        $display = $null
        if ((Test-JsonProperty $instance 'catalog') -and (Test-JsonProperty $instance.catalog 'productDisplayVersion')) { $display = [string]$instance.catalog.productDisplayVersion }
        if ([string]$instance.installationVersion -eq $Version -or $display -eq $Version) { return $instance }
    }
    return $null
}

function Install-VisualStudio {
    <#
    Installs Visual Studio at the version the step pins: from a fixed-version bootstrapper or a layout, each checked by
    its SHA-256, with the step's .vsconfig; then vswhere must list that version. Returns the exit code and the instance.
    #>
    param([Parameter(Mandatory = $true)]$Step, [Parameter(Mandatory = $true)][scriptblock]$Expand)
    $config = & $Expand ([string]$Step.vsconfig)
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw ('the ' + $Step.name + ' step''s .vsconfig is missing: ' + $config) }
    $arguments = @('--quiet', '--wait', '--norestart', '--nocache', '--config', $config)
    $downloaded = $null
    if (Test-JsonProperty $Step 'layout') {
        $bootstrapper = Join-Path (& $Expand ([string]$Step.layout.path)) ([string]$Step.layout.bootstrapper)
        if (-not (Test-Path -LiteralPath $bootstrapper -PathType Leaf)) { throw ('the layout has no ' + $bootstrapper) }
        $actual = Get-Sha256Hex $bootstrapper
        if ($actual -ne $Step.layout.sha256) { throw ('SHA-256 mismatch for ' + $bootstrapper + ': got ' + $actual + ', pinned ' + $Step.layout.sha256) }
        $arguments += '--noWeb'
    } else {
        $leaf = [System.IO.Path]::GetFileName(([uri]$Step.bootstrapper.url).AbsolutePath)
        $bootstrapper = Join-Path (Join-Path $Root 'toolchain') ($Step.name + '-' + $leaf)
        Save-VerifiedDownload -Uri $Step.bootstrapper.url -Sha256 $Step.bootstrapper.sha256 -Destination $bootstrapper
        $downloaded = $bootstrapper
    }
    if (Test-JsonProperty $Step 'arguments') { $arguments += @($Step.arguments | ForEach-Object { & $Expand $_ }) }
    $codes = @(0, 3010)
    if (Test-JsonProperty $Step 'successExitCodes') { $codes = @($Step.successExitCodes | ForEach-Object { [int]$_ }) }
    Write-Host ('Installing Visual Studio ' + $Step.version + ' (' + $Step.name + ')')
    $result = Invoke-NativeCommand -FilePath $bootstrapper -ArgumentList $arguments -SuccessExitCode $codes -TimeoutSeconds 14400
    if ($downloaded) { Remove-Item -LiteralPath $downloaded -Force }
    $instance = Get-VisualStudioInstance -Version $Step.version
    if (-not $instance) { throw ('vswhere lists no Visual Studio ' + $Step.version + ' after the ' + $Step.name + ' step') }
    Update-SessionPath
    return [pscustomobject]@{ ExitCode = $result.ExitCode; InstallationVersion = [string]$instance.installationVersion }
}

function Resize-PartitionToMaximum {
    <# Grows the partition behind a drive letter to all the space its disk has after it; returns its size. #>
    param([Parameter(Mandatory = $true)][string]$DriveLetter)
    $supported = Get-PartitionSupportedSize -DriveLetter $DriveLetter
    $size = (Get-Partition -DriveLetter $DriveLetter).Size
    # Less than 1 MB to gain is alignment, not free space.
    if (($supported.SizeMax - $size) -ge 1MB) {
        Write-Host ('Extending ' + $DriveLetter + ': from ' + $size + ' to ' + $supported.SizeMax + ' bytes')
        Resize-Partition -DriveLetter $DriveLetter -Size $supported.SizeMax
        $size = (Get-Partition -DriveLetter $DriveLetter).Size
    }
    return $size
}

function Expand-PackageArchive {
    <#
    Extracts a zip, or a NuGet package without its packaging parts ([Content_Types].xml, _rels/, package/) and with its
    entry names unescaped as NuGet does, into Destination. An entry whose path would leave Destination stops it.
    #>
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Destination, [Parameter(Mandatory = $true)][ValidateSet('nupkg', 'zip')][string]$Format)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $folder = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    [void](New-Item -ItemType Directory -Force -Path $folder)
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($Format -eq 'nupkg') {
                if ($name -eq '[Content_Types].xml' -or $name.StartsWith('_rels/') -or $name.StartsWith('package/')) { continue }
                $name = [System.Uri]::UnescapeDataString($name)
            }
            $target = [System.IO.Path]::GetFullPath($folder + $name.Replace('/', '\'))
            if ($name.StartsWith('/') -or $name.Contains(':') -or -not $target.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase)) {
                throw ($Path + ' has an entry outside its folder: ' + $entry.FullName)
            }
            if ($name.EndsWith('/')) {
                [void](New-Item -ItemType Directory -Force -Path $target)
                continue
            }
            [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally {
        $archive.Dispose()
    }
}

function Install-ToolchainPackage {
    <# Downloads a package, checks its SHA-512 or SHA-256, and extracts it into its destination. #>
    param([Parameter(Mandatory = $true)]$Step, [Parameter(Mandatory = $true)][scriptblock]$Expand)
    $file = Join-Path (Join-Path $Root 'toolchain') ($Step.name + '.' + $Step.format)
    $destination = & $Expand ([string]$Step.destination)
    Write-Host ('Extracting the package ' + $Step.name + ' into ' + $destination)
    if (Test-JsonProperty $Step 'sha512') { Save-VerifiedDownload -Uri $Step.url -Sha512 $Step.sha512 -Destination $file }
    else { Save-VerifiedDownload -Uri $Step.url -Sha256 $Step.sha256 -Destination $file }
    try {
        Expand-PackageArchive -Path $file -Destination $destination -Format $Step.format
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-NetLocalGroup {
    <# net.exe localgroup ..., which every Windows has, in either PowerShell. #>
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$NoThrow)
    return (Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\net.exe') -ArgumentList (@('localgroup') + $Arguments) -NoThrow:$NoThrow)
}

function Register-DockerService {
    <#
    Registers dockerd as the docker service, its named pipe open to the members of the step's local group, which it
    creates when missing. It does not start the engine: an image carries no engine state, and the service starts at
    the VM's next start.
    #>
    param([Parameter(Mandatory = $true)]$Step)
    $dockerd = [string]$Step.dockerd
    if (-not (Test-Path -LiteralPath $dockerd -PathType Leaf)) { throw ('the ' + $Step.name + ' step finds no ' + $dockerd + '; install it in an earlier step') }
    if ((Invoke-NetLocalGroup -Arguments @($Step.pipeGroup) -NoThrow).ExitCode -ne 0) {
        Write-Host ('Creating the local group ' + $Step.pipeGroup)
        [void](Invoke-NetLocalGroup -Arguments @($Step.pipeGroup, '/add'))
    }
    if (Get-Service -Name 'docker' -ErrorAction SilentlyContinue) {
        Stop-Service -Name 'docker' -Force -ErrorAction SilentlyContinue
        [void](Invoke-NativeCommand -FilePath $dockerd -ArgumentList @('--unregister-service'))
    }
    $arguments = @('--register-service', '--group', [string]$Step.pipeGroup)
    if (Test-JsonProperty $Step 'dataRoot') { $arguments += @('--data-root', [string]$Step.dataRoot) }
    Write-Host ('Registering the docker service for the group ' + $Step.pipeGroup)
    [void](Invoke-NativeCommand -FilePath $dockerd -ArgumentList $arguments)
    if (-not (Get-Service -Name 'docker' -ErrorAction SilentlyContinue)) { throw ($dockerd + ' --register-service left no docker service') }
}

function Invoke-ToolchainStep {
    <# Runs one step that is not a restart; returns its record for image-versions.json and whether Windows asked for a restart. #>
    param([Parameter(Mandatory = $true)]$Step, [Parameter(Mandatory = $true)][scriptblock]$Expand)
    $record = [ordered]@{ name = $Step.name; step = $Step.step }
    $restart = $false
    switch ($Step.step) {
        'installer' {
            $restart = (Install-ToolchainInstaller -Installer $Step -Expand $Expand) -eq 3010
            $record['url'] = $Step.url
            $record['sha256'] = $Step.sha256
        }
        'command' { $restart = (Invoke-ToolchainCommand -Command $Step -Expand $Expand) -eq 3010 }
        'windowsFeatures' {
            $restart = Install-WorkerWindowsFeature -Step $Step
            $record['features'] = @($Step.features)
        }
        'visualStudio' {
            $installed = Install-VisualStudio -Step $Step -Expand $Expand
            $restart = $installed.ExitCode -eq 3010
            $record['version'] = $Step.version
            $record['installationVersion'] = $installed.InstallationVersion
            if (Test-JsonProperty $Step 'layout') { $record['layoutBootstrapperSha256'] = $Step.layout.sha256 } else { $record['url'] = $Step.bootstrapper.url; $record['sha256'] = $Step.bootstrapper.sha256 }
        }
        'extendPartition' {
            $record['driveLetter'] = $Step.driveLetter
            $record['size'] = Resize-PartitionToMaximum -DriveLetter $Step.driveLetter
        }
        'package' {
            Install-ToolchainPackage -Step $Step -Expand $Expand
            $record['url'] = $Step.url
            if (Test-JsonProperty $Step 'sha512') { $record['sha512'] = $Step.sha512 } else { $record['sha256'] = $Step.sha256 }
            $record['destination'] = & $Expand ([string]$Step.destination)
        }
        'dockerService' {
            Register-DockerService -Step $Step
            $record['pipeGroup'] = $Step.pipeGroup
        }
        default { throw ('the ' + $Step.name + ' step is a ' + $Step.step + ' step, which runs on its own') }
    }
    return [pscustomobject]@{ Record = $record; RestartNeeded = [bool]$restart }
}

# Builds that stop for a restart.

function Get-BuildStatePath { return (Join-Path $Root 'toolchain\image-build-state.json') }

function New-BuildState { return [pscustomobject]@{ schemaVersion = 1; done = @(); restart = $null; restartPending = $false; records = [pscustomobject]@{} } }

function Read-BuildState {
    <# What an earlier run of a manifest with steps finished, before it stopped for a restart or failed; a new state otherwise. #>
    $path = Get-BuildStatePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return (New-BuildState) }
    $state = Read-JsonFile -Path $path
    if (-not (Test-JsonProperty $state 'schemaVersion') -or $state.schemaVersion -ne 1) { throw ($path + ' comes from another version of this script; delete it to start over') }
    return $state
}

function Save-BuildState {
    param([Parameter(Mandatory = $true)]$State)
    Write-Utf8File -Path (Get-BuildStatePath) -Content (ConvertTo-Json -InputObject $State -Depth 8)
}

function Add-BuildStateDone {
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Key)
    $State.done = @(@($State.done) + $Key)
    Save-BuildState $State
}

function Get-StepKey {
    <# A step's name and the SHA-256 of its definition: a step that changed since an earlier run runs again. #>
    param([Parameter(Mandatory = $true)]$Step)
    return ('step:' + $Step.name + ':' + (Get-StringSha256Hex (ConvertTo-Json -InputObject $Step -Compress -Depth 10)))
}

function Get-LastBootTime {
    <# When Windows last started: a restart the build asked for changes it. #>
    return (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
}

function Test-PendingRestart {
    <# Whether Windows waits for a restart to finish servicing components, which Sysprep would not do. #>
    return (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
}

function Complete-BuildRestart {
    <#
    At a restart point (Key): $null once the VM has restarted since the build stopped there, which marks the point
    done; otherwise the build stops there (again) and this returns why.
    #>
    param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$Key, [Parameter(Mandatory = $true)][string]$Reason)
    if ($null -ne $State.restart -and $State.restart.key -eq $Key) {
        if ($State.restart.bootTime -ne (Get-LastBootTime)) {
            Write-Host ('The VM restarted: ' + $State.restart.reason)
            $State.restart = $null
            $State.restartPending = $false
            Add-BuildStateDone -State $State -Key $Key
            return $null
        }
        return ('the VM has not restarted yet. ' + $State.restart.reason)
    }
    $State.restart = [pscustomobject]@{ key = $Key; bootTime = (Get-LastBootTime); reason = $Reason }
    Save-BuildState $State
    return $Reason
}

function Install-ToolchainSteps {
    <#
    The manifest's steps in order. A step finished by an earlier run with the same definition is skipped. A restart
    step stops the build until the VM has restarted; so does the end of the steps when a step asked for a restart.
    Returns why the build stops, or $null.
    #>
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][scriptblock]$Expand, [Parameter(Mandatory = $true)]$State)
    foreach ($step in @($Manifest.steps)) {
        $key = Get-StepKey $step
        if (@($State.done) -contains $key) {
            Write-Host ('Done in an earlier run: ' + $step.name)
            continue
        }
        if ($step.step -eq 'restart') {
            $reason = 'the ' + $step.name + ' step restarts the VM'
            if (Test-JsonProperty $step 'reason') { $reason += ': ' + $step.reason }
            $stop = Complete-BuildRestart -State $State -Key $key -Reason $reason
            if ($stop) { return $stop }
            $State.records | Add-Member -NotePropertyName $step.name -NotePropertyValue ([ordered]@{ name = $step.name; step = 'restart' }) -Force
            Save-BuildState $State
            continue
        }
        Write-Host ('Step ' + $step.name + ' (' + $step.step + ')')
        $outcome = Invoke-ToolchainStep -Step $step -Expand $Expand
        if ($outcome.RestartNeeded) {
            # Even when an earlier run already restarted before the services, this step's restart is still to come.
            $State.restartPending = $true
            $State.done = @(@($State.done) | Where-Object { $_ -ne 'restart:before-services' })
        }
        $State.records | Add-Member -NotePropertyName $step.name -NotePropertyValue $outcome.Record -Force
        Add-BuildStateDone -State $State -Key $key
    }
    return $null
}

function Install-Toolchain {
    <# The toolchain manifest's installers and commands, or its steps, then its MCP servers and Defender exclusions; returns the record and why the build stops, if it does. #>
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestDir, $State)
    $record = [ordered]@{ installers = @(); commands = @(); mcpServers = @() }
    $expand = { param([string]$Value) $Value.Replace('{manifestDir}', $ManifestDir) }
    if (Test-JsonProperty $Manifest 'installers') {
        foreach ($installer in @($Manifest.installers)) {
            [void](Install-ToolchainInstaller -Installer $installer -Expand $expand)
            $record.installers += [ordered]@{ name = $installer.name; url = $installer.url; sha256 = $installer.sha256 }
        }
    }
    if (Test-JsonProperty $Manifest 'commands') {
        foreach ($command in @($Manifest.commands)) {
            [void](Invoke-ToolchainCommand -Command $command -Expand $expand)
            $record.commands += $command.name
        }
    }
    if (Test-JsonProperty $Manifest 'steps') {
        $stop = Install-ToolchainSteps -Manifest $Manifest -Expand $expand -State $State
        if ($stop) { return [pscustomobject]@{ Record = $record; Stop = $stop } }
        $record['steps'] = @($Manifest.steps | ForEach-Object { $State.records.($_.name) })
    }
    if (Test-JsonProperty $Manifest 'mcpServers') {
        $npm = Join-Path (Split-Path -Parent $script:NodeExe) 'npm.cmd'
        $registry = ''
        if (Test-JsonProperty $Manifest 'npmRegistry') { $registry = [string]$Manifest.npmRegistry }
        foreach ($server in @($Manifest.mcpServers)) {
            $record.mcpServers += [ordered]@{ name = $server.name; package = $server.package; version = $server.version }
            $key = 'mcp:' + $server.name + ':' + (Get-StringSha256Hex -Text ((ConvertTo-Json -InputObject $server -Compress -Depth 5) + $registry))
            if ($State -and @($State.done) -contains $key) { continue }
            # Installed once here, so no session downloads an MCP server with npx at run time.
            $prefix = Join-Path $Root ('mcp\' + $server.name)
            [void](New-Item -ItemType Directory -Force -Path $prefix)
            $arguments = @('install', '--prefix', $prefix, '--no-audit', '--no-fund', '--omit=dev', '--save-exact')
            if (-not ((Test-JsonProperty $server 'ignoreScripts') -and $server.ignoreScripts -eq $false)) { $arguments += '--ignore-scripts' }
            if (Test-JsonProperty $Manifest 'npmRegistry') { $arguments += @('--registry', $Manifest.npmRegistry) }
            $arguments += ($server.package + '@' + $server.version)
            Write-Host ('Installing the MCP server ' + $server.name + ' (' + $server.package + '@' + $server.version + ')')
            [void](Invoke-NativeCommand -FilePath $npm -ArgumentList $arguments -WorkingDirectory $prefix)
            if ($State) { Add-BuildStateDone -State $State -Key $key }
        }
    }
    if (Test-JsonProperty $Manifest 'defenderExclusions') {
        $exclusions = $Manifest.defenderExclusions
        if (Get-Command -Name Add-MpPreference -ErrorAction SilentlyContinue) {
            if (Test-JsonProperty $exclusions 'paths') { foreach ($path in @($exclusions.paths)) { Add-MpPreference -ExclusionPath $path } }
            if (Test-JsonProperty $exclusions 'processes') { foreach ($process in @($exclusions.processes)) { Add-MpPreference -ExclusionProcess $process } }
        } else {
            Write-Warning 'Microsoft Defender is not installed: the manifest''s Defender exclusions are skipped'
        }
    }
    if ($State) {
        # Before the services and Sysprep: a step that asked for a restart, or Windows still finishing one, gets it here.
        $key = 'restart:before-services'
        if (@($State.done) -notcontains $key -and ($State.restartPending -or (Test-PendingRestart) -or ($null -ne $State.restart -and $State.restart.key -eq $key))) {
            $stop = Complete-BuildRestart -State $State -Key $key -Reason 'a step asked for a restart, which the VM needs before its services and Sysprep'
            if ($stop) { return [pscustomobject]@{ Record = $record; Stop = $stop } }
        }
    }
    return [pscustomobject]@{ Record = $record; Stop = $null }
}

function Install-WorkerServices {
    $winsw = Join-Path $Root ('toolchain\WinSW-' + $WinSWVersion + '.exe')
    Save-VerifiedDownload -Uri ('https://github.com/winsw/winsw/releases/download/v' + $WinSWVersion + '/WinSW.NET461.exe') -Sha256 $WinSWSha256 -Destination $winsw
    & (Join-Path $PSScriptRoot 'Install-WinWorkerService.ps1') -WorkerSettingsFile $WorkerSettingsFile -Root $Root -NodeExe $script:NodeExe -WinSWExe $winsw
    Remove-Item -LiteralPath $winsw -Force
}

function Invoke-SecEdit {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    [void](Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\secedit.exe') -ArgumentList $Arguments)
}

function Get-UserRightAccounts {
    <# The accounts a secedit export lists for one user right (*SID, or a name), in its [Privilege Rights] section. #>
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$InfText, [Parameter(Mandatory = $true)][string]$Right)
    $section = ''
    foreach ($line in ($InfText -split "`r?`n")) {
        $text = $line.Trim()
        if ($text -match '^\[(.+)\]$') {
            $section = $Matches[1]
            continue
        }
        $eq = $text.IndexOf('=')
        if ($section -ne 'Privilege Rights' -or $eq -le 0 -or $text.Substring(0, $eq).Trim() -ne $Right) { continue }
        return @($text.Substring($eq + 1).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    return @()
}

function New-UserRightsTemplate {
    <# A security template that sets each right in Rights (right -> accounts) and nothing else, for secedit /configure. #>
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Rights)
    $lines = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]')
    foreach ($right in $Rights.Keys) { $lines += ($right + ' = ' + (@($Rights[$right]) -join ',')) }
    return (($lines -join "`r`n") + "`r`n")
}

function Get-LocalGroupSid {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        return (New-Object System.Security.Principal.NTAccount $Name).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        throw ('the local group ' + $Name + ' does not exist; a step must create it first')
    }
}

function Test-LocalGroupMember {
    param([Parameter(Mandatory = $true)][string]$Group, [Parameter(Mandatory = $true)][string]$Account)
    $listed = Invoke-NetLocalGroup -Arguments @($Group)
    return [bool]@(($listed.StdOut -split "`r?`n") | Where-Object { $_.Trim() -ieq $Account }).Count
}

function Grant-WorkerAccount {
    <#
    The manifest's workerAccount, once the worker's service (and with it its account) exists: each user right goes to
    the worker's SID alone (secedit), and the account joins each local group (net localgroup), never a built-in one.
    The service gets both with its next token, at its first start on a VM. Returns what it granted.
    #>
    param([Parameter(Mandatory = $true)]$Settings)
    $sid = Get-WorkerServiceSid
    $account = (New-Object System.Security.Principal.SecurityIdentifier $sid).Translate([System.Security.Principal.NTAccount]).Value
    $record = [ordered]@{ userRights = @(); groups = @() }
    if (Test-JsonProperty $Settings 'userRights') { $record.userRights = @($Settings.userRights) }
    if (Test-JsonProperty $Settings 'groups') { $record.groups = @($Settings.groups) }
    $holds = { param([string]$Text, [string]$Right) [bool]@(Get-UserRightAccounts -InfText $Text -Right $Right | Where-Object { $_ -eq ('*' + $sid) -or $_ -ieq $account }).Count }
    if ($record.userRights.Count) {
        $work = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-rights-' + [guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $work)
        try {
            $export = Join-Path $work 'export.inf'
            Invoke-SecEdit -Arguments @('/export', '/cfg', $export, '/areas', 'USER_RIGHTS')
            $text = [System.IO.File]::ReadAllText($export)
            $changes = [ordered]@{}
            foreach ($right in $record.userRights) {
                if (-not (& $holds $text $right)) { $changes[$right] = @(@(Get-UserRightAccounts -InfText $text -Right $right) + ('*' + $sid)) }
            }
            if ($changes.Count) {
                Write-Host ('Granting the worker ' + (@($changes.Keys) -join ', '))
                $template = Join-Path $work 'rights.inf'
                [System.IO.File]::WriteAllText($template, (New-UserRightsTemplate -Rights $changes), [System.Text.Encoding]::Unicode)
                Invoke-SecEdit -Arguments @('/configure', '/db', (Join-Path $work 'rights.sdb'), '/cfg', $template, '/areas', 'USER_RIGHTS', '/quiet')
                Invoke-SecEdit -Arguments @('/export', '/cfg', $export, '/areas', 'USER_RIGHTS')
                $text = [System.IO.File]::ReadAllText($export)
                foreach ($right in $changes.Keys) { if (-not (& $holds $text $right)) { throw ('secedit did not give the worker ' + $right) } }
            }
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($group in $record.groups) {
        # By SID, which every Windows language shares: BUILTIN groups (Administrators, Hyper-V Administrators, ...) are refused.
        if ((Get-LocalGroupSid -Name $group) -match '^S-1-5-32-') { throw ('workerAccount: ' + $group + ' is a built-in group, which the worker never joins') }
        if (Test-LocalGroupMember -Group $group -Account $account) { continue }
        Write-Host ('Adding the worker to the local group ' + $group)
        [void](Invoke-NetLocalGroup -Arguments @($group, $account, '/add'))
        if (-not (Test-LocalGroupMember -Group $group -Account $account)) { throw ('the worker is still not in the local group ' + $group) }
    }
    return $record
}

function Set-CrashDumpPolicy {
    # Local dump collection works on its own, even with reporting disabled: no LocalDumps key may exist.
    $wer = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting'
    if (-not (Test-Path -LiteralPath $wer)) { [void](New-Item -Path $wer -Force) }
    [void](New-ItemProperty -Path $wer -Name 'Disabled' -PropertyType DWord -Value 1 -Force)
    foreach ($key in @(($wer + '\LocalDumps'), 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\Windows Error Reporting\LocalDumps')) {
        if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
    if ((Get-ItemProperty -LiteralPath $wer -Name 'Disabled').Disabled -ne 1) { throw 'Windows Error Reporting is still enabled' }
    # Release folders hold deep node_modules paths.
    [void](New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -PropertyType DWord -Value 1 -Force)
}

function Set-ReadOnlyGuard {
    <# An administrator-owned folder that everyone else can only read. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $system = '*' + (Get-WellKnownSid System)
    $admins = '*' + (Get-WellKnownSid Administrators)
    $users = '*' + (Get-WellKnownSid Users)
    Invoke-Icacls -Path $Path -Arguments @('/inheritance:r', '/grant:r', ($system + ':(OI)(CI)(F)'), ($admins + ':(OI)(CI)(F)'), ($users + ':(OI)(CI)(RX)'))
    Invoke-Icacls -Path $Path -Arguments @('/setowner', $admins)
}

function Get-CopilotHomePlaceholderText {
    <# A file placeholder's contents: what the Copilot CLI reads as no configuration at all. #>
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($script:CopilotHomeFileText.Contains($Name)) { return $script:CopilotHomeFileText[$Name] }
    if ($Name.EndsWith('.json')) { return '{}' }
    return ''
}

function New-CopilotHomePlaceholders {
    <#
    The placeholders and the two settings files in the Copilot CLI home, Folder,
    without their access lists: a file the image created keeps its contents.
    #>
    param([Parameter(Mandatory = $true)][string]$Folder)
    $text = Get-CopilotSettingsText
    Write-Utf8File -Path (Join-Path $Folder 'settings.json') -Content $text.Settings
    Write-Utf8File -Path (Join-Path $Folder 'config.json') -Content $text.Config
    foreach ($name in $CopilotHomeFiles) {
        $file = Join-Path $Folder $name
        if (-not (Test-Path -LiteralPath $file)) { Write-Utf8File -Path $file -Content (Get-CopilotHomePlaceholderText -Name $name) }
    }
    foreach ($name in $CopilotHomeFolders) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $Folder $name)) }
}

function Set-CopilotHomePlaceholders {
    <#
    Read-Only, Deny-Delete placeholders for what the Copilot CLI reads from its
    home, so no session can plant instructions, MCP servers, language servers,
    tool approvals, model providers, MCP credentials, skills, agents,
    extensions, plugins, hook files or settings for later sessions. The worker
    can still read each one: the CLI takes a providers.json it cannot read for
    a broken file, not a missing one.
    #>
    $copilot = Join-Path $Root 'copilot'
    $svc = '*' + (Get-WorkerServiceSid)
    $system = '*' + (Get-WellKnownSid System)
    $admins = '*' + (Get-WellKnownSid Administrators)
    New-CopilotHomePlaceholders -Folder $copilot
    foreach ($name in (@('settings.json', 'config.json') + $CopilotHomeFiles)) {
        $file = Join-Path $copilot $name
        Invoke-Icacls -Path $file -Arguments @('/inheritance:r', '/grant:r', ($system + ':(F)'), ($admins + ':(F)'), ($svc + ':(RX)'))
        Invoke-Icacls -Path $file -Arguments @('/deny', ($svc + ':(DE)'))
    }
    foreach ($name in $CopilotHomeFolders) {
        $folder = Join-Path $copilot $name
        Invoke-Icacls -Path $folder -Arguments @('/inheritance:r', '/grant:r', ($system + ':(OI)(CI)(F)'), ($admins + ':(OI)(CI)(F)'), ($svc + ':(OI)(CI)(RX)'))
        Invoke-Icacls -Path $folder -Arguments @('/deny', ($svc + ':(DE)'))
    }
}

function Set-FolderLockdown {
    $svc = '*' + (Get-WorkerServiceSid)
    $system = '*' + (Get-WellKnownSid System)
    $admins = '*' + (Get-WellKnownSid Administrators)
    $users = '*' + (Get-WellKnownSid Users)
    $authenticated = '*' + (Get-WellKnownSid AuthenticatedUsers)
    $creatorOwner = '*' + (Get-WellKnownSid CreatorOwner)

    # C:\: no folder creation or appending for ordinary accounts; read and run only.
    Invoke-Icacls -Path 'C:\' -Arguments @('/remove:g', $users, $authenticated, $creatorOwner)
    Invoke-Icacls -Path 'C:\' -Arguments @('/grant:r', ($users + ':(OI)(CI)(RX)'), ($authenticated + ':(OI)(CI)(RX)'))
    # A session cannot create C:\node_modules, and the image keeps an administrator-owned, Read-Only one there anyway.
    [void](New-Item -ItemType Directory -Force -Path 'C:\node_modules')
    Set-ReadOnlyGuard -Path 'C:\node_modules'

    # C:\pilotswarm: Read+Execute for the worker, Modify only on its writable folders.
    Invoke-Icacls -Path $Root -Arguments @('/inheritance:r', '/grant:r', ($system + ':(OI)(CI)(F)'), ($admins + ':(OI)(CI)(F)'), ($svc + ':(OI)(CI)(RX)'))
    foreach ($folder in $script:ModifyFolders) { Invoke-Icacls -Path (Join-Path $Root $folder) -Arguments @('/grant', ($svc + ':(OI)(CI)(M)')) }
    Set-CopilotHomePlaceholders

    # Machine-wide policy hooks: C:\ProgramData lets every user create folders, so the image owns these first.
    $github = 'C:\ProgramData\GitHub'
    if (Test-Path -LiteralPath $github) { throw 'C:\ProgramData\GitHub already exists: build the image on a fresh VM' }
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $github 'Copilot\policy.d'))
    Set-ReadOnlyGuard -Path $github
    # Git for Windows reads machine-wide configuration from C:\ProgramData\Git\config.
    [void](New-Item -ItemType Directory -Force -Path 'C:\ProgramData\Git')
    Set-ReadOnlyGuard -Path 'C:\ProgramData\Git'
}

function Test-TopLevelFolder {
    <# Every top-level folder on C:\ that an ordinary account or the worker could create or change entries in; throws unless allowed. #>
    $writeRights = [System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
    $principals = @((Get-WellKnownSid Users), (Get-WellKnownSid AuthenticatedUsers), (Get-WellKnownSid Everyone), (Get-WellKnownSid Interactive), (Get-WellKnownSid CreatorOwner), (Get-WorkerServiceSid))
    $problems = @()
    foreach ($folder in Get-ChildItem -LiteralPath 'C:\' -Directory -Force) {
        $acl = Get-Acl -LiteralPath $folder.FullName
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne 'Allow') { continue }
            if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
            if ($principals -notcontains $rule.IdentityReference.Value) { continue }
            if (($rule.FileSystemRights -band $writeRights) -eq 0) { continue }
            $line = $folder.Name + ': ' + $rule.IdentityReference.Value + ' ' + $rule.FileSystemRights
            if ($TopLevelWritableAllowlist -contains $folder.Name) { Write-Host ('Allowed: ' + $line) } else { $problems += $line }
        }
    }
    if ($problems.Count) { throw ('top-level folders on C:\ that sessions could write: ' + ($problems -join '; ')) }
}

function Disable-RemoteAccessFirewallRule {
    # Resource names, which do not depend on the Windows language, and the English display groups.
    $groups = @('@FirewallAPI.dll,-28752', '@FirewallAPI.dll,-30267', '@FirewallAPI.dll,-28502')
    $displayGroups = @('Remote Desktop', 'Windows Remote Management', 'File and Printer Sharing')
    $rules = @(Get-NetFirewallRule | Where-Object { ($groups -contains $_.Group) -or ($displayGroups -contains $_.DisplayGroup) })
    $rules | Disable-NetFirewallRule
    $left = @(Get-NetFirewallRule | Where-Object { (($groups -contains $_.Group) -or ($displayGroups -contains $_.DisplayGroup)) -and $_.Enabled -eq 'True' })
    if ($left.Count) { throw ('firewall rules still enabled: ' + (($left | ForEach-Object { $_.DisplayName }) -join ', ')) }
    Write-Host ('Disabled ' + $rules.Count + ' remote access firewall rule(s)')
}

function Invoke-Generalize {
    foreach ($agent in @('RdAgent', 'WindowsAzureGuestAgent')) {
        $service = Get-Service -Name $agent -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Running') { throw ('the Azure agent service ' + $agent + ' is not running; generalizing now would break provisioning') }
    }
    $panther = Join-Path $env:SystemRoot 'Panther'
    if (Test-Path -LiteralPath $panther) { Remove-Item -LiteralPath $panther -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host 'Generalizing: Sysprep shuts the VM down; capture it as the next image version'
    & (Join-Path $env:SystemRoot 'System32\Sysprep\Sysprep.exe') /generalize /oobe /mode:vm /quiet /shutdown
}

function Invoke-Main {
    Assert-BuildHost
    $manifest = Test-ToolchainManifest (Read-JsonFile -Path $ToolchainManifest)
    # The worker settings are checked before anything is installed.
    $check = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-settings-' + [guid]::NewGuid().ToString('N'))
    try {
        & (Join-Path $PSScriptRoot 'Install-WinWorkerService.ps1') -WorkerSettingsFile $WorkerSettingsFile -Root $check -ConfigurationOnly | Out-Null
    } finally {
        Remove-Item -LiteralPath $check -Recurse -Force -ErrorAction SilentlyContinue
    }

    # A manifest with steps can stop for a restart; the same command then carries on where it stopped.
    $state = $null
    if (Test-JsonProperty $manifest 'steps') { $state = Read-BuildState }
    $nodeKey = 'node:' + $NodeVersion + ':' + $NodeMsiSha256
    if ($state -and @($state.done) -contains $nodeKey) {
        Update-SessionPath
    } else {
        Install-NodeRuntime
        if ($state) { Add-BuildStateDone -State $state -Key $nodeKey }
    }
    New-WorkerLayout
    $toolchain = Install-Toolchain -Manifest $manifest -ManifestDir (Split-Path -Parent (Resolve-Path -LiteralPath $ToolchainManifest).ProviderPath) -State $state
    if ($toolchain.Stop) {
        Write-Host ('Stopped for a restart: ' + $toolchain.Stop + '. Restart the VM, then run the same command again.')
        $script:ExitCode = 3010
        return
    }
    Install-WorkerServices
    $workerAccount = $null
    if (Test-JsonProperty $manifest 'workerAccount') { $workerAccount = Grant-WorkerAccount -Settings $manifest.workerAccount }
    Set-CrashDumpPolicy
    Set-FolderLockdown
    Test-TopLevelFolder
    Disable-RemoteAccessFirewallRule

    $notes = ''
    if (Test-JsonProperty $manifest 'notes') { $notes = [string]$manifest.notes }
    $versions = [ordered]@{
        builtAt    = (Get-Date).ToUniversalTime().ToString('o')
        node       = [ordered]@{ version = $NodeVersion; msiSha256 = $NodeMsiSha256 }
        winsw      = [ordered]@{ version = $WinSWVersion; sha256 = $WinSWSha256 }
        installers = $toolchain.Record.installers
        commands   = $toolchain.Record.commands
    }
    if ($toolchain.Record.Contains('steps')) { $versions['steps'] = $toolchain.Record.steps }
    $versions['mcpServers'] = $toolchain.Record.mcpServers
    if ($workerAccount) { $versions['workerAccount'] = $workerAccount }
    $versions['notes'] = $notes
    Write-Utf8File -Path (Join-Path $Root 'image-versions.json') -Content (ConvertTo-Json -InputObject $versions -Depth 6)
    # The image carries no build progress.
    $statePath = Get-BuildStatePath
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
    Write-Host ('The worker image is ready; its versions are in ' + (Join-Path $Root 'image-versions.json'))
    if ($Generalize) { Invoke-Generalize }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main
    if ($script:ExitCode) { exit $script:ExitCode }
}
