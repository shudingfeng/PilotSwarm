# Azure disk controller and credential broker

The disk controller runs PilotSwarm's Windows worker pool on Azure. One
replica in the cluster owns:

- **the drive pool:** Premium SSD v2 data disks (Dev Drives), each copied from
  a golden snapshot, leased to one work (a root session and its owner),
  attached to the VM that runs the work's turn, parked for local work, reset
  on return, kept with spares, grown online, and refreshed from a new golden
  snapshot every week;
- **the VM lifecycle:** a Flexible scale set with a standby pool. The
  controller scales out by raising the scale set's capacity, activates and
  binds each VM to one owner, fences a VM that goes silent before its drive
  moves, drains and deletes idle VMs step by step (down to zero when the
  minimum allows it) and recycles outdated ones;
- **the credential broker:** a worker VM gets a session's credentials (the
  owner's personal GitHub token, the work's per-work credential) only from
  here, and only while the session's root holds a live drive lease of the
  VM's owner.

It is a package of its own, with its own `package.json` and lockfile, so
PilotSwarm's packages never install or import the Azure SDKs it uses. The
deploy tool deploys it as the `disk-controller` service, only with
`WIN_WORKERS_ENABLED=true`: the image (`deploy/Dockerfile.disk-controller`),
the manifests (`deploy/providers/azure/gitops/disk-controller/`) and the Flux
module (`deploy/providers/azure/services/disk-controller/`). Base-infra
creates its identity, its state storage, the scale set and the rest of the
pool, and the Windows worker deploy step
(`deploy/providers/azure/deploy-steps/win-workers.mjs`) runs the TLS step below
before the manifests are published. Stamps without the setting do not change.

## Layout

| File | Purpose |
|---|---|
| `server.mjs` | The process: builds the Azure clients (workload identity), the three HTTPS listeners and the timers; reloads the certificate when it changes |
| `lib/config.mjs` | The settings below, checked at start; a wrong value stops the start |
| `lib/http.mjs`, `lib/auth.mjs` | Route tables, token checks (Entra v2 tokens, app roles, object IDs) and source-IP resolution |
| `lib/state-store.mjs`, `lib/mutex.mjs` | The state in blobs, written with ETag compare-and-swap under per-record locks |
| `lib/model.mjs`, `lib/controller-record.mjs` | Drive states, timings and the pool-wide record |
| `lib/pool.mjs` | Claims, park, sync-branch, rebind, return, attach and detach, admission, spares, resets, growth and lease expiry |
| `lib/fleet.mjs` | Registration, heartbeats, binding, crash detection and fencing, drains, the upgrade freeze and rollouts |
| `lib/scaling.mjs`, `lib/demand.mjs`, `lib/working-hours.mjs` | The scaling target, scale-out and scale-in steps, and capacity requests |
| `lib/broker.mjs` | The credential broker |
| `lib/refresh.mjs` | The weekly golden-snapshot refresh |
| `lib/azure.mjs`, `lib/run-commands.mjs` | The Azure Resource Manager calls and the Managed Run Commands it sends to VMs |
| `lib/serving-tls.mjs`, `lib/log.mjs` | The server certificate and JSON-lines logs (`audit` and `alert` levels included) |
| `tls.mjs` | The deploy step for the controller's private CA and leaf certificate, and the CA's rotation (below); not in the image |
| `test/` | Tests with fakes for every Azure client, the clock and the timers; they need none of this package's dependencies |

## Ports and routes

All three listeners serve HTTPS with the same certificate.

| Port | Reached through | Routes |
|---|---|---|
| `3003` | the internal load balancer `pilotswarm-disk-controller` at `10.20.15.250`, from the worker subnet `10.20.32.0/24` only; `kubectl port-forward` for admin | worker and admin routes |
| `3004` | the ClusterIP Service `pilotswarm-disk-controller-dispatcher`, behind the Ingress of that name on the portal's host | dispatcher routes and the health route |
| `3005` | the ClusterIP Service `pilotswarm-disk-controller-coordination`, from the coordination host's pods | the coordination route |

Every route except the health route needs an Entra **v2** access token for
the controller's app (`PS_DISK_CONTROLLER_TOKEN_SCOPE`), from the tenant in
`AZURE_TENANT_ID`, signed with the tenant's keys. `401` means no or a bad
token, `403` a caller the route does not take.

