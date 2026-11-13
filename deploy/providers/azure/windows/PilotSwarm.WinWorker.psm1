# Helpers shared by the Windows worker scripts in this folder. The image
# installs them next to the scripts, in C:\pilotswarm\scripts. Windows
# PowerShell 5.1 and PowerShell 7 both load this module.

Set-StrictMode -Version 3.0

# The worker service and its virtual account. A service SID derives from the
# service name alone, so it is the same on every machine.
$script:WorkerServiceName = 'PilotSwarmWorker'
$script:WorkerServiceSid = 'S-1-5-80-3872531353-3733398320-4078817223-2862367190-1897339925'

# Well-known SIDs: names differ between Windows languages, SIDs do not.
$script:WellKnownSid = @{
    System             = 'S-1-5-18'
    Administrators     = 'S-1-5-32-544'
    Users              = 'S-1-5-32-545'
    AuthenticatedUsers = 'S-1-5-11'
    CreatorOwner       = 'S-1-3-0'
    Everyone           = 'S-1-1-0'
    Interactive        = 'S-1-5-4'
}

function Test-WindowsHost { return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT }

function Join-WindowsPath {
    <# A Windows path from a base and a child, joined with \ on any host (Join-Path uses / on Linux). #>
    param([Parameter(Mandatory = $true)][string]$Base, [Parameter(Mandatory = $true)][string]$Child)
    return ($Base.TrimEnd('\', '/') + '\' + $Child.TrimStart('\', '/'))
}

function Get-WorkerServiceName { return $script:WorkerServiceName }

function Get-WorkerServiceSid { return $script:WorkerServiceSid }

function Get-WellKnownSid {
    param([Parameter(Mandatory = $true)][ValidateSet('System', 'Administrators', 'Users', 'AuthenticatedUsers', 'CreatorOwner', 'Everyone', 'Interactive')][string]$Name)
    return $script:WellKnownSid[$Name]
}

function Get-ServiceSidFromName {
    <# The SID of NT SERVICE\<Name>: S-1-5-80 and the SHA-1 of the upper-case name in UTF-16LE as five integers. #>
    param([Parameter(Mandatory = $true)][string]$Name)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $digest = $sha1.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant()))
    } finally {
        $sha1.Dispose()
    }
    $parts = for ($offset = 0; $offset -lt 20; $offset += 4) { [BitConverter]::ToUInt32($digest, $offset) }
    return 'S-1-5-80-' + ($parts -join '-')
}

function Assert-WorkerServiceSid {
    <#
    The worker's SID from sc.exe showsid (which works even where the service is
    not installed) must be the one these scripts grant, and Windows must know
    its account: icacls looks a *SID up, and NT SERVICE\PilotSwarmWorker exists
    only where its service is installed, so elsewhere every grant and owner
    change would fail ("No mapping between account names and security IDs").
    #>
    $sc = Join-Path $env:SystemRoot 'System32\sc.exe'
    $result = Invoke-NativeCommand -FilePath $sc -ArgumentList @('showsid', $script:WorkerServiceName)
    $match = [regex]::Match($result.StdOut, 'S-1-5-80(-\d+){5}')
    if (-not $match.Success) { throw ('sc.exe showsid ' + $script:WorkerServiceName + ' printed no service SID') }
    if ($match.Value -ne $script:WorkerServiceSid -or (Get-ServiceSidFromName $script:WorkerServiceName) -ne $script:WorkerServiceSid) {
        throw ('the service SID of ' + $script:WorkerServiceName + ' is ' + $match.Value + ', not ' + $script:WorkerServiceSid)
    }
    try {
        [void](New-Object System.Security.Principal.SecurityIdentifier $match.Value).Translate([System.Security.Principal.NTAccount])
    } catch {
        throw ('NT SERVICE\' + $script:WorkerServiceName + ' does not exist on this machine, because its service is not installed: icacls cannot grant to it or make it an owner. Run this on a VM built from the worker image.')
    }
    return $match.Value
}

