// Guard: every *.test.mjs in deploy/scripts/test/, and in the test/ folder of
// each provider package (deploy/providers/<provider>/<package>/test/), must be
// wired into the `test:deploy-scripts` script in root package.json. Catches
// the "orphaned test file" gap (test passes locally but never runs in CI /
// pre-deploy).
//
// Run individually:
//   node --test deploy/scripts/test/test-discovery.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

function testFiles(dir, prefix) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => `${prefix}/${f}`);
}

function providerPackageTestFiles() {
  const providers = join(repoRoot, "deploy", "providers");
  const files = [];
  for (const provider of readdirSync(providers, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const component of readdirSync(join(providers, provider.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = join(providers, provider.name, component.name, "test");
      if (existsSync(dir)) files.push(...testFiles(dir, `deploy/providers/${provider.name}/${component.name}/test`));
    }
  }
  return files;
}

test("every deploy *.test.mjs is referenced by test:deploy-scripts", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const cmd = pkg.scripts["test:deploy-scripts"];
  assert.ok(cmd, "test:deploy-scripts script missing from package.json");

  const files = [...testFiles(__dirname, "deploy/scripts/test"), ...providerPackageTestFiles()].sort();

  const missing = files.filter((f) => !cmd.includes(f));
  assert.deepEqual(
    missing,
    [],
    `Orphaned test files (add to package.json#scripts.test:deploy-scripts): ${missing.join(", ")}`,
  );
});
