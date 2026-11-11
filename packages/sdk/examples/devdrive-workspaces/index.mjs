/**
 * Dev Drive workspaces: each root session's work on its own drive, mounted
 * as the workspace roots' volume (Q:) of the Windows worker that runs it
 * (README). Load it with the worker's extension-module hook:
 *
 *   PILOTSWARM_EXTENSION_MODULES=<path>\packages\sdk\examples\devdrive-workspaces\index.mjs
 *   PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1   required: only a root session holds a drive
 *   PS_DISK_POOL_CONTROLLER_URL=https://<controller>:3003
 *   PS_DISK_CONTROLLER_TOKEN_MODULE=<path>\controller-token.mjs   exports getToken()
 *   PS_DISK_CONTROLLER_CA_CERT=<path>\disk-controller-ca.crt     optional: the only CAs trusted
 *   PS_WORKSPACE_ROOTS=repos=Q:\Repos                            root name = path, on one volume
 *
 * The README lists every setting. register(worker) sets the workspace
 * provider, the admission hook, the credential resolver and (without
 * owner-only workers) the capacity requester, takes over the VM's heartbeat
 * and adds a shutdown hook. The extension holds no cloud code: it reaches
 * the disk controller and the local attacher over HTTP.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAttacherClient, DEFAULT_ATTACHER_TOKEN_FILE, DEFAULT_ATTACHER_URL } from "./attacher-client.mjs";
import { createDiskPoolClientFromEnv, useDiskPoolClient } from "./disk-pool-client.mjs";
import { createGitRunner, createRepoOps } from "./git-repos.mjs";
import { createHeartbeat, takeOverHeartbeat } from "./heartbeat.mjs";
import { createDevDriveProvider } from "./provider.mjs";
import {
    createAdmittedRoots, createBinding, createCapacityRequester, createCredentialResolver, createSessionAdmission,
} from "./worker-hooks.mjs";

export const DEFAULT_ROOTS = "repos=Q:\\Repos";
export const DEFAULT_ADOPT = "instructions,agents,skills";
export const DEFAULT_WIP_BRANCH_PREFIX = "pilotswarm/wip/";
/** The exit code that asks the service manager to start the worker again, bound. */
export const BIND_EXIT_CODE = 75;

const isAbsolutePath = (value) => path.isAbsolute(value) || path.win32.isAbsolute(value);

/** "repos=Q:\Repos,b=Q:\B" -> [{ name: "repos", path: "Q:\Repos" }, ...] */
export function parseRoots(value) {
    const roots = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const eq = entry.indexOf("=");
        if (eq <= 0) throw new Error(`PS_WORKSPACE_ROOTS entry "${entry}" must be name=path`);
        const root = { name: entry.slice(0, eq).trim(), path: entry.slice(eq + 1).trim() };
        if (!root.path || !isAbsolutePath(root.path)) throw new Error(`PS_WORKSPACE_ROOTS: root "${root.name}" needs an absolute path`);
        return root;
    });
    if (roots.length === 0) throw new Error("PS_WORKSPACE_ROOTS names no root");
    const names = new Set();
    for (const root of roots) {
        if (names.has(root.name)) throw new Error(`PS_WORKSPACE_ROOTS: root "${root.name}" is listed twice`);
        names.add(root.name);
    }
    // One drive: every root on its volume.
    const volumes = new Set(roots.map((root) => path.parse(root.path).root.toLowerCase()));
    if (volumes.size > 1) throw new Error("PS_WORKSPACE_ROOTS: every root must be on the Dev Drive's volume");
    return roots;
}

/** "instructions,agents,skills" -> what PilotSwarm may adopt from a working folder; "" or "none" -> nothing. */
export function parseAdopt(value) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text || text === "none") return null;
    const adopt = { agents: false, skills: false, instructions: false };
    for (const entry of text.split(",").map((part) => part.trim()).filter(Boolean)) {
        if (!(entry in adopt)) throw new Error(`PS_WORKSPACE_ADOPT: "${entry}" is not agents, skills or instructions`);
        adopt[entry] = true;
    }
    return adopt;
}

