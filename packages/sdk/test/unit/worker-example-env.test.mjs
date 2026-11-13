/**
 * The owner routing settings of the example worker, packages/sdk/examples/worker.js
 * (docs/proposals/windows-worker-pool.md, settings PILOTSWARM_WORKER_OWNER_TAG
 * and PILOTSWARM_WORKER_OWNER_ONLY).
 *
 * Each case runs the example in a child process with the settings. There
 * `pilotswarm-sdk` resolves to a module with the extension loaders from dist/
 * and a PilotSwarmWorker that prints the options the example passes and
 * whose start and shutdown do nothing, so no database is needed. The real
 * worker's checks of those options have their own tests (owner-routing.test.mjs).
 *
 * Run: node --test test/unit/worker-example-env.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE = fileURLToPath(new URL("../../examples/worker.js", import.meta.url));
const OWNER_TAG = "owner.6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01";
const OPTIONS_LINE = "WORKER_OPTIONS ";

const SDK = `export { horizonConfigFromEnv } from ${JSON.stringify(new URL("../../dist/horizon-env.js", import.meta.url).href)};
export { loadExtensionModules, parseExtensionModules } from ${JSON.stringify(new URL("../../dist/extension-modules.js", import.meta.url).href)};
export class PilotSwarmWorker {
    constructor(options) {
        console.log(${JSON.stringify(OPTIONS_LINE)} + JSON.stringify({ ownerTag: options.ownerTag ?? null, ownerOnly: options.ownerOnly ?? null }));
        this.modelProviders = null;
        this.loadedAgents = [];
        this.loadedSkillDirs = [];
        this.loadedMcpServers = {};
    }
    async start() {}
    async waitForShutdown() { return 0; }
}`;
const RESOLVE_SDK = `import { registerHooks } from "node:module";
registerHooks({
    resolve(specifier, context, nextResolve) {
        return specifier === "pilotswarm-sdk"
            ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(SDK)}`)}, shortCircuit: true }
            : nextResolve(specifier, context);
    },
});`;

/** Run the example with these settings: its exit code, the options it gave the worker (or null) and its stderr. */
function runExample(settings) {
    const home = mkdtempSync(join(tmpdir(), "ps-worker-example-"));
    const inherited = Object.entries(process.env).filter(([name]) => !/^(PILOTSWARM_|COPILOT_|GITHUB_TOKEN$|DATABASE_URL$)/.test(name));
    const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(RESOLVE_SDK)}`, EXAMPLE], {
        cwd: home,
        env: { ...Object.fromEntries(inherited), DATABASE_URL: "postgresql://nobody@127.0.0.1:9/none", LOG_LEVEL: "error", ...settings },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`the example did not exit: ${stdout}${stderr}`)); }, 60_000);
        child.on("error", reject);
        child.on("close", (code) => {
            clearTimeout(timer);
            rmSync(home, { recursive: true, force: true });
            const line = stdout.split(/\r?\n/).find((text) => text.startsWith(OPTIONS_LINE));
            resolve({ code, options: line ? JSON.parse(line.slice(OPTIONS_LINE.length)) : null, stderr });
        });
    });
}

test("the example passes PILOTSWARM_WORKER_OWNER_TAG as ownerTag and PILOTSWARM_WORKER_OWNER_ONLY=1 as ownerOnly; unset or 0 is off", async () => {
    const cases = [
        [{}, { ownerTag: null, ownerOnly: false }],
        [{ PILOTSWARM_WORKER_OWNER_TAG: OWNER_TAG }, { ownerTag: OWNER_TAG, ownerOnly: false }],
        [{ PILOTSWARM_WORKER_OWNER_TAG: OWNER_TAG, PILOTSWARM_WORKER_OWNER_ONLY: "0" }, { ownerTag: OWNER_TAG, ownerOnly: false }],
        [{ PILOTSWARM_WORKER_OWNER_TAG: OWNER_TAG, PILOTSWARM_WORKER_OWNER_ONLY: "1" }, { ownerTag: OWNER_TAG, ownerOnly: true }],
        // The worker refuses this one (ownerOnly needs an ownerTag): the example passes it on.
        [{ PILOTSWARM_WORKER_OWNER_ONLY: "1" }, { ownerTag: null, ownerOnly: true }],
    ];
    const runs = await Promise.all(cases.map(([settings]) => runExample(settings)));
    runs.forEach((run, i) => {
        const [settings, options] = cases[i];
        assert.equal(run.code, 0, `${JSON.stringify(settings)}: ${run.stderr}`);
        assert.deepEqual(run.options, options, JSON.stringify(settings));
    });
});

test("the example stops before it builds a worker for a PILOTSWARM_WORKER_OWNER_ONLY other than 1 or 0", async () => {
    const values = ["true", "yes", "2"];
    const runs = await Promise.all(values.map((value) => runExample({ PILOTSWARM_WORKER_OWNER_TAG: OWNER_TAG, PILOTSWARM_WORKER_OWNER_ONLY: value })));
    runs.forEach((run, i) => {
        assert.notEqual(run.code, 0, values[i]);
        assert.equal(run.options, null, values[i]);
        assert.match(run.stderr, new RegExp(`PILOTSWARM_WORKER_OWNER_ONLY must be 1 or 0, not "${values[i]}"`));
    });
});
