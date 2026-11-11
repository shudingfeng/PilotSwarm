<#
.SYNOPSIS
Upgrades a stamp's Windows workers in four lockstep steps, with the disk controller's pool frozen throughout.

.DESCRIPTION
  1. Freeze: POST /v1/admin/upgrade-freeze { frozen: true } through
     kubectl port-forward. The controller stops scaling out, activating VMs
     and attaching drives, and drains and stops the worker service on every
     active VM. The coordination host's manifest is published with 0 replicas
     (-CoordinationHostScript). The step ends when GET /v1/admin/upgrade-freeze
     reports every active VM stopped.
  2. Migrate: runs the database migration Job (-MigrationJobManifest) to
     completion, and fails as soon as the Job fails.
  3. Publish: uploads the release's artifacts to the release container, then
     current-release.json last, rolls -RollDeployments, and has the
     coordination host take its new manifest, still with 0 replicas.
  4. Unfreeze: brings the coordination host back (-CoordinationHostReplicas),
     then POST /v1/admin/upgrade-freeze { frozen: false }. The controller
     starts the worker service on the VMs it stopped, and each launcher syncs
     the new release before its worker starts.

The freeze is kept in the controller's state, so a failed run is resumed with
-From at the step that failed; the pool stays frozen until step 4.

Each controller call connects to 127.0.0.1:-LocalPort (kubectl port-forward)
but checks the certificate against -ControllerAddress, the address the
controller's certificate names, with the controller's trusted CAs
(-ControllerCaFile) only: one CA, or two during a CA rotation, as in the
ca.crt of the ConfigMap pilotswarm-disk-controller-ca. Its token is an Entra
token for -ControllerTokenScope from the signed-in Azure CLI: an app-only
token with the deployer role, or an operator's with the admin role. The token
is never printed.

Needs PowerShell 7 or Windows PowerShell 5.1, Node.js, kubectl (with the
stamp's kubeconfig) and the Azure CLI on PATH.

.PARAMETER ReleaseDir
The output folder of Pack-WinWorkerRelease.ps1: current-release.json and the
artifacts it names.

.PARAMETER CoordinationHostScript
A script the deployment provides, called as
  & <script> -Replicas <n> -Step Freeze|Publish|Unfreeze
It publishes the coordination host's manifest with that many replicas (the
current image at Freeze, the new one from Publish on) and returns only once
the manifest is applied and its pods are gone (0) or ready.

.PARAMETER MigrationJobManifest
The Kubernetes Job that migrates the database, with the objects it mounts, as
a manifest file for kubectl apply that creates exactly one Job. Its objects
are deleted first. With WIN_WORKERS_ENABLED=true, the portal's manifests step
of deploy/scripts/deploy.mjs stages the database role Job at
deploy/.tmp/portal-<env>/db-role-job.yaml.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$StorageAccountName,
    [string]$ReleaseContainer = 'win-worker-releases',
    [Parameter(Mandatory = $true)][string]$Namespace,
    [Parameter(Mandatory = $true)][string]$ControllerCaFile,
    [Parameter(Mandatory = $true)][string]$ControllerTokenScope,
    [string]$ControllerAddress = '10.20.15.250',
    [int]$ControllerPort = 3003,
    [int]$LocalPort = 3003,
    [string]$ControllerService = 'pilotswarm-disk-controller',
    [string]$KubeContext,
    [string]$MigrationJobManifest,
    [switch]$SkipMigration,
    [int]$MigrationTimeoutMinutes = 30,
    [string]$CoordinationHostScript,
    [ValidateRange(1, 20)][int]$CoordinationHostReplicas = 2,
    [switch]$NoCoordinationHost,
    [string[]]$RollDeployments = @('pilotswarm-portal', 'pilotswarm-disk-controller'),
    [ValidateSet('Freeze', 'Migrate', 'Publish', 'Unfreeze')][string]$From = 'Freeze',
    [ValidateSet('Freeze', 'Migrate', 'Publish', 'Unfreeze')][string]$To = 'Unfreeze',
    [int]$StopTimeoutMinutes = 130
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotSwarm.WinWorker.psm1') -Force

$script:Steps = @('Freeze', 'Migrate', 'Publish', 'Unfreeze')
$script:MigrationPollSeconds = 10

