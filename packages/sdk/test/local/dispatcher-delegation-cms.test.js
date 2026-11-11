/**
 * Migration 0088 — each user's opt-in to the deployment's dispatcher, and its
 * two stored procedures. Database only: no workers, no model.
 *
 * Why each block exists:
 *  - 0088 may change number before it merges, so it must only ADD objects: a
 *    column with a constant default and two new procedures. The upgrade test
 *    compares every procedure and every row across the migration.
 *  - The flag has its own column because profile_settings is replaced
 *    wholesale on every preference save; a save must not touch the opt-in.
 *  - Turning the flag off must keep the dispatcher's shares (no access
 *    procedure reads the flag), so turning it back on restores access.
 *
 * Run: PS_TEST_DATABASE_URL=… npx vitest run test/local/dispatcher-delegation-cms.test.js
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { useSuiteEnv } from "../helpers/local-env.js";

const CMS_LOCK_SEED = 0x63_6D_73;
const getEnv = useSuiteEnv(import.meta.url);

const persona = (id) => ({ provider: "dev", subject: id, email: `${id}@dev.local`, displayName: id.charAt(0).toUpperCase() + id.slice(1) });
const ALICE = persona("alice");
const BOB = persona("bob");
const DISPATCHER = { provider: "dev", subject: "dispatcher-app", email: null, displayName: "Dispatcher app" };

/** Migrate the suite's CMS schema (through `through`, or all), then run with a pool and an uninitialized catalog. */
async function withCms(run, through = null) {
    const env = getEnv();
    const schema = env.cmsSchema;
    const pool = new pg.Pool({ connectionString: env.store, max: 4 });
    const catalog = await PgSessionCatalog.create(env.store, schema);
    try {
        await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter((m) => !through || m.version <= through), CMS_LOCK_SEED);
        await run({ pool, schema, catalog });
    } finally {
        await catalog.close();
        await pool.end();
    }
}

async function functionDefinitions(pool, schema) {
    const { rows } = await pool.query(
        `SELECT p.proname AS name, p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
          ORDER BY 2`,
        [schema],
    );
    return rows;
}

