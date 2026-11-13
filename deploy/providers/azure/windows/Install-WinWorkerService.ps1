<#
.SYNOPSIS
Writes C:\pilotswarm\worker.env and installs the worker's two WinSW services.

.DESCRIPTION
Runs once, inside Build-WorkerOsImage.ps1, never on a running VM.

worker.env holds the image's own values (fixed: the folders and files the image
creates and the settings its hardening relies on), then defaults the
deployment may change, then the deployment's worker settings file
(-WorkerSettingsFile, NAME=VALUE lines; README, "The worker settings file").
The launcher overlays the deployment's per-stamp values from the scale set's
userData on top at every start, so a settings file may not set those, nor the
values the launcher sets itself.

Both services run "C:\Program Files\nodejs\node.exe" by its full path under
WinSW 2.12.0:
  PilotSwarmDiskAttacher  disk-attacher.mjs, as LocalSystem
  PilotSwarmWorker        launcher.mjs, as NT SERVICE\PilotSwarmWorker, working
                          folder C:\pilotswarm\work, after the attacher
                          (<depend>), with a 105-minute stop timeout and a
                          restart 10 seconds after any non-zero exit.

.PARAMETER WorkerSettingsFile
The deployment's worker settings, NAME=VALUE lines.

.PARAMETER WinSWExe
The verified WinSW 2.12.0 executable (Build-WorkerOsImage.ps1 downloads and
checks it).

.PARAMETER ConfigurationOnly
Write worker.env and the two service definitions under -Root, install nothing.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$WorkerSettingsFile,
    [string]$Root = 'C:\pilotswarm',
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string]$WinSWExe,
    [switch]$ConfigurationOnly
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

$script:AttacherService = 'PilotSwarmDiskAttacher'
$script:WorkerService = 'PilotSwarmWorker'

