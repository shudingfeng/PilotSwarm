/**
 * The dispatcher-delegation opt-in on the direct management client: it reads
 * and writes the named user's flag (the local default user when none is
 * named) and accepts only a boolean.
 *
 * Run: node --test test/unit/management-dispatcher-delegation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";

function clientWithCatalog() {
    const calls = [];
    const flags = new Map();
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._catalog = {
        getUserDispatcherDelegation: async (principal) => {
            calls.push(["get", `${principal.provider}/${principal.subject}`]);
            return flags.get(`${principal.provider}/${principal.subject}`) === true;
        },
        setUserDispatcherDelegation: async (principal, enabled) => {
            calls.push(["set", `${principal.provider}/${principal.subject}`, enabled]);
            flags.set(`${principal.provider}/${principal.subject}`, enabled);
            return enabled;
        },
    };
    return { client, calls };
}

test("getMy/setMyDispatcherDelegation act on the named user, or the local default user", async () => {
    const { client, calls } = clientWithCatalog();
    const user = { provider: "entra", subject: "u-1" };
    assert.deepEqual(await client.getMyDispatcherDelegation(user), { enabled: false });
    assert.deepEqual(await client.setMyDispatcherDelegation(true, user), { enabled: true });
    assert.deepEqual(await client.getMyDispatcherDelegation(user), { enabled: true });
    assert.deepEqual(await client.setMyDispatcherDelegation(true), { enabled: true });
    assert.deepEqual(calls, [
        ["get", "entra/u-1"],
        ["set", "entra/u-1", true],
        ["get", "entra/u-1"],
        ["set", "local/default", true],
    ]);
});

test("setMyDispatcherDelegation accepts only true or false", async () => {
    const { client, calls } = clientWithCatalog();
    for (const value of ["true", 1, null, undefined]) {
        await assert.rejects(client.setMyDispatcherDelegation(value), (error) => error.code === "INVALID_REQUEST");
    }
    assert.deepEqual(calls, []);
});
