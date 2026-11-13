# OSS Node deploy orchestrator (`deploy/scripts/`)

A multi-platform Node.js deploy driver for PilotSwarm on AKS that
**coexists with** — and never replaces — the existing paths:

| Path | What it is | When to use |
|---|---|---|
| `scripts/deploy-aks.sh` | Imperative bash script targeting an existing dev cluster (`docs/developer/deploy/aks.md`). | Engineer smoke loop on a one-off cluster. |
| _enterprise deployment orchestrator_ (internal-only) | Enterprise-driven GitOps deploy (Bicep + Kustomize + Flux Storage Bucket). | Production rollouts via the enterprise deployment path. |
| **`deploy/scripts/deploy.mjs`** *(this README)* | OSS-friendly equivalent of the enterprise path, runnable from any contributor's box without the enterprise path. | Reproducing the GitOps deploy locally; future GitHub Actions wrapper. |

The reusable Azure templates live under [`deploy/providers/azure/`](../providers/azure/README.md).
The logic of its optional profiles, `AZURE_POLICY_RESTRICTED` and the Windows
worker pool, lives there too, in `deploy/providers/azure/lib/`,
`deploy-steps/` and `entra/`; the scripts here only call it, behind those
settings.
Each local stamp is scaffolded from that provider's env template and records
`DEPLOY_PROVIDER=azure` in its ignored configuration.
Set `MODEL_PROVIDERS_FILE` to an ignored, per-stamp JSON catalog when the
worker and portal should use a model set different from the shared catalog.
Both workloads receive the same staged file, including the default model.

Same outcome as the enterprise path: Bicep deployed → image pushed to ACR →
Kustomize manifests staged with `.env` substitution → tree uploaded to
the Flux Storage Bucket → rollout verified against the running cluster.

## Prerequisites