# The deployment's per-stamp values: only the scale set's userData sets them.
$script:UserDataNames = @(
    'DATABASE_URL', 'PILOTSWARM_CMS_FACTS_DATABASE_URL', 'PILOTSWARM_DB_AAD_USER', 'AZURE_STORAGE_ACCOUNT_URL',
    'PS_DISK_POOL_CONTROLLER_URL', 'PS_DISK_CONTROLLER_TOKEN_SCOPE', 'AZURE_CLIENT_ID', 'EXPECTED_WIN_WORKER_OID',
    'ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS', 'WIN_WORKER_CONFIG_VERSION', 'PILOTSWARM_WORKER_OWNER_ONLY'
)
# Set by the launcher itself, and credentials no worker carries.
$script:ForbiddenNames = @('PILOTSWARM_WORKER_OWNER_TAG', 'PS_LAUNCH_ID', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN')
# The drain must end before WinSW's 105-minute stop timeout, with time left for the Dev Drive extension's release.
$script:MaxShutdownTimeoutMs = 6000000
# The image's values that agents' own git and az need. With PILOTSWARM_SCRUB_CLI_ENV=1, the SDK passes a CLI only
# its baseline and PILOTSWARM_CLI_ENV_ALLOWLIST, so without these they would use the service profile's writable
# configuration and extensions instead of the image's pinned ones.
$script:CliEnvPins = @('GIT_CONFIG_GLOBAL', 'AZURE_CONFIG_DIR', 'AZURE_EXTENSION_*')

function Get-ImageWorkerValues {
    <# The image's own values: the folders and files it creates and the hardening they rely on. A settings file may not change them. #>
    param([Parameter(Mandatory = $true)][string]$Root)
    $values = [ordered]@{}
    $values['PS_DISK_ATTACHER_URL'] = 'http://127.0.0.1:3099'
    $values['PS_DISK_ATTACHER_TOKEN_FILE'] = Join-WindowsPath $Root 'run\attacher.token'
    $values['PS_DISK_CONTROLLER_TOKEN_MODULE'] = Join-WindowsPath $Root 'controller-token.mjs'
    $values['PS_DISK_CONTROLLER_CA_CERT'] = Join-WindowsPath $Root 'disk-controller-ca.crt'
    $values['PS_MODEL_PROVIDERS_PATH'] = Join-WindowsPath $Root 'model_providers.json'
    $values['PS_EMPTY_HOOKS_DIR'] = Join-WindowsPath $Root 'empty-hooks'
    $values['PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE'] = '1'
    $values['COPILOT_HOME'] = Join-WindowsPath $Root 'copilot'
    $values['SESSION_STATE_DIR'] = Join-WindowsPath $Root 'copilot\session-state'
    $values['COPILOT_PKG_CACHE_HOME'] = Join-WindowsPath $Root 'current\copilot-pkg'
    $values['TEMP'] = Join-WindowsPath $Root 'temp'
    $values['TMP'] = Join-WindowsPath $Root 'temp'
    $values['GIT_CONFIG_GLOBAL'] = Join-WindowsPath $Root 'gitconfig-global'
    $values['AZURE_CONFIG_DIR'] = Join-WindowsPath $Root 'azure-cli'
    $values['AZURE_EXTENSION_USE_DYNAMIC_INSTALL'] = 'no'
    $values['AZURE_EXTENSION_DIR'] = Join-WindowsPath $Root 'az-extensions'
    $values['AZURE_EXTENSION_DEV_SOURCES'] = Join-WindowsPath $Root 'az-extensions'
    $values['AZURE_EXTENSION_SYS_DIR'] = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\Lib\site-packages\azure-cli-extensions'
    $values['PILOTSWARM_AGENT_PACKAGES'] = '0'
    $values['PILOTSWARM_CLI_DISABLE_HOOKS'] = '1'
    $values['PILOTSWARM_SCRUB_CLI_ENV'] = '1'
    return $values
}

function Get-DefaultWorkerValues {
    <# Defaults for a Windows worker that the deployment's settings file may change. #>
    param([Parameter(Mandatory = $true)][string]$Root)
    $values = [ordered]@{}
    $values['PILOTSWARM_EXTENSION_MODULES'] = Join-WindowsPath $Root 'current\packages\sdk\examples\devdrive-workspaces\index.mjs'
    $values['PS_WORKSPACE_ROOTS'] = 'repos=Q:\Repos'
    $values['PS_WORKSPACE_ADOPT'] = 'instructions,agents,skills'
    $values['PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS'] = '600000'
    $values['PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS'] = [string]$script:MaxShutdownTimeoutMs
    $values['PILOTSWARM_USE_MANAGED_IDENTITY'] = '1'
    $values['PILOTSWARM_BLOB_USE_MANAGED_IDENTITY'] = '1'
    $values['AZURE_STORAGE_CONTAINER'] = 'copilot-sessions'
    $values['PILOTSWARM_SKIP_DB_MIGRATIONS'] = '1'
    $values['PILOTSWARM_ARTIFACT_FILE_ROOTS'] = (Join-WindowsPath $Root 'temp') + ';Q:\temp;Q:\Repos'
    $values['PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS'] = '1'
    $values['PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS'] = '1'
    $values['PILOTSWARM_DISABLE_K8S_SCALING'] = '1'
    $values['MSBUILDDISABLENODEREUSE'] = '1'
    return $values
}

function Test-Contains([System.Collections.IDictionary]$Values, [string]$Name) {
    foreach ($key in $Values.Keys) { if ($key -ieq $Name) { return $true } }
    return $false
}

function Test-CliEnvCovered {
    <# True when an allowlist entry passes Name, as the SDK matches them: by name, or by a prefix that ends in *, without case. #>
    param([Parameter(Mandatory = $true)][string]$Name, [string[]]$Entries = @())
    foreach ($entry in $Entries) {
        if ($entry.EndsWith('*')) {
            if ($Name.StartsWith($entry.Substring(0, $entry.Length - 1), [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        } elseif ($Name -ieq $entry) {
            return $true
        }
    }
    return $false
}

function Get-CliEnvAllowlist {
    <#
    The PILOTSWARM_CLI_ENV_ALLOWLIST that worker.env holds: the deployment's own
    entries, unchanged, then each of the image's pins whose values none of them
    passes. An entry the SDK would refuse fails the build instead of every CLI.
    #>
    param(
        [AllowEmptyString()][string]$Allowlist = '',
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Image,
        [string]$SettingsName = 'the worker settings file'
    )
    $entries = @()
    foreach ($raw in ($Allowlist -split ',')) {
        $entry = $raw.Trim()
        if (-not $entry) { continue }
        if ($entry -notmatch '^[A-Za-z0-9_()]+\*?$') {
            throw ($SettingsName + ': PILOTSWARM_CLI_ENV_ALLOWLIST entry "' + $entry + '" is neither a variable name nor a name prefix followed by *')
        }
        $entries += $entry
    }
    foreach ($pin in $script:CliEnvPins) {
        $prefix = $pin.TrimEnd('*')
        $names = @($Image.Keys | Where-Object { if ($pin.EndsWith('*')) { $_.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } else { $_ -ieq $pin } })
        if (@($names | Where-Object { -not (Test-CliEnvCovered -Name $_ -Entries $entries) }).Count -gt 0) { $entries += $pin }
    }
    return ($entries -join ',')
}

function New-WorkerEnvContent {
    <# worker.env's text: the image's values, the defaults, then the deployment's settings, each checked. #>
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$SettingsName = 'the worker settings file'
    )
    $image = Get-ImageWorkerValues -Root $Root
    $defaults = Get-DefaultWorkerValues -Root $Root
    $own = [ordered]@{}
    foreach ($name in $Settings.Keys) {
        $value = [string]$Settings[$name]
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$') { throw ($SettingsName + ': "' + $name + '" is not a valid setting name') }
        if ($script:UserDataNames -contains $name.ToUpperInvariant()) { throw ($SettingsName + ' sets ' + $name + ', which only the scale set''s userData sets') }
        if ($script:ForbiddenNames -contains $name.ToUpperInvariant()) { throw ($SettingsName + ' sets ' + $name + ', which no worker image may carry') }
        if (Test-Contains $image $name) { throw ($SettingsName + ' sets ' + $name + ', which the image fixes') }
        if ($value.Contains("`n") -or $value.Contains("`r")) { throw ($SettingsName + ': ' + $name + ' spans more than one line') }
        $own[$name] = $value
    }
    $merged = [ordered]@{}
    foreach ($name in $defaults.Keys) { $merged[$name] = $defaults[$name] }
    foreach ($name in $own.Keys) {
        foreach ($key in @($merged.Keys)) { if ($key -ieq $name) { $merged.Remove($key) } }
        $merged[$name] = $own[$name]
    }
    # The deployment's allowlist keeps its name and place; one it didn't set comes last.
    $allowlistName = @(@($merged.Keys) | Where-Object { $_ -ieq 'PILOTSWARM_CLI_ENV_ALLOWLIST' }) + @('PILOTSWARM_CLI_ENV_ALLOWLIST') | Select-Object -First 1
    $allowlist = ''
    if ($merged.Contains($allowlistName)) { $allowlist = [string]$merged[$allowlistName] }
    $merged[$allowlistName] = Get-CliEnvAllowlist -Allowlist $allowlist -Image $image -SettingsName $SettingsName
    $timeout = 0L
    if (-not [long]::TryParse([string]$merged['PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS'], [ref]$timeout) -or $timeout -lt 1 -or $timeout -gt $script:MaxShutdownTimeoutMs) {
        throw ('PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS must be from 1 to ' + $script:MaxShutdownTimeoutMs + ': the drain ends before the service''s 105-minute stop timeout')
    }
    $extension = (Join-WindowsPath $Root 'current\packages\sdk\examples\devdrive-workspaces\index.mjs')
    $modules = @(([string]$merged['PILOTSWARM_EXTENSION_MODULES']) -split ',' | ForEach-Object { $_.Trim() })
    if (-not ($modules | Where-Object { $_ -ieq $extension })) { throw ('PILOTSWARM_EXTENSION_MODULES must load the Dev Drive extension, ' + $extension) }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# The Windows worker''s settings, written by Install-WinWorkerService.ps1 when the image was built.')
    $lines.Add('# launcher.mjs overlays the deployment''s per-stamp values from the scale set''s userData at every start.')
    $lines.Add('')
    $lines.Add('# The image''s own folders, files and hardening.')
    foreach ($name in $image.Keys) { $lines.Add($name + '=' + $image[$name]) }
    $lines.Add('')
    $lines.Add('# Windows worker defaults and the deployment''s settings (' + $SettingsName + ').')
    foreach ($name in $merged.Keys) { $lines.Add($name + '=' + $merged[$name]) }
    return (($lines -join "`r`n") + "`r`n")
}

function ConvertTo-XmlText([string]$Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

function New-WinSWServiceXml {
    <# The WinSW 2.12.0 definition of one of the two services. #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Attacher', 'Worker')][string]$Service,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$NodeExe
    )
    $ca = Join-WindowsPath $Root 'disk-controller-ca.crt'
    if ($Service -eq 'Attacher') {
        $id = $script:AttacherService
        $name = 'PilotSwarm disk attacher'
        $description = 'Brings the worker''s Dev Drive (LUN 0) online and offline and installs the worker release. Listens on 127.0.0.1 only.'
        $entryScript = Join-WindowsPath $Root 'disk-attacher.mjs'
        $workingDirectory = Join-WindowsPath $Root 'run'
        $stopTimeout = '2 min'
        $logPath = Join-WindowsPath $Root 'attacher-logs'
        $depend = $null
    } else {
        $id = $script:WorkerService
        $name = 'PilotSwarm worker'
        $description = 'Runs the PilotSwarm worker through launcher.mjs.'
        $entryScript = Join-WindowsPath $Root 'launcher.mjs'
        $workingDirectory = Join-WindowsPath $Root 'work'
        # The worker's drain (up to 100 minutes) and the Dev Drive extension's wait for a release in flight.
        $stopTimeout = '105 min'
        $logPath = Join-WindowsPath $Root 'logs'
        $depend = $script:AttacherService
    }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('<service>')
    $lines.Add('  <id>' + $id + '</id>')
    $lines.Add('  <name>' + (ConvertTo-XmlText $name) + '</name>')
    $lines.Add('  <description>' + (ConvertTo-XmlText $description) + '</description>')
    $lines.Add('  <executable>' + (ConvertTo-XmlText $NodeExe) + '</executable>')
    $lines.Add('  <arguments>' + (ConvertTo-XmlText ('"' + $entryScript + '"')) + '</arguments>')
    $lines.Add('  <workingdirectory>' + (ConvertTo-XmlText $workingDirectory) + '</workingdirectory>')
    $lines.Add('  <env name="NODE_EXTRA_CA_CERTS" value="' + (ConvertTo-XmlText $ca) + '"/>')
    if ($depend) { $lines.Add('  <depend>' + $depend + '</depend>') }
    $lines.Add('  <startmode>Automatic</startmode>')
    $lines.Add('  <stoptimeout>' + $stopTimeout + '</stoptimeout>')
    $lines.Add('  <stopparentprocessfirst>true</stopparentprocessfirst>')
    # WinSW applies this only to a non-zero exit: a crash or a binding exit (75) restarts, a clean stop does not.
    $lines.Add('  <onfailure action="restart" delay="10 sec"/>')
    $lines.Add('  <resetfailure>1 hour</resetfailure>')
    $lines.Add('  <logpath>' + (ConvertTo-XmlText $logPath) + '</logpath>')
    $lines.Add('  <log mode="roll-by-size">')
    $lines.Add('    <sizeThreshold>10240</sizeThreshold>')
    $lines.Add('    <keepFiles>8</keepFiles>')
    $lines.Add('  </log>')
    $lines.Add('</service>')
    return (($lines -join "`r`n") + "`r`n")
}

function Install-WinSWService {
    param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][string]$Xml, [Parameter(Mandatory = $true)][string]$ServicesDir, [Parameter(Mandatory = $true)][string]$WinSWExe)
    $exe = Join-Path $ServicesDir ($Id + '.exe')
    if (Get-Service -Name $Id -ErrorAction SilentlyContinue) {
        Write-Host ('Removing the existing service ' + $Id)
        [void](Invoke-NativeCommand -FilePath $exe -ArgumentList @('stop') -NoThrow)
        [void](Invoke-NativeCommand -FilePath $exe -ArgumentList @('uninstall'))
    }
    Copy-Item -LiteralPath $WinSWExe -Destination $exe -Force
    Write-Utf8File -Path (Join-Path $ServicesDir ($Id + '.xml')) -Content $Xml
    [void](Invoke-NativeCommand -FilePath $exe -ArgumentList @('install'))
}

function Invoke-Main {
    if (-not $WorkerSettingsFile) { throw '-WorkerSettingsFile is required' }
    $settings = Read-EnvFile -Path $WorkerSettingsFile
    $envText = New-WorkerEnvContent -Settings $settings -Root $Root -SettingsName (Split-Path -Leaf $WorkerSettingsFile)
    $attacherXml = New-WinSWServiceXml -Service Attacher -Root $Root -NodeExe $NodeExe
    $workerXml = New-WinSWServiceXml -Service Worker -Root $Root -NodeExe $NodeExe
    $servicesDir = Join-WindowsPath $Root 'services'
    Write-Utf8File -Path (Join-WindowsPath $Root 'worker.env') -Content $envText
    if ($ConfigurationOnly) {
        Write-Utf8File -Path (Join-Path $servicesDir ($script:AttacherService + '.xml')) -Content $attacherXml
        Write-Utf8File -Path (Join-Path $servicesDir ($script:WorkerService + '.xml')) -Content $workerXml
        Write-Host ('Wrote worker.env and the service definitions under ' + $Root)
        return
    }
    if (-not (Test-IsAdministrator)) { throw 'installing services needs an administrator' }
    if (-not $WinSWExe -or -not (Test-Path -LiteralPath $WinSWExe -PathType Leaf)) { throw '-WinSWExe must name the verified WinSW executable' }
    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw ('Node.js is not installed at ' + $NodeExe) }
    [void](New-Item -ItemType Directory -Force -Path $servicesDir)
    Install-WinSWService -Id $script:AttacherService -Xml $attacherXml -ServicesDir $servicesDir -WinSWExe $WinSWExe
    Install-WinSWService -Id $script:WorkerService -Xml $workerXml -ServicesDir $servicesDir -WinSWExe $WinSWExe

    # The worker runs as its own virtual account; the attacher stays LocalSystem.
    $sc = Join-Path $env:SystemRoot 'System32\sc.exe'
    [void](Invoke-NativeCommand -FilePath $sc -ArgumentList @('config', $script:WorkerService, 'obj=', ('NT SERVICE\' + $script:WorkerService)))
    [void](Invoke-NativeCommand -FilePath $sc -ArgumentList @('sidtype', $script:WorkerService, 'unrestricted'))
    [void](Assert-WorkerServiceSid)
    $account = (Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $script:WorkerService + "'")).StartName
    if ($account -ne ('NT SERVICE\' + $script:WorkerService)) { throw ($script:WorkerService + ' runs as ' + $account + ', not its virtual account') }
    $attacherAccount = (Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $script:AttacherService + "'")).StartName
    if ($attacherAccount -ne 'LocalSystem') { throw ($script:AttacherService + ' runs as ' + $attacherAccount + ', not LocalSystem') }
    Write-Host ('Installed ' + $script:AttacherService + ' (LocalSystem) and ' + $script:WorkerService + ' (NT SERVICE\' + $script:WorkerService + '); both start with the next boot')
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
