/**
 * The Windows worker's disk attacher. WinSW runs it as the service
 * PilotSwarmDiskAttacher, as LocalSystem, before the worker service starts:
 *
 *   "C:\Program Files\nodejs\node.exe" C:\pilotswarm\disk-attacher.mjs
 *
 * It listens on 127.0.0.1 only (PS_DISK_ATTACHER_URL, port 3099 by default),
 * and every request must carry `Authorization: Bearer <token>`, the random
 * token it writes at each start to PS_DISK_ATTACHER_TOKEN_FILE, which only
 * SYSTEM, Administrators and NT SERVICE\PilotSwarmWorker (read) can open.
 * Routes (README, "The attacher"), each a POST with a JSON object body:
 *
 *   /online-lun0   { diskName }              LUN 0 online as the Dev Drive Q:, at the disk's full size
 *   /offline-lun0  { diskName, workerPid }   LUN 0 offline, after stopping processes that use it
 *   /extend-lun0   { diskName, sizeGb }      Q: extended once Windows sees the grown disk
 *   /sync-release  {}                        the release that current-release.json names, in place
 *
 * The LUN 0 routes are idempotent and run one at a time. Disk operations run
 * in Windows PowerShell from a script this file writes at start, with the
 * request's values only as checked parameters, never inside a command line,
 * and with TEMP and TMP in run\ps-temp, which only SYSTEM and Administrators
 * can write: the start fails when that folder's access list says otherwise.
 *
 * Imports only Node.js built-in modules.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_ROOT = "C:\\pilotswarm";
export const DEFAULT_ATTACHER_URL = "http://127.0.0.1:3099";
export const DEFAULT_RELEASES_CONTAINER = "win-worker-releases";
export const RELEASE_MANIFEST_BLOB = "current-release.json";
export const WORKER_SERVICE = "PilotSwarmWorker";
export const USER_DATA_VERSION = 1;
export const MAX_SIZE_GB = 65_536;
/** An Azure managed disk name: letters, digits, _ . - ; starts with a letter or digit and does not end with . or - */
export const DISK_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9_])?$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BLOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,3}$/;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BODY_LIMIT = 16 * 1024;
/** One PEM certificate exactly: base64 lines between its two markers. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----/g;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lower = (value) => String(value).toLowerCase();

/**
 * The SID of a service's virtual account (NT SERVICE\<name>): S-1-5-80 and the
 * SHA-1 of the upper-case name in UTF-16LE as five little-endian integers.
 * The same on every machine; `sc.exe showsid <name>` prints it too.
 */
export function serviceSid(name) {
    const digest = createHash("sha1").update(Buffer.from(String(name).toUpperCase(), "utf16le")).digest();
    const parts = [];
    for (let offset = 0; offset < 20; offset += 4) parts.push(digest.readUInt32LE(offset));
    return `S-1-5-80-${parts.join("-")}`;
}

/** A failure the attacher reports to its caller as `{ ok: false, code, message, retryable }`. */
export class AttacherError extends Error {
    constructor(status, code, message, { retryable = false } = {}) {
        super(message);
        this.name = "AttacherError";
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

/** worker.env: NAME=VALUE lines, # comments, values taken literally. */
export function parseEnvFile(text, source = "worker.env") {
    const values = {};
    const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
        const line = raw.trimStart();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) throw new Error(`${source}, line ${index + 1}: expected NAME=VALUE`);
        const name = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error(`${source}, line ${index + 1}: "${name}" is not a valid setting name`);
        if (Object.keys(values).some((key) => lower(key) === lower(name))) throw new Error(`${source} sets ${name} twice`);
        values[name] = line.slice(eq + 1);
    }
    return values;
}

/** True when `child` is `parent` or inside it (Windows rules: no case). */
export function isInside(child, parent) {
    const relative = path.win32.relative(path.win32.resolve(parent), path.win32.resolve(child));
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

/** The settings the attacher reads from worker.env, checked. */
export function attacherSettings(workerEnv, { root = DEFAULT_ROOT } = {}) {
    const url = workerEnv.PS_DISK_ATTACHER_URL || DEFAULT_ATTACHER_URL;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`PS_DISK_ATTACHER_URL is not a URL: ${url}`);
    }
    // The attacher binds 127.0.0.1 only; the URL must say so.
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || (parsed.pathname !== "/" && parsed.pathname !== "")) {
        throw new Error(`PS_DISK_ATTACHER_URL must be http://127.0.0.1:<port>, not ${url}`);
    }
    const inRoot = (name, fallback) => {
        const value = workerEnv[name] || fallback;
        if (!path.win32.isAbsolute(value) || !isInside(value, root)) throw new Error(`${name} must be a path inside ${root}, not ${value}`);
        return value;
    };
    const container = workerEnv.PS_WORKER_RELEASES_CONTAINER || DEFAULT_RELEASES_CONTAINER;
    if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(container)) throw new Error(`PS_WORKER_RELEASES_CONTAINER is not a container name: ${container}`);
    return {
        port: Number(parsed.port),
        tokenFile: inRoot("PS_DISK_ATTACHER_TOKEN_FILE", path.win32.join(root, "run", "attacher.token")),
        caFile: inRoot("PS_DISK_CONTROLLER_CA_CERT", path.win32.join(root, "disk-controller-ca.crt")),
        catalogFile: inRoot("PS_MODEL_PROVIDERS_PATH", path.win32.join(root, "model_providers.json")),
        container,
    };
}

/**
 * What the attacher needs from the scale set's userData (the launcher checks
 * the rest): the storage account, the VM identity's client ID and the
 * controller's CAs, one CA certificate or two during a CA rotation, each one
 * checked. Same format as the launcher reads (README, "userData").
 */
export function decodeAttacherUserData(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("the scale set's userData is missing or not base64");
    let data;
    try {
        data = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
        throw new Error("the scale set's userData is not a JSON document");
    }
    if (!isPlainObject(data) || data.version !== USER_DATA_VERSION || !isPlainObject(data.env)) {
        throw new Error(`the scale set's userData is not version ${USER_DATA_VERSION} of the worker's format`);
    }
    const accountUrl = data.env.AZURE_STORAGE_ACCOUNT_URL;
    let url;
    try {
        url = new URL(accountUrl);
    } catch {
        throw new Error("userData: AZURE_STORAGE_ACCOUNT_URL is not a URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("userData: AZURE_STORAGE_ACCOUNT_URL must be a plain https:// URL");
    const clientId = data.env.AZURE_CLIENT_ID;
    if (typeof clientId !== "string" || !GUID.test(clientId)) throw new Error("userData: AZURE_CLIENT_ID must be a GUID");
    const pem = data.controllerCaCert;
    if (typeof pem !== "string" || !pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error("userData: controllerCaCert is not a PEM certificate");
    if (/\S/.test(pem.replace(PEM_CERTIFICATE, ""))) throw new Error("userData: controllerCaCert holds something other than PEM certificates");
    const blocks = [...pem.matchAll(PEM_CERTIFICATE)];
    if (blocks.length > 2) throw new Error(`userData: controllerCaCert holds ${blocks.length} certificates; it takes one, or two during a CA rotation`);
    for (const [index, [, body]] of blocks.entries()) {
        const der = Buffer.from(body.replace(/\s/g, ""), "base64");
        let certificate = null;
        try {
            certificate = new X509Certificate(der);
        } catch {
            certificate = null;
        }
        // A certificate parses from the front of its bytes; anything after it is junk.
        if (!certificate?.raw.equals(der)) throw new Error(`userData: controllerCaCert certificate ${index + 1} is not a certificate`);
        if (!certificate.ca) throw new Error(`userData: controllerCaCert certificate ${index + 1} is not a CA certificate`);
    }
    return { accountUrl: `${url.origin}/`, clientId: clientId.toLowerCase(), controllerCaCert: pem };
}

/** A new random token for this start of the attacher. */
export function newToken() {
    return randomBytes(32).toString("base64url");
}

/**
 * Checks `Authorization: Bearer <token>` in constant time: both sides are
 * hashed first, so neither the length nor the content of the token leaks.
 */
export function createAuthorizer(token) {
    if (typeof token !== "string" || token.length < 32) throw new Error("the attacher's token is too short");
    const expected = createHash("sha256").update(token).digest();
    return (header) => {
        const match = /^Bearer (\S+)$/.exec(String(header ?? ""));
        const presented = createHash("sha256").update(match ? match[1] : "").digest();
        return timingSafeEqual(presented, expected) && match !== null;
    };
}

/**
 * Writes the token file so that it is never readable by anyone else, not even
 * for a moment: an empty file gets its access list first (`setAcl`), then the
 * token, then it replaces the old file.
 */
export async function writeTokenFile(file, token, { setAcl, fsp = fs.promises } = {}) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fsp.open(temp, "wx");
    await handle.close();
    try {
        await setAcl(temp);
        await fsp.writeFile(temp, token, { encoding: "utf8" });
        await fsp.rename(temp, file);
    } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

/** Runs a program without a shell; resolves with its exit code and output. */
export function runProcess(file, args, { timeoutMs = 10 * 60_000, env, maxOutputBytes = 64 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
        } catch (error) {
            resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error), timedOut: false });
            return;
        }
        const out = [];
        const err = [];
        let size = 0;
        let timedOut = false;
        const collect = (list) => (chunk) => {
            size += chunk.length;
            if (size <= maxOutputBytes) list.push(chunk);
        };
        child.stdout.on("data", collect(out));
        child.stderr.on("data", collect(err));
        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform === "win32" && child.pid) {
                execFile(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)], () => {});
            } else {
                child.kill("SIGKILL");
            }
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error), timedOut });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
        });
    });
}

