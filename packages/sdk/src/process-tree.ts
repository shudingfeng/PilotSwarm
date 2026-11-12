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
 * process tree below a pid: /proc on Linux, Win32_Process on Windows, `ps`
 * elsewhere.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
 * Windows PowerShell by its full path, never another program PATH finds, and
 * without a console window on a service host. It takes about 0.2 seconds to
 * start, and the caller waits for it.
 */
function runWindowsPowerShell(command: string): string {
    const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
}

/**
 * When a process started, in epoch milliseconds, or undefined when this host
 * cannot tell. Linux: field 22 of /proc/<pid>/stat (clock ticks after boot)
 * plus the boot time from /proc/stat. Windows: the creation time, from .NET,
 * or from Win32_Process (slower) for a process this user cannot open.
 * Elsewhere: `ps -o lstart=`, to the second.
 */
export function processStartTimeMs(pid: number): number | undefined {
    if (process.platform === "win32") {
        if (!Number.isInteger(pid) || pid <= 0) return undefined;
        try {
            const out = runWindowsPowerShell(
                `$t = $null; try { $t = [Diagnostics.Process]::GetProcessById(${pid}).StartTime } catch {}; `
                + `if (-not $t) { $t = (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate }; `
                + "if ($t) { ([DateTimeOffset]$t).ToUnixTimeMilliseconds() }",
            ).trim();
            const ms = Number(out);
            return out !== "" && Number.isFinite(ms) ? ms : undefined;
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
            encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" },
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
export function taskProcessAlive(pid: unknown, startedAt?: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const taskStart = typeof startedAt === "string" ? Date.parse(startedAt)
        : typeof startedAt === "number" ? startedAt : Number.NaN;
    if (!Number.isFinite(taskStart)) return true;
    const processStart = processStartTimeMs(pid);
    if (processStart === undefined) return true;
    return processStart <= taskStart + START_TIME_SLACK_MS;
}

/**
 * Parent pid to child pids, from Win32_Process lines "pid ppid startMs".
 * Windows keeps a process's parent pid after that parent ends, and may give
 * the pid to a new process. A child that started before its listed parent
 * belongs to an earlier holder of the pid, so it is not counted as a child;
 * neither is a process without a start time.
 */
export function windowsChildrenByParent(listing: string): Map<number, number[]> {
    const started = new Map<number, number>();
    const rows: Array<[number, number]> = [];
    for (const line of listing.split("\n")) {
        const [pid, ppid, startMs] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        rows.push([pid, ppid]);
        if (Number.isFinite(startMs)) started.set(pid, startMs);
    }
    const children = new Map<number, number[]>();
    for (const [pid, ppid] of rows) {
        const parentStart = started.get(ppid);
        const childStart = started.get(pid);
        if (parentStart === undefined || childStart === undefined || parentStart > childStart) continue;
        const list = children.get(ppid);
        if (list) list.push(pid);
        else children.set(ppid, [pid]);
    }
    return children;
}

/** Parent pid to child pids, for every process this host lists. */
function childrenByParent(): Map<number, number[]> {
    const children = new Map<number, number[]>();
    const add = (pid: number, ppid: number) => {
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return;
        const list = children.get(ppid);
        if (list) list.push(pid);
        else children.set(ppid, [pid]);
    };
    if (process.platform === "win32") {
        try {
            return windowsChildrenByParent(runWindowsPowerShell(
                "Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { "
                + "'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }) }",
            ));
        } catch {
            return children; // no listing: only the pid itself is killed
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
        const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
        for (const line of out.split("\n")) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            add(pid, ppid);
        }
    } catch { /* no ps: only the pid itself is killed */ }
    return children;
}

/**
 * SIGKILL a process and every process below it. Returns true if any process
 * was killed. Never kills this process or pid 1. The root dies first, so a
 * loop cannot start new children; the listed children are then killed by
 * pid even after they are re-parented. On Windows, Node ends each process
 * with TerminateProcess; `taskkill /T` is not used because it follows a
 * parent pid that a new process may since have taken.
 */
export function killProcessTree(pid: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const children = childrenByParent();
    const tree: number[] = [];
    const seen = new Set<number>();
    const walk = (current: number) => {
        if (seen.has(current) || current === process.pid || current <= 1) return;
        seen.add(current);
        tree.push(current);
        for (const child of children.get(current) ?? []) walk(child);
    };
    walk(pid);
    let killed = false;
    for (const target of tree) {
        try {
            process.kill(target, "SIGKILL");
            killed = true;
        } catch { /* already gone */ }
    }
    return killed;
}
