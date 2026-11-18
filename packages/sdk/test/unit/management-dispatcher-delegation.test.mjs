/**
 * The dispatcher-delegation opt-in on the direct management client: it reads
 * and writes the named user's flag (the local default user when none is
 * named) and accepts only a boolean. Its CMS migration is 0096, after
 * upstream's 0090 to 0095 (it was numbered 0090, then 0095, before they
 * shipped).
 *
 * Run: node --test test/unit/management-dispatcher-delegation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { dispatcherDelegationMigration } from "../../dist/migrations/dispatcher-delegation-0096.js";

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

test("the opt-in's migration is 0096, registered after upstream's 0090 to 0095", () => {
    const list = CMS_MIGRATIONS("s");
    assert.deepEqual(list.filter(item => item.version >= "0090").map(item => [item.version, item.name]), [
        ["0090", "workflow_carry"], ["0091", "workflow_approvals"], ["0093", "session_summary_title_guard"],
        ["0094", "session_resurrection"], ["0095", "canvas_ten_slots"], ["0096", "dispatcher_delegation"],
    ]);
    assert.equal(list.at(-1).sql, dispatcherDelegationMigration("s"));
    assert.equal(new Set(list.map(item => item.version)).size, list.length, "every version once");
});
