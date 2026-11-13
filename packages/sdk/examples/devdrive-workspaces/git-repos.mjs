/**
 * Git on the Dev Drive (README, "Git on the drive"): what the extension does
 * to the drive's repositories, and nothing else runs git for it.
 *
 *   writeCleanRecord   right before a clean offline: the object IDs of HEAD and
 *                      of every ref of each repository and submodule, in
 *                      pilotswarm-clean-tips in its Git directory
 *   recoverAfterCrash  after a crash: remove stale lock files, check the objects
 *                      written since that record (all objects, without one),
 *                      then git status. Only a damaged repository is restored
 *                      from its WIP branch; an ownership error fails the attach
 *   pushWip            the drive's work, committed or not, to the WIP branch on
 *                      each repository's origin, within one deadline
 *   applySync          back from local work: save what the recorded commit
 *                      lacks to the WIP branch, then reset the working folder's
 *                      repository to that commit
 *
 * Every git call runs with hooks from an empty folder (core.hooksPath), no
 * fsmonitor, no terminal prompt and no askpass program, so nothing on the
 * drive starts a program and no prompt can hold a call. Each call has a
 * deadline, after which its whole process tree is killed: Node's own kill
 * ends only git itself, not the remote helper or credential helper it runs.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLEAN_TIPS_FILE = "pilotswarm-clean-tips";
export const SYNCED_FILE = "pilotswarm-synced";
export const BROKEN_REFS_FILE = "pilotswarm-broken-refs";
/** Where the last WIP commit is kept, so an unchanged drive pushes the same commit again. */
export const WIP_LOCAL_REF = "refs/pilotswarm/wip";
const WIP_INDEX_FILE = "pilotswarm-wip-index";
const RESTORE_REF = "refs/pilotswarm/wip-restore";
const SYNC_SOURCE_REF = "refs/pilotswarm/sync-source";
/** The remote name a branch sync fetches through; its URL is set in the environment, never on the command line. */
const SYNC_REMOTE = "pilotswarm-sync";
const EMPTY_TREES = new Set([
    "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
]);
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const OWNERSHIP = /detected dubious ownership/i;
const NO_IDENTITY = /Please tell me who you are|Author identity unknown|unable to auto-detect email/i;
const MAX_OUTPUT_CHARS = 32 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;

/**
 * Kill a process and everything it started. Resolves once the kill has run
 * (on Windows, once taskkill exited).
 */
export function killProcessTree(pid) {
    if (!pid) return Promise.resolve();
    if (process.platform === "win32") {
        const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        return new Promise((resolve) => {
            try {
                const killer = spawn(taskkill, ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
                killer.on("error", () => resolve());
                killer.on("close", () => resolve());
            } catch {
                resolve();
            }
        });
    }
    // The child leads its own process group (spawned detached), so this reaches its helpers.
    try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* the process is gone */ }
    }
    return Promise.resolve();
}

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]  the worker's environment (Git's own settings, credential helpers)
 * @param {string} [options.hooksPath]  PS_EMPTY_HOOKS_DIR; by default the null device, where no hook can exist
 * @param {string} [options.gitPath]
 * @returns {(args: string[], opts?: { cwd?: string, timeoutMs?: number, input?: string, env?: object }) =>
 *   Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function createGitRunner({ env = process.env, hooksPath = os.devNull, gitPath = "git" } = {}) {
    const base = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "false", GIT_ASKPASS: "", SSH_ASKPASS: "" };
    return function runGit(args, { cwd, timeoutMs = 60_000, input, env: extra } = {}) {
        if (!(timeoutMs > 0)) return Promise.resolve({ code: -1, stdout: "", stderr: "no time left", timedOut: true });
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(gitPath, ["-c", `core.hooksPath=${hooksPath}`, "-c", "core.fsmonitor=false", ...args], {
                    cwd,
                    env: { ...base, ...extra },
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    detached: process.platform !== "win32",
                });
            } catch (error) {
                resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error), timedOut: false });
                return;
            }
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            let settled = false;
            let killing = null;
            let grace;
            const timer = setTimeout(() => {
                timedOut = true;
                killing = killProcessTree(child.pid);
                // A tree that does not die must not hold the caller.
                grace = setTimeout(() => finish(-1), KILL_GRACE_MS);
            }, timeoutMs);
            function finish(code) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(grace);
                const result = { code, stdout, stderr, timedOut };
                if (!killing) {
                    resolve(result);
                    return;
                }
                // A killed call returns only once its whole tree was killed, or the grace time is up.
                let wait;
                const graceUp = new Promise((done) => { wait = setTimeout(done, KILL_GRACE_MS); });
                Promise.race([killing, graceUp]).then(() => {
                    clearTimeout(wait);
                    // A process that outlived the kill must not keep this process's pipe handles open.
                    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
                    resolve(result);
                });
            }
            child.stdout.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk; });
            child.stderr.on("data", (chunk) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk; });
            child.on("error", (error) => { if (!stderr) stderr = String(error?.message ?? error); finish(-1); });
            child.on("close", (code) => finish(code ?? -1));
            child.stdin.on("error", () => {});
            child.stdin.end(input ?? undefined);
        });
    };
}

