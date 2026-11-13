<#
.SYNOPSIS
Seeds the golden Dev Drive from the seed manifest, refreshes it (-Refresh) or verifies it (-Verify).

.DESCRIPTION
The seed manifest (README, "The seed manifest") names the repositories to
clone (full history, LFS when asked), the package caches to fill and the
folders the worker's account may change. The image keeps it at
C:\pilotswarm\seed-manifest.json, where -Refresh and -Verify find it without
arguments.

Seeding, as an administrator, on a VM built from the worker image (icacls
can name NT SERVICE\PilotSwarmWorker only where its service is installed)
whose LUN 0 holds a Dev Drive that Initialize-WinWorkerDisk.ps1 formatted:
  1. creates the Modify folders and grants NT SERVICE\PilotSwarmWorker Modify
     on them (by its SID, which sc.exe showsid confirms);
  2. clones each repository at its branch (or fetches it again), with its
     submodules and LFS objects, and fills each package cache;
  3. removes any hook from each Git directory (Git's *.sample files stay);
  4. writes each repository's and submodule's clean-detach record,
     pilotswarm-clean-tips: the object IDs of HEAD and of every ref;
  5. makes the worker service the owner of each repository's folder and .git,
     and of each submodule's folder, .git file and Git directory, so Git run
     as the service accepts them without a safe.directory entry;
  6. records what it fetched in <drive>\.pilotswarm\seed-state.json;
  7. with -SnapshotResourceGroup, -SnapshotName and -DiskResourceId, takes an
     incremental snapshot of the drive and waits, as the controller's refresh
     does, until Azure reports it Succeeded and fully copied; it stops when
     provisioning fails.

-Refresh, as LocalSystem from the disk controller's Managed Run Command,
mounts the drive (Initialize-WinWorkerDisk.ps1 -MountExisting) and runs steps
1 to 6 again: fetches, updates the caches, and writes access lists, owners and
records again. Its Git calls pass -c safe.directory=*, since LocalSystem does
not own the repositories.

-Verify checks the drive and prints, as its last line, one JSON object:
  {"verified": true|false, "manifestSha256": "<64 hex>", "checks": {...}}
where each check is true or a list of what failed. It exits 0 only when every
check passes; otherwise it ends with a terminating error (exit code 1), which
also fails the Run Command script that calls it.
#>
#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Seed')]
param(
    [Parameter(ParameterSetName = 'Refresh', Mandatory = $true)][switch]$Refresh,
    [Parameter(ParameterSetName = 'Verify', Mandatory = $true)][switch]$Verify,
    [string]$ManifestPath = 'C:\pilotswarm\seed-manifest.json',
    [Parameter(ParameterSetName = 'Seed')][string]$SnapshotResourceGroup,
    [Parameter(ParameterSetName = 'Seed')][string]$SnapshotName,
    [Parameter(ParameterSetName = 'Seed')][string]$DiskResourceId,
    [Parameter(ParameterSetName = 'Refresh')][switch]$SkipMount,
    [string]$WorkerEnvFile = 'C:\pilotswarm\worker.env'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

$script:CleanTipsFile = 'pilotswarm-clean-tips'
$script:EmptyHooks = $null
$script:GitEnvironment = @{}
# How often the seed asks for the snapshot's state while Azure copies it.
$script:SnapshotPollSeconds = 30

function Test-SeedManifest {
    <# Checks a seed manifest (schemaVersion 1) and returns it with each repository's folder; throws on the first problem. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $known = @('schemaVersion', 'reposRoot', 'repositories', 'modifyFolders', 'packageCaches', 'env')
    foreach ($name in $Manifest.PSObject.Properties.Name) { if ($known -notcontains $name) { throw ('seed manifest: unknown field ' + $name) } }
    if (-not (Test-JsonProperty $Manifest 'schemaVersion') -or $Manifest.schemaVersion -ne 1) { throw 'seed manifest: schemaVersion must be 1' }
    $reposRoot = 'Q:\Repos'
    if (Test-JsonProperty $Manifest 'reposRoot') { $reposRoot = [string]$Manifest.reposRoot }
    if (-not [System.IO.Path]::IsPathRooted($reposRoot)) { throw 'seed manifest: reposRoot must be an absolute folder' }
    $reposRoot = [System.IO.Path]::GetFullPath($reposRoot).TrimEnd('\', '/')
    $drive = [System.IO.Path]::GetPathRoot($reposRoot)
    $inside = {
        param([string]$Child, [string]$Parent)
        $c = $Child.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        $p = $Parent.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
    }
    $modify = @()
    if (Test-JsonProperty $Manifest 'modifyFolders') {
        foreach ($folder in @($Manifest.modifyFolders)) {
            if ($folder -isnot [string] -or -not [System.IO.Path]::IsPathRooted($folder)) { throw ('seed manifest: modify folder ' + $folder + ' must be an absolute path') }
            $full = [System.IO.Path]::GetFullPath($folder).TrimEnd('\', '/')
            if (-not (& $inside $full $drive) -or $full.Length -le $drive.TrimEnd('\', '/').Length) { throw ('seed manifest: modify folder ' + $folder + ' must be a folder on the drive of reposRoot') }
            if ($full -ieq $reposRoot) { throw 'seed manifest: reposRoot itself stays read-only; grant Modify on folders inside it' }
            $modify += $full
        }
    }
    $repositories = @()
    $names = @{}
    if (-not (Test-JsonProperty $Manifest 'repositories') -or @($Manifest.repositories).Count -eq 0) { throw 'seed manifest: repositories must list at least one repository' }
    foreach ($repo in @($Manifest.repositories)) {
        foreach ($field in $repo.PSObject.Properties.Name) {
            if (@('name', 'url', 'branch', 'submodules', 'lfs') -notcontains $field) { throw ('seed manifest: a repository has an unknown field ' + $field) }
        }
        if (-not (Test-JsonProperty $repo 'name') -or $repo.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'seed manifest: every repository needs a name of letters, digits, _ . -' }
        if ($names.ContainsKey($repo.name.ToLowerInvariant())) { throw ('seed manifest: the repository ' + $repo.name + ' is listed twice') }
        $names[$repo.name.ToLowerInvariant()] = $true
        if (-not (Test-JsonProperty $repo 'url') -or $repo.url -notmatch '^(https|file)://') { throw ('seed manifest: repository ' + $repo.name + ' needs an https:// (or file://) url') }
        if ($repo.url -match '^https://[^/]*@') { throw ('seed manifest: repository ' + $repo.name + ' has credentials in its url') }
        if (-not (Test-JsonProperty $repo 'branch') -or $repo.branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $repo.branch -match '\.\.|//|\.lock$') { throw ('seed manifest: repository ' + $repo.name + ' needs a branch name') }
        $lfs = $false
        if (Test-JsonProperty $repo 'lfs') {
            if (@($true, $false, 'all') -notcontains $repo.lfs) { throw ('seed manifest: repository ' + $repo.name + ': lfs is true, false or "all"') }
            $lfs = $repo.lfs
        }
        $submodules = $true
        if (Test-JsonProperty $repo 'submodules') { $submodules = [bool]$repo.submodules }
        $path = [System.IO.Path]::Combine($reposRoot, [string]$repo.name)
        if (-not ($modify | Where-Object { ($_ -ieq $path) -or (& $inside $path $_) })) { throw ('seed manifest: no modify folder covers ' + $path + '; the worker could not change the repository') }
        $repositories += [pscustomobject]@{ Name = $repo.name; Url = $repo.url; Branch = $repo.branch; Submodules = $submodules; Lfs = $lfs; Path = $path }
    }
    $caches = @()
    if (Test-JsonProperty $Manifest 'packageCaches') {
        foreach ($cache in @($Manifest.packageCaches)) {
            foreach ($field in $cache.PSObject.Properties.Name) {
                if (@('name', 'workingDirectory', 'command', 'env') -notcontains $field) { throw ('seed manifest: a package cache has an unknown field ' + $field) }
            }
            if (-not (Test-JsonProperty $cache 'name') -or $cache.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'seed manifest: every package cache needs a name' }
            if (-not (Test-JsonProperty $cache 'command') -or @($cache.command).Count -lt 1 -or @($cache.command | Where-Object { $_ -isnot [string] }).Count) { throw ('seed manifest: package cache ' + $cache.name + ' needs a command list') }
            if (-not (Test-JsonProperty $cache 'workingDirectory') -or -not [System.IO.Path]::IsPathRooted([string]$cache.workingDirectory)) { throw ('seed manifest: package cache ' + $cache.name + ' needs an absolute workingDirectory') }
            $caches += [pscustomobject]@{ Name = $cache.name; WorkingDirectory = [string]$cache.workingDirectory; Command = @($cache.command); Env = (ConvertTo-EnvTable $cache 'env' ('package cache ' + $cache.name)) }
        }
    }
    return [pscustomobject]@{
        ReposRoot     = $reposRoot
        Drive         = $drive
        Repositories  = $repositories
        ModifyFolders = $modify
        PackageCaches = $caches
        Env           = (ConvertTo-EnvTable $Manifest 'env' 'the manifest')
    }
}

function ConvertTo-EnvTable {
    param($Object, [string]$Field, [string]$Where)
    $table = @{}
    if (-not (Test-JsonProperty $Object $Field) -or $null -eq $Object.$Field) { return $table }
    foreach ($property in $Object.$Field.PSObject.Properties) {
        if ($property.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$' -or $property.Value -isnot [string]) { throw ('seed manifest: ' + $Where + ' env must map names to strings') }
        $table[$property.Name] = $property.Value
    }
    return $table
}

function Initialize-GitEnvironment {
    <# The seed's own Git calls: no prompt, the workers' Git configuration, the manifest's settings, and an empty hooks folder. #>
    param($Manifest)
    $environment = @{ GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'never' }
    if (Test-Path -LiteralPath $WorkerEnvFile -PathType Leaf) {
        $workerEnv = Read-EnvFile -Path $WorkerEnvFile
        foreach ($name in $workerEnv.Keys) { if ($name -ieq 'GIT_CONFIG_GLOBAL' -or $name -like 'GCM_*') { $environment[$name] = $workerEnv[$name] } }
    }
    if ($Manifest) { foreach ($name in $Manifest.Env.Keys) { $environment[$name] = $Manifest.Env[$name] } }
    $script:GitEnvironment = $environment
    $script:EmptyHooks = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-no-hooks-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Force -Path $script:EmptyHooks)
}

function Invoke-SeedGit {
    <# git -c safe.directory=* ... in a repository: the seed's own calls run as an administrator or LocalSystem, which do not own the repositories. #>
    param([Parameter(Mandatory = $true)][string]$Repo, [Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$NoThrow)
    if (-not $script:EmptyHooks) { Initialize-GitEnvironment $null }
    $all = @('-c', 'safe.directory=*', '-c', ('core.hooksPath=' + $script:EmptyHooks), '-c', 'core.fsmonitor=false', '-C', $Repo) + $Arguments
    return Invoke-NativeCommand -FilePath 'git' -ArgumentList $all -Environment $script:GitEnvironment -NoThrow:$NoThrow
}

function Get-GitDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $result = Invoke-SeedGit -Repo $Path -Arguments @('rev-parse', '--absolute-git-dir')
    return [System.IO.Path]::GetFullPath($result.StdOut.Trim())
}

function Get-SeedRepositories {
    <# A repository and its checked-out submodules, recursively, the superproject first, as the Dev Drive extension lists them. #>
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Parent = $null, [int]$Depth = 0)
    $dotGit = Join-Path $Path '.git'
    if (-not (Test-Path -LiteralPath $dotGit)) { return @() }
    $list = @([pscustomobject]@{ Path = $Path; GitDir = (Get-GitDirectory $Path); DotGit = $dotGit; Parent = $Parent })
    if ($Depth -ge 8 -or -not (Test-Path -LiteralPath (Join-Path $Path '.gitmodules') -PathType Leaf)) { return $list }
    $listed = Invoke-SeedGit -Repo $Path -Arguments @('config', '--file', '.gitmodules', '--get-regexp', '^submodule\..*\.path$') -NoThrow
    if ($listed.ExitCode -ne 0) { return $list }
    foreach ($line in ($listed.StdOut -split "`r?`n")) {
        $line = $line.Trim()
        if (-not $line) { continue }
        $sub = $line.Substring($line.IndexOf(' ') + 1).Trim()
        $child = [System.IO.Path]::GetFullPath((Join-Path $Path $sub))
        $prefix = $Path.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        if (-not $child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $list += @(Get-SeedRepositories -Path $child -Parent $Path -Depth ($Depth + 1))
    }
    return $list
}

function Get-RepositoryTips {
    <# HEAD and every ref of a repository as unique object IDs, HEAD first, in Git's ref order. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $tips = New-Object System.Collections.Generic.List[string]
    $head = Invoke-SeedGit -Repo $Path -Arguments @('rev-parse', '--verify', '--quiet', 'HEAD') -NoThrow
    $refs = Invoke-SeedGit -Repo $Path -Arguments @('for-each-ref', '--format=%(objectname)')
    $lines = @()
    if ($head.ExitCode -eq 0) { $lines += $head.StdOut.Trim() }
    $lines += ($refs.StdOut -split "`r?`n")
    foreach ($line in $lines) {
        $oid = $line.Trim()
        if ($oid -cmatch '^[0-9a-f]{40}([0-9a-f]{24})?$' -and -not $tips.Contains($oid)) { $tips.Add($oid) }
    }
    return , $tips.ToArray()
}

function Get-CleanTipsText {
    <# The clean-detach record's text: one object ID per line, LF line endings. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $tips = Get-RepositoryTips -Path $Path
    if ($tips.Count -eq 0) { return '' }
    return (($tips -join "`n") + "`n")
}

function Write-CleanTipsRecords {
    <# pilotswarm-clean-tips in the Git directory of a repository and of each of its submodules (UTF-8, no byte order mark). #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $written = @()
    foreach ($repo in @(Get-SeedRepositories -Path $Path)) {
        $file = Join-Path $repo.GitDir $script:CleanTipsFile
        Write-Utf8File -Path $file -Content (Get-CleanTipsText -Path $repo.Path)
        $written += $file
    }
    return $written
}

function Remove-RepositoryHooks {
    <# Leaves only Git's *.sample files in each hooks folder: the golden drive carries no hook. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    foreach ($repo in @(Get-SeedRepositories -Path $Path)) {
        $hooks = Join-Path $repo.GitDir 'hooks'
        if (-not (Test-Path -LiteralPath $hooks)) { continue }
        Get-ChildItem -LiteralPath $hooks -Force | Where-Object { $_.PSIsContainer -or -not $_.Name.EndsWith('.sample') } |
            ForEach-Object { Remove-LinkSafeItem -Path $_.FullName }
    }
}

function Test-ModifyGrant {
    param([Parameter(Mandatory = $true)][string]$Path)
    $sid = Get-WorkerServiceSid
    $modify = [System.Security.AccessControl.FileSystemRights]::Modify
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -ne $sid) { continue }
        if (($rule.FileSystemRights -band $modify) -ne $modify) { continue }
        if (($rule.InheritanceFlags -band $inherit) -ne $inherit) { continue }
        if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        return $true
    }
    return $false
}

function Grant-ModifyFolder {
    param([Parameter(Mandatory = $true)][string]$Path)
    [void](New-Item -ItemType Directory -Force -Path $Path)
    # A grant that is there already is left alone: re-granting walks every file below.
    if (-not (Test-ModifyGrant -Path $Path)) { Invoke-Icacls -Path $Path -Arguments @('/grant', ('*' + (Get-WorkerServiceSid) + ':(OI)(CI)(M)')) }
}

function Get-OwnedPaths {
    <# What Git checks the owner of: a repository's folder and .git; a submodule's folder, .git file and Git directory. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $paths = @()
    foreach ($repo in @(Get-SeedRepositories -Path $Path)) {
        $paths += $repo.Path
        $paths += $repo.DotGit
        if (-not ($repo.GitDir -ieq [System.IO.Path]::GetFullPath($repo.DotGit))) { $paths += $repo.GitDir }
    }
    return $paths
}

function Set-RepositoryOwners {
    param([Parameter(Mandatory = $true)][string]$Path)
    foreach ($item in @(Get-OwnedPaths -Path $Path)) { Invoke-Icacls -Path $item -Arguments @('/setowner', ('*' + (Get-WorkerServiceSid))) }
}

function Update-SeedRepository {
    <# Clones a repository (full history) or fetches it again, then checks out its branch, submodules and LFS objects. #>
    param([Parameter(Mandatory = $true)]$Repository, [Parameter(Mandatory = $true)][string]$ReposRoot)
    $path = $Repository.Path
    if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
        if ((Test-Path -LiteralPath $path) -and (Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1)) { throw ($path + ' exists and is not a Git repository') }
        [void](New-Item -ItemType Directory -Force -Path $ReposRoot)
        Write-Host ('Cloning ' + $Repository.Name)
        [void](Invoke-SeedGit -Repo $ReposRoot -Arguments @('clone', '--branch', $Repository.Branch, '--', $Repository.Url, $path))
    } else {
        Write-Host ('Fetching ' + $Repository.Name)
        [void](Invoke-SeedGit -Repo $path -Arguments @('remote', 'set-url', 'origin', $Repository.Url))
        [void](Invoke-SeedGit -Repo $path -Arguments @('fetch', '--prune', '--tags', 'origin'))
    }
    [void](Invoke-SeedGit -Repo $path -Arguments @('checkout', '--force', '-B', $Repository.Branch, ('refs/remotes/origin/' + $Repository.Branch)))
    if ($Repository.Submodules -and (Test-Path -LiteralPath (Join-Path $path '.gitmodules'))) {
        [void](Invoke-SeedGit -Repo $path -Arguments @('submodule', 'update', '--init', '--recursive', '--force'))
    }
    if ($Repository.Lfs -eq 'all') {
        [void](Invoke-SeedGit -Repo $path -Arguments @('lfs', 'fetch', '--all', 'origin'))
        [void](Invoke-SeedGit -Repo $path -Arguments @('lfs', 'checkout'))
    } elseif ($Repository.Lfs -eq $true) {
        [void](Invoke-SeedGit -Repo $path -Arguments @('lfs', 'pull', 'origin'))
    }
}

function Invoke-PackageCache {
    param([Parameter(Mandatory = $true)]$Cache, [Parameter(Mandatory = $true)]$Manifest)
    Write-Host ('Filling the package cache ' + $Cache.Name)
    $environment = @{}
    foreach ($name in $Manifest.Env.Keys) { $environment[$name] = $Manifest.Env[$name] }
    foreach ($name in $Cache.Env.Keys) { $environment[$name] = $Cache.Env[$name] }
    $rest = @()
    if ($Cache.Command.Count -gt 1) { $rest = $Cache.Command[1..($Cache.Command.Count - 1)] }
    [void](Invoke-NativeCommand -FilePath $Cache.Command[0] -ArgumentList $rest -WorkingDirectory $Cache.WorkingDirectory -Environment $environment)
}

function Get-RemoteRefs {
    param([Parameter(Mandatory = $true)][string]$Path)
    $refs = [ordered]@{}
    $listed = Invoke-SeedGit -Repo $Path -Arguments @('for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/')
    foreach ($line in ($listed.StdOut -split "`r?`n")) {
        $parts = $line.Trim() -split ' ', 2
        if ($parts.Count -eq 2 -and $parts[1] -ne 'refs/remotes/origin/HEAD') { $refs[$parts[1]] = $parts[0] }
    }
    return $refs
}

function Get-SeedStatePath {
    param([Parameter(Mandatory = $true)]$Manifest)
    # Beside the repositories' root, at the drive's root on a worker: Q:\.pilotswarm\seed-state.json.
    return [System.IO.Path]::Combine((Split-Path -Parent $Manifest.ReposRoot), '.pilotswarm', 'seed-state.json')
}

function Save-SeedState {
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestSha256, [Parameter(Mandatory = $true)][string]$Mode)
    $repos = [ordered]@{}
    foreach ($repo in $Manifest.Repositories) { $repos[$repo.Name] = Get-RemoteRefs -Path $repo.Path }
    $state = [ordered]@{ schemaVersion = 1; mode = $Mode; at = (Get-Date).ToUniversalTime().ToString('o'); manifestSha256 = $ManifestSha256; remoteRefs = $repos }
    Write-Utf8File -Path (Get-SeedStatePath $Manifest) -Content (ConvertTo-Json -InputObject $state -Depth 6)
}

function Invoke-SeedDrive {
    <# Steps 1 to 6: Modify folders, repositories, caches, hooks, records, owners, seed state. #>
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestSha256, [Parameter(Mandatory = $true)][string]$Mode)
    [void](Assert-WorkerServiceSid)
    [void](New-Item -ItemType Directory -Force -Path $Manifest.ReposRoot)
    foreach ($folder in $Manifest.ModifyFolders) { Grant-ModifyFolder -Path $folder }
    foreach ($repo in $Manifest.Repositories) { Update-SeedRepository -Repository $repo -ReposRoot $Manifest.ReposRoot }
    foreach ($cache in $Manifest.PackageCaches) { Invoke-PackageCache -Cache $cache -Manifest $Manifest }
    foreach ($repo in $Manifest.Repositories) {
        Remove-RepositoryHooks -Path $repo.Path
        [void](Write-CleanTipsRecords -Path $repo.Path)
    }
    # Owners last: Git run as the service must find it owns each repository.
    foreach ($repo in $Manifest.Repositories) { Set-RepositoryOwners -Path $repo.Path }
    Save-SeedState -Manifest $Manifest -ManifestSha256 $ManifestSha256 -Mode $Mode
}

