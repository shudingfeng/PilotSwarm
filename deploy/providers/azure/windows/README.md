# Windows workers (Azure)

This folder builds and runs PilotSwarm workers on Windows Server 2025 VMs in an
Azure scale set, each with a Dev Drive (`Q:`) that a disk controller attaches at
LUN 0. It holds the worker image's build scripts, the two services that run on
every VM, the token module the Dev Drive extension uses, the golden drive's seed
scripts, the release packer and the upgrade script.

Everything here is opt-in: nothing in it runs unless a deployment builds this
image and points a scale set at it. Existing PilotSwarm deployments do not
change.

The pieces it works with live elsewhere:

- the Dev Drive extension, `packages/sdk/examples/devdrive-workspaces/`
  (its README describes the controller and attacher APIs from the worker's side);
- the disk controller, which runs in the cluster and owns the drives, the VMs and
  the upgrade freeze.

## Files

| File | What it is |
|---|---|
| `launcher.mjs` | The worker service's entry point: settings, identity check, heartbeat, LUN 0 clean-up, release sync, activation, then `worker.js` |
| `disk-attacher.mjs` | The attacher service: LUN 0 online, offline and growth, and the release sync, on `127.0.0.1` |
| `controller-token.mjs` | The Dev Drive extension's controller token module (`PS_DISK_CONTROLLER_TOKEN_MODULE`) |
| `Build-WorkerOsImage.ps1` | Builds the generalized image |
| `Install-WinWorkerService.ps1` | Writes `worker.env` and installs both services (run by the image build) |
| `Initialize-WinWorkerDisk.ps1` | Formats LUN 0 as the ReFS Dev Drive `Q:`, or mounts an existing one |
| `Seed-WorkerReposDisk.ps1` | Seeds the golden drive; `-Refresh` and `-Verify` for the weekly snapshot refresh |
| `Pack-WinWorkerRelease.ps1` | Packs `worker-release-<sha>.zip` and `current-release.json` |
| `Bootstrap-WinWorkerStamp.ps1` | The four-step upgrade, with the controller's pool frozen |
| `Drain-And-StopWorker.ps1` | Drains the worker and stops its service (a controller Run Command) |
| `Clear-StaleWorkspaces.ps1` | Lists, and with `-Apply` empties, the image's scratch folder |
| `PilotSwarm.WinWorker.psm1` | Helpers the scripts share |
| `examples/` | A seed manifest, a toolchain manifest and a worker settings file |
| `test/` | Tests (below) |

The two services and `controller-token.mjs` import only Node.js built-in
`node:*` modules and nothing relative, so the image installs each as one file.
The scripts run in Windows PowerShell 5.1, which Run Commands and image builds
use, and in PowerShell 7.

## On a worker VM

### `C:\pilotswarm`

`NT SERVICE\PilotSwarmWorker` is the worker's virtual account. Its SID derives
from the service name, so it is the same on every machine:
`S-1-5-80-3872531353-3733398320-4078817223-2862367190-1897339925`
(`sc.exe showsid PilotSwarmWorker`). Every grant below uses the SID.

| Path | Holds | The worker's access |
|---|---|---|
| `C:\pilotswarm` | The services, `worker.env`, `seed-manifest.json`, `gitconfig-global`, `image-versions.json` | Read+Execute; inheritance is off: SYSTEM and Administrators Full, the worker Read+Execute |
| `copilot\` | The Copilot CLI's home (`COPILOT_HOME`) | Modify, but its placeholders are Read-Only and Deny-Delete (below) |
| `copilot\session-state\`, `copilot\logs\` | Session state, CLI logs | Modify |
| `logs\` | The worker service's WinSW logs | Modify |
| `temp\` | `TEMP` and `TMP`; cleared at every service start | Modify |
| `azure-cli\` | `AZURE_CONFIG_DIR`; cleared and signed in again at every service start | Modify |
| `work\` | The service's working folder: no `.mcp.json`, `AGENTS.md` or skills can be planted there | Read-Only |
| `az-extensions\` | Empty; `AZURE_EXTENSION_DIR` and `AZURE_EXTENSION_DEV_SOURCES` name it, so `az extension add` fails | Read-Only |
| `run\` | `attacher.token` (only SYSTEM, Administrators and the worker can read it), `disk-ops.ps1`, `release-state.json` | Read-Only |
| `run\ps-temp\` | `TEMP` and `TMP` of the attacher's disk operations; emptied at every attacher start | Read-Only (inherited from `run\`; the attacher checks it) |
| `releases\<commit12>-<zip12>\` | Each release, extracted once and never changed; `<folder>.complete.json` marks a finished one | Read-Only |
| `current` | A junction to the release in use | Read-Only |
| `plugins\<name>\`, `headless-instructions\`, `model_providers.json` | The release's other artifacts | Read-Only |
| `disk-controller-ca.crt` | The controller's trusted CAs, from userData | Read-Only |
| `mcp\<name>\` | MCP servers installed by the image build | Read-Only |
| `scripts\` | The scripts the disk controller runs as Run Commands, and their helper module | Read-Only |
| `services\`, `attacher-logs\`, `empty-hooks\`, `toolchain\` | WinSW and its definitions, the attacher's logs, the extension's empty Git hooks folder, the image build's downloads | Read-Only |

In `copilot\`, the image creates Read-Only, Deny-Delete placeholders for what
the Copilot CLI reads from its home: the files `copilot-instructions.md`,
`mcp-config.json`, `lsp-config.json`, `permissions-config.json`,
`mcp-oauth-config.json` and `providers.json`, and the folders `instructions`,
`skills`, `agents`, `extensions`, `pkg`, `hooks`, `installed-plugins`,
`mcp-oauth-config` and `mcp-secrets` (`-CopilotHomeFiles` and
`-CopilotHomeFolders` change the list). Each file holds what the CLI reads as no
configuration at all: `mcp-config.json` `{"mcpServers":{}}`, `lsp-config.json`
`{"lspServers":{}}`, `providers.json` nothing, any other JSON file `{}` and any
other file nothing. The worker can read each one: the CLI takes a
`providers.json` it cannot read for a broken file, not a missing one. `settings.json`
(`{"disableAllHooks": true}`) and `config.json` (its two comment lines and
`firstLaunchAt`) are written in the exact form the worker checks with
`PILOTSWARM_CLI_DISABLE_HOOKS=1`, Read-Only and Deny-Delete too. No session can
then plant instructions, MCP servers, language servers, tool approvals, model
providers, MCP credentials, skills, agents, extensions, plugins, hook files or
settings for later sessions on the VM.

#### Why these names

What the pinned Copilot CLI, 1.0.83, does with each name it reads from its home
(`COPILOT_HOME`), from its JavaScript and from its native module's own
functions, called with a temporary home. The native module builds the file
names at run time, so they do not appear as text in it.

| Name | What the CLI does with it |
|---|---|
| `providers.json` | Read at every start, in every mode, unless `COPILOT_PROVIDERS_CONFIG` names another file (the worker passes that variable to a CLI only when the deployment's `PILOTSWARM_CLI_ENV_ALLOWLIST` names it). Its `providers` and `models` replace the CLI's model providers. An empty file reads exactly like a missing one, before any JSON parsing, so the CLI keeps its normal providers |
| `mcp-config.json` | The account's own MCP servers. `{}` fails the CLI's check (`mcpServers: Required`), and the load of the merged MCP configuration fails with it |
| `lsp-config.json` | The account's own language servers, loaded whenever the CLI starts its language services: a server named there becomes one of the session's language servers for its file types. `{}` makes it log `lspServers must be an object` |
| `permissions-config.json` | Tool approvals saved per folder (`{"locations": {...}}`), applied to later sessions in that folder |
| `mcp-oauth-config\`, `mcp-secrets\` | The file stores of MCP OAuth tokens, client registrations and code verifiers, and of MCP server secrets, in files named after the server they belong to; without a system keychain, the CLI keeps them there. A session cannot add an MCP server, but a planted token would reach a later session's server of the same name and URL, the deployment's own included. A headless worker has no browser to sign an MCP server in, so it has nothing to keep there |
| `mcp-oauth-config.json` | Nothing in 1.0.83, whose OAuth store is the folder `mcp-oauth-config`; an extra read-only name costs nothing |

The CLI still reads the older names `mcp-config`, `lsp-config`,
`permissions-config` and `config`, but only when the `.json` file of the same
name is missing, so the placeholders and the settings files cover them too.
Session state, the CLI's session store and its logs are the program's own
state, which it writes itself. A file trace on a real VM confirms the final
list ("What only a real VM can verify").

Outside `C:\pilotswarm`, the image build also:

- removes the create, append and write grants of `BUILTIN\Users`,
  `Authenticated Users` and `CREATOR OWNER` on `C:\` and grants them Read+Execute
  only, then audits every top-level folder on `C:\` and fails if one lets those
  accounts or the worker write (except `$Recycle.Bin` and `ProgramData`);
- creates an administrator-owned, Read-Only `C:\node_modules`;
- fails if `C:\ProgramData\GitHub` exists, otherwise creates
  `C:\ProgramData\GitHub\Copilot\policy.d` and locks the tree (SYSTEM and
  Administrators Full, Users Read+Execute), so no session can add a machine-wide
  Copilot policy hook; it locks `C:\ProgramData\Git` the same way, where Git for
  Windows reads machine-wide configuration;
- sets `Disabled=1` under `HKLM\Software\Microsoft\Windows\Windows Error
  Reporting` and removes every `LocalDumps` key, so a crash leaves no dump;
- turns on long paths, and turns off the Remote Desktop, Windows Remote
  Management and File and Printer Sharing firewall rule groups.

`Initialize-WinWorkerDisk.ps1` gives `Q:\` and `Q:\Repos` the same root
treatment as `C:\`; the seed grants Modify only on its manifest's folders.

### The two services

Both run `"C:\Program Files\nodejs\node.exe"` by its full path under WinSW
2.12.0 (pinned and hash-checked by the image build), so a toolchain that puts
another `node.exe` on `PATH` never changes their runtime. Both set
`NODE_EXTRA_CA_CERTS=C:\pilotswarm\disk-controller-ca.crt`, stop their parent
process first, and restart 10 seconds after a non-zero exit (WinSW's
`onfailure` applies only then: a crash and a binding exit, code 75, restart; a
clean stop does not).

| Service | Runs | As | Options |
|---|---|---|---|
| `PilotSwarmDiskAttacher` | `disk-attacher.mjs` | LocalSystem | working folder `run\`, logs in `attacher-logs\`, 2-minute stop timeout |
| `PilotSwarmWorker` | `launcher.mjs` | `NT SERVICE\PilotSwarmWorker` | working folder `work\`, logs in `logs\`, `<depend>PilotSwarmDiskAttacher</depend>`, 105-minute stop timeout (the worker's 100-minute drain and the extension's wait for a release in flight) |

### `worker.env`

`Install-WinWorkerService.ps1` writes `C:\pilotswarm\worker.env` when the image
is built, as `NAME=VALUE` lines, values taken literally:

1. **The image's own values**, which a settings file may not change: the
   attacher's URL and token file, the controller token module, the CA path, the
   model catalog path, `PS_EMPTY_HOOKS_DIR`, `COPILOT_HOME`, `SESSION_STATE_DIR`,
   `COPILOT_PKG_CACHE_HOME`, `TEMP`, `TMP`, `GIT_CONFIG_GLOBAL`,
   `AZURE_CONFIG_DIR`, the four `AZURE_EXTENSION_*` settings,
   `PILOTSWARM_DISABLE_CHILD_WORKSPACE_INHERITANCE=1`,
   `PILOTSWARM_AGENT_PACKAGES=0`, `PILOTSWARM_CLI_DISABLE_HOOKS=1` and
   `PILOTSWARM_SCRUB_CLI_ENV=1`.
2. **Defaults** the settings file may change: `PILOTSWARM_EXTENSION_MODULES` (it
   must keep loading the Dev Drive extension), `PS_WORKSPACE_ROOTS`,
   `PS_WORKSPACE_ADOPT`, `PILOTSWARM_WORKSPACE_ATTACH_TIMEOUT_MS=600000`,
   `PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS=6000000` (at most that, so the drain
   ends before the stop timeout), managed identity for the database and Blob,
   `AZURE_STORAGE_CONTAINER`, `PILOTSWARM_SKIP_DB_MIGRATIONS=1`,
   `PILOTSWARM_ARTIFACT_FILE_ROOTS`, the title and system session tool limits,
   `PILOTSWARM_DISABLE_K8S_SCALING=1` and `MSBUILDDISABLENODEREUSE=1`.
3. **The deployment's worker settings file** (below).

`PILOTSWARM_CLI_ENV_ALLOWLIST` always passes the image's `GIT_CONFIG_GLOBAL`,
`AZURE_CONFIG_DIR` and `AZURE_EXTENSION_*` to agents' tools: the SDK gives a CLI
only its baseline and that list, and without them `git` and `az` in an agent's
shell would use the service profile's own, writable configuration. The build
keeps the deployment's entries as they are and appends each of these that none
of them covers, by name or by a prefix (`GIT_*` covers `GIT_CONFIG_GLOBAL`);
without the setting, the list is just these three. An entry the SDK would refuse
(anything but a name, or a name prefix followed by `*`) fails the build.

### `userData`

The deployment's per-stamp values reach every VM through the scale set's
`userData`, which `launcher.mjs` and `disk-attacher.mjs` read from IMDS
(`compute/userData`) at every service start. Any process on the VM can read
IMDS, so **userData holds no secret**; the launcher refuses a database URL with
a password, a storage URL with a query and a feed entry with a password.

IMDS returns userData base64-encoded. Decoded, version 1 is a UTF-8 JSON
object:

```json
{
  "version": 1,
  "env": {
    "DATABASE_URL": "postgresql://<worker-identity>@<server>:5432/<db>?sslmode=require",
    "PILOTSWARM_CMS_FACTS_DATABASE_URL": "postgresql://<worker-identity>@<server>:5432/<db>?sslmode=require",
    "PILOTSWARM_DB_AAD_USER": "<worker-identity-name>",
    "AZURE_STORAGE_ACCOUNT_URL": "https://<account>.blob.core.windows.net/",
    "PS_DISK_POOL_CONTROLLER_URL": "https://<controller-address>:3003",
    "PS_DISK_CONTROLLER_TOKEN_SCOPE": "api://<controller-app>/.default",
    "AZURE_CLIENT_ID": "<worker identity's client ID>",
    "EXPECTED_WIN_WORKER_OID": "<worker identity's object ID>",
    "ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS": "{\"endpointCredentials\":[]}",
    "WIN_WORKER_CONFIG_VERSION": "<hash of the rendered values>",
    "PILOTSWARM_WORKER_OWNER_ONLY": "1"
  },
  "extraEnv": { "EXAMPLE_TOOL_URL": "https://tool.example.test" },
  "controllerCaCert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
}
```

| Field | Rule |
|---|---|
| `version` | `1` |
| `env` | Exactly the eleven names above, each a non-empty string. Database URLs are `postgres://` or `postgresql://` without a password; the storage and controller URLs are plain `https://`; the client ID and object ID are GUIDs; the feed endpoints are `{"endpointCredentials":[...]}` (an empty list for none), each with an `endpoint` and no `password`; the configuration version is 1 to 128 letters, digits and `. _ : -`; `PILOTSWARM_WORKER_OWNER_ONLY` is exactly `"0"` or `"1"` |
| `extraEnv` | Optional extra `NAME: value` pairs for the deployment's own tools. A name may not be one that `worker.env` or `env` sets (compared without case), one the launcher sets (`PILOTSWARM_WORKER_OWNER_TAG`, `PS_LAUNCH_ID`), a process or profile variable (`PATH`, `TEMP`, `APPDATA` and the like), `GITHUB_TOKEN` or `GH_TOKEN`, or start with `NODE_`, `COPILOT_`, `PILOTSWARM_`, `PS_` or `WIN_WORKER_` (the platform's own settings), or with `AZURE_`, `GIT_`, `NUGET_`, `GCM_` or `ARTIFACTS_CREDENTIALPROVIDER_`, which would change every session's Azure CLI, Git, NuGet or credential flow (`GIT_CONFIG_PARAMETERS` injects Git configuration; `AZURE_EXTENSION_*` turns dynamic CLI extensions back on) |
| `controllerCaCert` | The controller's trusted CA certificates as one PEM bundle: its CA, or during a CA rotation two CAs, the current one first (see "Rotating the CA" in [the disk controller's README](../disk-controller/README.md#rotating-the-ca)). Each certificate must be a CA, and nothing but whitespace may come before, between or after them |

Anything missing, unknown or invalid stops the launcher (exit code 1) instead of
starting with the image's defaults. A deploy that changes these values sets a
new `WIN_WORKER_CONFIG_VERSION`, and the controller recycles VMs that report
another one.

### What the launcher does at each start

1. Refuses any Node.js but `24.22.1` (the version `deploy/Dockerfile.worker`
   pins).
2. Reads `worker.env` and userData and builds the worker's environment.
3. Asks IMDS for a controller token and refuses to start unless its `oid` is
   `EXPECTED_WIN_WORKER_OID`.
4. Creates this start's launch ID (`PS_LAUNCH_ID`) and starts the 15-second
   heartbeat (`POST /v1/vms/heartbeat` with `phase: "starting"`, the launch ID,
   the configuration version and no drive), over HTTPS that trusts only the CAs
   from userData.
5. Clears `C:\pilotswarm\temp` (never through a link).
6. When a heartbeat answer names a drive as attached to this VM, frees LUN 0:
   the attacher's `/offline-lun0`, then `POST /v1/leases/detach` with
   `crashed: true`, retried with backoff (1 second, doubling to a minute) with
   the same request ID while the heartbeat runs. Nothing that can fail runs
   before the first heartbeat answer and this clean-up.
7. Calls the attacher's `/sync-release` (reading `attacher.token` again after a
   `401`), retrying while the answer says it may succeed, for up to 15 minutes;
   anything else fails closed.