/** A URL's user name and password, if it has any, replaced: messages and logs never carry a credential. */
export function redactUrls(text) {
    return String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
}

/** The last lines of a failed git call, without credentials. */
function summarize(result) {
    if (result.timedOut) return "it ran out of time and was stopped";
    const text = redactUrls(String(result.stderr || result.stdout || "").trim());
    const lines = text.split(/\r?\n/).filter(Boolean);
    return (lines.slice(-3).join(" ") || `git exited with ${result.code}`).slice(0, 600);
}

function classify(result) {
    if (result.code === 0) return "ok";
    if (OWNERSHIP.test(result.stderr ?? "")) return "ownership";
    if (result.timedOut) return "timeout";
    if (result.code === -1) return "error";
    return "corrupt";
}

const remainingMs = (deadline, now, cap = Infinity) => Math.max(0, Math.min(cap, deadline - now()));

async function pathExists(target) {
    try { await fs.promises.access(target); return true; } catch { return false; }
}

async function writeFileAtomic(file, text) {
    const temp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(temp, text);
    await fs.promises.rename(temp, file);
}

function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A working tree's Git directory: its .git folder, or the folder its .git file names (submodules). */
export async function gitDirOf(worktree) {
    const dotGit = path.join(worktree, ".git");
    let stat;
    try { stat = await fs.promises.lstat(dotGit); } catch { return null; }
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const text = await fs.promises.readFile(dotGit, "utf8").catch(() => "");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    return match ? path.resolve(worktree, match[1]) : null;
}

async function submodulePaths(runGit, worktree, timeoutMs) {
    if (!(await pathExists(path.join(worktree, ".gitmodules")))) return [];
    const result = await runGit(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { cwd: worktree, timeoutMs });
    if (result.code !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => line.slice(line.indexOf(" ") + 1).trim()).filter(Boolean);
}

/**
 * The repositories on the drive: each root that is a working tree, else each
 * folder right under a root that is one (links are not followed), then their
 * checked-out submodules, recursively. A superproject comes before its
 * submodules. A repository nested deeper is not found, which keeps the scan
 * cheap on large checkouts (README, "Which repositories").
 */
export async function listRepositories(roots, runGit, { deadline = Infinity, now = Date.now, maxDepth = 8 } = {}) {
    const tops = [];
    for (const root of roots) {
        if (await gitDirOf(root.path)) {
            tops.push(root.path);
            continue;
        }
        let entries = [];
        try { entries = await fs.promises.readdir(root.path, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(root.path, entry.name);
            if (await gitDirOf(candidate)) tops.push(candidate);
        }
    }
    const repos = [];
    const visit = async (worktree, parent, depth) => {
        const gitDir = await gitDirOf(worktree);
        if (!gitDir) return;
        repos.push({ path: worktree, gitDir, parent });
        if (depth >= maxDepth) return;
        for (const sub of await submodulePaths(runGit, worktree, remainingMs(deadline, now, 30_000))) {
            const child = path.resolve(worktree, sub);
            if (child !== worktree && isInside(child, worktree)) await visit(child, worktree, depth + 1);
        }
    };
    for (const top of tops) await visit(top, null, 0);
    return repos;
}

/** HEAD and every ref of a repository, as object IDs. */
async function currentTips(repo, runGit, timeoutMs) {
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.path, timeoutMs });
    if (head.code !== 0 && classify(head) !== "corrupt") return { result: head };
    const refs = await runGit(["for-each-ref", "--format=%(objectname)"], { cwd: repo.path, timeoutMs });
    if (refs.code !== 0) return { result: refs };
    const oids = new Set();
    if (head.code === 0 && OID.test(head.stdout.trim())) oids.add(head.stdout.trim());
    for (const line of refs.stdout.split(/\r?\n/)) if (OID.test(line.trim())) oids.add(line.trim());
    return { oids: [...oids] };
}

