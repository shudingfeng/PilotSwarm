// The PowerShell scripts: every one parses in PowerShell 7 (and in Windows
// PowerShell 5.1 on Windows, which Run Commands and image builds use), and
// the parts that can run against temporary folders and repositories do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildWorkerEnv, decodeUserData, parseEnvFile, USER_DATA_SETTINGS } from "../launcher.mjs";
import { validateReleaseManifest } from "../disk-attacher.mjs";
import { createGitRunner, listRepositories, writeCleanRecord } from "../../../../../packages/sdk/examples/devdrive-workspaces/git-repos.mjs";
import { gitTestEnv, psQuote, pwsh, REPO_ROOT, runDriver, serviceEnv, tempDir, userData, windowsPowerShell, WINDOWS_DIR } from "./fixtures.mjs";

const SCRIPTS = fs.readdirSync(WINDOWS_DIR).filter((name) => /\.ps(m)?1$/.test(name)).sort();
const noPwsh = !pwsh() && "PowerShell 7 is not installed";
const notWindows = process.platform !== "win32" && "Windows only";
const noRunCommandShell = notWindows || (!windowsPowerShell() && "no Windows PowerShell");
const scriptPath = (name) => path.join(WINDOWS_DIR, name);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Runs one command the way the disk controller's Run Command does: as the
 * only line of a script that Windows PowerShell runs with -File, in a
 * service's environment.
 */
