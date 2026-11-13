// Regression test for FR-010 + FR-011 (SC-006): the portal and worker image
// builds must use the lockfile-enforcing install mode (`npm ci`) so rebuilds
// from a given source revision are byte-reproducible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readDockerfile(name) {
  return readFileSync(join(REPO_ROOT, "deploy", name), "utf8");
}

// Strip `# ...` comment lines so we only flag the install verb when it
// appears in an executable RUN line.
function stripComments(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
  test(`${file} installs deps with npm ci (lockfile-enforcing)`, () => {
    const src = stripComments(readDockerfile(file));
    assert.match(
      src,
      /RUN\s+npm\s+ci\b/,
      `${file} must use 'npm ci' (lockfile-enforcing) for byte-reproducible rebuilds`,
    );
    assert.equal(
      /RUN\s+npm\s+install\b/.test(src),
      false,
      `${file} must NOT use 'npm install' on dependencies — that drifts from package-lock.json on rebuild`,
    );
  });
}

test("AKS images bake the checked-in deploy catalog, never the private local catalog", () => {
  for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
    const source = readDockerfile(file);
    assert.match(source, /COPY deploy\/config\/model_providers\.ghcp\.json \.\/\.model_providers\.json/);
    assert.doesNotMatch(source, /COPY \.model_providers\.json/);
  }
});

