# Dev Drive workspaces (example)

A workspace provider for Windows workers where each root session's work
lives on its own disk: a Dev Drive (ReFS) that a disk controller attaches to
the worker's VM at LUN 0, and that a local attacher service mounts as the
volume of the workspace roots, `Q:`. A VM holds one drive at a time. When a
session's turn lands on a VM, its drive follows it there; when it lands on a
VM that holds another session's idle drive, that drive is taken back first.

The extension holds no cloud code. It reaches the disk controller over HTTPS
and the attacher over HTTP on the loopback address; the deployment supplies
the controller's token module, the controller's CA, the WIP branch prefix,
and the URL each branch sync fetches from. PilotSwarm core does not depend
on it: it loads only through `PILOTSWARM_EXTENSION_MODULES`.

The hooks it builds on are in
[Writing a workspace provider](../../../../docs/developer/building/workspace-providers.md):
taking a folder back and shutting down, admitting turns, and the owner
routing and personal-credential hooks of the
[configuration reference](../../../../docs/developer/reference/configuration.md).

## Files

| File | What it does |
|---|---|
| `index.mjs` | `register(worker)`: reads the settings, sets the workspace provider, the admission hook, the credential resolver and (without owner-only workers) the capacity requester, takes over the VM's heartbeat, and adds a shutdown hook |
| `provider.mjs` | The `WorkspaceProvider` and its LUN 0 state: the VM's LUN 0 mutex, attach, release, take-backs, orphans, the controller's release and growth requests |
| `disk-pool-client.mjs` | The controller's worker routes over HTTPS, with a token from the deployment's token module and a TLS agent that trusts only the configured CA; `fetchWorkCredential()` for the deployment's tool modules |
| `attacher-client.mjs` | The attacher's routes on the loopback address, with its token file |
| `git-repos.mjs` | Everything the extension does with Git on the drive: the clean-detach record, crash recovery, the WIP push and the branch sync |
| `heartbeat.mjs` | The VM's 15-second heartbeat and its take-over from a launcher |
| `worker-hooks.mjs` | Admission, the credential resolver, the capacity requester and the owner binding |

## Loading it

```text
PILOTSWARM_EXTENSION_MODULES=C:\<release>\packages\sdk\examples\devdrive-workspaces\index.mjs
PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1
PS_DISK_POOL_CONTROLLER_URL=https://<controller>:3003
PS_DISK_CONTROLLER_TOKEN_MODULE=C:\<path>\controller-token.mjs
PS_DISK_CONTROLLER_CA_CERT=C:\<path>\disk-controller-ca.crt
PS_WORKSPACE_ROOTS=repos=Q:\Repos
```

