// The database role Job of the Windows worker pool (WIN_WORKERS_ENABLED=true).
//
// It runs as a Kubernetes Job in the portal's image and namespace, with the
// portal's service account, so it signs in to PostgreSQL as the portal's
// identity: the server's Microsoft Entra administrator, which the migrations
// run as. deploy/providers/azure/deploy-steps/db-role-job.mjs stages the Job's
// manifest and runs it. Every run, in order:
//
//   1. Migrations. Starts PilotSwarmClient and PilotSwarmManagementClient with
//      the portal's storage settings, as the portal does, which applies every
//      pending migration of the orchestration store (duroxide), the session
//      catalog and the facts store.
//   2. The group. Creates the NOLOGIN role pilotswarm_worker_group when it is
//      missing, and grants it in each of the three schemas: USAGE on the
//      schema; SELECT, INSERT, UPDATE and DELETE on every table; USAGE, SELECT
//      and UPDATE on every sequence; EXECUTE on every function and procedure.
//      Never CREATE, TRUNCATE, TRIGGER or REFERENCES. The session catalog's
//      authz_audit table is the exception: SELECT and INSERT only, and only
//      USAGE on its ID sequence, so a worker can add audit rows and read them
//      but can't change or remove one. The same grants become the migrating
//      role's default privileges in those schemas, and every run grants them
//      again, so a later migration's objects get them too.
//   3. The members. The Windows workers' identity (WIN_WORKER_IDENTITY_NAME,
//      EXPECTED_WIN_WORKER_OID) and the coordination host's
//      (COORDINATION_IDENTITY_NAME, COORDINATION_IDENTITY_PRINCIPAL_ID) join
//      the group. A missing Microsoft Entra principal is created first,
//      with pgaadauth_create_principal_with_oid on the server's postgres
//      database; an existing role of that name must be the Entra principal of
//      the same object ID. Members are only added, never removed.
//   4. The check. Reads the group's privileges back through PostgreSQL's own
//      privilege functions and fails on any difference from the above.
//
// The clients start with the portal's model catalog (PS_MODEL_PROVIDERS_PATH),
// as the portal's do: the first client to start against a new database seeds
// the providers and the cluster default model from it, once. The Job never
// sets a default model: an administrator's choice in the Portal stays.
//
// Any failure exits non-zero. Nothing it prints holds a credential: the
// database URLs carry no password (the identity's Entra token is the
// password), and every error is redacted before it is printed.
//
// The decisions are pure, exported functions, tested by
// deploy/scripts/test/db-role-job.test.mjs. The SDK and pg load only when the
// Job runs, so importing this file needs no installed package.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORKER_GROUP_ROLE = "pilotswarm_worker_group";
export const AUDIT_TABLE = "authz_audit";
export const AUDIT_ID_COLUMN = "audit_id";
// The database that holds the pgaadauth functions on Azure Database for
// PostgreSQL flexible server.
export const ENTRA_ADMIN_DATABASE = "postgres";
// The last line of a successful run.
export const COMPLETE_MARKER = "[db-role-job] complete";

const UNSET = "__PS_UNSET__";
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
// Names PostgreSQL doesn't accept for a role.
const RESERVED_ROLE_NAMES = new Set(["public", "none", "current_role", "current_user", "session_user"]);
// pg_advisory_xact_lock(int, int): two runs grant one after the other.
const GRANTS_LOCK = Object.freeze([0x50535747, 1]);

const TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE";
const SEQUENCE_PRIVILEGES = "USAGE, SELECT, UPDATE";
const AUDIT_TABLE_PRIVILEGES = "SELECT, INSERT";
// The migrating role's default privileges the group must hold, by
// pg_default_acl object type.
const DEFAULT_PRIVILEGES = Object.freeze({
  r: Object.freeze(["DELETE", "INSERT", "SELECT", "UPDATE"]),
  S: Object.freeze(["SELECT", "UPDATE", "USAGE"]),
  f: Object.freeze(["EXECUTE"]),
});
const DEFAULT_PRIVILEGE_OBJECTS = Object.freeze({ r: "table", S: "sequence", f: "routine" });