test("AKS application images build generated artifacts inside Docker", () => {
  const portal = readDockerfile("Dockerfile.portal");
  const worker = readDockerfile("Dockerfile.worker");

  for (const [name, source] of [["portal", portal], ["worker", worker]]) {
    assert.match(source, /FROM node:24\.22\.1-trixie-slim AS build/);
    assert.match(source, /rm -rf[\s\S]*packages\/sdk\/dist[\s\S]*packages\/horizon-store\/dist/);
    assert.match(source, /npm run build --workspace=packages\/sdk/);
    assert.match(source, /--workspace=pilotswarm-horizon-store/);
    assert.doesNotMatch(source, /^COPY packages\/sdk\/dist\//m, `${name} must not require host SDK output`);
    assert.doesNotMatch(source, /^COPY packages\/horizon-store\/dist\//m, `${name} must not require host Horizon Store output`);
    assert.match(source, /COPY --from=build \/app\/packages\/sdk\/dist\//);
    assert.match(source, /COPY --from=build \/app\/packages\/horizon-store\/dist\//);
  }

  assert.match(portal, /--workspace=pilotswarm(?:\s|\\)/);
  assert.match(portal, /rm -rf[\s\S]*packages\/app\/web\/dist[\s\S]*packages\/app\/mcp\/dist/);
  assert.doesNotMatch(portal, /^COPY packages\/app\/mcp\/dist\//m);
  assert.doesNotMatch(portal, /^COPY packages\/app\/web\/dist\//m);
  assert.match(portal, /COPY --from=build \/app\/packages\/app\/mcp\/dist\//);
  assert.match(portal, /COPY --from=build \/app\/packages\/app\/web\/dist\//);
});

test("starter image stages every workspace manifest before npm ci", () => {
  const source = readDockerfile("Dockerfile.starter");
  assert.match(source, /COPY packages\/sdk\/package\.json \.\/packages\/sdk\//);
  assert.match(source, /COPY packages\/horizon-store\/package\.json \.\/packages\/horizon-store\//);
  assert.match(source, /COPY packages\/app\/package\.json \.\/packages\/app\//);
  assert.match(stripComments(source), /RUN\s+npm\s+ci\b/);
});

test("starter image allows organizations to select an npm registry", () => {
  const source = readDockerfile("Dockerfile.starter");
  assert.match(
    source,
    /^ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org\/$/m,
  );
  assert.match(
    stripComments(source),
    /RUN\s+npm\s+ci\s+--force\s+--registry\s+"\$\{NPM_REGISTRY\}"/,
  );
});

// Session workspaces: the manifests in gitops/*/components/workspaces and
// gitops/repo-cache name files and programs these images must carry. The
// render tests in workspaces.test.mjs check that the paths exist in the
// source tree; these check that each image copies them.
test("images carry what the session-workspaces manifests name", () => {
  const worker = stripComments(readDockerfile("Dockerfile.worker"));
  assert.match(worker, /COPY packages\/sdk\/examples\/repo-workspaces\/ \.\/packages\/sdk\/examples\/repo-workspaces\//);
  assert.match(worker, /apt-get install[^\n]*\bgit\b[^\n]*\bnfs-common\b/, "git for agents, mount.nfs4 for the attacher");
  assert.match(worker, /chmod u-s \/usr\/sbin\/mount\.nfs/, "no setuid mount.nfs for agent shells");

  const portal = stripComments(readDockerfile("Dockerfile.portal"));
  assert.match(portal, /COPY packages\/sdk\/examples\/repo-workspaces\/plugin\/ \.\/packages\/sdk\/examples\/repo-workspaces\/plugin\//);
  // The portal component sets PORTAL_CANVAS_COMMANDS_RUNNER=local; without
  // git in the image every canvas command fails with "git is not installed".
  assert.match(portal, /apt-get install(?:[^\r\n]*\\\r?\n)*[^\r\n]*\bgit\b/, "git for canvas commands");

  const repoCache = stripComments(readDockerfile("Dockerfile.repo-cache"));
  assert.match(repoCache, /apt-get install[^\n]*\bgit\b[^\n]*\bnfs-kernel-server\b/);
  assert.match(repoCache, /WORKDIR \/app\/packages\/sdk\/examples\/repo-workspaces\r?\n/);
  assert.match(repoCache, /COPY packages\/sdk\/examples\/repo-workspaces\/ \.\//);
});

// The Key Vault personal secret store is a package of its own, outside the
// workspaces. The portal's build stage installs it from its own lockfile with
// the configured registry, and the image takes it from there without its
// tests, at the path PILOTSWARM_PERSONAL_SECRET_STORE_MODULE names. Its
// lockfile must resolve from registry.npmjs.org, which NPM_REGISTRY rewrites.
test("portal image installs the Key Vault personal secret store from its lockfile, without its tests", () => {
  const dir = "deploy/providers/azure/secret-store";
  const [build, runtime] = stripComments(readDockerfile("Dockerfile.portal")).split(/^FROM\s/m).slice(1);
  const install = build.search(new RegExp(`^RUN npm ci --omit=dev --prefix ${dir}\\b`, "m"));
  const registry = build.indexOf("ENV npm_config_registry=${NPM_REGISTRY}");
  const manifests = build.indexOf(`COPY ${dir}/package.json ${dir}/package-lock.json ./${dir}/`);
  assert.ok(install > 0, "the build stage installs the package with npm ci");
  assert.ok(registry >= 0 && registry < install, "after NPM_REGISTRY takes effect");
  assert.ok(manifests >= 0 && manifests < install, "from its own manifests");
  assert.match(build, new RegExp(`COPY ${dir}/ \\./${dir}/\\r?\\nRUN rm -rf ${dir}/test\\r?\\n`));
  assert.match(runtime, new RegExp(`^COPY --from=build /app/${dir}/ \\./${dir}/\\r?$`, "m"));
  assert.doesNotMatch(runtime, new RegExp(`^COPY ${dir}`, "m"), "the image takes the package only from the build stage");

  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(root.workspaces, ["packages/*"], "the package stays outside the workspaces");
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, "the lockfile matches package.json");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(entry.integrity, /^sha512-/, path);
  }
});

// The disk controller is a package of its own, outside the workspaces, with an
// image of its own. The build stage installs it from its own lockfile with the
// configured registry; the image takes the server and its modules, not the
// tests and not the TLS deploy step, which runs on the deploying machine. What
// it takes must import only Node's built-ins, each other and the package's
// dependencies. The lockfile must resolve from registry.npmjs.org, which
// NPM_REGISTRY rewrites.
test("disk controller image installs its package from its lockfile, without its tests or the deploy step", () => {
  const dir = "deploy/providers/azure/disk-controller";
  const source = stripComments(readDockerfile("Dockerfile.disk-controller"));
  const [build, runtime] = source.split(/^FROM\s/m).slice(1);
  assert.match(build, /^ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org\/\r?$/m);
  const registry = build.indexOf("ENV npm_config_registry=${NPM_REGISTRY}");
  const manifests = build.indexOf(`COPY ${dir}/package.json ${dir}/package-lock.json ./`);
  const install = build.search(/^RUN npm ci --omit=dev\r?$/m);
  assert.ok(install > 0, "the build stage installs the package with npm ci");
  assert.ok(registry >= 0 && registry < install, "after NPM_REGISTRY takes effect");
  assert.ok(manifests >= 0 && manifests < install, "from its own manifests");
  assert.doesNotMatch(source, /\bnpm\s+install\b/);
  assert.match(runtime, /^COPY --from=build \/app\/node_modules\/ \.\/node_modules\/\r?$/m);
  const copied = [...runtime.matchAll(/^COPY (?!--from=)(\S+) /gm)].map((m) => m[1]);
  assert.deepEqual(copied, [`${dir}/package.json`, `${dir}/server.mjs`, `${dir}/lib/`], "no tests, no tls.mjs");
  assert.match(runtime, /^USER node\r?$/m);
  assert.match(runtime, /^ENTRYPOINT \["node", "server\.mjs"\]\r?$/m);

  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(root.workspaces, ["packages/*"], "the package stays outside the workspaces");
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
  const shipped = ["server.mjs", ...readdirSync(join(REPO_ROOT, dir, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`)];
  for (const file of shipped) {
    const text = readFileSync(join(REPO_ROOT, dir, file), "utf8");
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimportModule\(\s*)["']([^"']+)["']/g)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = join(dirname(join(REPO_ROOT, dir, file)), specifier);
        const inImage = target.startsWith(join(REPO_ROOT, dir, "lib")) || target === join(REPO_ROOT, dir, "server.mjs");
        assert.ok(inImage && existsSync(target), `${file} imports ${specifier}, which the image does not carry`);
        continue;
      }
      assert.ok(manifest.dependencies?.[specifier], `${file} imports ${specifier}, which is not a dependency`);
    }
  }
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, "the lockfile matches package.json");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(entry.integrity, /^sha512-/, path);
  }
});

// The coordination host's extension module, which the Linux worker beside a
// pool of owner-only Windows workers loads through PILOTSWARM_EXTENSION_MODULES
// from /app/deploy/providers/azure/linux-worker/. The worker image carries the
// folder's modules at that path, without its tests, before USER node. They
// import only Node's built-ins, each other and production dependencies of the
// SDK, which the image's node_modules holds.
test("worker image carries the coordination host's module at its path under /app, without its tests", () => {
  const dir = "deploy/providers/azure/linux-worker";
  const runtime = stripComments(readDockerfile("Dockerfile.worker")).split(/^FROM\s/m).at(-1);
  const copies = [...runtime.matchAll(/^COPY (?!--from=)(\S+) (\S+)\r?$/gm)].filter(([, source]) => source.startsWith(`${dir}/`));
  assert.deepEqual(copies.map(([, source, target]) => [source, target]), [[`${dir}/*.mjs`, `./${dir}/`]], "the folder's modules, not test/");
  assert.ok(copies[0].index < runtime.search(/^USER node\r?$/m), "copied before USER node, so the worker cannot change it");

  const sdk = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "sdk", "package.json"), "utf8"));
  const modules = readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith(".mjs"));
  assert.ok(modules.includes("capacity-requester.mjs"));
  for (const file of modules) {
    const text = readFileSync(join(REPO_ROOT, dir, file), "utf8");
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = join(REPO_ROOT, dir, specifier);
        assert.ok(dirname(target) === join(REPO_ROOT, dir) && target.endsWith(".mjs") && existsSync(target),
          `${file} imports ${specifier}, which the image does not carry`);
        continue;
      }
      assert.ok(sdk.dependencies?.[specifier], `${file} imports ${specifier}, which is not a production dependency of the SDK`);
    }
  }
});

// The coordination host's module is also a package of its own, outside the
// workspaces, so the Azure SDK it loads comes from its own lockfile. The
// worker's build stage installs it with the configured registry, and the image
// takes the installed modules beside the folder's *.mjs files, before USER
// node. Every package the modules import is a dependency of the package. Its
// lockfile must resolve from registry.npmjs.org, which NPM_REGISTRY rewrites.
test("worker image installs the coordination host's module from its own lockfile", () => {
  const dir = "deploy/providers/azure/linux-worker";
  const [build, runtime] = stripComments(readDockerfile("Dockerfile.worker")).split(/^FROM\s/m).slice(1);
  const install = build.search(new RegExp(`^RUN npm ci --omit=dev --prefix ${dir}\\b`, "m"));
  const registry = build.indexOf("ENV npm_config_registry=${NPM_REGISTRY}");
  const manifests = build.indexOf(`COPY ${dir}/package.json ${dir}/package-lock.json ./${dir}/`);
  assert.ok(install > 0, "the build stage installs the package with npm ci");
  assert.ok(registry >= 0 && registry < install, "after NPM_REGISTRY takes effect");
  assert.ok(manifests >= 0 && manifests < install, "from its own manifests");
  const copy = runtime.search(new RegExp(`^COPY --from=build /app/${dir}/node_modules/ \\./${dir}/node_modules/\\r?$`, "m"));
  assert.ok(copy > 0 && copy < runtime.search(/^USER node\r?$/m), "the image takes the installed modules before USER node");

  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(root.workspaces, ["packages/*"], "the package stays outside the workspaces");
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
  for (const file of readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(REPO_ROOT, dir, file), "utf8");
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      assert.ok(manifest.dependencies?.[specifier], `${file} imports ${specifier}, which is not a dependency of the package`);
    }
  }
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, "the lockfile matches package.json");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(entry.integrity, /^sha512-/, path);
  }
});

// The Copilot CLI program's unpacked copy. With external personal secrets a
// worker starts the program only from a complete copy that it cannot change,
// which COPILOT_PKG_CACHE_HOME names (packages/sdk/src/cli-program-guard.ts). A
// build that passes the argument of that name unpacks the program there as
// root before USER node, as its first start would, checks the marker and the
// files its loader checks, and leaves the copy owned by root and read-only.
// Without the argument the step runs nothing, so the image holds no unpacked
// copy. Only an image build runs these steps.
test("worker image unpacks the Copilot CLI program as root, only when the build passes COPILOT_PKG_CACHE_HOME", () => {
  const source = readDockerfile("Dockerfile.worker");
  // Instructions as Docker reads them: continuation lines joined.
  const steps = stripComments(source).split(/^FROM\s/m).at(-1).replace(/\\\r?\n/g, "").split(/\r?\n/);
  const arg = steps.findIndex((line) => /^ARG COPILOT_PKG_CACHE_HOME\b/.test(line));
  assert.equal(steps[arg], "ARG COPILOT_PKG_CACHE_HOME", "no default: unset unless the build passes it");
  const runs = steps.filter((line) => line.includes("--no-auto-update"));
  assert.equal(runs.length, 1, "one step runs the program");
  const [run] = runs;
  const modules = steps.indexOf("COPY --from=build /app/node_modules/ ./node_modules/");
  assert.ok(modules >= 0 && modules < arg && arg < steps.indexOf(run) && steps.indexOf(run) < steps.indexOf("USER node"),
    "after node_modules is in place, as root, before USER node");

  assert.match(run, /^RUN set -eu; if \[ -n "\$\{COPILOT_PKG_CACHE_HOME:-\}" \]; then .+; +fi$/, "every command depends on the argument");
  assert.match(run, /case "\$COPILOT_PKG_CACHE_HOME" in \/\*\) ;; \*\) [^;]*>&2; exit 1 ;; esac;/, "an absolute path only");
  // The program the SDK starts (copilotCliProgramPath), run with the setting, as its first start would.
  assert.match(run, /platform="linux-\$\(node -p process\.arch\)";/);
  assert.match(run, /createRequire\(require\.resolve\("@github\/copilot\/package\.json"\)\)\.resolve\(`@github\/copilot-\$\{process\.argv\[1\]\}`\)/);
  assert.match(run, /COPILOT_PKG_CACHE_HOME="\$COPILOT_PKG_CACHE_HOME" "\$program" --no-auto-update --version;/);
  // The marker and the files the program's loader checks, which the worker's start check requires.
  assert.match(run, /copy="\$COPILOT_PKG_CACHE_HOME\/pkg\/\$platform\/\$version";/);
  assert.match(run, /for file in \.extraction-complete index\.js app\.js "prebuilds\/\$platform\/runtime\.node"; do +test -f "\$copy\/\$file" \|\| \{[^}]*exit 1; \}; +done;/);
  const guard = readFileSync(join(REPO_ROOT, "packages", "sdk", "src", "cli-program-guard.ts"), "utf8");
  assert.match(guard, /\["\.extraction-complete", "index\.js", "app\.js", path\.join\("prebuilds", platform, "runtime\.node"\)\]/,
    "the worker's start check still requires these files");
  // Owned by root and read-only after the unpack: the node user can only read it.
  assert.match(run, /--version;.+chown -R root:root "\$COPILOT_PKG_CACHE_HOME"; +chmod -R a\+rX,a-w "\$COPILOT_PKG_CACHE_HOME"; +fi$/);
  // No setting in the image: the worker's own COPILOT_PKG_CACHE_HOME names the copy.
  assert.doesNotMatch(source, /^\s*ENV\s[^\n]*COPILOT_PKG_CACHE_HOME/m);
});