| Route | Caller and checks | Answer |
|---|---|---|
| `POST /v1/vms/register` | `worker` role, `EXPECTED_WIN_WORKER_OID`, from a VM of the scale set (source IP) | `{ status: "active", ownerOid }` for an activated VM, otherwise `{ status: "inactive", reason }` (`STANDBY`, `FROZEN`, `DRAINING`, `RESERVED`, `UNKNOWN`). Creates the VM's data collection rule association first |
| `POST /v1/vms/heartbeat` | as above | `{ ownerOid, attached, releaseRequested, extendRequested, draining, frozen }` |
| `POST /v1/vms/admit` | as above | `{ decision: "admit" }`, `busy` with `WORKSPACE_BUSY`, or `deny` with `NO_DRIVE_LEASE` |
| `POST /v1/vms/busy` | as above | the capacity answer below, for the VM's own owner |
| `POST /v1/leases/attach` | as above | `{ ok: true, diskName, lun: 0, rootSessionId, ownerOid, takeover, needsFsck, sync }` or `{ ok: false, code, reason, retryAfterMs }` |
| `POST /v1/leases/detach` | as above | `{ ok: true, detached }`; idempotent |
| `POST /v1/credentials/model` | as above | the broker's answer below, with `token` |
| `POST /v1/credentials/work` | as above, and the VM must hold the work's drive | the broker's answer below, with `credential` |
| `POST`, `GET /v1/admin/upgrade-freeze` | `admin` role (a person) or `deployer` role | `{ frozen, frozenAt, allStopped, vms }`; `POST` takes `{ frozen: true \| false }` |
| `GET /v1/admin/status` | `admin` role only (a person), not `deployer` | the pool, the drives and the VMs, without credentials; each VM's image and configuration versions, and `outdated` while a rollout will replace it once it is idle (`null` until the VM's first heartbeat after the controller starts) |
| `POST /disk-pool/v1/disks/claim` | `user` role and `DISPATCHER_SP_OBJECT_ID` only; a person's own token is refused | `{ decision: "ok", repeated, lease }`, `busy` (`NOT_READY`, `HYDRATING`, `POOL_FULL`), `deny` (`OWNER_DRIVE_LIMIT`), `409 WORK_HAS_ANOTHER_ROOT` |
| `POST /disk-pool/v1/disks/park` | as above | `{ decision: "ok", lease }` |
| `POST /disk-pool/v1/disks/sync-branch` | as above | `{ decision: "ok", syncId, lease }`; `busy` with `DRIVE_ATTACHED` while a VM still holds the parked drive; `409 NOT_PARKED` on a drive that isn't parked, unless the call repeats the last hand-back |
| `POST /disk-pool/v1/disks/rebind` | as above | `{ decision: "ok", lease }`, or `busy` with `DRIVE_ATTACHED` while a VM still holds the drive |
| `POST /disk-pool/v1/disks/return` | as above | `{ decision: "ok", changed, lease }`; idempotent |
| `POST /disk-pool/v1/disks/credential` | as above | `{ decision: "ok", lease }`, `409 LEASE_PARKED` |
| `GET /disk-pool/v1/owners/{ownerOid}/model-credential` | as above | `{ present, expiresOn, enabled }`, never the value |
| `GET /disk-pool/v1/healthz` | no token | `200` with no body once the state is loaded, `503` before |
| `POST /v1/coordination/demand` | `coordinator` role | the capacity answer below |

Every dispatcher call, admission decision, credential release, freeze and
refused caller is logged at the `audit` level, without credential values. A
lease's `credential` is never part of an answer except to the VM that holds
the work's drive.

**The per-work credential** is opaque to the controller. It never checks the
credential's expiry; the service that verifies the credential enforces that.
A claim, sync-branch or rebind sets it, a rotation replaces it, and the
controller keeps it until the drive is parked or returned, which wipe it.

**Parking and the release deadlines.** A park makes the lease busy
everywhere, and every heartbeat answer to the VM that holds the drive asks for
it back (`releaseRequested` with reason `park`) until that VM detaches it.
`sync-branch` unparks the drive only once no VM holds it, so the attach that
follows reaches the controller and gets the sync record: a holder would
reattach its mounted drive without asking. While a VM still holds it, the call
answers `busy` with `DRIVE_ATTACHED` and `retryAfterMs: 10000` and changes
nothing: no sync, no credential, no unpark, and the park's release request
stays. The dispatcher retries until it gets `ok`, as for `rebind`.

