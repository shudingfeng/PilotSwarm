/**
 * This fork's own CMS migrations against PostgreSQL. They take versions from 9001 up and are listed after every
 * upstream migration, so a new database runs them after all of upstream's, while an existing one ran each right after
 * the upstream migration it was written against (FORK_CMS_MIGRATION_BASES) and runs upstream's later migrations after
 * it. Database only: no workers, no model.
 *
 *  - Both orders must give the same schema; schemaSnapshot leaves the migration ledger out. No upstream migration
 *    follows 0095 yet, so today the orders are the same; after a sync that brings one, this is the check that this
 *    fork's migrations commute with it. It also compares column positions, so an upstream column added later to a
 *    table that a fork migration extends (9001 adds one to users) shows up here as a difference in position.
 *  - A database that recorded the dispatcher delegation migration under its provisional number, 0096, keeps working:
 *    this code lists no 0096, so the name check doesn't compare that record, and 9001 runs again without changing
 *    anything.
 *
 * Run: npx vitest run test/local/fork-migrations.test.js
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { deploymentOrder, isForkMigrationVersion } from "../helpers/fork-migrations.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { FORK_CMS_MIGRATION_BASES } from "../../src/fork-migrations.ts";
import { assertMigrationsApplied, runMigrations } from "../../src/pg-migrator.ts";
import { dispatcherDelegationMigration } from "../../src/migrations/dispatcher-delegation-9001.ts";

const CMS_LOCK_SEED = 0x63_6D_73;
const getEnv = useSuiteEnv(import.meta.url);

/** Runs with a pool of one connection and scratch schemas named after `suffixes`, dropped afterwards. */
async function withSchemas(suffixes, run) {
    const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
    const tag = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemas = suffixes.map((suffix) => `fm_${tag}_${suffix}`);
    const query = (sql, params) => pool.query(sql, params);
    try {
        await run({ pool, query, schemas });
    } finally {
        for (const schema of schemas) await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
    }
}

async function ledger(query, schema) {
    return (await query(`SELECT version, name FROM "${schema}".schema_migrations ORDER BY version`)).rows;
}

describe("this fork's CMS migrations", () => {
    it("give the same schema in list order, as a new database runs them, and in an existing deployment's order", async () => {
        await withSchemas(["l", "d"], async ({ pool, query, schemas: [listed, deployed] }) => {
            await runMigrations(pool, listed, CMS_MIGRATIONS(listed), CMS_LOCK_SEED);

            // Each release that brought a fork migration ran the list up to it; this code then runs what is left.
            const order = deploymentOrder(CMS_MIGRATIONS(deployed), FORK_CMS_MIGRATION_BASES);
            for (const [index, migration] of order.entries()) {
                if (isForkMigrationVersion(migration.version)) {
                    await runMigrations(pool, deployed, order.slice(0, index + 1), CMS_LOCK_SEED);
                }
            }
            await runMigrations(pool, deployed, CMS_MIGRATIONS(deployed), CMS_LOCK_SEED);

            expect(await ledger(query, deployed)).toEqual(await ledger(query, listed));
            expect(snapshotDifferences(await schemaSnapshot(query, listed), await schemaSnapshot(query, deployed))).toEqual({});
        });
    });

    it("migrate a database that recorded dispatcher delegation as 0096: 9001 runs again, changes nothing and ends as a new database", async () => {
        await withSchemas(["u", "f"], async ({ pool, query, schemas: [upgraded, fresh] }) => {
            // The list before the move: upstream's migrations through 0095, then this one as 0096.
            const previous = [
                ...CMS_MIGRATIONS(upgraded).filter((migration) => migration.version <= "0095"),
                { version: "0096", name: "dispatcher_delegation", sql: dispatcherDelegationMigration(upgraded) },
            ];
            await runMigrations(pool, upgraded, previous, CMS_LOCK_SEED);
            await query(`SELECT "${upgraded}".cms_set_user_dispatcher_delegation('dev', 'alice', NULL, NULL, true)`);
            const recorded = await ledger(query, upgraded);
            const before = await schemaSnapshot(query, upgraded);

            // The name check doesn't refuse it: a worker that skips migrations only waits for 9001.
            await expect(assertMigrationsApplied(pool, upgraded, CMS_MIGRATIONS(upgraded), "CMS"))
                .rejects.toThrow(`CMS schema "${upgraded}" lacks migration 9001 (dispatcher_delegation).`);
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded), CMS_LOCK_SEED);
            await assertMigrationsApplied(pool, upgraded, CMS_MIGRATIONS(upgraded), "CMS");

            expect(await ledger(query, upgraded)).toEqual([...recorded, { version: "9001", name: "dispatcher_delegation" }]);
            const after = await schemaSnapshot(query, upgraded);
            expect(snapshotDifferences(before, after), "rows included").toEqual({});
            const optIn = await query(`SELECT "${upgraded}".cms_get_user_dispatcher_delegation('dev', 'alice') AS enabled`);
            expect(optIn.rows[0].enabled).toBe(true);

            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh), CMS_LOCK_SEED);
            const catalog = ({ data, ...rest }) => rest;
            expect(snapshotDifferences(catalog(after), catalog(await schemaSnapshot(query, fresh)))).toEqual({});
        });
    });
});