function Get-SeedSnapshotState {
    <# The snapshot's provisioning state and copy progress; CompletionPercent is null when Azure reports none. #>
    $show = Invoke-NativeCommand -FilePath 'az' -ArgumentList @('snapshot', 'show', '--resource-group', $SnapshotResourceGroup, '--name', $SnapshotName, '--output', 'json')
    $snapshot = $show.StdOut | ConvertFrom-Json
    $state = ''
    if (Test-JsonProperty $snapshot 'provisioningState') { $state = [string]$snapshot.provisioningState }
    $percent = $null
    if ((Test-JsonProperty $snapshot 'completionPercent') -and $null -ne $snapshot.completionPercent) { $percent = [double]$snapshot.completionPercent }
    return [pscustomobject]@{ ProvisioningState = $state; CompletionPercent = $percent }
}

function New-SeedSnapshot {
    param([Parameter(Mandatory = $true)]$Manifest)
    $letter = $Manifest.Drive.Substring(0, 1)
    Write-VolumeCache -DriveLetter $letter
    Write-Host ('Taking the incremental snapshot ' + $SnapshotName)
    [void](Invoke-NativeCommand -FilePath 'az' -ArgumentList @('snapshot', 'create', '--resource-group', $SnapshotResourceGroup, '--name', $SnapshotName, '--source', $DiskResourceId, '--incremental', 'true', '--output', 'none'))
    # Complete as the controller's refresh has it: provisioning succeeded and the background copy done, where a
    # snapshot that reports no percentage counts as copied, but only once it has succeeded.
    $deadline = (Get-Date).AddHours(6)
    while ($true) {
        $snapshot = Get-SeedSnapshotState
        if ($snapshot.ProvisioningState -eq 'Failed') { throw ('the snapshot ' + $SnapshotName + ' failed to provision') }
        if ($snapshot.ProvisioningState -eq 'Succeeded' -and ($null -eq $snapshot.CompletionPercent -or $snapshot.CompletionPercent -ge 100)) { break }
        if ((Get-Date) -gt $deadline) { throw ('the snapshot ' + $SnapshotName + ' did not complete within 6 hours') }
        $progress = 'no copy progress yet'
        if ($null -ne $snapshot.CompletionPercent) { $progress = [string]$snapshot.CompletionPercent + '% copied' }
        Write-Host ('Snapshot ' + $SnapshotName + ': ' + $snapshot.ProvisioningState + ', ' + $progress)
        Start-Sleep -Seconds $script:SnapshotPollSeconds
    }
    Write-Host ('The snapshot ' + $SnapshotName + ' is complete')
}