Only a parked drive takes a branch sync. A caller that lost the answer
retries with the same branch and head: on the unparked drive, a call that
repeats the last hand-back's `sourceBranch` and `headSha`, whatever its URL,
answers `ok` with that hand-back's `syncId` and sets the call's credential,
but records no new sync. So no later attach resets the working copy under the
session's newer work, even after a turn applied the first sync. Any other call
on a drive that isn't parked gets `409 NOT_PARKED`: park it first. A park or a
return ends the hand-back.

A VM that still holds a drive 10 minutes after a return, a refused `rebind` or
`sync-branch`, or a turn attach from another VM (a move) is fenced: deleted
without a drain, like a crashed VM. The 10 minutes count from the first
request, across retries and controller restarts. A park alone sets no
deadline; a repeated park ends a refused `sync-branch`'s, and a return
replaces it with its own.

**Capacity answers** follow PilotSwarm's owner capacity contract:
`{ decision: "ok" }`, `{ decision: "busy", code: "WORKSPACE_BUSY", reason,
retryAfterMs, message }` (a parked, returning or quarantined drive waits 15
minutes), or `{ decision: "deny", code: "NO_DRIVE_LEASE", message }` for a
root without a lease. Only the coordination host asks for capacity, on its
own port: the worker port has no capacity route, because owner-only workers
send no capacity request. A returning lease answers busy on attach,
admission, the coordination route, `/v1/vms/busy` and both credential routes
until the return completes; only then does its root hold no lease. Only a
root with a live lease counts as demand.

**Broker answers** follow PilotSwarm's personal credential resolver
contract: `{ status: "ok", token | credential }`, `{ status: "refused", code,
message }` (the turn fails and is not retried), `{ status: "busy", code:
"WORKSPACE_BUSY", reason, retryAfterMs }`, or `{ status: "unavailable" }`
with `503`. The personal token is released only for a secret named
`ghcp-<ownerOid>-<32 hex>`, tagged with the same owner, enabled and not
expired, to a VM bound to that owner, for a root that holds a live lease.

## Settings

The overlay's `.env` (`deploy/providers/azure/gitops/disk-controller/overlays/*/.env`)
lists every setting. Unset, empty and `__PS_UNSET__` all mean unset.

