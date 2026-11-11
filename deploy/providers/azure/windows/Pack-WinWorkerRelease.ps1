<#
.SYNOPSIS
Packs the Windows worker release: worker-release-<sha>.zip, its other artifacts and current-release.json.

.DESCRIPTION
Runs on a Windows x64 agent with the image's Node.js (-NodeVersion), because
npm ci installs only the host platform's optional packages and the release
needs @github/copilot-win32-x64, @github/copilot-sdk-win32-x64 and
duroxide-windows-x64. It packs a lockfile-preserving tarball install:

  1. npm ci (with devDependencies), then npm run build;
  2. npm pack --ignore-scripts for packages/sdk, packages/horizon-store and
     packages/app;
  3. npm prune --omit=dev;
  4. replaces the three workspace links in node_modules by the extracted
     tarballs (a workspace's own node_modules, if npm kept one, goes inside);
  5. copies packages/sdk/examples/ and packages/app/tui/plugins/;
  6. writes a stub packages/sdk/package.json holding only {"type":"module"},
     never the real one, whose exports would make Node look for a missing
     packages/sdk/dist/index.js;
  7. unpacks the Copilot CLI program into copilot-pkg\ with
     copilot.exe --no-auto-update --version and COPILOT_PKG_CACHE_HOME, and
     fails unless copilot-pkg\pkg\win32-x64\<version>\ (the version the SDK
     pins) holds .extraction-complete, index.js, app.js and
     prebuilds\win32-x64\runtime.node;
  8. fails if any junction or other reparse point remains, or if one of the
     three Windows packages is missing;
  9. creates worker-release-<sha>.zip (checked the way the attacher checks it)
     and writes current-release.json with commitSha, zipSha256 and the SHA-256
     of every other artifact: -ModelCatalog, -HeadlessInstructions, -Plugin.

-OutputDir should be on the repository's volume: node_modules moves there.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot '..\..\..\..'),
    [string]$OutputDir,
    [string]$ModelCatalog,
    [string]$HeadlessInstructions,
    [string[]]$Plugin = @(),
    [string]$CommitSha,
    [string]$NodeVersion = '24.22.1',
    [switch]$KeepStage
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

$script:Workspaces = @('packages/sdk', 'packages/horizon-store', 'packages/app')
$script:WindowsPackages = @('@github/copilot-win32-x64', '@github/copilot-sdk-win32-x64', 'duroxide-windows-x64')

function Get-TarPath { return (Join-Path $env:SystemRoot 'System32\tar.exe') }

function Test-WindowsPackages {
    <# Throws unless node_modules holds the three Windows packages the worker needs. #>
    param([Parameter(Mandatory = $true)][string]$NodeModules)
    $missing = @($script:WindowsPackages | Where-Object { -not (Test-Path -LiteralPath ([System.IO.Path]::Combine([string[]](@($NodeModules) + $_.Split('/') + 'package.json'))) -PathType Leaf) })
    if ($missing.Count) { throw ('the release lacks Windows packages: ' + ($missing -join ', ') + '; pack on Windows x64') }
}

function Test-CopilotPackage {
    <# Throws unless the unpacked Copilot CLI program is complete for Version, as its loader checks. #>
    param([Parameter(Mandatory = $true)][string]$CopilotPkg, [Parameter(Mandatory = $true)][string]$Version)
    $dir = [System.IO.Path]::Combine($CopilotPkg, 'pkg', 'win32-x64', $Version)
    $missing = @(@('.extraction-complete', 'index.js', 'app.js', 'prebuilds/win32-x64/runtime.node') | Where-Object { -not (Test-Path -LiteralPath ([System.IO.Path]::Combine([string[]](@($dir) + $_.Split('/')))) -PathType Leaf) })
    if ($missing.Count) { throw ('the unpacked Copilot CLI program in ' + $dir + ' lacks ' + ($missing -join ', ')) }
}

function Get-PinnedCopilotVersion {
    <# The Copilot CLI version the SDK pins, exactly. #>
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $sdk = Read-JsonFile -Path ([System.IO.Path]::Combine($RepoRoot, 'packages', 'sdk', 'package.json'))
    $version = $null
    if ((Test-JsonProperty $sdk 'dependencies') -and (Test-JsonProperty $sdk.dependencies '@github/copilot')) { $version = [string]$sdk.dependencies.'@github/copilot' }
    if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+$') { throw ('packages/sdk/package.json must pin @github/copilot to an exact version, not ' + $version) }
    return $version
}

function Write-SdkPackageStub {
    <# packages/sdk/package.json in the release: only {"type":"module"}, so the examples load as ES modules. #>
    param([Parameter(Mandatory = $true)][string]$Stage)
    Write-Utf8File -Path ([System.IO.Path]::Combine($Stage, 'packages', 'sdk', 'package.json')) -Content '{"type":"module"}'
}

function Invoke-Robocopy {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    # /XJ: never copy through a junction; exit codes below 8 mean success.
    [void](Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\robocopy.exe') -ArgumentList @($Source, $Destination, '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -SuccessExitCode @(0, 1, 2, 3, 4, 5, 6, 7))
}

function New-ArtifactZip {
    <#
    A zip of a folder's contents, with the system's tar.exe; entries use / and
    never start with ./ . Without hdrcharset=UTF-8, tar.exe drops every
    non-ASCII character from entry names.
    #>
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    $names = @(Get-ChildItem -LiteralPath $Source -Force -Name)
    if ($names.Count -eq 0) { throw ($Source + ' is empty') }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    [void](Invoke-NativeCommand -FilePath (Get-TarPath) -ArgumentList (@('--options', 'hdrcharset=UTF-8', '-a', '-c', '-f', $Destination, '-C', $Source) + $names))
}

function Test-ReleaseArchive {
    <#
    Reads the zip the way the attacher will (disk-attacher.mjs), so a zip it
    would refuse fails here, and checks that its entries name exactly the
    files and folders of Source.
    #>
    param([Parameter(Mandatory = $true)][string]$ZipFile, [Parameter(Mandatory = $true)][string]$Source)
    $attacher = [System.Uri]::new((Join-Path $PSScriptRoot 'disk-attacher.mjs')).AbsoluteUri
    $check = @(
        'import fs from "node:fs"; import path from "node:path";',
        'const [url, zip, source] = process.argv.slice(1); const m = await import(url);',
        'const entries = await m.readZipEntries(zip); m.checkArchiveEntries(entries);',
        'const want = new Set(); const walk = (dir, prefix) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {',
        '  const name = prefix + e.name; if (e.isDirectory()) { want.add(name + "/"); walk(path.join(dir, e.name), name + "/"); } else want.add(name); } };',
        'walk(source, "");',
        'const got = new Set(entries.map((e) => e.name)); const missing = [...want].filter((n) => !got.has(n)); const extra = [...got].filter((n) => !want.has(n));',
        'if (missing.length || extra.length) throw new Error("the zip does not name the folder''s files: missing " + missing.slice(0, 5).join(", ") + "; unexpected " + extra.slice(0, 5).join(", "));',
        'console.log(entries.length);'
    ) -join ' '
    $result = Invoke-NativeCommand -FilePath 'node' -ArgumentList @('--input-type=module', '-e', $check, $attacher, $ZipFile, $Source) -NoThrow
    if ($result.ExitCode -ne 0) { throw ('the attacher would refuse ' + $ZipFile + ': ' + (($result.StdErr -split "`r?`n" | Where-Object { $_ -match 'Error' } | Select-Object -First 2) -join ' ')) }
    return [int]$result.StdOut.Trim()
}

function Get-ContentName {
    <# <prefix>-<first 12 hex of the SHA-256><extension>: a changed artifact gets a new blob name. #>
    param([Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)][string]$Prefix, [Parameter(Mandatory = $true)][string]$Extension)
    return ($Prefix + '-' + (Get-Sha256Hex $File).Substring(0, 12) + $Extension)
}

