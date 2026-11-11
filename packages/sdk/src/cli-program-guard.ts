/**
 * The fail-closed start for external personal secrets.
 *
 * With PILOTSWARM_PERSONAL_SECRETS=external a worker hands people's own
 * GitHub tokens to the Copilot CLI. It then refuses to start unless every
 * CLI is the Copilot CLI program that keeps the token from agents' shells
 * and MCP servers (`--secret-env-vars=COPILOT_SDK_AUTH_TOKEN`), and unless
 * that program can run only its own code.
 *
 * The program's loader unpacks its code once into a package cache,
 * `<COPILOT_PKG_CACHE_HOME>/pkg/<platform>-<arch>/<version>/`, and on later
 * launches runs whatever is there, checking only that the
 * `.extraction-complete` marker, `index.js`, `app.js` and
 * `prebuilds/<platform>-<arch>/runtime.node` exist. A cache the worker can
 * write is a cache an agent can plant code in, so the copy must be complete
 * and the worker must not be able to change it.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cliSecretEnvVars, copilotCliProgramPath, scrubbedCliEnvironment } from "./copilot-client.js";

const SDK_TOKEN_VARIABLE = "COPILOT_SDK_AUTH_TOKEN";
const MODE = "PILOTSWARM_PERSONAL_SECRETS=external";

/** The Copilot CLI version the installed Copilot SDK pins. */
export function pinnedCopilotCliVersion(): string {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@github/copilot-sdk"));
    for (let depth = 0; depth < 5; depth += 1, dir = path.dirname(dir)) {
        const manifest = readJson(path.join(dir, "package.json"));
        if (manifest?.name !== "@github/copilot-sdk") continue;
        if (typeof manifest.copilotCliVersion === "string" && manifest.copilotCliVersion) return manifest.copilotCliVersion;
        const pinned = /COPILOT_CLI_VERSION\s*=\s*"([^"]+)"/.exec(readText(path.join(dir, "dist", "cliVersion.js")) ?? "");
        if (pinned) return pinned[1];
        break;
    }
    throw new Error("Cannot tell which Copilot CLI version @github/copilot-sdk pins.");
}

function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
}