/** The last line of `text` that is a JSON object, or null. */
export function lastJsonObject(text) {
    const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index].startsWith("{")) continue;
        try {
            const value = JSON.parse(lines[index]);
            if (isPlainObject(value)) return value;
        } catch {
            // Not the result line.
        }
    }
    return null;
}

/**
 * The disk operations, in Windows PowerShell 5.1 (Storage module). The
 * attacher writes this script to C:\pilotswarm\run at start and runs it with
 * -File; the request's values arrive only as validated parameters. It prints
 * one JSON object as its last line: { ok, changed?, retry?, message? }.
 *
 * LUN 0 is the data disk at SCSI logical unit 0 on a controller other than
 * the OS disk's; Azure attaches data disks there.
 */
export const DISK_OPS_SCRIPT = String.raw`# PilotSwarm disk attacher: disk operations on LUN 0. Written by disk-attacher.mjs;
# do not edit. Every value arrives as a parameter the attacher checked.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Online', 'Offline', 'Extend', 'WorkerInstance', 'ProcessesOn', 'FolderAcl')]
    [string]$Operation,
    [ValidatePattern('^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9_])?$')]
    [string]$DiskName = 'unnamed',
    [ValidateRange(0, 65536)]
    [int]$SizeGb = 0,
    [ValidateRange(0, 2147483647)]
    [int]$WorkerPid = 0,
    [ValidateRange(0, 2147483647)]
    [int]$AttacherPid = 0,
    [switch]$NewGuid,
    [ValidatePattern('^[D-Z]$')]
    [string]$DriveLetter = 'Q',
    [string]$Root = '',
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
    [string]$ServiceName = 'PilotSwarmWorker'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result([hashtable]$Result) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Result -Compress -Depth 5))
}

function Get-Lun0DiskNumber {
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

function Get-DevDrivePartition([int]$Number) {
    $partition = Get-Partition -DiskNumber $Number | Where-Object { $_.Type -eq 'Basic' } | Sort-Object -Property Size -Descending | Select-Object -First 1
    if (-not $partition) { throw 'the disk at LUN 0 has no data partition: it is not a Dev Drive of this pool' }
    return $partition
}

function Expand-DevDrivePartition([int]$Number, [int]$PartitionNumber) {
    $supported = Get-PartitionSupportedSize -DiskNumber $Number -PartitionNumber $PartitionNumber
    $partition = Get-Partition -DiskNumber $Number -PartitionNumber $PartitionNumber
    if (($supported.SizeMax - $partition.Size) -ge 1MB) {
        Resize-Partition -DiskNumber $Number -PartitionNumber $PartitionNumber -Size $supported.SizeMax
        return $true
    }
    return $false
}

function Test-FullSize([int]$Number, [int]$PartitionNumber) {
    $supported = Get-PartitionSupportedSize -DiskNumber $Number -PartitionNumber $PartitionNumber
    $partition = Get-Partition -DiskNumber $Number -PartitionNumber $PartitionNumber
    return (($supported.SizeMax - $partition.Size) -lt 1MB)
}

function Invoke-Online {
    $deadline = (Get-Date).AddSeconds(90)
    $number = $null
    while ($true) {
        Update-HostStorageCache
        $number = Get-Lun0DiskNumber
        if ($null -ne $number) { break }
        if ((Get-Date) -gt $deadline) { return @{ ok = $false; retry = $true; message = 'no disk is attached at LUN 0' } }
        Start-Sleep -Seconds 3
    }
    $changed = $false
    $disk = Get-Disk -Number $number
    $wasOffline = [bool]$disk.IsOffline
    if ($disk.IsOffline) {
        Set-Disk -Number $number -IsOffline $false
        $changed = $true
    }
    $disk = Get-Disk -Number $number
    if ($disk.IsReadOnly) {
        Set-Disk -Number $number -IsReadOnly $false
        $changed = $true
    }
    if ($disk.PartitionStyle -ne 'GPT') { throw ('the disk at LUN 0 is not a GPT disk: ' + $disk.PartitionStyle) }
    if ($wasOffline -or $NewGuid) {
        # Drives are copies of one snapshot: each mount gets a disk GUID of its own.
        Set-Disk -Number $number -Guid ('{' + [guid]::NewGuid().ToString() + '}')
        $changed = $true
    }
    Update-HostStorageCache
    $partition = Get-DevDrivePartition $number
    if ([string]$partition.DriveLetter -ne $DriveLetter) {
        $taken = Get-Volume -DriveLetter $DriveLetter -ErrorAction SilentlyContinue
        if ($taken) { throw ('drive ' + $DriveLetter + ': is already in use by another volume') }
        Set-Partition -DiskNumber $number -PartitionNumber $partition.PartitionNumber -NewDriveLetter $DriveLetter
        $changed = $true
    }
    if (Expand-DevDrivePartition $number $partition.PartitionNumber) { $changed = $true }
    $fsutil = Join-Path $env:SystemRoot 'System32\fsutil.exe'
    & $fsutil devdrv trust ($DriveLetter + ':') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('fsutil devdrv trust failed with exit code ' + $LASTEXITCODE) }
    $volume = Get-Volume -DriveLetter $DriveLetter
    if ($volume.FileSystemType -ne 'ReFS') { throw ('drive ' + $DriveLetter + ': is ' + $volume.FileSystemType + ', not a ReFS Dev Drive') }
    if (-not (Test-FullSize $number $partition.PartitionNumber)) { return @{ ok = $false; retry = $true; message = 'the partition does not fill the disk yet' } }
    return @{ ok = $true; changed = $changed }
}

function Invoke-Extend {
    Update-HostStorageCache
    $number = Get-Lun0DiskNumber
    if ($null -eq $number) { return @{ ok = $false; message = 'no disk is attached at LUN 0' } }
    $disk = Get-Disk -Number $number
    if ($disk.IsOffline) { return @{ ok = $false; message = 'the disk at LUN 0 is offline' } }
    if ($disk.Size -lt ([int64]$SizeGb * 1GB)) {
        return @{ ok = $false; retry = $true; message = ('Windows sees ' + $disk.Size + ' bytes, not yet ' + $SizeGb + ' GiB') }
    }
    $partition = Get-DevDrivePartition $number
    $changed = Expand-DevDrivePartition $number $partition.PartitionNumber
    if (-not (Test-FullSize $number $partition.PartitionNumber)) { return @{ ok = $false; retry = $true; message = 'the partition does not fill the disk yet' } }
    return @{ ok = $true; changed = $changed }
}

$cwdReader = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PilotSwarmProcessCwd {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr ParentProcessId; }
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInformation info, int size, out int returned);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out IntPtr info, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    static byte[] Read(IntPtr process, long address, int size) {
        if (address == 0) return null;
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, new IntPtr(address), buffer, new IntPtr(size), out read) || read.ToInt64() != size) return null;
        return buffer;
    }
    static string ReadText(IntPtr process, long address, int length) {
        if (length <= 0 || length > 65534) return null;
        byte[] buffer = Read(process, address, length);
        return buffer == null ? null : Encoding.Unicode.GetString(buffer);
    }
    // The current directory of a process, from its process parameters; null when it cannot be read.
    public static string Get(int pid) {
        IntPtr process = OpenProcess(0x0410, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            int returned;
            IntPtr wow64Peb;
            if (NtQueryInformationProcess(process, 26, out wow64Peb, IntPtr.Size, out returned) == 0 && wow64Peb != IntPtr.Zero) {
                byte[] peb32 = Read(process, wow64Peb.ToInt64(), 0x14);
                if (peb32 == null) return null;
                byte[] cwd32 = Read(process, BitConverter.ToUInt32(peb32, 0x10) + 0x24, 8);
                if (cwd32 == null) return null;
                return ReadText(process, BitConverter.ToUInt32(cwd32, 4), BitConverter.ToUInt16(cwd32, 0));
            }
            BasicInformation info = new BasicInformation();
            if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
            byte[] peb = Read(process, info.PebBaseAddress.ToInt64(), 0x28);
            if (peb == null) return null;
            byte[] cwd = Read(process, BitConverter.ToInt64(peb, 0x20) + 0x38, 16);
            if (cwd == null) return null;
            return ReadText(process, BitConverter.ToInt64(cwd, 8), BitConverter.ToUInt16(cwd, 0));
        } finally {
            CloseHandle(process);
        }
    }
}
'@

function Get-ProcessesOn([string]$Folder, [int[]]$Spare) {
    $prefix = $Folder.TrimEnd('\') + '\'
    $bare = $prefix.TrimEnd('\')
    $mention = '(?i)(^|[\s"''=,;(])' + [regex]::Escape($bare) + '([\\/"''\s]|$)'
    $cwdNote = $null
    if (-not [Environment]::Is64BitProcess) {
        $cwdNote = 'a 32-bit PowerShell cannot read current folders'
    } elseif (-not ('PilotSwarmProcessCwd' -as [type])) {
        try { Add-Type -TypeDefinition $cwdReader -Language CSharp } catch { $cwdNote = ('current folders not read: ' + $_.Exception.Message) }
    }
    $all = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate)
    $byId = @{}
    foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }
    $found = @{}
    foreach ($process in $all) {
        $id = [int]$process.ProcessId
        if ($id -le 4 -or $Spare -contains $id) { continue }
        $reason = $null
        if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $reason = 'program' }
        elseif ($process.CommandLine -and ($process.CommandLine -match $mention)) { $reason = 'command line' }
        elseif ((-not $cwdNote) -and ('PilotSwarmProcessCwd' -as [type])) {
            $cwd = [PilotSwarmProcessCwd]::Get($id)
            if ($cwd -and ($cwd.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $cwd.TrimEnd('\') -ieq $bare)) { $reason = 'current folder' }
        }
        if ($reason) { $found[$id] = $reason }
    }
    # Whatever such a process started goes too; a child must be younger than its parent, so a reused ID never counts.
    $grew = $true
    while ($grew) {
        $grew = $false
        foreach ($process in $all) {
            $id = [int]$process.ProcessId
            $parent = [int]$process.ParentProcessId
            if ($found.ContainsKey($id) -or -not $found.ContainsKey($parent) -or $Spare -contains $id -or $id -le 4) { continue }
            $parentProcess = $byId[$parent]
            if ($parentProcess -and $process.CreationDate -and $parentProcess.CreationDate -and ($process.CreationDate -lt $parentProcess.CreationDate)) { continue }
            $found[$id] = 'started by a process on ' + $bare
            $grew = $true
        }
    }
    $list = @($found.Keys | Sort-Object | ForEach-Object { @{ pid = $_; name = [string]$byId[$_].Name; reason = $found[$_] } })
    return @{ processes = $list; note = $cwdNote }
}

function Stop-ProcessesOn([string]$Folder, [int[]]$Spare) {
    $found = Get-ProcessesOn $Folder $Spare
    $ids = @($found.processes | ForEach-Object { [int]$_.pid })
    foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    return $ids
}

function Invoke-Offline {
    Update-HostStorageCache
    $number = Get-Lun0DiskNumber
    if ($null -eq $number) { return @{ ok = $true; changed = $false; message = 'no disk is attached at LUN 0' } }
    $disk = Get-Disk -Number $number
    if ($disk.IsOffline) { return @{ ok = $true; changed = $false } }
    $spare = @($WorkerPid, $AttacherPid, $PID) | Where-Object { $_ -gt 0 }
    $letters = @(Get-Partition -DiskNumber $number | Where-Object { [string]$_.DriveLetter -match '^[A-Z]$' } | ForEach-Object { [string]$_.DriveLetter })
    $stopped = @()
    foreach ($letter in $letters) {
        $stopped += @(Stop-ProcessesOn ($letter + ':\') $spare)
        Write-VolumeCache -DriveLetter $letter -ErrorAction SilentlyContinue
    }
    Set-Disk -Number $number -IsOffline $true
    if (-not (Get-Disk -Number $number).IsOffline) { throw 'the disk at LUN 0 did not go offline' }
    return @{ ok = $true; changed = $true; stopped = $stopped }
}

function Get-WorkerInstance {
    $service = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $ServiceName + "'")
    if (-not $service -or -not $service.ProcessId) { return @{ ok = $true; pid = 0; started = '' } }
    $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [int]$service.ProcessId)
    if (-not $process) { return @{ ok = $true; pid = 0; started = '' } }
    return @{ ok = $true; pid = [int]$service.ProcessId; started = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o') }
}

# A folder's owner and access rules as SIDs, with each rule's raw rights mask; the attacher judges them.
function Get-FolderAcl([string]$Folder) {
    $acl = Get-Acl -LiteralPath $Folder
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
    $rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
        @{ sid = $_.IdentityReference.Value; allow = ([string]$_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights; inheritOnly = (($_.PropagationFlags -band $inheritOnly) -eq $inheritOnly) }
    })
    return @{ ok = $true; owner = $acl.GetOwner($sidType).Value; rules = $rules }
}

try {
    switch ($Operation) {
        'Online' { $result = Invoke-Online }
        'Offline' { $result = Invoke-Offline }
        'Extend' {
            if ($SizeGb -lt 1) { throw 'SizeGb is required' }
            $result = Invoke-Extend
        }
        'WorkerInstance' { $result = Get-WorkerInstance }
        'ProcessesOn' {
            if (-not [IO.Path]::IsPathRooted($Root)) { throw 'Root must be an absolute folder' }
            $listed = Get-ProcessesOn $Root @(@($WorkerPid, $AttacherPid, $PID) | Where-Object { $_ -gt 0 })
            $result = @{ ok = $true; processes = $listed.processes; note = $listed.note }
        }
        'FolderAcl' {
            if (-not [IO.Path]::IsPathRooted($Root)) { throw 'Root must be an absolute folder' }
            $result = Get-FolderAcl $Root
        }
    }
    Write-Result $result
    exit 0
} catch {
    Write-Result @{ ok = $false; message = [string]$_.Exception.Message }
    exit 1
}
`;

