<#
.SYNOPSIS
Lists, and with -Apply removes, what sessions left in the worker image's scratch folder.

.DESCRIPTION
Deliberately narrow. It only touches C:\pilotswarm\temp, the folder the image
gives sessions without a workspace, and tools, for scratch files (TEMP and TMP
in worker.env). It never touches session state (C:\pilotswarm\copilot), the
releases, the Azure CLI configuration or the Dev Drive. The launcher clears
the same folder at every start of the worker service; this script is for an
operator who wants it empty without a restart.

It refuses while PilotSwarmWorker is not stopped, because running sessions
use the folder. Without -Apply it only lists what it would remove. It never
follows a link or a junction: it removes the link itself.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Root = 'C:\pilotswarm',
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
    [string]$ServiceName = 'PilotSwarmWorker',
    [switch]$Apply
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Remove-ScratchItem {
    <# Removes a file, a folder or a link; a link or a junction goes, never what it points to. #>
    param([Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item)
    if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        if ($Item.Attributes -band [System.IO.FileAttributes]::Directory) { [System.IO.Directory]::Delete($Item.FullName, $false) }
        else { [System.IO.File]::Delete($Item.FullName) }
        return
    }
    if ($Item.Attributes -band [System.IO.FileAttributes]::Directory) {
        foreach ($child in ([System.IO.DirectoryInfo]$Item).EnumerateFileSystemInfos()) { Remove-ScratchItem -Item $child }
        [System.IO.Directory]::Delete($Item.FullName, $false)
        return
    }
    if ($Item.Attributes -band [System.IO.FileAttributes]::ReadOnly) { $Item.Attributes = $Item.Attributes -bxor [System.IO.FileAttributes]::ReadOnly }
    [System.IO.File]::Delete($Item.FullName)
}

function Invoke-Main {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        throw ('refusing: ' + $ServiceName + ' is ' + $service.Status + ', and its sessions use the scratch folder; stop it first (Drain-And-StopWorker.ps1)')
    }
    $scratch = Join-Path $Root 'temp'
    if (-not (Test-Path -LiteralPath $scratch -PathType Container)) {
        Write-Host ('There is no ' + $scratch)
        return
    }
    $items = @((New-Object System.IO.DirectoryInfo $scratch).EnumerateFileSystemInfos())
    if ($items.Count -eq 0) {
        Write-Host ($scratch + ' is empty')
        return
    }
    $failed = 0
    foreach ($item in $items) {
        $kind = 'file'
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $kind = 'link' }
        elseif ($item.Attributes -band [System.IO.FileAttributes]::Directory) { $kind = 'folder' }
        if (-not $Apply) {
            Write-Host ('Would remove ' + $kind + ' ' + $item.FullName + ' (last written ' + $item.LastWriteTimeUtc.ToString('u') + ')')
            continue
        }
        try {
            Remove-ScratchItem -Item $item
            Write-Host ('Removed ' + $kind + ' ' + $item.FullName)
        } catch {
            $failed++
            Write-Warning ('Could not remove ' + $item.FullName + ': ' + $_.Exception.Message)
        }
    }
    if (-not $Apply) { Write-Host ('Dry run: ' + $items.Count + ' item(s) in ' + $scratch + '; run again with -Apply to remove them') }
    elseif ($failed) { throw ($failed.ToString() + ' item(s) could not be removed') }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
