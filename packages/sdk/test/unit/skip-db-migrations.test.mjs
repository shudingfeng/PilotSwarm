/**
 * PILOTSWARM_SKIP_DB_MIGRATIONS=1: a worker whose database role can't change
 * the schema skips the CMS and facts migrations, which a deployment's
 * migration job runs. It only checks that the schema has every migration this
 * code knows, and fails at once, naming the first missing one, when it doesn't.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PgSessionCatalog } from "../../dist/cms.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { PgFactStore } from "../../dist/facts-store.js";
import { FACTS_MIGRATIONS } from "../../dist/facts-migrations.js";
import { assertMigrationsApplied, dbMigrationsSkipped } from "../../dist/pg-migrator.js";

const MIGRATIONS = [
    { version: "0001", name: "first", sql: "SELECT 1" },
    { version: "0002", name: "second", sql: "SELECT 1" },
    { version: "0003", name: "third", sql: "SELECT 1" },
];

/** A pool whose migrations table holds `versions`; `connect` is what a migration run calls first. */
function fakePool(versions, { tableError } = {}) {
    const pool = {
        queries: [],
        connected: 0,
        query: async (sql) => {
            pool.queries.push(sql);
            if (tableError) throw Object.assign(new Error("missing"), { code: tableError });
            return { rows: versions.map((version) => ({ version })) };
        },
        connect: async () => {
            pool.connected++;
            throw new Error("a migration run started");
        },
    };
    return pool;
}

function withSkipSetting(t, value) {
    const saved = process.env.PILOTSWARM_SKIP_DB_MIGRATIONS;
    if (value === undefined) delete process.env.PILOTSWARM_SKIP_DB_MIGRATIONS;
    else process.env.PILOTSWARM_SKIP_DB_MIGRATIONS = value;
    t.after(() => {
        if (saved === undefined) delete process.env.PILOTSWARM_SKIP_DB_MIGRATIONS;
        else process.env.PILOTSWARM_SKIP_DB_MIGRATIONS = saved;
    });
}

test("only 1 turns the skip on", () => {
    assert.equal(dbMigrationsSkipped({}), false);
    assert.equal(dbMigrationsSkipped({ PILOTSWARM_SKIP_DB_MIGRATIONS: "0" }), false);
    assert.equal(dbMigrationsSkipped({ PILOTSWARM_SKIP_DB_MIGRATIONS: "1" }), true);
});

test("the check passes when every known migration is applied, newer ones included", async () => {
    await assertMigrationsApplied(fakePool(["0001", "0002", "0003", "0004"]), "s", MIGRATIONS, "CMS");
});

test("the check names the first missing migration, and a schema with no migrations table at all", async () => {
    await assert.rejects(
        assertMigrationsApplied(fakePool(["0001"]), "s", MIGRATIONS, "CMS"),
        /^Error: CMS schema "s" lacks migration 0002 \(second\) and 1 more\. PILOTSWARM_SKIP_DB_MIGRATIONS=1/,
    );
    for (const code of ["42P01", "3F000"]) {
        await assert.rejects(
            assertMigrationsApplied(fakePool([], { tableError: code }), "s", MIGRATIONS, "Facts"),
            /Facts schema "s" lacks migration 0001 \(first\) and 2 more/,
        );
    }
    await assert.rejects(
        assertMigrationsApplied(fakePool([], { tableError: "28P01" }), "s", MIGRATIONS, "CMS"),
        /^Error: missing$/,
        "any other database error is the caller's",
    );
});

test("with the skip on, the catalog and the fact store check the schema and never migrate", async (t) => {
    withSkipSetting(t, "1");
    for (const [Store, migrations, schema] of [
        [PgSessionCatalog, CMS_MIGRATIONS, "copilot_sessions"],
        [PgFactStore, FACTS_MIGRATIONS, "pilotswarm_facts"],
    ]) {
        const current = Object.assign(Object.create(Store.prototype), {
            pool: fakePool(migrations(schema).map((migration) => migration.version)),
            sql: { schema },
            initialized: false,
        });
        await current.initialize();
        assert.equal(current.pool.connected, 0, `${Store.name} started no migration run`);
        assert.match(current.pool.queries[0], new RegExp(`FROM "${schema}"\\.schema_migrations`));

        const behind = Object.assign(Object.create(Store.prototype), {
            pool: fakePool(migrations(schema).slice(0, -1).map((migration) => migration.version)),
            sql: { schema },
            initialized: false,
        });
        await assert.rejects(behind.initialize(), /lacks migration/, `${Store.name} refuses a schema that is behind`);
        assert.equal(behind.pool.connected, 0);
    }
});

test("without the skip, both still run their migrations", async (t) => {
    withSkipSetting(t, undefined);
    for (const Store of [PgSessionCatalog, PgFactStore]) {
        const store = Object.assign(Object.create(Store.prototype), { pool: fakePool([]), sql: { schema: "s" }, initialized: false });
        await assert.rejects(store.initialize(), /a migration run started/);
        assert.equal(store.pool.connected, 1, `${Store.name} migrates as today`);
    }
});
