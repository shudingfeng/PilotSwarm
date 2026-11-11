// The two services and the token module run in the image with no
// node_modules of their own: they may import Node.js built-in modules only,
// and nothing relative, so each is one self-contained file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WINDOWS_DIR } from "./fixtures.mjs";

const SERVICES = ["launcher.mjs", "disk-attacher.mjs", "controller-token.mjs"];

/** The argument text of each `import(...)` call, with nested parentheses. */
function dynamicImportArguments(source) {
    const found = [];
    for (const match of source.matchAll(/\bimport\s*\(/g)) {
        let depth = 1;
        let index = match.index + match[0].length;
        const start = index;
        for (; index < source.length && depth > 0; index++) {
            if (source[index] === "(") depth++;
            else if (source[index] === ")") depth--;
        }
        found.push(source.slice(start, index - 1).trim());
    }
    return found;
}

/** Every module specifier a source imports or re-exports, and every dynamic import's argument. */
export function importsOf(source) {
    const staticImports = [...source.matchAll(/^\s*import\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1]);
    const reExports = [...source.matchAll(/^\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm)].map((match) => match[1]);
    const dynamic = dynamicImportArguments(source);
    const requires = [...source.matchAll(/\brequire\s*\(/g)].length;
    return { staticImports, reExports, dynamic, requires };
}

test("the parser sees static, re-exported and dynamic imports", () => {
    const found = importsOf([
        'import fs from "node:fs";',
        "import {",
        "    a,",
        "    b,",
        '} from "./local.mjs";',
        'export { c } from "pkg";',
        'const m = await import("node:path");',
        "const w = await import(pathToFileURL(file).href);",
    ].join("\n"));
    assert.deepEqual(found.staticImports, ["node:fs", "./local.mjs"]);
    assert.deepEqual(found.reExports, ["pkg"]);
    assert.deepEqual(found.dynamic, ['"node:path"', "pathToFileURL(file).href"]);
});

for (const file of SERVICES) {
    test(`${file} imports only node:* built-ins`, () => {
        const source = fs.readFileSync(path.join(WINDOWS_DIR, file), "utf8");
        const { staticImports, reExports, dynamic, requires } = importsOf(source);
        assert.ok(staticImports.length > 0, "expected at least one import");
        for (const specifier of [...staticImports, ...reExports]) {
            assert.match(specifier, /^node:[a-z_/]+$/, `${file} imports ${specifier}`);
        }
        assert.equal(requires, 0, `${file} calls require()`);
        for (const argument of dynamic) {
            if (/^["']/.test(argument)) {
                assert.match(argument, /^["']node:[a-z_/]+["']$/, `${file} imports ${argument} at run time`);
            } else {
                // The one computed import: the launcher loads the release's worker.js by its file URL.
                assert.equal(file, "launcher.mjs", `${file} imports a computed module`);
                assert.equal(argument, "pathToFileURL(file).href");
            }
        }
    });
}