- **Node.js ≥ 20** (already a repo dep — `node --version`)
- **Azure CLI** (`az login` against the target subscription)
- **Docker** (for `worker` / `portal` image builds; not required for `baseinfra` / `globalinfra`)
- **`oras`** ([install](https://oras.land/docs/installation)) — used to push the `docker save` tarball into ACR
- **`kubectl`** ([install](https://kubernetes.io/docs/tasks/tools/)) — used by the `rollout` step
- **`flux`** ([install](https://fluxcd.io/flux/installation/#install-the-flux-cli)) — used by the `rollout` step to force-reconcile the Flux Bucket source + Kustomization against the just-uploaded blobs (`kubectl wait kustomization --for=condition=Ready` is unreliable here — see `deploy/scripts/lib/wait-rollout.mjs` for why)

CLI checks are **lazy**: each step only validates the tools it actually
needs, so `--steps bicep` works without `oras` / `docker` installed.

## Quickstart

There are two ways to point this script at a target subscription / cluster:

Every deploy targets a personal local env at
`deploy/envs/local/<name>/.env`, scaffolded by `npm run deploy:new-env`
from `deploy/providers/azure/envs/template.env`. The local file is standalone — no
runtime cascade — so editing the template never retroactively changes
existing envs.

```bash
# 1. Sign in and select the target subscription
az login
az account set --subscription "<subscription-id>"

# 2. Scaffold a personal env. Run interactively (prompts for env name,
#    subscription, location) or pass everything via flags. <name> must
#    use up to 15 lowercase letters, digits, or internal hyphens.
npm run deploy:new-env
#    or non-interactive:
npm run deploy:new-env -- foo --subscription <id> --tenant-id <tenant-id> --location westus3
#    The scaffolder generates RESOURCE_GROUP, GLOBAL_RESOURCE_PREFIX,
#    GLOBAL_RESOURCE_GROUP, PORTAL_RESOURCE_NAME using the same patterns
#    that the enterprise deployment manifests use:
#      RESOURCE_GROUP         = ${RESOURCE_PREFIX}-<regionShort>-rg
#      GLOBAL_RESOURCE_PREFIX = ${RESOURCE_PREFIX}global
#      GLOBAL_RESOURCE_GROUP  = ${GLOBAL_RESOURCE_PREFIX}

# 3. Deploy. Use the same env name passed to new-env.
npm run deploy -- all foo

# 4. Single-service / single-step deploys
npm run deploy -- worker foo
npm run deploy -- worker foo --steps build,push
npm run deploy -- baseinfra foo --steps bicep
```

The reserved labels `dev` and `prod` are NOT valid OSS env names — they
are used by the enterprise path for ServiceGroup naming.

### First-time bring-up (`all`)

For an end-to-end deploy on a fresh subscription / cluster, use the `all`
aggregate. It runs the canonical enterprise-equivalent sequence
(`globalinfra → baseinfra → horizondb, when enabled → worker → portal`) in a single invocation,
sharing the same env map across services so Bicep outputs (ACR login
server, deployment storage account, etc.) cascade forward automatically.
With the Windows worker pool, whose worker runs as the coordination host
(`WIN_WORKER_COORDINATION_HOST=true`), the worker comes just after the portal
instead (see "The coordination host"):

```bash
# Full bring-up (all infra + both services, default pipeline per service)
npm run deploy -- all foo

# Infra-only refresh across all services
npm run deploy -- all foo --steps bicep

# App-only redeploy (skips infra services automatically — their default
# pipeline doesn't include manifests/rollout, so the intersection is empty
# and they're logged as "no applicable steps")
npm run deploy -- all foo --steps manifests,rollout
```

In `all` mode each service's Bicep step deploys **only its own module** —
dependencies (e.g. BaseInfra) were already deployed by an earlier item
in the same invocation, so we don't redundantly re-apply them. Outside
of `all` mode, single-service invocations still redeploy their
dependencies (idempotent, but slower) so a one-off `worker foo` works
even if BaseInfra hasn't been refreshed in this shell.

The mapping `service → module(s)` is in
[`deploy/scripts/lib/service-info.mjs`](lib/service-info.mjs)
(`SERVICE_TO_MODULES` for single-service, `ALL_MODE_MODULES` for `all`).

The `package.json` wrapper exposes the same CLI:

```bash
npm run deploy -- worker foo --steps manifests
```

> **Note**: when invoking via `npm run deploy`, separate npm flags from
> deploy-script flags with `--`. Inside the scripts themselves the entry
> point is `deploy/scripts/deploy.mjs`; you can call `node` directly if
> you prefer (e.g. `node deploy/scripts/deploy.mjs worker foo`).

## CLI reference

```
npm run deploy -- <service> <env> [flags]

Services:  worker | portal | baseinfra | globalinfra | horizondb | all
Envs:      a local env name created with `npm run deploy:new-env`

Flags:
  --steps <list>      build,bicep,push,manifests,rollout (or 'noop')
  --region <name>     Override LOCATION from <env>.env
  --image-tag <tag>   Default: <env>-<short-sha>[-dirty]
  --clean             Wipe deploy/.tmp/<service>-<env>/ before running
  --force             Ignore deploy markers; redeploy every Bicep module even
                      if its template + rendered params are unchanged
  --force-module <m>  Force-redeploy a single named Bicep module (e.g. portal,
                      pls-anchor). Repeatable. Lighter-touch than --force when
                      only one module needs to retry past its deploy marker
                      (e.g. recover from an out-of-band Bicep tweak or RBAC
                      propagation race).
  --help, -h
```

### Step matrix

| Step | What it does | Applies to |
|---|---|---|
| `noop` | Load env, run preflight (Azure login + subscription match), exit. | all |
| `build` | `docker build` the service image and `docker save` to a tarball under `deploy/.tmp/<svc>-<env>/`. | worker, portal |
| `push` | `oras cp` the tarball into the per-region ACR (no Docker daemon push). | worker, portal |
| `bicep` | Render `deploy/providers/azure/services/<Module>/bicep/<Module>.params.template.json` with `${VAR}` substitution from the env map, then `az deployment {sub|group} create`. Captures Bicep outputs back into the env map for downstream steps. | per-service module list |
| `seed-secrets` | Read seedable secrets (`GITHUB_TOKEN` + `ANTHROPIC_API_KEY`) from the loaded env map (set by `new-env` in `deploy/envs/local/<name>/.env`), `az keyvault secret set` each into the env's KV (writing `__PS_UNSET__` for any left blank). SPC mounts them into the worker pod; the runtime strips sentinel values at startup. See [Secrets & identity](#secrets--identity-bicep-deploy-path-only). | baseinfra |
| `manifests` | Substitute the overlay `.env` using the env map, stage the rendered `gitops/<svc>/` tree under `deploy/.tmp/<svc>-<env>/`, then `az storage blob upload-batch` the **unrendered** Kustomize tree to the Flux Storage Bucket. Flux reconciles the cluster from there. Worker / cert-manager / cert-manager-issuers each use a single `overlays/default` overlay (per-env values flow in via the staged `.env`); Portal overlays are keyed by `${EDGE_MODE}-${TLS_SOURCE}` (`overlays/afd-letsencrypt`, `overlays/afd-akv`, `overlays/private-akv`, `overlays/public-letsencrypt` — `akv-selfsigned` shares the `private-akv` overlay). | worker, portal |
| `rollout` | `flux reconcile kustomization <svc>-<svc> -n flux-system --with-source` (forces the Bucket source to re-pull the just-uploaded blobs and the Kustomization to apply that revision), then `kubectl rollout status deployment/<svc>` in `NAMESPACE`, then verifies live `image` ends with the expected tag. | worker, portal |

The default pipeline (no `--steps`) is the full chain. `baseinfra` and
`horizondb` run Bicep followed by secret seeding; `globalinfra` runs Bicep.
These infrastructure services have no app artifacts to roll out.

## Env-file schema

Every deploy targets a personal local env at `deploy/envs/local/<name>/.env`
(the entire `local/` directory is gitignored). Local env files are
**standalone** — `deploy.mjs` reads them directly with no runtime cascade
onto a shared base file.

`deploy/providers/azure/envs/template.env` is a checked-in template consumed only by the
scaffolder (`npm run deploy:new-env`): it copies the template, substitutes
deployment-target keys, prompts for per-stamp secrets, and writes the
complete file under `local/<name>/.env`. Subsequent edits to `template.env`
affect only newly-scaffolded envs — never existing ones.

`dev` and `prod` are reserved labels used by the enterprise path for ServiceGroup
naming; they are NOT valid OSS env names.

Files are flat `KEY=value`, no quoting, no shell expansion.

| Key | Used by | Notes |
|---|---|---|
| `SUBSCRIPTION_ID` | preflight | Must match `az account show --query id`. |
| `LOCATION`, `RESOURCE_GROUP`, `RESOURCE_PREFIX` | bicep, manifests, rollout | Region + RG + Bicep `resourceNamePrefix`. |
| `GLOBAL_RESOURCE_GROUP`, `GLOBAL_RESOURCE_PREFIX` | bicep (globalinfra) | Front Door RG + prefix. |
| `PORTAL_RESOURCE_NAME` | bicep (portal) | Portal logical name. |
| `NPM_REGISTRY` | build | Optional package registry URL forwarded to application image builds. Leave empty to use the Dockerfile default. |
| `NAMESPACE` | manifests, rollout | Target Kubernetes namespace (`pilotswarm` per A-11). |
| `EDGE_MODE` | bicep, manifests, rollout | `afd` (default) or `private`. Controls AFD/AppGw/AGIC vs AKS web-app-routing addon. Drives Portal overlay path. |
| `TLS_SOURCE` | bicep, manifests | `letsencrypt` \| `akv` \| `akv-selfsigned`. Drives Portal overlay path and AKV cert issuer. See [docs/developer/deploy/aks.md](../../docs/developer/deploy/aks.md) for the supported `(EDGE_MODE × TLS_SOURCE)` combos. |
| `AZURE_POLICY_RESTRICTED` | bicep, manifests | `false` (default) or `true`. Deploys a stamp for a subscription whose Azure Policy requires a network security perimeter and denies Storage shared keys and deployment scripts. Requires `EDGE_MODE=afd` and `TLS_SOURCE=letsencrypt`. See [policy-restricted subscriptions](../../docs/developer/deploy/aks.md#optional-policy-restricted-subscriptions). |
| `PERIMETER_OPERATOR_IP_PREFIXES` | bicep (base-infra) | Optional, with `AZURE_POLICY_RESTRICTED=true`: comma-separated public IPv4 addresses or CIDR prefixes that the network security perimeter also admits. |
| `WIN_WORKERS_ENABLED` | bicep, manifests, rollout (portal) | `false` (default) or `true`. Deploys a Windows worker pool beside the cluster and the `disk-controller` service, and runs the database role Job after the portal's rollout. Requires `EDGE_MODE=afd` or `private`, the stamp's own PostgreSQL with `PILOTSWARM_USE_MANAGED_IDENTITY=1`, `PORTAL_AUTH_ENTRA_CLIENT_ID`, `WIN_WORKER_ALERT_EMAILS`, `WIN_WORKER_COORDINATION_HOST=true`, `PILOTSWARM_OWNER_ROUTING=1` and `AUTHZ_ENFORCE_OWNERSHIP=true`. See [Optional: Windows worker pool](#optional-windows-worker-pool). |
| `WIN_WORKER_ALERT_EMAILS` | bicep (base-infra) | Required with `WIN_WORKERS_ENABLED=true`: comma-separated receivers of the pool's alerts. |
| `WIN_WORKER_*`, `WIN_DEV_DRIVE_*` | bicep (base-infra), manifests (disk-controller, worker) | The pool's size, image version, VM size, scaling, extra worker settings, the coordination host and Dev Drives. Each defaults to the value in `template.env`'s Windows worker pool section. |
| `PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT`, `PILOTSWARM_PERSONAL_SECRETS`, `PILOTSWARM_PERSONAL_SECRET_STORE_MODULE`, `PILOTSWARM_PERSONAL_SECRET_VAULT_URI`, `PILOTSWARM_OWNER_ROUTING`, `PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE`, `PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC`, `PILOTSWARM_SESSION_MESSAGE_SCOPE` | manifests (portal) | Optional portal settings. At its default a setting stays out of the staged overlay, so the portal's manifests don't change. `PILOTSWARM_OWNER_ROUTING=1` records the owner's tag on each session the dispatcher creates for a user, and needs `WIN_WORKERS_ENABLED=true`; with the pool, `PILOTSWARM_PERSONAL_SECRET_VAULT_URI` defaults to the stamp's personal vault. |
| `HOST`, `PRIVATE_DNS_ZONE` | bicep (portal), rollout (portal) | Required when `EDGE_MODE=private`. Bicep provisions the Private DNS Zone + VNet link; deploy.mjs writes the A record `${HOST}.${PRIVATE_DNS_ZONE}` → internal LB IP after Portal rollout. |
| `ACME_EMAIL` | bicep (cert-manager-issuers) | Required when `TLS_SOURCE=letsencrypt`. Let's Encrypt registration / renewal-failure notices. |
| `PORTAL_TLS_ISSUER_NAME` | bicep (portal) | Optional override for the AKV cert issuer name. Defaults to `OneCertV2-PublicCA` (afd) / `OneCertV2-PrivateCA` (private), auto-registered by Portal bicep. |
| `AZURE_TENANT_ID` | manifests | Workload identity federation tenant. |
| `PORTAL_HOSTNAME` | manifests (portal) | Public hostname for AFD origin. |
| `SSL_CERT_DOMAIN_SUFFIX`, `WAF_MODE`, `ACR_SKU`, `APP_GATEWAY_PRIVATE_IP` | bicep | Static infra params. |
| `IMAGE` | manifests | Auto-composed from `ACR_LOGIN_SERVER` + service image repo + `--image-tag`; do **not** seed manually. |

**Bicep outputs are never seeded.** `ACR_NAME`, `ACR_LOGIN_SERVER`, `KV_NAME`,
`AKS_CLUSTER_NAME`, `BLOB_CONTAINER_ENDPOINT`, `DEPLOYMENT_STORAGE_ACCOUNT_NAME`,
`DEPLOYMENT_STORAGE_CONTAINER_NAME`, `WORKLOAD_IDENTITY_CLIENT_ID`,
`APPROVAL_MANAGED_IDENTITY_ID`, `FRONT_DOOR_*`, `APPLICATION_GATEWAY_NAME`,
`PRIVATE_LINK_CONFIGURATION_NAME`
all cascade into the env Map at runtime via the FR-022 alias map. A full
`node deploy.mjs all <env>` invocation handles this end-to-end. Standalone
split-step runs (e.g. `worker dev --steps manifests` without first running
`--steps bicep` in the same process) fail fast with a clear "unresolved
placeholder" error directing you to run a prior `--steps bicep`.

### Optional: Windows worker pool

`WIN_WORKERS_ENABLED=true` adds a pool of Windows worker VMs to the stamp.
With the setting off (the default) the rendered Bicep parameters and the
staged manifests are exactly those of a stamp without it, and the
`disk-controller` service is skipped, as `repo-cache` is without
`WORKSPACES_ENABLED=true`.

Before any step, `deploy.mjs` refuses the pool without
`WIN_WORKER_COORDINATION_HOST=true` (see "The coordination host"),
`PILOTSWARM_OWNER_ROUTING=1` and `AUTHZ_ENFORCE_OWNERSHIP=true`, read as the
portal reads it: otherwise the portal only audits who may open a session, and
an owner's session runs on that owner's Windows worker with the owner's
token. It refuses `DISPATCHER_SP_OBJECT_ID` without enforced ownership too,
with the pool or without it. `npm run deploy:new-env` writes all three with
the pool.

Base-infra then deploys, each only with the setting:

- the workers' identity (`<prefix>-win-worker-mid`, the only identity of every
  VM) and the disk controller's (`<prefix>-disk-pool-mid`, federated with its
  service account);
- an Azure Compute Gallery with the image definition `pilotswarm-win-worker`;
- `win-workers-subnet` (`10.20.32.0/24`) with a NAT gateway for outbound
  access, and an NSG that denies all inbound traffic at priority 100 and lets
  the VMs reach only the controller's worker port (`10.20.15.250:3003`) and
  the main storage account's blob private endpoint (`10.20.33.4:443`) inside
  the VNet; with the VPN gateway, also the VNet's DNS resolver on port 53;
- `pe-subnet` with private endpoints for the main storage account's blob
  service, the controller's own state account (`10.20.33.5`) and the personal
  Key Vault (`10.20.33.6`), and their private DNS zones;
- a personal Key Vault for owners' tokens (the portal writes, only the
  controller reads), a deploy-only Key Vault for the controller's CA keys and
  the VMs' administrator password, and the controller's state account;
- container-scoped Blob grants: the portal identity's on `copilot-sessions`
  instead of the whole account, and the workers' on `copilot-sessions` and
  `win-worker-releases` (read);
- an Entra-only PostgreSQL server whose firewall admits only the cluster's
  and the workers' egress addresses. The pool pins the cluster's outbound
  address to the static IP `<prefix>-hdb-egress`, in every edge mode, which
  changes an existing stamp's outbound address;
- the workers' data collection rule, and the pool's security logs, alerts and
  action group;
- once `WIN_WORKER_IMAGE_VERSION` is set, the Flexible scale set and its
  standby pool.

Before the first deploy, the subscription owner creates three custom role
definitions: "PilotSwarm Disk Pool Controller", "PilotSwarm Worker Subnet
Join" and "PilotSwarm Personal Secret Writer". A role that can assign roles
can't create role definitions, so the deploy only assigns them; when one is
missing, it stops and prints the definition to create with
`az role definition create --role-definition @<file>`. Set up the portal's
Entra app with `deploy/scripts/auth/Setup-PortalAuth.ps1 -WorkerRoles`. The
alert rules on the Activity Log need the subscription's Activity Log sent to
the stamp's Log Analytics workspace, which the subscription owner configures.

The pool comes up in two deploys. The first, without
`WIN_WORKER_IMAGE_VERSION`, creates the gallery, vaults, network and
identities, and the `disk-controller` service makes the controller's CA.
Build the Windows image into the gallery, set `WIN_WORKER_IMAGE_VERSION` and
deploy again: base-infra then creates the scale set.

`deploy/providers/azure/deploy-steps/win-workers.mjs` runs with the setting:

- before base-infra's Bicep: it looks up the custom role definitions and,
  with an image version, checks whether the scale set exists, finds the
  standby pool resource provider's principal (or takes
  `WIN_WORKER_STANDBY_POOL_PRINCIPAL_ID`) and reads the controller's trusted
  CAs for the VMs' `userData`, certificates only. When Bicep is to create the
  scale set, it reads the VMs' administrator password from the deploy-only
  vault, or makes it once and keeps it there as `win-worker-admin-password`,
  and passes it as a secure parameter, never in the rendered parameters file;
- after it: Bicep sets the scale set's capacity only when it creates it.
  Later deploys change an existing scale set's size, image and `userData` with
  a PATCH that never names its capacity, which the controller owns. The step
  also deletes a PostgreSQL `AllowAllAzureServices` rule and the portal
  identity's old account-wide Blob grant, which an incremental deployment
  leaves in place;
- before the controller's manifests: it makes or renews the controller's TLS
  certificate; with `afd`, makes sure each trusted CA is on an App Gateway
  trusted root (the root that holds it already, whatever its name, or a new
  one named `<APPGW_TRUSTED_ROOT_CERTS>-<12 hex of the CA's SHA-256>`) and
  lists those roots for the dispatcher Ingress; puts the CAs in the cluster
  for NGINX; and checks the controller's settings with the controller's own
  parser.

The trusted CAs are the controller's current CA and, during a CA rotation,
the next or the previous one. `npm run deploy:rotate-ca -- <env> <operation>`
runs the rotation between deploys ("Rotating the CA" in
[the disk controller's README](../providers/azure/disk-controller/README.md#rotating-the-ca)).
Every trust store gets them as one PEM bundle, the current CA first; a stamp
that never rotates has one CA, as before.

`render-params.mjs` adds the VMs' `userData` to base-infra's parameters, as
`deploy/providers/azure/lib/bicep-parameters.mjs` renders it: the stamp's
database, storage, controller and identity values, the controller's trusted CA
certificates (one, or two during a rotation),
`PILOTSWARM_WORKER_OWNER_ONLY=1` (a pool always has the coordination host)
and the `WIN_WORKER_EXTRA_ENV` pairs. It holds no secret, and the renderer
refuses any value the workers' launcher would refuse, including a reserved
or repeated `WIN_WORKER_EXTRA_ENV` name. `WIN_WORKER_CONFIG_VERSION`, a SHA-256
of those values and of the VM size and image version, reaches the VMs and the
controller, which replaces the VMs that report another version.

Base-infra's outputs for the pool (`PS_DISK_POOL_STATE_URL`,
`WIN_WORKER_SCALE_SET_ID`, `WIN_WORKER_STANDBY_POOL_ID`, `WIN_WORKER_DCR_ID`,
`WIN_WORKER_GALLERY_IMAGE_ID`, `WIN_WORKER_CONFIG_VERSION`, the identities'
IDs, `PERSONAL_KEY_VAULT_URI` and `DEPLOY_KEY_VAULT_NAME`) reach the
controller's overlay and the deploy step through the alias map, like the
outputs above.

#### The database role Job

The Windows workers sign in to PostgreSQL as their own identity
(`<prefix>-win-worker-mid`, `PILOTSWARM_DB_AAD_USER` in their `userData`) and
run with `PILOTSWARM_SKIP_DB_MIGRATIONS=1`: they check that the migrations are
applied but never apply one. The portal's identity (`<prefix>-csi-mid`), the
server's Entra administrator, migrates, and the database role Job
(`deploy/providers/azure/deploy-steps/Setup-WinWorkerDbRole.mjs`) gives the
workers' identity what it needs, and only that.

With `WIN_WORKERS_ENABLED=true`, `stage-manifests.mjs` stages the Job with the
portal's manifests at `deploy/.tmp/portal-<env>/db-role-job.yaml`, outside the
tree it publishes to Flux: a ConfigMap `pilotswarm-db-role` that holds the
script and the portal's staged model catalog, and a Job `pilotswarm-db-role`
that runs the script in the portal's image and namespace, with the portal's
service account (and so its workload identity) and database settings. The
portal's rollout step runs it once the portal has rolled out, before the
`disk-controller` service starts any VM and before `all` deploys the
`worker` service, the coordination host (see "The coordination host"): it
deletes the last run's Job and
ConfigMap, applies the manifest and waits for the Job (30 minutes at most),
then prints its last log lines. The names are fixed and every run deletes
before it applies: a Job can't be changed once created, and the grants want
one run at a time. The Windows image's upgrade script takes the same file as
`-MigrationJobManifest` (see "Upgrading a stamp" in
[the Windows image's README](../providers/azure/windows/README.md)).

Each run does the following, and stops at the first error with a non-zero
exit, which fails the deploy:

1. starts `PilotSwarmClient` and `PilotSwarmManagementClient` as the portal
   does, which applies every pending migration of the orchestration store
   (`ps_duroxide`), the session catalog (`copilot_sessions`) and the facts
   store (`pilotswarm_facts`). The three must be in one database;
2. creates the `NOLOGIN` role `pilotswarm_worker_group` when it is missing
   and grants it its privileges in those three schemas (below), in one
   transaction. The same grants become the migrating role's default
   privileges there, so a later migration's objects get them too;
3. adds the members: `WIN_WORKER_IDENTITY_NAME` with
   `EXPECTED_WIN_WORKER_OID` and `COORDINATION_IDENTITY_NAME` with
   `COORDINATION_IDENTITY_PRINCIPAL_ID` (base-infra's outputs; it refuses to
   run without both). A missing member is created as a Microsoft Entra
   service principal with `pgaadauth_create_principal_with_oid` on the
   server's `postgres` database; an existing role of that name must be the
   Entra principal of that object ID. Members are only added, never removed;
4. reads the group's privileges back through PostgreSQL's privilege
   functions and fails on any difference.

The clients start with the portal's staged model catalog and the portal's
model credentials, as the portal's do: on a new database the first client to
start seeds the catalog's providers and its cluster default model, once. The
Job never sets a default model, so an administrator's choice in the portal
stays.

What the group can do in each of the three schemas:

| Objects | Granted | Never |
|---|---|---|
| The schema | `USAGE` | `CREATE` |
| Tables and views | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `TRUNCATE`, `TRIGGER`, `REFERENCES` |
| `copilot_sessions.authz_audit` | `SELECT`, `INSERT` | `UPDATE`, `DELETE`, `TRUNCATE`, `TRIGGER`, `REFERENCES` |
| Sequences | `USAGE`, `SELECT`, `UPDATE` | |
| The audit table's ID sequence | `USAGE` | `SELECT`, `UPDATE` (so no `setval`) |
| Functions and procedures | `EXECUTE` | |

So a worker reads and writes sessions, orchestrations and facts, and adds
audit rows and reads them. It can't change or remove an audit row, empty a
table, or change any schema: it owns no object, so it can't `ALTER` or `DROP`
one, and it can't create one, a schema included. The group can't log in.
Like every role, its members keep what PostgreSQL gives `PUBLIC`: `CONNECT`
to the database and temporary tables.

The table grants cover the session catalog's authorization records too:
`session_owners`, `session_shares`, `users` (with each user's
`allow_dispatcher_delegation`) and the provider tables. Whoever holds a
member's database token can change who owns or shares a session, or opt a
user into delegation; on a Windows VM an agent can reach that token through
the instance metadata service. Narrower grants are future hardening.

A member starts without any DDL once the migrations are applied: duroxide's
connect then only reads its migration table, and the SDK only checks its own
(`PILOTSWARM_SKIP_DB_MIGRATIONS=1`). A worker of a release whose migrations
the Job hasn't applied yet fails to start, which is why an upgrade runs the
Job before the workers start again.

#### The coordination host

A pool requires `WIN_WORKER_COORDINATION_HOST=true`, which makes the Linux
worker, `copilot-runtime-worker`, the coordination host. The Windows workers
then run only their owner's turns (`PILOTSWARM_WORKER_OWNER_ONLY=1` in their
`userData`), and the coordination host runs the orchestrations, durable
timers, system agents, title generator, every turn's bookkeeping, the
sessions that people start in the portal, with their workspaces, and every
Workflow activity, and sends every capacity request to the disk controller
(`deploy/providers/azure/linux-worker/README.md`). It needs
`WIN_WORKERS_ENABLED=true` and `PILOTSWARM_OWNER_ROUTING=1`.

With the pool, base-infra also deploys the host's own identity,
`<prefix>-linux-worker-mid`:

- federated with the worker's service account, `copilot-runtime-worker`.
  With the pool, `uami-federation.bicep` creates no `worker-fedcred` on the
  portal's identity, `<prefix>-csi-mid`, so no pod of that service account
  can sign in as the database's administrator;
- with Storage Blob Data Contributor on `copilot-sessions` only, and
  Cognitive Services OpenAI User on the stamp's Foundry account;
- reported as `COORDINATION_IDENTITY_CLIENT_ID`,
  `COORDINATION_IDENTITY_PRINCIPAL_ID` and `COORDINATION_IDENTITY_NAME`, from
  which the database role job adds it to the workers' database group.

Base-infra also adds the `capacity-request-unanswered` alert: the controller
has answered none of the host's capacity requests for 5 minutes, so sessions
whose owner has no Windows worker running wait. The controller's coordination
route also needs the portal app's `coordinator` role on the identity, which an
Entra administrator assigns once base-infra has created it:

```powershell
deploy/scripts/auth/Set-PortalAuthAssignments.ps1 -AppId <portal app client ID> `
  -CoordinatorAssignments <COORDINATION_IDENTITY_PRINCIPAL_ID>
```

Before the worker's manifests, on any stamp with the pool, the Windows worker
deploy step deletes the portal identity's federated credential for the
worker's service account, `worker-fedcred`, which an earlier deploy created
and an incremental deployment keeps, and fails the deploy while one remains:
with the pool the worker runs as the host, with its own identity. It then
puts the controller's trusted CAs in the cluster (the ConfigMap
`pilotswarm-disk-controller-ca`), making the controller's TLS certificate
first on a stamp's first deploy, where the worker comes before the
`disk-controller` service. While the controller trusts two CAs (a CA
rotation), it also passes the SHA-256 of their bundle to the worker's
staging, which puts it on the host's pod template as
`pilotswarm.dev/disk-controller-ca-sha256` (the `coordination-host-ca`
component): the host reads `NODE_EXTRA_CA_CERTS` only when it starts, so a
new bundle restarts it. With one CA the component is left out, and the pod
template stays as it was.

With the pool, `all` deploys the `worker` service just after the
`portal`, not before it: the portal's rollout step runs the database role Job
(above), which applies the migrations and makes the host's identity a member
of `pilotswarm_worker_group`, and the host's pods sign in as that identity
with `PILOTSWARM_SKIP_DB_MIGRATIONS=1`. When you deploy the services one at a
time, deploy `portal` before `worker` the first time you deploy the pool:
until the Job has run, the host's pods can't use the database, and the
worker's rollout fails.

`stage-manifests.mjs` (with `deploy/providers/azure/lib/coordination-host.mjs`)
stages the worker with:

- the host's identity as the overlay's `WORKLOAD_IDENTITY_CLIENT_ID` (its
  service account's workload identity) and `PILOTSWARM_DB_AAD_USER`, for that
  staging only: the portal, staged from the same env map, keeps the portal's;
- the `coordination-host` component (`gitops/worker/components/`): no
  `copilot-worker-secrets` SecretProviderClass, CSI volume or `secretRef`,
  because the database URL is passwordless and Blob and Foundry take the
  host's identity; a PodDisruptionBudget (`minAvailable: 1`) and a preference
  for different nodes; the rules of the worker's egress NetworkPolicy
  (`network-policy.yaml` in the base, below), replaced so the pods reach only
  the cluster's DNS pods, the controller's pods on port 3005, the blob private
  endpoint `10.20.33.4:443`, and ports 443 and 5432 outside the stamp VNet
  `10.20.0.0/16` (Entra ID, Foundry, PostgreSQL's public endpoint), never the
  instance metadata endpoint or the Azure host endpoint; the controller's trusted CAs as
  `NODE_EXTRA_CA_CERTS`; a
  4 GiB memory limit; and an init container that leaves the CLI home
  (`COPILOT_HOME`) root's, with the Windows image's read-only placeholders and
  the fixed `settings.json` and `config.json`, and only `session-state` the
  worker's;
- the settings the Windows workers run with: the capacity requester
  (`PILOTSWARM_EXTENSION_MODULES`, `PS_COORDINATION_URL`,
  `PS_COORDINATION_TOKEN_SCOPE`), which registers no admission hook, the title
  and system session tool limits, `PILOTSWARM_SCRUB_CLI_ENV=1`,
  `PILOTSWARM_CLI_DISABLE_HOOKS=1`, `PILOTSWARM_AGENT_PACKAGES=0`,
  `PILOTSWARM_SKIP_DB_MIGRATIONS=1`, `PILOTSWARM_SESSION_MESSAGE_SCOPE=owner`,
  `PILOTSWARM_PERSONAL_SECRETS=external` with
  `PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT=1` and
  `PILOTSWARM_CLI_SECRET_ENV_VARS=COPILOT_SDK_AUTH_TOKEN`,
  `COPILOT_PKG_CACHE_HOME=/app/copilot-pkg`, `COPILOT_HOME`,
  `SESSION_STATE_DIR`, `PILOTSWARM_EVENT_RETENTION_MINUTES=43200`,
  `PILOTSWARM_DISABLE_K8S_SCALING=1`, and a worker and orchestration
  concurrency of 8 and 4. A portal session's sub-agents keep its workspace,
  as on the Linux worker without the pool;
- with `WORKSPACES_ENABLED=true`, the `workspaces` component as without the
  pool, and after the host's own components `coordination-host-workspaces`:
  it loads the workspace provider and clone tools beside the capacity
  requester, names the plugin folders of both components in `PLUGIN_DIRS`
  (the Windows workers' plugin first), passes the repo service's URL and
  Git's author settings to agents' tools through
  `PILOTSWARM_CLI_ENV_ALLOWLIST`, and adds a second egress policy that opens
  only TCP 8080 to the repo pod;
- `WIN_WORKER_COORDINATION_HOST_REPLICAS` replicas;
- the model catalog's Foundry providers on the host's workload identity, in
  either `FOUNDRY_AUTH_MODE`. The host has no GitHub token and no Key Vault
  key, so its models come from Foundry or from shared providers in the
  database.

The `build` step builds the worker image with
`--build-arg COPILOT_PKG_CACHE_HOME=/app/copilot-pkg`, so the image holds the
Copilot CLI program's unpacked copy, owned by root, which external personal
secrets require. A worker image built without it does not start as the
coordination host: rebuild it when you turn the pool on.

| Setting | Default | |
|---|---|---|
| `WIN_WORKER_COORDINATION_HOST_REPLICAS` | `2` | 0 to 20. A Windows release's upgrade freeze publishes 0 (`Bootstrap-WinWorkerStamp.ps1 -CoordinationHostScript`), for example with `WIN_WORKER_COORDINATION_HOST_REPLICAS=0 npm run deploy -- worker <env> --steps manifests`: a shell value wins over the env file. |
| `WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP` | unset | A ConfigMap in the worker's namespace with the definitions of the plugin whose session policy and agents the Windows workers load: `plugin.json`, `session-policy.json`, the agents' `*.agent.md` files, and each skill an agent declares as `<skill>.SKILL.md` (and `<skill>.tools.json`). The host loads a read-only copy of only those (`PLUGIN_DIRS`), no tool module or MCP server. Unset: the image's own plugins. |
| `WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES` | unset | Comma-separated token prefixes the host redacts from what it persists (`PILOTSWARM_REDACT_SECRET_PREFIXES`), as the Windows workers do. |

## How `.env` substitution works (vs. The enterprise path)

| | Enterprise path | OSS path |
|---|---|---|
| Source | `*.Configuration.json` per service | `deploy/envs/local/<name>/.env` (standalone, scaffolded from `deploy/providers/azure/envs/template.env`) |
| Scope binding | the enterprise orchestrator injects subscription / region / IDs into the parameters JSON | `deploy/scripts/lib/common.mjs` resolves env file → JS Map |
| `.env` substitution | the enterprise param-substitution helper rewrites overlay `.env` from JSON params | `deploy/scripts/lib/substitute-env.mjs` rewrites overlay `.env` from the env map |
| Per-service identity | Per-service scope binding | Shared `csiIdentity` UAMI clientId cascades from BaseInfra Bicep output → both worker and portal overlays |

Both paths produce the **same rendered overlay `.env`** before upload.
The Kustomize tree itself is uploaded **unrendered** — Flux runs
`kustomize build` in-cluster against the substituted `.env`.

If a key referenced by the overlay `.env` is not present in the env
map, the substitute step **fails closed** with a sorted list of missing
keys before any file is written.

## Bicep param flow

`deploy/providers/azure/services/<Module>/bicep/<Module>.params.template.json` files use
literal `${VAR}` placeholders. The `bicep` step:

2. Reads the template, substitutes `${VAR}` from the env map (via `render-params.mjs`).
2. Writes the rendered JSON under `deploy/.tmp/<svc>-<env>/params/`.
3. Runs `az deployment {sub|group} create` with `--parameters @<rendered>.json`.
4. Captures named outputs back into the env map (e.g. `acrLoginServer`, `kvName`) so later steps can consume them.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Subscription mismatch` | `az account show` returns a different sub than `<env>.env`. | `az account set --subscription "<id>"`. |
| `Required CLI 'oras' not found` | `oras` not on PATH. | Install per [oras.land](https://oras.land/docs/installation). |
| `Missing keys for overlay .env: …` | `<env>.env` is missing keys that the overlay references. | Run `--steps bicep` first to populate Bicep-output keys in the same process. |
| `Live image tag mismatch` after rollout | `flux reconcile --with-source` returned but the Deployment still shows the prior image. | Re-run `--steps rollout`. If persistent, inspect with `kubectl describe kustomization/<svc>-<svc> -n flux-system` and `flux get sources bucket -n flux-system` to confirm the Bucket artifact revision and the Kustomization's `lastAppliedRevision` agree. |

## Tests

Stdlib-only unit tests cover the orchestrator's trickiest pieces (overlay
substitution rules, FR-022 Bicep-output alias map, deploy-marker hashing,
manifest publish atomicity, private-endpoint approval, and Dockerfile
lockfile enforcement).

```sh
npm run test:deploy-scripts
```

Test files live at `deploy/scripts/test/*.test.mjs`, and a provider package's
own tests at `deploy/providers/<provider>/<package>/test/*.test.mjs`. Both run
with the built-in Node test runner (no new dependencies). The suite is gated
on PRs and pushes to `main` by `.github/workflows/deploy-scripts-tests.yml`
whenever `deploy/scripts/**`, `deploy/providers/azure/services/**/deploy.json`,
`deploy/providers/azure/services/**/bicep/**`, `deploy/providers/azure/deploy-steps/**`,
`deploy/providers/azure/lib/**`, `deploy/providers/azure/entra/**`,
`deploy/providers/azure/secret-store/**`, `deploy/providers/azure/disk-controller/**`,
the worker/portal/disk-controller Dockerfiles, the root package
manifest/lockfile, or that workflow itself changes.

`deploy/scripts/test/db-role-job-postgres.test.mjs` runs the database role Job
against a real PostgreSQL server, then does what a Windows worker does as a
member of the group, with `PILOTSWARM_SKIP_DB_MIGRATIONS=1`. It is skipped
unless `PS_TEST_DB_ROLE_JOB_DATABASE_URL` names a database it may create
schemas and roles in as a superuser. That variable is the test's own:
`scripts/run-tests.sh` sets `PS_TEST_DATABASE_URL` for every full run, to a
server whose user need not be a superuser. It also needs the workspace's
packages and a built SDK. Its schemas and roles have names unique to the run
and are dropped at the end.

```sh
npm ci && npm run build --workspace=packages/sdk
PS_TEST_DB_ROLE_JOB_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/pilotswarm \
  node --test deploy/scripts/test/db-role-job-postgres.test.mjs
```

### Per-module redeploy controls

For one-off operator overrides, `--force-module <name>` on the deploy
orchestrator forces a single named module past its deploy marker for the
current invocation. Repeatable; lighter-touch than `--force` which
bypasses markers for every module.

### Manual verification protocol — private-endpoint approval

After landing the FR-015 hardening of
`deploy/providers/azure/services/common/bicep/approve-private-endpoint.bicep`, two
operator-driven checks should be run against a real AFD-fronted stamp:

1. **Idempotency**: re-run the deploy against an environment whose AFD
   private-endpoint is already Approved. The bicep deployment-script
   should exit 0 quickly via the idempotency pre-check (no polling). The
   portal module's deploy-marker matches on unchanged inputs, so the
   normal deploy is a no-op skip; use `--force-module portal` to actually
   re-run the approval bicep when verifying this.
2. **Minimum-role compatibility**: deploy from an identity holding only
   the documented minimum role assignment on the Application Gateway
   (Network Contributor scoped to the AppGw, no broader Reader). The
   `list_pe_connections` retry helper should not be exercised on the
   happy path; if it is, stderr will surface the underlying `az` error
   instead of being misclassified as "no pending connections".

If either check fails, the regression tests in `approve-pe.test.mjs`
should be extended to cover the new failure mode before re-attempting.

#### Note: AFD post-approval propagation delay

Approving the PE on the AppGw is necessary but **not sufficient** for the
AFD endpoint to start serving traffic. AFD does not continuously poll the
PE connection state — it only re-evaluates Private Link wiring as part
of each origin **deployment cycle**. If the PE is approved after AFD's
most recent cycle completed, AFD will not pick up the approval until its
next organic cycle, which the FAQ documents at
[**"up to 20 minutes" for a single configuration update**][afd-faq]
(back-to-back changes can extend to ~40 min). The Private Link how-to
adds: ["it can take a few minutes for the connection to be
established"][afd-pl-appgw] after approval. In practice we see
**15–30 minutes** end-to-end.

During that window the AFD endpoint returns AFD's default 404 HTML page
(consistent ~260 KB body, identical for `/`, `/api/health`, etc., with
an `x-azure-ref` response header). The AFD origin's
`sharedPrivateLinkResource.deploymentStatus` may also show `NotStarted`:
that field is a [documented read-only AFD edge-propagation state][afd-state-spec]
(values: `NotStarted`, `InProgress`, `Succeeded`, `Failed`), separate
from `provisioningState`, and it can persist as `NotStarted` even after
the endpoint becomes reachable — so it is not a reliable health signal.

Operator guidance:

- Confirm the PE on the AppGw shows `status=Approved,
  provisioningState=Succeeded`. If yes, the deploy did its job — wait.
- Re-test the AFD endpoint with `curl -i https://$AFD_HOSTNAME/api/health`
  after 15–30 minutes. A small-body `200` (no `x-azure-ref` header)
  confirms AFD has propagated.
- If still 404 after ~30 minutes, a no-op
  `az afd origin update … --enable-private-link true …` PUT against the
  origin re-triggers AFD's deployment cycle, which re-evaluates the
  now-Approved PE state. Re-running the bicep with `--force-module portal`
  is roughly equivalent.

[afd-faq]: https://learn.microsoft.com/en-us/azure/frontdoor/front-door-faq
[afd-pl-appgw]: https://learn.microsoft.com/en-us/azure/frontdoor/how-to-enable-private-link-application-gateway
[afd-state-spec]: https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cdn/resource-manager/Microsoft.Cdn/Cdn/stable/2024-09-01/afdx.json

## Secrets &amp; identity (bicep-deploy path only)

This deploy path uses **managed identity for Azure resources** and keeps
operator inputs in a single gitignored env file. Database and Blob
authentication can be selected independently.

> **Legacy `scripts/deploy-aks.sh` is unchanged.** It still builds the
> `copilot-runtime-secrets` K8s secret from local env vars
> (`DATABASE_URL`, `GITHUB_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`,
> etc.) and the runtime falls through to legacy connection-string code
> paths because `PILOTSWARM_USE_MANAGED_IDENTITY` is unset.

### Per-env secrets file

`npm run deploy:new-env` prompts for the two seedable secrets and appends
them to `deploy/envs/local/<name>/.env` (gitignored — the entire
`deploy/envs/local/` directory is excluded by
`deploy/envs/.gitignore`). Seedable keys:

| Key | Why it's a secret | How it's used |
|---|---|---|
| `GITHUB_TOKEN` | Optional. Human-issued PAT, cannot be created at deploy time. When blank, the deploy writes the `__PS_UNSET__` sentinel into KV; users supply their own per-user GitHub Copilot key via the Admin panel instead. | Synced to KV → mounted into worker pod via SPC as `github-token` |
| `ANTHROPIC_API_KEY` | Vendor-issued API key | Synced to KV → mounted as `anthropic-api-key` |
| `DATABASE_URL`, `PILOTSWARM_CMS_FACTS_DATABASE_URL` (BYO only) | External database connection URLs, which can contain passwords | Seeded into the stamp Key Vault and projected through a dedicated CSI Secret, never the BYO ConfigMap |

Everything else that used to live in K8s secrets is now either:
- **Config** (e.g. the legacy provisioned bootstrap `DATABASE_URL`, `AZURE_STORAGE_ACCOUNT_URL`,
  `KV_NAME`, `DEPLOYMENT_STORAGE_ACCOUNT_NAME`) — sourced from Bicep
  outputs, surfaced via the worker `ConfigMap` in the rendered overlay; or
- **Acquired at runtime** via managed identity — Postgres AAD tokens
  for CMS+facts; Blob OAuth tokens for session blobs.

The `seed-secrets` step reads these keys from the loaded env map.
Optional model credentials receive the unset sentinel when blank.
For BYO databases it validates the supplied URLs or explicit secret
references before writing any secrets.
It runs **after** `bicep` (so the KV exists) and **before**
`manifests`/`rollout`.

### Independent database and Blob authentication

The bicep-deploy path enables MI mode by setting these in the overlay
`.env` (substituted into the worker `ConfigMap`):

| Key | Effect |
|---|---|
| `PILOTSWARM_USE_MANAGED_IDENTITY=1` | Database Entra auth. Set `0` for password-authenticated BYO databases. Legacy callers without a Blob-specific override still use this as a shared default. |
| `PILOTSWARM_BLOB_USE_MANAGED_IDENTITY=1` | Independent Blob auth; default on this deploy path, including older env files. Keep enabled when database auth is password-based. The deploy does not seed a Blob connection-string secret. |
| `AZURE_STORAGE_ACCOUNT_URL=https://<acct>.blob.core.windows.net/` | Worker constructs `BlobServiceClient(accountUrl, DefaultAzureCredential)`. SAS generation throws `NotSupportedInManagedIdentityMode` — artifact downloads must proxy through the worker. |
| `PILOTSWARM_CMS_FACTS_DATABASE_URL=postgresql://<aad-user>@<fqdn>:5432/<db>?sslmode=require` | Passwordless URL for CMS + facts pools. The factory installs an AAD token callback (`https://ossrdbms-aad.database.windows.net/.default`). |
| `PILOTSWARM_DB_AAD_USER=<csi-uami-display-name>` | Postgres AAD admin role name = CSI UAMI display name. Used to build `aadUser` in the factory. |
| `DATABASE_URL=postgresql://<bootstrap-pwd-user>:<pwd>@<fqdn>:5432/<db>` | Password URL kept available for the legacy `scripts/deploy-aks.sh` flow and as a fallback when MI is not configured. In MI mode the duroxide store ignores any password in this URL and authenticates via duroxide-node's native Entra path (`PostgresProvider.connectWithSchemaAndEntra`, duroxide-node ≥ 0.1.25). |

`deploy.mjs` composes `AZURE_STORAGE_ACCOUNT_URL` from the
`BLOB_CONTAINER_ENDPOINT` Bicep output, and composes
`PILOTSWARM_CMS_FACTS_DATABASE_URL` + `PILOTSWARM_DB_AAD_USER` from
`POSTGRES_FQDN` + `POSTGRES_AAD_ADMIN_PRINCIPAL_NAME`.

### Use an existing database (including HorizonDB)

Set `DEPLOY_POSTGRES=false` in `deploy/envs/local/<name>/.env`.
The supported `deploy.mjs` path skips the flexible-server module and ignores
stale `POSTGRES_*` cache entries. `true` is the default, including for older
env files with no key. Legacy `1` and `0` are accepted and serialized as
JSON booleans; other values fail. This is an explicit provisioning choice,
not inferred from a URL. Switching to `false` does **not** delete a server
from an earlier incremental deployment.

Shell overrides of the two database URLs apply only when
`DEPLOY_POSTGRES=false`, with a key-only warning. With provisioning enabled,
ambient shell URLs are ignored and warned about, even if the env file has
blank URL keys. Explicit file values and the existing stamp-URL composition
remain unchanged.

For a password-authenticated external database, set:

```dotenv
DEPLOY_POSTGRES=false
PILOTSWARM_USE_MANAGED_IDENTITY=0
PILOTSWARM_BLOB_USE_MANAGED_IDENTITY=1
DATABASE_URL=postgresql://<user>:<percent-encoded-password>@<host>:5432/<environment-db>?sslmode=require
PILOTSWARM_CMS_FACTS_DATABASE_URL=postgresql://<user>:<percent-encoded-password>@<host>:5432/<environment-db>?sslmode=require
```

For Entra auth, use passwordless URLs, set
`PILOTSWARM_USE_MANAGED_IDENTITY=1`, and set `PILOTSWARM_DB_AAD_USER` to
the principal registered on the external database. The deploy does not
create that external principal, configure the external firewall, or
provision the external database. Verify network access and provider/extension
compatibility separately. Use a distinct database and role per test
environment on a shared cluster; sharing a server must not mean sharing
PilotSwarm's tables.

The full `npm run deploy -- all <name>` pipeline seeds the two URLs into
the environment's Key Vault as `database-url` and
`pilotswarm-cms-facts-database-url`. Seeding uses a private temporary file
outside the manifest tree instead of putting credentials in CLI arguments.
The file is removed on success or failure, and CLI diagnostics are withheld
on failures because they may contain credentials. For split bring-up, run:

```sh
npm run deploy -- base-infra <name> --steps bicep,seed-secrets
npm run deploy -- worker <name>
npm run deploy -- portal <name>
```

Alternatively, populate secrets in that same vault beforehand and set
`DATABASE_URL_SECRET_NAME` and
`PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME` instead of raw URLs.
`seed-secrets` leaves reference-only secrets unchanged. Custom names can
also be supplied with raw URLs to choose the seed destination.
When both URLs use one secret name, their supplied values must agree.

For reference-only inputs, the manifests stage queries only secret
identifiers. When a raw URL is supplied, it compares that URL with the
selected Key Vault version in deployer memory and fails on any mismatch.
No returned secret value is logged or persisted. The stage pins the
versions and creates service-specific CSI projections with explicit
`secretKeyRef` entries. URL values never enter the staged BYO `.env`,
ConfigMaps, Bicep outputs cache, or uploaded manifest tree. Password auth
omits the AAD-user key rather than inventing a placeholder. Version changes
produce new Kubernetes Secret references, forcing fresh pods to wait for
the new CSI-synced Secret instead of starting with an old value.
An explicit `<URL_KEY>_SECRET_VERSION` can pin an existing 32-character
Key Vault version; otherwise `--steps manifests` resolves the latest.
Pinned reference-only inputs are checked with an ID-only lookup before
each manifest publication, including versions resolved earlier in the run.
A missing or inaccessible name/version fails before upload. Raw URLs must
match even an explicitly pinned version.

After changing a supplied URL, run `base-infra --steps seed-secrets`, then
publish the worker and portal manifests again. A raw URL in a manifests-only
invocation is **not** written to Key Vault; a changed value fails with an
instruction to run the seeding step first. Unchanged values work across
separate invocations without seeding again.
Infrastructure-only `--steps bicep`, build-only, and unrelated services do
not require database URLs. Only secret seeding and worker/portal manifest
staging require the BYO configuration.

### Bicep-side identity wiring

- **Storage** (`storage.bicep`) grants *Storage Blob Data Contributor*
  on the session blob container scope to the CSI UAMI principal.
- **Postgres** (`postgres.bicep`) enables AAD auth alongside password
  auth and assigns the CSI UAMI as primary AAD admin
  (`flexibleServers/administrators` resource keyed by principal object ID,
  display-name surfaced as the role name).

Both reuse the same CSI UAMI federated to the worker's KSA, so a single
identity covers KV → SPC, blob, and Postgres access.

### Postgres auth rationale

In MI mode all three Postgres consumers — CMS, facts, and the duroxide
orchestration store — authenticate to Azure Database for PostgreSQL
Flexible Server via Microsoft Entra ID:

- **CMS + facts** → AAD via `pg-pool-factory.ts` (`buildPgPoolConfig`),
  using `DefaultAzureCredential` and pg's `password` callback.
- **Duroxide store** → AAD via `duroxide-provider-factory.ts`
  (`createDuroxidePostgresProvider`), which calls duroxide-node's
  `PostgresProvider.connectWithSchemaAndEntra`. Duroxide resolves its
  credential chain in Rust (WorkloadIdentity → ManagedIdentity →
  DeveloperTools).

`DATABASE_URL` (password URL) is kept alongside for the legacy
`scripts/deploy-aks.sh` flow; in MI mode the duroxide store ignores any
embedded password. Fully passwordless deployments may flip
`passwordAuth: 'Disabled'` on the Bicep `postgres.bicep` module and
drop the bootstrap admin password from Key Vault and the
SecretProviderClass once their deploy path is on duroxide-node ≥ 0.1.25
(pilotswarm-sdk ≥ 0.1.30).

## Workflows: always on, with the full engine

Workflows need no setting. Every worker serves session orchestration 1.0.83
(the latest version) and Workflow controller 1.9.0: agent, parallel and request
states, clock waits, revision tests and a person's workflow commands, on every
deployment. Script states run by default; `PILOTSWARM_WORKFLOW_SCRIPTS=0` on
every worker (and the portal and the MCP server) turns them off. Workflow test
mode still needs `PILOTSWARM_WORKFLOW_TEST_MODE=on`.

A script runs on the worker's Node, and Node's permission model does not limit
the network: a script, like an agent shell, reaches what the worker pod
reaches. The worker base therefore ships `network-policy.yaml`
(`copilot-runtime-worker-egress`): worker pods keep all egress (DNS, the
cluster, Postgres, Blob, Key Vault, model endpoints, the internet) except the
instance metadata address `169.254.169.254`, which would hand out the node's
managed identity token, and the Azure host endpoint `168.63.129.16` (DNS on it
stays allowed). The worker does not need it: it authenticates with
workload identity. A deployment that does not use these templates, or whose
cluster has no network policy engine, must block worker pods from
`169.254.169.254` itself (for example, with the AKS IMDS restriction) or set
`PILOTSWARM_WORKFLOW_SCRIPTS=0`.

### Upgrading to this release: stop, deploy, start

Do not roll the workers for this release. Stop every worker, deploy, then
start them. A worker of an earlier release does not have session
orchestration 1.0.83: when it picks up a 1.0.83 session it gives the session back
and tries again, and after 10 tries the session fails. Duroxide does not route
an orchestration by its version, so during a rolling update an old worker can
take a 1.0.83 session.

1. Stop Flux from restarting the old workers, and stop them, with `kubectl`
   and `flux` pointed at the cluster. The Flux Kustomization is
   `worker-worker` in `flux-system`; the Deployment is
   `copilot-runtime-worker` in `NAMESPACE`:

   ```bash
   flux suspend kustomization worker-worker -n flux-system
   kubectl scale deployment/copilot-runtime-worker -n <NAMESPACE> --replicas=0
   kubectl wait pod -n <NAMESPACE> -l app.kubernetes.io/component=worker --for=delete --timeout=10m
   ```

   A worker drains its turns when it stops (up to its termination grace
   period). Run nothing of this release that starts sessions (the portal, the
   MCP server, a terminal UI) before this step ends: it starts new sessions at
   1.0.83.
2. Build and publish the worker without its rollout step, then let Flux apply
   it. Flux applies the manifests with their replica count, so this starts the
   workers on the new image:

   ```bash
   npm run deploy -- worker <env> --steps build,bicep,push,manifests
   flux resume kustomization worker-worker -n flux-system
   npm run deploy -- worker <env> --steps rollout
   ```

   The last command reconciles again and checks that the live image is this
   release's.
3. Deploy the portal: `npm run deploy -- portal <env>`.

Existing sessions keep replaying on the frozen 1.0.82 and move to 1.0.83 at
their next continue-as-new, which carries their queued prompts, pending child
updates, notices and model. As for every release, run one image per database
and leave no old workers in another namespace. For a deployment with plain
manifests (`deploy/k8s`), see "Upgrading to orchestration 1.0.83" in
`docs/developer/deploy/aks.md`.

## Model provider types and runtime instances

The worker reads `model_providers.json` at startup as the provider TYPE/model
catalog. Runtime instances carry credentials and defaults in CMS. In the
bicep-deploy path the
canonical catalog lives at
[`deploy/providers/azure/gitops/worker/base/model_providers.json`](../providers/azure/gitops/worker/base/model_providers.json)
and is mounted into the pod via a kustomize-generated ConfigMap
(`copilot-worker-model-providers`) at `/app/config/model_providers.json`.
`PS_MODEL_PROVIDERS_PATH` is set on the deployment so the runtime picks
it up.

> **Legacy compatibility:** `scripts/deploy-aks.sh` still bakes
> `deploy/config/model_providers.ghcp.json` into the Docker image and
> reads it from `/app/.model_providers.json`. That catalog still carries env
> credential/default references so existing stamps bootstrap once. New stamp
> orchestration should provision provider instances and call
> `setModelDefault` / `setSystemModelDefault` after the management API is ready,
> then move to a type-only catalog.

### Built-in providers

The base catalog supplies three classes of providers:

| Provider | Auth | Source of secret/endpoint |
|---|---|---|
| `ghcp` (GitHub Copilot) | `GITHUB_TOKEN` (KV → SPC, optional, sentinel-tolerant; per-user PAT via Admin overrides) | Static endpoint `https://api.githubcopilot.com` |
| `anthropic` (direct) | `ANTHROPIC_API_KEY` (KV → SPC, optional, sentinel-tolerant) | Static endpoint `https://api.anthropic.com` |
| `azure-foundry`, `azure-foundry-router` | `AZURE_OAI_KEY` by default; workload identity when `FOUNDRY_AUTH_MODE=entra` | `__FOUNDRY_ENDPOINT__` placeholder, substituted at staging from the `FOUNDRY_ENDPOINT` Bicep output |

Foundry is **opt-in per stamp**. When `FOUNDRY_ENABLED=false`:
- `foundry.bicep` is skipped and no Foundry account is created.
- `auto-secrets-sentinel.bicep` writes the `__PS_UNSET__` sentinel into
  the `azure-oai-key` KV secret so the SPC mount still succeeds.
- The placeholder remains unresolved in the staged catalog; the worker's
  catalog loader silently drops the Foundry providers (their `apiKey:
  env:AZURE_OAI_KEY` resolves to the stripped sentinel → undefined).

### Enabling Foundry

1. `npm run deploy:new-env -- <name> --foundry-enabled y` — prompts you
   to populate `deploy/envs/local/<name>/foundry-deployments.json` with
   the deployment list. The scaffolder writes a starter array; the
   stdout banner lists common entries to copy in (gpt-5 family,
   gpt-4o, etc.). The file is parsed by `az` as a `--parameters
   foundryDeployments=@<file>` value, so it must be valid JSON.
2. Run `--steps bicep` for `base-infra`. `foundry.bicep` provisions one
   `Microsoft.CognitiveServices/accounts` (kind=AIServices) per stamp,
   declares each entry as a child `accounts/deployments` resource, and
   defaults to account-key authentication and writes that key to
   `azure-oai-key`. Set `FOUNDRY_AUTH_MODE=entra` to disable local auth,
   grant the worker workload identity the Cognitive Services OpenAI User
   role, and write the standard unset sentinel instead. The endpoint is
   surfaced to the env map as `FOUNDRY_ENDPOINT`. Set `FOUNDRY_LOCATION`
   when model availability requires the Foundry account to use a different
   Azure region from the rest of the stamp.
3. Re-run `--steps manifests`. The placeholder
   `__FOUNDRY_ENDPOINT__/openai/v1` is rewritten to the real Foundry
   endpoint URL (trailing slash collapsed). Flux reconciles; the
   worker's catalog now has live Foundry providers.

### Per-stamp catalog overrides

Set `MODEL_PROVIDERS_FILE=deploy/envs/local/<stamp>/model_providers.json` in
the ignored stamp env. Worker and portal stage the same JSON file. For a
Foundry-only stamp, list only the `azure-foundry` provider, keep
`__FOUNDRY_ENDPOINT__/openai/v1` as its base URL, and set `defaultModel` to a
deployment name in that stamp's `foundry-deployments.json`. The manifests
stage rewrites key-mode Foundry entries to `foundry-wif` and removes
`apiKey` when Entra mode is active. Leave `GITHUB_TOKEN` empty.

> Foundry-hosted Claude remains tracked in
> [`docs/proposals/foundry-hosted-claude.md`](../../docs/proposals/foundry-hosted-claude.md).

## Cross-references

- Enterprise / production path: handled by an internal-only orchestrator (out of scope for this OSS repo)
- Imperative engineer-smoke path: [`docs/developer/deploy/aks.md`](../../docs/developer/deploy/aks.md)
- Spec / plan / as-built record: [`.paw/work/oss-deploy-script/`](../../.paw/work/oss-deploy-script/)
