import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

function makeTransport({ currentUser } = {}) {
    const transport = new NodeSdkTransport({
        store: "sqlite::memory:",
        mode: "local",
        ...(currentUser ? { currentUser } : {}),
    });
    const calls = [];
    transport.mgmt = {
        getMyDispatcherDelegation: async (principal) => {
            calls.push(["get", principal]);
            return { enabled: true };
        },
        setMyDispatcherDelegation: async (enabled, principal) => {
            calls.push(["set", enabled, principal]);
            return { enabled };
        },
    };
    return { transport, calls };
}

function withDispatcherEnv(value, run) {
    const previous = process.env.DISPATCHER_SP_OBJECT_ID;
    if (value === undefined) delete process.env.DISPATCHER_SP_OBJECT_ID;
    else process.env.DISPATCHER_SP_OBJECT_ID = value;
    return Promise.resolve(run()).finally(() => {
        if (previous === undefined) delete process.env.DISPATCHER_SP_OBJECT_ID;
        else process.env.DISPATCHER_SP_OBJECT_ID = previous;
    });
}

test("the TUI's opt-in is its current user's, and the portal's is the principal it passes", async () => {
    await withDispatcherEnv(undefined, async () => {
        const { transport, calls } = makeTransport({ currentUser: { provider: "dev", subject: "alice" } });
        assert.deepEqual(await transport.setMyDispatcherDelegation({ enabled: false }), { enabled: false, dispatcherConfigured: false });
        assert.deepEqual(await transport.getMyDispatcherDelegation(), { enabled: true, dispatcherConfigured: false });
        await transport.setMyDispatcherDelegation({ enabled: true, principal: { provider: "entra", subject: "u-1", email: "u@example.test" } });
        assert.deepEqual(calls.map(([kind, ...args]) => [kind, ...args.map((arg) => (typeof arg === "object" ? `${arg.provider}/${arg.subject}` : arg))]), [
            ["set", false, "dev/alice"],
            ["get", "dev/alice"],
            ["set", true, "entra/u-1"],
        ]);
    });
});

test("dispatcherConfigured follows this host's DISPATCHER_SP_OBJECT_ID", async () => {
    await withDispatcherEnv("0b5e0c8a-1d2e-4f30-9a41-5c6d7e8f9a0b", async () => {
        const { transport } = makeTransport();
        assert.equal((await transport.getMyDispatcherDelegation()).dispatcherConfigured, true);
    });
    await withDispatcherEnv("   ", async () => {
        const { transport } = makeTransport();
        assert.equal((await transport.getMyDispatcherDelegation()).dispatcherConfigured, false);
    });
});
