<#
.SYNOPSIS
Formats the data disk at LUN 0 as the ReFS Dev Drive Q:, or mounts an existing one.

.DESCRIPTION
Without -MountExisting, formats a new, empty disk at LUN 0 as a ReFS Dev Drive
(GPT, one partition, drive letter Q:), trusts it (fsutil devdrv trust) and
locks the roots down: Q:\ gives SYSTEM and Administrators Full Control and
the worker's account Read+Execute, inherited by everything below, and no one
else any access (no Everyone, Users, Authenticated Users or CREATOR OWNER);
Q:\Repos keeps only what it inherits (README, "Folders and access"). It
refuses a disk that already has partitions unless -Force is given.

With -MountExisting (used by Seed-WorkerReposDisk.ps1 -Refresh), brings an
existing Dev Drive at LUN 0 online as Q: with a disk GUID of its own, extends
the partition to the disk's full size, trusts it, and applies the root access
lists again where they differ.

Run as an administrator or LocalSystem, on a VM built from the worker image:
icacls can grant to NT SERVICE\PilotSwarmWorker only where its service is
installed.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[D-Z]$')]
    [string]$DriveLetter = 'Q',
    [string]$Label = 'PilotSwarmDevDrive',
    [switch]$MountExisting,
    [switch]$Force
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

function Test-DevDriveRootAcl {
    <# Whether the root's access list is already exactly what Set-DevDriveRootAcl writes, so a mount need not walk the drive again. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $full = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
    $expected = @{}
    $expected[(Get-WellKnownSid System)] = $full
    $expected[(Get-WellKnownSid Administrators)] = $full
    $expected[(Get-WorkerServiceSid)] = [int64][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $synchronize = [int64][System.Security.AccessControl.FileSystemRights]::Synchronize
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { return $false }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or -not $expected.ContainsKey($sid)) { return $false }
        if ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or $rule.PropagationFlags -ne 'None') { return $false }
        if ((([int64]$rule.FileSystemRights) -bor $synchronize) -ne ($expected[$sid] -bor $synchronize)) { return $false }
        $expected.Remove($sid)
    }
    return $true
}

function Set-DevDriveRootAcl {
    <#
    The drive's root: SYSTEM and Administrators Full Control and the worker Read+Execute, inherited by everything
    below, and nothing else, so no other account on the VM can read the drive and the worker creates nothing at its
    root. The repositories' root keeps only what it inherits. The seed grants the worker Modify on its manifest's
    folders. Each change makes Windows walk the drive, so a list that is already right is left alone.
    #>
    param([Parameter(Mandatory = $true)][string]$Root)
    $system = Get-WellKnownSid System
    $administrators = Get-WellKnownSid Administrators
    $worker = Get-WorkerServiceSid
    $repos = Join-Path $Root 'Repos'
    [void](New-Item -ItemType Directory -Force -Path $repos)
    if (-not (Test-DevDriveRootAcl -Path $Root)) {
        Invoke-Icacls -Path $Root -Arguments @('/inheritance:r', '/grant:r', ('*' + $system + ':(OI)(CI)(F)'), ('*' + $administrators + ':(OI)(CI)(F)'), ('*' + $worker + ':(OI)(CI)(RX)'))
        $kept = @($system, $administrators, $worker)
        $rules = @((Get-Acl -LiteralPath $Root).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
        $others = @($rules | Where-Object { $kept -notcontains $_.IdentityReference.Value } | ForEach-Object { '*' + $_.IdentityReference.Value } | Select-Object -Unique)
        if ($others.Count) { Invoke-Icacls -Path $Root -Arguments (@('/remove') + $others) }
        $denied = @($rules | Where-Object { $_.AccessControlType -eq 'Deny' -and $kept -contains $_.IdentityReference.Value } | ForEach-Object { '*' + $_.IdentityReference.Value } | Select-Object -Unique)
        if ($denied.Count) { Invoke-Icacls -Path $Root -Arguments (@('/remove:d') + $denied) }
        if (-not (Test-DevDriveRootAcl -Path $Root)) { throw ('the access list of ' + $Root + ' is still not SYSTEM and Administrators Full Control and the worker Read+Execute alone') }
    }
    $reposAcl = Get-Acl -LiteralPath $repos
    if ($reposAcl.AreAccessRulesProtected -or @($reposAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])).Count) {
        Invoke-Icacls -Path $repos -Arguments @('/reset')
    }
}

function Set-DevDriveTrust {
    param([Parameter(Mandatory = $true)][string]$Letter)
    [void](Invoke-NativeCommand -FilePath (Join-Path $env:SystemRoot 'System32\fsutil.exe') -ArgumentList @('devdrv', 'trust', ($Letter + ':')))
}

