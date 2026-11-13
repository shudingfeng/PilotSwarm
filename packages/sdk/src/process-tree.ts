/**
 * Process helpers for stopping background shells the Copilot CLI will not
 * cancel (session workspaces, docs/proposals/session-workspaces.md 4.5).
 *
 * Verified on CLI 1.0.83:
 *   - after session.abort(), rpc.tasks.cancel answers { cancelled: false }
 *     for a detached shell, and the shell keeps running
 *   - the pid the CLI reports for a detached shell is not a process-group
 *     leader, so a group kill misses its children
 *   - after the process dies, the CLI still lists the task as running
 *
 *   - after a detached shell ends by itself, the CLI still lists it as
 *     running with its pid, which the host may give to another process
 *
 * The CLI runs on this host, so its pids are ours. These helpers walk the
 * process tree below a pid: /proc on Linux, WMI on Windows, `ps` elsewhere.
 *
 * On Windows they read WMI through [wmisearcher], which needs no PowerShell
 * module: loading one (Get-CimInstance's) took over 5 s on a fresh host, a
 * CI runner with many modules and no module analysis cache. [wmisearcher]
 * also runs in Constrained Language Mode, and the WMI time it prints is
 * converted here.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Kill every process of a process group (Workflow Simplified stage 2.4, PR 235 6e2a1fec: a script leads its own group, so
 * a process it started that left the tree, a daemon reparented to init, is still found). False when the group is gone or
 * cannot be signalled. POSIX only; false on Windows.
 */
export function killProcessGroup(pgid: unknown): boolean {
    if (process.platform === "win32" || typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false;
    try {
        process.kill(-pgid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

/** True while the process exists (EPERM: it exists, under another user). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
}

let clockTicksPerSecond: number | undefined;
function linuxClockTicks(): number {
    if (clockTicksPerSecond === undefined) {
        try {
            clockTicksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2_000 }).trim()) || 100;
        } catch {
            clockTicksPerSecond = 100;
        }
    }
    return clockTicksPerSecond;
}

/**
 * A WMI time, "yyyymmddHHMMSS.ffffff" and its offset from UTC in minutes
 * ("+000", "-480"), in epoch milliseconds; undefined when it is not one.
 */
export function wmiDateTimeMs(value: string): number | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d{3}([+-]\d{3})$/.exec(value.trim());
    if (!match) return undefined;
    const [year, month, day, hour, minute, second, millis, offsetMinutes] = match.slice(1).map(Number);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * How long one command these helpers run (PowerShell, taskkill, `ps`) may
 * take. They run synchronously, so the caller waits that long at most.
 */
export interface ProcessQueryOptions {
    /** 5 s when not given. */
    timeoutMs?: number;
}

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * When a process started, in epoch milliseconds, or undefined when this host
 * cannot tell. Linux: field 22 of /proc/<pid>/stat (clock ticks after boot)
 * plus the boot time from /proc/stat. Windows: the WMI CreationDate.
 * Elsewhere: `ps -o lstart=`, to the second.
 */
export function processStartTimeMs(pid: number, { timeoutMs = COMMAND_TIMEOUT_MS }: ProcessQueryOptions = {}): number | undefined {
    if (process.platform === "win32") {
        if (!Number.isInteger(pid) || pid <= 0) return undefined;
        try {
            const out = execFileSync(WINDOWS_POWERSHELL, [
                "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                `foreach ($p in ([wmisearcher]'SELECT CreationDate FROM Win32_Process WHERE ProcessId = ${pid}').Get()) { $p.CreationDate }`,
            ], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
            return wmiDateTimeMs(out);
        } catch {
            return undefined;
        }
    }
    if (fs.existsSync("/proc/self/stat")) {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            // Fields after "(comm) " start at field 3, so field 22 is [19].
            const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
            const bootSeconds = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
            if (!Number.isFinite(ticks) || !Number.isFinite(bootSeconds) || bootSeconds <= 0) return undefined;
            return bootSeconds * 1000 + Math.round((ticks / linuxClockTicks()) * 1000);
        } catch {
            return undefined;
        }
    }
    try {
        const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf8", timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" },
        }).trim();
        const ms = Date.parse(out);
        return Number.isFinite(ms) ? ms : undefined;
    } catch {
        return undefined;
    }
}

/** How much later than its task a process may seem to start: the boot time and `ps` are in whole seconds. */
const START_TIME_SLACK_MS = 2_000;

/**
 * True while `pid` still runs the process a task started at `startedAt`.
 * CLI 1.0.83 keeps a detached shell's pid after the shell ends, and the host
 * may give that pid to another process later. A process that started after
 * the task is that other process, and must never be killed. When either
 * start time is unknown, a live pid counts.
 */
export function taskProcessAlive(pid: unknown, startedAt?: unknown, options: ProcessQueryOptions = {}): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const taskStart = typeof startedAt === "string" ? Date.parse(startedAt)
        : typeof startedAt === "number" ? startedAt : Number.NaN;
    if (!Number.isFinite(taskStart)) return true;
    const processStart = processStartTimeMs(pid, options);
    if (processStart === undefined) return true;
    return processStart <= taskStart + START_TIME_SLACK_MS;
}

