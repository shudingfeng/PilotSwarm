<#
.SYNOPSIS
Formats the data disk at LUN 0 as the ReFS Dev Drive Q:, or mounts an existing one.

.DESCRIPTION
Without -MountExisting, formats a new, empty disk at LUN 0 as a ReFS Dev Drive
(GPT, one partition, drive letter Q:), trusts it (fsutil devdrv trust) and
locks the roots down: Q:\ and Q:\Repos lose the create, append and write
entries Windows gives to Users, Authenticated Users and CREATOR OWNER, and
keep inherited Read+Execute (README, "Folders and access"). It refuses a disk
that already has partitions unless -Force is given.

With -MountExisting (used by Seed-WorkerReposDisk.ps1 -Refresh), brings an
existing Dev Drive at LUN 0 online as Q: with a disk GUID of its own, extends
the partition to the disk's full size, trusts it, and applies the root access
lists again.

Run as an administrator or LocalSystem.
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

function Set-DevDriveRootAcl {
    <# Q:\ and Q:\Repos: read and run for ordinary accounts, no folder creation; subfolders inherit Read+Execute. #>
    param([Parameter(Mandatory = $true)][string]$Letter)
    $users = '*' + (Get-WellKnownSid Users)
    $authenticated = '*' + (Get-WellKnownSid AuthenticatedUsers)
    $creatorOwner = '*' + (Get-WellKnownSid CreatorOwner)
    $root = $Letter + ':\'
    $repos = Join-Path $root 'Repos'
    [void](New-Item -ItemType Directory -Force -Path $repos)
    foreach ($path in @($root, $repos)) {
        Invoke-Icacls -Path $path -Arguments @('/remove:g', $users, $authenticated, $creatorOwner)
        Invoke-Icacls -Path $path -Arguments @('/grant:r', ($users + ':(OI)(CI)(RX)'), ($authenticated + ':(OI)(CI)(RX)'))
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
    Set-DevDriveRootAcl -Letter $DriveLetter
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
    Set-DevDriveRootAcl -Letter $DriveLetter
    Write-Host ('Mounted disk ' + $number + ' as the Dev Drive ' + $DriveLetter + ':')
}

function Invoke-Main {
    if (-not (Test-IsAdministrator)) { throw 'run Initialize-WinWorkerDisk.ps1 as an administrator or LocalSystem' }
    if ($MountExisting) { Mount-ExistingDevDrive } else { Initialize-NewDevDrive }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