| Setting | Default | Meaning |
|---|---|---|
| `PS_DISK_POOL_STATE_URL` | required | The blob container that holds the state, such as `https://<account>.blob.core.windows.net/disk-pool-state` |
| `PS_DISK_CONTROLLER_TOKEN_SCOPE` | required | The workers' token scope, `api://<app client ID>/.default`; its app is the audience the controller accepts |
| `AZURE_TENANT_ID` | required | The tenant whose tokens the controller accepts. `AZURE_AUTHORITY_HOST` changes the authority (default `https://login.microsoftonline.com/`) |
| `EXPECTED_WIN_WORKER_OID` | required | The object ID of the workers' shared identity |
| `DISPATCHER_SP_OBJECT_ID` | unset | The dispatcher's object ID; without it, every dispatcher route answers `403` |
| `PILOTSWARM_PERSONAL_SECRET_VAULT_URI` | unset | The personal vault; without it, `/v1/credentials/model` answers `unavailable` |
| `WIN_WORKER_SCALE_SET_ID` | unset | The scale set's resource ID; without it, the worker routes answer `503 NOT_READY` and claims `busy NOT_READY` |
| `WIN_WORKER_DCR_ID` | unset | The workers' data collection rule, associated with each VM before its first `active` |
| `WIN_WORKER_STANDBY_POOL_ID`, `WIN_WORKER_GALLERY_IMAGE_ID` | unset | The standby pool and the gallery image definition, for operators and tools; the controller reads neither (a VM's standby state comes from its instance view, and new VMs take the scale set model's image) |
| `WIN_WORKER_IMAGE_VERSION`, `WIN_WORKER_CONFIG_VERSION` | unset | The current image and configuration; an older VM is drained and replaced (a rollout) |
| `WIN_WORKER_COUNT` | `5` | X, the most VMs |
| `WIN_WORKER_MIN_RUNNING` | `1` | Y, the fewest serving VMs; scale-in stops there, and `0` lets the pool scale to zero |
| `WIN_WORKER_WORKING_HOURS` | unset | Such as `Mon-Fri 08:00-18:00 America/Los_Angeles`: inside these hours at least one VM stays, even with Y of 0 |
| `WIN_WORKER_IDLE_RECYCLE_MINUTES` | `30` | How long a bound VM stays idle before a scale-in step may take it, and how long recent demand keeps one unbound VM ready |
| `WIN_WORKER_SCALE_IN_BATCH`, `WIN_WORKER_SCALE_IN_INTERVAL_MINUTES` | `1`, `5` | The size of a scale-in step and the pause between steps |
| `WIN_WORKER_COORDINATION_HOST` | `false` | `true` when the Windows workers are owner-only and the coordination host runs everything else, as the repository's deployment always sets it with the pool: a system session's admission on a VM answers `busy` (`SYSTEM_SESSION`), and binding a VM opens no restart window. `false` is for workers that aren't owner-only: they run system sessions, and a VM bound after its worker started gets 3 minutes for its restart with the owner's tag |
| `WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID` | unset | The first golden snapshot; the weekly refresh replaces it |
| `WIN_DEV_DRIVE_POOL_COUNT` | `10` | M, the most drives |
| `WIN_DEV_DRIVE_SPARE_COUNT` | `2` | Hydrated spares kept ready |
| `WIN_DEV_DRIVE_MAX_PER_USER` | `3` | N, the most leases per owner, parked ones included |
| `WIN_DEV_DRIVE_LEASE_EXPIRY_DAYS` | `7` | An unused lease is returned after this many days |
| `WIN_DEV_DRIVE_SIZE_GB`, `WIN_DEV_DRIVE_MAX_GB` | `1024`, `2048` | A new drive's size, and the most it grows to |
| `WIN_DEV_DRIVE_GROW_FREE_PERCENT`, `WIN_DEV_DRIVE_GROW_STEP_GB` | `20`, `256` | Grow a drive by a step when less free space than this is left |
| `WIN_DEV_DRIVE_IOPS`, `WIN_DEV_DRIVE_MBPS` | `6000`, `250` | A drive's provisioned performance |
| `PS_DISK_CONTROLLER_TLS_FILE` | `/mnt/disk-controller-tls/disk-controller-tls` | The PEM bundle the listeners serve |
| `PS_DISK_CONTROLLER_STARTUP_GRACE_SECONDS` | `60` | How long a new controller waits for heartbeats before it treats a silent VM as crashed |
| `PS_DISK_CONTROLLER_SNAPSHOT_REFRESH_DAYS` | `7` | The golden-snapshot refresh interval; `0` turns it off |
| `PS_DISK_CONTROLLER_VM_SCRIPTS_DIR` | `C:\pilotswarm\scripts` | Where the Windows image keeps the scripts the Managed Run Commands call |

The Windows image must provide, in `PS_DISK_CONTROLLER_VM_SCRIPTS_DIR`,
`Drain-And-StopWorker.ps1` and `Seed-WorkerReposDisk.ps1` (with `-Refresh`
and with `-Verify`, whose last output line is
`{ "verified": true, "manifestSha256": "<64 hex>", "checks": { ... } }`), and a
service named `PilotSwarmWorker`. The controller runs each script as one line,
`& '<folder>\<script>.ps1'`, of the Run Command's own script, and reads the
Run Command's exit code. So a script must report a failure with a terminating
error (`throw`): a bare `exit 1` inside it ends only that script, and the Run
Command would still succeed.

## State