function ConvertTo-NativeArgument {
    <# One argument quoted for a Windows command line (the rules programs built with the C runtime use to split it). #>
    param([AllowEmptyString()][string]$Value)
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($char in $Value.ToCharArray()) {
        if ($char -eq [char]'\') {
            $backslashes++
            continue
        }
        if ($char -eq [char]'"') {
            [void]$builder.Append([char]'\', 2 * $backslashes + 1)
            [void]$builder.Append('"')
        } else {
            if ($backslashes -gt 0) { [void]$builder.Append([char]'\', $backslashes) }
            [void]$builder.Append($char)
        }
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$builder.Append([char]'\', 2 * $backslashes) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-NativeCommand {
    <#
    Runs a program without a shell and returns its exit code and output. Output is
    read as UTF-8 and never goes through PowerShell's error stream, so a program
    that writes progress to stderr (git, msiexec) does not fail the script.
    Throws when the exit code is not one of SuccessExitCode, unless -NoThrow.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [hashtable]$Environment,
        [int]$TimeoutSeconds = 7200,
        [int[]]$SuccessExitCode = @(0),
        [switch]$NoThrow
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    if ($FilePath -notmatch '[\\/]') {
        # A bare name (git, npm.cmd) is found on PATH the same way in Windows PowerShell and PowerShell 7.
        $command = Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { throw ($FilePath + ' was not found on PATH') }
        $FilePath = $command.Path
    }
    $info.FileName = $FilePath
    $info.Arguments = (@($ArgumentList | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }
    if ($Environment) {
        foreach ($key in $Environment.Keys) {
            if ($null -eq $Environment[$key]) { [void]$info.EnvironmentVariables.Remove($key) }
            else { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
        }
    }
    Write-Verbose ('> ' + $FilePath + ' ' + $info.Arguments)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        if (Test-WindowsHost) {
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $process.Id | Out-Null
        } else {
            $process.Kill()
        }
        throw ((Split-Path -Leaf $FilePath) + ' did not finish within ' + $TimeoutSeconds + ' seconds')
    }
    $process.WaitForExit()
    $result = [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut   = $stdout.Result
        StdErr   = $stderr.Result
    }
    if (-not $NoThrow -and $SuccessExitCode -notcontains $result.ExitCode) {
        $detail = (($result.StdErr + "`n" + $result.StdOut).Trim() -split "`r?`n" | Select-Object -Last 5) -join ' '
        throw ((Split-Path -Leaf $FilePath) + ' exited with ' + $result.ExitCode + ': ' + $detail)
    }
    return $result
}

function Invoke-Icacls {
    <# icacls by its full path; SIDs are written *S-1-... so no account name is looked up. #>
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    [void](Invoke-NativeCommand -FilePath $icacls -ArgumentList (@($Path) + $Arguments))
}

function Write-Utf8File {
    <# Exactly these characters, UTF-8 without a byte order mark. #>
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Force -Path $parent) }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-StringSha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw ('missing file: ' + $Path) }
    try {
        return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json)
    } catch {
        throw ($Path + ' is not valid JSON: ' + $_.Exception.Message)
    }
}

function Test-JsonProperty {
    param($Object, [Parameter(Mandatory = $true)][string]$Name)
    return ($null -ne $Object) -and ($Object.PSObject.Properties.Name -contains $Name)
}

function Read-EnvFile {
    <#
    NAME=VALUE lines, as the launcher reads worker.env: blank lines and lines
    starting with # are skipped, the value is everything after the first =,
    taken literally. A name listed twice is refused. Returns an ordered
    dictionary.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw ('missing file: ' + $Path) }
    $values = [ordered]@{}
    $number = 0
    foreach ($raw in ([System.IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF) -split "`r?`n")) {
        $number++
        $line = $raw.TrimStart()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -le 0) { throw ($Path + ', line ' + $number + ': expected NAME=VALUE') }
        $name = $line.Substring(0, $eq).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$') { throw ($Path + ', line ' + $number + ': "' + $name + '" is not a valid setting name') }
        foreach ($existing in $values.Keys) {
            if ($existing -ieq $name) { throw ($Path + ' sets ' + $name + ' twice') }
        }
        $values[$name] = $line.Substring($eq + 1)
    }
    return $values
}

function Get-LongPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-WindowsHost)) { return $Path }
    if ($Path.StartsWith('\\?\')) { return $Path }
    if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
    return '\\?\' + $Path
}

function Find-ReparsePoint {
    <#
    Every junction, link or other reparse point under Path (Path itself
    included), never following one: Attributes -band ReparsePoint on each entry.
    Call it inside @() for a list.
    #>
    param([Parameter(Mandatory = $true)][string]$Path, [int]$Limit = 50)
    $found = New-Object System.Collections.Generic.List[string]
    $rootItem = Get-Item -LiteralPath $Path -Force
    if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $found.Add($rootItem.FullName) }
    $stack = New-Object System.Collections.Generic.Stack[string]
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::Directory) -and $found.Count -eq 0) { $stack.Push((Get-LongPath $rootItem.FullName)) }
    while ($stack.Count -gt 0 -and $found.Count -lt $Limit) {
        $directory = New-Object System.IO.DirectoryInfo ($stack.Pop())
        foreach ($item in $directory.EnumerateFileSystemInfos()) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                $found.Add(($item.FullName -replace '^\\\\\?\\(UNC\\)?', ''))
                if ($found.Count -ge $Limit) { break }
                continue
            }
            if ($item.Attributes -band [System.IO.FileAttributes]::Directory) { $stack.Push($item.FullName) }
        }
    }
    return $found.ToArray()
}