`register()` refuses to load, and so stops the worker, on a platform other
than Windows, without `PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1`
(only a root session may hold a drive: a sub-agent that inherited the
workspace on another VM would wait for its parent's drive), or without the
controller's URL and token module.

## Settings

| Setting | Default | What it is |
|---|---|---|
| `PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE` | — | Must be `1` |
| `PS_DISK_POOL_CONTROLLER_URL` | — (required) | The controller's worker endpoint, `https://` only |
| `PS_DISK_CONTROLLER_TOKEN_MODULE` | — (required) | A module path or package name that exports `getToken()`; called before every controller call. A path is imported by its file URL, so a Windows path such as `C:\...` works |
| `PS_DISK_CONTROLLER_CA_CERT` | unset: Node's default roots | A PEM file of the only CAs the client trusts: one, or two while the controller's CA rotates. Read again for every TLS agent, so the CA can rotate without a worker restart |
| `PS_DISK_ATTACHER_URL` | `http://127.0.0.1:3099` | The attacher; must be `http://` on a loopback address |
| `PS_DISK_ATTACHER_TOKEN_FILE` | `C:\pilotswarm\run\attacher.token` | The attacher's token; read again after a `401` |
| `PS_WORKSPACE_ROOTS` | `repos=Q:\Repos` | The roots, `name=path` comma-separated, all on the drive's volume |
| `PS_WORKSPACE_ADOPT` | `instructions,agents,skills` | What PilotSwarm may adopt from a working folder; `none` adopts nothing |
| `PS_EMPTY_HOOKS_DIR` | unset: the null device | `core.hooksPath` of the extension's own Git calls. Point it at an empty folder the worker cannot write |
| `PS_WIP_BRANCH_PREFIX` | `pilotswarm/wip/` | The WIP branch is `<prefix><rootSessionId>` on each repository's `origin` |
| `PS_LAUNCH_ID` | a new ID | This service start's ID, reported in every heartbeat |
| `WIN_WORKER_CONFIG_VERSION` | unset | The VM's configuration version, reported in every heartbeat |
| `PILOTSWARM_WORKER_OWNER_TAG` | unset | The worker started bound to this owner (`owner.<ownerOid>`): no binding restart |
| `PILOTSWARM_WORKER_OWNER_ONLY` | unset | `1`: no capacity requester, and no binding restart |
| `PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS` | unset: 10 minutes | The attach budget: an attach that waited for LUN 0 past it starts nothing |

The extension's Git calls use the worker's own Git settings for
identity and credentials (for example `GIT_CONFIG_GLOBAL` and a non-interactive
credential helper).

## How a turn gets its drive

`ensureAttached` runs under the VM's LUN 0 mutex. Every attach and every
release on the VM goes through it.

1. **The drive is already here.** When the request's root session holds the
   mounted drive, the answer comes at once, without the controller or the
   attacher (under 50 ms), unless the controller asked for the drive back, a
   branch sync is pending, or a crash check has not passed.
2. **Another session's drive is here.**
   - A check attach (`purpose: "check"`) never takes it: `WORKSPACE_BUSY` with
     a short `retryAfterMs`.
   - A session that this VM did not admit (another owner's) never takes it.
   - The session that was just taken back here gets `WORKSPACE_BUSY`, and the
     controller hears `POST /v1/vms/busy`, so the session moves to another of
     its owner's VMs instead of taking the drive back in turn.
   - Otherwise the extension takes the drive back: it marks the take-back,
     lets go of the mutex, and calls
     `worker.tryReleaseIdleWorkspace(sessionId, { reason: "moved", releaseTimeoutMs: 60_000 })`
     for each session holding a folder of the drive, the root first. The
     release that this triggers takes the mutex, skips the WIP push, and
     takes the drive offline and detaches it. A `busy` answer (a lock, a
     running turn or a task) leaves the drive where it is: `WORKSPACE_BUSY` and
     `/v1/vms/busy`. A drive left over (`notHeld`, a failed release) is freed
     as an orphan. Until the taking session has the drive, every other session
     gets `WORKSPACE_BUSY`.
3. `POST /v1/leases/attach` with `{ rootSessionId, requestId, purpose }`.
   The controller's refusals pass through, for example `WORKSPACE_BUSY` with
   `retryAfterMs: 900000` while the drive is parked or being returned.
4. The attacher's `/online-lun0` brings the drive online as `Q:`.
5. **After a crash** (`takeover` or `needsFsck` in the controller's answer),
   the repositories are checked before anyone uses them (below). **Back from
   local work** (a sync record in the answer), the working folder's
   repository moves to the recorded commit (below).

A turn's notes from step 5 reach the model once, with the turn's working
folder, as the attach's `notice`.

## How a drive is released

The extension keeps the set of folders held on the mounted drive, keyed as
PilotSwarm keys its own held folders: the session, the root and the folder.
`ensureAttached` adds, `release` removes. A release whose root session's
drive is not the mounted one does nothing, so a late release after a
take-back never touches the next session's drive. When the last folder goes:

1. the WIP push (not for a take-back, a release the controller asked for, or a
   `shutdown` release);
2. the clean-detach record;
3. `/offline-lun0`, then `POST /v1/leases/detach`.

A failed offline or detach is retried with backoff (1 s up to every minute,
with the same `requestId`, also across a controller restart) until the
controller confirms it; until then LUN 0 counts as taken. A drive that is
attached to the VM but that no session here holds, an **orphan**, is freed
the same way: a holder PilotSwarm no longer holds, a release request for a
drive no session here holds, or a drive in the controller's attach record
that differs from the mounted one. An orphan decision uses only a heartbeat
answer sent after the last attach or detach began, so an attach still in
flight never makes its own drive look like an orphan. An orphan cleanup writes
no record, and an orphan this worker never mounted is detached with
`crashed: true`, so its next attach checks it.

At start the worker holds no session, so a drive the first heartbeat answer
names is freed this way (`/offline-lun0`, then a detach with `crashed: true`).

## The controller's requests

Each heartbeat answer may ask for something:

- `releaseRequested: { diskName, reason }` (`return`, `park`, `rebind`,
  `drain`, `move`): for the mounted drive, the extension releases its idle
  holders through `tryReleaseIdleWorkspace`, without a WIP push; a busy one
  keeps it until the next heartbeat. Meanwhile a turn of the holder does not
  take the fast path but asks the controller, whose answer is the busy
  refusal for a parked or returning drive, and which cancels a `move` when the
  holder's own turn asks for its drive. A check never cancels a request.
- `extendRequested: { diskName, sizeGb }`: after the controller grew the
  mounted drive, the attacher's `/extend-lun0` extends `Q:`; while Windows
  does not see the new size yet, it answers `retry`, and the extension tries
  again a minute later. A request repeated after success does nothing.
- `ownerOid`: the VM's owner. A worker that started without an owner and
  without owner-only workers exits with code 75 once its VM is bound
  (`worker.requestExit(75, "bind", { drainTimeoutMs: 120_000 })`), so that
  its service manager starts it again with the owner's tag. The drain gets 2
  minutes, and the heartbeat keeps running, with `draining: true`, until the
  worker stops.

## Git on the drive

The extension's Git calls run with `core.hooksPath` at `PS_EMPTY_HOOKS_DIR`,
no fsmonitor, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=false` and no askpass
program, each with a deadline after which its whole process tree is killed
(`taskkill /T /F` on Windows; Node's own kill ends only git itself, not its
remote or credential helpers).

- **Which repositories.** All of this applies to each root that is a Git
  working tree, or else to each folder right under a root that is one, and to
  their checked-out submodules. A repository nested deeper, such as one an
  agent clones inside another repository's working tree or in a plain folder
  under a root, gets no clean-detach record, no stale-lock removal and no WIP
  push, so a crash can leave its `index.lock` behind and its work reaches no
  remote: clone repositories right under a root.
- **The clean-detach record.** Right before the offline of a release by the
  session that holds the drive, the object IDs of `HEAD` and of every ref
  (`git for-each-ref`) of each repository and submodule go to
  `pilotswarm-clean-tips` in its Git directory. A drive image should carry a
  first record.
- **Crash recovery.** Stale `*.lock` files under each `.git` are removed,
  except under `objects`, in a child process with no entry limit. Then, in
  each repository and submodule with a record,
  `git rev-list --objects --indexed-objects --quiet --stdin` walks `HEAD`, every
  ref and the index back to the recorded objects that still exist (`git
  cat-file --batch-check`): Git's own post-fetch connectivity check, limited to
  what was written since the last clean offline. Without a record, `git fsck
  --connectivity-only --no-dangling`. Then `git status`. Only real damage falls
  back to the WIP branch: refs that reach a lost object are listed in
  `pilotswarm-broken-refs` and removed, the WIP branch is fetched, and the
  branch moves to the backup's parent with the backup's changes staged. An
  ownership error (`detected dubious ownership`) fails the attach with
  `WORKSPACE_ATTACH_FAILED` and changes nothing: the drive's work is intact.
- **The WIP push.** Every other release pushes the drive's work, committed or
  not (untracked files too, ignored ones not), as a commit on top of `HEAD`
  made with a copy of the index, so neither the index nor the working tree
  changes, to `<PS_WIP_BRANCH_PREFIX><rootSessionId>` on each repository's
  `origin`, with `--force`, submodules first. It runs with
  `http.lowSpeedLimit=1000` and `http.lowSpeedTime=30` and gets 90 seconds in
  all; past that its processes are killed, the failure is logged, and the
  drive still goes offline and detaches. The drive keeps every edit, and the
  next release pushes again.
- **The branch sync.** When an attach answer carries
  `sync: { syncId, sourceBranch, headSha, url }`, a turn's attach of the working
  folder applies it to the repository that holds the working folder: it
  fetches `sourceBranch` from `url` (which is passed to Git in its
  environment, never on its command line or in a message), pushes anything on
  the drive that `headSha` does not contain to the WIP branch, and only after
  that push succeeded runs `git checkout --force -B <sourceBranch> <headSha>`,
  `git clean -fd` (never `-x`: ignored build output stays) and
  `git submodule update --init --recursive --force`. Then it writes `syncId`
  and `headSha` to `pilotswarm-synced`, and every heartbeat reports them. A
  failed push resets nothing and fails the attach; the drive stays mounted
  with the sync pending, so the next attach asks the controller and tries
  again. A sync the drive already applied is never applied again, also after a
  lost heartbeat report and a detach.

## Admission, credentials and capacity

| Hook | Controller route | What passes on |
|---|---|---|
| `worker.setSessionAdmission` | `POST /v1/vms/admit` `{ sessionId, rootSessionId, isSystem }` | `admit`, `busy` (with `retryAfterMs`), `deny`; a controller that does not answer fails the turn, which is retried. The roots it admits are the VM's owner's, and only they may take a drive back here |
| `worker.setPersonalCredentialResolver` | `POST /v1/credentials/model` `{ sessionId, rootSessionId, provider, secretName, secretVersion }` | `ok` with the token, `refused`, `busy`, `unavailable`. PilotSwarm keeps the token in memory by secret name and version and asks again after a `401` |
| `worker.setOwnerCapacityRequester` (not with owner-only workers) | `POST /v1/vms/demand` `{ ownerOid, rootSessionId }` | `ok`, `deny`, `busy` (with `retryAfterMs`). Retried until the controller answers or PilotSwarm's 15-second signal fires; a refused route (`4xx`) is not retried. An owner whose tag holds no object ID gets `deny` (`OWNER_NOT_SUPPORTED`) without a request: the controller binds VMs to object IDs only |

The deployment's tool modules get a root session's per-work credential
(`POST /v1/credentials/work` `{ rootSessionId }`) with
`fetchWorkCredential(rootSessionId)` from `disk-pool-client.mjs`. The
extension writes no token and no credential to disk or logs.

## The controller API

Every call is `POST` with a JSON body and `Authorization: Bearer <getToken()>`.
A non-`2xx` answer counts as no answer, except where the table says otherwise.

| Route | Body | Answer the extension reads |
|---|---|---|
| `/v1/vms/heartbeat` | `{ vmName, launchId, phase: "running", attachedDisk, attachedDiskSizeBytes, attachedDiskFreeBytes, activeWorkloadCount, draining, configVersion, syncId, syncedHeadSha }` | `{ ownerOid, attached: { diskName, rootSessionId } \| null, releaseRequested: { diskName, reason } \| null, extendRequested: { diskName, sizeGb } \| null }` |
| `/v1/leases/attach` | `{ rootSessionId, requestId, purpose }` | `{ ok: true, diskName, takeover, needsFsck, sync: { syncId, sourceBranch, headSha, url } \| null }` or `{ ok: false, code, message, retryAfterMs?, retryable? }` |
| `/v1/leases/detach` | `{ diskName, rootSessionId?, requestId, crashed }` | any `2xx`; idempotent, retried with the same `requestId` |
| `/v1/vms/busy` | `{ rootSessionId }` | ignored |
| `/v1/vms/admit` | `{ sessionId, rootSessionId, isSystem }` | `{ decision: "admit" \| "busy" \| "deny", message?, retryAfterMs? }` |
| `/v1/vms/demand` | `{ ownerOid, rootSessionId }` | `{ decision: "ok" \| "deny" \| "busy", code?, message?, retryAfterMs? }`; `4xx`: given up |
| `/v1/credentials/model` | `{ sessionId, rootSessionId, provider, secretName, secretVersion }` | `{ status: "ok", token }`, `{ status: "refused" \| "busy" \| "unavailable", message?, retryAfterMs? }` |
| `/v1/credentials/work` | `{ rootSessionId }` | `{ status: "ok", credential }`, or refused, busy or unavailable |

## The attacher API

`POST` with a JSON body and `Authorization: Bearer <attacher.token>`; a `401`
makes the extension read the token file again and retry once. The LUN 0
routes must be idempotent.

| Route | Body | Answer |
|---|---|---|
| `/online-lun0` | `{ diskName }` | `{ ok: true }` once `Q:` is mounted at the disk's full size |
| `/offline-lun0` | `{ diskName, workerPid }` | `{ ok: true }` once LUN 0 is offline (also when it already was); the worker's own process is spared |
| `/extend-lun0` | `{ diskName, sizeGb }` | `{ ok: true }` once the volume fills the disk; `{ ok: false, retry: true }` while Windows does not see the new size |

## The heartbeat hand-over

A launcher that sends the VM's heartbeats before the worker loads can hand
them over: it puts an object with a `stop()` method at
`globalThis[Symbol.for("pilotswarm.devdrive.heartbeat-handover")]`.
`register()` sends the extension's first heartbeat, then calls `stop()`, so
the controller sees no gap. The heartbeat runs until the worker's shutdown
hook has waited (up to 2 minutes) for a release in flight.

## Tests

`packages/sdk/test/unit/devdrive-workspace-provider.test.mjs` runs on any
platform: a fake controller, a fake attacher and a fake volume stand in for
the VM, the worker is a real, never-started `PilotSwarmWorker` (so
take-backs, checks and shutdown releases go through PilotSwarm's own
`SessionManager`), and the Git tests use real repositories with local bare
repositories, or a local server that never answers, as remotes. Nothing in it
mounts a disk; a real Windows VM with a disk controller and an attacher is
not covered.
