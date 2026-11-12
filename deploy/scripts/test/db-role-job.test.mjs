// The database role Job of the Windows worker pool: its decisions
// (deploy/providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs) against a
// database and an SDK the test answers, its entry point, its manifest and run
// (deploy/providers/azure/deploy-steps/db-role-job.mjs) against a kubectl the
// test answers, its wiring into stage-manifests.mjs and deploy.mjs, and the
// Windows image's upgrade script taking the staged manifest. The same Job
// against a real PostgreSQL server is db-role-job-postgres.test.mjs.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { REPO_ROOT, parseEnvFile, templateEnvPath } from "../lib/common.mjs";
import { AKS_ENV_DEFAULTS } from "../lib/aks-env.mjs";
import { DATABASE_INPUT_KEYS } from "../lib/database-env.mjs";
import { stageManifests } from "../lib/stage-manifests.mjs";
import {
  COMPLETE_MARKER,
  SQL,
  WORKER_GROUP_ROLE,
  databaseLayout,
  planGroupRole,
  planMemberGrants,
  planSchemaGrants,
  privilegeProblems,
  readJobSettings,
  redact,
  runDbRoleJob,
  withDatabase,
} from "../../providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs";
import {
  DB_ROLE_JOB_NAME,
  dbRoleJobManifestPath,
  jobState,
  renderDbRoleJobManifest,
  runStagedDbRoleJob,
  stagedJob,
} from "../../providers/azure/deploy-steps/db-role-job.mjs";

const SCRIPT = join(REPO_ROOT, "deploy/providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs");
const WORKER_OID = "33333333-3333-3333-3333-333333333333";
const COORDINATION_OID = "44444444-4444-4444-4444-444444444444";
const DATABASE = "postgresql://psstamp-csi-mid@stamp-pg.postgres.database.azure.com:5432/pilotswarm?sslmode=require";
const DX = "ps_duroxide";
const CMS = "copilot_sessions";
const FACTS = "pilotswarm_facts";
const SCHEMAS = [DX, CMS, FACTS];
const AUDIT = Object.freeze({ schema: CMS, table: "authz_audit", sequence: { schema: CMS, name: "authz_audit_audit_id_seq" } });

// The Job's env as the staged manifest gives it.
const jobEnv = (extra = {}) => ({
  DATABASE_URL: DATABASE,
  PILOTSWARM_CMS_FACTS_DATABASE_URL: DATABASE,
  PILOTSWARM_DB_AAD_USER: "psstamp-csi-mid",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  PS_MODEL_PROVIDERS_PATH: "/app/db-role-job/model_providers.json",
  WIN_WORKER_IDENTITY_NAME: "psstamp-win-worker-mid",
  EXPECTED_WIN_WORKER_OID: WORKER_OID,
  COORDINATION_IDENTITY_NAME: "psstamp-linux-worker-mid",
  COORDINATION_IDENTITY_PRINCIPAL_ID: COORDINATION_OID,
  ...extra,
});

// ─── Settings ───

test("the Job's settings: the Windows workers' identity and the coordination host's, both required", () => {
  const settings = readJobSettings(jobEnv({ COORDINATION_IDENTITY_PRINCIPAL_ID: COORDINATION_OID.toUpperCase() }));
  assert.deepEqual(settings.members, [
    { label: "the Windows workers' identity", name: "psstamp-win-worker-mid", oid: WORKER_OID },
    { label: "the coordination host's identity", name: "psstamp-linux-worker-mid", oid: COORDINATION_OID },
  ]);
  assert.equal(settings.catalogPath, "/app/db-role-job/model_providers.json");
});

