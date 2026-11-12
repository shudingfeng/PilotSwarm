# Configuration Guide

> **New here?** See the [Getting Started](../../quickstart/local.md) guide for a full walkthrough from zero to running.

## Prerequisites

- **Node.js 24.22.1+ within 24.x, or 26.12.1+** (patched security baseline; CI uses 24.22.1 LTS)
- **PostgreSQL** (local or managed — Azure Database for PostgreSQL, AWS RDS, etc.)
- **LLM provider credentials** — at least one of:
  - `GITHUB_TOKEN` (easiest — gives access to Claude, GPT, etc. via GitHub Copilot)
  - Azure OpenAI, Azure AI Services, or any OpenAI-compatible API key

Optional:
- **Azure Blob Storage** — for session dehydration/hydration across nodes

## Environment Variables

Start from the template:

```bash
cp .env.example .env
cp .model_providers.example.json .model_providers.json
# review/edit the local model catalog (keys stay in env files)
$EDITOR .model_providers.json
```

Then edit `.env` with the database and optional compatibility credentials:

```bash
# Required
DATABASE_URL=postgresql://user:password@localhost:5432/pilotswarm

# Optional legacy bootstrap keys. New deployments add runtime providers in
# Admin Console → Model Providers or through PilotSwarmManagementClient.
# GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
# AZURE_OAI_KEY=your-key

# Optional — session dehydration to blob storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_STORAGE_CONTAINER=copilot-sessions

# Optional — env-only PostgreSQL/runtime scaling knobs
# DUROXIDE_PG_POOL_MAX=10
# PILOTSWARM_CMS_PG_POOL_MAX=3
# PILOTSWARM_FACTS_PG_POOL_MAX=3
# PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
# PILOTSWARM_WORKER_CONCURRENCY=2
# PILOTSWARM_TURN_TIMEOUT_MS=1200000
```

> **Provider types and models** are declared in `.model_providers.json`, usually
> copied from the checked-in type-only `.model_providers.example.json`. Runtime
> provider instances carry credentials and are created in **Admin Console →
> Model Providers** or through `PilotSwarmManagementClient.createProvider()` /
> `createMyProvider()`. `setModelDefault()` controls future ordinary sessions;
> `setSystemModelDefault()` independently controls system machinery. With no
> configured default, PilotSwarm deterministically selects the first model of
> the first eligible runtime provider and stamps that exact `provider:model`
> before orchestration starts.

Credential references and `defaultModel` in a catalog remain supported only as
a one-time legacy bootstrap path. New catalogs should contain neither.

### Portal Auth Add-Ons

The shipped browser portal supports provider-based auth.

- default: `none`
- built-in optional providers: `entra`, `proxy`

Enable Entra for portal deployments with:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com