async function readRecord(file) {
    const text = await fs.promises.readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => OID.test(line)))];
}

/** Which of `oids` the repository still has (git cat-file --batch-check). */
async function existingObjects(repo, runGit, oids, timeoutMs) {
    if (oids.length === 0) return { oids: [] };
    const result = await runGit(["cat-file", "--batch-check"], { cwd: repo.path, input: `${oids.join("\n")}\n`, timeoutMs });
    if (result.code !== 0) return { result };
    const present = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        const [oid, kind] = line.trim().split(/\s+/);
        if (oid && OID.test(oid) && kind && kind !== "missing") present.push(oid);
    }
    return { oids: present };
}

/** Write the clean-detach record of every repository and submodule. */
export async function writeCleanRecord(repos, runGit, { deadline = Infinity, now = Date.now } = {}) {
    const failures = [];
    for (const repo of repos) {
        const tips = await currentTips(repo, runGit, remainingMs(deadline, now, 60_000));
        if (!tips.oids) {
            failures.push(`${repo.path}: ${summarize(tips.result)}`);
            continue;
        }
        try {
            await writeFileAtomic(path.join(repo.gitDir, CLEAN_TIPS_FILE), tips.oids.length ? `${tips.oids.join("\n")}\n` : "");
        } catch (error) {
            failures.push(`${repo.path}: ${error?.message ?? error}`);
        }
    }
    return { ok: failures.length === 0, failures };
}

// Runs in a child process: a walk of a large .git (logs, refs) stays off the
// worker's event loop. No entry cap, so the walk always reaches refs/ and
// packed-refs.lock. Never under objects/, and never through a link.
const LOCK_WALK = `
const fs = require("fs"), path = require("path");
const removed = [];
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "objects") walk(full); }
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".lock")) {
      try { fs.unlinkSync(full); removed.push(full); } catch {}
    }
  }
};
for (const dir of process.argv.slice(1)) walk(dir);
process.stdout.write(JSON.stringify(removed));
`;

/** Remove stale *.lock files under each Git directory, except under objects/, in a child process. */
export function removeStaleLocks(gitDirs, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve) => {
        if (gitDirs.length === 0) return resolve({ ok: true, removed: [] });
        execFile(process.execPath, ["-e", LOCK_WALK, ...gitDirs], {
            timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        }, (error, stdout) => {
            if (error) return resolve({ ok: false, message: error.killed ? `the walk took longer than ${timeoutMs} ms` : String(error.message) });
            try { resolve({ ok: true, removed: JSON.parse(String(stdout || "[]")) }); } catch {
                resolve({ ok: false, message: "the walk gave no answer" });
            }
        });
    });
}

/** The Git directories to walk for locks: a submodule's own one only when it is not inside its superproject's. */
function lockWalkDirs(repos) {
    const dirs = [];
    for (const repo of repos) {
        if (!dirs.some((dir) => isInside(repo.gitDir, dir))) dirs.push(repo.gitDir);
    }
    return dirs;
}

/**
 * Git's own post-fetch connectivity check (connected.c), limited to what was
 * written since the record: HEAD, every ref and the index, back to the
 * recorded objects that still exist. Without a record, git fsck.
 */