// The queries the Job reads state and checks privileges with. $1 is the group
// (or the role asked about); $2 the managed schemas.
export const SQL = Object.freeze({
  self: "SELECT current_user AS name, current_database() AS database",
  lock: "SELECT pg_catalog.pg_advisory_xact_lock($1, $2)",
  role: "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls " +
    "FROM pg_catalog.pg_roles WHERE rolname = $1",
  roleExists: "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
  auditTable: "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present",
  auditSequence: "SELECT sn.nspname AS schema, s.relname AS name FROM pg_catalog.pg_class s " +
    "JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace " +
    "WHERE s.oid = pg_catalog.to_regclass(pg_catalog.pg_get_serial_sequence($1, $2))",
  members: "SELECT m.rolname AS name FROM pg_catalog.pg_auth_members am " +
    "JOIN pg_catalog.pg_roles m ON m.oid = am.member JOIN pg_catalog.pg_roles g ON g.oid = am.roleid " +
    "WHERE g.rolname = $1",
  verifyDatabase: "SELECT pg_catalog.has_database_privilege($1, pg_catalog.current_database(), 'CONNECT') AS \"connect\", " +
    "pg_catalog.has_database_privilege($1, pg_catalog.current_database(), 'CREATE') AS \"create\"",
  verifySchemas: "SELECT n.nspname AS name, pg_catalog.has_schema_privilege($1, n.oid, 'USAGE') AS usage, " +
    "pg_catalog.has_schema_privilege($1, n.oid, 'CREATE') AS \"create\" FROM pg_catalog.pg_namespace n " +
    "WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1",
  verifyRelations: "SELECT n.nspname AS schema, c.relname AS name, " +
    "pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS \"select\", " +
    "pg_catalog.has_table_privilege($1, c.oid, 'INSERT') AS \"insert\", " +
    "pg_catalog.has_table_privilege($1, c.oid, 'UPDATE') AS \"update\", " +
    "pg_catalog.has_table_privilege($1, c.oid, 'DELETE') AS \"delete\", " +
    "pg_catalog.has_table_privilege($1, c.oid, 'TRUNCATE') AS \"truncate\", " +
    "pg_catalog.has_table_privilege($1, c.oid, 'TRIGGER') AS \"trigger\", " +
    "pg_catalog.has_any_column_privilege($1, c.oid, 'UPDATE') AS column_update, " +
    "pg_catalog.has_any_column_privilege($1, c.oid, 'REFERENCES') AS column_references " +
    "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname = ANY($2::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1, 2",
  verifySequences: "SELECT n.nspname AS schema, c.relname AS name, " +
    "pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE') AS usage, " +
    "pg_catalog.has_sequence_privilege($1, c.oid, 'SELECT') AS \"select\", " +
    "pg_catalog.has_sequence_privilege($1, c.oid, 'UPDATE') AS \"update\" " +
    "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname = ANY($2::text[]) AND c.relkind = 'S' ORDER BY 1, 2",
  verifyRoutines: "SELECT n.nspname AS schema, p.oid::pg_catalog.regprocedure::text AS name, " +
    "pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS execute " +
    "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace " +
    "WHERE n.nspname = ANY($2::text[]) ORDER BY 1, 2",
  verifyMembers: "SELECT r.rolname AS name, pg_catalog.pg_has_role(r.oid, g.oid, 'USAGE') AS inherits " +
    "FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles g WHERE g.rolname = $1 AND r.rolname = ANY($2::text[])",
  verifyDefaults: "SELECT n.nspname AS schema, d.defaclobjtype::text AS type, a.privilege_type AS privilege " +
    "FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace " +
    "CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a " +
    "WHERE d.defaclrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) " +
    "AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) " +
    "AND n.nspname = ANY($2::text[]) ORDER BY 1, 2, 3",
  entraPrincipals: "SELECT * FROM pg_catalog.pgaadauth_list_principals(false)",
  createEntraPrincipal: "SELECT * FROM pg_catalog.pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)",
});

// ─── Settings ───

// The env without the deploy's unset sentinel, as the portal reads it.
export function stripUnset(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== UNSET));
}

export function quoteIdent(name) {
  const text = String(name ?? "");
  if (text === "" || text.includes("\0")) throw new Error("An SQL identifier must be a non-empty string without NUL.");
  return `"${text.replace(/"/g, '""')}"`;
}

