// The controller-wide record, `controller.json`: the upgrade freeze, the
// golden snapshot, the snapshot refresh and the drives of finished refresh
// runs still to delete, unserved demand, scale-outs that have not delivered a
// VM yet, the last scale-in step and the versions of the last rollout.
export function emptyController() {
  return {
    upgradeFrozen: false,
    frozenAt: null,
    golden: null,
    previousGolden: null,
    refresh: null,
    refreshDisks: [],
    lastRefreshAt: null,
    lastScaleInAt: 0,
    lastDemandAt: 0,
    demand: [],
    pending: [],
    rollout: null,
    poolFullSince: null,
  };
}

export function controllerRecord(ctl) {
  return { ...emptyController(), ...(ctl.state.get("controller", "controller") ?? {}) };
}

/** Applies `mutate` to the controller record (defaults filled in) and writes what it returns. */
export function updateController(ctl, mutate) {
  return ctl.state.update("controller", "controller", (current) => mutate({ ...emptyController(), ...(current ?? {}) }));
}

/** The snapshot new drives and resets copy: the last refresh's, or the configured one. */
export function goldenSnapshotId(ctl) {
  return controllerRecord(ctl).golden?.id ?? ctl.config.goldenSnapshotId ?? null;
}