/** Windows PowerShell 5.1 by its full path: never another program PATH finds. */
export function windowsPowerShell(systemRoot = process.env.SystemRoot || "C:\\Windows") {
    return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The environment of a disk operation's Windows PowerShell. TEMP and TMP name
 * the attacher's private folder (run\ps-temp): Add-Type compiles the current
 * folder reader there (source, command line and DLL), and LocalSystem's
 * default, C:\Windows\Temp, lets ordinary accounts create files. PSModulePath
 * goes: one inherited from PowerShell 7 names module folders 5.1 cannot load.
 */
export function diskOpsEnv(env, tempDir) {
    const dropped = new Set(["psmodulepath", "temp", "tmp"]);
    return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !dropped.has(name.toLowerCase()))), TEMP: tempDir, TMP: tempDir };
}

/**
 * The disk operations, run as `powershell.exe -File <script> -Operation ...`
 * in diskOpsEnv(). Each resolves with the script's result object.
 */
export function createDiskOps({ scriptPath, tempDir, powershell = windowsPowerShell(), run = runProcess, attacherPid = process.pid, env = process.env }) {
    if (typeof tempDir !== "string" || !path.win32.isAbsolute(tempDir)) throw new Error("the disk operations need the attacher's private temporary folder, as an absolute path");
    const childEnv = diskOpsEnv(env, tempDir);
    async function invoke(args, timeoutMs) {
        const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], { timeoutMs, env: childEnv });
        const answer = lastJsonObject(result.stdout);
        if (!answer) {
            const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
            throw new AttacherError(500, "DISK_OPERATION_FAILED", `the disk operation gave no result (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${detail}`, { retryable: true });
        }
        return answer;
    }
    return {
        online: ({ diskName, newGuid }) => invoke(["-Operation", "Online", "-DiskName", diskName, ...(newGuid ? ["-NewGuid"] : [])], 5 * 60_000),
        offline: ({ diskName, workerPid }) => invoke(["-Operation", "Offline", "-DiskName", diskName, "-WorkerPid", String(workerPid), "-AttacherPid", String(attacherPid)], 5 * 60_000),
        extend: ({ diskName, sizeGb }) => invoke(["-Operation", "Extend", "-DiskName", diskName, "-SizeGb", String(sizeGb)], 3 * 60_000),
        workerInstance: () => invoke(["-Operation", "WorkerInstance"], 60_000),
        folderAcl: (folder) => invoke(["-Operation", "FolderAcl", "-Root", folder], 60_000),
    };
}