function Get-DataPartition([int]$Number) {
    $partition = Get-Partition -DiskNumber $Number | Where-Object { $_.Type -eq 'Basic' } | Sort-Object -Property Size -Descending | Select-Object -First 1
    if (-not $partition) { throw 'the disk at LUN 0 has no data partition' }
    return $partition
}

function Initialize-NewDevDrive {
    $number = Get-Lun0DiskNumber
    if ($null -eq $number) { throw 'no data disk is attached at LUN 0' }
    $disk = Get-Disk -Number $number
    if ($disk.IsOffline) { Set-Disk -Number $number -IsOffline $false }
    if ($disk.IsReadOnly) { Set-Disk -Number $number -IsReadOnly $false }
    $disk = Get-Disk -Number $number
    if ($disk.PartitionStyle -ne 'RAW') {
        if (-not $Force) { throw ('the disk at LUN 0 already has partitions (' + $disk.PartitionStyle + '); pass -Force to erase it') }
        Clear-Disk -Number $number -RemoveData -RemoveOEM -Confirm:$false
    }
    if (Get-Volume -DriveLetter $DriveLetter -ErrorAction SilentlyContinue) { throw ('drive ' + $DriveLetter + ': is already in use') }
    Initialize-Disk -Number $number -PartitionStyle GPT
    $partition = New-Partition -DiskNumber $number -UseMaximumSize -DriveLetter $DriveLetter
    [void](Format-Volume -Partition $partition -FileSystem ReFS -DevDrive -NewFileSystemLabel $Label -Confirm:$false -Force)
    Set-DevDriveTrust -Letter $DriveLetter
    Set-DevDriveRootAcl -Root ($DriveLetter + ':\')
    Write-Host ('Formatted disk ' + $number + ' as the ReFS Dev Drive ' + $DriveLetter + ':')
}

function Mount-ExistingDevDrive {
    $number = $null
    $deadline = (Get-Date).AddMinutes(2)
    while ($null -eq $number) {
        Update-HostStorageCache
        $number = Get-Lun0DiskNumber
        if ($null -eq $number) {
            if ((Get-Date) -gt $deadline) { throw 'no data disk is attached at LUN 0' }
            Start-Sleep -Seconds 5
        }
    }
    $disk = Get-Disk -Number $number
    if ($disk.IsOffline) { Set-Disk -Number $number -IsOffline $false }
    if ((Get-Disk -Number $number).IsReadOnly) { Set-Disk -Number $number -IsReadOnly $false }
    if ((Get-Disk -Number $number).PartitionStyle -ne 'GPT') { throw 'the disk at LUN 0 is not a GPT Dev Drive' }
    # Every drive is a copy of the same snapshot: this one gets a disk GUID of its own.
    Set-Disk -Number $number -Guid ('{' + [guid]::NewGuid().ToString() + '}')
    Update-HostStorageCache
    $partition = Get-DataPartition $number
    if ([string]$partition.DriveLetter -ne $DriveLetter) {
        if (Get-Volume -DriveLetter $DriveLetter -ErrorAction SilentlyContinue) { throw ('drive ' + $DriveLetter + ': is already in use by another volume') }
        Set-Partition -DiskNumber $number -PartitionNumber $partition.PartitionNumber -NewDriveLetter $DriveLetter
    }
    $supported = Get-PartitionSupportedSize -DiskNumber $number -PartitionNumber $partition.PartitionNumber
    if (($supported.SizeMax - (Get-Partition -DiskNumber $number -PartitionNumber $partition.PartitionNumber).Size) -ge 1MB) {
        Resize-Partition -DiskNumber $number -PartitionNumber $partition.PartitionNumber -Size $supported.SizeMax
    }
    if ((Get-Volume -DriveLetter $DriveLetter).FileSystemType -ne 'ReFS') { throw ('drive ' + $DriveLetter + ': is not a ReFS Dev Drive') }
    Set-DevDriveTrust -Letter $DriveLetter
    Set-DevDriveRootAcl -Root ($DriveLetter + ':\')
    Write-Host ('Mounted disk ' + $number + ' as the Dev Drive ' + $DriveLetter + ':')
}

function Invoke-Main {
    if (-not (Test-IsAdministrator)) { throw 'run Initialize-WinWorkerDisk.ps1 as an administrator or LocalSystem' }
    # Before any change to the disk: the root's access list names the worker's account.
    [void](Assert-WorkerServiceSid)
    if ($MountExisting) { Mount-ExistingDevDrive } else { Initialize-NewDevDrive }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
