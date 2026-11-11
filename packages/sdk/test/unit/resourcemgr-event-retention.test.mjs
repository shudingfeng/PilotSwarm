/**
 * The Resource Manager's purge_old_events keeps a deployment's event retention
 * floor (PILOTSWARM_EVENT_RETENTION_MINUTES). Unset, it purges as before: 24
 * hours by default and never under 60 minutes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResourceManagerTools, eventRetentionMinutesFromEnv } from "../../dist/resourcemgr-tools.js";
import { PilotSwarmWorker } from "../../dist/index.js";

function purgeTool(options = {}) {
    const cutoffs = [];
    const catalog = { pool: { query: async (_sql, params) => { cutoffs.push(params[0]); return { rowCount: 0 }; } } };
    const tool = createResourceManagerTools({ catalog, duroxideClient: null, blobStore: null, ...options })
        .find((candidate) => candidate.name === "purge_old_events");
    return { tool, cutoffs };
}

const minutesBefore = (cutoff) => Math.round((Date.now() - cutoff.getTime()) / 60_000);

test("without a retention setting, purges keep today's default and 60-minute floor", async () => {
    const { tool, cutoffs } = purgeTool();
    assert.equal((await tool.handler({})).olderThanMinutes, 1440);
    assert.equal((await tool.handler({ olderThanMinutes: 5 })).olderThanMinutes, 60);
    assert.equal((await tool.handler({ olderThanMinutes: 90 })).olderThanMinutes, 90);
    assert.equal(minutesBefore(cutoffs[2]), 90);
    assert.match(tool.description, /Minimum age: 60 minutes \(enforced\)\.$/);
    assert.equal(tool.parameters.properties.olderThanMinutes.description,
        "Delete events older than this many minutes. Default: 1440 (24h). Minimum: 60.");
});

test("a retention setting is a floor that no purge goes under, whatever the caller asks", async () => {
    const { tool, cutoffs } = purgeTool({ eventRetentionMinutes: 43_200 });
    assert.equal((await tool.handler({})).olderThanMinutes, 43_200);
    assert.equal((await tool.handler({ olderThanMinutes: 60 })).olderThanMinutes, 43_200);
    assert.equal((await tool.handler({ olderThanMinutes: 50_000 })).olderThanMinutes, 50_000);
    assert.equal(minutesBefore(cutoffs[1]), 43_200);
    assert.match(tool.description, /Minimum age: 43200 minutes/);
    assert.match(tool.parameters.properties.olderThanMinutes.description, /Default: 43200\. Minimum: 43200\.$/);
});

test("the setting is a positive whole number of minutes or unset, and a worker refuses anything else", (t) => {
    assert.equal(eventRetentionMinutesFromEnv(undefined), undefined);
    assert.equal(eventRetentionMinutesFromEnv(""), undefined);
    assert.equal(eventRetentionMinutesFromEnv(" 43200 "), 43_200);
    for (const bad of ["0", "-5", "1.5", "30d", "abc"]) {
        assert.throws(() => eventRetentionMinutesFromEnv(bad), /PILOTSWARM_EVENT_RETENTION_MINUTES must be a positive whole number/, bad);
    }

    const root = mkdtempSync(join(tmpdir(), "ps-event-retention-"));
    const saved = process.env.PILOTSWARM_EVENT_RETENTION_MINUTES;
    t.after(() => {
        if (saved === undefined) delete process.env.PILOTSWARM_EVENT_RETENTION_MINUTES;
        else process.env.PILOTSWARM_EVENT_RETENTION_MINUTES = saved;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.PILOTSWARM_EVENT_RETENTION_MINUTES = "30d";
    assert.throws(
        () => new PilotSwarmWorker({ store: "sqlite::memory:", disableManagementAgents: true, sessionStateDir: join(root, "sessions") }),
        /PILOTSWARM_EVENT_RETENTION_MINUTES/,
        "a worker refuses a value it can't read before it starts",
    );
});
