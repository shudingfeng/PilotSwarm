/**
 * This fork's own CMS migrations against PostgreSQL. They take versions from 9001 up and are listed after every
 * upstream migration, so a new database runs them after all of upstream's, while an existing one ran each right after
 * the upstream migration it was written against (FORK_CMS_MIGRATION_BASES) and runs upstream's later migrations after
 * it. Database only: no workers, no model.
 *
 *  - Both orders must give the same schema; schemaSnapshot leaves the migration ledger out. Upstream's 0096 to 0102
 *    (workflow outcome retention and the Workflow Decision node's) follow 0095, so an existing deployment runs them
 *    after 9001 and a new database before it: this is the check that this fork's migrations commute with them. It also
 *    compares column positions, so an upstream column added later to a table that a fork migration extends (9001 adds
 *    one to users) shows up here as a difference in position.
 *  - A database that recorded the dispatcher delegation migration under its provisional number, 0096, is refused now
 *    that upstream's 0096 has that number, before any migration runs, like one that recorded it as 0090 or 0095.
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

    it("refuse a database that recorded dispatcher delegation as 0096, upstream's workflow outcome retention, and run none", async () => {
        await withSchemas(["u"], async ({ pool, query, schemas: [upgraded] }) => {
            // The list before the move: upstream's migrations through 0095, then this one as 0096.
            const previous = [
                ...CMS_MIGRATIONS(upgraded).filter((migration) => migration.version <= "0095"),
                { version: "0096", name: "dispatcher_delegation", sql: dispatcherDelegationMigration(upgraded) },
            ];
            await runMigrations(pool, upgraded, previous, CMS_LOCK_SEED);
            const recorded = await ledger(query, upgraded);
            const before = await schemaSnapshot(query, upgraded);

            // Matched by version alone, it would skip upstream's 0096. The migrator and a worker that skips migrations
            // refuse it instead, naming the number and both names.
            const refusal = 'records a different migration under a version this code uses: migration 0096 is recorded as '
                + '"dispatcher_delegation", but this code\'s migration 0096 is "workflow_outcome_retention".';
            await expect(runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded), CMS_LOCK_SEED)).rejects.toThrow(refusal);
            await expect(assertMigrationsApplied(pool, upgraded, CMS_MIGRATIONS(upgraded), "CMS")).rejects.toThrow(refusal);

            expect(await ledger(query, upgraded)).toEqual(recorded);
            expect(snapshotDifferences(before, await schemaSnapshot(query, upgraded)), "rows included").toEqual({});
        });
    });
});