function runAsRunCommand(home, commandLine, env = process.env) {
    const wrapper = fs.mkdtempSync(path.join(home, "run-command-"));
    try {
        const file = path.join(wrapper, "script.ps1");
        fs.writeFileSync(file, `${commandLine}\r\n`);
        return spawnSync(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
            { encoding: "utf8", env: serviceEnv(env), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } finally {
        fs.rmSync(wrapper, { recursive: true, force: true });
    }
}

test("the folder holds every script the image, the controller and the upgrade use", () => {
    for (const name of ["Build-WorkerOsImage.ps1", "Initialize-WinWorkerDisk.ps1", "Seed-WorkerReposDisk.ps1", "Pack-WinWorkerRelease.ps1",
        "Install-WinWorkerService.ps1", "Drain-And-StopWorker.ps1", "Clear-StaleWorkspaces.ps1", "Bootstrap-WinWorkerStamp.ps1", "PilotSwarm.WinWorker.psm1"]) {
        assert.ok(SCRIPTS.includes(name), name);
    }
});

for (const [label, shell, skip] of [["PowerShell 7", pwsh(), noPwsh], ["Windows PowerShell 5.1", windowsPowerShell(), notWindows || (!windowsPowerShell() && "no Windows PowerShell")]]) {
    test(`every script parses without errors in ${label}`, { skip }, () => {
        const files = SCRIPTS.map((name) => psQuote(scriptPath(name))).join(", ");
        const command = `$all = @{}; foreach ($file in @(${files})) { $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors); $all[[System.IO.Path]::GetFileName($file)] = @($errors | ForEach-Object { $_.Message + ' (line ' + $_.Extent.StartLineNumber + ')' }) }; ConvertTo-Json -InputObject $all -Compress -Depth 4`;
        const parsed = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        assert.equal(parsed.status, 0, parsed.stderr);
        const errors = JSON.parse(parsed.stdout);
        assert.deepEqual(Object.keys(errors).sort(), SCRIPTS);
        for (const [file, list] of Object.entries(errors)) assert.deepEqual(list ?? [], [], file);
    });
}

// ── The clean-detach record ─────────────────────────────────────────────

/** A clone with a submodule, an extra branch, an annotated tag and a detached submodule HEAD. */
function repoWithSubmodule(home) {
    const env = gitTestEnv(home);
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const lib = path.join(home, "lib.git");
    git(home, "init", "-q", "--bare", lib);
    const libSeed = path.join(home, "lib-seed");
    git(home, "init", "-q", "-b", "main", libSeed);
    fs.writeFileSync(path.join(libSeed, "lib.txt"), "lib\n");
    git(libSeed, "add", "-A");
    git(libSeed, "commit", "-q", "-m", "lib one");
    git(libSeed, "push", "-q", lib, "main");
    const origin = path.join(home, "app.git");
    git(home, "init", "-q", "--bare", origin);
    const seed = path.join(home, "app-seed");
    git(home, "init", "-q", "-b", "main", seed);
    fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
    git(seed, "submodule", "add", "-q", lib, "lib");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "one");
    git(seed, "tag", "-a", "v1", "-m", "release one");
    git(seed, "branch", "feature");
    git(seed, "push", "-q", origin, "main", "feature", "v1");
    const reposRoot = path.join(home, "Q", "Repos");
    fs.mkdirSync(reposRoot, { recursive: true });
    git(reposRoot, "clone", "-q", "--recurse-submodules", origin, "app");
    return { env, git, origin, reposRoot, app: path.join(reposRoot, "app") };
}

test("the seed's clean-detach records are byte for byte what the Dev Drive extension writes", { skip: noPwsh }, async () => {
    const home = tempDir("ps-win-tips-");
    try {
        const { env, git, reposRoot, app } = repoWithSubmodule(home);
        const runGit = createGitRunner({ env });
        const repos = await listRepositories([{ name: "repos", path: reposRoot }], runGit);
        assert.equal(repos.length, 2, "the clone and its submodule");
        assert.deepEqual(await writeCleanRecord(repos, runGit), { ok: true, failures: [] });
        const expected = repos.map((repo) => fs.readFileSync(path.join(repo.gitDir, "pilotswarm-clean-tips")));

        // -Refresh runs in Windows PowerShell 5.1 (a Run Command); the first seed may run in either.
        for (const shell of [pwsh(), windowsPowerShell()].filter(Boolean)) {
            for (const repo of repos) fs.rmSync(path.join(repo.gitDir, "pilotswarm-clean-tips"));
            const driver = runDriver(home, "tips.ps1", [
                `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))}`,
                `$written = @(Write-CleanTipsRecords -Path ${psQuote(app)})`,
                "Remove-Item -LiteralPath $script:EmptyHooks -Recurse -Force",
                "ConvertTo-Json -InputObject $written -Compress",
            ].join("\n"), { env, shell });
            assert.equal(driver.status, 0, `${shell}: ${driver.stderr}${driver.stdout}`);
            assert.equal(driver.json.length, 2);
            for (const [index, repo] of repos.entries()) {
                const actual = fs.readFileSync(path.join(repo.gitDir, "pilotswarm-clean-tips"));
                assert.ok(actual.equals(expected[index]), `${shell} ${repo.path}: ${JSON.stringify(actual.toString())} vs ${JSON.stringify(expected[index].toString())}`);
                assert.notEqual(actual[0], 0xef, "no byte order mark");
                assert.equal(actual.includes(13), false, "LF line endings only");
            }
        }
        const tips = expected[0].toString().trim().split("\n");
        assert.equal(tips[0], git(app, "rev-parse", "HEAD"), "HEAD comes first");
        assert.ok(tips.includes(git(app, "rev-parse", "refs/tags/v1")), "an annotated tag's own object");
        assert.equal(new Set(tips).size, tips.length, "each object once");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("-Verify prints one JSON line last and fails the controller's Run Command unless every check passes", { skip: noPwsh || noRunCommandShell }, () => {
    const home = tempDir("ps-win-verify-");
    try {
        const { env, origin } = repoWithSubmodule(home);
        const reposRoot = path.join(home, "Drive", "Repos");
        const manifestPath = path.join(home, "seed-manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify({
            schemaVersion: 1,
            reposRoot,
            repositories: [{ name: "app", url: `file:///${origin.replace(/\\/g, "/")}`, branch: "main", submodules: true }],
            modifyFolders: [path.join(reposRoot, "app")],
        }, null, 2));
        // The refresh's steps, in the Windows PowerShell 5.1 a Run Command uses.
        const seeded = runDriver(home, "seed.ps1", [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))} -WorkerEnvFile ${psQuote(path.join(home, "none.env"))}`,
            `$manifest = Test-SeedManifest (Read-JsonFile -Path ${psQuote(manifestPath)})`,
            "Initialize-GitEnvironment $manifest",
            "foreach ($repo in $manifest.Repositories) { Update-SeedRepository -Repository $repo -ReposRoot $manifest.ReposRoot; Remove-RepositoryHooks -Path $repo.Path; [void](Write-CleanTipsRecords -Path $repo.Path) }",
            `Save-SeedState -Manifest $manifest -ManifestSha256 (Get-Sha256Hex ${psQuote(manifestPath)}) -Mode 'seed'`,
            "Remove-Item -LiteralPath $script:EmptyHooks -Recurse -Force",
            "ConvertTo-Json -InputObject @{ seeded = $manifest.Repositories.Count } -Compress",
        ].join("\n"), { env, shell: windowsPowerShell() });
        assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
        assert.deepEqual(seeded.json, { seeded: 1 });

        // Exactly the controller's command, with this test's manifest and settings.
        const verifyCommand = `& ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))} -Verify -ManifestPath ${psQuote(manifestPath)} -WorkerEnvFile ${psQuote(path.join(home, "none.env"))}`;
        const verify = runAsRunCommand(home, verifyCommand, env);
        const lines = verify.stdout.split(/\r?\n/).filter((line) => line.trim());
        const result = JSON.parse(lines.at(-1));
        assert.deepEqual(Object.keys(result), ["verified", "manifestSha256", "checks"]);
        assert.equal(result.manifestSha256, sha256(fs.readFileSync(manifestPath)));
        assert.deepEqual(Object.keys(result.checks), ["refs", "fsck", "hooks", "cleanRecord", "owner", "acl"]);
        for (const check of ["refs", "fsck", "hooks", "cleanRecord"]) assert.equal(result.checks[check], true, `${check}: ${JSON.stringify(result.checks[check])}`);
        // A test cannot hand the repositories to the service's account: those checks fail, and so does the drive.
        assert.ok(Array.isArray(result.checks.owner) && result.checks.owner.length > 0);
        assert.ok(Array.isArray(result.checks.acl) && result.checks.acl.length > 0);
        assert.equal(result.verified, false);
        assert.equal(verify.status, 1, "a nested exit code would leave the Run Command's script at 0");
        assert.match(verify.stderr, /failed verification/);

        fs.writeFileSync(path.join(reposRoot, "app", ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
        const planted = runAsRunCommand(home, verifyCommand, env);
        const plantedResult = JSON.parse(planted.stdout.split(/\r?\n/).filter((line) => line.trim()).at(-1));
        assert.match(plantedResult.checks.hooks[0], /post-checkout/);
        assert.equal(planted.status, 1);

        const broken = spawnSync(pwsh(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath("Seed-WorkerReposDisk.ps1"), "-Verify",
            "-ManifestPath", path.join(home, "missing.json")], { encoding: "utf8", env, windowsHide: true });
        const brokenResult = JSON.parse(broken.stdout.split(/\r?\n/).filter((line) => line.trim()).at(-1));
        assert.equal(brokenResult.verified, false);
        assert.ok(Array.isArray(brokenResult.checks.manifest));
        assert.equal(broken.status, 1);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the seed manifest: the example is valid, also on a machine without its drive, and a manifest the worker could not use is refused", { skip: noPwsh || notWindows }, () => {
    const home = tempDir("ps-win-seedmf-");
    try {
        const base = JSON.parse(fs.readFileSync(path.join(WINDOWS_DIR, "examples", "seed-manifest.json"), "utf8"));
        const variants = {
            outside: { ...base, modifyFolders: ["Q:\\temp"] },
            rootModify: { ...base, modifyFolders: [...base.modifyFolders, "Q:\\Repos"] },
            credentials: { ...base, repositories: [{ ...base.repositories[0], url: "https://user:pat@example.test/repo.git" }] },
            branch: { ...base, repositories: [{ ...base.repositories[0], branch: "../main" }] },
            twice: { ...base, repositories: [base.repositories[0], { ...base.repositories[0], name: "pilotswarm" }] },
            unknown: { ...base, extra: true },
        };
        for (const [name, value] of Object.entries(variants)) fs.writeFileSync(path.join(home, `${name}.json`), JSON.stringify(value));
        // Only a worker has the drive of reposRoot; the check runs anywhere.
        const missingDrive = [..."ZYXWVUTSRPONMLKJIHGF"].find((letter) => !fs.existsSync(`${letter}:\\`));
        assert.ok(missingDrive, "this machine has a free drive letter");
        const onMissingDrive = (folder) => folder.replace(/^Q:/i, `${missingDrive}:`);
        fs.writeFileSync(path.join(home, "elsewhere.json"), JSON.stringify({ ...base, reposRoot: onMissingDrive(base.reposRoot), modifyFolders: base.modifyFolders.map(onMissingDrive) }));
        const driver = runDriver(home, "manifest.ps1", [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))}`,
            `$example = Test-SeedManifest (Read-JsonFile -Path ${psQuote(path.join(WINDOWS_DIR, "examples", "seed-manifest.json"))})`,
            `$elsewhere = Test-SeedManifest (Read-JsonFile -Path ${psQuote(path.join(home, "elsewhere.json"))})`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(variants).map(psQuote).join(", ")})) { try { [void](Test-SeedManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($name + '.json')))); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 5 -InputObject @{ repos = @($example.Repositories | ForEach-Object { $_.Path }); elsewhere = @($elsewhere.Repositories | ForEach-Object { $_.Path }); modify = $example.ModifyFolders; caches = @($example.PackageCaches | ForEach-Object { $_.Name }); refused = $refused }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.deepEqual(driver.json.repos, ["Q:\\Repos\\PilotSwarm", "Q:\\Repos\\Hello-World"]);
        assert.deepEqual(driver.json.elsewhere, [`${missingDrive}:\\Repos\\PilotSwarm`, `${missingDrive}:\\Repos\\Hello-World`]);
        assert.deepEqual(driver.json.caches, ["npm"]);
        assert.match(driver.json.refused.outside, /no modify folder covers/);
        assert.match(driver.json.refused.rootModify, /reposRoot itself stays read-only/);
        assert.match(driver.json.refused.credentials, /credentials/);
        assert.match(driver.json.refused.branch, /branch/);
        assert.match(driver.json.refused.twice, /listed twice/);
        assert.match(driver.json.refused.unknown, /unknown field extra/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the seed starts only where Windows knows the worker's account, which icacls needs", { skip: noRunCommandShell }, () => {
    const home = tempDir("ps-win-account-");
    try {
        // In the Windows PowerShell 5.1 that the refresh's Run Command uses.
        const driver = runDriver(home, "account.ps1", [
            `Import-Module ${psQuote(scriptPath("PilotSwarm.WinWorker.psm1"))} -Force`,
            "try { $sid = Assert-WorkerServiceSid; $answer = 'accepted ' + $sid } catch { $answer = $_.Exception.Message }",
            "ConvertTo-Json -Compress -InputObject @{ answer = $answer; installed = [bool](Get-Service -Name PilotSwarmWorker -ErrorAction SilentlyContinue) }",
        ].join("\n"), { shell: windowsPowerShell() });
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        if (driver.json.installed) assert.match(driver.json.answer, /^accepted S-1-5-80-3872531353-3733398320-4078817223-2862367190-1897339925$/);
        else assert.match(driver.json.answer, /does not exist on this machine, because its service is not installed/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// An az for the seed's snapshot: it logs each call, and each snapshot show
// answers with the next state of FAKE_AZ_HOME/states.json, then the last.
const FAKE_AZ = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.FAKE_AZ_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify(args) + "\n");
if (args[0] === "snapshot" && args[1] === "create") process.exit(0);
if (args[0] === "snapshot" && args[1] === "show") {
  const file = path.join(home, "states.json");
  const states = JSON.parse(fs.readFileSync(file, "utf8"));
  const state = states.length > 1 ? states.shift() : states[0];
  fs.writeFileSync(file, JSON.stringify(states));
  console.log(JSON.stringify({ name: "golden-1", ...state }));
  process.exit(0);
}
console.error("unexpected az call: " + args.join(" "));
process.exit(9);
`;

test("the seed's snapshot is complete only once Azure reports it Succeeded and copied, and a failed one stops the seed", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-snapshot-");
    try {
        const bin = path.join(home, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "az.cjs"), FAKE_AZ);
        if (process.platform === "win32") {
            fs.writeFileSync(path.join(bin, "az.cmd"), `@"${process.execPath}" "%~dp0az.cjs" %*\r\n`);
        } else {
            fs.writeFileSync(path.join(bin, "az"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/az.cjs" "$@"\n`, { mode: 0o755 });
        }
        const env = { ...process.env, FAKE_AZ_HOME: home };
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
        env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
        const disk = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Compute/disks/seed";
        const snapshot = (states) => {
            fs.writeFileSync(path.join(home, "states.json"), JSON.stringify(states));
            fs.writeFileSync(path.join(home, "calls.jsonl"), "");
            const driver = runDriver(home, "snapshot.ps1", [
                `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))} -SnapshotResourceGroup rg -SnapshotName golden-1 -DiskResourceId ${psQuote(disk)}`,
                // The drive is not real here.
                "function Write-VolumeCache { param([string]$DriveLetter) }",
                "$script:SnapshotPollSeconds = 0",
                "try { New-SeedSnapshot -Manifest ([pscustomobject]@{ Drive = 'Q:\\' }); $outcome = 'complete' } catch { $outcome = $_.Exception.Message }",
                "ConvertTo-Json -Compress -InputObject @{ outcome = $outcome }",
            ].join("\n"), { env });
            assert.equal(driver.status, 0, driver.stderr + driver.stdout);
            const calls = fs.readFileSync(path.join(home, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
            return { outcome: driver.json.outcome, calls, shows: calls.filter((call) => call[1] === "show").length };
        };

        // An empty percentage while Azure still creates it, then the copy at 40%, is not yet complete.
        const copied = snapshot([
            { provisioningState: "Creating", completionPercent: null },
            { provisioningState: "Succeeded", completionPercent: 40.5 },
            { provisioningState: "Succeeded", completionPercent: 100 },
        ]);
        assert.equal(copied.outcome, "complete");
        assert.equal(copied.shows, 3);
        assert.deepEqual(copied.calls[0], ["snapshot", "create", "--resource-group", "rg", "--name", "golden-1", "--source", disk, "--incremental", "true", "--output", "none"]);
        assert.deepEqual(copied.calls[1], ["snapshot", "show", "--resource-group", "rg", "--name", "golden-1", "--output", "json"]);

        // Succeeded without a percentage, as the controller's refresh has it: nothing is left to copy.
        const noPercent = snapshot([{ provisioningState: "Succeeded" }]);
        assert.equal(noPercent.outcome, "complete");
        assert.equal(noPercent.shows, 1);

        const failed = snapshot([{ provisioningState: "Creating", completionPercent: null }, { provisioningState: "Failed", completionPercent: null }]);
        assert.equal(failed.outcome, "the snapshot golden-1 failed to provision");
        assert.equal(failed.shows, 2);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ── The image ───────────────────────────────────────────────────────────

/** The SDK's fixed settings texts (packages/sdk/src/cli-hooks.ts), evaluated from its source. */
function sdkSettingsTexts() {
    const source = fs.readFileSync(path.join(REPO_ROOT, "packages", "sdk", "src", "cli-hooks.ts"), "utf8");
    const start = source.indexOf("export const CLI_HOOKS_OFF_SETTINGS_TEXT");
    const configAt = source.indexOf("export const CLI_HOOKS_OFF_CONFIG_TEXT");
    assert.ok(start >= 0 && configAt > start, "cli-hooks.ts defines both texts");
    const snippet = source.slice(start, source.indexOf("\n", configAt)).replace(/export const/g, "const");
    return new Function(`${snippet}\nreturn { settings: CLI_HOOKS_OFF_SETTINGS_TEXT, config: CLI_HOOKS_OFF_CONFIG_TEXT };`)();
}

test("the image's Copilot settings files hold exactly the texts the worker checks, and the toolchain manifest is checked", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-build-");
    try {
        const bad = {
            unknown: { schemaVersion: 1, extra: 1 },
            http: { schemaVersion: 1, installers: [{ name: "x", url: "http://example.test/x.exe", sha256: "a".repeat(64), type: "exe" }] },
            upperHash: { schemaVersion: 1, installers: [{ name: "x", url: "https://example.test/x.exe", sha256: "A".repeat(64), type: "exe" }] },
            zipNoDestination: { schemaVersion: 1, installers: [{ name: "x", url: "https://example.test/x.zip", sha256: "a".repeat(64), type: "zip" }] },
            duplicate: { schemaVersion: 1, commands: [{ name: "x", command: ["a"] }], mcpServers: [{ name: "X", package: "p", version: "1.0.0" }] },
            rangeVersion: { schemaVersion: 1, mcpServers: [{ name: "m", package: "p", version: "^1.0.0" }] },
        };
        for (const [name, value] of Object.entries(bad)) fs.writeFileSync(path.join(home, `${name}.json`), JSON.stringify(value));
        const driver = runDriver(home, "build.ps1", [
            `. ${psQuote(scriptPath("Build-WorkerOsImage.ps1"))}`,
            "$texts = Get-CopilotSettingsText",
            `$example = Test-ToolchainManifest (Read-JsonFile -Path ${psQuote(path.join(WINDOWS_DIR, "examples", "toolchain-manifest.json"))})`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(bad).map(psQuote).join(", ")})) { try { [void](Test-ToolchainManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($name + '.json')))); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 5 -InputObject @{ settings = $texts.Settings; config = $texts.Config; installers = @($example.installers | ForEach-Object { $_.name }); refused = $refused; modify = $script:ModifyFolders; placeholders = $CopilotHomeFiles + $CopilotHomeFolders }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        const sdk = sdkSettingsTexts();
        assert.equal(driver.json.settings, sdk.settings);
        assert.equal(driver.json.config, sdk.config);
        assert.deepEqual(driver.json.installers, ["git", "powershell"]);
        assert.deepEqual(driver.json.modify, ["copilot", "copilot\\session-state", "copilot\\logs", "logs", "temp", "azure-cli"]);
        for (const name of ["copilot-instructions.md", "mcp-config.json", "lsp-config.json", "permissions-config.json", "providers.json", "instructions", "skills",
            "agents", "extensions", "pkg", "hooks", "installed-plugins", "mcp-oauth-config", "mcp-secrets"]) {
            assert.ok(driver.json.placeholders.includes(name), name);
        }
        assert.match(driver.json.refused.unknown, /unknown field extra/);
        assert.match(driver.json.refused.http, /https/);
        assert.match(driver.json.refused.upperHash, /lowercase sha256/);
        assert.match(driver.json.refused.zipNoDestination, /absolute destination/);
        assert.match(driver.json.refused.duplicate, /used twice/);
        assert.match(driver.json.refused.rangeVersion, /exact version/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the CLI home's placeholders hold what the Copilot CLI reads as no configuration, and the folders are folders", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-cli-home-");
    try {
        const folder = path.join(home, "copilot");
        fs.mkdirSync(folder);
        // A file the image already wrote keeps its contents.
        fs.writeFileSync(path.join(folder, "copilot-instructions.md"), "kept");
        const driver = runDriver(home, "cli-home.ps1", [
            `. ${psQuote(scriptPath("Build-WorkerOsImage.ps1"))}`,
            `New-CopilotHomePlaceholders -Folder ${psQuote(folder)}`,
            "ConvertTo-Json -Compress -InputObject @{ files = $CopilotHomeFiles; folders = $CopilotHomeFolders }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        const { files, folders } = driver.json;
        assert.deepEqual(fs.readdirSync(folder).sort(), ["config.json", "settings.json", ...files, ...folders].sort());
        for (const name of folders) assert.equal(fs.statSync(path.join(folder, name)).isDirectory(), true, name);
        const text = (name) => fs.readFileSync(path.join(folder, name), "utf8");
        // The CLI rejects {} for these two (mcpServers is required, lspServers must be an object).
        assert.deepEqual(JSON.parse(text("mcp-config.json")), { mcpServers: {} });
        assert.deepEqual(JSON.parse(text("lsp-config.json")), { lspServers: {} });
        // An empty providers.json is no file to the CLI: it keeps its own model providers.
        assert.equal(text("providers.json"), "");
        for (const name of files.filter((n) => n.endsWith(".json") && !["mcp-config.json", "lsp-config.json", "providers.json"].includes(n))) {
            assert.deepEqual(JSON.parse(text(name)), {}, name);
        }
        assert.equal(text("copilot-instructions.md"), "kept");
        const sdk = sdkSettingsTexts();
        assert.equal(text("settings.json"), sdk.settings);
        assert.equal(text("config.json"), sdk.config);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("worker.env and the two WinSW services, from the example worker settings", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-install-");
    try {
        const refusals = {
            userData: "DATABASE_URL=postgresql://x@db/y",
            fixed: "COPILOT_HOME=C:\\elsewhere",
            launcher: "PS_LAUNCH_ID=x",
            token: "GITHUB_TOKEN=x",
            timeout: "PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS=7200000",
            extension: "PILOTSWARM_EXTENSION_MODULES=C:\\other\\index.mjs",
        };
        for (const [name, line] of Object.entries(refusals)) fs.writeFileSync(path.join(home, `${name}.env`), `${line}\n`);
        const driver = runDriver(home, "install.ps1", [
            `. ${psQuote(scriptPath("Install-WinWorkerService.ps1"))}`,
            `$envText = New-WorkerEnvContent -Settings (Read-EnvFile -Path ${psQuote(path.join(WINDOWS_DIR, "examples", "worker-settings.env.example"))}) -Root 'C:\\pilotswarm' -SettingsName 'worker-settings.env'`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(refusals).map(psQuote).join(", ")})) { try { [void](New-WorkerEnvContent -Settings (Read-EnvFile -Path (Join-Path ${psQuote(home)} ($name + '.env'))) -Root 'C:\\pilotswarm'); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 5 -InputObject @{ env = $envText; worker = (New-WinSWServiceXml -Service Worker -Root 'C:\\pilotswarm' -NodeExe 'C:\\Program Files\\nodejs\\node.exe'); attacher = (New-WinSWServiceXml -Service Attacher -Root 'C:\\pilotswarm' -NodeExe 'C:\\Program Files\\nodejs\\node.exe'); refused = $refused }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);

        // The launcher reads this worker.env, and overlays userData on it without a collision.
        const entries = parseEnvFile(driver.json.env);
        const values = Object.fromEntries(entries.map(({ name, value }) => [name, value]));
        assert.equal(values.COPILOT_HOME, "C:\\pilotswarm\\copilot");
        assert.equal(values.SESSION_STATE_DIR, "C:\\pilotswarm\\copilot\\session-state");
        assert.equal(values.COPILOT_PKG_CACHE_HOME, "C:\\pilotswarm\\current\\copilot-pkg");
        assert.equal(values.PS_DISK_ATTACHER_URL, "http://127.0.0.1:3099");
        assert.equal(values.PS_DISK_ATTACHER_TOKEN_FILE, "C:\\pilotswarm\\run\\attacher.token");
        assert.equal(values.PS_DISK_CONTROLLER_TOKEN_MODULE, "C:\\pilotswarm\\controller-token.mjs");
        assert.equal(values.PILOTSWARM_EXTENSION_MODULES, "C:\\pilotswarm\\current\\packages\\sdk\\examples\\devdrive-workspaces\\index.mjs");
        assert.equal(values.PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE, "1");
        assert.equal(values.PILOTSWARM_AGENT_PACKAGES, "0");
        assert.equal(values.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
        assert.equal(values.AZURE_EXTENSION_DIR, "C:\\pilotswarm\\az-extensions");
        assert.equal(values.TEMP, "C:\\pilotswarm\\temp");
        assert.equal(values.GIT_AUTHOR_NAME, "PilotSwarm Agent");
        assert.equal(values.PILOTSWARM_WORKER_CONCURRENCY, "4");
        assert.equal(values.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS, "6000000");
        for (const name of USER_DATA_SETTINGS) assert.equal(name in values, false, name);
        const merged = buildWorkerEnv({ workerEnv: entries, userData: decodeUserData(userData({ extraEnv: { EXAMPLE_API_URL: "https://api.example.test" } })) });
        assert.equal(merged.EXAMPLE_API_URL, "https://api.example.test");

        assert.match(driver.json.refused.userData, /only the scale set's userData sets/);
        assert.match(driver.json.refused.fixed, /the image fixes/);
        assert.match(driver.json.refused.launcher, /no worker image may carry|only/);
        assert.match(driver.json.refused.token, /no worker image may carry/);
        assert.match(driver.json.refused.timeout, /105-minute stop timeout/);
        assert.match(driver.json.refused.extension, /Dev Drive extension/);

        const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((match) => match[1]);
        const worker = driver.json.worker;
        assert.deepEqual(tag(worker, "id"), ["PilotSwarmWorker"]);
        assert.deepEqual(tag(worker, "executable"), ["C:\\Program Files\\nodejs\\node.exe"]);
        assert.deepEqual(tag(worker, "arguments"), ["&quot;C:\\pilotswarm\\launcher.mjs&quot;"]);
        assert.deepEqual(tag(worker, "workingdirectory"), ["C:\\pilotswarm\\work"]);
        assert.deepEqual(tag(worker, "depend"), ["PilotSwarmDiskAttacher"]);
        assert.deepEqual(tag(worker, "stoptimeout"), ["105 min"]);
        assert.deepEqual(tag(worker, "stopparentprocessfirst"), ["true"]);
        assert.match(worker, /<env name="NODE_EXTRA_CA_CERTS" value="C:\\pilotswarm\\disk-controller-ca.crt"\/>/);
        assert.match(worker, /<onfailure action="restart" delay="10 sec"\/>/);
        const attacher = driver.json.attacher;
        assert.deepEqual(tag(attacher, "id"), ["PilotSwarmDiskAttacher"]);
        assert.deepEqual(tag(attacher, "executable"), ["C:\\Program Files\\nodejs\\node.exe"]);
        assert.deepEqual(tag(attacher, "arguments"), ["&quot;C:\\pilotswarm\\disk-attacher.mjs&quot;"]);
        assert.deepEqual(tag(attacher, "depend"), []);
        assert.match(attacher, /<env name="NODE_EXTRA_CA_CERTS" value="C:\\pilotswarm\\disk-controller-ca.crt"\/>/);
        assert.match(attacher, /<onfailure action="restart" delay="10 sec"\/>/);
        assert.deepEqual(tag(attacher, "stopparentprocessfirst"), ["true"]);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("worker.env's CLI allowlist always passes the image's Git and Azure CLI pins, and keeps the deployment's own entries", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-allowlist-");
    try {
        // The SDK's own rule for an entry, and how it matches names (copilot-client.ts, cliEnvAllowlist and
        // scrubbedCliEnvironment): by name or by a prefix that ends in *, without case.
        const source = fs.readFileSync(path.join(REPO_ROOT, "packages", "sdk", "src", "copilot-client.ts"), "utf8");
        const sdkEntry = new RegExp(/if \(!\/(\^[^/]+\$)\/\.test\(entry\)\)/.exec(source)[1]);
        const passes = (name, list) => list.split(",").map((e) => e.trim().toUpperCase()).filter(Boolean)
            .some((e) => (e.endsWith("*") ? name.toUpperCase().startsWith(e.slice(0, -1)) : name.toUpperCase() === e));
        const cases = {
            unset: null,
            empty: "",
            partial: "npm_config_*, AZURE_CONFIG_DIR",
            prefixes: "GIT_*,AZURE_*,MSBUILD*",
            exact: "git_config_global,AZURE_CONFIG_DIR,AZURE_EXTENSION_USE_DYNAMIC_INSTALL,AZURE_EXTENSION_DIR,AZURE_EXTENSION_DEV_SOURCES,AZURE_EXTENSION_SYS_DIR",
            invalid: "GIT_*,NOT-A-NAME",
        };
        for (const [name, value] of Object.entries(cases)) {
            fs.writeFileSync(path.join(home, `${name}.env`), value === null ? "PS_WIP_BRANCH_PREFIX=wip/\n" : `PILOTSWARM_CLI_ENV_ALLOWLIST=${value}\n`);
        }
        const driver = runDriver(home, "allowlist.ps1", [
            `. ${psQuote(scriptPath("Install-WinWorkerService.ps1"))}`,
            "$out = [ordered]@{}",
            `foreach ($name in @(${Object.keys(cases).map(psQuote).join(", ")})) { try { $out[$name] = New-WorkerEnvContent -Settings (Read-EnvFile -Path (Join-Path ${psQuote(home)} ($name + '.env'))) -Root 'C:\\pilotswarm' } catch { $out[$name] = 'refused: ' + $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -InputObject $out",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        const written = {};
        for (const name of Object.keys(cases).filter((n) => n !== "invalid")) {
            const entries = parseEnvFile(driver.json[name]);
            const lists = entries.filter((e) => e.name.toUpperCase() === "PILOTSWARM_CLI_ENV_ALLOWLIST");
            assert.equal(lists.length, 1, name);
            written[name] = lists[0].value;
            for (const entry of written[name].split(",")) assert.match(entry, sdkEntry, `${name}: ${entry}`);
            // Every value the image pins for agents' git and az reaches their CLI.
            const pinned = entries.filter((e) => e.name === "GIT_CONFIG_GLOBAL" || e.name === "AZURE_CONFIG_DIR" || e.name.startsWith("AZURE_EXTENSION_"));
            assert.equal(pinned.length, 6, name);
            for (const { name: pin } of pinned) assert.ok(passes(pin, written[name]), `${name}: ${pin}`);
        }
        assert.equal(written.unset, "GIT_CONFIG_GLOBAL,AZURE_CONFIG_DIR,AZURE_EXTENSION_*");
        assert.equal(written.empty, "GIT_CONFIG_GLOBAL,AZURE_CONFIG_DIR,AZURE_EXTENSION_*");
        assert.equal(written.partial, "npm_config_*,AZURE_CONFIG_DIR,GIT_CONFIG_GLOBAL,AZURE_EXTENSION_*");
        assert.equal(written.prefixes, cases.prefixes, "prefixes that cover every pin add nothing");
        assert.equal(written.exact, cases.exact, "names that cover every pin add nothing");
        assert.match(driver.json.invalid, /refused: .*"NOT-A-NAME" is neither a variable name nor a name prefix followed by \*/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ── The release packer ──────────────────────────────────────────────────

test("the packer's checks: Windows packages, the unpacked Copilot CLI program, links, the stub and current-release.json", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-pack-");
    try {
        const nodeModules = path.join(home, "node_modules");
        for (const pkg of ["@github/copilot-win32-x64", "@github/copilot-sdk-win32-x64"]) {
            fs.mkdirSync(path.join(nodeModules, ...pkg.split("/")), { recursive: true });
            fs.writeFileSync(path.join(nodeModules, ...pkg.split("/"), "package.json"), "{}");
        }
        const copilotPkg = path.join(home, "copilot-pkg");
        const version = path.join(copilotPkg, "pkg", "win32-x64", "1.0.83");
        fs.mkdirSync(path.join(version, "prebuilds", "win32-x64"), { recursive: true });
        for (const file of [".extraction-complete", "index.js", "app.js"]) fs.writeFileSync(path.join(version, file), "");
        const stage = path.join(home, "stage");
        fs.mkdirSync(path.join(stage, "packages", "sdk"), { recursive: true });
        fs.writeFileSync(path.join(stage, "plain.txt"), "x");
        const out = path.join(home, "out");
        fs.mkdirSync(path.join(out, "plugins"), { recursive: true });
        const commit = "c".repeat(40);
        fs.writeFileSync(path.join(out, `worker-release-${commit}.zip`), "zip bytes");
        fs.writeFileSync(path.join(out, "model-catalog-0123456789ab.json"), '{"defaultModel":"m"}');
        fs.writeFileSync(path.join(out, "headless-instructions-0123456789ab.zip"), "instructions");
        fs.writeFileSync(path.join(out, "plugins", "example-0123456789ab.zip"), "plugin");

        const driver = runDriver(home, "pack.ps1", [
            `. ${psQuote(scriptPath("Pack-WinWorkerRelease.ps1"))}`,
            "$result = [ordered]@{}",
            `try { Test-WindowsPackages -NodeModules ${psQuote(nodeModules)}; $result.packages = 'complete' } catch { $result.packages = $_.Exception.Message }`,
            `New-Item -ItemType Directory -Force -Path ${psQuote(path.join(nodeModules, "duroxide-windows-x64"))} | Out-Null; Set-Content -LiteralPath ${psQuote(path.join(nodeModules, "duroxide-windows-x64", "package.json"))} -Value '{}'`,
            `try { Test-WindowsPackages -NodeModules ${psQuote(nodeModules)}; $result.packagesAfter = 'complete' } catch { $result.packagesAfter = $_.Exception.Message }`,
            `try { Test-CopilotPackage -CopilotPkg ${psQuote(copilotPkg)} -Version '1.0.83'; $result.copilot = 'complete' } catch { $result.copilot = $_.Exception.Message }`,
            `Set-Content -LiteralPath ${psQuote(path.join(version, "prebuilds", "win32-x64", "runtime.node"))} -Value ''`,
            `try { Test-CopilotPackage -CopilotPkg ${psQuote(copilotPkg)} -Version '1.0.83'; $result.copilotAfter = 'complete' } catch { $result.copilotAfter = $_.Exception.Message }`,
            `$result.pinned = Get-PinnedCopilotVersion -RepoRoot ${psQuote(REPO_ROOT)}`,
            `$result.linksBefore = @(Find-ReparsePoint -Path ${psQuote(stage)})`,
            ...(process.platform === "win32" ? [`New-Item -ItemType Junction -Path ${psQuote(path.join(stage, "packages", "sdk", "linked"))} -Target ${psQuote(home)} | Out-Null`] : []),
            `$result.linksAfter = @(Find-ReparsePoint -Path ${psQuote(stage)})`,
            `Write-SdkPackageStub -Stage ${psQuote(stage)}`,
            `$plugins = @([pscustomobject]@{ Name = 'example'; Blob = 'plugins/example-0123456789ab.zip' })`,
            `$result.manifest = Write-CurrentReleaseJson -OutputDir ${psQuote(out)} -CommitSha '${commit}' -ZipFile ${psQuote(path.join(out, `worker-release-${commit}.zip`))} -ModelCatalogBlob 'model-catalog-0123456789ab.json' -HeadlessInstructionsBlob 'headless-instructions-0123456789ab.zip' -Plugins $plugins`,
            `try { [void](Write-CurrentReleaseJson -OutputDir ${psQuote(out)} -CommitSha '${commit}' -ZipFile ${psQuote(path.join(out, "model-catalog-0123456789ab.json"))}); $result.badZip = 'accepted' } catch { $result.badZip = $_.Exception.Message }`,
            "ConvertTo-Json -InputObject $result -Compress -Depth 5",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        const result = driver.json;
        assert.match(result.packages, /duroxide-windows-x64/);
        assert.equal(result.packagesAfter, "complete");
        assert.match(result.copilot, /runtime\.node/);
        assert.equal(result.copilotAfter, "complete");
        assert.equal(result.pinned, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages", "sdk", "package.json"), "utf8")).dependencies["@github/copilot"]);
        assert.deepEqual(result.linksBefore, []);
        if (process.platform === "win32") assert.deepEqual(result.linksAfter, [path.join(stage, "packages", "sdk", "linked")]);
        assert.equal(fs.readFileSync(path.join(stage, "packages", "sdk", "package.json"), "utf8"), '{"type":"module"}');
        assert.match(result.badZip, /worker-release-<commitSha>\.zip/);

        const written = JSON.parse(fs.readFileSync(path.join(out, "current-release.json"), "utf8"));
        assert.deepEqual(written, {
            schemaVersion: 1,
            commitSha: commit,
            zipSha256: sha256("zip bytes"),
            modelCatalog: { blob: "model-catalog-0123456789ab.json", sha256: sha256('{"defaultModel":"m"}') },
            headlessInstructions: { blob: "headless-instructions-0123456789ab.zip", sha256: sha256("instructions") },
            plugins: [{ name: "example", blob: "plugins/example-0123456789ab.zip", sha256: sha256("plugin") }],
        });
        assert.doesNotThrow(() => validateReleaseManifest(written), "the attacher accepts what the packer writes");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the packer's zips keep every name, non-ASCII ones included, and pass the attacher's checks", { skip: noPwsh || notWindows }, () => {
    const home = tempDir("ps-win-packzip-");
    try {
        const source = path.join(home, "source");
        fs.mkdirSync(path.join(source, "node_modules", "@scope", "pkg"), { recursive: true });
        fs.writeFileSync(path.join(source, "node_modules", "@scope", "pkg", "\u00fcber.js"), "1");
        fs.writeFileSync(path.join(source, "top.txt"), "2");
        const zip = path.join(home, "out.zip");
        const driver = runDriver(home, "zip.ps1", [
            `. ${psQuote(scriptPath("Pack-WinWorkerRelease.ps1"))}`,
            `New-ArtifactZip -Source ${psQuote(source)} -Destination ${psQuote(zip)}`,
            `$count = Test-ReleaseArchive -ZipFile ${psQuote(zip)} -Source ${psQuote(source)}`,
            `Set-Content -LiteralPath ${psQuote(path.join(source, "late.txt"))} -Value 'not in the zip'`,
            `try { [void](Test-ReleaseArchive -ZipFile ${psQuote(zip)} -Source ${psQuote(source)}); $mismatch = 'accepted' } catch { $mismatch = $_.Exception.Message }`,
            "ConvertTo-Json -Compress -InputObject @{ count = $count; mismatch = $mismatch }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.equal(driver.json.count, 5);
        assert.match(driver.json.mismatch, /late\.txt/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

for (const [label, shell] of [["PowerShell 7", pwsh()], ["Windows PowerShell 5.1", windowsPowerShell()]]) {
    test(`a stale stage or hook goes without following a junction, in ${label}`, { skip: notWindows || (!shell && `${label} is not installed`) }, () => {
        const home = tempDir("ps-win-unlink-");
        try {
            const outside = path.join(home, "repository-package");
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, "source.js"), "keep");
            const stage = path.join(home, "stage");
            const deep = path.join(stage, "node_modules", "a", "b");
            fs.mkdirSync(deep, { recursive: true });
            fs.writeFileSync(path.join(deep, "file.js"), "x");
            fs.writeFileSync(path.join(stage, "read-only.txt"), "x");
            fs.chmodSync(path.join(stage, "read-only.txt"), 0o444);
            fs.symlinkSync(outside, path.join(stage, "node_modules", "workspace-link"), "junction");
            fs.symlinkSync(outside, path.join(home, "top-link"), "junction");
            const driver = runDriver(home, "unlink.ps1", [
                `Import-Module ${psQuote(scriptPath("PilotSwarm.WinWorker.psm1"))} -Force`,
                `Remove-LinkSafeItem -Path ${psQuote(stage)}`,
                `Remove-LinkSafeItem -Path ${psQuote(path.join(home, "top-link"))}`,
                `Remove-LinkSafeItem -Path ${psQuote(path.join(home, "absent"))}`,
                "ConvertTo-Json -Compress -InputObject @{ done = $true }",
            ].join("\n"), { shell });
            assert.equal(driver.status, 0, driver.stderr + driver.stdout);
            assert.equal(fs.existsSync(stage), false);
            assert.equal(fs.existsSync(path.join(home, "top-link")), false);
            assert.equal(fs.readFileSync(path.join(outside, "source.js"), "utf8"), "keep");
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
}

// ── The upgrade, the drain and the cleanup ──────────────────────────────

test("the upgrade checks every artifact's hash before it freezes anything", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-boot-");
    try {
        const commit = "d".repeat(40);
        fs.writeFileSync(path.join(home, `worker-release-${commit}.zip`), "zip");
        fs.mkdirSync(path.join(home, "plugins"));
        fs.writeFileSync(path.join(home, "plugins", "p-0123456789ab.zip"), "plugin");
        fs.writeFileSync(path.join(home, "current-release.json"), JSON.stringify({
            schemaVersion: 1, commitSha: commit, zipSha256: sha256("zip"),
            plugins: [{ name: "p", blob: "plugins/p-0123456789ab.zip", sha256: sha256("plugin") }],
        }));
        const dot = `. ${psQuote(scriptPath("Bootstrap-WinWorkerStamp.ps1"))} -ReleaseDir ${psQuote(home)} -StorageAccountName example -Namespace pilotswarm -ControllerCaFile ca.crt -ControllerTokenScope 'api://controller/.default'`;
        const driver = runDriver(home, "boot.ps1", [
            dot,
            "$release = Read-ReleaseManifest",
            `Set-Content -LiteralPath ${psQuote(path.join(home, "plugins", "p-0123456789ab.zip"))} -Value 'tampered' -NoNewline`,
            "try { [void](Read-ReleaseManifest); $tampered = 'accepted' } catch { $tampered = $_.Exception.Message }",
            "ConvertTo-Json -Compress -Depth 4 -InputObject @{ blobs = @($release.Artifacts | ForEach-Object { $_.Blob }); tampered = $tampered }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.deepEqual(driver.json.blobs, [`worker-release-${commit}.zip`, "plugins/p-0123456789ab.zip"]);
        assert.match(driver.json.tampered, /does not match its SHA-256/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// A kubectl for the migration step: it logs each call, and each read of the
// Job answers with the next state of FAKE_KUBECTL_HOME/states.json.
const FAKE_KUBECTL = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.FAKE_KUBECTL_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify(args) + "\n");
const verb = args.find((arg, i) => !arg.startsWith("--") && !["--namespace", "--context"].includes(args[i - 1]));
if (verb === "delete") process.exit(0);
if (verb === "apply") { console.log("configmap/pilotswarm-db-role\njob.batch/pilotswarm-db-role"); process.exit(0); }
if (verb === "get") {
  const file = path.join(home, "states.json");
  const states = JSON.parse(fs.readFileSync(file, "utf8"));
  const state = states.length > 1 ? states.shift() : states[0];
  fs.writeFileSync(file, JSON.stringify(states));
  console.log(JSON.stringify({ kind: "Job", status: state === "Running" ? { active: 1 } : { conditions: [{ type: state, status: "True" }] } }));
  process.exit(0);
}
if (verb === "logs") { console.log("step 2 failed"); process.exit(0); }
console.error("unexpected kubectl call: " + args.join(" "));
process.exit(9);
`;

test("the upgrade's migration step fails as soon as the Job fails, and waits only while it runs", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-migrate-");
    try {
        const bin = path.join(home, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "kubectl.cjs"), FAKE_KUBECTL);
        if (process.platform === "win32") {
            fs.writeFileSync(path.join(bin, "kubectl.cmd"), `@"${process.execPath}" "%~dp0kubectl.cjs" %*\r\n`);
        } else {
            fs.writeFileSync(path.join(bin, "kubectl"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/kubectl.cjs" "$@"\n`, { mode: 0o755 });
        }
        const manifest = path.join(home, "db-role-job.yaml");
        fs.writeFileSync(manifest, "# the Job and its ConfigMap\n");
        const env = { ...process.env, FAKE_KUBECTL_HOME: home };
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
        env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
        const migrate = (states, timeoutMinutes = 30) => {
            fs.writeFileSync(path.join(home, "states.json"), JSON.stringify(states));
            fs.writeFileSync(path.join(home, "calls.jsonl"), "");
            const driver = runDriver(home, "migrate.ps1", [
                `. ${psQuote(scriptPath("Bootstrap-WinWorkerStamp.ps1"))} -ReleaseDir ${psQuote(home)} -StorageAccountName example -Namespace pilotswarm ` +
                    `-ControllerCaFile ca.crt -ControllerTokenScope 'api://controller/.default' -MigrationJobManifest ${psQuote(manifest)} -MigrationTimeoutMinutes ${timeoutMinutes}`,
                "$script:MigrationPollSeconds = 0",
                "try { Invoke-Migrate; $outcome = 'completed' } catch { $outcome = $_.Exception.Message }",
                "ConvertTo-Json -Compress -InputObject @{ outcome = $outcome }",
            ].join("\n"), { env });
            assert.equal(driver.status, 0, driver.stderr + driver.stdout);
            const verbs = fs.readFileSync(path.join(home, "calls.jsonl"), "utf8").split("\n").filter(Boolean)
                .map((line) => JSON.parse(line).find((arg, i, all) => !arg.startsWith("--") && !["--namespace", "--context"].includes(all[i - 1])));
            return { outcome: driver.json.outcome, verbs };
        };

        const failed = migrate(["Running", "Failed"]);
        assert.equal(failed.outcome, "the migration failed; the pool stays frozen. Last log lines: step 2 failed");
        assert.deepEqual(failed.verbs, ["delete", "apply", "get", "get", "logs"]);

        const completed = migrate(["Running", "Running", "Complete"]);
        assert.equal(completed.outcome, "completed");
        assert.deepEqual(completed.verbs, ["delete", "apply", "get", "get", "get"]);

        const timedOut = migrate(["Running"], 0);
        assert.match(timedOut.outcome, /^the migration did not complete within 0 minutes; the pool stays frozen\./);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
test("the drain is a no-op without the service, and the cleanup lists before it removes, never through a link", { skip: noPwsh || noRunCommandShell }, () => {
    const home = tempDir("ps-win-clear-");
    try {
        const drain = runAsRunCommand(home, `& ${psQuote(scriptPath("Drain-And-StopWorker.ps1"))} -ServiceName 'PilotSwarmNoSuchService'`);
        assert.equal(drain.status, 0, drain.stderr);
        assert.match(drain.stdout, /not installed/);

        const root = path.join(home, "root");
        const scratch = path.join(root, "temp");
        fs.mkdirSync(path.join(scratch, "session-folder"), { recursive: true });
        fs.writeFileSync(path.join(scratch, "session-folder", "file.txt"), "x");
        const kept = path.join(home, "kept");
        fs.mkdirSync(kept);
        fs.writeFileSync(path.join(kept, "important.txt"), "keep");
        fs.symlinkSync(kept, path.join(scratch, "link"), "junction");
        const run = (...extra) => spawnSync(pwsh(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath("Clear-StaleWorkspaces.ps1"), "-Root", root, "-ServiceName", "PilotSwarmNoSuchService", ...extra], { encoding: "utf8", windowsHide: true });
        const dry = run();
        assert.equal(dry.status, 0, dry.stderr);
        assert.match(dry.stdout, /Dry run: 2 item/);
        assert.deepEqual(fs.readdirSync(scratch).sort(), ["link", "session-folder"]);
        const applied = run("-Apply");
        assert.equal(applied.status, 0, applied.stderr);
        assert.deepEqual(fs.readdirSync(scratch), []);
        assert.equal(fs.readFileSync(path.join(kept, "important.txt"), "utf8"), "keep");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