8. Resolves `C:\pilotswarm\current` once and rewrites every value under it to
   that release's folder, so a running worker never sees another release.
9. Polls `POST /v1/vms/register` until the VM is `active`. A standby VM, or any
   VM while the pool is frozen, never starts a worker.
10. Sets `PILOTSWARM_WORKER_OWNER_TAG=owner.<ownerOid>` when the answer names an
    owner. With `PILOTSWARM_WORKER_OWNER_ONLY=1`, an unbound VM imports no
    worker: the launcher keeps heartbeating and starts the worker when a
    heartbeat answer first names an owner (and the VM is not frozen or
    draining).
11. Clears `C:\pilotswarm\azure-cli` and starts
    `az login --identity --client-id <AZURE_CLIENT_ID> --allow-no-subscriptions`
    through `cmd.exe /d /s /c` (Node cannot start `az.cmd` without a shell),
    after checking that the client ID is a GUID. It never waits for it: a failure
    is logged and retried 30 seconds later, then every 5 minutes.
12. Puts its heartbeat in the hand-over slot
    `globalThis[Symbol.for("pilotswarm.devdrive.heartbeat-handover")]` and
    imports `<release>\packages\sdk\examples\worker.js` by its file URL. The
    extension sends its first heartbeat, then stops the launcher's.

