# Linux coordination host

An extension module for PilotSwarm's Linux worker on Azure, for a deployment
whose Windows workers are owner-only (`PILOTSWARM_WORKER_OWNER_ONLY=1`). Those
workers run only their owner's sessions, so another worker must run
everything else: system sessions, titles, the activities around every turn,
and capacity requests. This Linux worker is that coordination host. The
module sets two hooks on it:

- **The capacity requester** (`worker.setOwnerCapacityRequester`). Before each
  turn of an owner-tagged session, PilotSwarm asks a worker with a capacity
  requester for capacity for the session's owner. The module sends
  `{ ownerOid, rootSessionId }` to the disk controller's coordination route,
  `POST /v1/coordination/demand`, with a token of the pod's own identity, and
  passes the answer on: `ok`; `deny` (`NO_DRIVE_LEASE`) for a root without a
  drive lease, which ends the turn without a retry; or `busy` with
  `retryAfterMs` for a parked or returning drive, which holds the session on
  its timer. The controller then starts a worker for that owner when none is
  up.
- **The admission hook** (`worker.setSessionAdmission`). Only system
  sessions' turns run here. Any other turn is denied, without a retry, so a
  user session that reaches this worker without an owner tag runs no turn on
  it.

It is a module of the Azure provider, not of PilotSwarm's packages: they never
import it, and nothing loads it unless a deployment names it. The worker
image (`deploy/Dockerfile.worker`) carries it at
`/app/deploy/providers/azure/linux-worker/`, without its tests.

## Loading it

On this repository's Azure deployment, `WIN_WORKER_COORDINATION_HOST=true`
sets all of the following on `copilot-runtime-worker` (the `coordination-host`
component of `deploy/providers/azure/gitops/worker`; see "The coordination
host" in `deploy/scripts/README.md`). Elsewhere, set on the worker:

| Setting | Value |
|---|---|
| `PILOTSWARM_EXTENSION_MODULES` | `/app/deploy/providers/azure/linux-worker/capacity-requester.mjs` |
| `PS_COORDINATION_URL` | The coordination route's https origin: `https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005`, the controller's namespace. Nothing else: no path, query or credentials |
| `PS_COORDINATION_TOKEN_SCOPE` | The scope of the controller's app, as in its `PS_DISK_CONTROLLER_TOKEN_SCOPE`: `<app client ID>/.default` or `api://<app client ID>/.default`. The pod's identity needs the app's `coordinator` role |
| `NODE_EXTRA_CA_CERTS` | The disk controller's trusted CA certificates, from the ConfigMap `pilotswarm-disk-controller-ca` (key `ca.crt`) that the controller's TLS step writes in the controller's namespace, mounted as a file: its CA, or two CAs during a CA rotation. Node reads the file only when the process starts, so a new bundle needs a restart; the repository's deployment restarts the pods itself (see "The coordination host") |

The pod signs in with Microsoft Entra Workload ID: AKS sets
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_FEDERATED_TOKEN_FILE` in a pod
with the `azure.workload.identity/use: "true"` label, from its service
account's client ID annotation.

```yaml
spec:
  containers:
    - name: worker
      env:
        - name: PILOTSWARM_EXTENSION_MODULES
          value: /app/deploy/providers/azure/linux-worker/capacity-requester.mjs
        - name: PS_COORDINATION_URL
          value: https://pilotswarm-disk-controller-coordination.<namespace>.svc:3005
        - name: PS_COORDINATION_TOKEN_SCOPE
          value: <app client ID>/.default
        - name: NODE_EXTRA_CA_CERTS
          value: /etc/pilotswarm/disk-controller-ca/ca.crt
      volumeMounts:
        - name: disk-controller-ca
          mountPath: /etc/pilotswarm/disk-controller-ca
          readOnly: true
  volumes:
    - name: disk-controller-ca
      configMap:
        name: pilotswarm-disk-controller-ca
```

`register()` checks everything before it sets a hook, and stops the worker
when:

- `PS_COORDINATION_URL` is missing or is not an `https://` origin;
- `PS_COORDINATION_TOKEN_SCOPE` is missing or is not an app's `/.default`
  scope;
- the worker runs an owner's sessions: `PILOTSWARM_WORKER_OWNER_TAG` is set,
  or `PILOTSWARM_WORKER_OWNER_ONLY` is anything but unset or `0`. The
  coordination host runs no owner-tagged work;
- a workload identity setting is missing;
- the worker has no `setOwnerCapacityRequester` or `setSessionAdmission`.

Register it before the worker starts, as `PILOTSWARM_EXTENSION_MODULES` does:
only then does the worker take capacity requests.

## Capacity requests

The requester asks again, with backoff from 250 ms to 4 seconds, after a
network failure, a `5xx`, a `408`, a `429`, or an answer without a decision,
until the controller answers or PilotSwarm's 15-second signal fires. Each
attempt waits at most 10 seconds. Any other `4xx` refuses the route itself,
for example a token without the `coordinator` role, or the controller's
`403 COORDINATION_HOST`; no retry can pass it, so the requester throws at
once. When the signal fires or the requester throws, PilotSwarm answers
`busy` with `CAPACITY_UNAVAILABLE` and the session asks again a minute later.

The owner comes from the session's owner routing tag, `owner.<subject>`, whose
subject is the owner's Microsoft Entra object ID. The controller serves no
other owner, so for a subject that is not an object ID the requester asks
nothing and answers `deny` with the code `OWNER_NOT_SUPPORTED`: the turn ends
without a retry, and the session shows a message that asks its owner to sign
in with Microsoft Entra ID. PilotSwarm asks only for sessions with an owner
tag, so a missing tag, another prefix or an empty subject is a programming
error, and the requester throws.

## The token

The token comes only from the pod's workload identity, never from managed
identity: the pod cannot reach the instance metadata endpoint. The module
keeps it in memory until five minutes before it expires, and never logs or
writes it. One sign-in runs at a time and gives up after 30 seconds. After
the controller refuses a token (`401` or `403`), the next request signs in
again with a new credential, at most once a minute, so a newly granted role
takes effect without a restart.

`@azure/identity` loads at the first sign-in, never with the module itself,
which imports only Node's built-ins. It is a dependency of `pilotswarm-sdk`,
so it resolves from `/app/node_modules` in the image, as from the repository's
root `node_modules`.

## TLS

The module reaches the controller only over `https`, and every call checks
the controller's certificate against Node's trust store, which holds the
certificates in `NODE_EXTRA_CA_CERTS`; during a CA rotation it holds both
CAs, so a leaf from either passes. The check stays on even when
`NODE_TLS_REJECT_UNAUTHORIZED=0`. The controller's leaf certificate names
`pilotswarm-disk-controller-coordination.<namespace>.svc`.

## Agents and session policy

The coordination host also answers `getWorkerSessionPolicy` and
`resolveAgentConfig` for every session, so it loads the same plugin
definitions (`PLUGIN_DIRS`) as the other workers: `plugin.json`,
`session-policy.json`, `agents/`, and `skills/` when an agent declares a
skill. It needs no tool module and no MCP servers for those answers;
`packages/sdk/test/unit/coordination-host-parity.test.mjs` checks that they
match. On the Azure deployment, `WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP`
names a ConfigMap with those definitions, and the host loads a read-only copy
of only them.

## Tests

```bash
node --test deploy/providers/azure/linux-worker/test/*.test.mjs
```

They need only Node's standard library, and run in `npm run
test:deploy-scripts`. They include the requester against the disk controller
itself, in the same process.
