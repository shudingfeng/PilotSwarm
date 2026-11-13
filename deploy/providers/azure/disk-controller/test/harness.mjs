// A controller wired to the fakes, plus helpers that call its listeners the
// way the network would: with a bearer token and a source address.
import { createAzure } from "../lib/azure.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createController } from "../lib/controller.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import {
  DCR_ID, DISPATCHER_OID, FakeClock, FakeCloud, FakeSecretClient, GOLDEN_ID, MemoryBackend, SCALE_SET_ID, TENANT, TOKENS, WORKER_OID,
  APP, createMemoryLogger, fakeVerifier,
} from "./fakes.mjs";

export const BASE_ENV = Object.freeze({
  PS_DISK_POOL_STATE_URL: "https://placeholder.blob.core.windows.net/disk-pool-state",
  PS_DISK_CONTROLLER_TOKEN_SCOPE: `api://${APP}/.default`,
  AZURE_TENANT_ID: TENANT,
  EXPECTED_WIN_WORKER_OID: WORKER_OID,
  DISPATCHER_SP_OBJECT_ID: DISPATCHER_OID,
  PILOTSWARM_PERSONAL_SECRET_VAULT_URI: "https://myvault.vault.azure.net/",
  WIN_WORKER_SCALE_SET_ID: SCALE_SET_ID,
  WIN_WORKER_DCR_ID: DCR_ID,
  WIN_DEV_DRIVE_GOLDEN_SNAPSHOT_ID: GOLDEN_ID,
  WIN_WORKER_IMAGE_VERSION: "1.0.1",
  WIN_WORKER_CONFIG_VERSION: "cfg-1",
  WIN_WORKER_COUNT: "5",
  WIN_WORKER_MIN_RUNNING: "0",
  WIN_WORKER_IDLE_RECYCLE_MINUTES: "15",
  WIN_DEV_DRIVE_POOL_COUNT: "4",
  WIN_DEV_DRIVE_SPARE_COUNT: "2",
  WIN_DEV_DRIVE_MAX_PER_USER: "2",
});

export const MINUTES = (n) => n * 60_000;

/**
 * Builds and starts a controller over the fakes. `env` overrides settings,
 * `cloud` configures the FakeCloud, and `graceOver` (default true) moves the
 * clock past the startup grace.
 */
export async function createHarness({ env = {}, cloud: cloudOptions = {}, graceOver = true, withAzure = true, withSecrets = true } = {}) {
  const clock = new FakeClock();
  const cloud = new FakeCloud(cloudOptions);
  const config = loadConfig({ ...BASE_ENV, ...env });
  const backend = new MemoryBackend();
  const state = createStateStore({ backend });
  const log = createMemoryLogger();
  const secrets = withSecrets ? new FakeSecretClient() : null;
  const azure = withAzure && config.scaleSet
    ? createAzure({ compute: cloud.compute, network: cloud.network, monitor: cloud.monitor, scaleSet: config.scaleSet, dcrId: config.dcrId })
    : null;
  const controller = createController({ config, azure, state, secrets, log, clock, verifyToken: fakeVerifier });
  await controller.start();
  const ctl = controller.ctl;
  if (graceOver) clock.advance(config.startupGraceMs + 1);

  async function call(listener, method, path, { token, body, from = "10.244.0.10" } = {}) {
    const answer = await controller.apps[listener].handle({
      method,
      url: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: from,
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    });
    await ctl.settle();
    return { status: answer.status, headers: answer.headers, text: answer.body, body: answer.body ? JSON.parse(answer.body) : null };
  }

  const h = {
    clock,
    cloud,
    config,
    backend,
    state,
    log,
    secrets,
    controller,
    ctl,
    call,
    /** A worker route from a VM's own address, with the workers' token. */
    worker: (vmName, path, body, token = TOKENS.worker) => call("worker", "POST", path, { token, body, from: `::ffff:${cloud.vm(vmName).ip}` }),
    dispatcher: (path, body, token = TOKENS.dispatcher) => call("dispatcher", "POST", path, { token, body }),
    coordination: (body, token = TOKENS.coordinator) => call("coordination", "POST", "/v1/coordination/demand", { token, body }),
    /** An admin route through a port-forward, as a person with the admin role, which every admin route takes. */
    admin: (method, path, body, token = TOKENS.admin) => call("worker", method, path, { token, body, from: "127.0.0.1" }),
    async tick() {
      await controller.tick();
      await ctl.settle();
    },
    async heartbeat(vmName, extra = {}) {
      const answer = await h.worker(vmName, "/v1/vms/heartbeat", {
        vmName,
        launchId: h.launchIds.get(vmName) ?? h.relaunch(vmName),
        phase: "running",
        activeWorkloadCount: 0,
        draining: false,
        configVersion: "cfg-1",
        ...extra,
      });
      return answer.body;
    },
    launchIds: new Map(),
    relaunch(vmName) {
      const id = `launch-${vmName}-${Math.random().toString(16).slice(2)}`;
      h.launchIds.set(vmName, id);
      return id;
    },
    /** Raises the scale set's capacity and lets the new VM register: an active VM, bound when `owner` is given. */
    async activeVm({ owner = null } = {}) {
      const { scaleOut } = await import("../lib/scaling.mjs");
      const { syncAzureView } = await import("../lib/fleet.mjs");
      // VMs that earlier scale-outs started take their purposes first, in order.
      await syncAzureView(ctl);
      const known = new Set(state.all("vm").map((record) => record.name));
      const added = await scaleOut(ctl, [owner ? { purpose: "owner", ownerOid: owner } : { purpose: "ready" }]);
      if (!added) throw new Error("the scale set is at its maximum");
      await syncAzureView(ctl);
      const name = state.all("vm").map((record) => record.name).find((candidate) => !known.has(candidate));
      const registered = await h.worker(name, "/v1/vms/register");
      if (registered.body?.status !== "active") throw new Error(`VM ${name} did not activate: ${JSON.stringify(registered.body)}`);
      await h.heartbeat(name);
      return name;
    },
    /** A hydrated spare drive, ready to be claimed. */
    async spares() {
      await h.tick();
      await h.tick();
      return state.all("disk").filter((disk) => disk.state === "AvailableInPool").map((disk) => disk.name);
    },
    async claim({ workId = "work-1", rootSessionId = "root-1", ownerOid, credential = "per-work-secret-1" } = {}) {
      return h.dispatcher("/disk-pool/v1/disks/claim", { workId, rootSessionId, ownerOid, credential });
    },
    drive: (name) => state.get("disk", name),
    driveOf: (workId) => state.all("disk").find((disk) => disk.lease?.workId === workId) ?? null,
    vmRecord: (name) => state.get("vm", name),
  };
  return h;
}