function Write-CurrentReleaseJson {
    <# current-release.json: commitSha, zipSha256 and each other artifact's blob name and SHA-256. #>
    param(
        [Parameter(Mandatory = $true)][string]$OutputDir,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [Parameter(Mandatory = $true)][string]$ZipFile,
        [string]$ModelCatalogBlob,
        [string]$HeadlessInstructionsBlob,
        [object[]]$Plugins = @()
    )
    if ($CommitSha -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') { throw ('not a lowercase commit ID: ' + $CommitSha) }
    if ((Split-Path -Leaf $ZipFile) -ne ('worker-release-' + $CommitSha + '.zip')) { throw 'the release zip must be named worker-release-<commitSha>.zip' }
    $blobFile = { param([string]$Blob) Join-Path $OutputDir ($Blob.Replace('/', [System.IO.Path]::DirectorySeparatorChar)) }
    $release = [ordered]@{ schemaVersion = 1; commitSha = $CommitSha; zipSha256 = (Get-Sha256Hex $ZipFile) }
    if ($ModelCatalogBlob) { $release['modelCatalog'] = [ordered]@{ blob = $ModelCatalogBlob; sha256 = (Get-Sha256Hex (& $blobFile $ModelCatalogBlob)) } }
    if ($HeadlessInstructionsBlob) { $release['headlessInstructions'] = [ordered]@{ blob = $HeadlessInstructionsBlob; sha256 = (Get-Sha256Hex (& $blobFile $HeadlessInstructionsBlob)) } }
    if ($Plugins.Count) {
        $release['plugins'] = @($Plugins | ForEach-Object { [ordered]@{ name = $_.Name; blob = $_.Blob; sha256 = (Get-Sha256Hex (& $blobFile $_.Blob)) } })
    }
    $file = Join-Path $OutputDir 'current-release.json'
    Write-Utf8File -Path $file -Content ((ConvertTo-Json -InputObject $release -Depth 5) + "`n")
    return $file
}

function Invoke-Npm {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    Write-Host ('npm ' + ($Arguments -join ' '))
    return Invoke-NativeCommand -FilePath 'npm.cmd' -ArgumentList $Arguments -WorkingDirectory $RepoRoot
}

function Invoke-Main {
    if (-not (Test-WindowsHost) -or [System.Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') -ne 'AMD64') { throw 'pack the release on a Windows x64 agent' }
    if (-not $OutputDir) { throw '-OutputDir is required' }
    $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).ProviderPath
    $node = (Invoke-NativeCommand -FilePath 'node' -ArgumentList @('--version')).StdOut.Trim()
    if ($node -ne ('v' + $NodeVersion)) { throw ('pack with the image''s Node.js v' + $NodeVersion + ', not ' + $node) }
    if (-not $CommitSha) { $CommitSha = (Invoke-NativeCommand -FilePath 'git' -ArgumentList @('-C', $RepoRoot, 'rev-parse', 'HEAD')).StdOut.Trim() }
    $copilotVersion = Get-PinnedCopilotVersion -RepoRoot $RepoRoot
    foreach ($dir in $Plugin) { if ((Split-Path -Leaf $dir) -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw ('a plugin folder name must be letters, digits, _ . -: ' + $dir) } }

    [void](New-Item -ItemType Directory -Force -Path $OutputDir)
    $OutputDir = (Resolve-Path -LiteralPath $OutputDir).ProviderPath
    if ([System.IO.Path]::GetPathRoot($OutputDir) -ne [System.IO.Path]::GetPathRoot($RepoRoot)) { throw '-OutputDir must be on the repository''s volume: node_modules moves there' }
    $stage = Join-Path $OutputDir 'stage'
    $tarballs = Join-Path $OutputDir 'tarballs'
    foreach ($dir in @($stage, $tarballs)) {
        # A stage left by a failed run can still hold workspace junctions into the repository.
        Remove-LinkSafeItem -Path $dir
        [void](New-Item -ItemType Directory -Path $dir)
    }

    # 1-3: install, build, pack, prune.
    [void](Invoke-Npm @('ci', '--include=dev', '--no-audit', '--no-fund'))
    [void](Invoke-Npm @('run', 'build'))
    $packArguments = @('pack', '--ignore-scripts', '--pack-destination', $tarballs) + @($script:Workspaces | ForEach-Object { '--workspace=' + $_ })
    [void](Invoke-Npm $packArguments)
    [void](Invoke-Npm @('prune', '--omit=dev', '--no-audit', '--no-fund'))

    # 4: the workspace links become the packed packages.
    $nodeModules = Join-Path $RepoRoot 'node_modules'
    foreach ($workspace in $script:Workspaces) {
        $package = Read-JsonFile -Path (Join-Path $RepoRoot ($workspace.Replace('/', '\') + '\package.json'))
        $tgz = Join-Path $tarballs ($package.name.Replace('@', '').Replace('/', '-') + '-' + $package.version + '.tgz')
        if (-not (Test-Path -LiteralPath $tgz -PathType Leaf)) { throw ('npm pack made no ' + $tgz) }
        $target = Join-Path $nodeModules $package.name.Replace('/', '\')
        Remove-LinkSafeItem -Path $target
        [void](New-Item -ItemType Directory -Path $target)
        [void](Invoke-NativeCommand -FilePath (Get-TarPath) -ArgumentList @('-x', '-z', '-f', $tgz, '-C', $target, '--strip-components', '1'))
        $own = Join-Path $RepoRoot ($workspace.Replace('/', '\') + '\node_modules')
        if (Test-Path -LiteralPath $own) { Invoke-Robocopy -Source $own -Destination (Join-Path $target 'node_modules') }
    }
    Move-Item -LiteralPath $nodeModules -Destination (Join-Path $stage 'node_modules')

    # 5-6: the examples, the plugin catalog and the stub package.json.
    Invoke-Robocopy -Source (Join-Path $RepoRoot 'packages\sdk\examples') -Destination (Join-Path $stage 'packages\sdk\examples')
    Invoke-Robocopy -Source (Join-Path $RepoRoot 'packages\app\tui\plugins') -Destination (Join-Path $stage 'packages\app\tui\plugins')
    Write-SdkPackageStub -Stage $stage

    # 7: the Copilot CLI program, unpacked once into the release, where the worker can only read it.
    $copilotExe = Join-Path $stage 'node_modules\@github\copilot-win32-x64\copilot.exe'
    if (-not (Test-Path -LiteralPath $copilotExe -PathType Leaf)) { throw ('missing ' + $copilotExe) }
    $environment = @{ COPILOT_PKG_CACHE_HOME = (Join-Path $stage 'copilot-pkg') }
    foreach ($name in @([System.Environment]::GetEnvironmentVariables().Keys)) { if ($name -like 'COPILOT_*' -and $name -ne 'COPILOT_PKG_CACHE_HOME') { $environment[$name] = $null } }
    [void](Invoke-NativeCommand -FilePath $copilotExe -ArgumentList @('--no-auto-update', '--version') -Environment $environment -TimeoutSeconds 600)
    Test-CopilotPackage -CopilotPkg (Join-Path $stage 'copilot-pkg') -Version $copilotVersion

    # 8: no link may remain, and the Windows packages must be there.
    $links = @(Find-ReparsePoint -Path $stage)
    if ($links.Count) { throw ('the release holds junctions or other reparse points: ' + (($links | Select-Object -First 10) -join ', ')) }
    Test-WindowsPackages -NodeModules (Join-Path $stage 'node_modules')

    # 9: the zip, the other artifacts and current-release.json.
    $zip = Join-Path $OutputDir ('worker-release-' + $CommitSha + '.zip')
    New-ArtifactZip -Source $stage -Destination $zip
    $entries = Test-ReleaseArchive -ZipFile $zip -Source $stage
    $catalogBlob = $null
    if ($ModelCatalog) {
        [void](Read-JsonFile -Path $ModelCatalog)
        $catalogBlob = Get-ContentName -File $ModelCatalog -Prefix 'model-catalog' -Extension '.json'
        Copy-Item -LiteralPath $ModelCatalog -Destination (Join-Path $OutputDir $catalogBlob) -Force
    }
    $instructionsBlob = $null
    if ($HeadlessInstructions) {
        $temp = Join-Path $OutputDir 'headless-instructions.zip'
        New-ArtifactZip -Source $HeadlessInstructions -Destination $temp
        [void](Test-ReleaseArchive -ZipFile $temp -Source $HeadlessInstructions)
        $instructionsBlob = Get-ContentName -File $temp -Prefix 'headless-instructions' -Extension '.zip'
        Move-Item -LiteralPath $temp -Destination (Join-Path $OutputDir $instructionsBlob) -Force
    }
    $plugins = @()
    if ($Plugin.Count) { [void](New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir 'plugins')) }
    foreach ($dir in $Plugin) {
        $name = Split-Path -Leaf $dir
        $temp = Join-Path $OutputDir ('plugins\' + $name + '.zip')
        New-ArtifactZip -Source $dir -Destination $temp
        [void](Test-ReleaseArchive -ZipFile $temp -Source $dir)
        $leaf = Get-ContentName -File $temp -Prefix $name -Extension '.zip'
        Move-Item -LiteralPath $temp -Destination (Join-Path $OutputDir ('plugins\' + $leaf)) -Force
        $plugins += [pscustomobject]@{ Name = $name; Blob = ('plugins/' + $leaf) }
    }
    $manifest = Write-CurrentReleaseJson -OutputDir $OutputDir -CommitSha $CommitSha -ZipFile $zip -ModelCatalogBlob $catalogBlob -HeadlessInstructionsBlob $instructionsBlob -Plugins $plugins
    Remove-Item -LiteralPath $tarballs -Recurse -Force
    # Step 8 found no link in the stage, so Remove-Item cannot follow one here.
    if (-not $KeepStage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    Write-Host ('Packed ' + $zip + ' (' + $entries + ' entries); publish the folder''s artifacts and then ' + $manifest)
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
