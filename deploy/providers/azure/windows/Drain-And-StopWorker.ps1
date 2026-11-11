<#
.SYNOPSIS
Drains the worker and stops its service. Safe to run again: a stopped worker stays stopped.

.DESCRIPTION
The disk controller runs it as a Managed Run Command, as LocalSystem, before
it deletes a VM and on every active VM when the pool freezes for an upgrade:

  & 'C:\pilotswarm\scripts\Drain-And-StopWorker.ps1'

Stopping PilotSwarmWorker sends the worker Ctrl+C: it stops taking work, lets
running turns finish within PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS, releases its
Dev Drive through the attacher and exits; WinSW waits up to its 105-minute
stop timeout. A worker that crashes while draining is restarted by the
service's failure action 10 seconds later, and its launcher waits without
starting a worker, because the controller reports a draining or frozen VM
inactive; this script then stops it again, until the service has stayed
stopped for -SettleSeconds. The attacher keeps running.

Exits 0 once the service is stopped (or not installed). When it is still
running after -TimeoutMinutes, the script ends with a terminating error (exit
code 1), which, unlike a nested exit code, also fails the Run Command script
that calls it.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
    [string]$ServiceName = 'PilotSwarmWorker',
    [ValidateRange(1, 1440)]
    [int]$TimeoutMinutes = 115,
    [ValidateRange(0, 600)]
    [int]$SettleSeconds = 20
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Wait-StaysStopped {
    <# True when the service is still stopped after Seconds: the failure restart comes 10 seconds after a crash. #>
    param([Parameter(Mandatory = $true)]$Service, [int]$Seconds)
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        Start-Sleep -Seconds 2
        $Service.Refresh()
        if ($Service.Status -ne 'Stopped') { return $false }
    }
    return $true
}

function Invoke-Main {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        Write-Host ('The service ' + $ServiceName + ' is not installed; nothing to drain')
        return
    }
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $started = Get-Date
    while ($true) {
        $service.Refresh()
        if ($service.Status -eq 'Stopped') {
            if (Wait-StaysStopped -Service $service -Seconds $SettleSeconds) {
                Write-Host ('The worker is drained and ' + $ServiceName + ' is stopped (' + [int]((Get-Date) - $started).TotalSeconds + ' s)')
                return
            }
            Write-Host ($ServiceName + ' started again after a failure; stopping it again')
            continue
        }
        if ((Get-Date) -gt $deadline) {
            throw ($ServiceName + ' is still ' + $service.Status + ' after ' + $TimeoutMinutes + ' minutes')
        }
        if ($service.Status -ne 'StopPending') {
            Write-Host ('Stopping ' + $ServiceName + ' (' + $service.Status + '): the worker drains its running turns first')
            try {
                Stop-Service -Name $ServiceName -NoWait -ErrorAction Stop
            } catch {
                # A service that is still starting does not take a stop yet.
                Write-Host ('The stop request was not taken yet: ' + $_.Exception.Message)
                Start-Sleep -Seconds 5
                continue
            }
        }
        try {
            $service.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(5))
        } catch {
            # WaitForStatus gives up after five minutes; the drain can take up to the service's stop timeout.
            Write-Host ('Still draining after ' + [int]((Get-Date) - $started).TotalMinutes + ' minute(s)')
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