function roleName(value, key) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error(`${key} is not set.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${key} holds a control character.`);
  if (Buffer.byteLength(name, "utf8") > 63) throw new Error(`${key} '${name}' is longer than PostgreSQL's 63-byte role names.`);
  if (name.toLowerCase().startsWith("pg_") || RESERVED_ROLE_NAMES.has(name.toLowerCase())) {
    throw new Error(`${key} '${name}' is a role name PostgreSQL reserves.`);
  }
  return name;
}

function objectId(value, key) {
  const id = String(value ?? "").trim();
  if (!GUID.test(id)) throw new Error(`${key} must be the identity's Microsoft Entra object ID (a GUID), not '${id}'.`);
  return id.toLowerCase();
}

// The Job's settings from its env. Throws on anything the Job can't act on,
// before it touches the database.
export function readJobSettings(env, { group = WORKER_GROUP_ROLE } = {}) {
  const values = stripUnset(env);
  const setting = (key) => String(values[key] ?? "").trim();
  if (setting("PILOTSWARM_SKIP_DB_MIGRATIONS") === "1") {
    throw new Error("PILOTSWARM_SKIP_DB_MIGRATIONS=1 keeps a process from migrating, and this Job is what migrates: unset it for the Job.");
  }
  if (!POSTGRES_URL.test(setting("DATABASE_URL"))) throw new Error("DATABASE_URL must be a postgres:// or postgresql:// URL.");
  const catalogUrl = setting("PILOTSWARM_CMS_FACTS_DATABASE_URL");
  if (catalogUrl && !POSTGRES_URL.test(catalogUrl)) {
    throw new Error("PILOTSWARM_CMS_FACTS_DATABASE_URL must be a postgres:// or postgresql:// URL.");
  }
  const catalogPath = setting("PS_MODEL_PROVIDERS_PATH");
  if (!catalogPath) throw new Error("PS_MODEL_PROVIDERS_PATH must name the portal's model catalog, which the Job's clients start with.");

  const members = [{
    label: "the Windows workers' identity",
    name: roleName(setting("WIN_WORKER_IDENTITY_NAME"), "WIN_WORKER_IDENTITY_NAME"),
    oid: objectId(setting("EXPECTED_WIN_WORKER_OID"), "EXPECTED_WIN_WORKER_OID"),
  }, {
    label: "the coordination host's identity",
    name: roleName(setting("COORDINATION_IDENTITY_NAME"), "COORDINATION_IDENTITY_NAME"),
    oid: objectId(setting("COORDINATION_IDENTITY_PRINCIPAL_ID"), "COORDINATION_IDENTITY_PRINCIPAL_ID"),
  }];
  for (const member of members) {
    if (member.name.toLowerCase() === group.toLowerCase()) throw new Error(`${member.label} can't be named ${group}, the group itself.`);
  }
  const [workers, coordination] = members;
  if (workers.name.toLowerCase() === coordination.name.toLowerCase() || workers.oid === coordination.oid) {
    throw new Error("The Windows workers' identity and the coordination host's identity must be two identities.");
  }
  return { members, catalogPath };
}

// The storage options the portal gives its clients (packages/app/web/server.js),
// with the Job's model catalog.
export function clientOptions(env, catalogPath) {
  const values = stripUnset(env);
  const useManagedIdentity = ["1", "true", "yes", "on"].includes(String(values.PILOTSWARM_USE_MANAGED_IDENTITY ?? "").trim().toLowerCase());
  return {
    store: String(values.DATABASE_URL ?? "").trim(),
    useManagedIdentity,
    ...(values.PILOTSWARM_CMS_FACTS_DATABASE_URL ? { cmsFactsDatabaseUrl: String(values.PILOTSWARM_CMS_FACTS_DATABASE_URL).trim() } : {}),
    ...(values.PILOTSWARM_DB_AAD_USER ? { aadDbUser: String(values.PILOTSWARM_DB_AAD_USER).trim() } : {}),
    modelProvidersPath: catalogPath,
  };
}