A stop request (Ctrl+C from WinSW) before the worker starts stops the heartbeat
and exits 0. After the import, the worker's own handler drains; a request that
arrives while the worker is still starting is passed on once that handler is
installed.

### The attacher

`disk-attacher.mjs` listens on `127.0.0.1:3099` only (`PS_DISK_ATTACHER_URL`
must be `http://127.0.0.1:<port>`). At each start it writes a new random token
to `C:\pilotswarm\run\attacher.token`: an empty file first gets an access list
of SYSTEM and Administrators (Full) and the worker (Read), then the token. Every
request needs `Authorization: Bearer <token>`, compared in constant time; any
other request gets `401`. The token keeps out other local accounts, not the
worker's own agents, which run as the same account: so no route gives more than
the worker already has.

Every route is a `POST` with a JSON object body (16 KB at most). Values are
checked before anything runs: `diskName` is a managed disk name (letters,
digits, `_ . -`), `workerPid` a process ID, `sizeGb` a whole number from 1 to
65536.

| Route | Body | Answer |
|---|---|---|
| `/online-lun0` | `{ diskName }` | `{ ok: true }` once LUN 0 is online as the ReFS Dev Drive `Q:` at the disk's full size and trusted (`fsutil devdrv trust`). A disk the attacher has not brought online before gets a new GPT disk GUID first, since every drive is a copy of one snapshot |
| `/offline-lun0` | `{ diskName, workerPid }` | `{ ok: true }` once LUN 0 is offline, also when it already was. First it stops every process that runs from the drive, names it on its command line or has its current folder there, and whatever those started, except the worker (`workerPid`) and the attacher; then it flushes the volume |
| `/extend-lun0` | `{ diskName, sizeGb }` | `{ ok: true }` once Windows sees the disk at `sizeGb` and the partition fills it; `{ ok: false, retry: true }` until then |
| `/sync-release` | `{}` | `{ ok: true, changed, commitSha, release }` |