test("the Job refuses settings it can't act on, before it touches the database", () => {
  for (const [label, extra, message] of [
    ["migrations skipped", { PILOTSWARM_SKIP_DB_MIGRATIONS: "1" }, /PILOTSWARM_SKIP_DB_MIGRATIONS=1 .* this Job is what migrates/],
    ["no database", { DATABASE_URL: undefined }, /DATABASE_URL must be a postgres/],
    ["not PostgreSQL", { DATABASE_URL: "sqlite::memory:" }, /DATABASE_URL must be a postgres/],
    ["catalog database", { PILOTSWARM_CMS_FACTS_DATABASE_URL: "mysql://h/d" }, /PILOTSWARM_CMS_FACTS_DATABASE_URL must be a postgres/],
    ["no catalog", { PS_MODEL_PROVIDERS_PATH: "__PS_UNSET__" }, /PS_MODEL_PROVIDERS_PATH must name the portal's model catalog/],
    ["no identity", { WIN_WORKER_IDENTITY_NAME: "" }, /WIN_WORKER_IDENTITY_NAME is not set/],
    ["no object ID", { EXPECTED_WIN_WORKER_OID: undefined }, /EXPECTED_WIN_WORKER_OID must be the identity's Microsoft Entra object ID/],
    ["bad object ID", { EXPECTED_WIN_WORKER_OID: "not-a-guid" }, /EXPECTED_WIN_WORKER_OID must be/],
    ["reserved name", { WIN_WORKER_IDENTITY_NAME: "pg_monitor" }, /a role name PostgreSQL reserves/],
    ["reserved word", { WIN_WORKER_IDENTITY_NAME: "PUBLIC" }, /a role name PostgreSQL reserves/],
    ["long name", { WIN_WORKER_IDENTITY_NAME: "x".repeat(64) }, /longer than PostgreSQL's 63-byte role names/],
    ["control character", { WIN_WORKER_IDENTITY_NAME: "a\nb" }, /holds a control character/],
    ["the group", { WIN_WORKER_IDENTITY_NAME: WORKER_GROUP_ROLE }, /can't be named pilotswarm_worker_group/],
    ["no coordination identity", { COORDINATION_IDENTITY_NAME: "__PS_UNSET__" }, /COORDINATION_IDENTITY_NAME is not set/],
    ["no coordination object ID", { COORDINATION_IDENTITY_PRINCIPAL_ID: undefined }, /COORDINATION_IDENTITY_PRINCIPAL_ID must be the identity's Microsoft Entra object ID/],
    ["the group as the host", { COORDINATION_IDENTITY_NAME: WORKER_GROUP_ROLE }, /the coordination host's identity can't be named pilotswarm_worker_group/],
    ["one identity twice", { COORDINATION_IDENTITY_NAME: "PSSTAMP-WIN-WORKER-MID" }, /must be two identities/],
    ["one object twice", { COORDINATION_IDENTITY_PRINCIPAL_ID: WORKER_OID }, /must be two identities/],
  ]) {
    const env = jobEnv(extra);
    for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
    assert.throws(() => readJobSettings(env), message, label);
  }
});

test("the grants go to one database: the three stores may sign in as different roles, but not live apart", () => {
  const storage = (overrides = {}) => ({
    duroxide: { provider: "postgres", url: "postgresql://admin@db.example.com:5432/pilotswarm", schema: DX },
    runtime: {
      provider: "postgres",
      url: "postgresql://admin@db.example.com:5432/pilotswarm",
      sessionCatalogUrl: "postgresql://other-user@DB.example.com/pilotswarm?sslmode=require",
      factStoreUrl: "postgresql://other-user@db.example.com:5432/pilotswarm",
      cmsSchema: CMS,
      factsSchema: FACTS,
      ...overrides,
    },
  });
  assert.deepEqual(databaseLayout(storage()), { schemas: SCHEMAS, auditSchema: CMS });
  assert.throws(() => databaseLayout(storage({ factStoreUrl: "postgresql://u@db.example.com:5432/facts" })),
    /must be in one database for the worker group, not .*db\.example\.com:5432\/facts \(facts store\)/);
  assert.throws(() => databaseLayout(storage({ provider: "horizondb" })), /selects another storage provider/);
  assert.throws(() => databaseLayout(storage({ cmsSchema: "" })), /The session catalog has no schema/);
});

// ─── Statements ───

test("the group is created NOLOGIN when missing, loses LOGIN, and is refused with a privilege only a superuser removes", () => {
  assert.deepEqual(planGroupRole(null), [`CREATE ROLE "${WORKER_GROUP_ROLE}" NOLOGIN`]);
  assert.deepEqual(planGroupRole({ rolcanlogin: true }), [`ALTER ROLE "${WORKER_GROUP_ROLE}" NOLOGIN`]);
  assert.deepEqual(planGroupRole({ rolcanlogin: false }), [], "an existing group is left as it is");
  for (const flag of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"]) {
    assert.throws(() => planGroupRole({ [flag]: true }), /exists with [A-Z]+; drop it/, flag);
  }
});

test("each schema gets USAGE, data access to its tables, sequences and routines, the same default privileges, and nothing more", () => {
  const statements = planSchemaGrants({ schemas: [DX], audit: AUDIT });
  const g = `"${WORKER_GROUP_ROLE}"`;
  assert.deepEqual(statements.slice(0, 12), [
    `GRANT USAGE ON SCHEMA "${DX}" TO ${g}`,
    `REVOKE CREATE ON SCHEMA "${DX}" FROM ${g}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA "${DX}" FROM ${g}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${DX}" TO ${g}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${DX}" FROM ${g}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${DX}" TO ${g}`,
    `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA "${DX}" TO ${g}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${DX}" REVOKE ALL ON TABLES FROM ${g}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${DX}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${g}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${DX}" REVOKE ALL ON SEQUENCES FROM ${g}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${DX}" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${g}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${DX}" GRANT EXECUTE ON ROUTINES TO ${g}`,
  ]);
  const all = planSchemaGrants({ schemas: SCHEMAS, audit: AUDIT, database: "pilotswarm" });
  assert.equal(all.length, 3 * 12 + 4);
  for (const schema of SCHEMAS) assert.ok(all.includes(`GRANT USAGE ON SCHEMA "${schema}" TO ${g}`), schema);
  for (const statement of all.filter((s) => s.startsWith("GRANT") || s.includes(" GRANT "))) {
    assert.doesNotMatch(statement, /TRUNCATE|TRIGGER|REFERENCES|CREATE|\bALL\b(?! (TABLES|SEQUENCES|ROUTINES) IN SCHEMA)/, statement);
  }
  assert.ok(!all.some((statement) => statement.includes("ON DATABASE")), "CREATE on the database is revoked only when the group holds it");
  assert.equal(planSchemaGrants({ schemas: [DX], audit: AUDIT, database: "pilot\"swarm", databaseCreate: true })[0],
    `REVOKE CREATE ON DATABASE "pilot""swarm" FROM ${g}`);
});

test("the audit table is the exception: SELECT and INSERT, and USAGE alone on its ID sequence, granted after the schema-wide grants", () => {
  const all = planSchemaGrants({ schemas: SCHEMAS, audit: AUDIT });
  const g = `"${WORKER_GROUP_ROLE}"`;
  assert.deepEqual(all.slice(-4), [
    `REVOKE ALL ON TABLE "${CMS}"."authz_audit" FROM ${g}`,
    `GRANT SELECT, INSERT ON TABLE "${CMS}"."authz_audit" TO ${g}`,
    `REVOKE ALL ON SEQUENCE "${CMS}"."authz_audit_audit_id_seq" FROM ${g}`,
    `GRANT USAGE ON SEQUENCE "${CMS}"."authz_audit_audit_id_seq" TO ${g}`,
  ]);
  const withoutSequence = planSchemaGrants({ schemas: [CMS], audit: { ...AUDIT, sequence: null } });
  assert.deepEqual(withoutSequence.slice(-2), [
    `REVOKE ALL ON TABLE "${CMS}"."authz_audit" FROM ${g}`,
    `GRANT SELECT, INSERT ON TABLE "${CMS}"."authz_audit" TO ${g}`,
  ]);
  assert.match(planSchemaGrants({ group: 'odd"group', schemas: ['odd"schema'], audit: AUDIT })[0], /^GRANT USAGE ON SCHEMA "odd""schema" TO "odd""group"$/);
});

test("members are granted the group once: a run that finds them in it grants nothing", () => {
  const members = [{ name: "psstamp-win-worker-mid" }, { name: "psstamp-linux-worker-mid" }];
  assert.deepEqual(planMemberGrants({ members }), [
    `GRANT "${WORKER_GROUP_ROLE}" TO "psstamp-win-worker-mid"`,
    `GRANT "${WORKER_GROUP_ROLE}" TO "psstamp-linux-worker-mid"`,
  ]);
  assert.deepEqual(planMemberGrants({ members, existing: ["psstamp-win-worker-mid"] }), [`GRANT "${WORKER_GROUP_ROLE}" TO "psstamp-linux-worker-mid"`]);
  assert.deepEqual(planMemberGrants({ members, existing: ["psstamp-win-worker-mid", "psstamp-linux-worker-mid", "someone-else"] }), []);
});

// ─── The check ───

const FULL = Object.freeze({ select: true, insert: true, update: true, delete: true, truncate: false, trigger: false, column_update: true, column_references: false });
const MEMBERS = [{ label: "the Windows workers' identity", name: "psstamp-win-worker-mid", oid: WORKER_OID }];

// What the verify* queries return for a group that has exactly its grants.
function granted({ schemas = SCHEMAS, members = MEMBERS } = {}) {
  return {
    role: { rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false },
    database: { connect: true, create: false },
    schemas: [...schemas.map((name) => ({ name, usage: true, create: false })), { name: "public", usage: true, create: false }],
    relations: [
      { schema: DX, name: "instances", ...FULL },
      { schema: CMS, name: "authz_audit", ...FULL, update: false, delete: false, column_update: false },
      { schema: CMS, name: "users", ...FULL },
      { schema: FACTS, name: "facts", ...FULL },
    ],
    sequences: [
      { schema: CMS, name: "authz_audit_audit_id_seq", usage: true, select: false, update: false },
      { schema: CMS, name: "users_user_id_seq", usage: true, select: true, update: true },
    ],
    routines: [{ schema: CMS, name: "copilot_sessions.cms_register_user(text,text,text,text)", execute: true }],
    members: members.map(({ name }) => ({ name, inherits: true })),
    defaults: schemas.flatMap((schema) => [
      ["r", ["DELETE", "INSERT", "SELECT", "UPDATE"]], ["S", ["SELECT", "UPDATE", "USAGE"]], ["f", ["EXECUTE"]],
    ].flatMap(([type, privileges]) => privileges.map((privilege) => ({ schema, type, privilege })))),
  };
}

test("the check passes a group with exactly its grants and names every difference", () => {
  const scope = { schemas: SCHEMAS, audit: AUDIT, members: MEMBERS };
  assert.deepEqual(privilegeProblems(scope, granted()), []);
  const changed = (edit) => {
    const observed = structuredClone(granted());
    edit(observed);
    return privilegeProblems(scope, observed);
  };
  for (const [label, edit, message] of [
    ["no group", (o) => { o.role = null; }, /the role pilotswarm_worker_group does not exist/],
    ["login", (o) => { o.role.rolcanlogin = true; }, /pilotswarm_worker_group can log in/],
    ["superuser", (o) => { o.role.rolsuper = true; }, /is a superuser/],
    ["database create", (o) => { o.database.create = true; }, /can create schemas in the database/],
    ["no connect", (o) => { o.database.connect = false; }, /can't connect to the database/],
    ["schema create", (o) => { o.schemas[1].create = true; }, /can create objects in schema copilot_sessions/],
    ["public create", (o) => { o.schemas[3].create = true; }, /can create objects in schema public/],
    ["no usage", (o) => { o.schemas[0].usage = false; }, /lacks USAGE on schema ps_duroxide/],
    ["schema missing", (o) => { o.schemas.splice(2, 1); }, /schema pilotswarm_facts does not exist/],
    ["audit update", (o) => { o.relations[1].update = true; }, /copilot_sessions\.authz_audit: pilotswarm_worker_group has UPDATE/],
    ["audit delete", (o) => { o.relations[1].delete = true; }, /authz_audit: pilotswarm_worker_group has DELETE/],
    ["audit column update", (o) => { o.relations[1].column_update = true; }, /authz_audit: .* can UPDATE some of its columns/],
    ["audit insert", (o) => { o.relations[1].insert = false; }, /authz_audit: pilotswarm_worker_group lacks INSERT/],
    ["audit missing", (o) => { o.relations.splice(1, 1); }, /copilot_sessions\.authz_audit does not exist/],
    ["truncate", (o) => { o.relations[0].truncate = true; }, /ps_duroxide\.instances: pilotswarm_worker_group has TRUNCATE/],
    ["trigger", (o) => { o.relations[2].trigger = true; }, /users: pilotswarm_worker_group has TRIGGER/],
    ["references", (o) => { o.relations[3].column_references = true; }, /facts: pilotswarm_worker_group has REFERENCES/],
    ["table delete", (o) => { o.relations[2].delete = false; }, /users: pilotswarm_worker_group lacks DELETE/],
    ["audit sequence update", (o) => { o.sequences[0].update = true; }, /authz_audit_audit_id_seq: pilotswarm_worker_group has UPDATE/],
    ["audit sequence select", (o) => { o.sequences[0].select = true; }, /authz_audit_audit_id_seq: pilotswarm_worker_group has SELECT/],
    ["sequence usage", (o) => { o.sequences[1].usage = false; }, /users_user_id_seq: pilotswarm_worker_group lacks USAGE/],
    ["execute", (o) => { o.routines[0].execute = false; }, /cms_register_user\(text,text,text,text\): pilotswarm_worker_group lacks EXECUTE/],
    ["member missing", (o) => { o.members = []; }, /the role psstamp-win-worker-mid \(the Windows workers' identity\) does not exist/],
    ["member without inheritance", (o) => { o.members[0].inherits = false; }, /does not have pilotswarm_worker_group's privileges/],
    ["default truncate", (o) => { o.defaults.push({ schema: CMS, type: "r", privilege: "TRUNCATE" }); },
      /schema copilot_sessions: the migrating role's default table privileges .* are DELETE, INSERT, SELECT, TRUNCATE, UPDATE/],
    ["no defaults", (o) => { o.defaults = o.defaults.filter((row) => row.schema !== FACTS); }, /schema pilotswarm_facts: .* default routine privileges .* are none, not EXECUTE/],
  ]) {
    const problems = changed(edit);
    assert.ok(problems.some((problem) => message.test(problem)), `${label}: ${problems.join(" | ")}`);
  }
});

// ─── The Job's output ───

test("what the Job prints never holds a credential", () => {
  assert.equal(redact("connect postgresql://admin:s3cret@db.example.com:5432/d failed"), "connect postgresql://admin:***@db.example.com:5432/d failed");
  assert.equal(redact("password=hunter2; host=h"), "password=***; host=h");
  assert.equal(redact("token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0xx.c2lnbmF0dXJlLXN0dWZm used"), "token *** used");
  assert.equal(redact("postgresql://admin@db.example.com/d"), "postgresql://admin@db.example.com/d");
});

test("the Entra functions run on the server's postgres database, through either kind of pg config", () => {
  assert.deepEqual(withDatabase({ host: "h", database: "pilotswarm", user: "u" }, "postgres"), { host: "h", database: "postgres", user: "u" });
  assert.equal(withDatabase({ connectionString: "postgresql://u:p@h:5432/pilotswarm?x=1" }, "postgres").connectionString, "postgresql://u:p@h:5432/postgres?x=1");
});

// ─── A run, against a database and an SDK the test answers ───

const GROUP = WORKER_GROUP_ROLE;

function fakeDatabase({ roleExists = false, members = [], self = "psstamp-csi-mid", broken = null, failOn = null } = {}) {
  const state = {
    role: roleExists ? granted().role : null,
    members: [...members],
    statements: [],
    connections: [],
  };
  const answer = (sql, params) => {
    switch (sql) {
      case SQL.self: return [{ name: self, database: "pilotswarm" }];
      case SQL.role: return state.role ? [state.role] : [];
      case SQL.auditTable: return [{ present: true }];
      case SQL.auditSequence: return [{ schema: CMS, name: "authz_audit_audit_id_seq" }];
      case SQL.verifyDatabase: return [granted().database];
      case SQL.members: return state.members.map((name) => ({ name }));
      case SQL.verifySchemas: return granted().schemas;
      case SQL.verifyRelations: return broken === "audit" ? granted().relations.map((row) => ({ ...row, update: true })) : granted().relations;
      case SQL.verifySequences: return granted().sequences;
      case SQL.verifyRoutines: return granted().routines;
      case SQL.verifyMembers: return params[1].filter((name) => state.members.includes(name)).map((name) => ({ name, inherits: true }));
      case SQL.verifyDefaults: return granted().defaults;
      default: return [];
    }
  };
  class Client {
    constructor(config) {
      this.config = config;
    }
    async connect() {
      state.connections.push(this.config);
    }
    async end() {}
    async query(sql, params) {
      state.statements.push(sql);
      if (failOn && sql.startsWith(failOn)) throw new Error("permission denied for table users");
      if (sql.startsWith("CREATE ROLE")) state.role = granted().role;
      const grant = /^GRANT "[^"]+" TO "([^"]+)"$/.exec(sql);
      if (grant) state.members.push(grant[1]);
      const rows = answer(sql, params);
      return { rows, rowCount: rows.length };
    }
  }
  return { state, pg: { Client } };
}

function fakeSdk() {
  const events = [];
  const sdk = {
    resolveStorageConfig({ env, options }) {
      return {
        duroxide: { provider: "postgres", url: options.store, schema: env.PILOTSWARM_DUROXIDE_SCHEMA || DX },
        runtime: {
          provider: "postgres",
          url: options.store,
          sessionCatalogUrl: options.cmsFactsDatabaseUrl,
          factStoreUrl: options.cmsFactsDatabaseUrl,
          cmsSchema: env.PILOTSWARM_CMS_SCHEMA || CMS,
          factsSchema: env.PILOTSWARM_FACTS_SCHEMA || FACTS,
        },
      };
    },
    buildSessionCatalogPgClientConfig: (options) => ({ host: new URL(options.cmsFactsDatabaseUrl).hostname, database: "pilotswarm", user: options.aadDbUser }),
    PilotSwarmClient: class {
      constructor(options) { events.push(["client", options]); }
      async start() { events.push("client.start"); }
      async stop() { events.push("client.stop"); }
    },
    // The management client's calls that change a default model, recorded:
    // the Job makes none of them.
    PilotSwarmManagementClient: class {
      constructor(options) { events.push(["mgmt", options]); }
      async start() { events.push("mgmt.start"); }
      async stop() { events.push("mgmt.stop"); }
      async setModelDefault(viewer, input) { events.push(["setModelDefault", viewer, input]); }
      async setSystemModelDefault(viewer, input) { events.push(["setSystemModelDefault", viewer, input]); }
      async recordUserRole(principal, role) { events.push(["recordUserRole", principal.subject, role]); }
    },
  };
  return { sdk, events };
}

const setsDefault = (events) => events.some((event) => Array.isArray(event) && /^set|recordUserRole/.test(event[0]));

async function withCatalog(fn, catalog = { providers: [], defaultModel: "azure-foundry:gpt-5.4" }) {
  const dir = mkdtempSync(join(tmpdir(), "ps-dbrole-unit-"));
  try {
    const path = join(dir, "model_providers.json");
    writeFileSync(path, JSON.stringify(catalog));
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function principalsFake(existing = []) {
  const calls = [];
  return { calls, ensure: async ({ name, oid }) => { calls.push([name, oid]); return existing.includes(name) ? "exists" : "created"; } };
}

test("a first run migrates first, creates the group in one locked transaction, adds both members and checks; it sets no default model", async () => {
  await withCatalog(async (catalogPath) => {
    const { state, pg } = fakeDatabase();
    const { sdk, events } = fakeSdk();
    const principals = principalsFake();
    const lines = [];
    const result = await runDbRoleJob({ env: jobEnv({ PS_MODEL_PROVIDERS_PATH: catalogPath }), sdk, pg, principals, log: (line) => lines.push(line) });

    const [client, mgmt] = events.filter((event) => Array.isArray(event) && ["client", "mgmt"].includes(event[0])).map(([, options]) => options);
    for (const options of [client, mgmt]) {
      assert.deepEqual(options, {
        store: DATABASE, useManagedIdentity: true, cmsFactsDatabaseUrl: DATABASE, aadDbUser: "psstamp-csi-mid",
        modelProvidersPath: catalogPath, duroxideSchema: DX, cmsSchema: CMS, factsSchema: FACTS,
      }, "the portal's storage options and model catalog, with the schemas the grants cover");
    }
    const order = events.filter((event) => typeof event === "string");
    assert.deepEqual(order, ["client.start", "mgmt.start", "client.stop", "mgmt.stop"]);
    assert.deepEqual(state.connections, [{ host: "stamp-pg.postgres.database.azure.com", database: "pilotswarm", user: "psstamp-csi-mid" }]);

    const s = state.statements;
    const at = (prefix) => s.findIndex((statement) => statement.startsWith(prefix));
    assert.equal(s[0], SQL.self);
    assert.deepEqual(s.slice(1, 5), ["BEGIN", SQL.lock, SQL.role, `CREATE ROLE "${GROUP}" NOLOGIN`]);
    assert.ok(at("GRANT SELECT, INSERT ON TABLE") > at(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${CMS}"`));
    assert.ok(at("COMMIT") > at("GRANT USAGE ON SEQUENCE"), "every grant in the one transaction");
    assert.ok(at(`GRANT "${GROUP}" TO "psstamp-win-worker-mid"`) > at("COMMIT"));
    assert.ok(at(`GRANT "${GROUP}" TO "psstamp-linux-worker-mid"`) > at("COMMIT"));
    assert.ok(at(SQL.verifyRelations) > at(`GRANT "${GROUP}" TO`), "the check reads the result");
    assert.ok(!s.includes("ROLLBACK"));
    assert.deepEqual(principals.calls, [["psstamp-win-worker-mid", WORKER_OID], ["psstamp-linux-worker-mid", COORDINATION_OID]]);

    assert.ok(!setsDefault(events), "the catalog's defaultModel is the first start's seed, not the Job's");
    assert.deepEqual(Object.keys(result).sort(), ["layout", "members"]);
    assert.ok(lines.some((line) => line.includes(`Created ${GROUP}`)), lines.join("\n"));
    assert.ok(!lines.some((line) => /default model/.test(line)), lines.join("\n"));
  });
});

test("a later run grants everything again but creates nothing, adds nobody and sets no default", async () => {
  await withCatalog(async (catalogPath) => {
    const members = ["psstamp-win-worker-mid", "psstamp-linux-worker-mid"];
    const { state, pg } = fakeDatabase({ roleExists: true, members });
    const { sdk, events } = fakeSdk();
    const principals = principalsFake(members);
    await runDbRoleJob({ env: jobEnv({ PS_MODEL_PROVIDERS_PATH: catalogPath }), sdk, pg, principals, log: () => {} });
    assert.ok(!state.statements.some((statement) => /^(CREATE|ALTER) ROLE/.test(statement)));
    assert.ok(!state.statements.some((statement) => statement.startsWith(`GRANT "${GROUP}" TO`)));
    assert.ok(state.statements.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${FACTS}" TO "${GROUP}"`), "new objects get their grants");
    assert.ok(state.statements.includes(`GRANT SELECT, INSERT ON TABLE "${CMS}"."authz_audit" TO "${GROUP}"`));
    assert.deepEqual(principals.calls, [["psstamp-win-worker-mid", WORKER_OID], ["psstamp-linux-worker-mid", COORDINATION_OID]],
      "the principals are still checked");
    assert.ok(!setsDefault(events));
  });
});

test("a failed grant rolls back the transaction, a wrong privilege fails the check, and the clients stop either way", async () => {
  await withCatalog(async (catalogPath) => {
    const env = jobEnv({ PS_MODEL_PROVIDERS_PATH: catalogPath });
    const failing = fakeDatabase({ failOn: "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES" });
    const first = fakeSdk();
    await assert.rejects(runDbRoleJob({ env, sdk: first.sdk, pg: failing.pg, principals: principalsFake(), log: () => {} }), /permission denied for table users/);
    assert.ok(failing.state.statements.includes("ROLLBACK"));
    assert.ok(!failing.state.statements.includes("COMMIT"));
    assert.deepEqual(first.events.filter((event) => typeof event === "string").slice(-2), ["client.stop", "mgmt.stop"]);

    const broken = fakeDatabase({ broken: "audit" });
    const second = fakeSdk();
    await assert.rejects(runDbRoleJob({ env, sdk: second.sdk, pg: broken.pg, principals: principalsFake(), log: () => {} }),
      /pilotswarm_worker_group's privileges are not what the Job grants: .*copilot_sessions\.authz_audit: pilotswarm_worker_group has UPDATE/);
    assert.deepEqual(second.events.filter((event) => typeof event === "string").slice(-2), ["client.stop", "mgmt.stop"]);
  });
});

test("the Job refuses to add the role it signs in as, and stops before any grant", async () => {
  await withCatalog(async (catalogPath) => {
    for (const [self, label] of [["psstamp-win-worker-mid", "the Windows workers' identity"], ["psstamp-linux-worker-mid", "the coordination host's identity"]]) {
      const { state, pg } = fakeDatabase({ self });
      const { sdk } = fakeSdk();
      await assert.rejects(runDbRoleJob({ env: jobEnv({ PS_MODEL_PROVIDERS_PATH: catalogPath }), sdk, pg, principals: principalsFake(), log: () => {} }),
        new RegExp(`${label} is ${self}, the role the Job signs in as`));
      assert.deepEqual(state.statements, [SQL.self]);
    }
  });
});

// ─── The entry point ───

function runScript(path, env) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DATABASE_URL|PILOTSWARM_|PS_MODEL_PROVIDERS_PATH|WIN_WORKER_|EXPECTED_WIN_WORKER_OID|COORDINATION_IDENTITY_)/.test(key)));
  return spawnSync(process.execPath, [path], { encoding: "utf8", env: { ...childEnv, ...env } });
}

test("started by node, the Job fails closed on its settings and prints no credential; imported, it runs nothing", () => {
  const result = runScript(SCRIPT, { DATABASE_URL: "postgresql://admin:not-printed@db.example.com/pilotswarm" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[db-role-job\] failed: PS_MODEL_PROVIDERS_PATH must name the portal's model catalog/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("not-printed"));
  assert.ok(!result.stdout.includes(COMPLETE_MARKER));
});

test("the Job also starts through the links of a ConfigMap volume", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ps-dbrole-mount-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A ConfigMap volume: <mount>/<file> -> ..data/<file>, ..data -> ..<timestamp>.
  const mount = join(dir, "db-role-job");
  mkdirSync(mount);
  try {
    symlinkSync(join(REPO_ROOT, "deploy/providers/azure/deploy-steps"), join(mount, "..data"), "junction");
  } catch (error) {
    t.skip(`can't link a folder here: ${error.message}`);
    return;
  }
  const result = runScript(join(mount, "..data", "Setup-WinWorkerDbRole.mjs"), { DATABASE_URL: "postgresql://admin@db.example.com/pilotswarm" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\[db-role-job\] failed: PS_MODEL_PROVIDERS_PATH/);
});

// ─── The manifest ───

const portalEnv = (extra = {}) => ({
  IMAGE: "stub.azurecr.io/pilotswarm-portal:t1",
  NAMESPACE: "pilotswarm",
  DATABASE_URL: DATABASE,
  PILOTSWARM_CMS_FACTS_DATABASE_URL: DATABASE,
  PILOTSWARM_DB_AAD_USER: "psstamp-csi-mid",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  WIN_WORKER_IDENTITY_NAME: "psstamp-win-worker-mid",
  EXPECTED_WIN_WORKER_OID: WORKER_OID,
  COORDINATION_IDENTITY_NAME: "psstamp-linux-worker-mid",
  COORDINATION_IDENTITY_PRINCIPAL_ID: COORDINATION_OID,
  ...extra,
});
const CATALOG_TEXT = JSON.stringify({ providers: [], defaultModel: "azure-foundry:gpt-5.4" }, null, 2);
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf8");

function documents(text) {
  return text.split(/^---\s*$/m).map((part) => part.replace(/^\s*#.*$/gm, "").trim()).filter(Boolean).map((part) => JSON.parse(part));
}

test("the manifest holds the script and the staged catalog in a ConfigMap, and a Job that runs it as the portal", () => {
  const text = renderDbRoleJobManifest({ env: portalEnv(), catalogText: CATALOG_TEXT.replace(/\n/g, "\r\n"), scriptText: SCRIPT_TEXT });
  assert.equal(renderDbRoleJobManifest({ env: portalEnv(), catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT }), text, "deterministic, whatever the line ends");
  const [configMap, job, ...rest] = documents(text);
  assert.deepEqual(rest, []);
  assert.equal(configMap.kind, "ConfigMap");
  assert.deepEqual(configMap.metadata, { name: DB_ROLE_JOB_NAME, namespace: "pilotswarm", labels: { "app.kubernetes.io/name": "pilotswarm", "app.kubernetes.io/component": "db-role-job" } });
  assert.equal(configMap.data["Setup-WinWorkerDbRole.mjs"], SCRIPT_TEXT.replace(/\r\n/g, "\n"));
  assert.equal(configMap.data["model_providers.json"], CATALOG_TEXT);

  assert.equal(job.kind, "Job");
  assert.equal(job.apiVersion, "batch/v1");
  assert.deepEqual(job.metadata, configMap.metadata);
  assert.equal(job.spec.backoffLimit, 1);
  assert.equal(job.spec.activeDeadlineSeconds, 1800);
  const pod = job.spec.template;
  assert.equal(pod.metadata.labels["azure.workload.identity/use"], "true", "the portal's workload identity");
  assert.equal(pod.spec.serviceAccountName, "pilotswarm-portal");
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.deepEqual(pod.spec.securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } });
  const [container] = pod.spec.containers;
  assert.equal(container.image, "stub.azurecr.io/pilotswarm-portal:t1");
  assert.deepEqual(container.command, ["node", "/app/db-role-job/Setup-WinWorkerDbRole.mjs"]);
  assert.deepEqual(Object.fromEntries(container.env.map(({ name, value }) => [name, value])), {
    DATABASE_URL: DATABASE,
    PILOTSWARM_CMS_FACTS_DATABASE_URL: DATABASE,
    PILOTSWARM_DB_AAD_USER: "psstamp-csi-mid",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    WIN_WORKER_IDENTITY_NAME: "psstamp-win-worker-mid",
    EXPECTED_WIN_WORKER_OID: WORKER_OID,
    COORDINATION_IDENTITY_NAME: "psstamp-linux-worker-mid",
    COORDINATION_IDENTITY_PRINCIPAL_ID: COORDINATION_OID,
    PS_MODEL_PROVIDERS_PATH: "/app/db-role-job/model_providers.json",
  });
  assert.deepEqual(container.envFrom, [{ secretRef: { name: "pilotswarm-portal-secrets", optional: true } }]);
  assert.deepEqual(container.volumeMounts, [{ name: "db-role-job", mountPath: "/app/db-role-job", readOnly: true }]);
  assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  assert.deepEqual(pod.spec.volumes, [{ name: "db-role-job", configMap: { name: DB_ROLE_JOB_NAME, defaultMode: 0o444 } }]);
  assert.deepEqual(stagedJob(text), { name: DB_ROLE_JOB_NAME, namespace: "pilotswarm" });

  const other = documents(renderDbRoleJobManifest({ env: portalEnv({ NAMESPACE: "other" }), catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT }))[1];
  assert.equal(other.metadata.namespace, "other");
});

test("the manifest refuses a password, a missing setting, and what the Job itself would refuse", () => {
  const render = (extra) => {
    const env = portalEnv(extra);
    for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
    return () => renderDbRoleJobManifest({ env, catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT });
  };
  for (const [label, extra, message] of [
    ["password", { DATABASE_URL: "postgresql://admin:pw@db.example.com/pilotswarm" }, /refuses DATABASE_URL with a password/],
    ["catalog password", { PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://admin:pw@db.example.com/pilotswarm" }, /refuses PILOTSWARM_CMS_FACTS_DATABASE_URL with a password/],
    ["no database", { DATABASE_URL: "__PS_UNSET__" }, /needs DATABASE_URL/],
    ["no AAD user", { PILOTSWARM_DB_AAD_USER: undefined }, /needs PILOTSWARM_DB_AAD_USER/],
    ["no identity", { PILOTSWARM_USE_MANAGED_IDENTITY: "0" }, /PILOTSWARM_USE_MANAGED_IDENTITY must be 1/],
    ["no worker identity", { WIN_WORKER_IDENTITY_NAME: undefined }, /needs WIN_WORKER_IDENTITY_NAME from base-infra/],
    ["no worker object", { EXPECTED_WIN_WORKER_OID: "__PS_UNSET__" }, /needs EXPECTED_WIN_WORKER_OID from base-infra/],
    // base-infra reports the host's identity empty without WIN_WORKER_COORDINATION_HOST=true.
    ["no host identity", { COORDINATION_IDENTITY_NAME: "" }, /needs COORDINATION_IDENTITY_NAME from base-infra: deploy base-infra with WIN_WORKERS_ENABLED=true and WIN_WORKER_COORDINATION_HOST=true/],
    ["no host object", { COORDINATION_IDENTITY_PRINCIPAL_ID: "__PS_UNSET__" }, /needs COORDINATION_IDENTITY_PRINCIPAL_ID from base-infra/],
    ["one identity twice", { COORDINATION_IDENTITY_PRINCIPAL_ID: WORKER_OID }, /must be two identities/],
    ["no image", { IMAGE: "" }, /IMAGE is not set/],
  ]) {
    assert.throws(render(extra), message, label);
  }
  assert.throws(() => renderDbRoleJobManifest({ env: portalEnv(), catalogText: "{", scriptText: SCRIPT_TEXT }), /staged model catalog is not valid JSON/);
});

// The portal's env map, as the Windows worker deploy tests stage it.
const stampEnv = (extra = {}) => ({
  EDGE_MODE: "afd",
  TLS_SOURCE: "letsencrypt",
  FOUNDRY_ENDPOINT: "",
  KV_NAME: "psstampkv",
  WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-00000000000a",
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002",
  PORTAL_HOSTNAME: "portal.example.com",
  AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net/",
  AZURE_STORAGE_CONTAINER: "copilot-sessions",
  PILOTSWARM_TURN_TIMEOUT_MS: "2700000",
  PILOTSWARM_LIVE_TURN: "0",
  PORTAL_AUTH_PROVIDER: "entra",
  PORTAL_AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000002",
  PORTAL_AUTH_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
  PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "__PS_UNSET__",
  PORTAL_AUTH_ENTRA_USER_GROUPS: "__PS_UNSET__",
  PORTAL_AUTHZ_DEFAULT_ROLE: "viewer",
  PORTAL_AUTHZ_ADMIN_GROUPS: "__PS_UNSET__",
  PORTAL_AUTHZ_USER_GROUPS: "__PS_UNSET__",
  ...portalEnv(),
  ...extra,
});

// The pool, with what it needs (overlay-contracts.mjs).
const POOL = Object.freeze({
  WIN_WORKERS_ENABLED: "true", WIN_WORKER_ALERT_EMAILS: "ops@example.com",
  WIN_WORKER_COORDINATION_HOST: "true", PILOTSWARM_OWNER_ROUTING: "1", AUTHZ_ENFORCE_OWNERSHIP: "true",
});

test("stage-manifests stages the Job beside the portal's tree only with the pool, from the portal's staged catalog", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-dbrole-stage-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  const manifest = dbRoleJobManifestPath(stagingDir);

  stageManifests({ service: "portal", envName: "testenv", env: stampEnv(), stagingDir });
  assert.equal(existsSync(manifest), false, "no Job without the pool");
  assert.deepEqual(readdirSync(stagingDir), ["gitops"]);

  const root = stageManifests({ service: "portal", envName: "testenv", env: stampEnv(POOL), stagingDir });
  const [configMap] = documents(readFileSync(manifest, "utf8"));
  assert.equal(configMap.data["model_providers.json"], readFileSync(join(root, "base", "model_providers.json"), "utf8").replace(/\r\n/g, "\n"));
  assert.ok(!readdirSync(join(stagingDir, "gitops", "portal"), { recursive: true }).some((file) => String(file).includes("db-role")),
    "the Job stays out of the published tree");

  stageManifests({ service: "worker", envName: "testenv", env: stampEnv({ ...POOL, COORDINATION_IDENTITY_CLIENT_ID: "55555555-5555-5555-5555-555555555555" }), stagingDir });
  assert.ok(existsSync(manifest), "only the portal's staging touches it");
  stageManifests({ service: "portal", envName: "testenv", env: stampEnv({ WIN_WORKERS_ENABLED: "false" }), stagingDir });
  assert.equal(existsSync(manifest), false, "a run without the pool removes the last one");
});

// ─── The run, against a kubectl the test answers ───

function fakeRun(states, { logs = `[pod/${DB_ROLE_JOB_NAME}-x/db-role] ${COMPLETE_MARKER}`, failOn = null } = {}) {
  const calls = [];
  let polls = 0;
  const runFn = (cli, args, opts = {}) => {
    calls.push({ cli, args, kubeconfig: opts.env?.KUBECONFIG ?? null });
    if (failOn && args[0] === failOn) return { status: 1, stdout: "", stderr: `Error from server (Forbidden): ${failOn} is forbidden` };
    if (cli === "kubectl" && args[0] === "get") {
      const state = states[Math.min(polls++, states.length - 1)];
      const conditions = state === "Running" ? [] : [{ type: state, status: "True" }];
      return { status: 0, stdout: JSON.stringify({ status: { conditions } }), stderr: "" };
    }
    if (cli === "kubectl" && args[0] === "logs") return { status: 0, stdout: logs, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runFn, calls };
}

function stagedManifest(t, extra = {}) {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-dbrole-run-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  writeFileSync(dbRoleJobManifestPath(stagingDir), renderDbRoleJobManifest({ env: portalEnv(extra), catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT }));
  return stagingDir;
}

const noWait = { sleepFn: async () => {}, pollMs: 1 };

test("a run deletes the last Job, applies the manifest and waits for the Job, with the cluster's own kubeconfig", async (t) => {
  const stagingDir = stagedManifest(t);
  const { runFn, calls } = fakeRun(["Running", "Running", "Complete"]);
  const env = { AKS_CLUSTER_NAME: "psstamp-aks", RESOURCE_GROUP: "stamp-rg" };
  assert.deepEqual(await runStagedDbRoleJob({ env, stagingDir }, { runFn, ...noWait }), { name: DB_ROLE_JOB_NAME, namespace: "pilotswarm" });
  const manifest = dbRoleJobManifestPath(stagingDir);
  const kubeconfig = join(stagingDir, "kubeconfig");
  assert.deepEqual(calls.map(({ cli, args }) => [cli, ...args]), [
    ["az", "aks", "get-credentials", "--resource-group", "stamp-rg", "--name", "psstamp-aks", "--file", kubeconfig, "--overwrite-existing", "--output", "none"],
    ["kubectl", "delete", "--filename", manifest, "--ignore-not-found", "--wait=true", "--cascade=foreground", "--timeout=5m"],
    ["kubectl", "apply", "--filename", manifest],
    ["kubectl", "get", "job", DB_ROLE_JOB_NAME, "--namespace", "pilotswarm", "--output", "json"],
    ["kubectl", "get", "job", DB_ROLE_JOB_NAME, "--namespace", "pilotswarm", "--output", "json"],
    ["kubectl", "get", "job", DB_ROLE_JOB_NAME, "--namespace", "pilotswarm", "--output", "json"],
    ["kubectl", "logs", "--selector", `job-name=${DB_ROLE_JOB_NAME}`, "--namespace", "pilotswarm", "--tail=60", "--prefix"],
  ]);
  assert.ok(calls.filter(({ cli }) => cli === "kubectl").every((call) => call.kubeconfig === kubeconfig));
});

test("a run fails on a failed Job, on a Job that completes without the Job's last line, on a timeout and on a kubectl error", async (t) => {
  const stagingDir = stagedManifest(t);
  await assert.rejects(runStagedDbRoleJob({ env: {}, stagingDir }, { runFn: fakeRun(["Failed"], { logs: "[db-role-job] failed: grants" }).runFn, ...noWait }),
    /job\/pilotswarm-db-role failed\. Its last lines:\n\[db-role-job\] failed: grants/);
  await assert.rejects(runStagedDbRoleJob({ env: {}, stagingDir }, { runFn: fakeRun(["Complete"], { logs: "nothing" }).runFn, ...noWait }),
    /completed without reporting every step done/);
  let now = 0;
  await assert.rejects(runStagedDbRoleJob({ env: {}, stagingDir }, {
    runFn: fakeRun(["Running"]).runFn, sleepFn: async () => { now += 60_000; }, nowFn: () => now, timeoutMs: 120_000, pollMs: 1,
  }), /did not finish within 2 minutes/);
  for (const verb of ["delete", "apply", "get"]) {
    await assert.rejects(runStagedDbRoleJob({ env: {}, stagingDir }, { runFn: fakeRun(["Complete"], { failOn: verb }).runFn, ...noWait }),
      new RegExp(`Could not .*: Error from server \\(Forbidden\\): ${verb} is forbidden`), verb);
  }
  const empty = mkdtempSync(join(tmpdir(), "ps-dbrole-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const { runFn, calls } = fakeRun(["Complete"]);
  await assert.rejects(runStagedDbRoleJob({ env: {}, stagingDir: empty }, { runFn, ...noWait }), /manifest is missing .*run the portal's manifests step/);
  assert.deepEqual(calls, []);
  assert.equal(jobState(JSON.stringify({ status: { conditions: [{ type: "Complete", status: "False" }] } })), "Running");
});

// ─── deploy.mjs ───

const FAKE_CLI = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1], ".cjs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DBROLE_TEST_CALLS, JSON.stringify([name, ...args]) + "\n");
const is = (...words) => words.every((word, i) => args[i] === word);
if (name === "az") {
  if (is("--version")) { console.log("azure-cli (test)"); process.exit(0); }
  if (is("account", "show")) { console.log(process.env.DBROLE_TEST_SUBSCRIPTION); process.exit(0); }
  if (is("aks", "get-credentials")) { fs.writeFileSync(args[args.indexOf("--file") + 1], "apiVersion: v1\n"); process.exit(0); }
}
if (name === "flux") process.exit(0);
if (name === "kubectl") {
  if (is("get", "deployment")) { console.log("stub.azurecr.io/pilotswarm-portal:fixture"); process.exit(0); }
  if (is("get", "job")) { console.log(JSON.stringify({ status: { conditions: [{ type: "Complete", status: "True" }] } })); process.exit(0); }
  if (is("logs")) { console.log("[pod/x/db-role] " + process.env.DBROLE_TEST_MARKER); process.exit(0); }
  process.exit(0);
}
console.error("unexpected call");
process.exit(9);
`;

let sequence = 0;
function rolloutWithFakeClis(t, settings) {
  const name = `dbr${process.pid.toString(36)}${sequence++}`;
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  const staging = join(REPO_ROOT, "deploy/.tmp", `portal-${name}`);
  const dir = mkdtempSync(join(tmpdir(), "ps-dbrole-deploy-"));
  t.after(() => {
    for (const path of [local, staging, dir, join(REPO_ROOT, "deploy/.tmp", name)]) rmSync(path, { recursive: true, force: true });
  });
  const subscription = "00000000-0000-0000-0000-000000000003";
  const env = {
    ...parseEnvFile(templateEnvPath()),
    SUBSCRIPTION_ID: subscription, AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002",
    RESOURCE_PREFIX: "psstamp", RESOURCE_GROUP: "stamp-rg", PORTAL_RESOURCE_NAME: "psstamp-portal", AKS_CLUSTER_NAME: "psstamp-aks",
    GLOBAL_RESOURCE_PREFIX: "psstampglobal", GLOBAL_RESOURCE_GROUP: "psstampglobal",
    FRONT_DOOR_ID: "fixture", FRONT_DOOR_PROFILE_NAME: "fixture", FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture",
    ACME_EMAIL: "operator@example.com", PORTAL_AUTH_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1", NAMESPACE: "pilotswarm",
    ...settings,
  };
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  if (String(settings.WIN_WORKERS_ENABLED) === "true") {
    mkdirSync(staging, { recursive: true });
    writeFileSync(dbRoleJobManifestPath(staging), renderDbRoleJobManifest({ env: portalEnv(), catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT }));
  }
  for (const cli of ["az", "kubectl", "flux"]) {
    writeFileSync(join(dir, `${cli}.cjs`), FAKE_CLI);
    if (process.platform === "win32") writeFileSync(join(dir, `${cli}.cmd`), `@"${process.execPath}" "%~dp0${cli}.cjs" %*\r\n`);
    else writeFileSync(join(dir, cli), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${cli}.cjs" "$@"\n`, { mode: 0o755 });
  }
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const childEnv = { ...process.env };
  for (const key of [...Object.keys(env), ...Object.keys(AKS_ENV_DEFAULTS), ...DATABASE_INPUT_KEYS, "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "KUBECONFIG"]) {
    delete childEnv[key];
  }
  const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  childEnv[pathKey] = `${dir}${delimiter}${childEnv[pathKey] ?? ""}`;
  Object.assign(childEnv, { DBROLE_TEST_CALLS: calls, DBROLE_TEST_SUBSCRIPTION: subscription, DBROLE_TEST_MARKER: COMPLETE_MARKER });
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "deploy/scripts/deploy.mjs"), "portal", name, "--steps", "rollout", "--image-tag", "fixture"],
    { cwd: REPO_ROOT, encoding: "utf8", env: childEnv });
  const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, logged, staging };
}

const kubectlVerbs = (logged) => logged.filter(([cli]) => cli === "kubectl").map(([, ...args]) => args.slice(0, 2).join(" "));

test("deploy.mjs runs the Job in the portal's rollout step, after the rollout, only with WIN_WORKERS_ENABLED=true", (t) => {
  const off = rolloutWithFakeClis(t, {});
  assert.equal(off.result.status, 0, `${off.result.stdout.slice(-3000)}\n${off.result.stderr}`);
  assert.deepEqual(kubectlVerbs(off.logged), ["version --client", "rollout status", "get deployment"]);

  const on = rolloutWithFakeClis(t, POOL);
  assert.equal(on.result.status, 0, `${on.result.stdout.slice(-3000)}\n${on.result.stderr}`);
  assert.deepEqual(kubectlVerbs(on.logged), [
    "version --client", "rollout status", "get deployment",
    "delete --filename", "apply --filename", "get job", "logs --selector",
  ]);
  const apply = on.logged.find(([cli, verb]) => cli === "kubectl" && verb === "apply");
  assert.equal(apply[3], dbRoleJobManifestPath(on.staging));
  assert.match(on.result.stdout, /job\/pilotswarm-db-role completed/);
});

// ─── The Windows image's upgrade script ───

const pwshWorks = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", windowsHide: true }).status === 0;

test("Bootstrap-WinWorkerStamp.ps1 takes the staged manifest: its ConfigMap and its one Job", { skip: !pwshWorks && "PowerShell 7 is not installed" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ps-dbrole-boot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, "db-role-job.yaml");
  writeFileSync(manifest, renderDbRoleJobManifest({ env: portalEnv(), catalogText: CATALOG_TEXT, scriptText: SCRIPT_TEXT }));
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const bootstrap = join(REPO_ROOT, "deploy/providers/azure/windows/Bootstrap-WinWorkerStamp.ps1");
  const migrate = (applied) => {
    const driver = join(dir, "driver.ps1");
    writeFileSync(driver, [
      `. ${quote(bootstrap)} -ReleaseDir ${quote(dir)} -StorageAccountName example -Namespace pilotswarm -ControllerCaFile ca.crt -ControllerTokenScope 'api://controller/.default' -MigrationJobManifest ${quote(manifest)}`,
      "$script:calls = @()",
      "function Invoke-Kubectl { param([string[]]$Arguments, [switch]$NoThrow, [int]$TimeoutSeconds = 3600)",
      "  $script:calls += ($Arguments -join ' ')",
      `  if ($Arguments[0] -eq 'apply') { return [pscustomobject]@{ ExitCode = 0; StdOut = ${quote(applied)}; StdErr = '' } }`,
      `  if ($Arguments[0] -eq 'get') { return [pscustomobject]@{ ExitCode = 0; StdOut = '{"status":{"conditions":[{"type":"Complete","status":"True"}]}}'; StdErr = '' } }`,
      "  return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }",
      "try { Invoke-Migrate; $outcome = 'ok' } catch { $outcome = $_.Exception.Message }",
      "ConvertTo-Json -Compress -InputObject @{ outcome = $outcome; calls = @($script:calls) }",
    ].join("\n"));
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  };
  const ok = migrate(`configmap/${DB_ROLE_JOB_NAME}\njob.batch/${DB_ROLE_JOB_NAME}\n`);
  assert.equal(ok.outcome, "ok");
  assert.deepEqual(ok.calls, [
    `delete --filename ${manifest} --ignore-not-found --wait=true`,
    `apply --filename ${manifest} --output name`,
    `get job.batch/${DB_ROLE_JOB_NAME} --output json`,
  ]);
  assert.match(migrate(`configmap/${DB_ROLE_JOB_NAME}\n`).outcome, /created configmap\/pilotswarm-db-role, not one Job/);
  assert.match(migrate(`job.batch/a\njob.batch/b`).outcome, /created job\.batch\/a, job\.batch\/b, not one Job/);
});