function Remove-LinkSafeItem {
    <#
    Deletes a file or a folder tree. A junction or symbolic link is deleted
    itself, never followed, in any PowerShell: Windows PowerShell 5.1's
    Remove-Item -Recurse can follow a junction into its target. Long paths work.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $rootItem = Get-Item -LiteralPath $Path -Force
    $full = Get-LongPath $rootItem.FullName
    $directory = [System.IO.FileAttributes]::Directory
    $link = [System.IO.FileAttributes]::ReparsePoint
    $readOnly = [System.IO.FileAttributes]::ReadOnly
    if (-not ($rootItem.Attributes -band $directory)) {
        if ($rootItem.Attributes -band $readOnly) { $rootItem.Attributes = $rootItem.Attributes -bxor $readOnly }
        [System.IO.File]::Delete($full)
        return
    }
    if ($rootItem.Attributes -band $link) {
        [System.IO.Directory]::Delete($full, $false)
        return
    }
    # Post-order: a folder goes once everything in it has.
    $pending = New-Object System.Collections.Generic.Stack[object]
    $pending.Push([pscustomobject]@{ Path = $full; Emptied = $false })
    while ($pending.Count -gt 0) {
        $entry = $pending.Pop()
        if ($entry.Emptied) {
            [System.IO.Directory]::Delete($entry.Path, $false)
            continue
        }
        $pending.Push([pscustomobject]@{ Path = $entry.Path; Emptied = $true })
        foreach ($item in (New-Object System.IO.DirectoryInfo $entry.Path).EnumerateFileSystemInfos()) {
            $attributes = $item.Attributes
            if ($attributes -band $directory) {
                if ($attributes -band $link) { [System.IO.Directory]::Delete($item.FullName, $false) }
                else { $pending.Push([pscustomobject]@{ Path = $item.FullName; Emptied = $false }) }
                continue
            }
            if ($attributes -band $readOnly) { $item.Attributes = $attributes -bxor $readOnly }
            [System.IO.File]::Delete($item.FullName)
        }
    }
}

function Test-IsAdministrator {
    if (-not (Test-WindowsHost)) { return $false }
    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Save-VerifiedDownload {
    <# Downloads over https only, then refuses the file unless its SHA-256 is the pinned one. #>
    param([Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][string]$Sha256, [Parameter(Mandatory = $true)][string]$Destination)
    if ($Uri -notmatch '^https://') { throw ('only https:// downloads are allowed: ' + $Uri) }
    if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw ('not a SHA-256: ' + $Sha256) }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }
    $actual = Get-Sha256Hex $Destination
    if ($actual -ne $Sha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Destination -Force
        throw ('SHA-256 mismatch for ' + $Uri + ': got ' + $actual + ', pinned ' + $Sha256)
    }
}

function Get-Lun0DiskNumber {
    <#
    The data disk at SCSI logical unit 0 on a controller other than the OS
    disk's, where Azure attaches data disks; $null when there is none.
    #>
    $boot = @(Get-Disk | Where-Object { $_.IsBoot -or $_.IsSystem } | ForEach-Object { [int]$_.Number })
    $drives = @(Get-CimInstance -ClassName Win32_DiskDrive)
    $bootPorts = @($drives | Where-Object { $boot -contains [int]$_.Index } | ForEach-Object { [int]$_.SCSIPort })
    $candidates = @($drives | Where-Object {
            ($_.InterfaceType -eq 'SCSI') -and ($null -ne $_.SCSILogicalUnit) -and ([int]$_.SCSILogicalUnit -eq 0) -and
            ($boot -notcontains [int]$_.Index) -and ($bootPorts -notcontains [int]$_.SCSIPort)
        })
    if ($candidates.Count -gt 1) { throw ('more than one disk answers at LUN 0: ' + (($candidates | ForEach-Object { $_.Index }) -join ', ')) }
    if ($candidates.Count -eq 0) { return $null }
    return [int]$candidates[0].Index
}

Export-ModuleMember -Function @(
    'Test-WindowsHost', 'Join-WindowsPath', 'Get-WorkerServiceName', 'Get-WorkerServiceSid', 'Get-WellKnownSid', 'Get-ServiceSidFromName', 'Assert-WorkerServiceSid',
    'ConvertTo-NativeArgument', 'Invoke-NativeCommand', 'Invoke-Icacls', 'Write-Utf8File', 'Get-Sha256Hex', 'Get-StringSha256Hex',
    'Read-JsonFile', 'Test-JsonProperty', 'Read-EnvFile', 'Get-LongPath', 'Find-ReparsePoint', 'Remove-LinkSafeItem', 'Test-IsAdministrator',
    'Save-VerifiedDownload', 'Get-Lun0DiskNumber'
)