function databaseOf(url, what) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    throw new Error(`The ${what}'s URL does not parse.`);
  }
  if (!/^postgres(?:ql)?:$/i.test(parsed.protocol)) throw new Error(`The ${what} is not a PostgreSQL database.`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}`;
}

// Where the group's grants go, from the storage config the clients resolve
// (resolveStorageConfig): one database, the three schemas, and the schema of
// the audit table. The Windows workers reach all three through one URL, so a
// configuration that splits them is refused.
export function databaseLayout(storage) {
  if (storage?.duroxide?.provider !== "postgres" || storage?.runtime?.provider !== "postgres") {
    throw new Error("The worker group covers the postgres orchestration store, session catalog and facts store; this deployment selects another storage provider.");
  }
  const { runtime, duroxide } = storage;
  const stores = [
    ["orchestration store", duroxide.url, duroxide.schema],
    ["session catalog", runtime.sessionCatalogUrl ?? runtime.url, runtime.cmsSchema],
    ["facts store", runtime.factStoreUrl ?? runtime.sessionCatalogUrl ?? runtime.url, runtime.factsSchema],
  ];
  const databases = new Map(stores.map(([what, url]) => [what, databaseOf(url, what)]));
  if (new Set(databases.values()).size !== 1) {
    throw new Error(
      "The orchestration store, the session catalog and the facts store must be in one database for the worker group, " +
        `not ${[...databases].map(([what, database]) => `${database} (${what})`).join(", ")}.`,
    );
  }
  for (const [what, , schema] of stores) {
    if (!String(schema ?? "").trim()) throw new Error(`The ${what} has no schema.`);
  }
  return { schemas: [...new Set(stores.map(([, , schema]) => schema))], auditSchema: runtime.cmsSchema };
}

// ─── Statements ───

// The group's role: created when missing; a role of that name that can log in
// loses that. A role with a privilege only a superuser could remove is
// refused.
export function planGroupRole(state, group = WORKER_GROUP_ROLE) {
  const role = quoteIdent(group);
  if (!state) return [`CREATE ROLE ${role} NOLOGIN`];
  const extra = [
    ["rolsuper", "SUPERUSER"], ["rolcreaterole", "CREATEROLE"], ["rolcreatedb", "CREATEDB"],
    ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"],
  ].filter(([flag]) => state[flag]).map(([, name]) => name);
  if (extra.length > 0) {
    throw new Error(`The role ${group} exists with ${extra.join(", ")}; drop it, or remove that, before the Job grants it anything.`);
  }
  return state.rolcanlogin ? [`ALTER ROLE ${role} NOLOGIN`] : [];
}

// Every grant of the group, in the order the Job issues them. Each REVOKE
// before a GRANT drops any privilege granted outside this list; CREATE on the
// database is revoked only when the group holds it (`databaseCreate`).
export function planSchemaGrants({ group = WORKER_GROUP_ROLE, schemas, database, databaseCreate = false, audit }) {
  const role = quoteIdent(group);
  const statements = [];
  if (database && databaseCreate) statements.push(`REVOKE CREATE ON DATABASE ${quoteIdent(database)} FROM ${role}`);
  for (const name of schemas) {
    const schema = quoteIdent(name);
    statements.push(
      `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
      `GRANT ${TABLE_PRIVILEGES} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
      `GRANT ${SEQUENCE_PRIVILEGES} ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
      `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${schema} TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ${TABLE_PRIVILEGES} ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ${SEQUENCE_PRIVILEGES} ON SEQUENCES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON ROUTINES TO ${role}`,
    );
  }
  const table = `${quoteIdent(audit.schema)}.${quoteIdent(audit.table ?? AUDIT_TABLE)}`;
  statements.push(
    `REVOKE ALL ON TABLE ${table} FROM ${role}`,
    `GRANT ${AUDIT_TABLE_PRIVILEGES} ON TABLE ${table} TO ${role}`,
  );
  if (audit.sequence) {
    const sequence = `${quoteIdent(audit.sequence.schema)}.${quoteIdent(audit.sequence.name)}`;
    statements.push(`REVOKE ALL ON SEQUENCE ${sequence} FROM ${role}`, `GRANT USAGE ON SEQUENCE ${sequence} TO ${role}`);
  }
  return statements;
}