The container in `PS_DISK_POOL_STATE_URL` holds one blob per record:
`controller.json` (the freeze, the golden snapshot and its refresh, the
drives of finished refresh runs still to delete, pending scale-outs and
unserved demand), `disks/<name>.json` (a drive, its lease and its
attachment) and `vms/<name>.json` (a VM's role, owner and fence). Every
write is a conditional write on the blob's ETag, under a per-record lock;
a conflict reloads the record and retries. Heartbeats live in memory only.

A refresh run's drive (`psrefresh-*`) goes on that list in the same write
that ends the run, and leaves it only once Azure confirms the drive deleted:
every refresh check retries a deletion that failed. Only drives on the list
are deleted, never the live run's, which is never on it.

## Permissions

The controller signs in with `DefaultAzureCredential`, which in the pod is
its own user-assigned identity through workload identity. It needs:

- on the stamp's resource group, a custom role with
  `Microsoft.Compute/virtualMachines/read`, `write`, `delete`,
  `attachDetachDataDisks/action`, `instanceView/read` and
  `runCommands/read`, `write`, `delete` (no `runCommand/action`);
  `virtualMachineScaleSets/read`, `write` and
  `virtualMachineScaleSets/virtualMachines/read`, `write`; `disks/read`,
  `write`, `delete`; `snapshots/read`, `write`, `delete` (no
  `beginGetAccess/action`); `galleries/images/versions/read`;
  `Microsoft.Network/networkInterfaces/read`, `write`, `delete`,
  `join/action`; `Microsoft.Insights/dataCollectionRuleAssociations/read`,
  `write`, `delete` and `dataCollectionRules/read`;
- `Microsoft.Network/virtualNetworks/subnets/join/action` on the worker subnet
  only, and Managed Identity Operator on the workers' identity only;
- Storage Blob Data Contributor on the state container;
- Key Vault Secrets User on the personal vault, and on the secret
  `disk-controller-tls` of the stamp vault (the TLS step grants it).

It associates each VM with the workers' data collection rule before the VM's
first `active`, and removes the association whenever it deletes a VM, drained
or fenced: Azure does not document removing it with the VM. A fence removes it
beside the deletion, so a failed removal never delays the drive's move, and
retries it with every retried deletion.

It needs no `Microsoft.StandbyPool` permission: a VM's standby state comes
from its instance view, so the role carries no standby pool reads.

## Security notes

Base-infra's alert rules
(`deploy/providers/azure/services/base-infra/bicep/win-worker-alerts.bicep`)
read the controller's `alert` records and some of its `audit` records.
`attach-without-turn` matches every `drive.attach` record with a `vm.admit`
record that admitted the same root session on the same VM: in the 30 minutes
before a turn's attach, or from 23 hours before to 15 minutes after the
attach of a workspace check (`purpose: "check"`), which runs no turn. Checks
are watched too: a check attaches the drive in Azure as a turn does, and the
VM that holds a drive gets its work's per-work credential. The rule doesn't
use the broker's `credential.model` records, because a worker asks for the
owner's model token only when it holds no usable copy of that secret version,
and never for a model that needs no personal secret.

What it leaves open:

- **An admission is the worker's own word.** Code that holds the workers'
  token on a VM bound to the owner can ask for an admission of another of the
  owner's roots before it attaches that root's drive, and the rule then sees
  nothing wrong. It catches an attach without one, such as a check attach of
  a root the VM has not admitted for a day.
- **Rare false alarms.** A legitimate check alerts when its VM admitted no
  turn of that root from 23 hours before to 15 minutes after it: a workspace
  set on a session that has not run on that VM for a day, with no prompt within
  15 minutes, or a check in a turn that has run for more than 23 hours.

## The TLS step

`tls.mjs` is a deploy step for the Azure provider; the deploy tool calls
`ensureDiskControllerTls({ namespace, stampVaultName, stampVaultResourceId,
deployVaultName, controllerPrincipalId })` as the deploying principal, with
the Azure CLI signed in and openssl 1.1.1 or later on `PATH`. The Azure CLI
cannot put an IP address in a Key Vault certificate, so the step:

1. makes a private CA once (RSA 4096, 5 years) and keeps its key only in the
   deploy-only vault, as `disk-controller-ca-key`, beside its certificate
   (`disk-controller-ca-cert`). It reads the key only to sign a leaf;
2. issues a leaf (RSA 2048, 1 year, ending at least a day before its CA) when
   none is stored, fewer than 60 days remain, its names changed or another CA
   signed it. The leaf names
   `IP:10.20.15.250` and the dispatcher and coordination Services' DNS names
   in the namespace, with the dispatcher's as its common name, and carries
   its CA's key identifier, so a client that trusts two CAs finds the issuer
   at once. The step checks the names with `openssl x509 -noout -ext
   subjectAltName`, and stores the leaf, the CA and the leaf's key as
   `disk-controller-tls` in the stamp vault;
3. grants the controller's identity Key Vault Secrets User on that one secret.

Keys and secret values never appear on a command line; they pass through a
private temporary folder that the step removes. The step learns which
secrets exist from `az keyvault secret list`, which reads no value, so it
reads a CA key only to sign. It returns the trusted CAs, the current one
first, and their PEM bundle: one CA, or two during a CA rotation (below).
Every trust store must hold them before the controller's manifests are
published:

- the workers, in their `userData`'s `controllerCaCert`;
- App Gateway (`EDGE_MODE=afd`), with a trusted root per CA. App Gateway
  refuses a second root with a certificate that another root holds, so the
  deploy step reads the gateway's roots and compares them by certificate: a
  CA on a root keeps that root, whatever its name, and only a CA on none is
  uploaded, as `<prefix>-<the first 12 hex digits of the SHA-256 of its DER>`.
  The prefix is the env's `APPGW_TRUSTED_ROOT_CERTS`
  (`pilotswarm-disk-controller-ca` unless the deployment changes it): one
  name, not a list. The step uploads a missing root before the manifests reach
  AGIC, since an App Gateway update that names a missing root fails, and lists
  the roots in the overlay's `APPGW_TRUSTED_ROOT_CERTS` for the dispatcher
  Ingress's `appgw-trusted-root-certificate` annotation;
- the Secret and ConfigMap `pilotswarm-disk-controller-ca` (`ca.crt`) for NGINX
  and the coordination host, which `applyCaToCluster` applies with kubectl
  from the deploy step, outside Flux.

A stamp deployed before CA rotations has its CA on the root named after the
prefix itself, and keeps it there: its deploys change nothing on App Gateway,
and the Ingress and the controller's settings render exactly as before. On a
new stamp the first CA, and in each rotation the next CA, get a root named by
content, which they keep through the rotation.

The controller loads a renewed leaf when the mounted file changes, without a
restart. That needs the Secrets Store CSI driver's secret rotation, which
rewrites the file; without it, a renewed certificate takes effect only when
the pod restarts. From 425 days before the CA's end, each deploy warns: the
leaf's next renewal would come too near it. With 60 days or fewer left, the
step signs no leaf, so rotate the CA before then. Only when a rotation has
started and the stored leaf still serves does it keep that leaf, with a
warning, so a deploy can still carry the next CA to the trust stores; once
the leaf no longer serves, the deploy stops and names the way forward,
promote.

## Rotating the CA

The CA lasts 5 years. Start its rotation when the deploys start warning: it
takes as long as the controller needs to replace every worker VM, and two
deploys of the stamp.

```bash
npm run deploy:rotate-ca -- <env> status|start|cleanup
npm run deploy:rotate-ca -- <env> promote|finish [--force]
```

The command (`deploy/scripts/rotate-ca.mjs`, with its checks in
`deploy/providers/azure/deploy-steps/ca-rotation.mjs`) loads the env map as
`npm run deploy` does, from the env file and the Bicep outputs cache, and
checks the Azure CLI's subscription. `status`, `promote` and `finish` also need
kubectl. The deploy-only vault holds the rotation's state:

| Secret | Holds |
|---|---|
| `disk-controller-ca-cert`, `disk-controller-ca-key` | The current CA, which signs the leaf |
| `disk-controller-ca-cert-next`, `disk-controller-ca-key-next` | The next CA: trusted everywhere, signs nothing yet |
| `disk-controller-ca-cert-previous` | The CA the last promote retired, its certificate only: trusted until the rotation finishes |

No more than two CAs are ever trusted. A secret the rotation is done with is
retired by disabling its latest version, never deleted: Key Vault's soft
delete would keep the name from being written again. A disabled secret counts
as absent, and a later write makes a new, enabled version. Each operation can
run again after an interruption at any write, and completes what is left.

1. **`status`** prints each CA's subject, SHA-256 fingerprint and validity,
   the App Gateway root that holds it (found by certificate, whatever its
   name) and, during a rotation, the checks of the next step. It reads
   certificates only, never a key, so it cannot tell a next key that does not
   belong to its certificate; promote checks that.
2. **`start`** makes the next CA (RSA 4096, 5 years), its key and then its
   certificate, with a common name of its own,
   `PilotSwarm disk controller CA <yyyymmdd>`, so that no client has to choose
   between two trusted CAs of one name. With a next CA there already, it
   reports it and changes nothing. It refuses while the last rotation's
   previous CA is still trusted.
3. **Deploy** base-infra, `disk-controller` and the worker, the coordination
   host. Every trust store gets both CAs, the
   current one first:
   - base-infra writes the bundle into the workers' `userData`, which changes
     `WIN_WORKER_CONFIG_VERSION`;
   - `disk-controller` uploads the next CA's App Gateway root, publishes the
     Ingress that names both roots, and puts the bundle in the Secret and the
     ConfigMap. The controller restarts with the new configuration version in
     its settings: it deletes its standby VMs, so the standby pool refills from
     the new model, and replaces each VM that reports the old version once that
     VM is idle, as after an image update;
   - the worker's staging puts the bundle's SHA-256 on the coordination host's
     pod template (`pilotswarm.dev/disk-controller-ca-sha256`), which restarts
     the host: it reads `NODE_EXTRA_CA_CERTS` only when it starts. With one
     trusted CA the annotation is left out, so the pod template is as before.
4. **Watch `status`** until each of promote's checks holds:
   - `vms`: the scale set model and every VM's own `userData` hold the next CA
     (`az vm list --vmss`, then `az vm show --include-user-data` for each VM).
     A changed model leaves an existing VM's `userData` as it was, so this
     waits for the controller's replacements;
   - `appgw` (`EDGE_MODE=afd`): a trusted root holds the next CA, and every
     backend setting for the dispatcher's host names such a root, so AGIC has
     applied the Ingress;
   - `cluster`: the Secret and the ConfigMap hold it;
   - `host` (with the coordination host): its pod template carries the
     bundle's hash, and its rollout has finished.
5. **`promote`** first makes sure the next CA can still sign a leaf and that
   its key is there, enabled, a private key and the next certificate's; if
   not, it refuses with nothing written. It refuses unless every check holds;
   `--force` promotes anyway, with a warning, and any client that lacks the
   next CA then refuses the controller. It writes the previous CA's
   certificate from the current one; then the current key, then the current
   certificate, from the next CA's; disables the next key, then the next
   certificate; and issues a leaf from the new CA at once. A promote that
   stopped part-way is completed by the next run, which never copies the new
   CA into the previous one; until then, deploys refuse to run. Promote reads
   the next CA's key and then the new current key, so the
   `deploy-vault-ca-key-read` alert fires: expect it. When a controller pod
   started before the new leaf was written, it then restarts the controller:
   the Secrets Store CSI driver would rewrite the mounted secret only at its
   next rotation poll, up to 30 minutes later.
6. **`finish`** disables the previous CA's certificate. It refuses until the
   stored leaf is the current CA's and no controller pod started before that
   leaf was written; `--force` finishes anyway. Run it right after promote: a
   deploy in between only puts the new CA first, which recycles the VMs once
   more.
7. **Deploy again**, as in step 3. The trust stores drop the previous CA, the
   host restarts without the annotation, and the controller replaces the VMs
   again.
8. **`cleanup`** (`EDGE_MODE=afd`), once AGIC has applied that deploy, deletes
   App Gateway's trusted roots of the prefix that hold no trusted CA and that
   no backend setting names: the previous CA's root, which on a stamp from
   before CA rotations is the root named after the prefix itself. `status`
   lists them. Skipping it leaves them unused; to delete one by hand, run
   `az network application-gateway root-cert delete`.

During a rotation, give `Bootstrap-WinWorkerStamp.ps1` the ConfigMap's
`ca.crt` as `-ControllerCaFile`: it holds both CAs, and the controller may
serve a leaf from either.

To abandon a rotation before promote, disable the next CA's certificate,
then its key, in the deploy-only vault (`DEPLOY_KEY_VAULT_NAME`):
`az keyvault secret set-attributes --vault-name <vault> --name
disk-controller-ca-cert-next --enabled false`, then the same for
`disk-controller-ca-key-next`. Then deploy as in step 3: the trust stores drop
the next CA, and a later `start` makes a new one. Stopping after either
command is safe. With the certificate disabled, the next CA is gone. With
only the key disabled, deploys still ship the next CA while promote and
`start` refuse, with nothing written, until the certificate is disabled too
or the key's latest version enabled again. After promote, the previous CA
keeps only its certificate and can sign nothing, so the command has no way
back: finish the rotation instead.

If the current CA expires before its rotation is promoted, nothing trusts the
controller any more, and a deploy stops, naming the way forward: run `start`
if no rotation has started, then `promote --force` at once, then deploy and
`finish`. Once expired, the previous CA is left out of every trust store, with
a warning, since it anchors no valid chain; finish still retires it.

## Tests

```bash
node --test deploy/providers/azure/disk-controller/test/*.test.mjs
```

`npm run test:deploy-scripts` runs them too. They use fakes for every Azure
client and need none of this package's dependencies. One TLS test runs the
real openssl when it is on `PATH`, and the manifest tests render the overlays
with `kubectl kustomize` when kubectl is installed.