/** The disk operations' TEMP and TMP, in the attacher's run folder. */
export const PRIVATE_TEMP_FOLDER = "ps-temp";
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
/**
 * Every right that adds, changes or removes a folder's entries or its access
 * list: add file and subfolder, write extended attributes and attributes,
 * delete child, delete, write DAC, write owner, generic all and generic write.
 */
const FOLDER_WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/**
 * What is wrong with a folder that only SYSTEM and Administrators may write,
 * from the disk script's FolderAcl answer (owner and rules as SIDs): another
 * owner, or any allow rule with a write right for anyone else, also one that
 * only what is created in the folder inherits. Empty when nothing is.
 */
export function privateFolderProblems(acl) {
    if (!isPlainObject(acl) || acl.ok !== true || !Array.isArray(acl.rules) || typeof acl.owner !== "string") {
        return [`its access list could not be read${isPlainObject(acl) && acl.message ? `: ${acl.message}` : ""}`];
    }
    const trusted = new Set([SYSTEM_SID, ADMINISTRATORS_SID]);
    const problems = [];
    if (!trusted.has(acl.owner)) problems.push(`it is owned by ${acl.owner}`);
    for (const rule of acl.rules) {
        if (!isPlainObject(rule) || typeof rule.sid !== "string" || !Number.isInteger(rule.rights)) {
            problems.push("it has a rule the attacher cannot read");
            continue;
        }
        if (rule.allow !== true || (rule.rights & FOLDER_WRITE_RIGHTS) === 0 || trusted.has(rule.sid)) continue;
        problems.push(`${rule.sid} may write ${rule.inheritOnly === true ? "what is created in it" : "in it"}`);
    }
    return problems;
}

/**
 * Makes the disk operations' private temporary folder ready at start: creates
 * it, refuses it unless it is a plain folder that only SYSTEM and
 * Administrators can write (it inherits the run folder's list, where the
 * worker only reads), then empties it, never through a link. Resolves with
 * what could not be removed; throws when the folder may not be used.
 */