async function checkRepository(repo, runGit, { deadline, now }) {
    const recorded = await readRecord(path.join(repo.gitDir, CLEAN_TIPS_FILE));
    let result;
    let existing = [];
    if (recorded) {
        const present = await existingObjects(repo, runGit, recorded, remainingMs(deadline, now));
        if (!present.oids) return { status: classify(present.result), scoped: true, recorded, existing, message: summarize(present.result) };
        existing = present.oids;
        const tips = await currentTips(repo, runGit, remainingMs(deadline, now));
        if (!tips.oids) return { status: classify(tips.result), scoped: true, recorded, existing, message: summarize(tips.result) };
        result = await runGit(["rev-list", "--objects", "--indexed-objects", "--quiet", "--stdin"], {
            cwd: repo.path,
            input: `${[...tips.oids, "--not", ...existing].join("\n")}\n`,
            timeoutMs: remainingMs(deadline, now),
        });
    } else {
        result = await runGit(["fsck", "--connectivity-only", "--no-dangling"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
    }
    const verdict = classify(result);
    if (verdict !== "ok") return { status: verdict, scoped: Boolean(recorded), recorded, existing, message: summarize(result) };
    const status = await runGit(["status", "--porcelain"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
    const statusVerdict = classify(status);
    if (statusVerdict !== "ok") return { status: statusVerdict, scoped: Boolean(recorded), recorded, existing, message: summarize(status) };
    return { status: "ok", scoped: Boolean(recorded), recorded, existing };
}

/** Refs (and a detached HEAD) whose history reaches an object the repository lost. */
async function findBrokenRefs(repo, runGit, good, { deadline, now }) {
    const listed = await runGit(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
    if (listed.code !== 0) return { result: listed };
    const refs = listed.stdout.split(/\r?\n/).map((line) => line.trim().split(" ")).filter(([oid, ref]) => OID.test(oid ?? "") && ref)
        .map(([oid, ref]) => ({ oid, ref }));
    const symbolic = await runGit(["symbolic-ref", "-q", "HEAD"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
    if (symbolic.code !== 0) {
        const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
        if (head.code === 0 && OID.test(head.stdout.trim())) refs.push({ oid: head.stdout.trim(), ref: "HEAD" });
    }
    const known = new Set(good);
    const broken = [];
    for (const entry of refs) {
        if (known.has(entry.oid)) continue;
        const walk = await runGit(["rev-list", "--objects", "--quiet", "--stdin"], {
            cwd: repo.path, input: `${[entry.oid, "--not", ...known].join("\n")}\n`, timeoutMs: remainingMs(deadline, now),
        });
        if (walk.timedOut) return { result: walk };
        if (walk.code !== 0) broken.push(entry);
    }
    return { broken };
}

/**
 * A damaged repository: fetch its WIP branch from origin and put it back, the
 * branch at the backup's parent and the backup's uncommitted changes staged.
 * Refs that reach a lost object would stop the fetch, so they are listed in
 * pilotswarm-broken-refs and removed first.
 */
async function restoreFromWip(repo, runGit, { wipBranch, good, deadline, now, fetchTimeoutMs }) {
    const run = (args, opts = {}) => runGit(args, { cwd: repo.path, timeoutMs: remainingMs(deadline, now, opts.capMs), ...opts });
    const origin = await run(["remote", "get-url", "origin"]);
    if (origin.code !== 0) return { ok: false, message: "it has no origin to restore its WIP branch from" };
    const listed = await run(["ls-remote", "--heads", "origin", `refs/heads/${wipBranch}`], { capMs: fetchTimeoutMs });
    if (listed.code !== 0) return { ok: false, message: `its WIP branch ${wipBranch} could not be listed: ${summarize(listed)}` };
    if (!listed.stdout.trim()) return { ok: false, message: `it has no WIP branch ${wipBranch} on origin` };
    const found = await findBrokenRefs(repo, runGit, good, { deadline, now });
    if (!found.broken) return { ok: false, message: `its refs could not be checked: ${summarize(found.result)}` };
    if (found.broken.length > 0) {
        await fs.promises.appendFile(path.join(repo.gitDir, BROKEN_REFS_FILE),
            found.broken.map((entry) => `${entry.oid} ${entry.ref} ${new Date(now()).toISOString()}\n`).join(""));
        for (const entry of found.broken) {
            const removed = entry.ref === "HEAD"
                ? await run(["symbolic-ref", "HEAD", "refs/heads/pilotswarm-recovered"])
                : await run(["update-ref", "-d", "--no-deref", entry.ref]);
            if (removed.code !== 0) return { ok: false, message: `${entry.ref} could not be removed: ${summarize(removed)}` };
        }
    }
    // The index may name blobs the crash lost; reset --hard writes a new one.
    await fs.promises.rm(path.join(repo.gitDir, "index"), { force: true });
    const fetched = await run(["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${wipBranch}:${RESTORE_REF}`], { capMs: fetchTimeoutMs });
    if (fetched.code !== 0) return { ok: false, message: `fetching its WIP branch ${wipBranch} failed: ${summarize(fetched)}` };
    const reset = await run(["reset", "-q", "--hard", RESTORE_REF]);
    if (reset.code !== 0) return { ok: false, message: `resetting to its WIP branch failed: ${summarize(reset)}` };
    const parent = await run(["rev-parse", "--verify", "--quiet", `${RESTORE_REF}^1`]);
    if (parent.code === 0 && OID.test(parent.stdout.trim())) {
        const soft = await run(["reset", "-q", "--soft", parent.stdout.trim()]);
        if (soft.code !== 0) return { ok: false, message: `moving the branch to the backup's parent failed: ${summarize(soft)}` };
    }
    const tips = await currentTips(repo, runGit, remainingMs(deadline, now));
    if (!tips.oids) return { ok: false, message: `checking the restored repository failed: ${summarize(tips.result)}` };
    const recheck = await run(["rev-list", "--objects", "--indexed-objects", "--quiet", "--stdin"], { input: `${[...tips.oids, "--not", ...good].join("\n")}\n` });
    if (recheck.code !== 0) return { ok: false, message: `the restored repository still misses objects: ${summarize(recheck)}` };
    const head = await run(["rev-parse", "--short=12", "HEAD"]);
    return { ok: true, broken: found.broken, head: head.code === 0 ? head.stdout.trim() : null };
}

function crashNotice({ removedLocks, restored, wipBranch }) {
    const lines = ["This workspace's drive was taken over after the worker that held it stopped without releasing it."];
    if (removedLocks.length > 0) {
        lines.push(`${removedLocks.length} stale Git lock file${removedLocks.length === 1 ? " was" : "s were"} removed (${removedLocks.slice(0, 3).map((file) => path.basename(file)).join(", ")}${removedLocks.length > 3 ? ", ..." : ""}).`);
    }
    for (const entry of restored) {
        lines.push(`Repository "${path.basename(entry.repo)}" had lost objects. It was restored from its WIP backup branch ${wipBranch}`
            + `${entry.head ? `: the branch is at ${entry.head}` : ""}, with the backup's uncommitted changes staged. Work done after that backup is lost.`
            + (entry.broken.length > 0 ? ` Refs that pointed at lost commits were removed: ${entry.broken.map((b) => b.ref).join(", ")}.` : ""));
    }
    if (restored.length === 0) lines.push("Every repository on the drive passed Git's connectivity check.");
    lines.push("An earlier attempt may have changed files. Check `git status` first.");
    return lines.join("\n");
}

/**
 * The crash recovery of an attach whose drive's last writer is gone. Resolves
 * with { ok: true, notice } or { ok: false, message, ownership?, corrupt?, retryAfterMs? }.
 */
export async function recoverAfterCrash({ repos, runGit, wipBranch, deadline = Infinity, now = Date.now, fetchTimeoutMs = 90_000 }) {
    const locks = await removeStaleLocks(lockWalkDirs(repos), { timeoutMs: remainingMs(deadline, now, 10 * 60_000) });
    if (!locks.ok) return { ok: false, message: `removing stale Git lock files failed: ${locks.message}`, retryAfterMs: 60_000 };
    const restored = [];
    const checked = [];
    for (const repo of repos) {
        const check = await checkRepository(repo, runGit, { deadline, now });
        const name = path.basename(repo.path);
        if (check.status === "ownership") {
            // The drive's own work is intact: a person fixes the owner, nothing is restored.
            return { ok: false, ownership: true, message: `repository "${name}" belongs to another account: ${check.message}` };
        }
        if (check.status === "timeout" || check.status === "error") {
            return { ok: false, message: `checking repository "${name}" failed: ${check.message}`, retryAfterMs: 60_000 };
        }
        if (check.status === "corrupt") {
            const good = check.existing ?? [];
            const result = await restoreFromWip(repo, runGit, { wipBranch, good, deadline, now, fetchTimeoutMs });
            if (!result.ok) return { ok: false, corrupt: true, message: `repository "${name}" is damaged (${check.message}), and ${result.message}` };
            restored.push({ repo: repo.path, ...result });
        }
        checked.push({ repo: repo.path, scoped: check.scoped, status: check.status });
    }
    return { ok: true, removedLocks: locks.removed, restored, checked, notice: crashNotice({ removedLocks: locks.removed, restored, wipBranch }) };
}

/**
 * A commit of the working tree as it is, committed or not (untracked files
 * too, ignored ones not), made with a copy of the index so that neither the
 * index nor the working tree changes. null when there is nothing at all.
 */
async function wipCommit(repo, runGit, { deadline, now, message }) {
    const run = (args, opts = {}) => runGit(args, { cwd: repo.path, timeoutMs: remainingMs(deadline, now), ...opts });
    const headResult = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    const head = headResult.code === 0 && OID.test(headResult.stdout.trim()) ? headResult.stdout.trim() : null;
    const indexFile = path.join(repo.gitDir, WIP_INDEX_FILE);
    const env = { GIT_INDEX_FILE: indexFile };
    let tree;
    try {
        await fs.promises.rm(indexFile, { force: true });
        if (await pathExists(path.join(repo.gitDir, "index"))) {
            // A copy keeps the stat data, so only changed files are hashed again.
            await fs.promises.copyFile(path.join(repo.gitDir, "index"), indexFile);
        } else if (head) {
            const read = await run(["read-tree", head], { env });
            if (read.code !== 0) return { ok: false, result: read };
        }
        const added = await run(["add", "-A"], { env });
        if (added.code !== 0) return { ok: false, result: added };
        const written = await run(["write-tree"], { env });
        if (written.code !== 0) return { ok: false, result: written };
        tree = written.stdout.trim();
    } finally {
        await fs.promises.rm(indexFile, { force: true }).catch(() => {});
    }
    if (!head && EMPTY_TREES.has(tree)) return { ok: true, oid: null };
    const previous = await run(["rev-parse", "--verify", "--quiet", WIP_LOCAL_REF]);
    if (previous.code === 0) {
        const prevTree = await run(["rev-parse", "--verify", "--quiet", `${WIP_LOCAL_REF}^{tree}`]);
        const prevParent = await run(["rev-parse", "--verify", "--quiet", `${WIP_LOCAL_REF}^1`]);
        if (prevTree.stdout.trim() === tree && (prevParent.code === 0 ? prevParent.stdout.trim() : null) === head) {
            return { ok: true, oid: previous.stdout.trim() };
        }
    }
    const commitArgs = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message];
    let committed = await run(commitArgs);
    if (committed.code !== 0 && NO_IDENTITY.test(committed.stderr)) {
        committed = await run(["-c", "user.name=PilotSwarm", "-c", "user.email=pilotswarm@localhost", ...commitArgs]);
    }
    if (committed.code !== 0) return { ok: false, result: committed };
    const oid = committed.stdout.trim();
    await run(["update-ref", WIP_LOCAL_REF, oid]);
    return { ok: true, oid };
}

/**
 * Push the drive's work, committed or not, to `wipBranch` on each
 * repository's origin, submodules before their superproject, all within one
 * deadline. A repository without origin is skipped. The push never prompts,
 * gives up on a stalled connection, and is killed with its helpers at the
 * deadline; the drive keeps every edit either way.
 */
export async function pushWip({ repos, runGit, wipBranch, deadline, now = Date.now, label = "the drive" }) {
    const pushed = [];
    const failed = [];
    const skipped = [];
    for (const repo of [...repos].reverse()) {
        if (remainingMs(deadline, now) <= 0) {
            failed.push({ repo: repo.path, message: "no time was left for it" });
            continue;
        }
        const origin = await runGit(["remote", "get-url", "origin"], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
        if (origin.code !== 0) {
            skipped.push(repo.path);
            continue;
        }
        const commit = await wipCommit(repo, runGit, { deadline, now, message: `PilotSwarm WIP backup of ${label}` });
        if (!commit.ok) {
            failed.push({ repo: repo.path, message: summarize(commit.result) });
            continue;
        }
        if (!commit.oid) {
            skipped.push(repo.path);
            continue;
        }
        const push = await runGit([
            "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30",
            "push", "--force", "--no-verify", "--recurse-submodules=no", "--quiet", "origin", `${commit.oid}:refs/heads/${wipBranch}`,
        ], { cwd: repo.path, timeoutMs: remainingMs(deadline, now) });
        if (push.code !== 0) failed.push({ repo: repo.path, message: summarize(push) });
        else pushed.push({ repo: repo.path, commit: commit.oid });
    }
    return { ok: failed.length === 0, pushed, failed, skipped };
}

/** The branch sync this drive already applied, from pilotswarm-synced, or null. */
export async function findAppliedSync(repos, syncId) {
    for (const repo of repos) {
        const text = await fs.promises.readFile(path.join(repo.gitDir, SYNCED_FILE), "utf8").catch(() => null);
        if (!text) continue;
        try {
            const record = JSON.parse(text);
            if (record?.syncId === syncId) return { syncId, headSha: record.headSha ?? null };
        } catch { /* not a record */ }
    }
    return null;
}

/** The environment that adds one Git setting, after any the worker already passes this way. */
function withGitSetting(env, key, value) {
    const count = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? "0"), 10);
    const index = Number.isFinite(count) && count >= 0 ? count : 0;
    return { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: key, [`GIT_CONFIG_VALUE_${index}`]: value };
}

const SYNC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A sync record from an attach answer, checked, or null. */
export function validSyncRecord(sync) {
    if (!sync || typeof sync !== "object") return null;
    const { syncId, sourceBranch, headSha, url } = sync;
    if (typeof syncId !== "string" || !SYNC_ID.test(syncId)) return null;
    if (typeof sourceBranch !== "string" || !/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,255}$/.test(sourceBranch)
        || sourceBranch.endsWith("/") || sourceBranch.endsWith(".lock")) return null;
    if (typeof headSha !== "string" || !OID.test(headSha)) return null;
    let parsed;
    try { parsed = new URL(String(url)); } catch { return null; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "file:") return null;
    return { syncId, sourceBranch, headSha, url: String(url) };
}

/**
 * Back from local work: the working folder's repository moves to the
 * recorded { sourceBranch, headSha }, fetched from the URL the controller
 * named (never logged: it may carry a credential). Anything on the drive that
 * headSha does not contain, committed or not, goes to the WIP branch first;
 * only after that push succeeds is anything reset. Then the record's ID is
 * written to pilotswarm-synced, so no attach, here or on another VM, applies
 * it twice.
 */
export async function applySync({ repos, runGit, sync, folderPath, wipBranch, deadline, now = Date.now, env = process.env, pushTimeoutMs = 90_000, fetchTimeoutMs = 5 * 60_000 }) {
    const record = validSyncRecord(sync);
    if (!record) return { ok: false, message: "the controller's branch sync record is not valid" };
    const applied = await findAppliedSync(repos, record.syncId);
    if (applied) return { ok: true, applied, already: true };
    const repo = repos.find((candidate) => !candidate.parent && isInside(folderPath, candidate.path));
    if (!repo) return { ok: false, message: "the session's working folder is in no repository on the drive, so the branch sync cannot apply" };
    const subs = repos.filter((candidate) => candidate !== repo && isInside(candidate.path, repo.path));
    const run = (args, opts = {}) => runGit(args, { cwd: repo.path, timeoutMs: remainingMs(deadline, now, opts.capMs), ...opts });
    const fetched = await run(["fetch", "--no-tags", "--no-write-fetch-head", SYNC_REMOTE, `+refs/heads/${record.sourceBranch}:${SYNC_SOURCE_REF}`], {
        capMs: fetchTimeoutMs,
        env: withGitSetting(env, `remote.${SYNC_REMOTE}.url`, record.url),
    });
    if (fetched.code !== 0) {
        // Git's message may quote the URL, which may carry a credential anywhere in it.
        const reason = fetched.timedOut ? "it ran out of time" : summarize(fetched).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<the sync source>");
        return { ok: false, message: `fetching ${record.sourceBranch} from the sync source failed: ${reason}`, retryAfterMs: 60_000 };
    }
    const has = await run(["cat-file", "-e", `${record.headSha}^{commit}`]);
    if (has.code !== 0) return { ok: false, message: `commit ${record.headSha} is not on ${record.sourceBranch}`, retryAfterMs: 60_000 };

    const status = await run(["status", "--porcelain", "--ignore-submodules=none"]);
    if (status.code !== 0) return { ok: false, message: `git status failed: ${summarize(status)}`, retryAfterMs: 60_000 };
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    const contained = head.code !== 0 || (await run(["merge-base", "--is-ancestor", "HEAD", record.headSha])).code === 0;
    if (status.stdout.trim() || !contained) {
        const pushDeadline = Math.min(deadline, now() + pushTimeoutMs);
        const push = await pushWip({ repos: [repo, ...subs], runGit, wipBranch, deadline: pushDeadline, now, label: `${path.basename(repo.path)} before a branch sync` });
        const unsaved = [...push.failed.map((entry) => `${path.basename(entry.repo)}: ${entry.message}`),
            ...push.skipped.filter((entry) => entry === repo.path).map((entry) => `${path.basename(entry)}: it has no origin`)];
        if (unsaved.length > 0) {
            return { ok: false, pushFailed: true, message: `saving the drive's work to ${wipBranch} failed, so nothing was reset (${unsaved.join("; ")})`, retryAfterMs: 60_000 };
        }
    }
    const checkout = await run(["checkout", "-q", "--force", "-B", record.sourceBranch, record.headSha]);
    if (checkout.code !== 0) return { ok: false, message: `checking out ${record.headSha} failed: ${summarize(checkout)}`, retryAfterMs: 60_000 };
    const clean = await run(["clean", "-q", "-f", "-d"]);
    if (clean.code !== 0) return { ok: false, message: `git clean failed: ${summarize(clean)}`, retryAfterMs: 60_000 };
    const submodules = await run(["submodule", "update", "--init", "--recursive", "--force"], { capMs: fetchTimeoutMs });
    if (submodules.code !== 0) return { ok: false, message: `updating the submodules failed: ${summarize(submodules)}`, retryAfterMs: 60_000 };
    await writeFileAtomic(path.join(repo.gitDir, SYNCED_FILE), `${JSON.stringify({ syncId: record.syncId, headSha: record.headSha, appliedAt: new Date(now()).toISOString() })}\n`);
    return {
        ok: true,
        applied: { syncId: record.syncId, headSha: record.headSha },
        notice: `Repository "${path.basename(repo.path)}" was moved to branch ${record.sourceBranch} at ${record.headSha.slice(0, 12)}, where the work continued outside this session.`
            + ` Anything on the drive that this commit did not contain was saved to branch ${wipBranch} first.`,
    };
}

/**
 * The extension's view of the drive's repositories: each call looks for the
 * repositories again, because sessions clone and remove them.
 *
 * @param {object} options
 * @param {Array<{ name: string, path: string }>} options.roots
 * @param {Function} options.runGit
 * @param {Record<string, string|undefined>} [options.env]   for the branch sync's fetch setting
 * @param {number} [options.wipPushTimeoutMs]  default 90 s
 * @param {() => number} [options.now]
 */
export function createRepoOps({ roots, runGit, env = process.env, wipPushTimeoutMs = 90_000, now = Date.now }) {
    const list = (deadline) => listRepositories(roots, runGit, { deadline, now });
    return {
        listRepositories: list,
        async writeCleanRecord({ timeoutMs = 60_000 } = {}) {
            const deadline = now() + timeoutMs;
            return writeCleanRecord(await list(deadline), runGit, { deadline, now });
        },
        async pushWip({ wipBranch, timeoutMs = wipPushTimeoutMs, label }) {
            const deadline = now() + timeoutMs;
            return pushWip({ repos: await list(deadline), runGit, wipBranch, deadline, now, ...(label ? { label } : {}) });
        },
        async recoverAfterCrash({ wipBranch, deadline }) {
            return recoverAfterCrash({ repos: await list(deadline), runGit, wipBranch, deadline, now });
        },
        async findAppliedSync(syncId) {
            return findAppliedSync(await list(now() + 60_000), syncId);
        },
        async applySync({ sync, folderPath, wipBranch, deadline }) {
            return applySync({ repos: await list(deadline), runGit, sync, folderPath, wipBranch, deadline, now, env, pushTimeoutMs: wipPushTimeoutMs });
        },
    };
}