The LUN 0 routes run one at a time and are idempotent. Errors answer
`{ ok: false, code, message, retryable }`. Disk operations run in Windows
PowerShell 5.1 (by its full path) from a script the attacher writes to
`run\disk-ops.ps1` at start, with `-File` and the checked values as separate
parameters, never inside a command line. LUN 0 is the data disk at SCSI logical
unit 0 on a controller other than the OS disk's.

Their `TEMP` and `TMP` are `run\ps-temp\`, never LocalSystem's
`C:\Windows\Temp`, where ordinary accounts may create files: the process search
compiles C# there with `Add-Type`. At each start the attacher creates the folder,
checks its access list (owned by SYSTEM or Administrators, and no write right for
anyone else, not even one that only what is created in it inherits: the worker
only reads), refuses to start otherwise, and empties it.

#### `current-release.json` and the release on a VM

`Pack-WinWorkerRelease.ps1` writes `current-release.json`, and the upgrade
publishes it last, in the release container (`win-worker-releases` unless
`worker.env` sets `PS_WORKER_RELEASES_CONTAINER`) of `AZURE_STORAGE_ACCOUNT_URL`:

```json
{
  "schemaVersion": 1,
  "commitSha": "<40 lowercase hex>",
  "zipSha256": "<64 lowercase hex>",
  "modelCatalog": { "blob": "model-catalog-<hash12>.json", "sha256": "<64 hex>" },
  "headlessInstructions": { "blob": "headless-instructions-<hash12>.zip", "sha256": "<64 hex>" },
  "plugins": [{ "name": "<plugin>", "blob": "plugins/<plugin>-<hash12>.zip", "sha256": "<64 hex>" }]
}
```

The release itself is the blob `worker-release-<commitSha>.zip`. Every field but
`schemaVersion`, `commitSha` and `zipSha256` is optional; unknown fields are
refused. Blob names are letters, digits and `. _ -`, up to four `/` segments.

`/sync-release`, with the VM identity's storage token from IMDS:

1. writes `disk-controller-ca.crt` from userData, the whole bundle;
2. reads `current-release.json`; when that release and its artifacts are already
   in place, it downloads nothing and answers `changed: false`;
3. a release changes only in the first successful sync of each start of the
   worker service (the service's process ID and start time, kept in
   `run\release-state.json`), so a later call during the same run answers `409
   WORKER_RUNNING` and changes nothing;
4. downloads each artifact into a staging folder, hashing it as it streams;
   a hash that is not the named one is refused (`502 HASH_MISMATCH`) before the
   artifact is extracted or used;
5. checks each zip's entries in its central directory, each against its local
   header: no links, absolute paths, drive letters, `..`, backslashes, `:`,
   device names or names ending in a dot or space; then extracts it with
   `C:\Windows\System32\tar.exe` into a new folder and refuses it if a link
   appears;
6. moves the release to `releases\<commit12>-<zip12>\` (a folder never changes
   once complete), then switches `current` (a new junction renamed into place;
   an interrupted switch is completed by the next sync), replaces
   `plugins\<name>\` and `headless-instructions\`, and removes those no longer
   named;
7. writes the catalog to `C:\pilotswarm\model_providers.json` and records the
   state, then removes releases other than the current and the previous one in
   the background.

### The controller's Run Commands

The disk controller runs these as Managed Run Commands from
`C:\pilotswarm\scripts` (its `PS_DISK_CONTROLLER_VM_SCRIPTS_DIR`):

| Command | What it does |
|---|---|
| `& 'C:\pilotswarm\scripts\Drain-And-StopWorker.ps1'` | Stops `PilotSwarmWorker`, which drains; waits up to 115 minutes. A worker that crashes while draining is restarted by its failure action and stopped again, until the service stays stopped. Exits 0 when stopped or not installed |
| `Start-Service -Name PilotSwarmWorker` | After an upgrade |
| `& 'C:\pilotswarm\scripts\Seed-WorkerReposDisk.ps1' -Refresh` | On a refresh VM: mounts the drive, fetches, updates the caches, and writes grants, owners and clean-detach records again |
| `& 'C:\pilotswarm\scripts\Seed-WorkerReposDisk.ps1' -Verify` | Prints, as its last line, `{"verified": true\|false, "manifestSha256": "<64 hex>", "checks": {...}}` and exits 0 only when verified |

Each command is one line of the Run Command's own script, so the scripts never
report a failure with a bare `exit 1`: a nested script's exit code does not
become the exit code of a script run with `-File`. They fail with a terminating
error instead, which ends the calling script with exit code 1 however
PowerShell runs it.

`-Refresh` and `-Verify` read the seed manifest the image installed,
`C:\pilotswarm\seed-manifest.json` (`-ManifestPath` changes it). `-Verify`'s
checks are `refs` (each repository on its branch at the fetched commit, and the
remote refs the seed recorded in `<drive>\.pilotswarm\seed-state.json`
unchanged), `fsck` (`git fsck --connectivity-only` in each repository and
submodule), `hooks` (only Git's `*.sample` files), `cleanRecord` (each
`pilotswarm-clean-tips` current), `owner` (each repository's folder and `.git`,
and each submodule's folder, `.git` file and Git directory, owned by the worker's
SID) and `acl` (the Modify folders granted, `Q:\` and the repositories' root not
writable by Users, Authenticated Users, CREATOR OWNER or Everyone). Each is
`true`, or a list of up to five things it found wrong.

## Building the image

On a fresh Windows Server 2025 VM (below: Gen2, Standard security, in the
stamp's region), as an administrator, from a copy of this folder:

```powershell
.\Build-WorkerOsImage.ps1 -ToolchainManifest .\examples\toolchain-manifest.json `
  -WorkerSettingsFile .\examples\worker-settings.env.example `
  -SeedManifest .\examples\seed-manifest.json -Generalize