export async function preparePrivateTemp(dir, { checkAcl, fsp = fs.promises }) {
    let stat = await fsp.lstat(dir).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
    if (!stat) {
        await fsp.mkdir(dir, { recursive: true });
        stat = await fsp.lstat(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is a link or a file, not a folder; refusing to run disk operations with it`);
    const problems = privateFolderProblems(await checkAcl(dir));
    if (problems.length) throw new Error(`${dir} must be writable by SYSTEM and Administrators only, but ${problems.join("; ")}`);
    const failed = [];
    for (const name of await fsp.readdir(dir)) {
        try {
            await removeTree(path.join(dir, name), fsp);
        } catch (error) {
            failed.push(`${name}: ${error?.code ?? error?.message ?? error}`);
        }
    }
    return { failed };
}

/** One operation at a time. */
export function createMutex() {
    let tail = Promise.resolve();
    return (fn) => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => {});
        return run;
    };
}

function checkDiskName(body) {
    if (typeof body.diskName !== "string" || !DISK_NAME.test(body.diskName)) {
        throw new AttacherError(400, "BAD_REQUEST", "diskName must be a managed disk name: letters, digits, _ . -");
    }
    return body.diskName;
}

/**
 * The attacher's routes, without sockets: `handle` takes a request
 * description and returns `{ status, body }`, so tests drive every check.
 */
export function createAttacherApp({ authorize, disk, sync, log = () => {} }) {
    const lun0 = createMutex();
    const releases = createMutex();
    // The disk this attacher brought online last; a new one gets a disk GUID of its own.
    let onlineDisk = null;

    const routes = {
        "/online-lun0": (body) => {
            const diskName = checkDiskName(body);
            return lun0(async () => {
                const result = await disk.online({ diskName, newGuid: onlineDisk !== diskName });
                if (result.ok === true) onlineDisk = diskName;
                return result.ok === true ? { ok: true } : diskFailure("/online-lun0", result);
            });
        },
        "/offline-lun0": (body) => {
            const diskName = checkDiskName(body);
            if (!Number.isSafeInteger(body.workerPid) || body.workerPid < 1 || body.workerPid > 0x7fffffff) {
                throw new AttacherError(400, "BAD_REQUEST", "workerPid must be the worker's process ID");
            }
            return lun0(async () => {
                const result = await disk.offline({ diskName, workerPid: body.workerPid });
                if (result.ok !== true) return diskFailure("/offline-lun0", result);
                onlineDisk = null;
                if (Array.isArray(result.stopped) && result.stopped.length) log(`attacher: stopped ${result.stopped.length} process(es) that used the drive before taking ${diskName} offline`);
                return { ok: true };
            });
        },
        "/extend-lun0": (body) => {
            const diskName = checkDiskName(body);
            if (!Number.isSafeInteger(body.sizeGb) || body.sizeGb < 1 || body.sizeGb > MAX_SIZE_GB) {
                throw new AttacherError(400, "BAD_REQUEST", `sizeGb must be a whole number of GiB from 1 to ${MAX_SIZE_GB}`);
            }
            return lun0(async () => {
                const result = await disk.extend({ diskName, sizeGb: body.sizeGb });
                if (result.ok === true) return { ok: true };
                if (result.retry === true) return { ok: false, retry: true, ...(typeof result.message === "string" ? { message: result.message } : {}) };
                return diskFailure("/extend-lun0", result);
            });
        },
        "/sync-release": () => releases(() => sync()),
    };

    function diskFailure(route, result) {
        const message = typeof result.message === "string" ? result.message : "the disk operation failed";
        log(`attacher: ${route} failed: ${message}`);
        throw new AttacherError(500, result.retry === true ? "NOT_READY" : "DISK_OPERATION_FAILED", message, { retryable: result.retry === true });
    }

    async function handle({ method, url, headers = {}, body: text = "" }) {
        if (!authorize(headers.authorization)) return { status: 401, body: { ok: false, code: "UNAUTHENTICATED", message: "a valid bearer token is required" } };
        let pathname;
        try {
            pathname = new URL(url, "http://127.0.0.1").pathname;
        } catch {
            return { status: 400, body: { ok: false, code: "BAD_REQUEST", message: "the request URL is not valid" } };
        }
        const route = Object.hasOwn(routes, pathname) ? routes[pathname] : null;
        if (!route) return { status: 404, body: { ok: false, code: "NOT_FOUND", message: "no such route" } };
        if (method !== "POST") return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED", message: "use POST" } };
        let body;
        try {
            body = String(text).trim() ? JSON.parse(text) : {};
        } catch {
            return { status: 400, body: { ok: false, code: "BAD_REQUEST", message: "the body is not JSON" } };
        }
        if (!isPlainObject(body)) return { status: 400, body: { ok: false, code: "BAD_REQUEST", message: "the body must be a JSON object" } };
        try {
            return { status: 200, body: await route(body) };
        } catch (error) {
            if (error instanceof AttacherError) {
                return { status: error.status, body: { ok: false, code: error.code, message: error.message, retryable: error.retryable } };
            }
            log(`attacher: ${pathname} failed: ${error?.message ?? error}`);
            return { status: 500, body: { ok: false, code: "INTERNAL", message: String(error?.message ?? error).slice(0, 500), retryable: true } };
        }
    }

    return { handle };
}

/** Serves `app` on 127.0.0.1 only. Resolves with the listening server. */
export function startServer(app, { port, host = "127.0.0.1", log = () => {} }) {
    if (host !== "127.0.0.1") throw new Error("the attacher listens on 127.0.0.1 only");
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        let size = 0;
        try {
            for await (const chunk of req) {
                size += chunk.length;
                if (size <= BODY_LIMIT) chunks.push(chunk);
            }
            const answer = size > BODY_LIMIT
                ? { status: 413, body: { ok: false, code: "TOO_LARGE", message: "the body is too large" } }
                : await app.handle({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
            const payload = JSON.stringify(answer.body);
            res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
            res.end(payload);
        } catch (error) {
            log(`attacher: a request failed: ${error?.message ?? error}`);
            res.destroy();
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, exclusive: true }, () => {
            server.off("error", reject);
            resolve(server);
        });
    });
}

// ── The release ─────────────────────────────────────────────────────────

/**
 * current-release.json (README, "current-release.json"), checked:
 *
 *   { "schemaVersion": 1, "commitSha": "<40 hex>", "zipSha256": "<64 hex>",
 *     "modelCatalog": { "blob", "sha256" }?, "headlessInstructions": { "blob", "sha256" }?,
 *     "plugins": [{ "name", "blob", "sha256" }]? }
 *
 * The release zip itself is the blob worker-release-<commitSha>.zip.
 */
export function validateReleaseManifest(value) {
    const bad = (message) => new AttacherError(502, "BAD_RELEASE_MANIFEST", `current-release.json: ${message}`);
    if (!isPlainObject(value)) throw bad("must be a JSON object");
    const known = ["schemaVersion", "commitSha", "zipSha256", "modelCatalog", "headlessInstructions", "plugins"];
    const unknown = Object.keys(value).filter((key) => !known.includes(key));
    if (unknown.length) throw bad(`unknown fields ${unknown.join(", ")}`);
    if (value.schemaVersion !== 1) throw bad("schemaVersion must be 1");
    if (typeof value.commitSha !== "string" || !COMMIT.test(value.commitSha)) throw bad("commitSha must be a lowercase commit ID");
    if (typeof value.zipSha256 !== "string" || !SHA256.test(value.zipSha256)) throw bad("zipSha256 must be 64 lowercase hex digits");
    const artifact = (entry, label) => {
        if (!isPlainObject(entry)) throw bad(`${label} must be an object`);
        const extra = Object.keys(entry).filter((key) => !["name", "blob", "sha256"].includes(key));
        if (extra.length) throw bad(`${label} has unknown fields ${extra.join(", ")}`);
        if (typeof entry.blob !== "string" || !BLOB_NAME.test(entry.blob) || entry.blob === RELEASE_MANIFEST_BLOB) throw bad(`${label}.blob is not a valid blob name`);
        if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw bad(`${label}.sha256 must be 64 lowercase hex digits`);
        return { blob: entry.blob, sha256: entry.sha256 };
    };
    const manifest = { schemaVersion: 1, commitSha: value.commitSha, zipSha256: value.zipSha256, modelCatalog: null, headlessInstructions: null, plugins: [] };
    if (value.modelCatalog !== undefined && value.modelCatalog !== null) {
        if ("name" in value.modelCatalog) throw bad("modelCatalog has no name");
        manifest.modelCatalog = artifact(value.modelCatalog, "modelCatalog");
    }
    if (value.headlessInstructions !== undefined && value.headlessInstructions !== null) {
        if ("name" in value.headlessInstructions) throw bad("headlessInstructions has no name");
        manifest.headlessInstructions = artifact(value.headlessInstructions, "headlessInstructions");
    }
    if (value.plugins !== undefined) {
        if (!Array.isArray(value.plugins)) throw bad("plugins must be a list");
        const names = new Set();
        for (const [index, entry] of value.plugins.entries()) {
            const checked = artifact(entry, `plugins[${index}]`);
            if (typeof entry.name !== "string" || !PLUGIN_NAME.test(entry.name)) throw bad(`plugins[${index}].name must be letters, digits, _ . -`);
            if (names.has(lower(entry.name))) throw bad(`plugin ${entry.name} is listed twice`);
            names.add(lower(entry.name));
            manifest.plugins.push({ name: entry.name, ...checked });
        }
    }
    return manifest;
}

export const releaseZipBlob = (commitSha) => `worker-release-${commitSha}.zip`;
/** The folder a release extracts to: short, so deep node_modules paths stay short too. */
export const releaseFolderName = (manifest) => `${manifest.commitSha.slice(0, 12)}-${manifest.zipSha256.slice(0, 12)}`;

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * The entries of a zip file, from its central directory, each checked
 * against the local header it points to (both must name the same path).
 * @returns {Promise<Array<{ name: string, directory: boolean, symlink: boolean }>>}
 */
export async function readZipEntries(file, { fsp = fs.promises, maxEntries = 500_000 } = {}) {
    const handle = await fsp.open(file, "r");
    try {
        const { size } = await handle.stat();
        const read = async (position, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new Error("the zip ends early");
            return buffer;
        };
        const tailLength = Math.min(size, 22 + 65_535);
        const tail = await read(size - tailLength, tailLength);
        const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        if (eocd < 0) throw new Error("the file is not a zip archive");
        let count = tail.readUInt16LE(eocd + 10);
        let directorySize = tail.readUInt32LE(eocd + 12);
        let directoryOffset = tail.readUInt32LE(eocd + 16);
        if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
            const locator = eocd - 20;
            if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error("the zip64 locator is missing");
            const zip64 = await read(Number(tail.readBigUInt64LE(locator + 8)), 56);
            if (zip64.readUInt32LE(0) !== 0x06064b50) throw new Error("the zip64 directory record is missing");
            count = Number(zip64.readBigUInt64LE(32));
            directorySize = Number(zip64.readBigUInt64LE(40));
            directoryOffset = Number(zip64.readBigUInt64LE(48));
        }
        if (count > maxEntries) throw new Error(`the zip has ${count} entries, more than ${maxEntries}`);
        if (directoryOffset + directorySize > size) throw new Error("the zip's central directory lies outside the file");
        const directory = await read(directoryOffset, directorySize);
        const entries = [];
        let offset = 0;
        for (let index = 0; index < count; index++) {
            if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error("the zip's central directory is damaged");
            const madeBy = directory.readUInt16LE(offset + 4) >> 8;
            const flags = directory.readUInt16LE(offset + 8);
            const nameLength = directory.readUInt16LE(offset + 28);
            const extraLength = directory.readUInt16LE(offset + 30);
            const commentLength = directory.readUInt16LE(offset + 32);
            const external = directory.readUInt32LE(offset + 38);
            let localOffset = directory.readUInt32LE(offset + 42);
            const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
            if (localOffset === 0xffffffff) {
                // The local header's offset is in the zip64 extra field, after any 64-bit sizes it replaces.
                const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
                for (let at = 0; at + 4 <= extra.length;) {
                    const id = extra.readUInt16LE(at);
                    const length = extra.readUInt16LE(at + 2);
                    if (id === 0x0001) {
                        let field = at + 4;
                        if (directory.readUInt32LE(offset + 24) === 0xffffffff) field += 8;
                        if (directory.readUInt32LE(offset + 20) === 0xffffffff) field += 8;
                        localOffset = Number(extra.readBigUInt64LE(field));
                        break;
                    }
                    at += 4 + length;
                }
            }
            const name = (flags & 0x800) ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
            const local = await read(localOffset, 30);
            if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`the local header of ${name} is missing`);
            const localName = await read(localOffset + 30, local.readUInt16LE(26));
            if (!localName.equals(nameBytes)) throw new Error(`the zip names an entry differently in its directory (${name}) and its local header`);
            const unixMode = madeBy === 3 ? external >>> 16 : 0;
            entries.push({
                name,
                directory: name.endsWith("/") || (unixMode & 0o170000) === 0o040000 || (external & 0x10) !== 0,
                symlink: (unixMode & 0o170000) === 0o120000,
            });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    } finally {
        await handle.close();
    }
}

/**
 * Refuses an archive with anything that could land outside the folder it
 * extracts to, or that is not a plain file or folder: links, absolute paths,
 * drive letters, `..`, backslashes, alternate data streams, device names.
 */
export function checkArchiveEntries(entries) {
    if (!entries.length) throw new AttacherError(502, "UNSAFE_ARCHIVE", "the archive is empty");
    for (const entry of entries) {
        const refuse = (why) => new AttacherError(502, "UNSAFE_ARCHIVE", `the archive entry ${JSON.stringify(entry.name).slice(0, 200)} ${why}`);
        const name = entry.name;
        if (entry.symlink) throw refuse("is a link");
        if (!name || name.length > 1024) throw refuse("has no name or too long a name");
        if (/[\x00-\x1f\x7f\\:*?"<>|]/.test(name)) throw refuse("has a character Windows paths may not hold here");
        if (name.startsWith("/")) throw refuse("is an absolute path");
        for (const segment of name.replace(/\/$/, "").split("/")) {
            if (segment === "" || segment === "." || segment === "..") throw refuse("has an empty, . or .. segment");
            if (RESERVED_NAME.test(segment)) throw refuse("names a device");
            if (/[. ]$/.test(segment)) throw refuse("has a segment ending in a dot or a space");
        }
    }
}

/** Every link or junction under `dir` (up to `limit`), never following one. */
export async function findLinks(dir, { limit = 10, fsp = fs.promises } = {}) {
    const found = [];
    const stack = [dir];
    while (stack.length && found.length < limit) {
        const current = stack.pop();
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) found.push(full);
            else if (entry.isDirectory()) stack.push(full);
        }
    }
    return found;
}

async function removeTree(target, fsp = fs.promises) {
    let stat;
    try {
        stat = await fsp.lstat(target);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
    }
    if (stat.isSymbolicLink()) {
        try {
            await fsp.unlink(target);
        } catch {
            await fsp.rmdir(target);
        }
        return;
    }
    if (stat.isDirectory()) {
        for (const name of await fsp.readdir(target)) await removeTree(path.join(target, name), fsp);
        await fsp.rmdir(target);
        return;
    }
    try {
        await fsp.unlink(target);
    } catch (error) {
        if (error?.code !== "EPERM") throw error;
        await fsp.chmod(target, 0o666);
        await fsp.unlink(target);
    }
}

async function exists(target, fsp = fs.promises) {
    try {
        await fsp.lstat(target);
        return true;
    } catch {
        return false;
    }
}

async function writeFileAtomic(file, data, fsp = fs.promises) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(temp, data);
    try {
        await fsp.rename(temp, file);
    } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

async function sha256OfFile(file) {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
}

/** One GET; resolves with the response stream (any status). */
export function httpsGet(url, { headers = {}, timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers, agent: false }, resolve);
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`no data within ${timeoutMs} ms`)));
        req.on("error", reject);
    });
}

async function readAll(stream, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("the answer is too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** Tokens from IMDS for the VM's identity, kept in memory until five minutes before they expire. */
export function createImdsTokenSource({ resource, clientId, request, now = Date.now }) {
    let cached = null;
    return async () => {
        if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token;
        const url = `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}&client_id=${encodeURIComponent(clientId)}`;
        const answer = await request(url);
        if (answer.status !== 200) throw new AttacherError(503, "IMDS_UNAVAILABLE", `IMDS answered HTTP ${answer.status} for a storage token`, { retryable: true });
        const body = JSON.parse(answer.text);
        if (typeof body?.access_token !== "string" || !body.access_token) throw new AttacherError(503, "IMDS_UNAVAILABLE", "IMDS answered without a token", { retryable: true });
        const expiresOn = Number(body.expires_on) * 1000;
        cached = { token: body.access_token, expiresAt: Number.isFinite(expiresOn) && expiresOn > 0 ? expiresOn : now() + 5 * 60_000 };
        return cached.token;
    };
}

/** IMDS GET (link-local, no proxy, no kept-alive socket). */
export function imdsRequest(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers: { Metadata: "true" }, agent: false }, (res) => {
            readAll(res, 1024 * 1024).then((buffer) => resolve({ status: res.statusCode ?? 0, text: buffer.toString("utf8") }), reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`IMDS gave no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
    });
}

