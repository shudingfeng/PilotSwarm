// The database role Job (deploy/providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs)
// against a real PostgreSQL server: the migrations and the grants as an
// administrator, then what a Windows worker does, as a member of the group
// and with PILOTSWARM_SKIP_DB_MIGRATIONS=1.
//
// Skipped unless PS_TEST_DB_ROLE_JOB_DATABASE_URL names a database this test
// may create schemas and roles in, as a superuser. It has a variable of its
// own: scripts/run-tests.sh sets PS_TEST_DATABASE_URL for every full run, to a
// server whose user need not be a superuser (HorizonDB, for one). It also
// needs the workspace's packages and a built SDK (`npm ci`, then
// `npm run build --workspace=packages/sdk`). Every schema and role it creates
// has a name unique to the run and is dropped at the end.
//
//   PS_TEST_DB_ROLE_JOB_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/pilotswarm \
//     node --test deploy/scripts/test/db-role-job-postgres.test.mjs
//
// A local Microsoft Entra principal can't exist, so the members are LOGIN
// roles with a password, created through the Job's `principals` hook.

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteIdent, runDbRoleJob } from "../../providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs";

const DATABASE_URL = process.env.PS_TEST_DB_ROLE_JOB_DATABASE_URL;
const skip = DATABASE_URL ? false : "set PS_TEST_DB_ROLE_JOB_DATABASE_URL to run the database role Job against a real PostgreSQL server";

const RUN = randomBytes(4).toString("hex");
const MODEL_KEY_ENV = `PS_TEST_DBROLE_KEY_${RUN.toUpperCase()}`;
const created = { schemas: [], roles: [], dirs: [] };
let deps;
let admin;

const schemasFor = (label) => ({
  duroxide: `ps_test_dx_dbrole_${label}_${RUN}`,
  cms: `ps_test_cms_dbrole_${label}_${RUN}`,
  facts: `ps_test_facts_dbrole_${label}_${RUN}`,
});

function urlAs(role, password) {
  const url = new URL(DATABASE_URL);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  return url.toString();
}

function quiet() {
  const lines = [];
  return { lines, log: (message) => lines.push(message) };
}

async function setup() {
  if (deps) return deps;
  const [sdk, pgModule, duroxideModule] = await Promise.all([import("pilotswarm-sdk"), import("pg"), import("duroxide")]);
  const pg = pgModule.default ?? pgModule;
  const duroxide = duroxideModule.PostgresProvider ? duroxideModule : duroxideModule.default;
  admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  const dir = mkdtempSync(join(tmpdir(), "ps-dbrole-pg-"));
  created.dirs.push(dir);
  const catalogPath = join(dir, "model_providers.json");
  writeFileSync(catalogPath, JSON.stringify({
    providers: [{
      id: "dbrole-test",
      type: "openai",
      baseUrl: "https://models.example.invalid/openai/v1",
      apiKey: `env:${MODEL_KEY_ENV}`,
      models: [{ name: "test-model", description: "A model no test calls." }, { name: "other-model", description: "Another." }],
    }],
    defaultModel: "dbrole-test:test-model",
  }, null, 2));
  process.env[MODEL_KEY_ENV] = "not-a-real-key";
  deps = { sdk, pg, duroxide, dir, catalogPath };
  return deps;
}

// The members as LOGIN roles, made by the administrator connection.
function localPrincipals(passwords) {
  const made = [];
  return {
    made,
    async ensure({ name }) {
      if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount > 0) return "exists";
      await admin.query(`CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD '${passwords[name]}'`);
      created.roles.push(name);
      made.push(name);
      return "created";
    },
  };
}

function jobEnv({ url, schemas, member, catalogPath }) {
  return {
    DATABASE_URL: url,
    PILOTSWARM_DUROXIDE_SCHEMA: schemas.duroxide,
    PILOTSWARM_CMS_SCHEMA: schemas.cms,
    PILOTSWARM_FACTS_SCHEMA: schemas.facts,
    PS_MODEL_PROVIDERS_PATH: catalogPath,
    WIN_WORKER_IDENTITY_NAME: member,
    EXPECTED_WIN_WORKER_OID: "11111111-1111-1111-1111-111111111111",
  };
}

