/**
 * Shared PostgreSQL Schema Migrator — versioned SQL migrations with advisory locks.
 *
 * Extracted from the CMS-specific migrator so that both the CMS and Facts
 * schemas can reuse the same ordered, transactional migration runner.
 *
 * @module
 */

// Poll interval while waiting for the advisory migration lock (ms).
const LOCK_POLL_INTERVAL_MS = 100;

interface MigrationEntryBase {
    version: string;
    name: string;
}

export type MigrationEntry = MigrationEntryBase & (
    | {
        /** Transactional SQL run inside one BEGIN/COMMIT block. */
        sql: string;
        steps?: never;
    }
    | {
        /**
         * Non-transactional, individually autocommitted SQL statements.
         * Every step must be idempotent: partial success leaves the version
         * unrecorded and the next run starts again from step one.
         */
        steps: string[];
        sql?: never;
    }
);

/** Validate migration definitions before acquiring a connection or lock. */
export function validateMigrationEntries(migrations: MigrationEntry[]): void {
    const versions = new Set<string>();
    for (const migration of migrations as Array<MigrationEntry & { sql?: unknown; steps?: unknown }>) {
        const label = migration?.version ? `Migration ${migration.version}` : "Migration entry";
        if (!migration || typeof migration.version !== "string" || !migration.version.trim()) {
            throw new Error(`${label} requires a non-empty version`);
        }
        if (versions.has(migration.version)) {
            throw new Error(`Duplicate migration version: ${migration.version}`);
        }
        versions.add(migration.version);
        if (typeof migration.name !== "string" || !migration.name.trim()) {
            throw new Error(`${label} requires a non-empty name`);
        }

        const hasSql = typeof migration.sql === "string";
        const hasSteps = Array.isArray(migration.steps);
        if (hasSql === hasSteps) {
            throw new Error(`${label} must define exactly one execution mode: sql or steps`);
        }
        if (hasSql && !migration.sql!.trim()) {
            throw new Error(`${label} sql must be non-empty`);
        }
        if (hasSteps) {
            if (migration.steps!.length === 0) {
                throw new Error(`${label} steps must contain at least one statement`);
            }
            if (migration.steps!.some((step) => typeof step !== "string" || !step.trim())) {
                throw new Error(`${label} steps must contain only non-empty SQL strings`);
            }
        }
    }
}

/**
 * Refuses a schema whose migrations table records a version under another name
 * than this code's migration at that version. Applied migrations are matched by
 * version, so a database that ran a different migration under a number this code
 * reuses would otherwise skip this code's migration without a word. Recorded
 * versions this code doesn't list (from newer code) are not compared.
 */
export function assertRecordedMigrationNames(
    schema: string,
    recorded: ReadonlyArray<{ version: string; name: string }>,
    migrations: ReadonlyArray<{ version: string; name: string }>,
    label?: string,
): void {
    const expected = new Map(migrations.map((migration) => [migration.version, migration.name]));
    const mismatches = recorded.filter((row) => expected.has(row.version) && expected.get(row.version) !== row.name);
    if (mismatches.length === 0) return;
    const list = mismatches
        .map((row) => `migration ${row.version} is recorded as "${row.name}", but this code's migration ${row.version} is "${expected.get(row.version)}"`)
        .join("; ");
    throw new Error(
        `${label ? `${label} schema` : "Schema"} "${schema}" records a different migration under a version this code uses: ${list}. `
        + "No migration was run. Recreate the database, or run the code that recorded it.",
    );
}

/**
 * Run all pending migrations against the given schema.
 *
 * Uses a PostgreSQL advisory lock keyed on `lockSeed` + schema name to
 * serialize concurrent workers. Each migration runs in its own transaction
 * (or as autocommit steps — see MigrationEntry.steps). A schema that recorded
 * another migration under one of these versions is refused before any runs
 * (assertRecordedMigrationNames).
 *
 * @param pool      - node-postgres pool
 * @param schema    - target schema name (e.g. "copilot_sessions", "pilotswarm_facts")
 * @param migrations - ordered list of migrations to apply
 * @param lockSeed  - unique seed per system so different schemas don't block each other
 */
