// The dispatcher-delegation switch: the portal's My Providers block and the
// TUI's Admin Console command share one controller path. The control exists
// only when the deployment names a dispatcher; turning delegation off asks
// first, because the dispatcher loses access to the work it runs.
import test from "node:test";
import assert from "node:assert/strict";
import {
    DISPATCHER_DELEGATION_OFF_WARNING,
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    selectAdminConsole,
} from "../src/index.js";

function makeController({ configured = true, enabled = false, transportOverrides = {} } = {}) {
    const calls = { reads: 0, writes: [] };
    let current = enabled;
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getMyDispatcherDelegation: async () => {
            calls.reads += 1;
            return { enabled: current, dispatcherConfigured: configured };
        },
        setMyDispatcherDelegation: async ({ enabled: next }) => {
            calls.writes.push(next);
            current = next;
            return { enabled: current, dispatcherConfigured: configured };
        },
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls };
}

const view = (store) => selectAdminConsole(store.getState()).modelProviders.dispatcherDelegation;

test("the control stays hidden until the deployment says it has a dispatcher", async () => {
    const { controller, store, calls } = makeController({ configured: false, enabled: true });
    assert.deepEqual(view(store), { available: false, enabled: false, saving: false, error: null });
    await controller.refreshDispatcherDelegation();
    assert.equal(view(store).available, false);
    await controller.toggleDispatcherDelegation();
    assert.deepEqual(calls.writes, [], "no write without a dispatcher");
    assert.match(store.getState().ui.statusText, /no dispatcher/);

    const legacy = makeController({ transportOverrides: { getMyDispatcherDelegation: undefined, setMyDispatcherDelegation: undefined } });
    assert.equal(await legacy.controller.refreshDispatcherDelegation(), null);
    assert.equal(view(legacy.store).available, false);
});

test("turning delegation on happens at once", async () => {
    const { controller, store, calls } = makeController();
    await controller.toggleDispatcherDelegation();
    assert.equal(calls.reads, 1, "loads the current state first");
    assert.deepEqual(calls.writes, [true]);
    assert.deepEqual(view(store), { available: true, enabled: true, saving: false, error: null });
    assert.equal(store.getState().ui.modal, null);
    assert.match(store.getState().ui.statusText, /delegation is on/);
});

test("turning delegation off warns and waits for confirmation", async () => {
    const { controller, store, calls } = makeController({ enabled: true });
    await controller.refreshDispatcherDelegation();
    await controller.toggleDispatcherDelegation();
    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "confirm");
    assert.equal(modal.action, "disableDispatcherDelegation");
    assert.equal(modal.message, DISPATCHER_DELEGATION_OFF_WARNING);
    assert.match(DISPATCHER_DELEGATION_OFF_WARNING, /loses access/);
    assert.deepEqual(calls.writes, [], "nothing changes before the confirmation");

    await controller.confirmModal();
    assert.deepEqual(calls.writes, [false]);
    assert.equal(view(store).enabled, false);
    assert.match(store.getState().ui.statusText, /cannot reach your sessions/);
});

test("a refused change keeps the old state and shows why", async () => {
    const { controller, store } = makeController({
        transportOverrides: { setMyDispatcherDelegation: async () => { throw new Error("database unavailable"); } },
    });
    await controller.refreshDispatcherDelegation();
    const outcome = await controller.setDispatcherDelegation(true);
    assert.deepEqual(outcome, { ok: false, error: "database unavailable" });
    assert.deepEqual(view(store), { available: true, enabled: false, saving: false, error: "database unavailable" });
});

test("opening the Admin Console loads the opt-in", async () => {
    const { controller, store, calls } = makeController({ enabled: true });
    await controller.openAdminConsole();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.reads, 1);
    assert.deepEqual(view(store), { available: true, enabled: true, saving: false, error: null });
});