```

It installs Node.js 24.22.1 from its MSI after checking the MSI's SHA-256
against the pinned value and the one Node.js publishes, installs the toolchain,
WinSW and both services, applies everything in "On a worker VM", writes
`C:\pilotswarm\image-versions.json` and, with `-Generalize`, runs Sysprep, which
shuts the VM down for capture as the next gallery image version. The image
holds no secret, stamp value or identity.

### Capturing it into the gallery

Base-infra creates the stamp's gallery, `<prefix>gallery` (the stamp's naming
prefix, lowercase, without `-` and `_`), and its image definition
`pilotswarm-win-worker`: Windows, generalized, Gen2 (`hyperVGeneration` `V2`),
and without a security type, so its versions come from VMs with Standard
security, as the scale set's are.
`WIN_WORKER_GALLERY_IMAGE_ID`, a base-infra output, is the definition's ID.
`az vm create` makes a Gen2 VM a Trusted launch VM unless told otherwise, and
the gallery refuses a Trusted launch VM's image for this definition, so create
the build VM with `--security-type Standard`, from a Gen2 image, in a resource
group of its own:

```powershell
az group create --name <build-rg> --location <region>
az vm create --resource-group <build-rg> --name <build-vm> --location <region> `
  --image MicrosoftWindowsServer:WindowsServer:2025-datacenter-g2:latest `
  --security-type Standard --size Standard_D4ds_v5 --admin-username <admin> --nsg-rule NONE
