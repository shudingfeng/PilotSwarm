<#
.SYNOPSIS
Seeds the golden Dev Drive from the seed manifest, refreshes it (-Refresh) or verifies it (-Verify).

.DESCRIPTION
The seed manifest (README, "The seed manifest") names the repositories to
clone (full history, LFS when asked, and all, none or a list of their
submodules), the package caches to fill, the folders to create with the
worker account's access, and the folders to empty just before the snapshot.
The image keeps it at C:\pilotswarm\seed-manifest.json, where -Refresh and
-Verify find it without arguments.

Seeding, as an administrator, on a VM built from the worker image (icacls
can name NT SERVICE\PilotSwarmWorker only where its service is installed)
whose LUN 0 holds a Dev Drive that Initialize-WinWorkerDisk.ps1 formatted:
  1. creates the manifest's folders and grants NT SERVICE\PilotSwarmWorker
     Modify on the Modify ones (by its SID, which sc.exe showsid confirms);
     a Read folder keeps the read access it inherits from the drive's root;
  2. clones each repository at its branch (or fetches it again), with its
     submodules (all of them at the commits it pins, or only the listed
     ones, each at the pinned commit or at the tip of its own branch) and
     LFS objects, and fills each package cache, every command with Git's
     prompts turned off;
  3. removes any hook from each Git directory (Git's *.sample files stay);
  4. writes each repository's and submodule's clean-detach record,
     pilotswarm-clean-tips: the object IDs of HEAD and of every ref;
  5. makes the worker service the owner of each repository's folder and .git,
     and of each submodule's folder, .git file and Git directory, so Git run
     as the service accepts them without a safe.directory entry;
  6. empties each beforeSnapshot folder, keeping the folder and its grant;
  7. records what it fetched in <drive>\.pilotswarm\seed-state.json;
  8. with -SnapshotResourceGroup, -SnapshotName and -DiskResourceId, takes an
     incremental snapshot of the drive and waits, as the controller's refresh
     does, until Azure reports it Succeeded and fully copied; it stops when
     provisioning fails.

-Refresh, as LocalSystem from the disk controller's Managed Run Command,
mounts the drive (Initialize-WinWorkerDisk.ps1 -MountExisting) and runs steps
1 to 7 again: fetches, updates the caches, and writes access lists, owners and
records again. Its Git calls pass -c safe.directory=*, since LocalSystem does
not own the repositories.

-Verify checks the drive and prints, as its last line, one JSON object:
  {"verified": true|false, "manifestSha256": "<64 hex>", "checks": {...}}
where each check is true or a list of what failed; a manifest with
beforeSnapshot steps adds the check "emptied". It exits 0 only when every
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

function Test-SeedBranchName {
    param($Name)
    return -not ($null -eq $Name -or $Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $Name -match '\.\.|//|\.lock$')
}

function Assert-SeedNotes {
    <# notes, wherever the manifest allows it, is free text for people; the seed never reads it. #>
    param($Object, [Parameter(Mandatory = $true)][string]$Where)
    if ((Test-JsonProperty $Object 'notes') -and $Object.notes -isnot [string]) { throw ('seed manifest: ' + $Where + ': notes must be a string') }
}

function Test-SeedManifest {
    <# Checks a seed manifest (schemaVersion 1) and returns it with each repository's folder; throws on the first problem. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $known = @('schemaVersion', 'notes', 'reposRoot', 'repositories', 'modifyFolders', 'folders', 'packageCaches', 'beforeSnapshot', 'env')
    foreach ($name in $Manifest.PSObject.Properties.Name) { if ($known -notcontains $name) { throw ('seed manifest: unknown field ' + $name) } }
    if (-not (Test-JsonProperty $Manifest 'schemaVersion') -or $Manifest.schemaVersion -ne 1) { throw 'seed manifest: schemaVersion must be 1' }
    Assert-SeedNotes $Manifest 'the manifest'
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
    $onDrive = {
        param($Folder, [string]$What)
        if ($Folder -isnot [string] -or -not [System.IO.Path]::IsPathRooted($Folder)) { throw ('seed manifest: ' + $What + ' ' + $Folder + ' must be an absolute path') }
        $full = [System.IO.Path]::GetFullPath($Folder).TrimEnd('\', '/')
        if (-not (& $inside $full $drive) -or $full.Length -le $drive.TrimEnd('\', '/').Length) { throw ('seed manifest: ' + $What + ' ' + $Folder + ' must be a folder on the drive of reposRoot') }
        return $full
    }
    $modify = @()
    if (Test-JsonProperty $Manifest 'modifyFolders') {
        foreach ($folder in @($Manifest.modifyFolders)) {
            $full = & $onDrive $folder 'modify folder'
            if ($full -ieq $reposRoot) { throw 'seed manifest: reposRoot itself stays read-only; grant Modify on folders inside it' }
            $modify += $full
        }
    }
    # folders: each created by the seed, with the worker's access; modify ones join modifyFolders.
    $read = @()
    $listed = @{}
    foreach ($folder in $modify) { $listed[$folder.ToLowerInvariant()] = 'modify' }
    if (Test-JsonProperty $Manifest 'folders') {
        foreach ($entry in @($Manifest.folders)) {
            if ($entry -isnot [System.Management.Automation.PSCustomObject]) { throw 'seed manifest: each folders entry is an object with path and access' }
            foreach ($field in $entry.PSObject.Properties.Name) {
                if (@('path', 'access', 'notes') -notcontains $field) { throw ('seed manifest: a folder has an unknown field ' + $field) }
            }
            if (-not (Test-JsonProperty $entry 'path')) { throw 'seed manifest: every folder needs a path' }
            $where = 'folder ' + $entry.path
            $full = & $onDrive $entry.path 'folder'
            if (-not (Test-JsonProperty $entry 'access') -or @('modify', 'read') -notcontains $entry.access) { throw ('seed manifest: ' + $where + ': access is "modify" or "read"') }
            Assert-SeedNotes $entry $where
            if ($listed.ContainsKey($full.ToLowerInvariant())) { throw ('seed manifest: the ' + $where + ' is listed twice') }
            $listed[$full.ToLowerInvariant()] = $entry.access.ToLowerInvariant()
            if ($entry.access -eq 'modify') {
                if ($full -ieq $reposRoot) { throw 'seed manifest: reposRoot itself stays read-only; grant Modify on folders inside it' }
                $modify += $full
            } else {
                $read += $full
            }
        }
    }
    foreach ($folder in $read) {
        if ($modify | Where-Object { & $inside $folder $_ }) { throw ('seed manifest: the read folder ' + $folder + ' is inside a modify folder, so the worker could change it') }
    }
    $repositories = @()
    $names = @{}
    if (-not (Test-JsonProperty $Manifest 'repositories') -or @($Manifest.repositories).Count -eq 0) { throw 'seed manifest: repositories must list at least one repository' }
    foreach ($repo in @($Manifest.repositories)) {
        foreach ($field in $repo.PSObject.Properties.Name) {
            if (@('name', 'url', 'branch', 'submodules', 'lfs', 'notes') -notcontains $field) { throw ('seed manifest: a repository has an unknown field ' + $field) }
        }
        if (-not (Test-JsonProperty $repo 'name') -or $repo.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'seed manifest: every repository needs a name of letters, digits, _ . -' }
        if ($names.ContainsKey($repo.name.ToLowerInvariant())) { throw ('seed manifest: the repository ' + $repo.name + ' is listed twice') }
        $names[$repo.name.ToLowerInvariant()] = $true
        if (-not (Test-JsonProperty $repo 'url') -or $repo.url -notmatch '^(https|file)://') { throw ('seed manifest: repository ' + $repo.name + ' needs an https:// (or file://) url') }
        if ($repo.url -match '^https://[^/]*@') { throw ('seed manifest: repository ' + $repo.name + ' has credentials in its url') }
        if (-not (Test-JsonProperty $repo 'branch') -or -not (Test-SeedBranchName $repo.branch)) { throw ('seed manifest: repository ' + $repo.name + ' needs a branch name') }
        Assert-SeedNotes $repo ('repository ' + $repo.name)
        $lfs = $false
        if (Test-JsonProperty $repo 'lfs') {
            if (@($true, $false, 'all') -notcontains $repo.lfs) { throw ('seed manifest: repository ' + $repo.name + ': lfs is true, false or "all"') }
            $lfs = $repo.lfs
        }
        $path = [System.IO.Path]::Combine($reposRoot, [string]$repo.name)
        # submodules: true (all, recursively, at the commits the repository pins), false, or a list of the ones to check out.
        $submodules = $true
        $submoduleList = @()
        if ((Test-JsonProperty $repo 'submodules') -and $repo.submodules -is [System.Array]) {
            $submodules = $false
            $paths = @{}
            foreach ($entry in @($repo.submodules)) {
                if ($entry -isnot [System.Management.Automation.PSCustomObject]) { throw ('seed manifest: repository ' + $repo.name + ': each submodules entry is an object with a path') }
                foreach ($field in $entry.PSObject.Properties.Name) {
                    if (@('path', 'branch', 'notes') -notcontains $field) { throw ('seed manifest: repository ' + $repo.name + ': a submodule has an unknown field ' + $field) }
                }
                $subPath = ''
                if ((Test-JsonProperty $entry 'path') -and $entry.path -is [string]) { $subPath = $entry.path.Replace('\', '/').Trim('/') }
                if ($subPath -notmatch '^[A-Za-z0-9._][A-Za-z0-9._ /-]{0,199}$' -or $subPath -match '(^|/)\.{1,2}(/|$)|(^|/)\.git(/|$)|//') {
                    throw ('seed manifest: repository ' + $repo.name + ': a submodule needs its relative path inside the repository')
                }
                if ($paths.ContainsKey($subPath.ToLowerInvariant())) { throw ('seed manifest: repository ' + $repo.name + ': the submodule ' + $subPath + ' is listed twice') }
                $paths[$subPath.ToLowerInvariant()] = $true
                $branch = $null
                if (Test-JsonProperty $entry 'branch') {
                    if (-not (Test-SeedBranchName $entry.branch)) { throw ('seed manifest: repository ' + $repo.name + ': the submodule ' + $subPath + ' needs a branch name') }
                    $branch = $entry.branch
                }
                Assert-SeedNotes $entry ('repository ' + $repo.name + ', submodule ' + $subPath)
                $submoduleList += [pscustomobject]@{ Path = $subPath; Branch = $branch; Folder = [System.IO.Path]::Combine($path, $subPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)) }
            }
        } elseif (Test-JsonProperty $repo 'submodules') {
            $submodules = [bool]$repo.submodules
        }
        if (-not ($modify | Where-Object { ($_ -ieq $path) -or (& $inside $path $_) })) { throw ('seed manifest: no modify folder covers ' + $path + '; the worker could not change the repository') }
        $repositories += [pscustomobject]@{ Name = $repo.name; Url = $repo.url; Branch = $repo.branch; Submodules = $submodules; SubmoduleList = $submoduleList; Lfs = $lfs; Path = $path }
    }
    $caches = @()
    if (Test-JsonProperty $Manifest 'packageCaches') {
        foreach ($cache in @($Manifest.packageCaches)) {
            foreach ($field in $cache.PSObject.Properties.Name) {
                if (@('name', 'workingDirectory', 'command', 'env', 'notes') -notcontains $field) { throw ('seed manifest: a package cache has an unknown field ' + $field) }
            }
            if (-not (Test-JsonProperty $cache 'name') -or $cache.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'seed manifest: every package cache needs a name' }
            if (-not (Test-JsonProperty $cache 'command') -or @($cache.command).Count -lt 1 -or @($cache.command | Where-Object { $_ -isnot [string] }).Count) { throw ('seed manifest: package cache ' + $cache.name + ' needs a command list') }
            if (-not (Test-JsonProperty $cache 'workingDirectory') -or -not [System.IO.Path]::IsPathRooted([string]$cache.workingDirectory)) { throw ('seed manifest: package cache ' + $cache.name + ' needs an absolute workingDirectory') }
            Assert-SeedNotes $cache ('package cache ' + $cache.name)
            $caches += [pscustomobject]@{ Name = $cache.name; WorkingDirectory = [string]$cache.workingDirectory; Command = @($cache.command); Env = (ConvertTo-EnvTable $cache 'env' ('package cache ' + $cache.name)) }
        }
    }
    # beforeSnapshot: what the seed and its refresh do last, so the snapshot does not carry it to every drive.
    $beforeSnapshot = @()
    if (Test-JsonProperty $Manifest 'beforeSnapshot') {
        foreach ($step in @($Manifest.beforeSnapshot)) {
            if ($step -isnot [System.Management.Automation.PSCustomObject]) { throw 'seed manifest: each beforeSnapshot step is an object' }
            foreach ($field in $step.PSObject.Properties.Name) {
                if (@('emptyFolder', 'reason', 'notes') -notcontains $field) { throw ('seed manifest: a beforeSnapshot step has an unknown field ' + $field) }
            }
            if (-not (Test-JsonProperty $step 'emptyFolder')) { throw 'seed manifest: each beforeSnapshot step names its emptyFolder' }
            $full = & $onDrive $step.emptyFolder 'beforeSnapshot folder'
            if (-not (Test-JsonProperty $step 'reason') -or $step.reason -isnot [string] -or -not $step.reason.Trim()) { throw ('seed manifest: the beforeSnapshot step that empties ' + $step.emptyFolder + ' needs a reason') }
            Assert-SeedNotes $step ('the beforeSnapshot step that empties ' + $step.emptyFolder)
            if (-not $listed.ContainsKey($full.ToLowerInvariant())) { throw ('seed manifest: beforeSnapshot empties only folders the manifest lists, and ' + $step.emptyFolder + ' is not one') }
            foreach ($repository in $repositories) {
                if (($full -ieq $repository.Path) -or (& $inside $full $repository.Path) -or (& $inside $repository.Path $full)) {
                    throw ('seed manifest: beforeSnapshot may not empty ' + $step.emptyFolder + ', which would delete files of the repository ' + $repository.Name)
                }
            }
            # The seed creates and grants every listed folder before it empties these: one inside would go, grant and all.
            foreach ($other in @($modify + $read)) {
                if (($other -ine $full) -and (& $inside $other $full)) {
                    throw ('seed manifest: beforeSnapshot may not empty ' + $step.emptyFolder + ', which would delete the listed folder ' + $other + ' inside it')
                }
            }
            if ($beforeSnapshot | Where-Object { $_.EmptyFolder -ieq $full }) { throw ('seed manifest: beforeSnapshot empties ' + $step.emptyFolder + ' twice') }
            $beforeSnapshot += [pscustomobject]@{ EmptyFolder = $full; Reason = $step.reason.Trim() }
        }
    }
    return [pscustomobject]@{
        ReposRoot      = $reposRoot
        Drive          = $drive
        Repositories   = $repositories
        ModifyFolders  = $modify
        ReadFolders    = $read
        PackageCaches  = $caches
        BeforeSnapshot = $beforeSnapshot
        Env            = (ConvertTo-EnvTable $Manifest 'env' 'the manifest')
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
    # A list checks out only the submodules it names, without their own submodules, each at the commit the
    # repository pins or at the tip of its own branch.
    foreach ($submodule in @($Repository.SubmoduleList)) {
        Write-Host ('Checking out the submodule ' + $submodule.Path + ' of ' + $Repository.Name)
        [void](Invoke-SeedGit -Repo $path -Arguments @('submodule', 'update', '--init', '--force', '--', $submodule.Path))
        # Without its own .git, a Git command in the folder would act on the repository around it.
        if (-not (Test-Path -LiteralPath (Join-Path $submodule.Folder '.git'))) { throw ($submodule.Path + ' is not a submodule of ' + $Repository.Name) }
        if ($submodule.Branch) {
            [void](Invoke-SeedGit -Repo $submodule.Folder -Arguments @('fetch', '--prune', '--tags', 'origin'))
            [void](Invoke-SeedGit -Repo $submodule.Folder -Arguments @('checkout', '--force', '-B', $submodule.Branch, ('refs/remotes/origin/' + $submodule.Branch)))
        }
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
    # The same non-interactive Git as the clones: a restore that calls git must fail, not wait for a prompt.
    $environment = @{}
    foreach ($name in $script:GitEnvironment.Keys) { $environment[$name] = $script:GitEnvironment[$name] }
    foreach ($name in $Manifest.Env.Keys) { $environment[$name] = $Manifest.Env[$name] }
    foreach ($name in $Cache.Env.Keys) { $environment[$name] = $Cache.Env[$name] }
    $rest = @()
    if ($Cache.Command.Count -gt 1) { $rest = $Cache.Command[1..($Cache.Command.Count - 1)] }
    [void](Invoke-NativeCommand -FilePath $Cache.Command[0] -ArgumentList $rest -WorkingDirectory $Cache.WorkingDirectory -Environment $environment)
}

function Clear-SeedFolder {
    <# A beforeSnapshot step: deletes what the folder holds, never the folder itself or its grant, and never through a link. #>
    param([Parameter(Mandatory = $true)]$Step)
    $folder = $Step.EmptyFolder
    Write-Host ('Emptying ' + $folder + ' before the snapshot: ' + $Step.Reason)
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw ('the folder ' + $folder + ' to empty before the snapshot does not exist') }
    if ((Get-Item -LiteralPath $folder -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ($folder + ' is a link; the seed empties only a folder') }
    foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force)) { Remove-LinkSafeItem -Path $item.FullName }
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
    foreach ($repo in $Manifest.Repositories) {
        $repos[$repo.Name] = Get-RemoteRefs -Path $repo.Path
        # A submodule at its own branch: under <repository>/<path>, a key no repository name can take.
        foreach ($submodule in @($repo.SubmoduleList | Where-Object { $_.Branch })) { $repos[$repo.Name + '/' + $submodule.Path] = Get-RemoteRefs -Path $submodule.Folder }
    }
    $state = [ordered]@{ schemaVersion = 1; mode = $Mode; at = (Get-Date).ToUniversalTime().ToString('o'); manifestSha256 = $ManifestSha256; remoteRefs = $repos }
    Write-Utf8File -Path (Get-SeedStatePath $Manifest) -Content (ConvertTo-Json -InputObject $state -Depth 6)
}

function Invoke-SeedDrive {
    <# Steps 1 to 7: folders, repositories, caches, hooks, records, owners, the steps before the snapshot, seed state. #>
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestSha256, [Parameter(Mandatory = $true)][string]$Mode)
    [void](Assert-WorkerServiceSid)
    [void](New-Item -ItemType Directory -Force -Path $Manifest.ReposRoot)
    foreach ($folder in $Manifest.ModifyFolders) { Grant-ModifyFolder -Path $folder }
    # A read folder only exists: it keeps the read access it inherits from the drive's root.
    foreach ($folder in $Manifest.ReadFolders) { [void](New-Item -ItemType Directory -Force -Path $folder) }
    foreach ($repo in $Manifest.Repositories) { Update-SeedRepository -Repository $repo -ReposRoot $Manifest.ReposRoot }
    foreach ($cache in $Manifest.PackageCaches) { Invoke-PackageCache -Cache $cache -Manifest $Manifest }
    foreach ($repo in $Manifest.Repositories) {
        Remove-RepositoryHooks -Path $repo.Path
        [void](Write-CleanTipsRecords -Path $repo.Path)
    }
    # Owners last: Git run as the service must find it owns each repository.
    foreach ($repo in $Manifest.Repositories) { Set-RepositoryOwners -Path $repo.Path }
    foreach ($step in $Manifest.BeforeSnapshot) { Clear-SeedFolder -Step $step }
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

function Get-WriteMask {
    # The rights that change a folder or what it holds, the generic write and all rights included.
    return ([int64][System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership') -bor 0x50000000
}

function Test-WorkerMayWrite {
    <# Whether the worker, or a group every service's token holds (Everyone, Users, Authenticated Users, SERVICE), may change the folder or what it holds. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $who = @((Get-WorkerServiceSid), (Get-WellKnownSid Everyone), (Get-WellKnownSid Users), (Get-WellKnownSid AuthenticatedUsers), 'S-1-5-6')
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $who -contains $rule.IdentityReference.Value -and (([int64]$rule.FileSystemRights) -band (Get-WriteMask))) { return $true }
    }
    return $false
}

function Get-RootAclFailures {
    <#
    The drive's root and the repositories' root give access only to SYSTEM, Administrators and the worker, and the
    worker only reads: Initialize-WinWorkerDisk.ps1 sets that, and every folder the seed does not grant inherits it.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $worker = Get-WorkerServiceSid
    $allowed = @((Get-WellKnownSid System), (Get-WellKnownSid Administrators), $worker)
    $failures = @()
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        $who = $rule.IdentityReference.Value
        if ($allowed -notcontains $who) { $failures += ($Path + ': ' + $who + ' has access') }
        elseif ($who -eq $worker -and (([int64]$rule.FileSystemRights) -band (Get-WriteMask))) { $failures += ($Path + ': the worker may write') }
    }
    return @($failures | Select-Object -Unique)
}

function Get-BranchFailure {
    <# $null when the clone at Path is on Branch at the fetched commit; otherwise what is wrong. #>
    param([Parameter(Mandatory = $true)][string]$Label, [Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Branch)
    $head = (Invoke-SeedGit -Repo $Path -Arguments @('rev-parse', 'HEAD')).StdOut.Trim()
    $current = (Invoke-SeedGit -Repo $Path -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -NoThrow).StdOut.Trim()
    $fetched = (Invoke-SeedGit -Repo $Path -Arguments @('rev-parse', ('refs/remotes/origin/' + $Branch)) -NoThrow).StdOut.Trim()
    if ($current -ne $Branch) { return ($Label + ': HEAD is ' + $current + ', not ' + $Branch) }
    if ($head -ne $fetched) { return ($Label + ': ' + $Branch + ' is not at the fetched commit') }
    return $null
}

function Get-RecordedRefsFailure {
    <# $null when the fetched refs at Path are the ones the seed recorded under Key; otherwise what is wrong. #>
    param($State, [Parameter(Mandatory = $true)][string]$Key, [Parameter(Mandatory = $true)][string]$Path)
    if (-not $State -or -not (Test-JsonProperty $State.remoteRefs $Key)) { return ($Key + ': the seed recorded no fetched refs') }
    $recorded = $State.remoteRefs.($Key)
    $current = Get-RemoteRefs -Path $Path
    $recordedNames = @($recorded.PSObject.Properties.Name)
    if ($recordedNames.Count -ne $current.Count -or @($recordedNames | Where-Object { $current[$_] -ne $recorded.$_ }).Count) {
        return ($Key + ': the fetched refs differ from the ones the seed recorded')
    }
    return $null
}

function Test-SeedDrive {
    <# The -Verify checks; returns failures by check. #>
    param([Parameter(Mandatory = $true)]$Manifest)
    $failures = [ordered]@{ refs = @(); fsck = @(); hooks = @(); cleanRecord = @(); owner = @(); acl = @() }
    # Only a manifest with beforeSnapshot steps adds the check, so an older manifest's result keeps its form.
    if (@($Manifest.BeforeSnapshot).Count) { $failures['emptied'] = @() }
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
            $message = Get-BranchFailure -Label $repo.Name -Path $repo.Path -Branch $repo.Branch
            if ($message) { $failures.refs += $message }
            $message = Get-RecordedRefsFailure -State $state -Key $repo.Name -Path $repo.Path
            if ($message) { $failures.refs += $message }
            # A listed submodule is checked out: at its own branch, the same way, or at the commit the repository pins.
            foreach ($submodule in @($repo.SubmoduleList)) {
                $label = $repo.Name + '/' + $submodule.Path
                if (-not (Test-Path -LiteralPath (Join-Path $submodule.Folder '.git'))) {
                    $failures.refs += ($label + ': not checked out')
                    continue
                }
                if ($submodule.Branch) {
                    $message = Get-BranchFailure -Label $label -Path $submodule.Folder -Branch $submodule.Branch
                    if ($message) { $failures.refs += $message }
                    $message = Get-RecordedRefsFailure -State $state -Key $label -Path $submodule.Folder
                    if ($message) { $failures.refs += $message }
                } else {
                    $pinned = (Invoke-SeedGit -Repo $repo.Path -Arguments @('rev-parse', ('HEAD:' + $submodule.Path))).StdOut.Trim()
                    $head = (Invoke-SeedGit -Repo $submodule.Folder -Arguments @('rev-parse', 'HEAD')).StdOut.Trim()
                    if ($head -ne $pinned) { $failures.refs += ($label + ': not at the commit ' + $repo.Name + ' pins') }
                }
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
    foreach ($folder in $Manifest.ReadFolders) {
        try {
            if (-not (Test-Path -LiteralPath $folder -PathType Container)) { $failures.acl += ($folder + ': missing') }
            elseif (Test-WorkerMayWrite -Path $folder) { $failures.acl += ($folder + ': the worker may write') }
        } catch {
            $failures.acl += ($folder + ': ' + $_.Exception.Message)
        }
    }
    foreach ($root in @($Manifest.Drive, $Manifest.ReposRoot)) {
        try {
            $failures.acl += @(Get-RootAclFailures -Path $root)
        } catch {
            $failures.acl += ($root + ': ' + $_.Exception.Message)
        }
    }
    foreach ($step in @($Manifest.BeforeSnapshot)) {
        try {
            if (-not (Test-Path -LiteralPath $step.EmptyFolder -PathType Container)) { $failures.emptied += ($step.EmptyFolder + ': missing') }
            elseif (@(Get-ChildItem -LiteralPath $step.EmptyFolder -Force).Count) { $failures.emptied += ($step.EmptyFolder + ': not empty') }
        } catch {
            $failures.emptied += ($step.EmptyFolder + ': ' + $_.Exception.Message)
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