async function auditCount(schemas, actions) {
  const { rows } = await admin.query(
    `SELECT count(*)::int AS n FROM ${quoteIdent(schemas.cms)}.authz_audit WHERE action = ANY($1::text[])`, [actions]);
  return rows[0].n;
}

async function privilege(sql, params) {
  return (await admin.query(sql, params)).rows[0].allowed;
}

// What a Windows worker does with the database, as `member`: duroxide's own
// connect, the SDK's worker, client and management client with the
// migrations skipped, a CMS and a facts write, and the audit table.
async function exerciseMember({ member, password, schemas }) {
  const { sdk, pg, duroxide, dir, catalogPath } = deps;
  const url = urlAs(member, password);
  const saved = process.env.PILOTSWARM_SKIP_DB_MIGRATIONS;
  process.env.PILOTSWARM_SKIP_DB_MIGRATIONS = "1";
  const options = {
    store: url, duroxideSchema: schemas.duroxide, cmsSchema: schemas.cms, factsSchema: schemas.facts, modelProvidersPath: catalogPath,
  };
  const stateDir = mkdtempSync(join(dir, "worker-"));
  const worker = new sdk.PilotSwarmWorker({
    ...options, sessionStateDir: stateDir, workerNodeId: `dbrole-${RUN}`, disableManagementAgents: true, logLevel: "error",
  });
  const client = new sdk.PilotSwarmClient(options);
  const mgmt = new sdk.PilotSwarmManagementClient(options);
  const db = new pg.Client({ connectionString: url });
  try {
    // duroxide connects without DDL when its schema and migrations are in place.
    await duroxide.PostgresProvider.connectWithSchema(url, schemas.duroxide);

    await worker.start();
    await client.start();
    await mgmt.start();
    assert.ok(Array.isArray(await client.listSessions()));
    assert.ok(Array.isArray(await mgmt.listSessions()));
    const principal = { provider: "test", subject: `dbrole-${RUN}`, email: null, displayName: "Test user" };
    assert.equal(await mgmt.recordUserRole(principal, "user"), "user");
    await mgmt.recordAuthzAudit({ actor: principal, action: "dbrole.test", target: null, decision: "allow" });
    await mgmt.storeFact({ key: `dbrole/test/${RUN}`, value: { ok: true }, shared: true });
    const { facts } = await mgmt.readFacts({ keyPattern: `dbrole/test/${RUN}` }, { admin: true });
    assert.equal(facts.length, 1);

    await db.connect();
    const audit = `${quoteIdent(schemas.cms)}.authz_audit`;
    const { rows: [row] } = await db.query(
      `INSERT INTO ${audit} (action, decision) VALUES ('dbrole.direct', 'allow') RETURNING audit_id`);
    assert.ok(Number(row.audit_id) > 0);
    const { rows: [count] } = await db.query(`SELECT count(*)::int AS n FROM ${audit} WHERE action LIKE 'dbrole.%'`);
    assert.equal(count.n, 2);
    const refused = async (sql, pattern = /permission denied|must be owner/) => {
      await assert.rejects(db.query(sql), (error) => {
        assert.equal(error.code, "42501", `${sql}: ${error.message}`);
        assert.match(error.message, pattern);
        return true;
      }, sql);
    };
    await refused(`UPDATE ${audit} SET reason = 'changed' WHERE audit_id = ${Number(row.audit_id)}`);
    await refused(`DELETE FROM ${audit} WHERE audit_id = ${Number(row.audit_id)}`);
    await refused(`TRUNCATE ${audit}`);
    await refused(`SELECT setval(pg_get_serial_sequence('${schemas.cms}.authz_audit', 'audit_id'), 1)`);
    await refused(`CREATE TABLE ${quoteIdent(schemas.cms)}.dbrole_probe (id int)`);
    await refused(`CREATE TABLE public.${quoteIdent(`dbrole_probe_${RUN}`)} (id int)`);
    await refused(`CREATE SCHEMA ${quoteIdent(`dbrole_probe_${RUN}`)}`);
    await refused(`ALTER TABLE ${audit} ADD COLUMN probe int`);
    await refused(`TRUNCATE ${quoteIdent(schemas.cms)}.users`);
    await refused(`TRUNCATE ${quoteIdent(schemas.duroxide)}.instances`);
  } finally {
    await db.end().catch(() => {});
    await Promise.allSettled([worker.stop(), client.stop(), mgmt.stop()]);
    if (saved === undefined) delete process.env.PILOTSWARM_SKIP_DB_MIGRATIONS;
    else process.env.PILOTSWARM_SKIP_DB_MIGRATIONS = saved;
  }
}