function readJson(file: string): Record<string, unknown> | null {
    const text = readText(file);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

const uncheckable = (target: string, err: any) => `${target} could not be checked (${err?.code ?? err?.message ?? err})`;

function fileWritable(target: string): string | null {
    let fd: number;
    try {
        fd = fs.openSync(target, "r+");
    } catch (err: any) {
        if (NOT_WRITABLE.has(err?.code)) return null;
        // In use by another process, which means its permissions allow writing.
        if (err?.code === "EBUSY" || err?.code === "ETXTBSY") return `${target} can be written`;
        return uncheckable(target, err);
    }
    fs.closeSync(fd);
    return `${target} can be written`;
}

function folderWritable(target: string): string | null {
    const probe = path.join(target, `.pilotswarm-write-probe-${process.pid}-${randomBytes(6).toString("hex")}`);
    let fd: number;
    try {
        fd = fs.openSync(probe, "wx");
    } catch (err: any) {
        if (NOT_WRITABLE.has(err?.code)) return null;
        return uncheckable(target, err);
    }
    fs.closeSync(fd);
    try {
        fs.unlinkSync(probe);
    } catch {
        return `${target} can be written, and the probe file ${probe} could not be removed`;
    }
    return `${target} can be written`;
}

// Setting the permissions to what they already are changes nothing, and
// succeeds only for an account that could also make the target writable:
// its owner on Linux and macOS, one allowed to change its attributes on
// Windows.
function permissionsChangeable(target: string): string | null {
    let mode: number;
    try {
        mode = fs.statSync(target).mode & 0o7777;
    } catch (err: any) {
        return uncheckable(target, err);
    }
    try {
        fs.chmodSync(target, mode);
    } catch (err: any) {
        if (NOT_WRITABLE.has(err?.code)) return null;
        return uncheckable(target, err);
    }
    return `the permissions of ${target} can be changed`;
}

/**
 * Why this process can write `target`, or null when it cannot. A folder is
 * tested by creating and deleting a probe file in it, a file by opening it
 * for writing without writing anything, and both by setting their
 * permissions to what they already are.
 */
export function writableProblem(target: string, kind: "directory" | "file"): string | null {
    return (kind === "file" ? fileWritable(target) : folderWritable(target)) ?? permissionsChangeable(target);
}

export interface CliProgramGuardOptions {
    /** Replaces the writability test, for tests on a platform that cannot make a folder read-only. */
    writableProblem?: (target: string, kind: "directory" | "file") => string | null;
}

/**
 * Throw, saying what is wrong, unless this worker can start the Copilot CLI
 * program safely with external personal secrets:
 * - PILOTSWARM_CLI_SECRET_ENV_VARS names COPILOT_SDK_AUTH_TOKEN;
 * - the program (COPILOT_CLI_PATH, or the platform package of
 *   `@github/copilot`) exists and is the version the Copilot SDK pins;
 * - the CLI does not get COPILOT_CLI_DIST_DIR;
 * - COPILOT_PKG_CACHE_HOME is an absolute path that holds that version's
 *   complete unpacked copy;
 * - this process can neither write nor change the permissions of anything
 *   from COPILOT_PKG_CACHE_HOME down to the copy, or inside it, and the copy
 *   holds no links.
 */
export function assertCliProgramForExternalSecrets(
    settings: NodeJS.ProcessEnv = process.env,
    options: CliProgramGuardOptions = {},
): void {
    if (!cliSecretEnvVars(settings)?.includes(SDK_TOKEN_VARIABLE)) {
        throw new Error(`${MODE} needs PILOTSWARM_CLI_SECRET_ENV_VARS to name ${SDK_TOKEN_VARIABLE}, so agents' shells and MCP servers never get the token.`);
    }

    const program = settings.COPILOT_CLI_PATH?.trim() || copilotCliProgramPath();
    if (!isFile(program)) {
        throw new Error(`${MODE} needs the Copilot CLI program, and there is none at ${program}.`);
    }
    const manifest = readJson(path.join(path.dirname(program), "package.json"));
    const platform = typeof manifest?.name === "string" ? /^@github\/copilot-([a-z0-9]+-[a-z0-9]+)$/.exec(manifest.name)?.[1] : undefined;
    if (!manifest || !platform || typeof manifest.version !== "string") {
        throw new Error(`${MODE}: cannot tell which Copilot CLI program ${program} is; its package.json is missing or is not a @github/copilot platform package.`);
    }
    const pinned = pinnedCopilotCliVersion();
    if (manifest.version !== pinned) {
        throw new Error(`${MODE}: the Copilot CLI program at ${program} is version ${manifest.version}, and the Copilot SDK pins ${pinned}.`);
    }

    // The program runs the index.js in COPILOT_CLI_DIST_DIR instead of its own copy.
    const cliEnv = scrubbedCliEnvironment(settings, settings) ?? settings;
    const distDir = Object.entries(cliEnv).find(([name, value]) => name.toUpperCase() === "COPILOT_CLI_DIST_DIR" && value);
    if (distDir) {
        throw new Error(`${MODE}: COPILOT_CLI_DIST_DIR would make the Copilot CLI program run the code in ${distDir[1]}. Unset it, or keep it from the CLI with PILOTSWARM_SCRUB_CLI_ENV=1.`);
    }

    const home = settings.COPILOT_PKG_CACHE_HOME?.trim();
    if (!home) {
        throw new Error(`${MODE} needs COPILOT_PKG_CACHE_HOME to name the Copilot CLI program's unpacked copy, in a folder this worker cannot write.`);
    }
    if (!path.isAbsolute(home)) {
        throw new Error(`${MODE}: COPILOT_PKG_CACHE_HOME must be an absolute path, not "${home}".`);
    }
    const copy = path.join(home, "pkg", platform, pinned);
    for (const file of [".extraction-complete", "index.js", "app.js", path.join("prebuilds", platform, "runtime.node")]) {
        if (!isFile(path.join(copy, file))) {
            throw new Error(`${MODE}: COPILOT_PKG_CACHE_HOME has no complete copy of Copilot CLI ${pinned}; ${path.join(copy, file)} is missing.`);
        }
    }

    const check = options.writableProblem ?? writableProblem;
    const refuse = (problem: string): never => {
        throw new Error(`${MODE}: this worker can change the Copilot CLI program's copy in COPILOT_PKG_CACHE_HOME: ${problem}. `
            + "Let another account own the copy, and give the worker's account read access only.");
    };
    for (const dir of [home, path.join(home, "pkg"), path.join(home, "pkg", platform)]) {
        const problem = check(dir, "directory");
        if (problem) refuse(problem);
    }
    const walk = (dir: string): void => {
        const problem = check(dir, "directory");
        if (problem) refuse(problem);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(target);
            } else if (entry.isFile()) {
                const fileProblem = check(target, "file");
                if (fileProblem) refuse(fileProblem);
            } else {
                // A link could lead anywhere, including somewhere the worker can write.
                refuse(`${target} is a link or other special file, and the copy may hold only files and folders`);
            }
        }
    };
    walk(copy);
}
