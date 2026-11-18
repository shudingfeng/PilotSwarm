/**
 * The migration identity guard on a real CMS schema. A database that recorded
 * the dispatcher delegation migration as 0095, before upstream's ten canvas
 * slots took that number, would skip upstream's 0095 if the migrator matched
 * by version alone. It is refused instead, before any migration runs, by the
 * migrator and by a worker that skips migrations. Database only: no workers,
 * no model.
 *
 * Run: npx vitest run test/local/pg-migrator-identity.test.js
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { assertMigrationsApplied, runMigrations } from "../../src/pg-migrator.ts";
import { useSuiteEnv } from "../helpers/local-env.js";

const CMS_LOCK_SEED = 0x63_6D_73;
const getEnv = useSuiteEnv(import.meta.url);

describe("migration identity", () => {
    it("refuses a schema that recorded another migration as 0095, and runs none", async () => {
        const env = getEnv();
        const schema = env.cmsSchema;
        const pool = new pg.Pool({ connectionString: env.store, max: 2 });
        try {
            const migrations = CMS_MIGRATIONS(schema);
            const through0094 = migrations.filter((migration) => migration.version <= "0094");
            await runMigrations(pool, schema, through0094, CMS_LOCK_SEED);
            await pool.query(`INSERT INTO "${schema}".schema_migrations (version, name) VALUES ('0095', 'dispatcher_delegation')`);
            const records = async () => (await pool.query(`SELECT version, name FROM "${schema}".schema_migrations ORDER BY version`)).rows;
            const before = await records();

            const refusal = 'records a different migration under a version this code uses: migration 0095 is recorded as '
                + '"dispatcher_delegation", but this code\'s migration 0095 is "canvas_ten_slots".';
            await expect(runMigrations(pool, schema, migrations, CMS_LOCK_SEED)).rejects.toThrow(refusal);
            await expect(assertMigrationsApplied(pool, schema, migrations, "CMS")).rejects.toThrow(refusal);

            expect(await records()).toEqual(before);
            const canvasRange = await pool.query(
                `SELECT 1 FROM pg_constraint
                  WHERE conrelid = format('%I.%I', $1::text, 'session_canvases')::regclass AND conname = 'session_canvases_slot_range'`,
                [schema],
            );
            expect(canvasRange.rowCount, "0095 (ten canvas slots) did not run").toBe(0);
            const delegationColumn = await pool.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'allow_dispatcher_delegation'`,
                [schema],
            );
            expect(delegationColumn.rowCount, "0096 (dispatcher delegation) did not run").toBe(0);

            // The refusal released the migration lock, and code that lists only 0001-0094 still runs against this schema.
            await runMigrations(pool, schema, through0094, CMS_LOCK_SEED);
            expect(await records()).toEqual(before);
        } finally {
            await pool.end();
        }
    });
});
