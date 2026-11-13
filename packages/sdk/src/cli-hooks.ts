import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `PILOTSWARM_CLI_DISABLE_HOOKS=1`: a CLI the worker starts runs no hook from
 * its home's settings or the session's working folder. Every session is
 * created and resumed with `enableFileHooks: false`, and before every CLI
 * launch and every session create or resume the CLI home's `settings.json`
 * turns inline hooks off and its `config.json` holds nothing a hook could
 * hide in. Off by default.
 */
export function cliHooksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.PILOTSWARM_CLI_DISABLE_HOOKS === "1";
}

/** The CLI home's `settings.json` with every inline hook off. */
export const CLI_HOOKS_OFF_SETTINGS_TEXT = '{\n  "disableAllHooks": true\n}\n';

const CLI_CONFIG_COMMENT_LINES = [
    "// User settings belong in settings.json.",
    "// This file is managed automatically.",
];

/**
 * The CLI home's `config.json` in the CLI's own form: its two comment lines
 * and only `firstLaunchAt`. A key the CLI reads from here would replace the
 * same key in `settings.json`, hooks included.
 */
export const CLI_HOOKS_OFF_CONFIG_TEXT = `${CLI_CONFIG_COMMENT_LINES.join("\n")}\n{\n  "firstLaunchAt": "1970-01-01T00:00:00.000Z"\n}\n`;

function parsedObject(text: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function settingsInForm(text: string): boolean {
    const value = parsedObject(text.replace(/^\uFEFF/, ""));
    return value !== null && Object.keys(value).length === 1 && value.disableAllHooks === true;
}

function configInForm(text: string): boolean {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0]?.trimEnd() !== CLI_CONFIG_COMMENT_LINES[0] || lines[1]?.trimEnd() !== CLI_CONFIG_COMMENT_LINES[1]) return false;
    const value = parsedObject(lines.slice(2).join("\n"));
    return value !== null && Object.keys(value).length === 1 && "firstLaunchAt" in value;
}

async function keepInForm(file: string, inForm: (text: string) => boolean, text: string): Promise<void> {
    let current: string | null = null;
    try {
        current = await fs.promises.readFile(file, "utf8");
    } catch (err: any) {
        if (err?.code !== "ENOENT") throw new Error(`PILOTSWARM_CLI_DISABLE_HOOKS: cannot read ${file}: ${err?.message ?? err}`);
    }
    // A file already in form is left alone, so a read-only one passes.
    if (current !== null && inForm(current)) return;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.promises.writeFile(temp, text, { encoding: "utf8", flag: "wx" });
        await fs.promises.rename(temp, file);
    } catch (err: any) {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
        throw new Error(`PILOTSWARM_CLI_DISABLE_HOOKS: cannot reset ${file}: ${err?.message ?? err}`);
    }
}

const resets = new Map<string, Promise<void>>();

/**
 * Put the CLI home's `settings.json` and `config.json` in their fixed form,
 * writing a file only when it is not in that form, through a temporary file
 * and a rename. One reset of a home runs at a time. Rejects when a file
 * cannot be read or written, so the launch or session call fails.
 */
export function resetCliHomeSettings(home: string): Promise<void> {
    const key = path.resolve(home);
    const run = (resets.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await fs.promises.mkdir(key, { recursive: true });
        await keepInForm(path.join(key, "settings.json"), settingsInForm, CLI_HOOKS_OFF_SETTINGS_TEXT);
        await keepInForm(path.join(key, "config.json"), configInForm, CLI_HOOKS_OFF_CONFIG_TEXT);
    });
    resets.set(key, run);
    void run.finally(() => {
        if (resets.get(key) === run) resets.delete(key);
    }).catch(() => {});
    return run;
}

/**
 * The setting rewrites the CLI home's settings, so the worker refuses it
 * unless that home is named explicitly: `COPILOT_HOME` must be set, so the
 * CLI's default home is never rewritten, and the session state folder must
 * be its `session-state` folder. Which folder it names is the deployment's
 * choice: one of the worker's own, never an account's `~/.copilot`.
 */
export function assertCliHooksHome(sessionStateDir: string, env: NodeJS.ProcessEnv = process.env): void {
    if (!cliHooksDisabled(env)) return;
    const home = env.COPILOT_HOME?.trim();
    if (!home) {
        throw new Error("PILOTSWARM_CLI_DISABLE_HOOKS=1 needs COPILOT_HOME: the worker rewrites that folder's settings, never an account's own ~/.copilot.");
    }
    const expected = path.resolve(home, "session-state");
    const actual = path.resolve(sessionStateDir);
    const same = process.platform === "win32" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
    if (!same) {
        throw new Error(`PILOTSWARM_CLI_DISABLE_HOOKS=1 needs the session state folder to be COPILOT_HOME's session-state folder (${expected}), not ${actual}.`);
    }
}