```

`--nsg-rule NONE` opens no inbound port; reach the VM through Azure Bastion or
Run Command. `az vm create` asks for the administrator's password. Once
`Build-WorkerOsImage.ps1 -Generalize` has shut the VM down (never start it
again), capture it:

```powershell
az vm deallocate --resource-group <build-rg> --name <build-vm>
az vm generalize --resource-group <build-rg> --name <build-vm>
$vm = az vm show --resource-group <build-rg> --name <build-vm> --query id --output tsv
az sig image-version create --resource-group <stamp-rg> --gallery-name <prefix>gallery `
  --gallery-image-definition pilotswarm-win-worker --gallery-image-version <Major.Minor.Patch> `
  --virtual-machine $vm --target-regions <region> --replica-count 1
az group delete --name <build-rg> --yes
```

- `az vm generalize` tells Azure what Sysprep did; a generalized VM can't
  start again, and the version doesn't need it once it exists.
- `--target-regions` names the stamp's region, where the scale set creates its
  VMs; it must include the build VM's region. One replica serves up to 20 VMs
  created at the same time, more than the default pool (`WIN_WORKER_COUNT`,
  five VMs); raise `--replica-count` for a pool that creates more at once.
- The version is `WIN_WORKER_IMAGE_VERSION`. Set it and deploy: the first
  version brings up the scale set, and a later one changes
  `WIN_WORKER_CONFIG_VERSION`, so the controller replaces the VMs that run
  another ([deploy/scripts/README.md](../../../scripts/README.md)).

### The toolchain manifest

```json
{
  "schemaVersion": 1,
  "notes": "free text, kept in image-versions.json",
  "installers": [
    { "name": "git", "url": "https://...exe", "sha256": "<64 lowercase hex>", "type": "exe", "arguments": ["/VERYSILENT"], "successExitCodes": [0] },
    { "name": "tool", "url": "https://...msi", "sha256": "...", "type": "msi" },
    { "name": "pwsh", "url": "https://...zip", "sha256": "...", "type": "zip", "destination": "C:\\Program Files\\PowerShell\\7", "addToPath": true }
  ],
  "commands": [{ "name": "step", "command": ["C:\\path\\program.exe", "arg"], "successExitCodes": [0] }],
  "mcpServers": [{ "name": "filesystem", "package": "@modelcontextprotocol/server-filesystem", "version": "2026.8.31", "ignoreScripts": true }],
  "npmRegistry": "https://registry.npmjs.org/",
  "defenderExclusions": { "paths": ["Q:\\Repos"], "processes": [] }
}
```

Installers download over `https://` only and run only when their SHA-256
matches. An `msi` runs with `/qn /norestart` (exit codes 0 and 3010 succeed);
a `zip` extracts to `destination`. In `arguments` and `command`,
`{manifestDir}` is the manifest's folder, for files shipped next to it. Each MCP
server is installed with `npm install --prefix C:\pilotswarm\mcp\<name>` at its
exact version, so no session downloads one with `npx` at run time. Names are
unique; unknown fields are refused. The worker's own Node.js is not part of the
toolchain.

### The worker settings file

`NAME=VALUE` lines (see `examples/worker-settings.env.example`), the deployment's choices
for every VM: Git identity and the WIP branch prefix, capacity, package cache
locations, `PILOTSWARM_CLI_ENV_ALLOWLIST`, `PLUGIN_DIRS`,
`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, `PILOTSWARM_REDACT_SECRET_PREFIXES` and any
other worker setting. It may not set the image's own values, the userData names,
`PILOTSWARM_WORKER_OWNER_TAG`, `PS_LAUNCH_ID`, `GITHUB_TOKEN`, `GH_TOKEN` or
`COPILOT_GITHUB_TOKEN`; the build fails if it does. It holds no secret.

`-GitConfigFile` installs the workers' global Git configuration
(`GIT_CONFIG_GLOBAL`, Read-Only), for example a credential helper that signs in
with the VM's managed identity; without it, a minimal one is written.

## The golden drive

1. Attach an empty disk at LUN 0 to a VM built from the image and run
   `Initialize-WinWorkerDisk.ps1` (ReFS Dev Drive `Q:`, root access lists).
2. Run `Seed-WorkerReposDisk.ps1` as an administrator, with
   `-SnapshotResourceGroup`, `-SnapshotName` and `-DiskResourceId` to take the
   incremental snapshot (the Azure CLI must be signed in). Like the controller's
   weekly refresh, it waits until Azure reports the snapshot `Succeeded` and its
   background copy at 100% (or reports no percentage), and stops when
   provisioning fails.

### The seed manifest

```json
{
  "schemaVersion": 1,
  "reposRoot": "Q:\\Repos",
  "repositories": [{ "name": "PilotSwarm", "url": "https://github.com/microsoft/PilotSwarm.git", "branch": "main", "submodules": true, "lfs": false }],
  "modifyFolders": ["Q:\\Repos\\PilotSwarm", "Q:\\.cache\\npm", "Q:\\temp"],
  "packageCaches": [{ "name": "npm", "workingDirectory": "Q:\\Repos\\PilotSwarm", "command": ["npm.cmd", "ci", "--ignore-scripts"], "env": { "npm_config_cache": "Q:\\.cache\\npm" } }],
  "env": { "NAME": "value for every command" }
}
```

| Field | Rule |
|---|---|
| `reposRoot` | Where repositories are cloned, `<reposRoot>\<name>`; default `Q:\Repos`. It stays Read-Only to the worker |
| `repositories` | `name` (letters, digits, `_ . -`), `url` (`https://` or `file://`, no credentials), `branch`, `submodules` (default `true`), `lfs` (`false`, `true` for the checked-out files, or `"all"`) |
| `modifyFolders` | Absolute folders on the drive that the worker may change; each repository's folder must be one of them or inside one |
| `packageCaches` | Commands that fill caches: `command` (program and arguments, no shell), `workingDirectory`, optional `env` |
| `env` | Optional settings for every command, for example a credential helper's |