/** A WIP branch prefix that makes a valid branch name with any root session ID after it. */
export function parseWipPrefix(value) {
    const prefix = String(value ?? "").trim() || DEFAULT_WIP_BRANCH_PREFIX;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(prefix) || /\.\.|\/\/|\.\/|\/\.|\.lock\//.test(prefix)) {
        throw new Error(`PS_WIP_BRANCH_PREFIX "${prefix}" is not a valid branch name prefix`);
    }
    return prefix;
}

/** Every setting the extension reads, from the worker's environment. */
export function settingsFromEnv(env = process.env) {
    const roots = parseRoots(env.PS_WORKSPACE_ROOTS || DEFAULT_ROOTS);
    // The worker gives up on an attach after this; the provider starts nothing past it.
    const attachTimeout = Number(String(env.PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS ?? "").trim());
    return {
        roots,
        volumeRoot: path.parse(roots[0].path).root,
        attachBudgetMs: Number.isSafeInteger(attachTimeout) && attachTimeout > 0 ? attachTimeout : null,
        adopt: parseAdopt(env.PS_WORKSPACE_ADOPT ?? DEFAULT_ADOPT),
        wipPrefix: parseWipPrefix(env.PS_WIP_BRANCH_PREFIX),
        emptyHooksDir: String(env.PS_EMPTY_HOOKS_DIR ?? "").trim() || null,
        attacherUrl: String(env.PS_DISK_ATTACHER_URL ?? "").trim() || DEFAULT_ATTACHER_URL,
        attacherTokenFile: String(env.PS_DISK_ATTACHER_TOKEN_FILE ?? "").trim() || DEFAULT_ATTACHER_TOKEN_FILE,
        launchId: String(env.PS_LAUNCH_ID ?? "").trim() || randomUUID(),
        configVersion: String(env.WIN_WORKER_CONFIG_VERSION ?? "").trim() || null,
        ownerOnly: String(env.PILOTSWARM_WORKER_OWNER_ONLY ?? "").trim() === "1",
        ownerTag: String(env.PILOTSWARM_WORKER_OWNER_TAG ?? "").trim() || null,
    };
}