/**
 * The release container, read with the VM identity's token. Every download
 * is hashed while it streams to disk and refused when the hash is not the
 * one current-release.json names.
 */
export function createBlobClient({ accountUrl, container, getToken, get = httpsGet, attempts = 3, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const base = `${String(accountUrl).replace(/\/+$/, "")}/${container}/`;
    const urlOf = (name) => `${base}${name.split("/").map(encodeURIComponent).join("/")}`;
    const transient = (status) => status === 408 || status === 429 || status >= 500;

    async function open(name) {
        const token = await getToken();
        return get(urlOf(name), { headers: { authorization: `Bearer ${token}`, "x-ms-version": "2021-08-06" } });
    }

    async function withRetries(name, fn) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (error instanceof AttacherError && !error.retryable) throw error;
                lastError = error;
            }
            if (attempt < attempts) await wait(1_000 * 2 ** attempt);
        }
        throw lastError instanceof AttacherError ? lastError
            : new AttacherError(503, "BLOB_UNAVAILABLE", `reading ${name} failed: ${lastError?.message ?? lastError}`, { retryable: true });
    }

    async function checkStatus(name, res) {
        if (res.statusCode === 200) return;
        res.resume();
        const status = res.statusCode ?? 0;
        throw new AttacherError(status === 404 ? 502 : 503, status === 404 ? "BLOB_MISSING" : "BLOB_UNAVAILABLE",
            `the release container answered HTTP ${status} for ${name}`, { retryable: status !== 404 && (transient(status) || status === 401 || status === 403) });
    }

    return {
        getText: (name, maxBytes = 1024 * 1024) => withRetries(name, async () => {
            const res = await open(name);
            await checkStatus(name, res);
            return (await readAll(res, maxBytes)).toString("utf8");
        }),
        download: (name, file, { sha256, maxBytes }) => withRetries(name, async () => {
            const res = await open(name);
            await checkStatus(name, res);
            const hash = createHash("sha256");
            let size = 0;
            const meter = new Transform({
                transform(chunk, _encoding, done) {
                    size += chunk.length;
                    if (size > maxBytes) return done(new AttacherError(502, "ARTIFACT_TOO_LARGE", `${name} is larger than ${maxBytes} bytes`));
                    hash.update(chunk);
                    return done(null, chunk);
                },
            });
            await pipeline(res, meter, fs.createWriteStream(file));
            const digest = hash.digest("hex");
            if (digest !== sha256) {
                await fs.promises.rm(file, { force: true });
                throw new AttacherError(502, "HASH_MISMATCH", `${name} has SHA-256 ${digest}, not the ${sha256} that current-release.json names`);
            }
            return { size };
        }),
    };
}

/** tar.exe of Windows, by its full path, extracts zips: `tar.exe -x -f <zip> -C <folder>`. */
export function createZipExtractor({ tar = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), run = runProcess } = {}) {
    return async (zipFile, dest) => {
        const result = await run(tar, ["-x", "-f", zipFile, "-C", dest], { timeoutMs: 30 * 60_000 });
        if (result.code !== 0) {
            throw new AttacherError(500, "EXTRACT_FAILED", `tar.exe could not extract ${path.basename(zipFile)}: ${String(result.stderr).trim().slice(0, 400)}`, { retryable: true });
        }
    };
}

/**
 * /sync-release. Brings C:\pilotswarm into the state current-release.json
 * names (README, "The release on a VM"):
 *
 *   releases\<commit12>-<zip12>\   each release, extracted once and never changed
 *   current                       a junction to the release in use
 *   plugins\<name>\               the deployment's plugins
 *   headless-instructions\        the headless instructions
 *   model_providers.json          the model catalog
 *   disk-controller-ca.crt        the controller's CAs (one, or two during a CA rotation), from userData
 *
 * Nothing is downloaded when that state is already in place. Every artifact
 * is checked against its SHA-256 before it is extracted or used. A release
 * changes only in the first successful sync of each start of the worker
 * service, before its worker runs; later calls never change the release a
 * running worker uses.
 */
