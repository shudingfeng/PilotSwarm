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
  4. installs the toolchain manifest's installers, commands, MCP servers and
     Defender exclusions;
  5. downloads WinSW -WinSWVersion (pinned SHA-256) and runs
     Install-WinWorkerService.ps1 (worker.env and both services);
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

function Test-ToolchainManifest {
    <# Checks a toolchain manifest (schemaVersion 1) and returns it; throws on the first problem. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $known = @('schemaVersion', 'installers', 'commands', 'mcpServers', 'npmRegistry', 'defenderExclusions', 'notes')
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
    if (Test-JsonProperty $Manifest 'installers') {
        foreach ($installer in @($Manifest.installers)) {
            & $checkName $installer.name 'an installer'
            foreach ($field in $installer.PSObject.Properties.Name) {
                if (@('name', 'url', 'sha256', 'type', 'arguments', 'successExitCodes', 'destination', 'addToPath') -notcontains $field) { throw ('toolchain manifest: installer ' + $installer.name + ' has an unknown field ' + $field) }
            }
            if (-not (Test-JsonProperty $installer 'url') -or $installer.url -notmatch '^https://') { throw ('toolchain manifest: installer ' + $installer.name + ' needs an https:// url') }
            if (-not (Test-JsonProperty $installer 'sha256') -or $installer.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw ('toolchain manifest: installer ' + $installer.name + ' needs a lowercase sha256') }
            if (-not (Test-JsonProperty $installer 'type') -or @('exe', 'msi', 'zip') -notcontains $installer.type) { throw ('toolchain manifest: installer ' + $installer.name + ' needs a type: exe, msi or zip') }
            if (Test-JsonProperty $installer 'arguments') { & $checkStrings $installer.arguments ('installer ' + $installer.name + ' arguments') }
            if ($installer.type -eq 'zip' -and (-not (Test-JsonProperty $installer 'destination') -or [string]$installer.destination -notmatch '^[A-Za-z]:\\')) {
                throw ('toolchain manifest: zip installer ' + $installer.name + ' needs an absolute destination')
            }
        }
    }
    if (Test-JsonProperty $Manifest 'commands') {
        foreach ($command in @($Manifest.commands)) {
            & $checkName $command.name 'a command'
            if (-not (Test-JsonProperty $command 'command') -or @($command.command).Count -lt 1) { throw ('toolchain manifest: command ' + $command.name + ' needs a command list') }
            & $checkStrings $command.command ('command ' + $command.name)
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

function Install-Toolchain {
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestDir)
    $record = [ordered]@{ installers = @(); commands = @(); mcpServers = @() }
    $expand = { param([string]$Value) $Value.Replace('{manifestDir}', $ManifestDir) }
    $downloads = Join-Path $Root 'toolchain'
    if (Test-JsonProperty $Manifest 'installers') {
        foreach ($installer in @($Manifest.installers)) {
            $leaf = [System.IO.Path]::GetFileName(([uri]$installer.url).AbsolutePath)
            $file = Join-Path $downloads ($installer.name + '-' + $leaf)
            Write-Host ('Installing ' + $installer.name)
            Save-VerifiedDownload -Uri $installer.url -Sha256 $installer.sha256 -Destination $file
            $arguments = @()
            if (Test-JsonProperty $installer 'arguments') { $arguments = @($installer.arguments | ForEach-Object { & $expand $_ }) }
            $codes = @(0)
            if (Test-JsonProperty $installer 'successExitCodes') { $codes = @($installer.successExitCodes | ForEach-Object { [int]$_ }) }
            switch ($installer.type) {
                'exe' { [void](Invoke-NativeCommand -FilePath $file -ArgumentList $arguments -SuccessExitCode $codes) }
                'msi' {
                    if (-not (Test-JsonProperty $installer 'successExitCodes')) { $codes = @(0, 3010) }
                    [void](Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList (@('/i', $file, '/qn', '/norestart') + $arguments) -SuccessExitCode $codes)
                }
                'zip' {
                    $destination = & $expand ([string]$installer.destination)
                    [void](New-Item -ItemType Directory -Force -Path $destination)
                    Expand-Archive -LiteralPath $file -DestinationPath $destination -Force
                    if ((Test-JsonProperty $installer 'addToPath') -and $installer.addToPath -eq $true) {
                        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
                        if (-not (($machine -split ';') -contains $destination)) { [Environment]::SetEnvironmentVariable('Path', ($machine.TrimEnd(';') + ';' + $destination), 'Machine') }
                    }
                }
            }
            Remove-Item -LiteralPath $file -Force
            Update-SessionPath
            $record.installers += [ordered]@{ name = $installer.name; url = $installer.url; sha256 = $installer.sha256 }
        }
    }
    if (Test-JsonProperty $Manifest 'commands') {
        foreach ($command in @($Manifest.commands)) {
            Write-Host ('Running ' + $command.name)
            $parts = @($command.command | ForEach-Object { & $expand $_ })
            $codes = @(0)
            if (Test-JsonProperty $command 'successExitCodes') { $codes = @($command.successExitCodes | ForEach-Object { [int]$_ }) }
            $rest = @()
            if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
            [void](Invoke-NativeCommand -FilePath $parts[0] -ArgumentList $rest -SuccessExitCode $codes)
            Update-SessionPath
            $record.commands += $command.name
        }
    }
    if (Test-JsonProperty $Manifest 'mcpServers') {
        $npm = Join-Path (Split-Path -Parent $script:NodeExe) 'npm.cmd'
        foreach ($server in @($Manifest.mcpServers)) {
            # Installed once here, so no session downloads an MCP server with npx at run time.
            $prefix = Join-Path $Root ('mcp\' + $server.name)
            [void](New-Item -ItemType Directory -Force -Path $prefix)
            $arguments = @('install', '--prefix', $prefix, '--no-audit', '--no-fund', '--omit=dev', '--save-exact')
            if (-not ((Test-JsonProperty $server 'ignoreScripts') -and $server.ignoreScripts -eq $false)) { $arguments += '--ignore-scripts' }
            if (Test-JsonProperty $Manifest 'npmRegistry') { $arguments += @('--registry', $Manifest.npmRegistry) }
            $arguments += ($server.package + '@' + $server.version)
            Write-Host ('Installing the MCP server ' + $server.name + ' (' + $server.package + '@' + $server.version + ')')
            [void](Invoke-NativeCommand -FilePath $npm -ArgumentList $arguments -WorkingDirectory $prefix)
            $record.mcpServers += [ordered]@{ name = $server.name; package = $server.package; version = $server.version }
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
    return $record
}

function Install-WorkerServices {
    $winsw = Join-Path $Root ('toolchain\WinSW-' + $WinSWVersion + '.exe')
    Save-VerifiedDownload -Uri ('https://github.com/winsw/winsw/releases/download/v' + $WinSWVersion + '/WinSW.NET461.exe') -Sha256 $WinSWSha256 -Destination $winsw
    & (Join-Path $PSScriptRoot 'Install-WinWorkerService.ps1') -WorkerSettingsFile $WorkerSettingsFile -Root $Root -NodeExe $script:NodeExe -WinSWExe $winsw
    Remove-Item -LiteralPath $winsw -Force
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

    Install-NodeRuntime
    New-WorkerLayout
    $toolchain = Install-Toolchain -Manifest $manifest -ManifestDir (Split-Path -Parent (Resolve-Path -LiteralPath $ToolchainManifest).ProviderPath)
    Install-WorkerServices
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
        installers = $toolchain.installers
        commands   = $toolchain.commands
        mcpServers = $toolchain.mcpServers
        notes      = $notes
    }
    Write-Utf8File -Path (Join-Path $Root 'image-versions.json') -Content (ConvertTo-Json -InputObject $versions -Depth 5)
    Write-Host ('The worker image is ready; its versions are in ' + (Join-Path $Root 'image-versions.json'))
    if ($Generalize) { Invoke-Generalize }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