// GRANT for each member not in the group yet.
export function planMemberGrants({ group = WORKER_GROUP_ROLE, members, existing = [] }) {
  const current = new Set(existing);
  return members.filter((member) => !current.has(member.name)).map((member) => `GRANT ${quoteIdent(group)} TO ${quoteIdent(member.name)}`);
}

// ─── The check ───

// What differs from the group's grants, one sentence per difference, from the
// rows of the verify* queries. Empty when the group has exactly its grants.
export function privilegeProblems({ group = WORKER_GROUP_ROLE, schemas, audit, members }, observed) {
  const problems = [];
  const role = observed.role;
  if (!role) {
    problems.push(`the role ${group} does not exist`);
  } else {
    for (const [flag, what] of [
      ["rolcanlogin", "can log in"], ["rolsuper", "is a superuser"], ["rolcreaterole", "can create roles"],
      ["rolcreatedb", "can create databases"], ["rolreplication", "can replicate"], ["rolbypassrls", "bypasses row security"],
    ]) {
      if (role[flag]) problems.push(`${group} ${what}`);
    }
  }
  if (!observed.database?.connect) problems.push(`${group} can't connect to the database`);
  if (observed.database?.create) problems.push(`${group} can create schemas in the database`);

  const managed = new Set(schemas);
  for (const row of observed.schemas ?? []) {
    if (row.create) problems.push(`${group} can create objects in schema ${row.name}`);
    if (managed.has(row.name) && !row.usage) problems.push(`${group} lacks USAGE on schema ${row.name}`);
  }
  for (const name of schemas) {
    if (!(observed.schemas ?? []).some((row) => row.name === name)) problems.push(`schema ${name} does not exist`);
  }

  const auditKey = `${audit.schema}.${audit.table ?? AUDIT_TABLE}`;
  let auditSeen = false;
  for (const row of observed.relations ?? []) {
    const key = `${row.schema}.${row.name}`;
    const isAudit = key === auditKey;
    auditSeen ||= isAudit;
    const wanted = isAudit
      ? { select: true, insert: true, update: false, delete: false }
      : { select: true, insert: true, update: true, delete: true };
    for (const [privilege, want] of Object.entries(wanted)) {
      if (Boolean(row[privilege]) !== want) problems.push(`${key}: ${group} ${want ? "lacks" : "has"} ${privilege.toUpperCase()}`);
    }
    if (row.truncate) problems.push(`${key}: ${group} has TRUNCATE`);
    if (row.trigger) problems.push(`${key}: ${group} has TRIGGER`);
    if (row.column_references) problems.push(`${key}: ${group} has REFERENCES`);
    if (isAudit && row.column_update) problems.push(`${key}: ${group} can UPDATE some of its columns`);
  }
  if (!auditSeen) problems.push(`${auditKey} does not exist`);

  const auditSequenceKey = audit.sequence ? `${audit.sequence.schema}.${audit.sequence.name}` : null;
  for (const row of observed.sequences ?? []) {
    const key = `${row.schema}.${row.name}`;
    const wanted = key === auditSequenceKey
      ? { usage: true, select: false, update: false }
      : { usage: true, select: true, update: true };
    for (const [privilege, want] of Object.entries(wanted)) {
      if (Boolean(row[privilege]) !== want) problems.push(`${key}: ${group} ${want ? "lacks" : "has"} ${privilege.toUpperCase()}`);
    }
  }
  for (const row of observed.routines ?? []) {
    if (!row.execute) problems.push(`${row.name}: ${group} lacks EXECUTE`);
  }

  for (const member of members) {
    const row = (observed.members ?? []).find((candidate) => candidate.name === member.name);
    if (!row) problems.push(`the role ${member.name} (${member.label}) does not exist`);
    else if (!row.inherits) problems.push(`${member.name} (${member.label}) does not have ${group}'s privileges`);
  }

  for (const schema of schemas) {
    for (const [type, privileges] of Object.entries(DEFAULT_PRIVILEGES)) {
      const held = (observed.defaults ?? [])
        .filter((row) => row.schema === schema && row.type === type)
        .map((row) => row.privilege)
        .sort();
      if (held.join(",") !== privileges.join(",")) {
        problems.push(
          `schema ${schema}: the migrating role's default ${DEFAULT_PRIVILEGE_OBJECTS[type]} privileges for ${group} are ` +
            `${held.join(", ") || "none"}, not ${privileges.join(", ")}`,
        );
      }
    }
  }
  return problems;
}