export function createReleaseSync({
    root = DEFAULT_ROOT, settings, getUserData, createBlob, extract, readEntries = readZipEntries, getWorkerInstance,
    log = () => {}, fsp = fs.promises, now = Date.now, maxZipBytes = 8 * 1024 ** 3, maxArtifactBytes = 512 * 1024 ** 2,
}) {
    const releasesDir = path.join(root, "releases");
    const currentDir = path.join(root, "current");
    const pluginsDir = path.join(root, "plugins");
    const instructionsDir = path.join(root, "headless-instructions");
    const stateFile = path.join(root, "run", "release-state.json");
    const random = () => randomBytes(6).toString("hex");
    const markerOf = (releaseDir) => `${releaseDir}.complete.json`;
    let cleanup = Promise.resolve();

    async function readState() {
        try {
            const state = JSON.parse(await fsp.readFile(stateFile, "utf8"));
            return isPlainObject(state) ? state : {};
        } catch {
            return {};
        }
    }

    async function realpathOrNull(target) {
        try {
            return await fsp.realpath(target);
        } catch {
            return null;
        }
    }

    const samePath = (a, b) => (a && b ? (process.platform === "win32" ? lower(a) === lower(b) : a === b) : false);

    async function releaseComplete(releaseDir, manifest) {
        try {
            const marker = JSON.parse(await fsp.readFile(markerOf(releaseDir), "utf8"));
            return marker?.zipSha256 === manifest.zipSha256 && marker?.commitSha === manifest.commitSha && (await exists(releaseDir, fsp));
        } catch {
            return false;
        }
    }

    async function installed(manifest, state) {
        if (JSON.stringify(state.installed?.manifest ?? null) !== JSON.stringify(manifest)) return false;
        const releaseDir = path.join(releasesDir, releaseFolderName(manifest));
        if (!(await releaseComplete(releaseDir, manifest))) return false;
        if (!samePath(await realpathOrNull(currentDir), await realpathOrNull(releaseDir))) return false;
        for (const plugin of manifest.plugins) if (!(await exists(path.join(pluginsDir, plugin.name), fsp))) return false;
        if (Boolean(manifest.headlessInstructions) !== (await exists(instructionsDir, fsp))) return false;
        if (manifest.modelCatalog) {
            if (!(await exists(settings.catalogFile, fsp)) || (await sha256OfFile(settings.catalogFile)) !== manifest.modelCatalog.sha256) return false;
        } else if (await exists(settings.catalogFile, fsp)) {
            return false;
        }
        return true;
    }

    /** A switch that a crash interrupted: put `current` back, drop leftovers. */
    async function recover() {
        const names = await fsp.readdir(root).catch(() => []);
        const fresh = names.filter((name) => name.startsWith("current.new-")).sort();
        if (!(await exists(currentDir, fsp)) && fresh.length) await fsp.rename(path.join(root, fresh.pop()), currentDir);
        for (const name of names) {
            if ((name.startsWith("current.new-") || name.startsWith("current.old-")) && (await exists(path.join(root, name), fsp))) {
                await removeTree(path.join(root, name), fsp).catch(() => {});
            }
        }
        for (const name of await fsp.readdir(releasesDir).catch(() => [])) {
            if (name.startsWith(".staging-")) await removeTree(path.join(releasesDir, name), fsp).catch(() => {});
        }
        for (const name of await fsp.readdir(pluginsDir).catch(() => [])) {
            if (name.includes(".old-")) await removeTree(path.join(pluginsDir, name), fsp).catch(() => {});
        }
        for (const name of names) {
            if (name.startsWith("headless-instructions.old-")) await removeTree(path.join(root, name), fsp).catch(() => {});
        }
    }

    async function extractChecked(zipFile, dest) {
        let entries;
        try {
            entries = await readEntries(zipFile);
        } catch (error) {
            throw new AttacherError(502, "UNSAFE_ARCHIVE", `${path.basename(zipFile)} cannot be read as a zip: ${error?.message ?? error}`);
        }
        checkArchiveEntries(entries);
        await fsp.mkdir(dest, { recursive: true });
        await extract(zipFile, dest);
        const links = await findLinks(dest, { fsp });
        if (links.length) throw new AttacherError(502, "UNSAFE_ARCHIVE", `extracting ${path.basename(zipFile)} created links: ${links.slice(0, 3).join(", ")}`);
    }

    async function replaceFolder(target, staged) {
        let old = null;
        if (await exists(target, fsp)) {
            old = `${target}.old-${random()}`;
            await fsp.rename(target, old);
        }
        await fsp.rename(staged, target);
        if (old) await removeTree(old, fsp).catch((error) => log(`attacher: could not remove ${old}: ${error?.message ?? error}`));
    }

    /** Points `current` at `releaseDir`: a new junction, renamed into place. */
    async function switchCurrent(releaseDir) {
        const fresh = path.join(root, `current.new-${random()}`);
        await fsp.symlink(releaseDir, fresh, "junction");
        let old = null;
        if (await exists(currentDir, fsp)) {
            old = path.join(root, `current.old-${random()}`);
            await fsp.rename(currentDir, old);
        }
        await fsp.rename(fresh, currentDir);
        if (old) await removeTree(old, fsp);
    }

    /** Deletes releases other than the current and the previous one, in the background. */
    function collect(keep) {
        cleanup = cleanup.then(async () => {
            for (const name of await fsp.readdir(releasesDir).catch(() => [])) {
                if (name.startsWith(".") || name.endsWith(".complete.json")) continue;
                const dir = path.join(releasesDir, name);
                if (keep.some((kept) => samePath(kept, dir))) continue;
                await fsp.rm(markerOf(dir), { force: true }).catch(() => {});
                await removeTree(dir, fsp).catch((error) => log(`attacher: could not remove the old release ${name}: ${error?.message ?? error}`));
            }
        }).catch((error) => log(`attacher: removing old releases failed: ${error?.message ?? error}`));
        return cleanup;
    }

    async function sync() {
        const userData = await getUserData();
        const ca = String(userData.controllerCaCert);
        if ((await fsp.readFile(settings.caFile, "utf8").catch(() => null)) !== ca) await writeFileAtomic(settings.caFile, ca, fsp);

        const blob = createBlob(userData);
        let manifest;
        try {
            manifest = validateReleaseManifest(JSON.parse(await blob.getText(RELEASE_MANIFEST_BLOB)));
        } catch (error) {
            if (error instanceof AttacherError) throw error;
            throw new AttacherError(502, "BAD_RELEASE_MANIFEST", `current-release.json is not JSON: ${error?.message ?? error}`);
        }
        await fsp.mkdir(releasesDir, { recursive: true });
        await recover();
        const state = await readState();
        const releaseDir = path.join(releasesDir, releaseFolderName(manifest));
        const answer = (changed) => ({ ok: true, changed, commitSha: manifest.commitSha, release: path.basename(releaseDir) });
        let instance = null;
        let instanceError = null;
        try {
            instance = await getWorkerInstance();
        } catch (error) {
            instanceError = error;
        }
        const instanceKey = instance?.pid ? `${instance.pid}@${instance.started}` : null;

        if (await installed(manifest, state)) {
            // This start of the worker service has its release: from now on it never changes under it.
            if (instanceKey && state.syncedInstance !== instanceKey) await writeFileAtomic(stateFile, JSON.stringify({ ...state, syncedInstance: instanceKey }), fsp);
            else if (instanceError) log(`attacher: the worker service's state is unknown: ${instanceError?.message ?? instanceError}`);
            return answer(false);
        }
        if (instanceError) {
            throw new AttacherError(503, "WORKER_STATE_UNKNOWN", `the release changes only before the worker runs, and the worker service's state is unknown: ${instanceError?.message ?? instanceError}`, { retryable: true });
        }
        if (instanceKey && state.syncedInstance === instanceKey) {
            throw new AttacherError(409, "WORKER_RUNNING",
                "the release changed after this start of the worker service synced; it is installed at the service's next start, never under a running worker");
        }

        const staging = path.join(releasesDir, `.staging-${random()}`);
        await fsp.mkdir(staging, { recursive: true });
        try {
            if (!(await releaseComplete(releaseDir, manifest))) {
                log(`attacher: downloading release ${manifest.commitSha}`);
                const zipFile = path.join(staging, "release.zip");
                await blob.download(releaseZipBlob(manifest.commitSha), zipFile, { sha256: manifest.zipSha256, maxBytes: maxZipBytes });
                const extracted = path.join(staging, "release");
                await extractChecked(zipFile, extracted);
                await fsp.rm(zipFile, { force: true });
                // A folder without its marker never finished extracting, so no worker ever used it.
                if (await exists(releaseDir, fsp)) await removeTree(releaseDir, fsp);
                await fsp.rename(extracted, releaseDir);
                await writeFileAtomic(markerOf(releaseDir), JSON.stringify({ commitSha: manifest.commitSha, zipSha256: manifest.zipSha256, at: new Date(now()).toISOString() }), fsp);
            }

            const previous = state.installed?.manifest;
            const stagedPlugins = [];
            for (const plugin of manifest.plugins) {
                const kept = previous?.plugins?.find((entry) => entry.name === plugin.name && entry.sha256 === plugin.sha256);
                if (kept && (await exists(path.join(pluginsDir, plugin.name), fsp))) continue;
                const zipFile = path.join(staging, `plugin-${plugin.name}.zip`);
                await blob.download(plugin.blob, zipFile, { sha256: plugin.sha256, maxBytes: maxArtifactBytes });
                const dest = path.join(staging, "plugins", plugin.name);
                await extractChecked(zipFile, dest);
                stagedPlugins.push({ name: plugin.name, dest });
            }
            let stagedInstructions = null;
            if (manifest.headlessInstructions
                && !(previous?.headlessInstructions?.sha256 === manifest.headlessInstructions.sha256 && (await exists(instructionsDir, fsp)))) {
                const zipFile = path.join(staging, "headless-instructions.zip");
                await blob.download(manifest.headlessInstructions.blob, zipFile, { sha256: manifest.headlessInstructions.sha256, maxBytes: maxArtifactBytes });
                stagedInstructions = path.join(staging, "headless-instructions");
                await extractChecked(zipFile, stagedInstructions);
            }
            let stagedCatalog = null;
            if (manifest.modelCatalog) {
                stagedCatalog = path.join(staging, "model_providers.json");
                await blob.download(manifest.modelCatalog.blob, stagedCatalog, { sha256: manifest.modelCatalog.sha256, maxBytes: 16 * 1024 * 1024 });
            }

            // Everything is downloaded and checked: switch.
            const previousRelease = await realpathOrNull(currentDir);
            await switchCurrent(releaseDir);
            await fsp.mkdir(pluginsDir, { recursive: true });
            for (const { name, dest } of stagedPlugins) await replaceFolder(path.join(pluginsDir, name), dest);
            const named = new Set(manifest.plugins.map((plugin) => lower(plugin.name)));
            for (const name of await fsp.readdir(pluginsDir)) {
                if (!named.has(lower(name))) await removeTree(path.join(pluginsDir, name), fsp);
            }
            if (stagedInstructions) await replaceFolder(instructionsDir, stagedInstructions);
            else if (!manifest.headlessInstructions) await removeTree(instructionsDir, fsp);
            if (stagedCatalog) await fsp.rename(stagedCatalog, settings.catalogFile);
            else await fsp.rm(settings.catalogFile, { force: true });

            await writeFileAtomic(stateFile, JSON.stringify({
                schemaVersion: 1, installed: { manifest, release: path.basename(releaseDir), at: new Date(now()).toISOString() }, syncedInstance: instanceKey,
            }), fsp);
            log(`attacher: release ${manifest.commitSha} is in place (${path.basename(releaseDir)})`);
            collect([releaseDir, previousRelease].filter(Boolean));
            return answer(true);
        } finally {
            await removeTree(staging, fsp).catch(() => {});
        }
    }

    return {
        sync,
        /** Resolves once old releases scheduled for removal are gone (tests). */
        cleanedUp: () => cleanup,
    };
}