function Test-SeedDrive {
    <# The -Verify checks; returns failures by check. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $failures = [ordered]@{ refs = @(); fsck = @(); hooks = @(); cleanRecord = @(); owner = @(); acl = @() }
    $state = $null
    $statePath = Get-SeedStatePath $Manifest
    if (Test-Path -LiteralPath $statePath -PathType Leaf) { $state = Read-JsonFile -Path $statePath }
    $sid = Get-WorkerServiceSid
    foreach ($repo in $Manifest.Repositories) {
        try {
            if (-not (Test-Path -LiteralPath (Join-Path $repo.Path '.git'))) {
                $failures.refs += ($repo.Name + ': not cloned')
                continue
            }
            # The seeded branch is what was fetched, and the fetched refs are the ones the seed recorded.
            $head = (Invoke-SeedGit -Repo $repo.Path -Arguments @('rev-parse', 'HEAD')).StdOut.Trim()
            $branch = (Invoke-SeedGit -Repo $repo.Path -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -NoThrow).StdOut.Trim()
            $fetched = (Invoke-SeedGit -Repo $repo.Path -Arguments @('rev-parse', ('refs/remotes/origin/' + $repo.Branch)) -NoThrow).StdOut.Trim()
            if ($branch -ne $repo.Branch) { $failures.refs += ($repo.Name + ': HEAD is ' + $branch + ', not ' + $repo.Branch) }
            elseif ($head -ne $fetched) { $failures.refs += ($repo.Name + ': ' + $repo.Branch + ' is not at the fetched commit') }
            if ($state -and (Test-JsonProperty $state.remoteRefs $repo.Name)) {
                $recorded = $state.remoteRefs.($repo.Name)
                $current = Get-RemoteRefs -Path $repo.Path
                $recordedNames = @($recorded.PSObject.Properties.Name)
                if ($recordedNames.Count -ne $current.Count -or @($recordedNames | Where-Object { $current[$_] -ne $recorded.$_ }).Count) {
                    $failures.refs += ($repo.Name + ': the fetched refs differ from the ones the seed recorded')
                }
            } else {
                $failures.refs += ($repo.Name + ': the seed recorded no fetched refs')
            }
            foreach ($item in @(Get-SeedRepositories -Path $repo.Path)) {
                $label = $item.Path
                $fsck = Invoke-SeedGit -Repo $item.Path -Arguments @('fsck', '--connectivity-only', '--no-dangling') -NoThrow
                if ($fsck.ExitCode -ne 0) { $failures.fsck += ($label + ': git fsck failed') }
                $hooks = Join-Path $item.GitDir 'hooks'
                if (Test-Path -LiteralPath $hooks) {
                    $planted = @(Get-ChildItem -LiteralPath $hooks -Force | Where-Object { $_.PSIsContainer -or -not $_.Name.EndsWith('.sample') })
                    if ($planted.Count) { $failures.hooks += ($label + ': ' + (($planted | ForEach-Object { $_.Name }) -join ', ')) }
                }
                $record = Join-Path $item.GitDir $script:CleanTipsFile
                if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { $failures.cleanRecord += ($label + ': no clean-detach record') }
                elseif ([System.IO.File]::ReadAllText($record) -cne (Get-CleanTipsText -Path $item.Path)) { $failures.cleanRecord += ($label + ': the clean-detach record is not current') }
            }
            foreach ($item in @(Get-OwnedPaths -Path $repo.Path)) {
                $owner = (Get-Acl -LiteralPath $item).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
                if ($owner -ne $sid) { $failures.owner += ($item + ': owned by ' + $owner) }
            }
        } catch {
            $failures.refs += ($repo.Name + ': ' + $_.Exception.Message)
        }
    }
    foreach ($folder in $Manifest.ModifyFolders) {
        try {
            if (-not (Test-Path -LiteralPath $folder -PathType Container)) { $failures.acl += ($folder + ': missing') }
            elseif (-not (Test-ModifyGrant -Path $folder)) { $failures.acl += ($folder + ': the worker has no Modify grant') }
        } catch {
            $failures.acl += ($folder + ': ' + $_.Exception.Message)
        }
    }
    $writeRights = [System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
    $locked = @((Get-WellKnownSid Users), (Get-WellKnownSid AuthenticatedUsers), (Get-WellKnownSid CreatorOwner), (Get-WellKnownSid Everyone))
    foreach ($root in @($Manifest.Drive, $Manifest.ReposRoot)) {
        try {
            foreach ($rule in (Get-Acl -LiteralPath $root).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                if ($rule.AccessControlType -eq 'Allow' -and $locked -contains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $writeRights)) {
                    $failures.acl += ($root + ': ' + $rule.IdentityReference.Value + ' may write')
                    break
                }
            }
        } catch {
            $failures.acl += ($root + ': ' + $_.Exception.Message)
        }
    }
    return $failures
}