Repositories are cloned with full history. The seed's own Git calls run without
hooks and with `-c safe.directory=*`. The clean-detach record,
`pilotswarm-clean-tips` in each repository's and submodule's Git directory,
holds the object IDs of `HEAD` and then of every ref (`git for-each-ref`), each
once, one per line, LF line endings, UTF-8 without a byte order mark: exactly
what the Dev Drive extension writes, so a drive's first crash takeover already
gets the scoped check. Then the worker's SID becomes the owner of each
repository's folder and `.git`, and of each submodule's folder, `.git` file and
Git directory, because Git refuses a repository that another account owns
("detected dubious ownership"). The seed confirms the SID with
`sc.exe showsid PilotSwarmWorker` first, and that Windows knows the account:
`icacls` looks a `*SID` up, and `NT SERVICE\PilotSwarmWorker` exists only where
its service is installed, so the seed and its refresh run on VMs built from the
image.

## Packing a release

On a Windows x64 agent with Node.js 24.22.1, from a clean checkout:

```powershell
.\deploy\providers\azure\windows\Pack-WinWorkerRelease.ps1 -OutputDir .\out `
  -ModelCatalog .\model_providers.json -HeadlessInstructions .\instructions -Plugin .\plugins\example-plugin
```

It runs `npm ci` and `npm run build`, packs `packages/sdk`,
`packages/horizon-store` and `packages/app` with `npm pack --ignore-scripts`,
prunes devDependencies, replaces the three workspace links in `node_modules` by
the extracted tarballs, copies `packages/sdk/examples/` and
`packages/app/tui/plugins/`, writes a stub `packages/sdk/package.json` holding
only `{"type":"module"}`, and unpacks the Copilot CLI program into
`copilot-pkg\` (`copilot.exe --no-auto-update --version` with
`COPILOT_PKG_CACHE_HOME`, every other `COPILOT_*` variable removed). It fails
unless `copilot-pkg\pkg\win32-x64\<version>\` (the version the SDK pins) holds
`.extraction-complete`, `index.js`, `app.js` and
`prebuilds\win32-x64\runtime.node`, if any junction or other reparse point
remains, or if `@github/copilot-win32-x64`, `@github/copilot-sdk-win32-x64` or
`duroxide-windows-x64` is missing. The zip is made with `tar.exe` (with UTF-8
entry names: without them `tar.exe` drops non-ASCII characters) and read back
the way the attacher reads it, and every entry must name a file of the staged
release. `-OutputDir` must be on the repository's volume.

The output folder holds `worker-release-<sha>.zip`, the other artifacts (named
by their content hash) and `current-release.json`.

## Upgrading a stamp

`Bootstrap-WinWorkerStamp.ps1` upgrades in four steps, with the controller's
pool frozen from the first to the last:

1. **Freeze:** `POST /v1/admin/upgrade-freeze` `{ "frozen": true }`. The
   controller stops scaling out, activating VMs and attaching drives, and runs
   `Drain-And-StopWorker.ps1` on every active VM. The coordination host's
   manifest is published with 0 replicas. The step ends when
   `GET /v1/admin/upgrade-freeze` reports every active VM stopped.
2. **Migrate:** runs the database migration Job (`-MigrationJobManifest`) to
   completion: on a stamp deployed with `deploy/scripts/deploy.mjs`, the
   database role Job, which migrates as the portal's identity and grants the
   workers' database group (see "The database role Job" in
   [deploy/scripts/README.md](../../../scripts/README.md)).
3. **Publish:** uploads every artifact `current-release.json` names, then
   `current-release.json` last, with `az storage blob upload --auth-mode login`;
   rolls `-RollDeployments` (`kubectl rollout restart` and `rollout status`);
   and has the coordination host take its new manifest, still with 0 replicas.
4. **Unfreeze:** brings the coordination host back, then
   `POST /v1/admin/upgrade-freeze` `{ "frozen": false }`. The controller starts
   the worker service again, and each launcher syncs the new release before its
   worker starts.

```powershell
.\Bootstrap-WinWorkerStamp.ps1 -ReleaseDir .\out -StorageAccountName <account> -Namespace <namespace> `
  -ControllerCaFile .\disk-controller-ca.crt -ControllerTokenScope api://<controller-app>/.default `
  -MigrationJobManifest ..\..\..\.tmp\portal-<env>\db-role-job.yaml -CoordinationHostScript .\Set-CoordinationHost.ps1