# Connects to 127.0.0.1 and checks the certificate against the controller's address, with the controller's trusted CAs only (a PEM file of one or two).
$script:AdminClient = @'
import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
const [method, route, body] = process.argv.slice(2);
const name = process.env.PS_CONTROLLER_TLS_NAME;
const request = https.request({
    host: "127.0.0.1",
    port: Number(process.env.PS_CONTROLLER_LOCAL_PORT),
    method,
    path: route,
    agent: false,
    ca: fs.readFileSync(process.env.PS_CONTROLLER_CA_FILE),
    checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(name, certificate),
    headers: { authorization: "Bearer " + process.env.PS_CONTROLLER_TOKEN, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
}, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
        process.stdout.write(Buffer.concat(chunks).toString("utf8"));
        process.exitCode = response.statusCode >= 200 && response.statusCode < 300 ? 0 : 2;
    });
});
request.setTimeout(60000, () => request.destroy(new Error("no answer within 60 s")));
request.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
request.end(body || undefined);
'@

function Get-KubectlArguments {
    param([string[]]$Arguments)
    $all = @()
    if ($KubeContext) { $all += @('--context', $KubeContext) }
    return $all + @('--namespace', $Namespace) + $Arguments
}

function Invoke-Kubectl {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$NoThrow, [int]$TimeoutSeconds = 3600)
    return Invoke-NativeCommand -FilePath 'kubectl' -ArgumentList (Get-KubectlArguments $Arguments) -NoThrow:$NoThrow -TimeoutSeconds $TimeoutSeconds
}

function Read-ReleaseManifest {
    <# current-release.json and every artifact it names, each checked against its SHA-256 before anything is frozen. #>
    $file = Join-Path $ReleaseDir 'current-release.json'
    $release = Read-JsonFile -Path $file
    if (-not (Test-JsonProperty $release 'schemaVersion') -or $release.schemaVersion -ne 1) { throw 'current-release.json: schemaVersion must be 1' }
    if ($release.commitSha -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$' -or $release.zipSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'current-release.json needs commitSha and zipSha256' }
    $artifacts = @([pscustomobject]@{ Blob = ('worker-release-' + $release.commitSha + '.zip'); Sha256 = $release.zipSha256 })
    foreach ($field in @('modelCatalog', 'headlessInstructions')) {
        if ((Test-JsonProperty $release $field) -and $null -ne $release.$field) { $artifacts += [pscustomobject]@{ Blob = $release.$field.blob; Sha256 = $release.$field.sha256 } }
    }
    if (Test-JsonProperty $release 'plugins') { foreach ($plugin in @($release.plugins)) { $artifacts += [pscustomobject]@{ Blob = $plugin.blob; Sha256 = $plugin.sha256 } } }
    foreach ($artifact in $artifacts) {
        $path = Join-Path $ReleaseDir ($artifact.Blob.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('the release folder lacks ' + $artifact.Blob) }
        if ((Get-Sha256Hex $path) -ne $artifact.Sha256) { throw ($artifact.Blob + ' does not match its SHA-256 in current-release.json') }
        $artifact | Add-Member -NotePropertyName Path -NotePropertyValue $path
    }
    return [pscustomobject]@{ File = $file; CommitSha = $release.commitSha; Artifacts = $artifacts }
}

function Wait-LocalPort {
    param([Parameter(Mandatory = $true)][int]$Port, [int]$Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $connect = $client.ConnectAsync('127.0.0.1', $Port)
            if ($connect.Wait(1000) -and $client.Connected) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        } finally {
            $client.Dispose()
        }
    }
    throw ('kubectl port-forward did not open 127.0.0.1:' + $Port)
}