/** Size and free space of the drive's volume, for the heartbeat. */
export function volumeInfoOf(volumeRoot) {
    return async () => {
        const stats = await fs.promises.statfs(volumeRoot);
        return { sizeBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
    };
}

/**
 * The extension, put together from its parts. register() builds the real
 * parts from the settings; tests pass fakes.
 */
export function createDevDriveWorkspaces({
    worker, settings, controller, attacher, repos, volumeInfo, timers, log = () => {}, heartbeatIntervalMs, providerOptions = {},
}) {
    const admitted = createAdmittedRoots();
    const wipBranchFor = (rootSessionId) => `${settings.wipPrefix}${rootSessionId}`;
    const drive = createDevDriveProvider({
        roots: settings.roots,
        adopt: settings.adopt,
        controller,
        attacher,
        repos,
        worker,
        wipBranchFor,
        isAdmittedRoot: (rootSessionId) => admitted.has(rootSessionId),
        ...(timers ? { timers } : {}),
        log,
        options: { ...(settings.attachBudgetMs ? { attachBudgetMs: settings.attachBudgetMs } : {}), ...providerOptions },
    });
    let heartbeat;
    const binding = createBinding({
        worker,
        ownerTag: settings.ownerTag,
        ownerOnly: settings.ownerOnly,
        onRestart: () => heartbeat.setDraining(true),
        log,
    });
    heartbeat = createHeartbeat({
        controller,
        drive,
        worker,
        launchId: settings.launchId,
        configVersion: settings.configVersion,
        volumeInfo,
        onAnswer: (answer, sentEpoch) => {
            binding.observe(answer?.ownerOid);
            drive.onHeartbeatAnswer(answer, sentEpoch);
        },
        ...(timers ? { timers } : {}),
        ...(heartbeatIntervalMs ? { intervalMs: heartbeatIntervalMs } : {}),
        log,
    });

    return {
        drive,
        heartbeat,
        binding,
        admitted,
        wipBranchFor,
        async start() {
            worker.setWorkspaceProvider(drive.provider);
            worker.setSessionAdmission(createSessionAdmission({ controller, admitted }));
            worker.setPersonalCredentialResolver(createCredentialResolver({ controller }));
            // With owner-only workers, the coordination host sends every capacity request.
            if (!settings.ownerOnly) worker.setOwnerCapacityRequester(createCapacityRequester({ controller, ...(timers ? { timers } : {}) }));
            worker.onShutdown(async () => {
                heartbeat.setDraining(true);
                // A release still running (its offline and detach) finishes first; the heartbeat runs until then.
                await drive.shutdown();
                await heartbeat.stop();
            });
            // Ours first, then the launcher's stops: the controller sees no gap. A
            // drive this answer names, which no session here can hold yet, is freed.
            await heartbeat.start();
            await takeOverHeartbeat(log);
        },
    };
}

/** The worker hooks this extension needs (PilotSwarm's worker lifecycle, admission, credential and owner routing hooks). */
const REQUIRED_WORKER_METHODS = [
    "setWorkspaceProvider", "setSessionAdmission", "setPersonalCredentialResolver", "setOwnerCapacityRequester",
    "tryReleaseIdleWorkspace", "getActiveWorkloadCount", "onShutdown", "requestExit",
];

/**
 * Extension entry point (PILOTSWARM_EXTENSION_MODULES). `deps` replaces the
 * real parts in tests: { platform, controllerOptions, attacherOptions,
 * runGit, repos, volumeInfo, timers, heartbeatIntervalMs, providerOptions }.
 */
export async function register(worker, context = {}, deps = {}) {
    const env = context.env ?? process.env;
    const log = context.log ?? ((message) => console.log(message));
    const platform = deps.platform ?? process.platform;
    if (platform !== "win32") throw new Error("devdrive-workspaces runs on Windows workers only: it mounts a Dev Drive");
    if (String(env.PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE ?? "").trim() !== "1") {
        throw new Error("devdrive-workspaces needs PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1: a drive belongs to one root session, "
            + "and a sub-agent that inherited it on another worker would wait for its parent's drive");
    }
    const missing = REQUIRED_WORKER_METHODS.filter((name) => typeof worker?.[name] !== "function");
    if (missing.length > 0) throw new Error(`devdrive-workspaces needs a PilotSwarm worker with ${missing.join(", ")}`);
    const settings = settingsFromEnv(env);
    const controller = await createDiskPoolClientFromEnv(env, deps.controllerOptions ?? {});
    useDiskPoolClient(controller);
    const attacher = createAttacherClient({ url: settings.attacherUrl, tokenFile: settings.attacherTokenFile, ...(deps.attacherOptions ?? {}) });
    const runGit = deps.runGit ?? createGitRunner({ env, ...(settings.emptyHooksDir ? { hooksPath: settings.emptyHooksDir } : { hooksPath: os.devNull }) });
    const repos = deps.repos ?? createRepoOps({ roots: settings.roots, runGit, env });
    const extension = createDevDriveWorkspaces({
        worker,
        settings,
        controller,
        attacher,
        repos,
        volumeInfo: deps.volumeInfo ?? volumeInfoOf(settings.volumeRoot),
        ...(deps.timers ? { timers: deps.timers } : {}),
        ...(deps.heartbeatIntervalMs ? { heartbeatIntervalMs: deps.heartbeatIntervalMs } : {}),
        ...(deps.providerOptions ? { providerOptions: deps.providerOptions } : {}),
        log,
    });
    await extension.start();
    log(`devdrive workspaces: roots ${settings.roots.map((root) => `${root.name}=${root.path}`).join(", ")}; launch ${settings.launchId}`
        + `${settings.ownerTag ? `; owner tag ${settings.ownerTag}` : "; unbound"}${settings.ownerOnly ? "; owner-only" : ""}`);
    return extension;
}