after(async () => {
  if (!DATABASE_URL) return;
  delete process.env[MODEL_KEY_ENV];
  if (admin) {
    for (const schema of created.schemas) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
    for (const role of created.roles.reverse()) {
      await admin.query(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`).catch(() => {});
    }
    await admin.end().catch(() => {});
  }
  for (const dir of created.dirs) rmSync(dir, { recursive: true, force: true });
});

test("as a superuser, the Job migrates, creates the group and its member and sets the defaults; a later run puts a changed default back, and the next changes nothing", { skip, timeout: 600_000 }, async () => {
  const { sdk, pg, catalogPath } = await setup();
  const schemas = schemasFor("su");
  created.schemas.push(...Object.values(schemas));
  const group = `ps_test_wg_su_${RUN}`;
  const member = `ps_test_ww_su_${RUN}`;
  const password = randomBytes(18).toString("base64url");
  created.roles.push(group);
  const env = jobEnv({ url: DATABASE_URL, schemas, member, catalogPath });

  const principals = localPrincipals({ [member]: password });
  const first = quiet();
  const result = await runDbRoleJob({ env, sdk, pg, principals, group, log: first.log });
  assert.deepEqual(result.layout.schemas, [schemas.duroxide, schemas.cms, schemas.facts]);
  assert.deepEqual(principals.made, [member]);
  // The first start of a management client seeds the cluster default from
  // the catalog; the system default is the Job's.
  assert.deepEqual(result.defaults, { cluster: false, system: true });
  assert.ok(first.lines.some((line) => line.includes(`Created ${group}`)), first.lines.join("\n"));

  const { rows: [role] } = await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [group]);
  assert.equal(role.rolcanlogin, false);
  assert.equal(await privilege("SELECT pg_has_role($1, $2, 'USAGE') AS allowed", [member, group]), true);
  const audit = `${schemas.cms}.authz_audit`;
  for (const [what, want] of [["SELECT", true], ["INSERT", true], ["UPDATE", false], ["DELETE", false], ["TRUNCATE", false], ["TRIGGER", false], ["REFERENCES", false]]) {
    assert.equal(await privilege("SELECT has_table_privilege($1, $2, $3) AS allowed", [group, audit, what]), want, `authz_audit ${what}`);
  }
  for (const [what, want] of [["USAGE", true], ["SELECT", false], ["UPDATE", false]]) {
    assert.equal(await privilege("SELECT has_sequence_privilege($1, pg_get_serial_sequence($2, 'audit_id'), $3) AS allowed", [group, audit, what]), want, `audit sequence ${what}`);
  }
  for (const [what, want] of [["SELECT", true], ["INSERT", true], ["UPDATE", true], ["DELETE", true], ["TRUNCATE", false]]) {
    assert.equal(await privilege("SELECT has_table_privilege($1, $2, $3) AS allowed", [group, `${schemas.cms}.users`, what]), want, `users ${what}`);
  }

  const mgmt = new sdk.PilotSwarmManagementClient({
    store: DATABASE_URL, duroxideSchema: schemas.duroxide, cmsSchema: schemas.cms, factsSchema: schemas.facts, modelProvidersPath: catalogPath,
  });
  const viewer = { principal: null, isAdmin: true };
  await mgmt.start();
  try {
    const defaults = await mgmt.getModelDefaults(viewer);
    assert.equal(defaults.clusterSession.configured.model, "dbrole-test:test-model");
    assert.equal(defaults.system.configured.model, "dbrole-test:test-model");
    // An administrator picks another cluster default in the portal.
    await mgmt.setModelDefault(viewer, { scope: "cluster", provider: "dbrole-test", model: "dbrole-test:other-model" });
  } finally {
    await mgmt.stop();
  }

  // The next run puts the catalog's default back, and only that one.
  const second = await runDbRoleJob({ env, sdk, pg, principals, group, log: quiet().log });
  assert.deepEqual(second.defaults, { cluster: true, system: false });

  const actions = ["setModelDefault", "setSystemModelDefault"];
  const before = await auditCount(schemas, actions);
  const third = quiet();
  const again = await runDbRoleJob({ env, sdk, pg, principals, group, log: third.log });
  assert.deepEqual(principals.made, [member], "the member is not created again");
  assert.deepEqual(again.defaults, { cluster: false, system: false });
  assert.equal(await auditCount(schemas, actions), before, "no default is set again");
  assert.ok(!third.lines.some((line) => line.includes("Created") || line.includes("Added")), third.lines.join("\n"));

  await exerciseMember({ member, password, schemas });
});

test("as a non-superuser administrator that may create roles, like the Entra administrator, the Job does the same", { skip, timeout: 600_000 }, async () => {
  const { sdk, pg, catalogPath } = await setup();
  const schemas = schemasFor("adm");
  created.schemas.push(...Object.values(schemas));
  const administrator = `ps_test_adm_${RUN}`;
  const administratorPassword = randomBytes(18).toString("base64url");
  const group = `ps_test_wg_adm_${RUN}`;
  const member = `ps_test_ww_adm_${RUN}`;
  const password = randomBytes(18).toString("base64url");
  const { rows: [{ database }] } = await admin.query("SELECT current_database() AS database");
  await admin.query(`CREATE ROLE ${quoteIdent(administrator)} LOGIN CREATEROLE PASSWORD '${administratorPassword}'`);
  created.roles.push(administrator, group);
  await admin.query(`GRANT CREATE ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(administrator)}`);

  // The administrator makes the members too, as pgaadauth would.
  const administratorClient = new pg.Client({ connectionString: urlAs(administrator, administratorPassword) });
  await administratorClient.connect();
  const made = [];
  const principals = {
    async ensure({ name }) {
      if ((await administratorClient.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount > 0) return "exists";
      await administratorClient.query(`CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD '${password}'`);
      created.roles.push(name);
      made.push(name);
      return "created";
    },
  };
  try {
    // A stamp whose portal first ran with another catalog default.
    const otherCatalog = join(deps.dir, "other-default.json");
    writeFileSync(otherCatalog, readFileSync(catalogPath, "utf8").replace("dbrole-test:test-model", "dbrole-test:other-model"));
    const earlier = new sdk.PilotSwarmManagementClient({
      store: urlAs(administrator, administratorPassword), duroxideSchema: schemas.duroxide, cmsSchema: schemas.cms, factsSchema: schemas.facts,
      modelProvidersPath: otherCatalog,
    });
    await earlier.start();
    await earlier.stop();

    const env = jobEnv({ url: urlAs(administrator, administratorPassword), schemas, member, catalogPath });
    const first = await runDbRoleJob({ env, sdk, pg, principals, group, log: quiet().log });
    assert.deepEqual(made, [member]);
    assert.deepEqual(first.defaults, { cluster: true, system: true });
    const again = await runDbRoleJob({ env, sdk, pg, principals, group, log: quiet().log });
    assert.deepEqual(made, [member]);
    assert.deepEqual(again.defaults, { cluster: false, system: false });
  } finally {
    await administratorClient.end().catch(() => {});
    await admin.query(`REVOKE CREATE ON DATABASE ${quoteIdent(database)} FROM ${quoteIdent(administrator)}`).catch(() => {});
  }
  await exerciseMember({ member, password, schemas });
});
