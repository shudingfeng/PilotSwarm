// The disk controller: the context every module works on, the three
// listeners' route tables, the 15-second tick and the refresh timer.
//
//   :3003  worker routes (worker role, the workers' identity, a pool VM's
//          source IP; no capacity route: owner-only workers send no capacity
//          request) and /v1/admin/* (admin; upgrade freeze also deployer)
//   :3004  dispatcher routes (user role, DISPATCHER_SP_OBJECT_ID only) and
//          the health probe, which takes no token and answers no data
//   :3005  /v1/coordination/demand (coordinator role), every capacity request
import { KeyedMutex } from "./mutex.mjs";
import { HttpError, createApp } from "./http.mjs";
import { TIMING, leaseView } from "./model.mjs";
import { controllerRecord, goldenSnapshotId } from "./controller-record.mjs";
import {
  checkCrashes, checkRollout, freezeStatus, heartbeat, isOutdated, progressDrains, progressFences, register, resolveVm, setFrozen,
  syncAzureView, vmRuntime,
} from "./fleet.mjs";
import { admit, attach, claim, detach, maintainPool, park, rebind, returnDrive, rotateCredential, syncBranch } from "./pool.mjs";
import { busyRequest, capacityRequest } from "./demand.mjs";
import { evaluateScaling } from "./scaling.mjs";
import { modelCredentialStatus, releaseModelToken, releaseWorkCredential } from "./broker.mjs";
import { REFRESH_CHECK_MS, progressRefresh } from "./refresh.mjs";

const ok = (body) => ({ status: 200, body });