/** Parent pid to child pids, for every process this host lists. */
function childrenByParent(rootPid: number, timeoutMs: number): Map<number, number[]> | undefined {
    const children = new Map<number, number[]>();
    const add = (pid: number, ppid: number) => {
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return;
        const list = children.get(ppid);
        if (list) list.push(pid);
        else children.set(ppid, [pid]);
    };
    if (process.platform === "win32") {
        try {
            const out = execFileSync(WINDOWS_POWERSHELL, [
                "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "foreach ($p in ([wmisearcher]'SELECT ProcessId, ParentProcessId FROM Win32_Process').Get()) { [string]$p.ProcessId + ' ' + [string]$p.ParentProcessId }",
            ], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
            let includesSelf = false;
            let includesRoot = false;
            for (const line of out.split("\n")) {
                if (!line.trim()) continue;
                const row = /^(\d+) (\d+)$/.exec(line.trim());
                if (!row) return undefined;
                const childPid = Number(row[1]);
                includesSelf ||= childPid === process.pid;
                includesRoot ||= childPid === rootPid;
                add(childPid, Number(row[2]));
            }
            // An incomplete snapshot could hide an ancestor or a root that has exited.
            return includesSelf && includesRoot ? children : undefined;
        } catch {
            return undefined;
        }
    }
    if (fs.existsSync("/proc/self/stat")) {
        for (const entry of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                // "pid (comm) state ppid ..."; comm may hold spaces and parens.
                const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                add(Number(entry), Number(fields[1]));
            } catch { /* the process ended while we read */ }
        }
        return children;
    }
    try {
        const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: timeoutMs });
        for (const line of out.split("\n")) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            add(pid, ppid);
        }
    } catch { /* no ps: only the pid itself is killed */ }
    return children;
}

/**
 * Stop a process and every process below it. Returns true if any process
 * was killed. Never kills this process or pid 1. On POSIX the root dies
 * first, so a loop cannot start new children; the listed children are then
 * killed by pid even after they are re-parented.
 */
export function killProcessTree(pid: unknown, { timeoutMs = COMMAND_TIMEOUT_MS }: ProcessQueryOptions = {}): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const children = childrenByParent(pid, timeoutMs);
    if (!children) return false;
    const tree: number[] = [];
    const seen = new Set<number>();
    let containsSelf = false;
    const walk = (current: number) => {
        if (current === process.pid) {
            containsSelf = true;
            return;
        }
        if (seen.has(current) || current <= 1) return;
        seen.add(current);
        tree.push(current);
        for (const child of children.get(current) ?? []) walk(child);
    };
    walk(pid);
    if (process.platform === "win32") {
        if (containsSelf) return false;
        try {
            execFileSync("C:\\Windows\\System32\\taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
                timeout: timeoutMs, windowsHide: true, stdio: "ignore",
            });
            return true;
        } catch { /* the root may have exited; still stop its snapshotted children */ }
    }
    let killed = false;
    for (const target of tree) {
        try {
            process.kill(target, "SIGKILL");
            killed = true;
        } catch { /* already gone */ }
    }
    return killed;
}
