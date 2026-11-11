/**
 * PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC: the idle hold of the client the
 * portal and terminal UI build (its `dehydrateOnIdle`). Unset, the client
 * gets no value and keeps its own default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "pilotswarm-sdk";
import { NodeSdkTransport, defaultIdleTimeoutSecFromEnv } from "../src/node-sdk-transport.js";

const KEY = "PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC";

function setEnv(t, value) {
    const saved = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    t.after(() => {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    });
}

/** The options the transport's start() gives its PilotSwarmClient, without a database. */
async function clientOptions(t) {
    const start = PilotSwarmClient.prototype.start;
    PilotSwarmClient.prototype.start = async function () {};
    t.after(() => { PilotSwarmClient.prototype.start = start; });
    const transport = new NodeSdkTransport({ store: "sqlite::memory:", mode: "remote" });
    transport.mgmt = { start: async () => {} };
    await transport.start();
    return transport.client.config;
}

test("unset, the client is built without dehydrateOnIdle, as before", async (t) => {
    setEnv(t, undefined);
    const options = await clientOptions(t);
    assert.equal("dehydrateOnIdle" in options, false);
});

test("set, the client gets it as dehydrateOnIdle", async (t) => {
    setEnv(t, "600");
    const options = await clientOptions(t);
    assert.equal(options.dehydrateOnIdle, 600);
});

test("the setting is a positive whole number of seconds, and the transport refuses anything else", (t) => {
    assert.equal(defaultIdleTimeoutSecFromEnv(undefined), undefined);
    assert.equal(defaultIdleTimeoutSecFromEnv(""), undefined);
    assert.equal(defaultIdleTimeoutSecFromEnv(" 600 "), 600);
    for (const bad of ["0", "-1", "1.5", "10m", "abc"]) {
        assert.throws(() => defaultIdleTimeoutSecFromEnv(bad), /PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC must be a positive whole number of seconds/, bad);
    }
    setEnv(t, "10m");
    assert.throws(() => new NodeSdkTransport({ store: "sqlite::memory:", mode: "remote" }), /PILOTSWARM_DEFAULT_IDLE_TIMEOUT_SEC/);
});