/**
 * Restricts the token file to SYSTEM and Administrators (full) and the worker
 * service (read), with icacls by its full path.
 */
export function icaclsSetTokenAcl({ run = runProcess, systemRoot = process.env.SystemRoot || "C:\\Windows" } = {}) {
    const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");
    return async (file) => {
        const result = await run(icacls, [file, "/inheritance:r", "/grant:r", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)", `*${serviceSid(WORKER_SERVICE)}:(R)`], { timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(`icacls could not restrict ${file}: ${String(result.stderr || result.stdout).trim().slice(0, 300)}`);
    };
}

/** Retries IMDS while it is not ready. */
async function retry(fn, { attempts = 8, log = () => {} } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            log(`attacher: ${error?.message ?? error}; retrying`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1_000 * 2 ** (attempt - 1))));
    }
    throw lastError;
}

async function main({ root = DEFAULT_ROOT } = {}) {
    const log = (message) => console.log(message);
    const workerEnv = parseEnvFile(await fs.promises.readFile(path.join(root, "worker.env"), "utf8"));
    const settings = attacherSettings(workerEnv, { root });
    const readUserData = async () => {
        const answer = await imdsRequest("http://169.254.169.254/metadata/instance/compute/userData?api-version=2021-01-01&format=text");
        if (answer.status !== 200) throw new AttacherError(503, "IMDS_UNAVAILABLE", `IMDS answered HTTP ${answer.status} for userData`, { retryable: true });
        try {
            return decodeAttacherUserData(answer.text);
        } catch (error) {
            throw new AttacherError(502, "BAD_USER_DATA", error.message);
        }
    };
    const userData = await retry(readUserData, { log });
    // The CA is in place before the worker's first heartbeat, not only after a release sync.
    await writeFileAtomic(settings.caFile, userData.controllerCaCert).catch((error) => log(`attacher: could not write ${settings.caFile}: ${error.message}`));

    const scriptPath = path.join(root, "run", "disk-ops.ps1");
    await writeFileAtomic(scriptPath, DISK_OPS_SCRIPT);
    const tempDir = path.join(root, "run", PRIVATE_TEMP_FOLDER);
    const disk = createDiskOps({ scriptPath, tempDir });
    // Fails the start when the folder is not private: the disk operations compile C# in it.
    const cleared = await preparePrivateTemp(tempDir, { checkAcl: (dir) => disk.folderAcl(dir) });
    if (cleared.failed.length) log(`attacher: could not empty ${tempDir} of ${cleared.failed.length} item(s): ${cleared.failed.slice(0, 3).join("; ")}`);
    const token = newToken();
    await writeTokenFile(settings.tokenFile, token, { setAcl: icaclsSetTokenAcl() });

    const storageTokens = new Map();
    const releaseSync = createReleaseSync({
        root,
        settings,
        getUserData: readUserData,
        createBlob: (data) => {
            const key = data.clientId;
            if (!storageTokens.has(key)) storageTokens.set(key, createImdsTokenSource({ resource: "https://storage.azure.com/", clientId: data.clientId, request: imdsRequest }));
            return createBlobClient({ accountUrl: data.accountUrl, container: settings.container, getToken: storageTokens.get(key) });
        },
        extract: createZipExtractor(),
        getWorkerInstance: async () => {
            const result = await disk.workerInstance();
            if (result.ok !== true) throw new AttacherError(503, "WORKER_STATE_UNKNOWN", `the worker service's state is unknown: ${result.message ?? "no answer"}`, { retryable: true });
            return result;
        },
        log,
    });
    const app = createAttacherApp({ authorize: createAuthorizer(token), disk, sync: releaseSync.sync, log });
    const server = await startServer(app, { port: settings.port, log });
    log(`attacher: listening on 127.0.0.1:${settings.port}`);

    let stopping = false;
    const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        log(`attacher: ${signal} received; finishing the requests in flight`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 110_000).unref();
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => stop(signal));
}

function isMainModule() {
    if (!process.argv[1]) return false;
    try {
        const main = pathToFileURL(fs.realpathSync(process.argv[1])).href;
        return process.platform === "win32" ? main.toLowerCase() === import.meta.url.toLowerCase() : main === import.meta.url;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    main().catch((error) => {
        console.error(`attacher: cannot start: ${error?.message ?? error}`);
        process.exit(1);
    });
}
