/**
 * Windows: session archives use the system tar.exe whatever `tar` comes
 * first on PATH, and keep their exclusions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSessionStore } from "../../dist/session-store.js";

test("a session archives and extracts with the system tar.exe, whatever tar comes first on PATH", { skip: process.platform !== "win32" && "Windows only" }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-win-tar-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // A decoy tar.exe ahead of everything: where.exe refuses tar's flags.
    const decoys = join(root, "bin");
    mkdirSync(decoys);
    copyFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), join(decoys, "tar.exe"));
    const savedPath = process.env.PATH;
    process.env.PATH = `${decoys};${savedPath}`;
    t.after(() => { process.env.PATH = savedPath; });

    const stateDir = join(root, "state");
    const sessionDir = join(stateDir, "s1");
    mkdirSync(join(sessionDir, "files"), { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "id: s1\n");
    writeFileSync(join(sessionDir, "files", "notes.txt"), "kept");
    writeFileSync(join(sessionDir, "inuse.42.lock"), "");
    const store = new FilesystemSessionStore(join(root, "store"), stateDir);

    await store.dehydrate("s1");
    assert.equal(existsSync(sessionDir), false);
    await store.hydrate("s1");
    assert.equal(readFileSync(join(sessionDir, "files", "notes.txt"), "utf8"), "kept");
    assert.equal(existsSync(join(sessionDir, "inuse.42.lock")), false, "the live lock file is not archived");
});