# Per-user session ownership and sharing posture
AUTHZ_ENFORCE_OWNERSHIP=true
SESSIONS_DEFAULT_VISIBILITY=private
SESSIONS_SYSTEM_VISIBILITY=read
# Optional: the deployment's dispatcher (see Dispatcher delegation below)
# DISPATCHER_SP_OBJECT_ID=<dispatcher-object-id>
```

For now, `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS` are interpreted
as comma-delimited user email allowlists, not Entra group IDs.

For tenants that prefer to drive admission from Entra **app roles** instead of
an email allowlist, see the operator runbook at
[`docs/portal-entra-app-roles.md`](../deploy/entra-app-roles.md). The portal
matches the JWT `roles` claim by case-insensitive equality against exactly
two canonical values: `admin` and `user`. There is no override env var —
`Setup-PortalAuth.ps1 -CreateAppRoles` creates exactly these two roles, and
extra granularity belongs in new app roles checked explicitly in code.

> **Provisioning the Entra app registration.** PilotSwarm ships
> `deploy/scripts/auth/Setup-PortalAuth.ps1` to create (or append a
> redirect URI to) the Entra application backing the portal. It
> requires a `-ServiceTreeId` (operator-supplied) and supports two
> optional switches that align with the role-driven authz engine:
> `-CreateAppRoles` defines `admin` and `user` app roles on the
> application object (recommended for production stamps), and
> `-AssignmentRequired` flips the service principal to require explicit
> user/group assignment before any token is issued. `-AssignmentRequired`
> is OFF by default — in restricted tenants it can trip an AADSTS90094
> admin-consent prompt; the recommended production lockdown is
> `-CreateAppRoles` plus role assignments in Entra (the role
> assignment **is** the allowlist), with the portal engine's
> deny-by-default behavior. See
> `deploy/scripts/auth/README.md`,
> [`docs/portal-entra-app-roles.md`](../deploy/entra-app-roles.md), and
> the `pilotswarm-portal-app-reg` skill for full usage. For
> npm-orchestrator stamps, this is wired into the new-env flow by the
> `pilotswarm-npm-deployer` agent. The opt-in `-WorkerRoles` switch adds
> app roles for application identities (`worker`, `deployer`,
> `coordinator`), which the portal does not admit, lets applications hold
> `user`, and switches the app to v2.0 access tokens; see
> [Roles for application identities](../deploy/entra-app-roles.md#roles-for-application-identities).

For deployments already protected by an identity-aware reverse proxy, use the
request-authenticated `proxy` provider. The default `jwt` mode verifies the
proxy's signed assertion, including issuer and audience:

```bash
PORTAL_AUTH_PROVIDER=proxy
PORTAL_AUTH_PROXY_MODE=jwt
PORTAL_AUTH_PROXY_JWKS_URL=https://access.example.com/cdn-cgi/access/certs
PORTAL_AUTH_PROXY_ISSUER=https://access.example.com
PORTAL_AUTH_PROXY_AUDIENCE=<application-audience>
# Optional; defaults to Cloudflare Access's assertion header.
# PORTAL_AUTH_PROXY_JWT_HEADER=cf-access-jwt-assertion
```

Claim names are configurable with `PORTAL_AUTH_PROXY_SUBJECT_CLAIM`,
`PORTAL_AUTH_PROXY_EMAIL_CLAIM`, `PORTAL_AUTH_PROXY_NAME_CLAIM`,
`PORTAL_AUTH_PROXY_ROLES_CLAIM`, and `PORTAL_AUTH_PROXY_GROUPS_CLAIM`.
Authorization still flows through the ordinary `PORTAL_AUTHZ_*` policy.

Unsigned header mode is only safe when the portal origin cannot be reached
except through the trusted proxy. It deliberately refuses startup without the
explicit acknowledgement:

```bash
PORTAL_AUTH_PROVIDER=proxy
PORTAL_AUTH_PROXY_MODE=header
PORTAL_AUTH_PROXY_TRUST_HEADERS=true
# Defaults: x-forwarded-user, x-forwarded-email,
# x-forwarded-preferred-username, x-forwarded-groups
```

Override those names with `PORTAL_AUTH_PROXY_SUBJECT_HEADER`,
`PORTAL_AUTH_PROXY_EMAIL_HEADER`, `PORTAL_AUTH_PROXY_NAME_HEADER`, and
`PORTAL_AUTH_PROXY_GROUPS_HEADER`. The proxy completes sign-in before the SPA
loads, so this provider has no browser-side PKCE flow or token cache.

Portal branding and sign-in copy come from `plugin.json.portal`, with
`plugin.json.tui` used as a fallback when the portal plugin metadata does not
provide an override. Preferred portal metadata shape is nested under
`portal.branding`, `portal.ui`, and `portal.auth`; browser logo assets can be
supplied with `portal.branding.logoFile` and optional
`portal.branding.faviconFile`.

The provider can also be selected in plugin metadata:

```json
{
  "portal": {
    "auth": {
      "provider": "entra"
    }
  }
}
```

Selection precedence is:

1. `PORTAL_AUTH_PROVIDER`
2. `plugin.json.portal.auth.provider`
3. provider inference from provider-specific env vars
4. `none`

When the resolved provider is `none`, the portal still assigns a stable shared
identity to browser users: `provider=none`, `subject=unknown`, display name
`Unknown User`. All unauthenticated browser users in that no-auth deployment
therefore share the same Admin Console profile, GitHub Copilot key override,
profile settings, and session owner identity.

When `AUTHZ_ENFORCE_OWNERSHIP=true`, every session request is checked against
the authenticated principal's owner/share relationship. `private` sessions are
owner/admin only; `shared_read` and targeted read grants allow reads;
`shared_write` and targeted write grants allow reads and messages. Manage,
destroy, and share operations remain owner/admin only. Set
`SESSIONS_SYSTEM_VISIBILITY=admin` to hide system sessions from ordinary users.

`SESSIONS_DEFAULT_VISIBILITY` applies only to newly-created sessions. Migration
`0029` stamps existing sessions as `private`; before enabling enforcement on an
existing collaborative deployment, explicitly share the sessions that should
remain visible or keep enforcement disabled during the transition. See
[Access, sharing & security](../../user-guide/security-and-sharing.md).

### Dispatcher delegation

`DISPATCHER_SP_OBJECT_ID` (portal; unset by default) names the deployment's
**dispatcher**: an application that signs in with its own token and runs
sessions for the people who allow it. For Entra, that is an app-only token
holding the `user` app role, and the value is the service principal's object
ID (the token's `oid`, which the portal uses as the principal's subject).
Unset, none of the rules below applies and the portal makes no extra lookups.

- **The opt-in.** Each user turns delegation on or off for themselves only:
  the **Dispatcher Delegation** switch in Admin Console → Model Providers →
  My Providers (`g` on the same page of the TUI), or
  `PUT /api/v1/me/dispatcher-delegation`. It is stored in
  `users.allow_dispatcher_delegation` (CMS migration `0090`) and is off until
  the user turns it on. The switch shows only on deployments that name a
  dispatcher.
- **Creating for a user.** `createSession` and `createSessionForAgent` accept
  `onBehalfOfOwner: { subject, provider? }` from the dispatcher only — from
  nobody else, admins included — and only for a user whose opt-in is on. That
  user owns the session, its visibility stays `private`, and the dispatcher
  gets a targeted `write` share, the session's only share.
- **Ending the work.** On a session it holds that write share on, the
  dispatcher may also complete, cancel and delete it (with `force` and
  `settleTimeoutMs`) while the owner's opt-in is on.
- **Finishing a deleted tree.** A forced delete of a session that is already
  deleted (a retry, or what a plain delete left) finishes the rest of its
  tree. With ownership enforced, the portal finds that session in the
  caller's own listing of deleted sessions and decides on its tree's root.
  The owner and admins may finish it. The dispatcher may too while a live
  session is left in the tree: the portal reads its share through that
  session, and checks the owner's opt-in. Everyone else gets `404`, as for
  any deleted session.
- **Revocation is live.** Turning the opt-in off keeps the dispatcher's shares
  but refuses the dispatcher on that user's sessions from its next request:
  `403 DELEGATION_REVOKED` wherever it would otherwise have access (a session
  it never had still answers `404`), the sessions leave its listings, and an
  open WebSocket subscription stops before its next event. Turning the opt-in
  back on restores access to the same sessions.
- **Audit.** Each delegated creation and end of work writes its `authz_audit`
  entry (decision `delegated`) before the portal answers, and fails with
  `503 AUDIT_UNAVAILABLE` when it cannot; it also prints one JSON log line
  (`"event":"pilotswarm.dispatcher_delegation"`) for log-based alerting.

How each rule behaves under `AUTHZ_ENFORCE_OWNERSHIP`:

| Rule | `true` | `false` (default, audit only) |
|---|---|---|
| `onBehalfOfOwner` | Dispatcher and opted-in owner only | Same — a new capability, always enforced |
| Opt-in off | `403 DELEGATION_REVOKED`, left out of listings, subscriptions stop | Audited as `would_deny`; access unchanged, like every other session rule in this mode |
| Delegated complete / cancel / delete | Allowed with the write share and the opt-in, audited first | Same |
| `force` on `deleteSession` | Owner, admin or delegated dispatcher, also on a deleted tree (above) | Same — always enforced, except on a session that is already deleted, which passes unchecked like every call on a session the portal can't find |

To try it locally with the dev auth provider, add a persona for the dispatcher
(`PORTAL_AUTH_DEV_USERS=ada:admin,alice:user,dispatcher:user`) and set
`DISPATCHER_SP_OBJECT_ID=dispatcher`.

### Session Message Scope

Every session has the `send_session_message` and `reply_session_message`
tools. `PILOTSWARM_SESSION_MESSAGE_SCOPE` sets which sessions they reach:

| Value | Messages and replies reach |
|---|---|
| `fleet` (default, also when unset) | Any live session. A message between two users' sessions is framed as advisory. |
| `owner` | Sessions with the same user owner. A system session reaches only system sessions and is reached only by them. |

With `owner`, a session counts as a system session when it is one, when the
system user owns it (the children that system sessions spawn), or when the
root of its tree is one. A session with no owner can neither send nor
receive. Any other message or reply is refused with `policy_denied` before
it is queued. `list_sessions` is unchanged.

Set it on the workers and on the portal. The standalone worker
(`packages/sdk/examples/worker.js`) and the workers that the portal and the
TUI embed pass it to the `PilotSwarmWorker` option `sessionMessageScope`.
With `owner`, the portal also refuses a non-admin's shared `storeFact` under
`skills/`, `asks/` or `config/facts-manager/`, and a shared `deleteFact`
whose key or pattern can match one of them: every session's prompt reads
those facts, and the agent tools already reserve them for the Facts Manager.
Administrators (and every caller when portal sign-in is off) and other shared
keys are unaffected. Any other value stops the worker or the portal at startup.

## PostgreSQL Setup

### Worker Runtime Tuning

PilotSwarm deployments use environment variables for PostgreSQL pool sizing,
Duroxide runtime concurrency, and process-wide worker limits.

- `DUROXIDE_PG_POOL_MAX`
  Sets the `duroxide-pg` provider pool size. Default: `10`.
- `PILOTSWARM_CMS_PG_POOL_MAX`
  Sets the session catalog (`pg.Pool`) max size. Default: `3`.
- `PILOTSWARM_FACTS_PG_POOL_MAX`
  Sets the facts store (`pg.Pool`) max size. Default: `3`.
- `PILOTSWARM_ORCHESTRATION_CONCURRENCY`
  Sets Duroxide orchestration concurrency. Default: `2`.
- `PILOTSWARM_WORKER_CONCURRENCY`
  Sets Duroxide activity/worker concurrency. Default: `2`.
- `PILOTSWARM_TURN_TIMEOUT_MS`
  Sets the wall-clock cap for one Copilot turn across the worker deployment.
  Default: `1200000` (20 minutes). Set `0` to disable the cap. An explicit
  `PilotSwarmWorker({ turnTimeoutMs })` option takes precedence over the env var.
- `PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE`
  `1` gives sub-agents no workspace, neither their parent's nor one the parent
  names: `spawn_agent` no longer offers `workspace` and refuses one with
  `WORKSPACE_PATH_INVALID`. For a workspace provider that can give a folder to
  only one session at a time. Default: `0`. See
  [Workspace providers](../building/workspace-providers.md).
- `PILOTSWARM_CLI_ABORT_TIMEOUT_MS`
  Limits how long a turn waits for the Copilot CLI to answer the abort sent
  when the turn cap or the inactivity watchdog (no CLI events for 5 minutes)
  ends the turn.
  Default: unset, no limit, so a CLI that never answers keeps the turn and
  its worker activity open. When set and the CLI does not answer in time,
  the worker ends that CLI process and every process below it, its shells
  included, then force-stops its client. A wedged CLI can't stop its own
  shells, and they would keep running, detached ones too, in the folder the
  retry works in.
  The turn ends as a lost connection, which the session retries on a fresh
  CLI. Other sessions that the stopped process served lose their shells
  too, and resume on a fresh CLI at their next turn.
  A positive whole number of milliseconds up to `2147483647`, for example
  `30000`; the worker refuses to start with any other value.
- `PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS`
  Sets how long the worker waits for a workspace provider to make one folder
  ready (`listRoots` and `ensureAttached` together). Default: `30000`
  (30 seconds). A positive whole number of milliseconds up to `2147483647`;
  the worker refuses to start with any other value. See
  [Writing a workspace provider](../building/workspace-providers.md).
- `PILOTSWARM_EVENT_RETENTION_MINUTES`
  An extra floor, in minutes, for the Resource Manager's `purge_old_events`:
  no purge deletes events younger than this, whatever age the agent asks for.
  Unset: the tool's 60-minute floor and 24-hour default. A worker refuses to
  start with a value that isn't a positive whole number.
- `PILOTSWARM_DISABLE_K8S_SCALING`
  `1` makes the Resource Manager's `scale_workers` refuse, for deployments
  whose workers aren't a Kubernetes deployment it should scale. Default: `0`.
- `PILOTSWARM_LIMIT_SYSTEM_SESSION_TOOLS`
  `1` leaves system sessions only their PilotSwarm tools and the Copilot
  CLI's `skill` tool: no shell, file, web, MCP or native task tools, and no
  Workflow tools (the Workflow context `none`), since a Workflow's script runs
  code with network access. Their
  Copilot sessions are also created and resumed with
  `enableSessionStore: false` and `skipEmbeddingRetrieval: true`, so they stay
  out of the CLI's cross-session store and skip embedding retrieval, whose
  cache other sessions share. It applies to sessions marked system
  (PilotSwarm's system agents and an app's own), to sessions the system user
  owns (the sessions that system sessions spawn) and to every session whose
  root is one of those. A session whose own row or root can't be read at that
  moment is limited too, so the setting fails closed; its next turn with a
  readable row is not. Other sessions are unchanged. Default: `0`, which
  gives system sessions the CLI's built-in tools too and sets neither option.
  Leave it off if an app's system agents need tools beyond PilotSwarm's.
- Duroxide lock settings. Each has a matching `PilotSwarmWorker` option
  (`workerLockTimeoutMs`, `workerLockRenewalBufferMs`, `orchestratorLockTimeoutMs`,
  `orchestratorLockRenewalBufferMs`, `sessionLockTimeoutMs`,
  `sessionLockRenewalBufferMs`), which takes precedence over the env var.
  A running item renews its lock this many ms before the lock expires, so the
  renewal buffer is the longest stall (a blocked event loop, a paused
  database) it survives without losing the lock. An unset buffer defaults to
  75% of its lock timeout. Locks under 15 s renew at half their timeout and
  ignore the buffer.
  - `PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`: activity lock timeout. Default: `10000`.
  - `PILOTSWARM_WORKER_LOCK_RENEWAL_BUFFER_MS`: activity lock renewal buffer.
  - `PILOTSWARM_ORCHESTRATOR_LOCK_TIMEOUT_MS`: orchestration lock timeout. Default: `60000`.
  - `PILOTSWARM_ORCHESTRATOR_LOCK_RENEWAL_BUFFER_MS`: orchestration lock renewal buffer. Default: `45000`.
  - `PILOTSWARM_SESSION_LOCK_TIMEOUT_MS`: session lock timeout. Default: duroxide's.
  - `PILOTSWARM_SESSION_LOCK_RENEWAL_BUFFER_MS`: session lock renewal buffer.
- `PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS`
  `1` gives the session that writes session titles no tools and refuses every
  permission it asks for, so its model can only answer in text, and keeps that
  session out of the CLI's cross-session store and embedding cache
  (`enableSessionStore: false`, `skipEmbeddingRetrieval: true`). That session
  reads the latest messages of any user's session; by default it has the
  CLI's built-in tools, the shell included, with every permission approved.
  Default: `0`.

Example:

```bash
DUROXIDE_PG_POOL_MAX=10
PILOTSWARM_CMS_PG_POOL_MAX=3
PILOTSWARM_FACTS_PG_POOL_MAX=3
PILOTSWARM_ORCHESTRATION_CONCURRENCY=2
PILOTSWARM_WORKER_CONCURRENCY=2
PILOTSWARM_TURN_TIMEOUT_MS=1200000
PILOTSWARM_WORKER_LOCK_TIMEOUT_MS=10000
PILOTSWARM_ORCHESTRATOR_LOCK_TIMEOUT_MS=60000
PILOTSWARM_ORCHESTRATOR_LOCK_RENEWAL_BUFFER_MS=45000
```

### Local Development

```bash
# Create database
createdb pilotswarm

# Connection string
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pilotswarm
```

### Azure Database for PostgreSQL

```bash
DATABASE_URL=postgresql://user:password@myserver.postgres.database.azure.com:5432/postgres?sslmode=require
```

The runtime automatically handles SSL certificate validation for Azure-managed PostgreSQL (strips `sslmode` from the URL and configures `rejectUnauthorized: false`).

### Schema Initialization

Both the duroxide runtime and the session catalog (CMS) create their schemas automatically on first connection:

- **`duroxide`** schema — orchestration state, execution history, queues
- **`copilot_sessions`** schema — session records, event log

No manual migration needed.

A worker whose database role can't change the schema sets
`PILOTSWARM_SKIP_DB_MIGRATIONS=1` (default `0`): it then never migrates the
CMS and facts schemas, and only checks that every migration it knows is
applied. If one is missing, it fails at startup and names it, so run the
migrations first, for example in a deployment's migration job that starts the
same code without the setting, as the Windows worker pool's
[database role Job](../deploy/windows-workers.md#the-database-role-job) does.

### Database Reset

To wipe all state and start fresh:

```bash
npm run db:reset
# or
node --env-file=.env scripts/db-reset.js
```

## Single-Process Mode

The simplest setup — client and worker in the same process:

```typescript
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";

const store = process.env.DATABASE_URL;

const worker = new PilotSwarmWorker({
    store,
});
await worker.start();

const client = new PilotSwarmClient({ store });
await client.start();

const session = await client.createSession({
    systemMessage: "You are a helpful assistant.",
});