function Invoke-ControllerAdmin {
    <# One admin call through a fresh port-forward; returns the parsed answer. #>
    param([Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method, [object]$Body)
    $token = (Invoke-NativeCommand -FilePath 'az' -ArgumentList @('account', 'get-access-token', '--scope', $ControllerTokenScope, '--query', 'accessToken', '--output', 'tsv')).StdOut.Trim()
    if (-not $token) { throw ('the Azure CLI gave no token for ' + $ControllerTokenScope) }
    $kubectl = (Get-Command -Name 'kubectl' -CommandType Application | Select-Object -First 1).Path
    $logs = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-port-forward-' + [guid]::NewGuid().ToString('N'))
    $forward = Start-Process -FilePath $kubectl -ArgumentList (Get-KubectlArguments @('port-forward', ('svc/' + $ControllerService), ([string]$LocalPort + ':' + [string]$ControllerPort))) -PassThru -NoNewWindow -RedirectStandardOutput ($logs + '.out') -RedirectStandardError ($logs + '.err')
    $client = Join-Path ([System.IO.Path]::GetTempPath()) ('pilotswarm-admin-' + [guid]::NewGuid().ToString('N') + '.mjs')
    try {
        Wait-LocalPort -Port $LocalPort
        Write-Utf8File -Path $client -Content $script:AdminClient
        $json = ''
        if ($null -ne $Body) { $json = ConvertTo-Json -InputObject $Body -Compress }
        $environment = @{
            PS_CONTROLLER_TOKEN      = $token
            PS_CONTROLLER_CA_FILE    = (Resolve-Path -LiteralPath $ControllerCaFile).ProviderPath
            PS_CONTROLLER_TLS_NAME   = $ControllerAddress
            PS_CONTROLLER_LOCAL_PORT = [string]$LocalPort
        }
        $result = Invoke-NativeCommand -FilePath 'node' -ArgumentList @($client, $Method, '/v1/admin/upgrade-freeze', $json) -Environment $environment -NoThrow
        if ($result.ExitCode -ne 0) { throw ('the controller refused ' + $Method + ' /v1/admin/upgrade-freeze: ' + ($result.StdOut + ' ' + $result.StdErr).Trim()) }
        return ($result.StdOut | ConvertFrom-Json)
    } finally {
        if (-not $forward.HasExited) { Stop-Process -Id $forward.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $client, ($logs + '.out'), ($logs + '.err') -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-CoordinationHost {
    param([Parameter(Mandatory = $true)][int]$Replicas, [Parameter(Mandatory = $true)][string]$Step)
    if ($NoCoordinationHost) { return }
    Write-Host ('Coordination host: ' + $Replicas + ' replica(s) (' + $Step + ')')
    & $CoordinationHostScript -Replicas $Replicas -Step $Step
}

function Invoke-Freeze {
    $status = Invoke-ControllerAdmin -Method POST -Body @{ frozen = $true }
    Write-Host ('The pool is frozen since ' + $status.frozenAt + '; the controller drains and stops the workers')
    Invoke-CoordinationHost -Replicas 0 -Step 'Freeze'
    $deadline = (Get-Date).AddMinutes($StopTimeoutMinutes)
    $last = ''
    while ($true) {
        $status = Invoke-ControllerAdmin -Method GET
        if (-not $status.frozen) { throw 'the pool is no longer frozen' }
        $line = (@($status.vms) | ForEach-Object {
                $state = 'running'
                if ($_.stoppedForUpgrade) { $state = 'stopped' } elseif ($_.stopping) { $state = 'stopping' } elseif ($_.draining) { $state = 'draining' }
                if ($_.stopFailed) { $state = 'stop failed' }
                $_.name + '=' + $state
            }) -join ', '
        if ($line -ne $last) { Write-Host ('Workers: ' + $(if ($line) { $line } else { 'none active' })) }
        $last = $line
        if ($status.allStopped) { return }
        if ((Get-Date) -gt $deadline) { throw ('not every worker stopped within ' + $StopTimeoutMinutes + ' minutes; the pool stays frozen: fix it and resume with -From Freeze') }
        Start-Sleep -Seconds 30
    }
}

function Invoke-Migrate {
    if ($SkipMigration) {
        Write-Host 'Skipping the migration (-SkipMigration)'
        return
    }
    if (-not $MigrationJobManifest -or -not (Test-Path -LiteralPath $MigrationJobManifest -PathType Leaf)) { throw '-MigrationJobManifest must name the migration Job''s manifest (or pass -SkipMigration)' }
    [void](Invoke-Kubectl -Arguments @('delete', '--filename', $MigrationJobManifest, '--ignore-not-found', '--wait=true'))
    # The manifest may also hold what the Job mounts, such as its ConfigMap.
    $created = @((Invoke-Kubectl -Arguments @('apply', '--filename', $MigrationJobManifest, '--output', 'name')).StdOut -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $jobs = @($created | Where-Object { $_ -match '^job(\.batch)?/' })
    if ($jobs.Count -ne 1) { throw ('the migration manifest created ' + ($created -join ', ') + ', not one Job') }
    $job = $jobs[0]
    Write-Host ('Running ' + $job)
    # Polled rather than `kubectl wait --for=condition=complete`, which waits out
    # the whole timeout for a Job that has already failed, with the pool frozen.
    $deadline = (Get-Date).AddMinutes($MigrationTimeoutMinutes)
    while ($true) {
        $state = Get-JobState -Job $job
        if ($state -ne 'Running' -or (Get-Date) -gt $deadline) { break }
        Start-Sleep -Seconds $script:MigrationPollSeconds
    }
    if ($state -ne 'Complete') {
        $logs = Invoke-Kubectl -Arguments @('logs', $job, '--tail=50') -NoThrow
        $outcome = 'did not complete within ' + $MigrationTimeoutMinutes + ' minutes'
        if ($state -eq 'Failed') { $outcome = 'failed' }
        throw ('the migration ' + $outcome + '; the pool stays frozen. Last log lines: ' + $logs.StdOut.Trim())
    }
}

# 'Complete', 'Failed' or 'Running' (also while the Job can't be read), from the Job's conditions.
function Get-JobState {
    param([Parameter(Mandatory = $true)][string]$Job)
    $read = Invoke-Kubectl -Arguments @('get', $Job, '--output', 'json') -NoThrow
    $object = $null
    if ($read.ExitCode -eq 0) {
        try { $object = ConvertFrom-Json -InputObject $read.StdOut } catch { $object = $null }
    }
    if ($null -eq $object) {
        Write-Warning ('could not read ' + $Job + ': ' + ((($read.StdErr + "`n" + $read.StdOut).Trim() -split '\r?\n')[0]))
        return 'Running'
    }
    $conditions = @()
    if ($object.PSObject.Properties['status'] -and $object.status.PSObject.Properties['conditions']) { $conditions = @($object.status.conditions) }
    foreach ($type in @('Failed', 'Complete')) {
        if (@($conditions | Where-Object { $_.type -eq $type -and $_.status -eq 'True' }).Count -gt 0) { return $type }
    }
    return 'Running'
}

function Invoke-Publish {
    param([Parameter(Mandatory = $true)]$Release)
    foreach ($artifact in $Release.Artifacts) {
        Write-Host ('Uploading ' + $artifact.Blob)
        [void](Invoke-NativeCommand -FilePath 'az' -ArgumentList @('storage', 'blob', 'upload', '--auth-mode', 'login', '--account-name', $StorageAccountName, '--container-name', $ReleaseContainer, '--name', $artifact.Blob, '--file', $artifact.Path, '--overwrite', 'true', '--only-show-errors', '--output', 'none'))
    }
    # Last: a VM only ever reads a current-release.json whose artifacts are all in place.
    Write-Host 'Uploading current-release.json'
    [void](Invoke-NativeCommand -FilePath 'az' -ArgumentList @('storage', 'blob', 'upload', '--auth-mode', 'login', '--account-name', $StorageAccountName, '--container-name', $ReleaseContainer, '--name', 'current-release.json', '--file', $Release.File, '--overwrite', 'true', '--only-show-errors', '--output', 'none'))
    foreach ($deployment in $RollDeployments) {
        Write-Host ('Rolling deployment/' + $deployment)
        [void](Invoke-Kubectl -Arguments @('rollout', 'restart', ('deployment/' + $deployment)))
        [void](Invoke-Kubectl -Arguments @('rollout', 'status', ('deployment/' + $deployment), '--timeout=15m') -TimeoutSeconds 1000)
    }
    Invoke-CoordinationHost -Replicas 0 -Step 'Publish'
}

function Invoke-Unfreeze {
    Invoke-CoordinationHost -Replicas $CoordinationHostReplicas -Step 'Unfreeze'
    $status = Invoke-ControllerAdmin -Method POST -Body @{ frozen = $false }
    if ($status.frozen) { throw 'the controller still reports the pool frozen' }
    Write-Host ('The pool is unfrozen; the controller starts the worker service on ' + @($status.vms).Count + ' VM(s), which sync the new release first')
}

function Invoke-Main {
    if (-not $NoCoordinationHost -and (-not $CoordinationHostScript -or -not (Test-Path -LiteralPath $CoordinationHostScript -PathType Leaf))) {
        throw '-CoordinationHostScript must name the deployment''s coordination host script (or pass -NoCoordinationHost)'
    }
    if (-not (Test-Path -LiteralPath $ControllerCaFile -PathType Leaf)) { throw ('missing controller CA: ' + $ControllerCaFile) }
    $first = [array]::IndexOf($script:Steps, $From)
    $last = [array]::IndexOf($script:Steps, $To)
    if ($first -gt $last) { throw '-From comes after -To' }
    $release = Read-ReleaseManifest
    Write-Host ('Release ' + $release.CommitSha + ': ' + $release.Artifacts.Count + ' artifact(s) checked')
    foreach ($step in $script:Steps[$first..$last]) {
        Write-Host ('== ' + $step)
        switch ($step) {
            'Freeze' { Invoke-Freeze }
            'Migrate' { Invoke-Migrate }
            'Publish' { Invoke-Publish -Release $release }
            'Unfreeze' { Invoke-Unfreeze }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-Main }