export async function runMigrations(
    pool: any,
    schema: string,
    migrations: MigrationEntry[],
    lockSeed: number,
): Promise<void> {
    validateMigrationEntries(migrations);
    const lockKey = hashSchemaName(schema, lockSeed);
    const client = await pool.connect();
    // Review CI-114: a ROLLBACK or the unlock that fails (HorizonDB answered a ROLLBACK after a lock timeout with a server
    // error) leaves this connection in an aborted transaction, and maybe still holding the migration lock. It is then
    // discarded, never handed back to the pool, so no later query gets it and its session lock goes with it.
    let unusable: unknown = null;
    const rollback = () => client.query("ROLLBACK").catch((error: unknown) => { unusable ??= error; });
    try {
        // Acquire the migration lock by POLLING pg_try_advisory_lock rather
        // than blocking on pg_advisory_lock. A worker blocked inside
        // pg_advisory_lock holds an open transaction for the entire wait, and
        // CREATE INDEX CONCURRENTLY (used by hardened migrations such as CMS
        // 0029) waits for every concurrent transaction to finish — so the lock
        // holder's CIC and the blocked waiter deadlock. Polling lets a waiter
        // sleep with NO open transaction between attempts, so the holder's CIC
        // can complete. Same session-level lock, released by pg_advisory_unlock.
        for (;;) {
            const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
            if (rows[0]?.locked === true) break;
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
        }

        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows: applied } = await client.query(
            `SELECT version, name FROM ${migrationsTable} ORDER BY version`,
        );
        assertRecordedMigrationNames(schema, applied, migrations);
        const appliedSet = new Set(applied.map((r: any) => r.version));

        for (const migration of migrations) {
            if (appliedSet.has(migration.version)) continue;

            if (migration.steps) {
                // Autocommit path: no BEGIN wrapper. On a mid-way failure the
                // version stays unrecorded and the (idempotent) steps re-run
                // on the next attempt.
                for (const step of migration.steps) {
                    try {
                        await client.query(step);
                    } catch (err) {
                        // A failed step can leave the connection inside an
                        // aborted explicit transaction (a step's own BEGIN);
                        // roll it back so the pooled connection stays usable.
                        await rollback();
                        throw err;
                    }
                }
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
                continue;
            }

            try {
                await client.query("BEGIN");
                await client.query(migration.sql);
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
                await client.query("COMMIT");
            } catch (err) {
                await rollback();
                throw err;
            }
        }
    } finally {
        if (unusable === null) {
            await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch((error: unknown) => { unusable = error; });
        }
        // node-postgres: release(error) closes the connection instead of returning it to the pool.
        client.release(unusable === null ? undefined : (unusable instanceof Error ? unusable : new Error(String(unusable))));
    }
}

/**
 * `PILOTSWARM_SKIP_DB_MIGRATIONS=1`: this process never changes the schema.
 * For workers whose database role can't, while another process (a
 * deployment's migration job) runs the migrations first.
 */
export function dbMigrationsSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.PILOTSWARM_SKIP_DB_MIGRATIONS === "1";
}

/**
 * Instead of migrating: checks that every migration in `migrations` is
 * recorded, and throws, naming the first missing one, when the schema is
 * behind this code, so a worker started before the migrations fails at once
 * rather than on its first query. Later migrations from newer code are fine.
 * A version recorded under another migration's name is refused as
 * runMigrations refuses it.
 */
export async function assertMigrationsApplied(
    pool: any,
    schema: string,
    migrations: MigrationEntry[],
    label: string,
): Promise<void> {
    let recorded: Array<{ version: string; name: string }> = [];
    try {
        ({ rows: recorded } = await pool.query(`SELECT version, name FROM "${schema}".schema_migrations`));
    } catch (err: any) {
        // 42P01 undefined_table, 3F000 invalid_schema_name: nothing is migrated.
        if (err?.code !== "42P01" && err?.code !== "3F000") throw err;
    }
    assertRecordedMigrationNames(schema, recorded, migrations, label);
    const applied = new Set(recorded.map((row) => row.version));
    const missing = migrations.filter((migration) => !applied.has(migration.version));
    if (missing.length > 0) {
        const more = missing.length > 1 ? ` and ${missing.length - 1} more` : "";
        throw new Error(
            `${label} schema "${schema}" lacks migration ${missing[0].version} (${missing[0].name})${more}. `
            + "PILOTSWARM_SKIP_DB_MIGRATIONS=1 keeps this process from migrating, so run the migrations first.",
        );
    }
}

/** Stable 32-bit hash of a schema name combined with a per-system seed. */
function hashSchemaName(schema: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < schema.length; i++) {
        hash = ((hash << 5) - hash + schema.charCodeAt(i)) | 0;
    }
    return hash;
}