// Must forward tools to co-located worker
worker.setSessionConfig(session.sessionId, { tools: [myTool] });

const response = await session.sendAndWait("Hello!");
```

This is great for development and testing. The worker runs LLM turns in-process.

> **Note:** the direct `{ store }` client construction shown here is appropriate only because client and worker are co-located in one trusted process. It is internal (worker/portal-host embedding and testing). Standalone client apps should use web mode — `new PilotSwarmClient({ apiUrl })` — as shown below.

## Separate Worker Process

For production, run workers as separate processes:

### Worker Process

```javascript
// worker.js
import { PilotSwarmWorker } from "pilotswarm-sdk";

const worker = new PilotSwarmWorker({
    store: process.env.DATABASE_URL,
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
});

await worker.start();
console.log("Worker started, polling for orchestrations...");

// Graceful shutdown
process.on("SIGTERM", async () => {
    await worker.stop();
    process.exit(0);
});

// Block forever
await new Promise(() => {});
```

### Client Process

Client apps connect over the deployment's Web API (hosted by the portal server) — no database or storage credentials needed:

```javascript
// app.js
import { PilotSwarmClient } from "pilotswarm-sdk";

const client = new PilotSwarmClient({
    apiUrl: "https://portal.example.com",  // your deployment's portal URL
    // getAccessToken: async () => token,  // for auth-protected deployments
});
await client.start();

const session = await client.createSession();
await session.send("Monitor the API every 10 minutes");

// Client can exit — the worker will continue processing
console.log(`Session ${session.sessionId} is running on the worker`);
```

The client talks to the portal's [Web API](../../api/reference.md); the portal enqueues work into PostgreSQL, and workers poll and execute. Direct `{ store }` client construction (connecting straight to the database) still exists but is internal — for worker/portal-host embedding and internal testing only.

## Worker Options

```typescript
new PilotSwarmWorker({
    // Required
    store: string,           // PostgreSQL connection string
    githubToken: string,     // GitHub Copilot token

    // Optional
    logLevel: "info",        // "none" | "error" | "warning" | "info" | "debug" | "all"
    waitThreshold: 30,       // seconds — waits above this become durable timers
    workerNodeId: "pod-1",   // identifier for this worker (default: hostname)
    turnTimeoutMs: 1_200_000, // explicit override; 0 disables the cap
    sessionMessageScope: "fleet", // "fleet" | "owner"; see Session Message Scope above
    ownerTag: "owner.<subject>", // owner routing: also run this owner's sessions (default: none)
    ownerOnly: false,        // owner routing: run only this owner's sessions, nothing else (needs ownerTag)
    workflowScripts: { enabled: true },  // run workflow script states; on by default (env PILOTSWARM_WORKFLOW_SCRIPTS=0 turns them off)

    // Blob storage for session dehydration
    blobConnectionString: string,   // Azure Storage connection string
    blobContainer: string,          // container name (default: "copilot-sessions")

    // Schema isolation (for multi-tenant on same database)
    duroxideSchema: "ps_duroxide",      // orchestration schema (default: "ps_duroxide")
    cmsSchema: "copilot_sessions",       // session catalog schema (default: "copilot_sessions")
});
```

  PostgreSQL pool sizing and Duroxide concurrency are intentionally **not** part
  of `PilotSwarmWorkerOptions`; configure them with the env vars above. Turn
  timeout supports both layers: the explicit constructor option wins, then
  `PILOTSWARM_TURN_TIMEOUT_MS`, then the 20-minute SDK default.

### Copilot CLI Environment

Each Copilot CLI a worker starts, for a session, model listing, titles or the
distiller, gets the worker's whole environment by default, and so do the
agents' shells and the MCP servers the CLI starts. With
`PILOTSWARM_SCRUB_CLI_ENV=1` (default `0`), a CLI gets only:

- the platform baseline. On Windows: `PATH`, `PATHEXT`, `SystemRoot`, `windir`,
  `SystemDrive`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `HOMEDRIVE`,
  `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ALLUSERSPROFILE`,
  `PUBLIC`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`,
  `CommonProgramFiles`, `CommonProgramFiles(x86)`, `CommonProgramW6432`,
  `PSModulePath`, `PROCESSOR_ARCHITECTURE`, `PROCESSOR_IDENTIFIER`,
  `NUMBER_OF_PROCESSORS`, `OS`, `COMPUTERNAME`, `USERNAME` and `USERDOMAIN`.
  On Linux and macOS: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
  `LANG`, `LC_*` and `TERM`;