export function createController({
  config,
  azure = null,
  state,
  secrets = null,
  log,
  clock = { now: () => Date.now() },
  timers = { setInterval, clearInterval },
  verifyToken,
}) {
  const tasks = new Set();
  const ctl = {
    config,
    azure,
    state,
    secrets,
    log,
    locks: new KeyedMutex(),
    now: () => clock.now(),
    startedAt: clock.now(),
    ready: false,
    runtime: {
      vms: new Map(),
      azureVms: new Map(),
      scaleSet: null,
      nics: { addresses: new Map(), at: 0, loading: null },
      creating: new Set(),
      deleting: new Set(),
      massSilence: false,
      kickQueued: false,
    },
    /** Runs `promise` without awaiting it; a failure is logged, and settle() waits for it. */
    background(label, promise) {
      const task = Promise.resolve(promise).catch((err) => log.error("background.failed", { task: label, error: err?.message ?? String(err) }));
      tasks.add(task);
      task.finally(() => tasks.delete(task));
      return task;
    },
    /** Waits until no background work is left. */
    async settle() {
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
    /** Serves owner demand at once instead of at the next tick. */
    kick() {
      if (ctl.runtime.kickQueued) return;
      ctl.runtime.kickQueued = true;
      ctl.background("kick", (async () => {
        await Promise.resolve();
        ctl.runtime.kickQueued = false;
        await evaluateScaling(ctl);
      })());
    },
  };

  const started = (handler) => async (request) => {
    if (!ctl.ready) throw new HttpError(503, "STARTING", "The disk controller is starting.");
    if (!ctl.azure) throw new HttpError(503, "NOT_READY", "The disk controller has no scale set configured.");
    return handler(request);
  };
  const workerRoute = (path, handler) => ({ method: "POST", path, auth: "worker", vm: true, handler: started(handler) });
  const dispatcherRoute = (method, path, handler) => ({
    method,
    path,
    auth: "dispatcher",
    handler: async (request) => {
      const fields = {
        route: typeof path === "string" ? path : "/disk-pool/v1/owners/{ownerOid}/model-credential",
        workId: typeof request.body?.workId === "string" ? request.body.workId : null,
        owner: request.params?.ownerOid ?? (typeof request.body?.ownerOid === "string" ? request.body.ownerOid : null),
      };
      try {
        if (!ctl.ready) throw new HttpError(503, "STARTING", "The disk controller is starting.");
        const result = await handler(request);
        ctl.log.audit("dispatcher.call", { ...fields, status: result.status ?? 200, decision: result.body?.decision ?? null, code: result.body?.code ?? null });
        return result;
      } catch (err) {
        ctl.log.audit("dispatcher.call", { ...fields, status: err instanceof HttpError ? err.status : 500, code: err?.code ?? "INTERNAL" });
        throw err;
      }
    },
  });

  const workerRoutes = [
    workerRoute("/v1/vms/register", ({ vm }) => register(ctl, vm).then(ok)),
    workerRoute("/v1/vms/heartbeat", ({ vm, body }) => heartbeat(ctl, vm, body).then(ok)),
    workerRoute("/v1/vms/admit", ({ vm, body }) => admit(ctl, vm, body).then(ok)),
    workerRoute("/v1/vms/busy", ({ vm, body }) => busyRequest(ctl, vm, body).then(ok)),
    workerRoute("/v1/leases/attach", ({ vm, body }) => attach(ctl, vm, body).then(ok)),
    workerRoute("/v1/leases/detach", ({ vm, body }) => detach(ctl, vm, body).then(ok)),
    workerRoute("/v1/credentials/model", ({ vm, body }) => releaseModelToken(ctl, vm, body)),
    workerRoute("/v1/credentials/work", ({ vm, body }) => releaseWorkCredential(ctl, vm, body).then(ok)),
    {
      method: "POST",
      path: "/v1/admin/upgrade-freeze",
      auth: "admin",
      handler: async ({ body, caller }) => {
        if (!ctl.ready) throw new HttpError(503, "STARTING", "The disk controller is starting.");
        if (typeof body.frozen !== "boolean") throw new HttpError(400, "BAD_REQUEST", "frozen must be true or false.");
        return ok(await setFrozen(ctl, body.frozen, caller.oid));
      },
    },
    { method: "GET", path: "/v1/admin/upgrade-freeze", auth: "admin", handler: async () => ok(freezeStatus(ctl)) },
    { method: "GET", path: "/v1/admin/status", auth: "admin-only", handler: async () => ok(status()) },
  ];

  const dispatcherRoutes = [
    {
      method: "GET",
      path: "/disk-pool/v1/healthz",
      auth: "none",
      handler: async () => ({ status: ctl.ready ? 200 : 503 }),
    },
    dispatcherRoute("POST", "/disk-pool/v1/disks/claim", ({ body }) => claim(ctl, body).then(ok)),
    dispatcherRoute("POST", "/disk-pool/v1/disks/park", ({ body }) => park(ctl, body).then(ok)),
    dispatcherRoute("POST", "/disk-pool/v1/disks/sync-branch", ({ body }) => syncBranch(ctl, body).then(ok)),
    dispatcherRoute("POST", "/disk-pool/v1/disks/rebind", ({ body }) => rebind(ctl, body).then(ok)),
    dispatcherRoute("POST", "/disk-pool/v1/disks/return", ({ body }) => returnDrive(ctl, body).then(ok)),
    dispatcherRoute("POST", "/disk-pool/v1/disks/credential", ({ body }) => rotateCredential(ctl, body).then(ok)),
    dispatcherRoute(
      "GET",
      /^\/disk-pool\/v1\/owners\/(?<ownerOid>[^/]+)\/model-credential$/,
      ({ params }) => modelCredentialStatus(ctl, params.ownerOid).then(ok),
    ),
  ];

  const coordinationRoutes = [
    {
      method: "POST",
      path: "/v1/coordination/demand",
      auth: "coordinator",
      handler: async ({ body }) => {
        if (!ctl.ready) throw new HttpError(503, "STARTING", "The disk controller is starting.");
        return ok(await capacityRequest(ctl, body, { kind: "coordination" }));
      },
    },
  ];

  const common = { verifyToken, tokens: config.tokens, resolveVm: (address) => resolveVm(ctl, address), log };
  const apps = {
    worker: createApp({ name: "worker", routes: workerRoutes, ...common }),
    dispatcher: createApp({ name: "dispatcher", routes: dispatcherRoutes, ...common }),
    coordination: createApp({ name: "coordination", routes: coordinationRoutes, ...common }),
  };

  async function step(name, fn) {
    try {
      await fn();
    } catch (err) {
      ctl.log.error("tick.step-failed", { step: name, error: err?.message ?? String(err) });
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking || !ctl.ready || !ctl.azure) return;
    ticking = true;
    try {
      await step("azure", () => syncAzureView(ctl));
      await step("rollout", () => checkRollout(ctl));
      await step("crashes", () => checkCrashes(ctl));
      await step("fences", () => progressFences(ctl));
      await step("drains", () => progressDrains(ctl));
      await step("pool", () => maintainPool(ctl));
      await step("scaling", () => evaluateScaling(ctl));
    } finally {
      ticking = false;
    }
  }

  let refreshing = false;
  async function refreshTick() {
    if (refreshing || !ctl.ready) return;
    refreshing = true;
    try {
      await step("refresh", () => progressRefresh(ctl));
    } finally {
      refreshing = false;
    }
  }

  function status() {
    const c = controllerRecord(ctl);
    return {
      ready: ctl.ready,
      frozen: Boolean(c.upgradeFrozen),
      scaleSet: ctl.runtime.scaleSet ? { capacity: ctl.runtime.scaleSet.capacity } : null,
      goldenSnapshot: goldenSnapshotId(ctl),
      previousSnapshot: c.previousGolden?.id ?? null,
      refresh: c.refresh ? { id: c.refresh.id, phase: c.refresh.phase } : null,
      lastRefreshAt: c.lastRefreshAt ? new Date(c.lastRefreshAt).toISOString() : null,
      pendingScaleOuts: c.pending.map((entry) => ({ purpose: entry.purpose, ownerOid: entry.ownerOid ?? null })),
      unservedDemand: c.demand.map((entry) => ({ ownerOid: entry.ownerOid, rootSessionId: entry.rootSessionId, kind: entry.kind })),
      drives: ctl.state.all("disk").map((disk) => ({
        ...leaseView(disk),
        hydrated: Boolean(disk.hydrated),
        creating: Boolean(disk.creating),
        deleting: Boolean(disk.deleting),
        growth: disk.growth ? { targetGb: disk.growth.targetGb } : null,
        needsFsck: Boolean(disk.needsFsck),
        takeover: Boolean(disk.takeover),
      })),
      vms: ctl.state.all("vm").map((record) => {
        const rt = vmRuntime(ctl, record.name);
        return {
          name: record.name,
          role: record.role,
          ownerOid: record.ownerOid,
          activated: Boolean(record.activatedAt),
          draining: record.drain?.reason ?? null,
          fencing: record.fence?.reason ?? null,
          deleting: Boolean(record.deleting),
          stoppedForUpgrade: record.stoppedForUpgrade,
          phase: rt.phase,
          lastHeartbeatAt: rt.lastHeartbeatAt ? new Date(rt.lastHeartbeatAt).toISOString() : null,
          activeWorkloadCount: rt.activeWorkloadCount,
          // What the VM runs, and whether the controller replaces it once it is idle (a rollout):
          // null while the VM has sent no heartbeat since the controller started.
          imageVersion: ctl.runtime.azureVms.get(record.name)?.imageVersion ?? null,
          configVersion: rt.configVersion ?? null,
          outdated: isOutdated(ctl, record) || (ctl.config.configVersion && !rt.configVersion ? null : false),
        };
      }),
    };
  }

  let handles = [];
  return {
    ctl,
    apps,
    tick,
    refreshTick,
    status,
    /** Loads the state and the first Azure view; the listeners can answer from then on. */
    async start() {
      await ctl.state.load();
      ctl.startedAt = ctl.now();
      if (ctl.azure) {
        try {
          await syncAzureView(ctl);
        } catch (err) {
          ctl.log.error("controller.first-view-failed", { error: err?.message ?? String(err) });
        }
      }
      ctl.ready = true;
      ctl.log.info("controller.started", {
        scaleSet: config.scaleSet?.name ?? null,
        ownerOnly: config.vms.ownerOnly,
        maxVms: config.vms.max,
        minRunning: config.vms.minRunning,
        poolCount: config.drives.poolCount,
        graceMs: config.startupGraceMs,
      });
    },
    startTimers() {
      handles = [
        timers.setInterval(() => tick(), TIMING.tickMs),
        timers.setInterval(() => refreshTick(), REFRESH_CHECK_MS),
      ];
    },
    async stop() {
      for (const handle of handles) timers.clearInterval(handle);
      handles = [];
      ctl.ready = false;
      await ctl.settle();
    },
  };
}
