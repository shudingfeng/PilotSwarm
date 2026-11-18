/**
 * The migrator matches applied migrations by version, so a database that ran
 * another migration under a version this code uses (a provisional number that
 * a later migration took) would skip this code's migration without a word. It
 * refuses such a schema before running any migration, naming the version, the
 * recorded name and this code's name. A schema whose recorded names match, and
 * versions not recorded yet, migrate as before.
 *
 * Run: node --test test/unit/pg-migrator-identity.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertMigrationsApplied, runMigrations } from "../../src/pg-migrator.ts";

const MIGRATIONS = [
    { version: "0001", name: "first", sql: "MIGRATE_0001" },
    { version: "0002", name: "second", sql: "MIGRATE_0002" },
    { version: "0003", name: "third", steps: ["MIGRATE_0003"] },
];

/** A database whose migrations table holds `recorded` ({ version, name }); the migration lock is free. */
function fakeDatabase(recorded) {
    const rows = recorded.map((row) => ({ ...row }));
    const executed = [];
    const released = [];
    const client = {
        async query(sql, params = []) {
            if (sql === "SELECT pg_try_advisory_lock($1) AS locked") return { rows: [{ locked: true }] };
            if (/SELECT version(, name)? FROM "[^"]+"\.schema_migrations/.test(sql)) return { rows: rows.map((row) => ({ ...row })) };
            if (sql.includes("INSERT INTO") && sql.includes("schema_migrations")) {
                rows.push({ version: params[0], name: params[1] });
                return { rows: [] };
            }
            if (sql.startsWith("MIGRATE_")) executed.push(sql);
            return { rows: [] };
        },
        release(error) { released.push(error); },
    };
    return { rows, executed, released, pool: { connect: async () => client, query: (sql, params) => client.query(sql, params) } };
}

const REFUSED_0002 = 'migration 0002 is recorded as "provisional", but this code\'s migration 0002 is "second"';

test("a version recorded under another name stops the run before any migration", async () => {
    const db = fakeDatabase([{ version: "0001", name: "first" }, { version: "0002", name: "provisional" }]);
    await assert.rejects(runMigrations(db.pool, "s", MIGRATIONS, 42), (error) => {
        assert.equal(error.message, `Schema "s" records a different migration under a version this code uses: ${REFUSED_0002}. `
            + "No migration was run. Recreate the database, or run the code that recorded it.");
        return true;
    });
    assert.deepEqual(db.executed, [], "not even 0003, which nothing recorded, runs");
    assert.deepEqual(db.rows, [{ version: "0001", name: "first" }, { version: "0002", name: "provisional" }], "nothing is recorded");
    assert.deepEqual(db.released, [undefined], "the connection goes back to the pool");
});

test("the refusal names every mismatched version", async () => {
    const db = fakeDatabase([{ version: "0001", name: "other_first" }, { version: "0003", name: "other_third" }]);
    await assert.rejects(runMigrations(db.pool, "s", MIGRATIONS, 42), new RegExp(
        'migration 0001 is recorded as "other_first", but this code\'s migration 0001 is "first"; '
        + 'migration 0003 is recorded as "other_third", but this code\'s migration 0003 is "third"\\.',
    ));
    assert.deepEqual(db.executed, []);
});

test("matching names and unrecorded versions migrate as before; versions this code doesn't list are not compared", async () => {
    const db = fakeDatabase([{ version: "0001", name: "first" }, { version: "0009", name: "from_newer_code" }]);
    await runMigrations(db.pool, "s", MIGRATIONS, 42);
    assert.deepEqual(db.executed, ["MIGRATE_0002", "MIGRATE_0003"]);
    assert.deepEqual(db.rows.map((row) => [row.version, row.name]),
        [["0001", "first"], ["0009", "from_newer_code"], ["0002", "second"], ["0003", "third"]]);
    await runMigrations(db.pool, "s", MIGRATIONS, 42);
    assert.deepEqual(db.executed, ["MIGRATE_0002", "MIGRATE_0003"], "a second run finds every name matching and runs nothing");
});

test("a worker that skips migrations refuses the same schema, and accepts one whose names match", async () => {
    const mismatched = fakeDatabase([{ version: "0001", name: "first" }, { version: "0002", name: "provisional" }, { version: "0003", name: "third" }]);
    await assert.rejects(
        assertMigrationsApplied(mismatched.pool, "s", MIGRATIONS, "CMS"),
        (error) => error.message.startsWith(`CMS schema "s" records a different migration under a version this code uses: ${REFUSED_0002}.`),
    );
    const matching = fakeDatabase([...MIGRATIONS.map(({ version, name }) => ({ version, name })), { version: "0004", name: "from_newer_code" }]);
    await assertMigrationsApplied(matching.pool, "s", MIGRATIONS, "CMS");
});