```

Before it freezes anything, it checks every artifact against its hash. Each
controller call opens `kubectl port-forward svc/pilotswarm-disk-controller
<LocalPort>:3003`, connects to `127.0.0.1`, and checks the certificate against
`-ControllerAddress` (default `10.20.15.250`, the address the controller's
certificate names) with `-ControllerCaFile` as the only CAs: the `ca.crt` of
the ConfigMap `pilotswarm-disk-controller-ca`, which holds both CAs during a
CA rotation. The token is an
Entra token for `-ControllerTokenScope` from the signed-in Azure CLI: an
app-only token with the `deployer` role, or an operator's with `admin`. It is
passed to the request in its environment and never printed.

Two pieces come from the deployment, as parameters:

- `-CoordinationHostScript`: called as `& <script> -Replicas <n> -Step
  Freeze|Publish|Unfreeze`; it publishes the coordination host's manifest with
  that many replicas (the current image at `Freeze`, the new one from `Publish`
  on) and returns once it is applied and the pods are gone or ready.
  `-NoCoordinationHost` skips it on a stamp without one.
- `-MigrationJobManifest`: the migration Job for `kubectl apply`, with the
  objects it mounts; it must create exactly one Job, and the step deletes its
  objects first. With `WIN_WORKERS_ENABLED=true`, the portal's manifests step
  of `deploy/scripts/deploy.mjs` stages the database role Job there:
  `deploy/.tmp/portal-<env>/db-role-job.yaml`, a ConfigMap with the Job's
  script and model catalog, and the Job, both named `pilotswarm-db-role`.
  `-SkipMigration` skips the step.

The freeze is kept in the controller's state: after a failure, fix the cause
and run again with `-From` at the failed step; the pool stays frozen until
`Unfreeze` succeeds.

## Other scripts

- `Drain-And-StopWorker.ps1` (above).
- `Clear-StaleWorkspaces.ps1` lists what is in `C:\pilotswarm\temp`, the image's
  scratch folder, and with `-Apply` removes it, never through a link. It refuses
  while `PilotSwarmWorker` is not stopped, because running sessions use the
  folder, and touches nothing else: not session state, releases or the Dev Drive.
  The launcher already clears the same folder at every start.

## Tests

```bash
node --test deploy/providers/azure/windows/test/*.test.mjs
```

`npm run test:deploy-scripts` runs them too. They need no dependency: IMDS,
the controller, the release container, PowerShell's disk operations and the
worker are fakes, and the heartbeat hand-over uses the Dev Drive extension's own
`takeOverHeartbeat()`. With PowerShell 7 installed, every script is parsed, and
the seed's clean-detach records are compared byte for byte with the extension's
on a real repository with a submodule. On Windows, every script is also parsed
by Windows PowerShell 5.1, the clean-detach records are written by it too, and
these run for real against temporary folders: the seed's `-Verify` and the
drain, each called the way the controller's Run Command calls it (one line of a
script that Windows PowerShell 5.1 runs with `-File`); the disk script's process
search, which compiles its C# only in the `TEMP` and `TMP` it is given; its
access-list report and the attacher's check of `run\ps-temp\` (in an elevated
shell, also under the list the image gives `C:\pilotswarm`); `tar.exe` zips;
junctions in the packer's check, its stage clean-up and the scratch folder
clean-up.

## What only a real VM can verify

The tests cannot reach Azure, a scale set or a data disk. These need a worker
VM:

- the image build end to end: the Node.js and WinSW installs, the toolchain,
  every access list (write attempts from an agent shell as the worker account on
  `C:\`, `Q:\`, `C:\pilotswarm\work`, the `copilot\` placeholders and settings
  files, `releases\`, `current\copilot-pkg` and `C:\ProgramData\GitHub`), the
  top-level folder audit, the firewall rule groups and Sysprep;
- no crash dump: a crash of `node.exe` and of the Copilot CLI program as the
  worker account leaves no dump and no queued report;
- whether the Copilot CLI program reads anything else from its home or the
  service profile (a file trace of launch, create and resume), which confirms
  the placeholder list, and whether it keeps MCP tokens and secrets in the
  worker account's keychain or in the placeholder folders;
- the services under WinSW: the worker's account, `<depend>`, the restart after
  a non-zero exit and none after exit 0, the 105-minute stop and the drain;
- the disk operations: finding LUN 0 among the VM's disks, a new disk GUID on a
  drive copied from the snapshot, the drive letter, the extend to full size
  (also after the controller grows a mounted drive), `fsutil devdrv trust`, the
  processes stopped before an offline, and a clean offline; and, as LocalSystem,
  that the attacher accepts the image's `run\ps-temp\` and that `Add-Type`
  compiles there or in SYSTEM's own private folder (`C:\Windows\SystemTemp`,
  which newer Windows gives SYSTEM processes), never in `C:\Windows\Temp`;
- IMDS: userData, tokens for the worker identity and the storage token;
- the controller: register, heartbeats, the detach, and the timings that size the
  controller's windows (service start to first heartbeat and to `running`, cold
  with a release download, warm and after a crash);
- the release sync against the real container, a hash mismatch failing every
  start, and `az login --identity` as the worker account;
- the seed and its refresh on full repositories: clones, LFS, caches, owners
  (`git status` as the worker account on a fresh copy of the snapshot, with no
  "dubious ownership"), the snapshot, and `-Verify` as a Run Command;
- the packer on a Windows x64 agent (`npm ci`, the tarballs, the unpacked
  Copilot CLI program) and the upgrade against a live controller and cluster.
