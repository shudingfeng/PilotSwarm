// The PowerShell scripts: every one parses in PowerShell 7 (and in Windows
// PowerShell 5.1 on Windows, which Run Commands and image builds use), and
// the parts that can run against temporary folders and repositories do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildWorkerEnv, CREDENTIAL_ENV_NAMES, decodeUserData, parseEnvFile, USER_DATA_SETTINGS } from "../launcher.mjs";
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
            outside: { ...base, modifyFolders: ["Q:\\elsewhere"] },
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
        fs.writeFileSync(path.join(home, "elsewhere.json"), JSON.stringify({
            ...base, reposRoot: onMissingDrive(base.reposRoot), modifyFolders: base.modifyFolders.map(onMissingDrive),
            folders: base.folders.map((folder) => ({ ...folder, path: onMissingDrive(folder.path) })),
            beforeSnapshot: base.beforeSnapshot.map((step) => ({ ...step, emptyFolder: onMissingDrive(step.emptyFolder) })),
        }));
        const driver = runDriver(home, "manifest.ps1", [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))}`,
            `$example = Test-SeedManifest (Read-JsonFile -Path ${psQuote(path.join(WINDOWS_DIR, "examples", "seed-manifest.json"))})`,
            `$elsewhere = Test-SeedManifest (Read-JsonFile -Path ${psQuote(path.join(home, "elsewhere.json"))})`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(variants).map(psQuote).join(", ")})) { try { [void](Test-SeedManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($name + '.json')))); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 5 -InputObject @{ repos = @($example.Repositories | ForEach-Object { $_.Path }); elsewhere = @($elsewhere.Repositories | ForEach-Object { $_.Path }); modify = $example.ModifyFolders; emptied = @($example.BeforeSnapshot | ForEach-Object { $_.EmptyFolder }); caches = @($example.PackageCaches | ForEach-Object { $_.Name }); refused = $refused }",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.deepEqual(driver.json.repos, ["Q:\\Repos\\PilotSwarm", "Q:\\Repos\\Hello-World"]);
        assert.deepEqual(driver.json.elsewhere, [`${missingDrive}:\\Repos\\PilotSwarm`, `${missingDrive}:\\Repos\\Hello-World`]);
        assert.deepEqual(driver.json.modify, ["Q:\\Repos\\PilotSwarm", "Q:\\Repos\\Hello-World", "Q:\\.cache\\npm", "Q:\\temp"]);
        assert.deepEqual(driver.json.emptied, ["Q:\\temp"]);
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

test("the seed manifest's submodule lists, folders, beforeSnapshot steps and notes are checked", { skip: noPwsh || notWindows }, () => {
    const home = tempDir("ps-win-seedfields-");
    try {
        const repo = (fields = {}) => ({ name: "app", url: "https://example.test/app.git", branch: "main", ...fields });
        const full = {
            schemaVersion: 1,
            notes: "free text",
            repositories: [
                repo({ submodules: [{ path: "libs\\core", branch: "release/2", notes: "its own branch" }, { path: "tools/" }], notes: "two submodules" }),
                { name: "plain", url: "https://example.test/plain.git", branch: "main", submodules: [] },
            ],
            modifyFolders: ["Q:\\Repos\\plain"],
            folders: [
                { path: "Q:\\Repos\\app", access: "modify" },
                { path: "Q:\\.cache\\http", access: "modify", notes: "a package manager's HTTP cache" },
                { path: "Q:\\tools", access: "read" },
            ],
            packageCaches: [{ name: "fill", workingDirectory: "Q:\\Repos\\app", command: ["fill.exe"], notes: "fills the cache" }],
            beforeSnapshot: [{ emptyFolder: "Q:\\.cache\\http\\", reason: "no drive needs the HTTP cache", notes: "kept free text" }],
        };
        const withFolders = (folders) => ({ ...full, folders });
        const withSteps = (beforeSnapshot) => ({ ...full, beforeSnapshot });
        const variants = {
            subPathParent: { ...full, repositories: [repo({ submodules: [{ path: "../other" }] }), full.repositories[1]] },
            subPathRooted: { ...full, repositories: [repo({ submodules: [{ path: "C:\\other" }] }), full.repositories[1]] },
            subPathGit: { ...full, repositories: [repo({ submodules: [{ path: "x/.git" }] }), full.repositories[1]] },
            subPathMissing: { ...full, repositories: [repo({ submodules: [{ branch: "main" }] }), full.repositories[1]] },
            subTwice: { ...full, repositories: [repo({ submodules: [{ path: "lib" }, { path: "LIB/" }] }), full.repositories[1]] },
            subBranch: { ...full, repositories: [repo({ submodules: [{ path: "lib", branch: "../main" }] }), full.repositories[1]] },
            subUnknown: { ...full, repositories: [repo({ submodules: [{ name: "lib" }] }), full.repositories[1]] },
            subNotObject: { ...full, repositories: [repo({ submodules: ["lib"] }), full.repositories[1]] },
            repoNotes: { ...full, repositories: [repo({ notes: 7 }), full.repositories[1]] },
            folderAccess: withFolders([...full.folders, { path: "Q:\\x", access: "write" }]),
            folderNoAccess: withFolders([...full.folders, { path: "Q:\\x" }]),
            folderUnknown: withFolders([...full.folders, { path: "Q:\\x", access: "read", create: true }]),
            folderTwice: withFolders([...full.folders, { path: "Q:\\tools\\", access: "read" }]),
            folderAlsoModify: withFolders([...full.folders, { path: "Q:\\Repos\\plain", access: "modify" }]),
            folderOffDrive: withFolders([...full.folders, { path: "D:\\cache", access: "modify" }]),
            folderRoot: withFolders([...full.folders, { path: "Q:\\Repos", access: "modify" }]),
            readInModify: withFolders([...full.folders, { path: "Q:\\.cache\\http\\v3", access: "read" }]),
            notCovered: withFolders(full.folders.filter((folder) => folder.path !== "Q:\\Repos\\app")),
            stepNoReason: withSteps([{ emptyFolder: "Q:\\.cache\\http" }]),
            stepBlankReason: withSteps([{ emptyFolder: "Q:\\.cache\\http", reason: " " }]),
            stepUnlisted: withSteps([{ emptyFolder: "Q:\\.cache\\other", reason: "x" }]),
            stepRepository: withSteps([{ emptyFolder: "Q:\\Repos\\app", reason: "x" }]),
            stepInsideRepository: { ...withFolders([...full.folders, { path: "Q:\\Repos\\app\\obj", access: "modify" }]), beforeSnapshot: [{ emptyFolder: "Q:\\Repos\\app\\obj", reason: "x" }] },
            stepAroundRepository: { ...withFolders([...full.folders, { path: "Q:\\Repos", access: "read" }]), beforeSnapshot: [{ emptyFolder: "Q:\\Repos", reason: "x" }] },
            stepTwice: withSteps([...full.beforeSnapshot, { emptyFolder: "Q:\\.cache\\http", reason: "again" }]),
            stepUnknown: withSteps([{ emptyFolder: "Q:\\.cache\\http", reason: "x", recursive: true }]),
            cacheNotes: { ...full, packageCaches: [{ ...full.packageCaches[0], notes: ["not text"] }] },
        };
        // The same manifest, but every repository with submodules: true, as an older manifest has it.
        const legacy = { ...full, repositories: full.repositories.map((entry) => ({ ...entry, submodules: true })) };
        for (const [name, value] of Object.entries({ full, legacy, ...variants })) fs.writeFileSync(path.join(home, `${name}.json`), JSON.stringify(value));
        const driver = runDriver(home, "fields.ps1", [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))}`,
            "$describe = { param($m) [ordered]@{",
            "  repos = @($m.Repositories | ForEach-Object { [ordered]@{ name = $_.Name; all = $_.Submodules; listed = @($_.SubmoduleList | ForEach-Object { [ordered]@{ path = $_.Path; branch = $_.Branch; folder = $_.Folder } }) } })",
            "  modify = @($m.ModifyFolders); read = @($m.ReadFolders); caches = @($m.PackageCaches | ForEach-Object { $_.Name })",
            "  beforeSnapshot = @($m.BeforeSnapshot | ForEach-Object { [ordered]@{ emptyFolder = $_.EmptyFolder; reason = $_.Reason } }) } }",
            `$full = & $describe (Test-SeedManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} 'full.json')))`,
            `$legacy = & $describe (Test-SeedManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} 'legacy.json')))`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(variants).map(psQuote).join(", ")})) { try { [void](Test-SeedManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($name + '.json')))); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 8 -InputObject ([ordered]@{ full = $full; legacy = $legacy; refused = $refused })",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.deepEqual(driver.json.full.repos, [
            { name: "app", all: false, listed: [
                { path: "libs/core", branch: "release/2", folder: "Q:\\Repos\\app\\libs\\core" },
                { path: "tools", branch: null, folder: "Q:\\Repos\\app\\tools" },
            ] },
            { name: "plain", all: false, listed: [] },
        ]);
        assert.deepEqual(driver.json.full.modify, ["Q:\\Repos\\plain", "Q:\\Repos\\app", "Q:\\.cache\\http"]);
        assert.deepEqual(driver.json.full.read, ["Q:\\tools"]);
        assert.deepEqual(driver.json.full.caches, ["fill"]);
        assert.deepEqual(driver.json.full.beforeSnapshot, [{ emptyFolder: "Q:\\.cache\\http", reason: "no drive needs the HTTP cache" }]);
        assert.deepEqual(driver.json.legacy.repos.map((entry) => [entry.name, entry.all, entry.listed.length]), [["app", true, 0], ["plain", true, 0]]);
        const refused = driver.json.refused;
        for (const name of ["subPathParent", "subPathRooted", "subPathGit", "subPathMissing"]) assert.match(refused[name], /a submodule needs its relative path inside the repository/, name);
        assert.match(refused.subTwice, /the submodule LIB is listed twice/);
        assert.match(refused.subBranch, /the submodule lib needs a branch name/);
        assert.match(refused.subUnknown, /a submodule has an unknown field name/);
        assert.match(refused.subNotObject, /each submodules entry is an object with a path/);
        assert.match(refused.repoNotes, /repository app: notes must be a string/);
        assert.match(refused.folderAccess, /folder Q:\\x: access is "modify" or "read"/);
        assert.match(refused.folderNoAccess, /access is "modify" or "read"/);
        assert.match(refused.folderUnknown, /a folder has an unknown field create/);
        assert.match(refused.folderTwice, /is listed twice/);
        assert.match(refused.folderAlsoModify, /is listed twice/);
        assert.match(refused.folderOffDrive, /must be a folder on the drive of reposRoot/);
        assert.match(refused.folderRoot, /reposRoot itself stays read-only/);
        assert.match(refused.readInModify, /the read folder Q:\\\.cache\\http\\v3 is inside a modify folder/);
        assert.match(refused.notCovered, /no modify folder covers Q:\\Repos\\app/);
        assert.match(refused.stepNoReason, /needs a reason/);
        assert.match(refused.stepBlankReason, /needs a reason/);
        assert.match(refused.stepUnlisted, /empties only folders the manifest lists/);
        assert.match(refused.stepRepository, /would delete files of the repository app/);
        assert.match(refused.stepInsideRepository, /would delete files of the repository app/);
        assert.match(refused.stepAroundRepository, /would delete files of the repository app/);
        assert.match(refused.stepTwice, /empties Q:\\\.cache\\http twice/);
        assert.match(refused.stepUnknown, /a beforeSnapshot step has an unknown field recursive/);
        assert.match(refused.cacheNotes, /package cache fill: notes must be a string/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

/**
 * A repository with two submodules, lib and other, and a docs folder. After
 * the repository pinned lib, lib got a release branch the repository does not
 * pin.
 */
function repoWithTwoSubmodules(home) {
    const env = gitTestEnv(home);
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const remote = (name, file) => {
        const bare = path.join(home, `${name}.git`);
        const work = path.join(home, `${name}-work`);
        git(home, "init", "-q", "--bare", bare);
        git(home, "init", "-q", "-b", "main", work);
        fs.writeFileSync(path.join(work, file), `${name} one\n`);
        git(work, "add", "-A");
        git(work, "commit", "-q", "-m", `${name} one`);
        git(work, "push", "-q", bare, "main");
        return { bare, work };
    };
    const lib = remote("lib", "lib.txt");
    const other = remote("other", "other.txt");
    const app = remote("app", "a.txt");
    git(app.work, "submodule", "add", "-q", lib.bare, "lib");
    git(app.work, "submodule", "add", "-q", other.bare, "other");
    fs.mkdirSync(path.join(app.work, "docs"));
    fs.writeFileSync(path.join(app.work, "docs", "readme.txt"), "docs\n");
    git(app.work, "add", "-A");
    git(app.work, "commit", "-q", "-m", "two submodules and docs");
    git(app.work, "push", "-q", app.bare, "main");
    const pinned = git(lib.work, "rev-parse", "HEAD");
    const release = () => {
        fs.appendFileSync(path.join(lib.work, "lib.txt"), "more\n");
        git(lib.work, "commit", "-q", "-am", "lib on release");
        git(lib.work, "push", "-q", lib.bare, "HEAD:release");
        return git(lib.work, "rev-parse", "HEAD");
    };
    return { env, git, app, pinned, release };
}

// A package cache command: it fills an HTTP cache and records the Git settings it was given.
const FILL_CACHE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = process.env.FILL_TARGET;
fs.mkdirSync(path.join(target, "v3"), { recursive: true });
fs.writeFileSync(path.join(target, "v3", "index.json"), "{}");
fs.writeFileSync(path.join(target, "..", "fill.json"), JSON.stringify({ prompt: process.env.GIT_TERMINAL_PROMPT ?? null, gcm: process.env.GCM_INTERACTIVE ?? null }));
`;

test("the seed checks out only the listed submodules, at their own branch, empties the beforeSnapshot folders, and -Verify checks both", { skip: noRunCommandShell }, () => {
    const home = tempDir("ps-win-seedlist-");
    try {
        const { env, git, app, pinned, release } = repoWithTwoSubmodules(home);
        // Without prompts of its own, so the package cache command shows what the seed gives it.
        const seedEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE)$/i.test(name)));
        let tip = release();
        assert.notEqual(tip, pinned);
        const drive = path.join(home, "Drive");
        const reposRoot = path.join(drive, "Repos");
        const clone = path.join(reposRoot, "app");
        const http = path.join(drive, "cache", "http");
        const tools = path.join(drive, "tools");
        const fill = path.join(home, "fill.cjs");
        fs.writeFileSync(fill, FILL_CACHE);
        const manifest = (submodules) => ({
            schemaVersion: 1,
            reposRoot,
            repositories: [{ name: "app", url: `file:///${app.bare.replace(/\\/g, "/")}`, branch: "main", submodules, notes: "only lib" }],
            folders: [{ path: clone, access: "modify" }, { path: http, access: "modify" }, { path: tools, access: "read" }],
            packageCaches: [{ name: "fill", workingDirectory: clone, command: [process.execPath, fill], env: { FILL_TARGET: http } }],
            beforeSnapshot: [{ emptyFolder: http, reason: "an HTTP cache no drive needs" }],
        });
        const manifestPath = path.join(home, "seed-manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(manifest([{ path: "lib", branch: "release" }])));
        fs.writeFileSync(path.join(home, "docs-manifest.json"), JSON.stringify(manifest([{ path: "docs", branch: "release" }])));
        // The seed's steps in the Windows PowerShell 5.1 of the refresh's Run Command. A test cannot install the worker's
        // service, so LOCAL SERVICE, which icacls can name, stands in for its account, and the owners stay as they are.
        const seed = (mode, lines) => runDriver(home, `${mode}.ps1`, [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))} -WorkerEnvFile ${psQuote(path.join(home, "none.env"))}`,
            "function Assert-WorkerServiceSid { 'S-1-5-19' }",
            "function Get-WorkerServiceSid { 'S-1-5-19' }",
            "function Set-RepositoryOwners { param([string]$Path) }",
            `$manifest = Test-SeedManifest (Read-JsonFile -Path ${psQuote(manifestPath)})`,
            "Initialize-GitEnvironment $manifest",
            ...lines,
            "$checks = Test-SeedDrive -Manifest $manifest",
            "Remove-Item -LiteralPath $script:EmptyHooks -Recurse -Force",
            "ConvertTo-Json -Compress -Depth 5 -InputObject $checks",
        ].join("\n"), { env: seedEnv, shell: windowsPowerShell() });
        const run = (mode) => seed(mode, [`Invoke-SeedDrive -Manifest $manifest -ManifestSha256 (Get-Sha256Hex ${psQuote(manifestPath)}) -Mode '${mode}'`]);
        const libDir = path.join(clone, "lib");
        const passing = (checks) => {
            for (const name of ["refs", "fsck", "hooks", "cleanRecord", "emptied"]) assert.deepEqual(checks[name], [], `${name}: ${JSON.stringify(checks[name])}`);
            assert.ok(checks.owner.length > 0, "the owners stayed the test's");
            // Only the roots fail outside a real drive: the folders have their grants, and the read folder is read-only.
            const roots = [`${path.parse(reposRoot).root}: `, `${reposRoot}: `];
            assert.ok(checks.acl.length > 0 && checks.acl.every((line) => roots.some((root) => line.startsWith(root))), JSON.stringify(checks.acl));
        };

        const seeded = run("seed");
        assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
        passing(seeded.json);
        assert.equal(git(libDir, "symbolic-ref", "--short", "HEAD"), "release");
        assert.equal(git(libDir, "rev-parse", "HEAD"), tip, "lib is at its own branch, not at the commit app pins");
        assert.equal(fs.existsSync(path.join(clone, "other", ".git")), false, "an unlisted submodule is not checked out");
        assert.deepEqual(fs.readdirSync(http), [], "the HTTP cache was emptied, its folder kept");
        assert.ok(fs.statSync(tools).isDirectory(), "the read folder exists");
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(drive, "cache", "fill.json"), "utf8")), { prompt: "0", gcm: "never" });
        const state = JSON.parse(fs.readFileSync(path.join(drive, ".pilotswarm", "seed-state.json"), "utf8"));
        assert.equal(state.remoteRefs["app/lib"]["refs/remotes/origin/release"], tip);

        // The refresh moves lib to the new tip of its branch and empties the cache again.
        tip = release();
        const refreshed = run("refresh");
        assert.equal(refreshed.status, 0, refreshed.stderr + refreshed.stdout);
        passing(refreshed.json);
        assert.equal(git(libDir, "rev-parse", "HEAD"), tip);
        assert.deepEqual(fs.readdirSync(http), []);

        // -Verify sees a file left in the cache and lib moved off the fetched commit.
        fs.writeFileSync(path.join(http, "left.bin"), "x");
        git(libDir, "reset", "-q", "--hard", "HEAD~1");
        const drifted = seed("verify", []);
        assert.equal(drifted.status, 0, drifted.stderr + drifted.stdout);
        assert.deepEqual(drifted.json.emptied, [`${http}: not empty`]);
        assert.deepEqual(drifted.json.refs, ["app/lib: release is not at the fetched commit"]);

        // A listed folder that is not a submodule is refused before any Git command runs in it.
        const notSubmodule = runDriver(home, "docs.ps1", [
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))} -WorkerEnvFile ${psQuote(path.join(home, "none.env"))}`,
            `$manifest = Test-SeedManifest (Read-JsonFile -Path ${psQuote(path.join(home, "docs-manifest.json"))})`,
            "Initialize-GitEnvironment $manifest",
            "try { Update-SeedRepository -Repository $manifest.Repositories[0] -ReposRoot $manifest.ReposRoot; $answer = 'accepted' } catch { $answer = $_.Exception.Message }",
            "Remove-Item -LiteralPath $script:EmptyHooks -Recurse -Force",
            "ConvertTo-Json -Compress -InputObject @{ answer = $answer }",
        ].join("\n"), { env: seedEnv, shell: windowsPowerShell() });
        assert.equal(notSubmodule.status, 0, notSubmodule.stderr + notSubmodule.stdout);
        assert.equal(notSubmodule.json.answer, "docs is not a submodule of app");
        assert.equal(git(clone, "symbolic-ref", "--short", "HEAD"), "main", "app stays on its branch");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("the drive's root gives access only to SYSTEM, Administrators and the worker, a mount leaves a right list alone, and -Verify checks it", { skip: noRunCommandShell }, () => {
    const home = tempDir("ps-win-rootacl-");
    const root = path.join(home, "Q");
    try {
        fs.mkdirSync(path.join(root, "Repos"), { recursive: true });
        // What a new volume and the earlier treatment leave: Everyone, Users and Authenticated Users read the drive.
        execFileSync("icacls", [root, "/grant", "*S-1-1-0:(OI)(CI)(RX)", "*S-1-5-32-545:(OI)(CI)(RX)", "*S-1-5-11:(OI)(CI)(RX)"], { windowsHide: true });
        execFileSync("icacls", [path.join(root, "Repos"), "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"], { windowsHide: true });
        // The test's own account stands in for the worker's, so it can still read what it locked.
        const driver = runDriver(home, "root-acl.ps1", [
            `. ${psQuote(scriptPath("Initialize-WinWorkerDisk.ps1"))}`,
            `. ${psQuote(scriptPath("Seed-WorkerReposDisk.ps1"))}`,
            "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
            "function Get-WorkerServiceSid { $script:me }",
            "$script:calls = 0",
            "function Invoke-Icacls { param([string]$Path, [string[]]$Arguments) $script:calls++; PilotSwarm.WinWorker\\Invoke-Icacls -Path $Path -Arguments $Arguments }",
            `$root = ${psQuote(root)}`,
            "$before = @(Get-RootAclFailures -Path $root)",
            "Set-DevDriveRootAcl -Root $root",
            "$first = $script:calls",
            "Set-DevDriveRootAcl -Root $root",
            "$rules = @((Get-Acl -LiteralPath $root).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + ' ' + $_.AccessControlType + ' ' + $_.IsInherited + ' ' + $_.InheritanceFlags })",
            "$reposAcl = Get-Acl -LiteralPath (Join-Path $root 'Repos')",
            "ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ me = $me; before = $before; first = $first; second = $script:calls - $first; locked = Test-DevDriveRootAcl -Path $root; rules = $rules",
            "  reposExplicit = @($reposAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])).Count; reposProtected = $reposAcl.AreAccessRulesProtected",
            "  after = @(Get-RootAclFailures -Path $root); reposAfter = @(Get-RootAclFailures -Path (Join-Path $root 'Repos')) })",
        ].join("\n"), { shell: windowsPowerShell() });
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        const result = driver.json;
        for (const sid of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) assert.ok(result.before.includes(`${root}: ${sid} has access`), `${sid}: ${JSON.stringify(result.before)}`);
        assert.ok(result.before.includes(`${root}: the worker may write`), "the stand-in's inherited Full Control");
        assert.ok(result.first > 0);
        assert.equal(result.second, 0, "a mount does not rewrite a right list, which would walk the whole drive");
        assert.equal(result.locked, true);
        const flags = "ContainerInherit, ObjectInherit";
        assert.deepEqual([...result.rules].sort(), [`S-1-5-18 Allow False ${flags}`, `S-1-5-32-544 Allow False ${flags}`, `${result.me} Allow False ${flags}`].sort());
        assert.equal(result.reposExplicit, 0, "the repositories' root keeps only what it inherits");
        assert.equal(result.reposProtected, false);
        assert.deepEqual(result.after, []);
        assert.deepEqual(result.reposAfter, []);
    } finally {
        // The test's account owns the folder, so it may give itself access again before the folder goes.
        spawnSync("icacls", [root, "/reset", "/T", "/C", "/Q"], { windowsHide: true });
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

test("the toolchain manifest's steps and workerAccount are checked", { skip: noPwsh }, () => {
    const home = tempDir("ps-win-steps-");
    try {
        const sha = (character, length = 64) => character.repeat(length);
        const steps = [
            { step: "installer", name: "git", url: "https://example.test/git.exe", sha256: sha("a"), type: "exe", arguments: ["/VERYSILENT"], notes: "Git for Windows" },
            { step: "windowsFeatures", name: "features", features: ["Containers", "Hyper-V"], includeManagementTools: true },
            { step: "restart", name: "after-features", reason: "Hyper-V needs it" },
            { step: "visualStudio", name: "vs", bootstrapper: { url: "https://download.example.test/vs_enterprise.exe", sha256: sha("b") }, vsconfig: "{manifestDir}\\.vsconfig", version: "17.14.7" },
            { step: "visualStudio", name: "vs-layout", layout: { path: "\\\\share\\layouts\\vs", bootstrapper: "vs_enterprise.exe", sha256: sha("c") }, vsconfig: "C:\\cfg\\x.vsconfig", version: "17.14.36301.6", successExitCodes: [0, 3010] },
            { step: "extendPartition", name: "os-disk", driveLetter: "C" },
            { step: "package", name: "pack", url: "https://example.test/pack.nupkg", sha512: sha("d", 128), format: "nupkg", destination: "C:\\Program Files\\dotnet\\packs\\Pack\\1.0.0" },
            { step: "package", name: "zip", url: "https://example.test/tool.zip", sha256: sha("e"), format: "zip", destination: "C:\\tools\\zip" },
            { step: "dockerService", name: "docker", dockerd: "C:\\Program Files\\docker\\dockerd.exe", pipeGroup: "docker-users", dataRoot: "D:\\docker" },
            { step: "command", name: "lfs", command: ["git.exe", "lfs", "install", "--system"], successExitCodes: [0] },
        ];
        const full = { schemaVersion: 1, steps, mcpServers: [{ name: "fs", package: "p", version: "1.0.0" }], workerAccount: { userRights: ["SeCreateSymbolicLinkPrivilege"], groups: ["docker-users"], notes: "for symbolic links and the engine's pipe" } };
        const replace = (name, change) => ({ ...full, steps: steps.map((step) => (step.name === name ? change(step) : step)) });
        const withoutField = (name, field) => replace(name, (step) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== field)));
        const account = (workerAccount) => ({ ...full, workerAccount });
        const bad = {
            mixed: { ...full, installers: [] },
            empty: { ...full, steps: [] },
            noKind: replace("git", ({ step, ...rest }) => rest),
            unknownKind: replace("git", (step) => ({ ...step, step: "reboot" })),
            noName: replace("lfs", ({ name, ...rest }) => rest),
            nameTwice: { ...full, mcpServers: [{ name: "GIT", package: "p", version: "1.0.0" }] },
            unknownField: replace("os-disk", (step) => ({ ...step, size: 1 })),
            otherKindsField: replace("os-disk", (step) => ({ ...step, features: ["x"] })),
            notesNotText: replace("git", (step) => ({ ...step, notes: 1 })),
            codesNotNumbers: replace("lfs", (step) => ({ ...step, successExitCodes: ["0"] })),
            installerHash: replace("git", (step) => ({ ...step, sha256: sha("A") })),
            featuresEmpty: replace("features", (step) => ({ ...step, features: [] })),
            featureName: replace("features", (step) => ({ ...step, features: ["Hyper V"] })),
            restartReason: replace("after-features", (step) => ({ ...step, reason: 3 })),
            vsBoth: replace("vs", (step) => ({ ...step, layout: steps[4].layout })),
            vsNeither: withoutField("vs", "bootstrapper"),
            vsEvergreen: replace("vs", (step) => ({ ...step, bootstrapper: { url: "https://aka.ms/vs/17/release/vs_enterprise.exe", sha256: sha("b") } })),
            vsNoHash: replace("vs", (step) => ({ ...step, bootstrapper: { url: step.bootstrapper.url } })),
            vsBootstrapperField: replace("vs", (step) => ({ ...step, bootstrapper: { ...step.bootstrapper, channel: "release" } })),
            vsNoConfig: withoutField("vs", "vsconfig"),
            vsVersion: replace("vs", (step) => ({ ...step, version: "17" })),
            vsLayoutPath: replace("vs-layout", (step) => ({ ...step, layout: { ...step.layout, path: "layouts\\vs" } })),
            partitionLetter: replace("os-disk", (step) => ({ ...step, driveLetter: "C:" })),
            packageTwoHashes: replace("pack", (step) => ({ ...step, sha256: sha("a") })),
            packageNoHash: withoutField("pack", "sha512"),
            packageUpperHash: replace("pack", (step) => ({ ...step, sha512: sha("D", 128) })),
            packageFormat: replace("pack", (step) => ({ ...step, format: "msi" })),
            packageRoot: replace("pack", (step) => ({ ...step, destination: "C:\\" })),
            packageHttp: replace("pack", (step) => ({ ...step, url: "http://example.test/pack.nupkg" })),
            dockerPath: replace("docker", (step) => ({ ...step, dockerd: "dockerd.exe" })),
            dockerGroup: replace("docker", ({ pipeGroup, ...rest }) => rest),
            accountField: account({ userRights: [], admin: true }),
            accountRight: account({ userRights: ["CreateSymbolicLinks"] }),
            accountStrongRight: account({ userRights: ["SeDebugPrivilege"] }),
            accountRightTwice: account({ userRights: ["SeCreateSymbolicLinkPrivilege", "SeCreateSymbolicLinkPrivilege"] }),
            accountGroup: account({ groups: ["docker\\users"] }),
        };
        // An older manifest, with installers and commands, may now carry notes on each.
        const legacy = { schemaVersion: 1, installers: [{ ...steps[0], step: undefined, notes: "kept" }], commands: [{ name: "lfs", command: ["git.exe"] }] };
        for (const [name, value] of Object.entries({ full, legacy, ...bad })) fs.writeFileSync(path.join(home, `${name}.json`), JSON.stringify(value));
        const driver = runDriver(home, "steps.ps1", [
            `. ${psQuote(scriptPath("Build-WorkerOsImage.ps1"))}`,
            `$full = Test-ToolchainManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} 'full.json'))`,
            `$legacy = Test-ToolchainManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} 'legacy.json'))`,
            `$example = Test-ToolchainManifest (Read-JsonFile -Path ${psQuote(path.join(WINDOWS_DIR, "examples", "toolchain-manifest.steps.json"))})`,
            "$refused = [ordered]@{}",
            `foreach ($name in @(${Object.keys(bad).map(psQuote).join(", ")})) { try { [void](Test-ToolchainManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($name + '.json')))); $refused[$name] = 'accepted' } catch { $refused[$name] = $_.Exception.Message } }`,
            "ConvertTo-Json -Compress -Depth 5 -InputObject ([ordered]@{ steps = @($full.steps | ForEach-Object { $_.name }); legacy = @($legacy.installers | ForEach-Object { $_.name }); example = @($example.steps | ForEach-Object { $_.step }); exampleVsconfig = @($example.steps | Where-Object { $_.step -eq 'visualStudio' } | ForEach-Object { $_.vsconfig }); refused = $refused })",
        ].join("\n"));
        assert.equal(driver.status, 0, driver.stderr + driver.stdout);
        assert.deepEqual(driver.json.steps, steps.map((step) => step.name));
        assert.deepEqual(driver.json.legacy, ["git"]);
        // The example in steps is valid, and the .vsconfig it names ships next to it.
        assert.deepEqual(driver.json.example, ["installer", "command", "windowsFeatures", "restart", "visualStudio", "package", "extendPartition"]);
        for (const vsconfig of driver.json.exampleVsconfig) {
            // The example names a Windows path, whose backslash Linux would read as part of the file's name.
            const file = vsconfig.replace("{manifestDir}", path.join(WINDOWS_DIR, "examples")).replace(/[\\/]/g, path.sep);
            assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")).components), file);
        }
        const expected = {
            mixed: /steps replaces installers and commands/,
            empty: /steps lists no step/,
            noKind: /every step names its kind in step: installer, command, windowsFeatures, restart, visualStudio, extendPartition, package, dockerService/,
            unknownKind: /every step names its kind/,
            noName: /every command step needs a name/,
            nameTwice: /the name GIT is used twice/,
            unknownField: /extendPartition step os-disk has an unknown field size/,
            otherKindsField: /has an unknown field features/,
            notesNotText: /installer step git: notes must be a string/,
            codesNotNumbers: /command step lfs successExitCodes must be a list of integers/,
            installerHash: /installer step git needs a lowercase sha256/,
            featuresEmpty: /windowsFeatures step features needs a list of feature names/,
            featureName: /needs a list of feature names/,
            restartReason: /reason must be a string/,
            vsBoth: /needs either a bootstrapper or a layout/,
            vsNeither: /needs either a bootstrapper or a layout/,
            vsEvergreen: /aka\.ms links to whatever version is current/,
            vsNoHash: /needs the bootstrapper's lowercase sha256/,
            vsBootstrapperField: /bootstrapper is \{ url, sha256 \}/,
            vsNoConfig: /needs the path of its \.vsconfig/,
            vsVersion: /needs the exact version it installs/,
            vsLayoutPath: /needs the layout's absolute path/,
            partitionLetter: /needs a driveLetter/,
            packageTwoHashes: /needs either a sha512 or a sha256/,
            packageNoHash: /needs either a sha512 or a sha256/,
            packageUpperHash: /needs a lowercase sha512/,
            packageFormat: /needs a format: nupkg or zip/,
            packageRoot: /needs an absolute destination folder below a drive's root/,
            packageHttp: /needs an https:\/\/ url/,
            dockerPath: /needs the absolute path of dockerd\.exe/,
            dockerGroup: /needs the name of the local group/,
            accountField: /workerAccount has an unknown field admin/,
            accountRight: /holds user right names/,
            accountStrongRight: /may not grant SeDebugPrivilege, which would make the worker as strong as an administrator/,
            accountRightTwice: /lists SeCreateSymbolicLinkPrivilege twice/,
            accountGroup: /holds local group names/,
        };
        assert.deepEqual(Object.keys(driver.json.refused), Object.keys(expected));
        for (const [name, pattern] of Object.entries(expected)) assert.match(driver.json.refused[name], pattern, name);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// A toolchain command for the restart test: it appends its first argument to a log and exits with its second.
const STEP_COMMAND = String.raw`
require("node:fs").appendFileSync(process.env.STEP_LOG, process.argv[2] + "\n");
process.exit(Number(process.argv[3] || 0));
`;

for (const [label, shell, skip] of [["PowerShell 7", pwsh(), noPwsh], ["Windows PowerShell 5.1", windowsPowerShell(), noRunCommandShell]]) {
    test(`a build with steps stops for each restart, carries on once the VM has restarted, and runs a step again only when it changed, in ${label}`, { skip }, () => {
        const home = tempDir("ps-win-restart-");
        try {
            const script = path.join(home, "step.cjs");
            fs.writeFileSync(script, STEP_COMMAND);
            const log = path.join(home, "steps.log");
            fs.writeFileSync(log, "");
            const command = (name, ...args) => ({ step: "command", name, command: [process.execPath, script, ...args], successExitCodes: [0, 3010] });
            const manifest = (second) => ({
                schemaVersion: 1,
                steps: [
                    command("first", "first"),
                    { step: "windowsFeatures", name: "features", features: ["Containers", "Hyper-V"], includeManagementTools: true },
                    { step: "restart", name: "after-features", reason: "the features need it" },
                    second,
                ],
                mcpServers: [{ name: "fs", package: "example-mcp", version: "1.0.0" }],
            });
            fs.writeFileSync(path.join(home, "manifest.json"), JSON.stringify(manifest(command("second", "second", "3010"))));
            fs.writeFileSync(path.join(home, "changed.json"), JSON.stringify(manifest(command("second", "second again", "3010"))));
            // Each run reads the state the one before saved; Get-LastBootTime stands in for the VM's restarts.
            const runs = [["A", "manifest"], ["A", "manifest"], ["B", "manifest"], ["B", "manifest"], ["C", "manifest"], ["C", "changed"], ["D", "changed"]];
            const driver = runDriver(home, "restart.ps1", [
                `. ${psQuote(scriptPath("Build-WorkerOsImage.ps1"))} -Root ${psQuote(path.join(home, "root"))}`,
                // The image's node.exe is on C:, a drive Linux doesn't have: npm's path, which the stand-in below catches, comes from this node.
                `$script:NodeExe = ${psQuote(process.execPath)}`,
                "$script:boot = ''",
                "function Get-LastBootTime { $script:boot }",
                "function Test-PendingRestart { $false }",
                `function Install-WindowsFeature { param([string[]]$Name, [switch]$IncludeManagementTools) [System.IO.File]::AppendAllText(${psQuote(log)}, ('features ' + ($Name -join ',') + ' ' + [bool]$IncludeManagementTools + [char]10)); [pscustomobject]@{ Success = $true; RestartNeeded = 'Yes' } }`,
                // npm installs the MCP server only in the log; every other program runs.
                `function Invoke-NativeCommand { [CmdletBinding()] param([string]$FilePath, [string[]]$ArgumentList = @(), [string]$WorkingDirectory, [hashtable]$Environment, [int]$TimeoutSeconds = 7200, [int[]]$SuccessExitCode = @(0), [switch]$NoThrow) if ($FilePath -match 'npm\\.cmd$') { [System.IO.File]::AppendAllText(${psQuote(log)}, ('npm ' + $ArgumentList[-1] + [char]10)); return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }`,
                // Outside Windows an exit status keeps only its low 8 bits, so a step's 3010 arrives as 194: report it as Windows does.
                "    if (-not (Test-WindowsHost) -and $ArgumentList.Count -gt 0 -and $ArgumentList[-1] -eq '3010') { $PSBoundParameters['SuccessExitCode'] = @($SuccessExitCode) + 194; $result = PilotSwarm.WinWorker\\Invoke-NativeCommand @PSBoundParameters; if ($result.ExitCode -eq 194) { $result.ExitCode = 3010 }; return $result }",
                "    PilotSwarm.WinWorker\\Invoke-NativeCommand @PSBoundParameters }",
                "$results = @()",
                `foreach ($run in @(${runs.map(([boot, file]) => `@('${boot}', '${file}')`).join(", ")})) {`,
                "    $script:boot = $run[0]",
                `    $manifest = Test-ToolchainManifest (Read-JsonFile -Path (Join-Path ${psQuote(home)} ($run[1] + '.json')))`,
                `    $outcome = Install-Toolchain -Manifest $manifest -ManifestDir ${psQuote(home)} -State (Read-BuildState)`,
                "    $steps = @()",
                "    if (-not $outcome.Stop -and $outcome.Record.Contains('steps')) { $steps = @($outcome.Record.steps | ForEach-Object { $_.name + ':' + $_.step }) }",
                `    $results += ,([ordered]@{ stop = $outcome.Stop; log = [System.IO.File]::ReadAllText(${psQuote(log)}); steps = $steps })`,
                "}",
                "ConvertTo-Json -Compress -Depth 6 -InputObject @{ runs = $results; state = Test-Path -LiteralPath (Get-BuildStatePath) }",
            ].join("\n"), { shell, env: { ...process.env, STEP_LOG: log } });
            assert.equal(driver.status, 0, driver.stderr + driver.stdout);
            const [first, notRestarted, afterRestart, notRestartedAgain, done, changed, doneAgain] = driver.json.runs;
            const ranFirst = "first\nfeatures Containers,Hyper-V True\n";
            assert.deepEqual(first, { stop: "the after-features step restarts the VM: the features need it", log: ranFirst, steps: [] });
            assert.deepEqual(notRestarted, { stop: "the VM has not restarted yet. the after-features step restarts the VM: the features need it", log: ranFirst, steps: [] });
            const beforeServices = "a step asked for a restart, which the VM needs before its services and Sysprep";
            const ranSecond = `${ranFirst}second\nnpm example-mcp@1.0.0\n`;
            assert.deepEqual(afterRestart, { stop: beforeServices, log: ranSecond, steps: [] }, "the second step's exit code 3010 asks for a restart before the services");
            assert.deepEqual(notRestartedAgain, { stop: `the VM has not restarted yet. ${beforeServices}`, log: ranSecond, steps: [] });
            assert.deepEqual(done, { stop: null, log: ranSecond, steps: ["first:command", "features:windowsFeatures", "after-features:restart", "second:command"] });
            assert.deepEqual(changed, { stop: beforeServices, log: `${ranSecond}second again\n`, steps: [] }, "only the changed step runs again, and asks for its restart");
            assert.equal(doneAgain.stop, null);
            assert.equal(doneAgain.log, `${ranSecond}second again\n`, "the MCP server was installed once");
            assert.equal(driver.json.state, true, "the state stays until the whole build has finished");
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
}

// A program that records its arguments and exits with 3010, as a Visual Studio bootstrapper asking for a restart does.
const FAKE_VS_BOOTSTRAPPER = "@echo %*> \"%~dp0args.txt\"\r\n@exit /b 3010\r\n";
/** An argument as a Windows command line quotes it. */
const quoteArgument = (value) => (/[\s"]/.test(value) ? `"${value}"` : value);

for (const [label, shell, skip] of [["PowerShell 7", pwsh(), noPwsh || notWindows], ["Windows PowerShell 5.1", windowsPowerShell(), noRunCommandShell]]) {
    test(`the image's package, Visual Studio, partition, docker and worker account steps, with Windows' own tools faked, in ${label}`, { skip }, () => {
        const home = tempDir("ps-win-step-kinds-");
        try {
            const layout = path.join(home, "layout");
            fs.mkdirSync(layout);
            fs.writeFileSync(path.join(layout, "vs_fake.cmd"), FAKE_VS_BOOTSTRAPPER);
            fs.writeFileSync(path.join(home, "x.vsconfig"), JSON.stringify({ version: "1.0", components: ["Microsoft.VisualStudio.Workload.ManagedDesktop"] }));
            fs.writeFileSync(path.join(home, "instances.json"), JSON.stringify([{ installationVersion: "18.12.12405.243", catalog: { productDisplayVersion: "18.12.0" } }]));
            fs.writeFileSync(path.join(home, "vswhere.cmd"), `@type "${path.join(home, "instances.json")}"\r\n`);
            fs.writeFileSync(path.join(home, "dockerd.exe"), "");
            const exported = "[Unicode]\r\nUnicode=yes\r\n[Privilege Rights]\r\nSeCreateSymbolicLinkPrivilege = *S-1-5-32-544\r\nSeServiceLogonRight = *S-1-5-80-0\r\n";
            const driver = runDriver(home, "kinds.ps1", [
                `. ${psQuote(scriptPath("Build-WorkerOsImage.ps1"))} -Root ${psQuote(path.join(home, "root"))}`,
                `$home2 = ${psQuote(home)}`,
                "$out = [ordered]@{}",
                "Add-Type -AssemblyName System.IO.Compression.FileSystem",
                "function New-TestZip([string]$Path, [string[]]$Names) { $zip = [System.IO.Compression.ZipFile]::Open($Path, 'Create'); foreach ($n in $Names) { $w = New-Object System.IO.StreamWriter(($zip.CreateEntry($n)).Open()); $w.Write($n); $w.Dispose() }; $zip.Dispose() }",
                "$list = { param($Folder) @(Get-ChildItem -LiteralPath $Folder -Recurse -File | ForEach-Object { $_.FullName.Substring($Folder.Length + 1).Replace('\\', '/') } | Sort-Object) }",
                // Packages: a NuGet package loses its packaging parts and gets its names unescaped; a zip keeps both; no entry leaves the folder.
                "$names = @('[Content_Types].xml', '_rels/.rels', 'package/services/metadata/core-properties/1.psmdcp', 'data/FrameworkList.xml', 'ref/net8.0/A%20B.dll', 'Pack.nuspec')",
                "New-TestZip (Join-Path $home2 'p.nupkg') $names",
                "Expand-PackageArchive -Path (Join-Path $home2 'p.nupkg') -Destination (Join-Path $home2 'nupkg') -Format nupkg",
                "$out.nupkg = & $list (Join-Path $home2 'nupkg')",
                "Expand-PackageArchive -Path (Join-Path $home2 'p.nupkg') -Destination (Join-Path $home2 'zip') -Format zip",
                "$out.zip = & $list (Join-Path $home2 'zip')",
                "New-TestZip (Join-Path $home2 'evil.zip') @('ok.txt', '../evil.txt')",
                "try { Expand-PackageArchive -Path (Join-Path $home2 'evil.zip') -Destination (Join-Path $home2 'evil') -Format zip; $out.evil = 'accepted' } catch { $out.evil = $_.Exception.Message }",
                "$out.escaped = Test-Path -LiteralPath (Join-Path $home2 'evil.txt')",
                // File hashes: SHA-512 as well as SHA-256, exactly one of them; a mismatch deletes the file.
                "$file = Join-Path $home2 'hashed.bin'",
                "[System.IO.File]::WriteAllText($file, 'payload')",
                "Assert-FileHash -Path $file -Sha512 (Get-Sha512Hex $file) -Source 'test'",
                "try { Assert-FileHash -Path $file -Sha256 (Get-Sha256Hex $file) -Sha512 (Get-Sha512Hex $file) -Source 'test'; $out.both = 'accepted' } catch { $out.both = $_.Exception.Message }",
                "try { Assert-FileHash -Path $file -Sha512 ('0' * 128) -Source 'test'; $out.mismatch = 'accepted' } catch { $out.mismatch = $_.Exception.Message }",
                "$out.deleted = -not (Test-Path -LiteralPath $file)",
                // Visual Studio from a layout: its bootstrapper checked first, the .vsconfig and --noWeb passed, then vswhere must list the version.
                "$script:VsWhere = Join-Path $home2 'vswhere.cmd'",
                "$expand = { param([string]$Value) $Value.Replace('{manifestDir}', $home2) }",
                "$vs = [pscustomobject]@{ step = 'visualStudio'; name = 'vs'; layout = [pscustomobject]@{ path = (Join-Path $home2 'layout'); bootstrapper = 'vs_fake.cmd'; sha256 = (Get-Sha256Hex (Join-Path $home2 'layout\\vs_fake.cmd')) }; vsconfig = '{manifestDir}\\x.vsconfig'; version = '18.12.0'; arguments = @('--includeRecommended') }",
                "$installed = Install-VisualStudio -Step $vs -Expand $expand",
                "$out.vs = [ordered]@{ exitCode = $installed.ExitCode; installationVersion = $installed.InstallationVersion; args = ([System.IO.File]::ReadAllText((Join-Path $home2 'layout\\args.txt'))).Trim() }",
                "$vs.version = '18.13.0'",
                "try { [void](Install-VisualStudio -Step $vs -Expand $expand); $out.vsOtherVersion = 'accepted' } catch { $out.vsOtherVersion = $_.Exception.Message }",
                "Remove-Item -LiteralPath (Join-Path $home2 'layout\\args.txt')",
                "$vs.layout.sha256 = '0' * 64",
                "try { [void](Install-VisualStudio -Step $vs -Expand $expand); $out.vsTampered = 'accepted' } catch { $out.vsTampered = $_.Exception.Message }",
                "$out.vsTamperedRan = Test-Path -LiteralPath (Join-Path $home2 'layout\\args.txt')",
                // The partition grows only when there is at least 1 MB to gain.
                "$script:size = 127GB; $script:resized = @()",
                "function Get-PartitionSupportedSize { param($DriveLetter) [pscustomobject]@{ SizeMax = 256GB } }",
                "function Get-Partition { param($DriveLetter) [pscustomobject]@{ Size = $script:size } }",
                "function Resize-Partition { param($DriveLetter, $Size) $script:resized += ($DriveLetter + '=' + $Size); $script:size = $Size }",
                "$out.grown = Resize-PartitionToMaximum -DriveLetter 'C'",
                "$out.unchanged = Resize-PartitionToMaximum -DriveLetter 'C'",
                "$out.resized = $script:resized",
                // The docker service: the group made when missing, an existing service registered again, the data root passed on.
                "$script:calls = @(); $script:service = $true",
                "function Invoke-NetLocalGroup { param([string[]]$Arguments, [switch]$NoThrow) $script:calls += ('net localgroup ' + ($Arguments -join ' ')); if ($Arguments.Count -eq 1) { [pscustomobject]@{ ExitCode = 2; StdOut = '' } } else { [pscustomobject]@{ ExitCode = 0; StdOut = '' } } }",
                "function Get-Service { [CmdletBinding()] param($Name) if ($script:service) { [pscustomobject]@{ Name = $Name } } }",
                "function Stop-Service { [CmdletBinding()] param($Name, [switch]$Force) $script:calls += ('stop ' + $Name) }",
                "function Invoke-NativeCommand { param($FilePath, [string[]]$ArgumentList) $script:calls += ([System.IO.Path]::GetFileName($FilePath) + ' ' + ($ArgumentList -join ' ')); [pscustomobject]@{ ExitCode = 0; StdOut = '' } }",
                "Register-DockerService -Step ([pscustomobject]@{ name = 'docker'; dockerd = (Join-Path $home2 'dockerd.exe'); pipeGroup = 'docker-users'; dataRoot = 'D:\\docker' })",
                "$out.docker = $script:calls",
                // The worker account: a missing right goes to the worker's SID, the rest of the right's accounts kept; groups by SID.
                `$script:exported = ${psQuote(exported)}; $script:secedit = @(); $script:template = ''; $script:members = @()`,
                "function Get-WorkerServiceSid { 'S-1-5-19' }",
                "function Invoke-SecEdit { param([string[]]$Arguments) $script:secedit += $Arguments[0]; $cfg = $Arguments[[array]::IndexOf($Arguments, '/cfg') + 1]; if ($Arguments[0] -eq '/export') { [System.IO.File]::WriteAllText($cfg, $script:exported, [System.Text.Encoding]::Unicode) } else { $script:template = [System.IO.File]::ReadAllText($cfg); foreach ($line in ($script:template -split \"`r`n\")) { if ($line -match '^(Se\\w+) = (.+)$') { $script:exported = $script:exported -replace ('(?m)^' + $Matches[1] + ' = .*$'), $line } } } }",
                "function Get-LocalGroupSid { param($Name) if ($Name -eq 'Administrators') { 'S-1-5-32-544' } else { 'S-1-5-21-1-2-3-1001' } }",
                "function Invoke-NetLocalGroup { param([string[]]$Arguments, [switch]$NoThrow) if ($Arguments.Count -gt 1) { $script:members += $Arguments[1] }; [pscustomobject]@{ ExitCode = 0; StdOut = ('Members' + [char]10 + '-----' + [char]10 + ($script:members -join [char]10)) } }",
                "$out.account = Grant-WorkerAccount -Settings ([pscustomobject]@{ userRights = @('SeCreateSymbolicLinkPrivilege'); groups = @('docker-users') })",
                "$out.template = $script:template",
                "$out.members = $script:members",
                "$again = Grant-WorkerAccount -Settings ([pscustomobject]@{ userRights = @('SeCreateSymbolicLinkPrivilege'); groups = @('docker-users') })",
                "$out.secedit = $script:secedit",
                "$out.membersAgain = $script:members",
                "$out.accountName = (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-19').Translate([System.Security.Principal.NTAccount]).Value",
                "try { [void](Grant-WorkerAccount -Settings ([pscustomobject]@{ groups = @('Administrators') })); $out.builtIn = 'accepted' } catch { $out.builtIn = $_.Exception.Message }",
                "ConvertTo-Json -Compress -Depth 6 -InputObject $out",
            ].join("\n"), { shell });
            assert.equal(driver.status, 0, driver.stderr + driver.stdout);
            const out = driver.json;
            assert.deepEqual([...out.nupkg].sort(), ["Pack.nuspec", "data/FrameworkList.xml", "ref/net8.0/A B.dll"]);
            assert.deepEqual([...out.zip].sort(), ["Pack.nuspec", "[Content_Types].xml", "_rels/.rels", "data/FrameworkList.xml", "package/services/metadata/core-properties/1.psmdcp", "ref/net8.0/A%20B.dll"]);
            assert.match(out.evil, /has an entry outside its folder: \.\.\/evil\.txt/);
            assert.equal(out.escaped, false);
            assert.match(out.both, /exactly one of a SHA-256 and a SHA-512/);
            assert.match(out.mismatch, /^SHA-512 mismatch for test: got [0-9a-f]{128}, pinned 0{128}$/);
            assert.equal(out.deleted, true);
            assert.deepEqual(out.vs, {
                exitCode: 3010,
                installationVersion: "18.12.12405.243",
                args: `--quiet --wait --norestart --nocache --config ${quoteArgument(path.join(home, "x.vsconfig"))} --noWeb --includeRecommended`,
            });
            assert.match(out.vsOtherVersion, /vswhere lists no Visual Studio 18\.13\.0 after the vs step/);
            assert.match(out.vsTampered, /SHA-256 mismatch for .*vs_fake\.cmd/);
            assert.equal(out.vsTamperedRan, false, "a bootstrapper that fails its hash never runs");
            assert.equal(out.grown, 256 * 1024 ** 3);
            assert.equal(out.unchanged, 256 * 1024 ** 3);
            assert.deepEqual(out.resized, [`C=${256 * 1024 ** 3}`]);
            assert.deepEqual(out.docker, [
                "net localgroup docker-users",
                "net localgroup docker-users /add",
                "stop docker",
                "dockerd.exe --unregister-service",
                "dockerd.exe --register-service --group docker-users --data-root D:\\docker",
            ]);
            assert.deepEqual(out.account, { userRights: ["SeCreateSymbolicLinkPrivilege"], groups: ["docker-users"] });
            assert.match(out.template, /\[Privilege Rights\]\r\nSeCreateSymbolicLinkPrivilege = \*S-1-5-32-544,\*S-1-5-19\r\n$/);
            assert.doesNotMatch(out.template, /SeServiceLogonRight/, "only the rights that change are configured");
            assert.deepEqual(out.secedit, ["/export", "/configure", "/export", "/export"], "a right the worker holds is not configured again");
            assert.deepEqual(out.members, [out.accountName], "the worker's account by the name Windows gives it");
            assert.deepEqual(out.membersAgain, [out.accountName], "a member is not added again");
            assert.match(out.builtIn, /Administrators is a built-in group, which the worker never joins/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
}

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
            prompt: "GIT_TERMINAL_PROMPT=1",
            launcher: "PS_LAUNCH_ID=x",
            token: "GITHUB_TOKEN=x",
            ...Object.fromEntries([...CREDENTIAL_ENV_NAMES, "git_config_key_0", "GIT_CONFIG_VALUE_12", "NuGetPackageSourceCredentials_feed"]
                .map((name) => [`credential-${name}`, `${name}=x`])),
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
        // Git never waits on a prompt, in a build or anywhere else: the Dev Drive extension's own settings for its Git calls.
        assert.equal(values.GIT_TERMINAL_PROMPT, "0");
        assert.equal(values.GCM_INTERACTIVE, "never");
        assert.equal(values.GIT_ASKPASS, "");
        assert.equal(values.SSH_ASKPASS, "");
        assert.equal(values.GIT_AUTHOR_NAME, "PilotSwarm Agent");
        assert.equal(values.PILOTSWARM_WORKER_CONCURRENCY, "4");
        assert.equal(values.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS, "6000000");
        for (const name of USER_DATA_SETTINGS) assert.equal(name in values, false, name);
        const merged = buildWorkerEnv({ workerEnv: entries, userData: decodeUserData(userData({ extraEnv: { EXAMPLE_API_URL: "https://api.example.test" } })) });
        assert.equal(merged.EXAMPLE_API_URL, "https://api.example.test");

        assert.match(driver.json.refused.userData, /only the scale set's userData sets/);
        assert.match(driver.json.refused.fixed, /the image fixes/);
        assert.match(driver.json.refused.prompt, /the image fixes/);
        assert.match(driver.json.refused.launcher, /no worker image may carry|only/);
        assert.match(driver.json.refused.token, /no worker image may carry/);
        for (const [name, refusal] of Object.entries(driver.json.refused).filter(([name]) => name.startsWith("credential-"))) {
            assert.match(refusal, /which no worker image may carry/, name);
        }
        assert.match(driver.json.refused["credential-VSS_NUGET_EXTERNAL_FEED_ENDPOINTS"], /a credential variable/);
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
            prefixes: "GIT_*,GCM_*,SSH_ASKPASS,AZURE_*,MSBUILD*",
            exact: "git_config_global,GIT_TERMINAL_PROMPT,GIT_ASKPASS,GCM_INTERACTIVE,SSH_ASKPASS,AZURE_CONFIG_DIR,AZURE_EXTENSION_USE_DYNAMIC_INSTALL,"
                + "AZURE_EXTENSION_DIR,AZURE_EXTENSION_DEV_SOURCES,AZURE_EXTENSION_SYS_DIR",
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
            // Every value the image pins for agents' git and az reaches their CLI, the non-interactive Git settings included.
            const pinned = entries.filter((e) => ["GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GCM_INTERACTIVE", "SSH_ASKPASS", "AZURE_CONFIG_DIR"]
                .includes(e.name) || e.name.startsWith("AZURE_EXTENSION_"));
            assert.equal(pinned.length, 10, name);
            for (const { name: pin } of pinned) assert.ok(passes(pin, written[name]), `${name}: ${pin}`);
        }
        const pins = "GIT_CONFIG_GLOBAL,GIT_TERMINAL_PROMPT,GIT_ASKPASS,GCM_INTERACTIVE,SSH_ASKPASS,AZURE_CONFIG_DIR,AZURE_EXTENSION_*";
        assert.equal(written.unset, pins);
        assert.equal(written.empty, pins);
        assert.equal(written.partial, "npm_config_*,AZURE_CONFIG_DIR,GIT_CONFIG_GLOBAL,GIT_TERMINAL_PROMPT,GIT_ASKPASS,GCM_INTERACTIVE,SSH_ASKPASS,AZURE_EXTENSION_*");
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