describe("dispatcher delegation in the CMS (migration 0088)", () => {
    it("adds only a false-by-default column and two new procedures, changing no procedure and no row", async () => {
        await withCms(async ({ pool, schema, catalog }) => {
            await catalog.setUserRole(ALICE, "user");
            await catalog.setUserProfileSettings(ALICE, { theme: "dark" });
            await catalog.setUserRole(BOB, "admin");
            await catalog.createSession("s-upgrade", { model: "m", owner: ALICE });
            await catalog.grantSessionShare("s-upgrade", DISPATCHER, "write", ALICE);

            const before = await functionDefinitions(pool, schema);
            const users = (await pool.query(`SELECT * FROM "${schema}".users ORDER BY user_id`)).rows;
            const shares = (await pool.query(`SELECT * FROM "${schema}".session_shares ORDER BY session_id, user_id`)).rows;
            const records = (await pool.query(`SELECT * FROM "${schema}".schema_migrations ORDER BY version`)).rows;
            expect(records.at(-1).version).toBe("0087");

            await catalog.initialize();

            const after = await functionDefinitions(pool, schema);
            const beforeBySignature = new Map(before.map((row) => [row.signature, row.definition]));
            for (const row of after) {
                if (beforeBySignature.has(row.signature)) {
                    expect(row.definition, `${row.signature} must not be replaced`).toBe(beforeBySignature.get(row.signature));
                }
            }
            expect(after.length).toBe(before.length + 2);
            expect(after.filter((row) => !beforeBySignature.has(row.signature)).map((row) => row.name).sort())
                .toEqual(["cms_get_user_dispatcher_delegation", "cms_set_user_dispatcher_delegation"]);

            const column = (await pool.query(
                `SELECT data_type, is_nullable, column_default FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'allow_dispatcher_delegation'`,
                [schema],
            )).rows[0];
            expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });

            const upgraded = (await pool.query(`SELECT * FROM "${schema}".users ORDER BY user_id`)).rows;
            expect(upgraded.map(({ allow_dispatcher_delegation, ...rest }) => rest)).toEqual(users);
            expect(upgraded.every((row) => row.allow_dispatcher_delegation === false)).toBe(true);
            expect((await pool.query(`SELECT * FROM "${schema}".session_shares ORDER BY session_id, user_id`)).rows).toEqual(shares);

            const upgradedRecords = (await pool.query(`SELECT * FROM "${schema}".schema_migrations ORDER BY version`)).rows;
            expect(upgradedRecords.slice(0, -1)).toEqual(records);
            expect(upgradedRecords.at(-1)).toMatchObject({ version: "0088", name: "dispatcher_delegation" });
        }, "0087");
    });

    it("reads false for anyone who never opted in, and stores exactly what the user sets", async () => {
        await withCms(async ({ pool, schema, catalog }) => {
            expect(await catalog.getUserDispatcherDelegation(persona("nobody"))).toBe(false);
            expect(await catalog.getUserDispatcherDelegation({ provider: "", subject: "" })).toBe(false);
            await expect(catalog.setUserDispatcherDelegation({ provider: "", subject: "" }, true)).rejects.toThrow(/provider and subject/);

            // A first write registers the user, like the profile and role writers.
            const carol = persona("carol");
            expect(await catalog.setUserDispatcherDelegation(carol, true)).toBe(true);
            expect(await catalog.getUserDispatcherDelegation({ provider: "dev", subject: "carol" })).toBe(true);
            const profile = await catalog.getUserProfile(carol);
            expect([profile.email, profile.displayName]).toEqual(["carol@dev.local", "Carol"]);

            expect(await catalog.setUserDispatcherDelegation(carol, false)).toBe(false);
            expect(await catalog.getUserDispatcherDelegation(carol)).toBe(false);
            expect(await catalog.setUserDispatcherDelegation(carol, true)).toBe(true);
            expect(await catalog.getUserDispatcherDelegation(carol)).toBe(true);
            expect(await catalog.getUserDispatcherDelegation(BOB), "only that user's row changes").toBe(false);

            const direct = await pool.query(`SELECT "${schema}".cms_get_user_dispatcher_delegation(' dev ', ' carol ') AS enabled`);
            expect(direct.rows[0].enabled).toBe(true);
            await expect(pool.query(`SELECT "${schema}".cms_set_user_dispatcher_delegation('dev', 'carol', NULL, NULL, NULL)`))
                .rejects.toThrow(/true or false/);
            expect(await catalog.getUserDispatcherDelegation(carol)).toBe(true);
        });
    });

    it("keeps the opt-in apart from profile settings, and keeps the dispatcher's share while it is off", async () => {
        await withCms(async ({ catalog }) => {
            await catalog.initialize();
            await catalog.createSession("s-delegated", { model: "m", owner: ALICE, visibility: "private" });
            await catalog.grantSessionShare("s-delegated", DISPATCHER, "write", DISPATCHER);
            await catalog.setUserDispatcherDelegation(ALICE, true);

            // A preference save replaces profile_settings wholesale.
            await catalog.setUserProfileSettings(ALICE, { theme: "dark" });
            expect(await catalog.getUserDispatcherDelegation(ALICE)).toBe(true);
            await catalog.setUserDispatcherDelegation(ALICE, false);
            expect((await catalog.getUserProfile(ALICE)).profileSettings.theme).toBe("dark");

            // The catalog does not enforce delegation: the portal does. Off
            // keeps the share, so on restores the same access.
            const shares = await catalog.listSessionShares("s-delegated");
            expect(shares.map((share) => [share.subject, share.access])).toEqual([["dispatcher-app", "write"]]);
            const access = await catalog.getSessionAccess("s-delegated", DISPATCHER);
            expect([access.visibility, access.owner.subject, access.viewerShareAccess]).toEqual(["private", "alice", "write"]);
            await catalog.setUserDispatcherDelegation(ALICE, true);
            expect(await catalog.getUserDispatcherDelegation(ALICE)).toBe(true);
            expect((await catalog.listSessionShares("s-delegated")).length).toBe(1);
        });
    });

    it("the direct management client reads and writes the named user's opt-in", async () => {
        await withCms(async ({ catalog }) => {
            await catalog.initialize();
            const mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
            mgmt._catalog = catalog;
            mgmt._started = true;
            expect(await mgmt.setMyDispatcherDelegation(true, ALICE)).toEqual({ enabled: true });
            expect(await mgmt.getMyDispatcherDelegation(ALICE)).toEqual({ enabled: true });
            expect(await mgmt.getMyDispatcherDelegation(BOB)).toEqual({ enabled: false });
            expect(await mgmt.getMyDispatcherDelegation()).toEqual({ enabled: false });
            expect(await mgmt.setMyDispatcherDelegation(true)).toEqual({ enabled: true });
            expect(await catalog.getUserDispatcherDelegation({ provider: "local", subject: "default" })).toBe(true);
        });
    });
});