function ConvertTo-VerifyResult {
    <# The -Verify line: each check is true, or the first few things it found wrong. #>
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Failures, [AllowEmptyString()][string]$ManifestSha256)
    $checks = [ordered]@{}
    $verified = $true
    foreach ($name in $Failures.Keys) {
        $list = @($Failures[$name])
        if ($list.Count -eq 0) {
            $checks[$name] = $true
        } else {
            $verified = $false
            $checks[$name] = @($list | Select-Object -First 5 | ForEach-Object { $text = [string]$_; if ($text.Length -gt 160) { $text.Substring(0, 160) } else { $text } })
        }
    }
    return (ConvertTo-Json -InputObject ([ordered]@{ verified = $verified; manifestSha256 = $ManifestSha256; checks = $checks }) -Compress -Depth 5)
}

function Invoke-Main {
    $manifestSha256 = ''
    if ($Verify) {
        try {
            $manifestSha256 = Get-Sha256Hex -Path $ManifestPath
            $manifest = Test-SeedManifest (Read-JsonFile -Path $ManifestPath)
            Initialize-GitEnvironment $manifest
            $line = ConvertTo-VerifyResult -Failures (Test-SeedDrive -Manifest $manifest) -ManifestSha256 $manifestSha256
        } catch {
            $line = ConvertTo-VerifyResult -Failures ([ordered]@{ manifest = @($_.Exception.Message) }) -ManifestSha256 $manifestSha256
        }
        [Console]::Out.WriteLine($line)
        # A terminating error rather than exit 1: the controller calls this script from its own Run Command
        # script, and a nested exit code does not become that script's exit code.
        if (-not $line.StartsWith('{"verified":true')) { throw 'the drive failed verification; the line above lists the checks' }
        return
    }
    if (-not (Test-IsAdministrator)) { throw 'run Seed-WorkerReposDisk.ps1 as an administrator or LocalSystem' }
    $manifestSha256 = Get-Sha256Hex -Path $ManifestPath
    $manifest = Test-SeedManifest (Read-JsonFile -Path $ManifestPath)
    Initialize-GitEnvironment $manifest
    if ($Refresh) {
        if (-not $SkipMount) { & (Join-Path $PSScriptRoot 'Initialize-WinWorkerDisk.ps1') -MountExisting -DriveLetter $manifest.Drive.Substring(0, 1) }
        Invoke-SeedDrive -Manifest $manifest -ManifestSha256 $manifestSha256 -Mode 'refresh'
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ refreshed = $true; manifestSha256 = $manifestSha256 }) -Compress))
        return
    }
    if (-not (Test-Path -LiteralPath $manifest.Drive)) { throw ('the drive ' + $manifest.Drive + ' is not mounted; run Initialize-WinWorkerDisk.ps1 first') }
    Invoke-SeedDrive -Manifest $manifest -ManifestSha256 $manifestSha256 -Mode 'seed'
    if ($SnapshotResourceGroup -or $SnapshotName -or $DiskResourceId) {
        if (-not ($SnapshotResourceGroup -and $SnapshotName -and $DiskResourceId)) { throw 'a snapshot needs -SnapshotResourceGroup, -SnapshotName and -DiskResourceId' }
        New-SeedSnapshot -Manifest $manifest
    }
    Write-Host ('Seeded ' + $manifest.Repositories.Count + ' repositories; manifest SHA-256 ' + $manifestSha256)
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Main
    } finally {
        if ($script:EmptyHooks) { Remove-Item -LiteralPath $script:EmptyHooks -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