// ─── Database steps ───

async function rows(db, sql, params) {
  return (await db.query(sql, params)).rows;
}

async function applyGroupGrants(db, { group, layout, database, log }) {
  await db.query("BEGIN");
  try {
    await db.query(SQL.lock, [...GRANTS_LOCK]);
    const [state] = await rows(db, SQL.role, [group]);
    const create = planGroupRole(state ?? null, group);
    for (const statement of create) await db.query(statement);
    const table = `${quoteIdent(layout.auditSchema)}.${quoteIdent(AUDIT_TABLE)}`;
    const [{ present } = {}] = await rows(db, SQL.auditTable, [table]);
    if (!present) throw new Error(`The session catalog has no ${layout.auditSchema}.${AUDIT_TABLE} table after its migrations.`);
    const [sequence] = await rows(db, SQL.auditSequence, [table, AUDIT_ID_COLUMN]);
    const audit = { schema: layout.auditSchema, table: AUDIT_TABLE, sequence: sequence ? { schema: sequence.schema, name: sequence.name } : null };
    const [{ create: databaseCreate } = {}] = await rows(db, SQL.verifyDatabase, [group]);
    for (const statement of planSchemaGrants({ group, schemas: layout.schemas, database, databaseCreate, audit })) await db.query(statement);
    await db.query("COMMIT");
    log(`${state ? "Granted" : `Created ${group} and granted`} its privileges in ${layout.schemas.join(", ")}.`);
    return audit;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function addMembers(db, { group, members, principals, log }) {
  for (const member of members) {
    const outcome = await principals.ensure({ name: member.name, oid: member.oid });
    if (outcome === "created") log(`Created the Microsoft Entra principal ${member.name} (${member.label}).`);
  }
  const existing = (await rows(db, SQL.members, [group])).map((row) => row.name);
  const grants = planMemberGrants({ group, members, existing });
  for (const statement of grants) await db.query(statement);
  if (grants.length > 0) log(`Added ${members.filter((member) => !existing.includes(member.name)).map((member) => member.name).join(" and ")} to ${group}.`);
}

async function verifyGroup(db, { group, layout, audit, members }) {
  const scope = [group, layout.schemas];
  const [role] = await rows(db, SQL.role, [group]);
  const [database] = await rows(db, SQL.verifyDatabase, [group]);
  const observed = {
    role: role ?? null,
    database,
    schemas: await rows(db, SQL.verifySchemas, [group]),
    relations: await rows(db, SQL.verifyRelations, scope),
    sequences: await rows(db, SQL.verifySequences, scope),
    routines: await rows(db, SQL.verifyRoutines, scope),
    members: await rows(db, SQL.verifyMembers, [group, members.map((member) => member.name)]),
    defaults: await rows(db, SQL.verifyDefaults, scope),
  };
  const problems = privilegeProblems({ group, schemas: layout.schemas, audit, members }, observed);
  if (problems.length > 0) {
    throw new Error(`${group}'s privileges are not what the Job grants: ${problems.slice(0, 20).join("; ")}` +
      (problems.length > 20 ? `; and ${problems.length - 20} more.` : "."));
  }
  return observed;
}

// pg config for another database of the same server.
export function withDatabase(config, database) {
  if (config.connectionString) {
    const url = new URL(config.connectionString);
    url.pathname = `/${encodeURIComponent(database)}`;
    return { ...config, connectionString: url.toString() };
  }
  return { ...config, database };
}

// Microsoft Entra principals on Azure Database for PostgreSQL flexible
// server, through the pgaadauth functions of its postgres database. A role of
// the member's name must be the Entra principal of the member's object ID; a
// missing one is created as a service principal, with no admin rights.
export function azurePrincipals({ pg, clientConfig, database = ENTRA_ADMIN_DATABASE }) {
  return {
    async ensure({ name, oid }) {
      const client = new pg.Client(withDatabase(clientConfig, database));
      await client.connect();
      try {
        const principals = (await client.query(SQL.entraPrincipals)).rows
          .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
        const principal = principals.find((row) => row.rolename === name);
        if (principal) {
          if (String(principal.objectid ?? "").toLowerCase() !== oid.toLowerCase()) {
            throw new Error(`The database role ${name} is the Microsoft Entra principal of another object (${principal.objectid}), not of ${oid}.`);
          }
          if (principal.principaltype && String(principal.principaltype).toLowerCase() !== "service") {
            throw new Error(`The database role ${name} is a Microsoft Entra ${principal.principaltype}, not a service principal.`);
          }
          return "exists";
        }
        if ((await client.query(SQL.roleExists, [name])).rows.length > 0) {
          throw new Error(`The database role ${name} exists but is not a Microsoft Entra principal; rename or drop it.`);
        }
        await client.query(SQL.createEntraPrincipal, [name, oid]);
        return "created";
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

// ─── The run ───

// Text with anything that looks like a credential masked: a URL's password,
// a password= pair, or a JSON Web Token.
export function redact(text) {
  return String(text ?? "")
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]*:)[^@\s]*@/gi, "$1***@")
    .replace(/(password\s*[=:]\s*)[^\s;,&]+/gi, "$1***")
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "***");
}

function defaultLog(message) {
  console.log(`[db-role-job] ${message}`);
}

// One run of the Job. `sdk` is the pilotswarm-sdk module and `pg` the pg
// module; `principals` creates and checks the members' principals
// (azurePrincipals by default).
export async function runDbRoleJob({ env = process.env, sdk, pg, principals, group = WORKER_GROUP_ROLE, log = defaultLog } = {}) {
  const settings = readJobSettings(env, { group });
  const values = stripUnset(env);
  const base = clientOptions(values, settings.catalogPath);
  const storage = sdk.resolveStorageConfig({ env: values, options: base });
  const layout = databaseLayout(storage);
  const options = {
    ...base,
    duroxideSchema: storage.duroxide.schema,
    cmsSchema: storage.runtime.cmsSchema,
    factsSchema: storage.runtime.factsSchema,
  };
  const client = new sdk.PilotSwarmClient(options);
  const mgmt = new sdk.PilotSwarmManagementClient(options);
  try {
    log(`Running the migrations of schemas ${layout.schemas.join(", ")}.`);
    await client.start();
    await mgmt.start();
    log("The migrations are applied.");

    const clientConfig = sdk.buildSessionCatalogPgClientConfig(options, values);
    const db = new pg.Client(clientConfig);
    await db.connect();
    try {
      const [self] = await rows(db, SQL.self);
      const named = settings.members.find((member) => member.name === self.name);
      if (named) throw new Error(`${named.label} is ${self.name}, the role the Job signs in as.`);
      const audit = await applyGroupGrants(db, { group, layout, database: self.database, log });
      await addMembers(db, { group, members: settings.members, principals: principals ?? azurePrincipals({ pg, clientConfig }), log });
      await verifyGroup(db, { group, layout, audit, members: settings.members });
      log(`${group} holds exactly its grants; members: ${settings.members.map((member) => member.name).join(", ")}.`);
    } finally {
      await db.end().catch(() => {});
    }
    return { layout, members: settings.members };
  } finally {
    await Promise.allSettled([client.stop(), mgmt.stop()]);
  }
}

// The Job's entry point: 0 when every step succeeded, 1 otherwise.
export async function main({ env = process.env } = {}) {
  // Like the portal, read the unset sentinel as unset everywhere, the SDK's
  // own reads of process.env included.
  for (const [key, value] of Object.entries(env)) {
    if (value === UNSET) delete env[key];
  }
  try {
    readJobSettings(env);
    const [sdk, pgModule] = await Promise.all([import("pilotswarm-sdk"), import("pg")]);
    await runDbRoleJob({ env, sdk, pg: pgModule.default ?? pgModule });
    console.log(COMPLETE_MARKER);
    return 0;
  } catch (error) {
    console.error(`[db-role-job] failed: ${redact(error?.message ?? error)}`);
    return 1;
  }
}

// Run when node starts this file, also through the links of a ConfigMap
// volume, whose paths differ from the file's real path.
function startedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) process.exit(await main());