- the Copilot settings `COPILOT_HOME`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`,
  `COPILOT_CLI_PATH` and `COPILOT_PKG_CACHE_HOME`, which points the Copilot CLI
  program at an unpacked copy of itself
  ([Personal Keys in an External Secret Store](#personal-keys-in-an-external-secret-store)).
  Other Copilot variables, such as `COPILOT_CLI_DIST_DIR` and
  `COPILOT_CACHE_HOME`, are dropped;
- the names in `PILOTSWARM_CLI_ENV_ALLOWLIST` (default: unset), comma-separated,
  where a trailing `*` matches a prefix: for example `NUGET_*,DOTNET_*,MSBUILD*`
  for agents that build .NET code. A worker refuses to start with an entry that
  is neither a name nor a prefix.

Names match in any case. Credentials such as the database URL, provider keys
and cloud credentials stay in the worker. An MCP server that needs one gets it
from its `env` block, whose `${VAR}` placeholders still expand from the
worker's environment. The SDK still adds the CLI's own token
(`COPILOT_SDK_AUTH_TOKEN`), which the agents' shells can read unless the
next setting keeps it from them.

```bash
PILOTSWARM_SCRUB_CLI_ENV=1
PILOTSWARM_CLI_ENV_ALLOWLIST=NUGET_*,DOTNET_*,MSBUILD*
```

`PILOTSWARM_CLI_SECRET_ENV_VARS` names variables, comma-separated, that the
CLI keeps out of the environment of the shells, MCP servers and hooks it
starts, usually `COPILOT_SDK_AUTH_TOKEN`. The CLI itself still uses them. Only
the Copilot CLI program takes this list (`--secret-env-vars`), not the runtime
the SDK bundles, so with the setting every CLI the worker starts is that
program: the platform package of `@github/copilot`, which the SDK installs, or
`COPILOT_CLI_PATH` when it is set, which must then name the program. The
program also offers its own bundled skills, so sessions are created and
resumed without them (`includedBuiltinSkills: []`); the deployment's skills
stay available. Unset (the default), the SDK's bundled runtime runs as
before. A worker refuses to start when a name is not a variable name or the
program is not installed.

Keeping a variable out of a shell's environment does not hide its value
anywhere else: a command that prints the same value from another place, such
as a file, shows it to the model.

The program unpacks itself into a package cache, by default in the account's
local application data, and every later launch runs that copy. Point
`COPILOT_PKG_CACHE_HOME` at an unpacked copy that the worker's account cannot
write, so that no session can change the program that later sessions run.

```bash
PILOTSWARM_CLI_SECRET_ENV_VARS=COPILOT_SDK_AUTH_TOKEN
```

### Copilot CLI Hooks

The Copilot CLI runs the hooks it finds in its home (`COPILOT_HOME`: inline
`hooks` in `settings.json` or `config.json`, and the files in `hooks/`) and in
the session's working folder (such as `.github/hooks/*.json`,
`.github/copilot/settings.json` and `.claude/settings.json`). A hook is a
command that runs as the worker's account, so a session that writes one of
those files can make later sessions run its commands.

With `PILOTSWARM_CLI_DISABLE_HOOKS=1` (default `0`):

- every session PilotSwarm creates or resumes sets `enableFileHooks: false`,
  which turns off the working folder's hooks;
- before every CLI launch and every session create or resume, the worker puts
  the CLI home's `settings.json` in a form that turns inline hooks off
  (`{"disableAllHooks": true}`), and its `config.json` in the CLI's own form,
  its two comment lines and only `firstLaunchAt`, because a key in
  `config.json` replaces the same key in `settings.json`. It compares parsed
  content and writes a file only when it differs, through a temporary file
  and a rename, and drops any other key a session wrote there. When it cannot,
  the launch or session call fails.

The SDK exports both contents (`CLI_HOOKS_OFF_SETTINGS_TEXT`,
`CLI_HOOKS_OFF_CONFIG_TEXT`), so an image can create the files read-only ahead
of time: a file already in its form is never written. The files in the home's
`hooks/` folder still run, so keep that folder empty and read-only.

The setting rewrites the CLI home's settings, so it never runs against an
account's own `~/.copilot`: every CLI needs `COPILOT_HOME`, and the worker
refuses to start unless its session state folder (`sessionStateDir`) is
`COPILOT_HOME`'s `session-state` folder. Unset, PilotSwarm passes no
`enableFileHooks` and leaves both files alone.

## Owner Routing (optional)

Owner routing keeps each user's sessions on that user's own workers, for
deployments where a worker holds one user's files or credentials. It is off
unless you turn it on, and it needs orchestration 1.0.84 or later.

| Setting | Where | What it does |
|---|---|---|
| `ownerRouting: true` or `PILOTSWARM_OWNER_ROUTING=1` | `PilotSwarmClient` and `PilotSwarmManagementClient` (the option wins over the env var) | When the client starts a top-level user session, it records the owner's routing tag `owner.<subject>` in the session's orchestration input. System sessions and sessions without an owner stay untagged. A sub-agent created during a tagged turn takes that turn's tag and busy policy, whatever the client's setting. In a tagged tree no Workflow is started or tested: an agent's `spawn_workflow` and `workflow_definition` `start` and `test` are refused (`WORKFLOW_OWNER_ROUTED`), and so is `create_agent_session`. The management client refuses a person's start there (409 `WORKFLOW_OWNER_ROUTED`): a session whose creation config, or its root's, carries a tag and, with this setting, any user session's tree. Default: off (`0`) |
| `ownerTag: "owner.<subject>"` | `PilotSwarmWorker` option; `PILOTSWARM_WORKER_OWNER_TAG` in `examples/worker.js` | The worker also runs the activities tagged for this owner. Each activity of a tagged session runs only on a worker with its tag, and waits in the queue while there is none. The tag has no spaces or control characters and is at most 256 bytes. Default: none |
| `ownerOnly: true` | `PilotSwarmWorker` option; `PILOTSWARM_WORKER_OWNER_ONLY=1` in `examples/worker.js` (`0` or unset: off; any other value stops the worker) | The worker runs only the activities tagged for its `ownerTag`: the turns and other session-scoped activities of that owner's sessions. It runs no untagged work (system sessions' turns, titles, the manager activities before and after every turn), no capability-tagged activity and no capacity request, even with a capacity requester. Another worker without `ownerOnly` must run that work, or the owner's sessions wait. Without `ownerTag` the worker refuses to start |
| `worker.setOwnerCapacityRequester(fn)` | `PilotSwarmWorker`, before `start()`; a worker with an `ownerTag` and without `ownerOnly` refuses to start with one | The worker answers capacity requests: before each turn of a tagged session, the orchestration asks one worker with a requester. `fn({ sessionId, rootSessionId, ownerTag }, signal)` returns `{ decision: "ok" }`, `{ decision: "deny", message?, code? }` (the turn ends and is not retried) or `{ decision: "busy", message?, code?, retryAfterMs? }` (the prompt waits and the session asks again). After 15 s the signal fires and the session waits a minute (`CAPACITY_UNAVAILABLE`). With owner routing on and no worker with a requester, tagged sessions wait |
| `workspaceBusyFastRelease: true` or `PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE=1` | `PilotSwarmClient` (the option wins over the env var) | Sessions the client starts, and the sessions they create, use the fast busy policy: a `WORKSPACE_BUSY` refusal releases the worker at once and retries after 10 s, 20 s, 1 min, then every 3 min, instead of 30 s, 2 min, 5 min, then every 15 min with a release after two refusals on one worker. Default: off (unset) |

A worker's Duroxide tag filter holds the four capability tags, plus its owner
tag or, with a capacity requester, the capacity tag `pilotswarm.owner-capacity.v1`:
five tags, Duroxide's limit, so a worker never has both. It is `defaultAnd`, so
the worker also runs untagged activities. An owner-only worker's filter is `{ tags: [ownerTag] }`, which
admits that one tag. Duroxide applies the filter to activities only: every
worker runs orchestrations. But `ctx.utcNow()` and `ctx.newGuid()` are untagged
Duroxide activities, so an orchestration also needs a worker without
`ownerOnly` to move on. Start the workers that declare owner tags and the
capacity requester before you turn on `PILOTSWARM_OWNER_ROUTING`. Sessions
that started before the upgrade, on orchestration 1.0.82 or older, stay
untagged. See the [orchestration design](../../architecture/orchestration/design.md#owner-routing-and-capacity-requests-1084)
and its [owner-only workers](../../architecture/orchestration/design.md#owner-only-workers).

### Coordination Host on Azure

On Azure, with a pool of owner-only Windows workers, the Linux worker runs the
work they do not and takes every capacity request. It loads the
[coordination host module](../../../deploy/providers/azure/linux-worker/README.md)
with `PILOTSWARM_EXTENSION_MODULES=/app/deploy/providers/azure/linux-worker/capacity-requester.mjs`,
which sends each capacity request to the disk controller and admits only
system sessions' turns. The module reads:

| Setting | What it does |
|---|---|
| `PS_COORDINATION_URL` | Required. The disk controller's coordination route, an `https://` origin with nothing after it: `https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005`. The module trusts the controller's certificate through `NODE_EXTRA_CA_CERTS`, which names the CA file from the ConfigMap `pilotswarm-disk-controller-ca` (two CAs during a CA rotation) |
| `PS_COORDINATION_TOKEN_SCOPE` | Required. The scope of the token the module gets from the pod's workload identity: `<app client ID>/.default` of the controller's app, whose `coordinator` role the identity holds |

Without either, or on a worker with `PILOTSWARM_WORKER_OWNER_TAG` or
`PILOTSWARM_WORKER_OWNER_ONLY=1`, the module stops the worker at start. On
Azure, `WIN_WORKER_COORDINATION_HOST=true` loads the module on
`copilot-runtime-worker` and sets both settings and `NODE_EXTRA_CA_CERTS`. The
[Windows workers](../deploy/windows-workers.md#the-coordination-host) guide
covers the coordination host's deployment.

## Windows Worker Pool (Azure)

An optional pool of Windows worker VMs, each serving one owner, with a Dev
Drive per session tree, a disk controller and a Linux coordination host. The
[Windows workers](../deploy/windows-workers.md) guide explains how the pieces
fit together and what a shared pool sets. This section lists the settings of
its Azure pieces with their defaults; the SDK settings it builds on have
sections of their own: [owner routing](#owner-routing-optional), the
[coordination host](#coordination-host-on-azure),
[admission and take-backs](../building/workspace-providers.md#taking-a-folder-back-and-shutting-down),
[personal keys](#personal-keys-in-an-external-secret-store) and their
[Key Vault store](#azure-key-vault-store-for-personal-keys),
[dispatcher delegation](#dispatcher-delegation), the
[message scope](#session-message-scope), the
[CLI's environment](#copilot-cli-environment) and [hooks](#copilot-cli-hooks),
and the worker settings under [Worker Runtime Tuning](#worker-runtime-tuning).
Unset, empty and `__PS_UNSET__` all mean unset.

### Deployment settings

In the stamp's env file (`deploy/providers/azure/envs/template.env`), read by
`deploy.mjs`, base-infra's Bicep and the overlays of the disk controller and the
Linux worker. Each is off or at its default unless set, and with
`WIN_WORKERS_ENABLED` and `SFI_COMPLIANT` both off, a redeploy renders exactly
what it did before.

| Setting | Default | What it does |
|---|---|---|
| `WIN_WORKERS_ENABLED` | `false` | Deploys the pool and the `disk-controller` service, and runs the database role Job after the Portal's rollout. Needs `EDGE_MODE=afd` or `private`, `DEPLOY_POSTGRES=true` with `PILOTSWARM_USE_MANAGED_IDENTITY=1`, `PORTAL_AUTH_ENTRA_CLIENT_ID` and `WIN_WORKER_ALERT_EMAILS` |
| `WIN_WORKER_ALERT_EMAILS` | unset | Comma-separated receivers of the pool's alerts; at least one is required with the pool |
| `WIN_WORKER_COUNT` | `5` | `X`: the most active VMs (1 to 100), the scale set's ceiling and the standby pool's ready capacity |
| `WIN_WORKER_MIN_RUNNING` | `1` | `Y`: the fewest active VMs, and the scale set's capacity when it is created. `0` needs `WIN_WORKER_COORDINATION_HOST=true` |
| `WIN_WORKER_STANDBY_MIN` | `1` | Deallocated VMs the standby pool keeps ready |
| `WIN_WORKER_VM_SIZE` | `Standard_D16ds_v5` | The VMs' size, which needs nested virtualization; a change reaches new VMs, and the controller replaces the others |
| `WIN_WORKER_IMAGE_VERSION` | unset | The gallery image version, `Major.Minor.Patch`. Unset, base-infra creates the gallery and its image definition but no scale set. The controller replaces VMs on another version |
| `WIN_WORKER_IDLE_RECYCLE_MINUTES` | `30` | Idle minutes before a bound VM is drained and deleted, and how long recent demand keeps one unbound VM ready |
| `WIN_WORKER_SCALE_IN_BATCH` | `1` | The most idle VMs deleted in one scale-in step |
| `WIN_WORKER_SCALE_IN_INTERVAL_MINUTES` | `5` | The fewest minutes between scale-in steps |
| `WIN_WORKER_COORDINATION_HOST` | `false` | `true` runs the Linux worker as the coordination host, with its own identity, and makes the Windows workers owner-only (`PILOTSWARM_WORKER_OWNER_ONLY=1`); `deploy all` then deploys the `worker` service just after the `portal`. Needs `PILOTSWARM_OWNER_ROUTING=1` and `WORKSPACES_ENABLED=false`. Without it, a stamp with the pool runs the Linux worker at 0 replicas. Turn it off service by service, never with one `deploy all`: see [Turning the coordination host off](../deploy/windows-workers.md#turning-the-coordination-host-off) |
| `WIN_WORKER_COORDINATION_HOST_REPLICAS` | `2` | The coordination host's replicas, 0 to 20. An upgrade freeze publishes 0 |
| `WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP` | unset | A ConfigMap in the worker's namespace with the plugin definitions the Windows workers load: `plugin.json`, `session-policy.json`, the agents' `*.agent.md` files, and each skill an agent declares as `<skill>.SKILL.md` (and `<skill>.tools.json`). The coordination host loads a read-only copy of only those (`PLUGIN_DIRS`). Unset, it loads the image's own plugins |
| `WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES` | unset | Comma-separated token prefixes that the coordination host redacts from what it persists (its `PILOTSWARM_REDACT_SECRET_PREFIXES`), each at least three letters, digits, `_` or `-`, starting with a letter or digit |
| `WIN_WORKER_WORKING_HOURS` | unset | Hours in which at least one VM stays active, such as `Mon-Fri 08:00-18:00 America/Los_Angeles` |
| `WIN_WORKER_EXTRA_ENV` | unset | Non-secret `NAME=VALUE` pairs for every VM, separated by semicolons, each value at most 4,096 characters. Reserved names are refused at deploy time and again on the VM |
| `WIN_WORKER_FEED_ENDPOINTS` | unset | Comma-separated `https` package feed URLs that the workers' NuGet credential provider signs in to with the workers' identity (`ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS` on the VMs) |
| `WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID` | unset | The object ID of the Standby Pool Resource Provider's service principal in the tenant. Unset, the deploy step looks it up by name, which needs directory read access |
| `WIN_DEV_DRIVE_POOL_COUNT` | `10` | `M`: the most drives at once, leased, spare and hydrating |
| `WIN_DEV_DRIVE_SPARE_COUNT` | `2` | Drives kept hydrated or hydrating as spares; a returned drive above it is deleted, not reset |
| `WIN_DEV_DRIVE_MAX_PER_USER` | `3` | `N`: the most leases per owner, parked ones included |
| `WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS` | `7` | Days after which a lease that no VM holds and nothing used is returned; a parked lease never expires |
| `WIN_DEV_DRIVE_SIZE_GB` | `1024` | A new drive's size |
| `WIN_DEV_DRIVE_GROW_FREE_PERCENT` | `20` | Grow a mounted drive when less than this share of it is free |
| `WIN_DEV_DRIVE_GROW_STEP_GB` | `256` | One growth step |
| `WIN_DEV_DRIVE_MAX_GB` | `2048` | No growth beyond this |
| `WIN_DEV_DRIVE_IOPS` | `6000` | A drive's provisioned IOPS (Premium SSD v2) |
| `WIN_DEV_DRIVE_MBPS` | `250` | A drive's provisioned throughput, MB/s |
| `WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID` | unset | The first golden snapshot's resource ID; the controller's weekly refresh replaces it. Unset, no claim succeeds |
| `PS_DISK_CONTROLLER_STARTUP_GRACE_SECONDS` | `60` | How long a new controller waits for heartbeats before it treats a silent VM as crashed |
| `PS_DISK_CONTROLLER_SNAPSHOT_REFRESH_DAYS` | `7` | The golden snapshot's refresh interval; `0` turns the refresh off |
| `PS_DISK_CONTROLLER_VM_SCRIPTS_DIR` | unset (`C:\pilotswarm\scripts`) | Where the image keeps the scripts the controller runs as Run Commands |
| `APPGW_TRUSTED_ROOT_CERTS` | `pilotswarm-disk-controller-ca` | With `EDGE_MODE=afd`, the prefix of the App Gateway trusted roots that the deploy uploads for the controller's CAs: one name of 1 to 67 letters, digits, `_`, `.` or `-`, starting with a letter or digit, never a list (the deploy refuses a comma). Roots are matched by certificate: a CA already on a root keeps it, whatever its name, and a CA on none is uploaded as `<prefix>-<the first 12 hex digits of the SHA-256 of its DER>`. A stamp deployed before CA rotations keeps its CA on the root named after the prefix itself, so it deploys as before. The deploy lists the roots, two during a CA rotation, for the dispatcher Ingress |
| `SFI_COMPLIANT` | `false` | The profile for policy-restricted subscriptions; see [Deploying to AKS](../deploy/aks.md#optional-policy-restricted-subscriptions) |
| `PERIMETER_OPERATOR_IP_PREFIXES` | unset | With `SFI_COMPLIANT=true`, comma-separated IPv4 addresses or CIDR prefixes that the network security perimeter also admits |

The deploy also refuses `PILOTSWARM_OWNER_ROUTING=1` without
`WIN_WORKERS_ENABLED=true`: only a bound Windows worker serves an owner tag.
The Portal settings that a pool sets (`DISPATCHER_SP_OBJECT_ID`, the personal
secret, owner routing, busy policy, idle and message scope settings) reach the
Portal's manifests from the same env file, and stay out of them at their
defaults.

### Dev Drive workspace extension

`packages/sdk/examples/devdrive-workspaces`
([README](../../../packages/sdk/examples/devdrive-workspaces/README.md)), loaded
on Windows workers through `PILOTSWARM_EXTENSION_MODULES`. It refuses to load
on another platform, without `PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1`,
or without the controller's URL and token module.

| Setting | Default | What it does |
|---|---|---|
| `PS_DISK_POOL_CONTROLLER_URL` | required | The controller's worker endpoint, `https://` only |
| `PS_DISK_CONTROLLER_TOKEN_MODULE` | required | A module path or package name that exports `getToken()`, called before every controller call |
| `PS_DISK_CONTROLLER_CA_CERT` | unset: Node's default roots | A PEM file of the only CAs the controller client trusts: one, or two while the controller's CA rotates. Read again for every TLS agent, so the CA can rotate without a worker restart |
| `PS_DISK_ATTACHER_URL` | `http://127.0.0.1:3099` | The local attacher service; `http://` on a loopback address only |
| `PS_DISK_ATTACHER_TOKEN_FILE` | `C:\pilotswarm\run\attacher.token` | The attacher's token, read again after a `401` |
| `PS_WORKSPACE_ROOTS` | `repos=Q:\Repos` | The workspace roots, `name=path` comma-separated, all on the drive |
| `PS_WORKSPACE_ADOPT` | `instructions,agents,skills` | What may be adopted from a working folder; `none` adopts nothing |
| `PS_EMPTY_HOOKS_DIR` | unset: the null device | `core.hooksPath` of the extension's own Git calls |
| `PS_WIP_BRANCH_PREFIX` | `pilotswarm/wip/` | The WIP branch, `<prefix><rootSessionId>` on each repository's `origin` |
| `PS_LAUNCH_ID` | a new ID | This service start's ID, reported in every heartbeat; the launcher sets it |
| `WIN_WORKER_CONFIG_VERSION` | unset | The VM's configuration version, from `userData`, reported in every heartbeat. The controller has the current one in the same setting and replaces VMs that report another |

It also reads `PILOTSWARM_WORKER_OWNER_TAG` (the worker started bound) and
`PILOTSWARM_WORKER_OWNER_ONLY` (`1`: no capacity requester), described under
[Owner Routing](#owner-routing-optional), and
`PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS` as its own attach budget, 10 minutes
when unset: an attach that waited for LUN 0 past it starts nothing.

### Windows worker services

`deploy/providers/azure/windows/`
([README](../../../deploy/providers/azure/windows/README.md)). The launcher and
the attacher read the image's `C:\pilotswarm\worker.env`, overlaid with the
scale set's `userData`, which the deploy renders. Besides the database, storage
and identity values every worker reads, they read:

| Setting | Default | What it does |
|---|---|---|
| `PS_DISK_CONTROLLER_TOKEN_SCOPE` | required | In `userData`: `<app client ID>/.default` or `api://<app client ID>/.default` of the Portal's Entra app, the scope of the workers' controller tokens, which carry the `worker` role |
| `EXPECTED_WIN_WORKER_OID` | required | In `userData`: the workers' identity's object ID; the launcher refuses to start when the instance metadata service issues tokens to another |
| `ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS` | required, `{"endpointCredentials":[]}` for none | In `userData`: the NuGet credential provider's feeds, from `WIN_WORKER_FEED_ENDPOINTS`, each signed in to with the workers' identity and never a password |
| `PS_WORKER_RELEASES_CONTAINER` | `win-worker-releases` | In `worker.env`: the release container of `AZURE_STORAGE_ACCOUNT_URL` that `/sync-release` reads |

`userData` also carries `WIN_WORKER_CONFIG_VERSION` and
`PILOTSWARM_WORKER_OWNER_ONLY`, `1` with `WIN_WORKER_COORDINATION_HOST=true`
and `0` otherwise. A missing, unknown or invalid `userData` value stops the
launcher instead of falling back to a default.

The image's `worker.env` also pins the tools' own settings, which a worker
settings file can't change: Git's `GIT_CONFIG_GLOBAL`, a read-only global
configuration; the Azure CLI's `AZURE_CONFIG_DIR`, which the launcher clears
and signs in again as the workers' identity at every service start; and
`AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`, `AZURE_EXTENSION_DIR` and
`AZURE_EXTENSION_DEV_SOURCES`, an empty read-only folder, and
`AZURE_EXTENSION_SYS_DIR`, the system extension folder, so no session installs
an Azure CLI extension. Its `PILOTSWARM_CLI_ENV_ALLOWLIST` always passes
`GIT_CONFIG_GLOBAL`, `AZURE_CONFIG_DIR` and `AZURE_EXTENSION_*` to agents'
tools: the image build appends each that no entry of the settings file covers,
and an entry the SDK would refuse fails the build.

### Disk controller

`deploy/providers/azure/disk-controller/`
([README](../../../deploy/providers/azure/disk-controller/README.md)). Besides the
deployment settings above, `DISPATCHER_SP_OBJECT_ID`,
`PILOTSWARM_PERSONAL_SECRET_VAULT_URI`, `PS_DISK_CONTROLLER_TOKEN_SCOPE`,
`EXPECTED_WIN_WORKER_OID` and `WIN_WORKER_CONFIG_VERSION`, the controller reads
these, which the deploy fills in from base-infra's outputs. A wrong value stops
it at start.

| Setting | Default | What it does |
|---|---|---|
| `PS_DISK_POOL_STATE_URL` | required | The blob container that keeps the controller's state |
| `AZURE_TENANT_ID` | required | The tenant whose v2 tokens the controller accepts |
| `AZURE_AUTHORITY_HOST` | `https://login.microsoftonline.com/` | The token authority |
| `WIN_WORKER_SCALE_SET_ID` | unset | The scale set's resource ID. Unset, the worker routes answer `503 NOT_READY` and claims `busy` |
| `WIN_WORKER_DCR_ID` | unset | The workers' data collection rule, associated with each VM before its first `active` |
| `WIN_WORKER_STANDBY_POOL_ID`, `WIN_WORKER_GALLERY_IMAGE_ID` | unset | The standby pool and the image definition, for operators and tools; the controller reads neither |
| `PS_DISK_CONTROLLER_TLS_FILE` | `/mnt/disk-controller-tls/disk-controller-tls` | The PEM bundle the controller serves |

## Enhanced Facts & Knowledge Graph (optional)

By default the facts store is plain Postgres (`PgFactStore`) — every session gets
the `store_fact` / `read_facts` / `delete_fact` tools. Two **optional, independently
injected** providers extend this without changing the default:

- **EnhancedFactStore** — multi-signal retrieval (lexical + semantic + hybrid) plus
  a durable in-DB embedder, backed by a HorizonDB (preview) cluster with
  `pgvector` + `pg_textsearch` + `pg_durable`. Lights up `facts_search`,
  `facts_similar`, and an on-demand `search_skills` tool.
- **GraphStore** — an open knowledge graph (Apache AGE) for entities/edges with
  fact-`scopeKey` evidence anchors. Lights up the graph read tools
  (`graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood`) plus a
  harvester-only crawl-queue + graph-write surface.

The two axes are orthogonal: enhanced-facts works without a graph, and a graph
works over a base fact store (you get graph tools but no search tools). Graph
tools key off **graph presence alone** (`graphDatabaseUrl` set), never the facts
capability.

```typescript
new PilotSwarmWorker({
    store: process.env.DATABASE_URL,

    // ── EnhancedFactStore (optional) ──
    // Setting enhancedFactsDatabaseUrl alone constructs the enhanced provider
    // (factsProvider inferred "horizon"). Resolution for the facts URL is
    // enhancedFactsDatabaseUrl ?? cmsFactsDatabaseUrl ?? store.
    enhancedFactsDatabaseUrl: process.env.HORIZON_DATABASE_URL,
    factsProvider: "horizon",            // optional; inferred when the URL is set
    enhancedFactsSchema: "horizon_facts", // default: "horizon_facts"
    horizonEmbed: {                       // optional; omit ⇒ lexical-only search
        url: process.env.HORIZON_EMBED_URL,
        model: process.env.HORIZON_EMBED_MODEL,
        dim: Number(process.env.HORIZON_EMBED_DIM),
        apiKey: process.env.HORIZON_EMBED_API_KEY,
    },

    // ── GraphStore (optional, opt-in) ──
    // Unset ⇒ no graph, no graph tools. May reuse the enhanced facts URL.
    graphDatabaseUrl: process.env.HORIZON_GRAPH_DATABASE_URL,
    graphSchema: "horizon_graph",         // AGE graph name; default: "horizon_graph"
    graphRegistrySchema: "horizon_graph_registry", // sidecar schema; default: `${graphSchema}_registry`
    graphNamespaceCacheTtlMs: 60000,       // namespace-list cache; 0 disables
});
```

> **Schema-collision guard.** Apache AGE creates a Postgres schema named after the
> graph. When `graphDatabaseUrl` is the **same** database as the facts store, the
> `graphSchema` MUST differ from the facts schema — the worker fails fast at start
> if they collide. The defaults (`horizon_facts` vs `horizon_graph`) are already
  > distinct. The graph namespace registry is a separate relational sidecar schema
  > (`graphRegistrySchema` / `HORIZON_GRAPH_REGISTRY_SCHEMA`) and must also differ
  > from the AGE graph name. By default it is `${graphSchema}_registry`.

> **Env shortcut.** The shipped worker entrypoints (the CLI/portal embedded worker
> and the standalone K8s worker) wire all of the above from the canonical
> `HORIZON_*` env vars via the SDK helper `horizonConfigFromEnv()`. Custom apps can
> use the same one-liner — it returns `{}` when `HORIZON_DATABASE_URL` is unset, so
> default deployments are unaffected:
>
> ```typescript
> import { PilotSwarmWorker, horizonConfigFromEnv } from "pilotswarm-sdk";
>
> const worker = new PilotSwarmWorker({
>     store: process.env.DATABASE_URL,
>     githubToken: process.env.GITHUB_TOKEN,
>     ...horizonConfigFromEnv(), // HORIZON_DATABASE_URL / _GRAPH_DATABASE_URL / _EMBED_* / _*_SCHEMA
> });
> ```
>
> See [`.env.horizondb.example`](../../../.env.horizondb.example) for the full list of `HORIZON_*` vars.

**Direct-mode (internal) clients** and management clients embedded next to the
worker must resolve the **same** facts target as the worker, or session cleanup
hits the wrong database. Pass the matching fields (web-mode `{ apiUrl }` clients
need none of this — the portal host resolves it server-side):

```typescript
new PilotSwarmClient({
    store: process.env.DATABASE_URL,
    enhancedFactsDatabaseUrl: process.env.HORIZON_DATABASE_URL, // match the worker
    factsProvider: "horizon",
    enhancedFactsSchema: "horizon_facts",
});
```

To run a `crawler: true` ingestion agent continuously as its own service over a
shared HorizonDB, see [Deploying a Knowledge Harvester](../deploy/harvester.md).

### Role-based tool exposure

Which enhanced/graph tools a session sees is the cross product of capability,
graph presence, and **session role** (`agentIdentity`):

| Tool group | Who gets it | Gated on |
|------------|-------------|----------|
| `store_fact` / `read_facts` / `delete_fact` | every session | always |
| `facts_search` / `facts_similar` | every reader (incl. `agent-tuner`) | enhanced + `capabilities.search` |
| `search_skills` | every reader **except `facts-manager`** (it owns the namespace) | enhanced + `capabilities.search` |
| `graph_search_nodes` / `graph_search_edges` / `graph_neighbourhood` | every reader | `graphDatabaseUrl` set |
| `graph_stats` (read-only) | `facts-manager` + `agent-tuner` | `graphDatabaseUrl` set |
| crawl queue + `graph_remove_evidence` + namespace archive | app **crawler role** + `facts-manager` (dormant) | `graphDatabaseUrl` set |
| `graph_upsert_*` / `graph_merge_nodes` / `graph_delete_*` | every non-tuner session | `graphDatabaseUrl` set |

`agent-tuner` is **strictly read-only**: it gets every read tool (including
`graph_stats`) but never a write, delete, crawl, or mutating control tool — even
if a stale config sets the crawler/legacy harvester flag. See [Facts Table](../../architecture/facts.md) for
the full capability/role model and the crawler crawl protocol.

## Client Options

### Web Mode (supported)

Client applications connect to a deployment's [Web API](../../api/reference.md)
(hosted by the portal server) and need no database or storage credentials:

```typescript
new PilotSwarmClient({
    // Required
    apiUrl: "https://portal.example.com",  // portal Web API base URL

    // Optional
    getAccessToken: async () => token,     // bearer-token supplier for authenticated deployments
});
```

`PilotSwarmManagementClient` accepts the same options. Session handles keep the
same programming model (`send` / `wait` / `sendAndWait` / `on` / `getMessages` /
`getInfo` / `destroy`); model-listing methods are async in web mode, so always
`await` them.

### Direct Mode (internal)

Direct `{ store }` construction connects straight to PostgreSQL. It is internal —
for worker/portal-host embedding and internal testing only, not for client apps:

```typescript
new PilotSwarmClient({
    // Required
    store: string,            // PostgreSQL connection string

    // Optional
    blobEnabled: false,       // enable session dehydration across nodes
    waitThreshold: 30,        // seconds — passed to orchestration
    dehydrateThreshold: 10,   // seconds — waits above this trigger dehydration
    dehydrateOnIdle: 120,     // seconds an idle top-level session keeps its worker (default: 1800)
    dehydrateOnInputRequired: 60, // seconds to wait before dehydrating on user input
    ownerRouting: false,      // tag user sessions for their owner's workers (default: PILOTSWARM_OWNER_ROUTING=1)
    workspaceBusyFastRelease: false, // fast busy policy (default: PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE=1)

    // Schema isolation (must match worker)
    duroxideSchema: "ps_duroxide",      // default: "ps_duroxide"
    cmsSchema: "copilot_sessions",       // default: "copilot_sessions"
});
```

The portal and the terminal UI host a direct-mode client. Set
`PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC` in their environment to pass it as that
client's `dehydrateOnIdle`. Default: unset, so the client keeps its own
default of `1800` seconds (30 minutes). Each session keeps the value it
started with, so the setting applies to sessions started after it is set. The
value is a positive whole number of seconds; the portal and the terminal UI
refuse to start with any other value. The orchestration reads `60` as the old
default and holds for 1,800 seconds instead, so use `59` or `61` for about a
minute.

## Azure Blob Storage

Session dehydration stores the full LLM conversation history in blob storage, allowing sessions to move between worker nodes. Without it, sessions are pinned to a single worker.

### Setup

1. Create an Azure Storage Account
2. Create a container (e.g., `copilot-sessions`)
3. Get the connection string from the Azure Portal

```bash
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=mystorageaccount;AccountKey=...;EndpointSuffix=core.windows.net"
AZURE_STORAGE_CONTAINER=copilot-sessions
```

### How It Works

When a session needs to wait (durable timer) or goes idle:

1. **Dehydrate** — serialize the full conversation to a blob
2. **Release** — the worker drops the in-memory session
3. **Timer fires** — any available worker picks up the job
4. **Hydrate** — download the blob, reconstruct the session
5. **Continue** — resume the LLM turn with full context

This enables true multi-node scaling — sessions can migrate between workers transparently.

## LLM Provider Configuration

The model catalog describes provider types, models, and capabilities. Runtime
provider instances hold credentials and are created through management APIs or
**Admin Console → Model Providers**. New configuration should not put runtime
credentials or session defaults in the static catalog; credential-bearing
catalog entries are accepted only as a legacy bootstrap source during the
transition.

For a personal GitHub Copilot credential, open the Admin Console and choose
**Add GitHub Copilot provider**. The provider is private to its
owner. An administrator may separately allow system sessions to use their own
personal provider, but that machinery grant never makes it available to other
users. Administrators can also create shared providers for ordinary cluster
use. A deployment can require fine-grained tokens for it; see
[Fine-Grained GitHub Tokens Only](#fine-grained-github-tokens-only). It can
also keep the key out of the database; see
[Personal Keys in an External Secret Store](#personal-keys-in-an-external-secret-store).

When a personal provider credential expires, use **Update Key** on that
provider instead of deleting or replacing it. The update changes only the
write-only credential; the provider identity, defaults, routing references,
and usage ledger remain unchanged.

The same page owns independent routing settings:

- **My Session Default**: shared providers plus the current user's own.
- **Cluster Session Default**: shared providers only; administrator-managed.
- **System Session Default**: shared providers plus the current administrator's
  system-enabled personal providers.
- **System Agent Overrides**: persistent per-agent choices; changing one uses a
  durable model switch, while restart remains a separate session action.

Changing ordinary defaults affects future sessions only. Changing the system
default can optionally Complete, Terminate, or Hard Delete & Restart existing
inheriting system sessions; per-agent overrides are excluded.

```bash
# Get a GitHub token (easiest path)
gh auth token
```

Credentials are write-only: provider reads, defaults reads, logs, and selector
view models never return them. Browser and terminal password drafts are cleared
on save and cancel; the native UI also removes its draft before awaiting the
provider create or credential-update request.

### Fine-Grained GitHub Tokens Only

`PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT=1`, set on the portal and on every
worker, limits what a GitHub-type provider (catalog `type: "github"`, such as
`github-copilot`) accepts. When one is created or its key updated, through the
Admin Console, the Web API, MCP or an agent's `manage_provider` tool, the key
must:

1. start with `github_pat_`. Classic (`ghp_`), OAuth (`gho_`, which
   `gh auth token` returns) and GitHub App user (`ghu_`) tokens are refused;
2. reach public repositories only: no repository that
   `GET https://api.github.com/user/repos?visibility=all` lists may be private
   or internal. GitHub must also report an expiry
   (`GitHub-Authentication-Token-Expiration`) no more than 30 days away;
3. not hold the account permissions *Git SSH keys*, *GPG keys*, *SSH signing
   keys*, *Email addresses* or *Codespaces user secrets*.

An update is checked by the type of the stored provider. A refusal says which
check failed and never repeats the key; nothing is stored, and an update keeps
the previous key. Each request to GitHub has a 10-second limit, and a check
GitHub does not answer refuses the key. Other provider types are unaffected.
With the setting on, the portal also refuses a key on the legacy
`setCurrentUserGitHubCopilotKey` and `setSystemGitHubCopilotKey` APIs;
clearing one still works.

`1`, `true`, `yes` or `on` turns it on; unset, empty, `0`, `false`, `no` or
`off` leaves it off. Any other value is refused, and the portal and workers do
not start.

The checks apply to keys sent to PilotSwarm. They do not re-check a key that is
already stored, a legacy System key adopted as a provider, or a key the
deployment's own catalog references. GitHub has no API that lists a
fine-grained token's permissions, so its other account permissions are not
checked: grant the token nothing its use does not need.

### Personal Keys in an External Secret Store

By default a personal provider's key is stored, write-only, in its PostgreSQL
row. With `PILOTSWARM_PERSONAL_SECRETS=external`, set on the portal and on
every worker, the key of a personal GitHub-type provider is kept in a secret
store the deployment supplies, and the row keeps only a reference to it:

```json
{ "kind": "externalSecret", "store": "team-secrets", "name": "github-alice", "version": "3", "expiresOn": "2026-12-01T00:00:00.000Z" }
```

A worker asks the deployment for the key on every turn. Unset, empty or
`database` keeps keys in the rows; any other value is refused, and the portal
and workers do not start.

**The portal** writes the store. When a personal GitHub-type provider is
created or its key updated, through the Admin Console, the Web API or MCP, the
key is checked as before, including
[Fine-Grained GitHub Tokens Only](#fine-grained-github-tokens-only) when it is
on, handed to the store, and only the reference is saved. An update writes a
new version of the provider's secret. If saving the row fails, a secret written
for it is deleted again. Deleting the provider deletes its secret in the same
database transaction, so if the store cannot delete it, the provider stays.
In external mode:

- a personal provider of another type is refused: the store holds GitHub
  tokens only. This does not affect shared providers or
  [workload identity](#providers-with-no-key-workload-identity) providers;
- an agent's `manage_provider` tool refuses to add a personal provider or
  update its key, which only the portal does;
- the legacy `setCurrentUserGitHubCopilotKey` API refuses a key; clearing one
  still works;
- when the store fails, the request fails with status `503` and code
  `PROVIDER_SECRET_STORE_UNAVAILABLE`, and nothing is saved.

In either mode a caller cannot send a reference itself: a credential with
`kind: "externalSecret"` is refused.

`PILOTSWARM_PERSONAL_SECRET_STORE_MODULE` (default: unset) names the store
module the portal imports when it starts: a package name, or a path to a file.
The module exports `createPersonalSecretStore`, or a default export: a function
the portal calls with `{ env }` that returns the store or a promise of it, or
the store itself. In external mode the portal refuses to start without it. Set
in `database` mode, it is loaded too, so a provider saved in external mode can
still be deleted with its secret.

The store has three methods. `pilotswarm-sdk` exports these types
(`PersonalSecretStore`, `ExternalSecretRef`):

```ts
interface PersonalSecretStore {
    // Store a token, as a new version of `previous` when it is set, and
    // return what the provider row keeps.
    put(secret: {
        provider: string;                 // the provider's name
        owner: { userId: number; principal: { provider: string; subject: string } | null };
        token: string;
        expiresOn: string | null;         // ISO 8601, when known
        previous: ExternalSecretRef | null;
    }): Promise<{ store: string; name: string; version: string; expiresOn?: string | null }>;
    // Remove the secret. One that is already gone is not an error.
    delete(ref: ExternalSecretRef): Promise<void>;
    // The secret's attributes, or null when it does not exist; never the token.
    describe(ref: ExternalSecretRef): Promise<{ enabled: boolean; expiresOn: string | null } | null>;
}
```

`version` must change whenever the token does: workers cache keys by store,
name and version, so a reused version keeps the old key in use. PilotSwarm
does not call `describe` itself; it is there for tools that check a secret
without reading it. PilotSwarm ships no store and loads no cloud SDK for one;
the module brings the client its secret service needs.

**Workers** get keys from a resolver the deployment registers, usually before
`start()`:

```js
worker.setPersonalCredentialResolver(async ({ sessionId, rootSessionId, provider, secret }) => {
    const answer = await broker.release({ sessionId, rootSessionId, name: secret.name, version: secret.version });
    if (answer.token) return { status: "ok", token: answer.token };
    if (answer.retryLater) return { status: "busy", retryAfterMs: 60_000 };
    return { status: "refused", message: answer.reason };
});
```

Before a turn whose model is on such a provider, before anything else is set
up for it, the worker resolves the key:

| Answer | The turn |
|---|---|
| `{ status: "ok", token }` | Runs with the token. The worker keeps it in memory, keyed by store, name and version, for its later turns in any session. A new name or version is fetched again, and a key the model refuses (`401`) is dropped, so the next turn asks again. |
| `{ status: "refused", message? }` | Fails as an authentication failure and is not retried. The user updates the key and sends the prompt again. |
| `{ status: "busy", message?, retryAfterMs? }` | Waits as it does for a busy workspace (`WORKSPACE_BUSY`): the session keeps the prompt and tries again later, and nothing asks the user to sign in again. A session on an orchestration older than 1.0.80, which has no such wait, gets an ordinary error and is retried. |
| `{ status: "unavailable", message? }`, an error thrown, or no resolver | Fails with an ordinary error and is retried. |

Nothing stands in for such a key: not the legacy per-user or System key, the
worker's `GITHUB_TOKEN`, the first GitHub provider or another provider. The
model's vision lookup uses the same key or none. Replacing the resolver
empties the cache.

**Redaction.** In external mode PilotSwarm redacts GitHub tokens
(`github_pat_`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) from what it persists.
In either mode it also redacts tokens that start with a prefix listed in
`PILOTSWARM_REDACT_SECRET_PREFIXES` (default: unset), comma-separated. Each
prefix is at least three letters, digits, `_` or `-`; the portal and workers
refuse to start with any other entry. A match keeps its prefix: `ghp_abc…` is
stored as `ghp_[REDACTED]`. Redaction covers:

- session events (prompts, assistant messages and tool output among them),
  live updates, the session's title, error and wait text, canvas names, and
  stored turn results;
- what an agent sends through PilotSwarm's tools, before it is queued or
  saved: a sub-agent's task, system message and contract; messages from
  `message_agent`, `message_agent_session`, `send_session_message` and
  `reply_session_message`; `create_agent_session` prompts; the reasons given
  to `cancel_agent`, `delete_agent`, `stop_agent_turn` and
  `manage_agent_session`; the handoff and instructions of
  `regenerate_context` and `regenerate_agent`; and the results passed to
  `complete_agent` and `cancel_agent`;
- the logs of the portal and workers: standard output, standard error and
  orchestration traces.

So a sub-agent or another session gets `[REDACTED]` where its sender quoted a
token: tokens don't travel between agents.

Redaction does not cover:

- what a person sends: a prompt, a steer or an answer is queued and kept as
  typed, and only its copy in the session's events is redacted;
- what an agent stores on purpose and reads back: facts, artifacts, canvas
  pages, and a canvas's live data and key-value entries;
- the Copilot CLI's own session-state files, which dehydration archives to
  blob storage as the CLI recorded them.

A secret split across two log writes is not recognized.

```bash
PILOTSWARM_PERSONAL_SECRETS=external
PILOTSWARM_PERSONAL_SECRET_STORE_MODULE=/opt/pilotswarm/secret-store.mjs   # portal
PILOTSWARM_REDACT_SECRET_PREFIXES=acme_
```

**Fail closed.** In external mode a worker refuses to start unless:

1. `PILOTSWARM_CLI_SECRET_ENV_VARS` names `COPILOT_SDK_AUTH_TOKEN`, so every
   CLI is the Copilot CLI program and keeps the token from agents' shells and
   MCP servers ([Copilot CLI Environment](#copilot-cli-environment));
2. the program, `COPILOT_CLI_PATH` or the platform package of
   `@github/copilot`, exists and is the version `@github/copilot-sdk` pins
   (its `copilotCliVersion`);
3. the CLI does not get `COPILOT_CLI_DIST_DIR`, which makes the program run
   another folder's code. `PILOTSWARM_SCRUB_CLI_ENV=1` drops it;
4. `COPILOT_PKG_CACHE_HOME` is an absolute path that holds the program's
   unpacked copy of that version,
   `<COPILOT_PKG_CACHE_HOME>/pkg/<platform>-<arch>/<version>/`, with its
   `.extraction-complete` marker, `index.js`, `app.js` and
   `prebuilds/<platform>-<arch>/runtime.node`;
5. the worker can neither write nor change the permissions of
   `COPILOT_PKG_CACHE_HOME`, its `pkg` and `pkg/<platform>-<arch>` folders, or
   anything in the copy, and the copy holds no links. The worker finds out by
   trying: it creates and deletes a probe file in each folder, opens each file
   for writing without writing anything, and sets the permissions of each to
   what they already are.

The program unpacks itself once into this cache, by default under
`%LOCALAPPDATA%\copilot` on Windows and `~/.cache/copilot` on Linux, and on
later starts runs whatever it finds there. A copy the worker can write is one
an agent can change. To make a copy, run the program once with the variable
set, as an account other than the worker's, then give the worker's account
read access only:

```bash
COPILOT_PKG_CACHE_HOME=/opt/copilot-pkg node_modules/@github/copilot-linux-x64/copilot --no-auto-update --version
```

The worker image does this when it is built with
`--build-arg COPILOT_PKG_CACHE_HOME=/app/copilot-pkg`: it unpacks the program
there as root and leaves the copy owned by root and read-only, so the `node`
user that runs the worker can only read it. Set
`COPILOT_PKG_CACHE_HOME=/app/copilot-pkg` on the worker too. Built without the
argument, the image holds no unpacked copy.

**Limits.**

- The worker checks the copy once, when it starts.
- A cached key is not checked with the resolver again: the worker uses it
  until its version changes, the model refuses it, or the worker restarts.
- On Windows the check cannot see who owns the copy, and an owner can change
  its permissions back: let another account, such as Administrators, own it.
  The folders above `COPILOT_PKG_CACHE_HOME` are not checked; an account that
  can write one can replace the copy.
- A key stored in a row before the setting was turned on keeps working until
  it is updated, which moves it to the store. The keys of shared providers
  stay in the database.
- After a switch back to `database`, saved references keep resolving through
  the workers' resolver. Updating such a provider's key stores it in the row
  and leaves the old secret in the store.
- A provider removed without being deleted, as when the database removes a
  user's providers with the user, leaves its secret in the store.
- A key in the store is checked only when it is saved, like any other key.

### Request Format (`wireApi`)

`wireApi` picks the request format for an OpenAI-shaped endpoint:
`"completions"` (Chat Completions) or `"responses"` (the Responses API). Set
it on a provider entry, on a model entry, or both. Only `openai`,
`openai-proxy`, `azure`, and `foundry-wif` types accept it.

Which value a model gets:

```
1. The model's own wireApi, if set
2. Else the provider's wireApi, if set
3. Else none is sent, and the Copilot SDK uses Chat Completions
```

Example: Azure GPT-5.6 needs Responses when a turn has tools and reasoning
together. GPT-5.4 models under the same provider stay on Chat Completions:

```json
{
  "id": "azure-openai",
  "type": "azure",
  "baseUrl": "https://my-resource.openai.azure.com/openai",
  "models": [
    { "name": "gpt-5.6", "wireApi": "responses" },
    { "name": "gpt-5.4" }
  ]
}
```

The value follows shared and personal provider instances of the type. The
catalog is checked when it loads. A `wireApi` other than `"completions"` or
`"responses"`, or one on a `github`, `anthropic` or `anthropic-wif` model,
fails the load with an error that names the `provider:model`. A hot reload
that fails this way keeps the previous catalog.

### Request Headers (`headers`)

`headers` adds fixed HTTP headers to every model request a provider sends.
Use it for an endpoint that needs a header besides the credential, such as an
integration id or an API-gateway routing header:

```json
{
  "id": "gateway",
  "type": "openai",
  "baseUrl": "https://gateway.example.com/v1",
  "wireApi": "completions",
  "headers": { "X-Gateway-Route": "inference" },
  "models": [{ "name": "example-model" }]
}
```

Set it on the provider entry only. Every shared and personal instance of the
type sends the same headers, and an instance cannot add or change them.

Header values are sent exactly as written. They are not for secrets:

```
1. A personal instance may set its own baseUrl
2. The type's headers go to that baseUrl with every request
3. So a secret in a header would reach a host the instance owner chose
```

For the same reason the catalog load refuses:

- an `env:` reference as a value
- a credential header: `Authorization`, `Proxy-Authorization`, `api-key`,
  `x-api-key`. The credential comes from `apiKey`, the instance, or workload
  identity.
- a header the HTTP client sets: `Host`, `Content-Length`, `Content-Type`,
  `Transfer-Encoding`, `Connection`
- an invalid header name, the same name twice in a different case, or a value
  that is not a single-line string
- `headers` on a `github` provider. The native Copilot transport takes no
  provider config.

The error names the provider. A hot reload that fails this way keeps the
previous catalog.

`openai`, `openai-proxy`, `azure`, `foundry-wif`, `anthropic` and
`anthropic-wif` providers all accept `headers`.

### Tool Catalog Overflow (`toolCatalog`)

Overflow dispatch is **off by default**. A cluster operator can opt a model
entry into typed dispatch after validating that endpoint's protocol and schema
support. This is independent of model routing and deployment naming:

```json
{
  "name": "gpt-5.4",
  "wireApi": "completions",
  "toolCatalog": {
    "maxDeclarations": 128,
    "overflowStrategy": "typed-dispatch"
  }
}
```

Omit `toolCatalog` to disable dispatch. The checked-in example explicitly opts
one sample model in; it does not change a deployment's private runtime catalog.
This capability belongs on a model in the provider-type catalog, not in an
environment flag, session prompt, or hard-coded model allowlist. Shared and
personal instances inherit the type's model settings. Use separate catalog
types when endpoints need different validated policies.

Only `openai`, `openai-proxy`, `azure`, and `foundry-wif` Chat Completions paths
support this strategy. Native GitHub/Anthropic paths and models resolving to Responses
reject the opt-in at catalog load. `maxDeclarations` must be a positive safe
integer and `overflowStrategy` must be `typed-dispatch`; invalid objects and
unknown keys fail the catalog load. No provider-level default is inferred.

The adapter checks the selected model and endpoint for each session request.
It groups eligible function tools only when the outgoing declarations, including
runtime-added tools, exceed the configured limit. At or below the limit there
is no grouping or response buffering. Canonical tool names, arguments and call
IDs are restored before ordinary permissions, hooks, telemetry and handlers.
Strict or unsupported schemas are retained directly; if the catalog cannot
fit safely, the request fails before transport rather than dropping tools.

Grouping adds no model call or agent hop, but it does not reduce the schema's
token footprint and streamed tool-call fragments wait until complete. Enable
only after provider acceptance/quality validation. Model switches and cold
resume re-resolve the policy; a missing session/model match leaves dispatch off.
Reload/rebuild the registry after changing the catalog, using the deployment's
existing reload or rollout path. No new database migration or runtime provider
row rewrite is required by this field.

### GPT-6 Astra through GitHub Copilot

The shared `github-copilot` type includes `gpt-6-astra`. Existing personal and
shared instances inherit its models without rewriting provider rows, rotating
credentials, or changing session defaults. Each user's Copilot entitlement and
organization model policy still apply; a catalog entry does not grant access.

Capabilities verified against the authenticated Copilot model catalog and CLI
on 2026-09-04:

- Reasoning: `low`, `medium` (default), `high`, `xhigh`, `max`.
- Context tiers: `default` (272,000 prompt tokens) and `long_context` (872,000).
- Maximum total window: 1,000,000 tokens, with up to 128,000 output tokens.

`contextWindowSizes` contains the usable prompt budgets reported by
`session.usage_info.tokenLimit`, not the full input-plus-output window.
Both default/medium and extended/max completed a real inference check.
Copilot's picker-only `supportedReasoningEfforts` field omitted `max`, but its
capability record and an actual inference confirmed support. No additional
Astra variant was advertised. Availability announcement:
[GitHub Copilot changelog](https://github.blog/changelog/2026-09-04-gpt-6-astra-is-generally-available-in-github-copilot/).

### Providers With No Key: Workload Identity

Provider types declared `anthropic-wif` or `foundry-wif` store no credential.
The worker authenticates as itself using workload identity. Nothing is stored
in the database, so there is no key to rotate and none to leak.

For Azure AI Foundry's OpenAI-compatible endpoint, declare `foundry-wif` with
the account's `/openai/v1` data-plane URL:

```json
{
  "id": "azure-foundry-wif",
  "type": "foundry-wif",
  "baseUrl": "https://example-foundry.cognitiveservices.azure.com/openai/v1",
  "models": [
    { "name": "gpt-5.6", "wireApi": "responses" },
    { "name": "gpt-5.4" }
  ]
}
```

The worker obtains an Entra token for
`https://cognitiveservices.azure.com/.default` through
`DefaultAzureCredential`. Grant its managed identity the **Cognitive Services
OpenAI User** role on the Foundry account. In AKS workload-identity
deployments, add the normal Azure workload-identity pod label and service
account annotation, and configure the managed identity's federated credential.

For Anthropic, the worker exchanges an identity token its platform issues for
a short-lived Anthropic access token:

Declare the type in the model catalog with no `apiKey`:

```json
{
  "id": "anthropic-wif",
  "type": "anthropic-wif",
  "baseUrl": "https://api.anthropic.com",
  "models": [{ "name": "claude-opus-5" }]
}
```

In **Admin Console → Model Providers** the type appears in the Add provider
list like any other. It asks for no key: where the API key field would be, it
says *Use the Workload Identity configured in the worker*. **Update Key** is
not offered on such a provider, and the server refuses a key update on one —
there is no stored key to replace, so what changes instead is the worker's own
identity configuration.

Such a provider is always **shared**, and a personal one is refused. A personal
provider exists to run on its owner's own credentials; this type has none and
runs on the worker's, which belongs to the organization. A personal one would
spend the cluster's own account under a name no administrator can cap, hold or
delete, because a personal provider answers only to its owner.

The worker reads that configuration from its environment. These name the
federation rule, the organization, and the service account the minted token
acts as:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | The federation rule to evaluate (`fdrl_…`) |
| `ANTHROPIC_ORGANIZATION_ID` | The Anthropic organization (UUID) |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | The service account the token acts as (`svac_…`) |
| `ANTHROPIC_WORKSPACE_ID` | Required only when the rule spans several workspaces |

The identity token itself comes from whichever of these the platform provides,
in this order:

1. `ANTHROPIC_IDENTITY_TOKEN` — the JWT itself.
2. `ANTHROPIC_IDENTITY_TOKEN_FILE` — a file holding it, re-read on every
   exchange so a token that rotates on disk is always current.
3. `AZURE_FEDERATED_TOKEN_FILE` with `AZURE_TENANT_ID` — a Kubernetes-projected
   token, which Microsoft Entra ID does not accept as an assertion for anyone
   but itself. The worker redeems it at Entra first and presents the result.
   The identity claimed defaults to the injected `AZURE_CLIENT_ID`, and the
   audience to that identity's own id; override either with
   `ANTHROPIC_WIF_AZURE_CLIENT_ID` or `ANTHROPIC_WIF_AZURE_SCOPE` when the rule
   names a different identity or a separate audience registration.

A token is cached until shortly before it expires and minted once per worker
however many sessions are running, because the callback that supplies it is
invoked before every outbound request. No token is trusted for more than an
hour however long it claims to be valid: nothing tells a worker that a
credential was revoked, and the only symptom would be requests failing until
the token aged out on its own. A worker missing any required variable says
which one at session creation, rather than failing the first turn with an
authentication error.

The exchange itself goes to `https://api.anthropic.com` unless
`ANTHROPIC_WIF_TOKEN_URL` (or, failing that, `ANTHROPIC_BASE_URL`) says
otherwise. The assertion posted there is a signed identity token, so a
deployment that repoints `ANTHROPIC_BASE_URL` at a gateway for unrelated
reasons should pin the exchange back with `ANTHROPIC_WIF_TOKEN_URL`.

### Azure Key Vault Store for Personal Keys

On Azure, a deployment can keep personal keys in Key Vault. With
`PILOTSWARM_PERSONAL_SECRETS=external`, set the portal's
`PILOTSWARM_PERSONAL_SECRET_STORE_MODULE` to
`/app/deploy/providers/azure/secret-store/keyvault-personal-secret-store.mjs`,
which every portal image carries. That store reads one more setting on the
portal:

| Variable | Meaning |
|---|---|
| `PILOTSWARM_PERSONAL_SECRET_VAULT_URI` | The `https://` URI of the Key Vault that keeps the keys, such as `https://myvault.vault.azure.net/`. Unset by default; when the store is named and this is unset or not such a URI, the portal does not start. On a deployment with the [Windows worker pool](#windows-worker-pool-azure), the deploy defaults it to the stamp's personal vault, and the disk controller reads the same vault. |

The portal writes the vault with its own identity, through
`DefaultAzureCredential`, and needs only the rights to set and delete secrets
and to read their metadata, never their values. The package's
[README](../../../deploy/providers/azure/secret-store/README.md) covers the
role, the secret names, soft delete and the vault the deployment creates.

### Legacy Per-User GitHub Copilot Key

The profile-key management APIs remain during the migration window for rollback
and adoption tooling. They are not the current Admin Console experience and new
deployments should create personal runtime providers instead. A deployment may
still consume `GITHUB_TOKEN` or legacy key material through its compatibility
bootstrap path, but it should translate that material into provider/default
desired state rather than maintain a second long-lived configuration source.
With [`PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT`](#fine-grained-github-tokens-only)
on, the portal refuses to set a key through them; clearing one still works.
With [`PILOTSWARM_PERSONAL_SECRETS=external`](#personal-keys-in-an-external-secret-store),
it refuses a key on `setCurrentUserGitHubCopilotKey`.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode compilation |
| `npm test` | Run test suite |
| `npm run chat` | Interactive chat (single-process) |
| `npm run tui` | Full TUI with embedded workers |
| `npm run tui:remote` | TUI client-only against a remote deployment (`.env.remote` carries `PILOTSWARM_API_URL`) |
| `npm run worker` | Headless worker process |
| `npm run db:reset` | Reset database schemas |

## Workflow scripts

Workflows are always on, on the portal, every worker and the MCP server; they
need no setting. Script nodes are on by default: a workflow's script states
run as processes on the worker, on its Node with the permission model (file
access limited to the script's own folder, no child processes). See
[Durable workflows](../building/workflow-sessions.md).

| Variable | Default | Effect |
|---|---|---|
| `PILOTSWARM_WORKFLOW_SCRIPTS` | on | An opt-out. Unset or empty: script states run on this worker. `0`, `false`, `no` or `off` turns them off; `1`, `true` or `yes` keeps them on; any other value keeps them on, with one startup warning. The `workflowScripts.enabled` option wins. Off, a definition with a script node is refused at save and Start (`WORKFLOW_SCRIPTS_DISABLED`). Set the same value on the portal and the MCP server, so a person's save or Start is checked there. |
| `PILOTSWARM_WORKFLOW_TEST_MODE` | off | Exactly `on` turns test mode on: the `update_workflow` operations `test`, `test_respond` and `test_advance`, test runs in reads, and test controls in the portal and the terminal UI. Unset, empty or any other value: off. A session's Workflow Definition tests (`workflow_definition` `test`) run on every deployment without it. See [Durable workflows](../building/workflow-sessions.md). |
| `PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS` | `15000` | A worker's shutdown waits for its runtime to drain (`PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS`, 60 s by default), then this long for the release of its sessions and the closes; a step still waiting then is left behind and the process exits. |
| `PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS` | `20000` | The portal's whole shutdown ends within this. Unset with embedded workers: their own budget (`PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS` plus `PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS`) plus 5 s. |
