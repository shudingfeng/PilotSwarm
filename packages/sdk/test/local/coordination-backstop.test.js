/**
 * Owner routing's backstop on PostgreSQL with Duroxide, PilotSwarm workers,
 * the real Copilot CLI and the scripted model, so it needs no model token. A
 * worker with a capacity requester, as the coordination host has, refuses
 * without a retry a turn of a session whose creation config holds an owner
 * tag that the turn's input lacks. An untagged session runs there, and a
 * session whose turns carry its saved tag runs on its owner's worker.
 *
 * Run: npx vitest run test/local/coordination-backstop.test.js
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { patchSessionStartInput } from "../helpers/pinned-start.mjs";
import { PilotSwarmClient, PilotSwarmWorker } from "../../src/index.ts";
import { ownerTagMissingText } from "../../src/owner-routing.ts";

const TIMEOUT = 300_000;
const TAG = "owner.6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01";
/** Longer than the first retry of a turn that returned an error (15 s). */
const RETRY_WINDOW_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The worker that started each of a session's turns. */
async function turnWorkers(catalog, sessionId) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.turn_started"]);
    return events.map((e) => e.workerNodeId);
}

/** How many turn activities a session's orchestration scheduled, over all its executions. */
async function scheduledTurns(client, sessionId) {
    const duroxide = client._getDuroxideClient();
    const instanceId = `session-${sessionId}`;
    let count = 0;
    for (const executionId of await duroxide.listExecutions(instanceId)) {
        const history = await duroxide.readExecutionHistory(instanceId, executionId);
        // The history elides large activity inputs, so the event's data is matched, not parsed.
        count += history.filter((e) => e.kind === "ActivityScheduled" && /"name":"runTurn/.test(String(e.data))).length;
    }
    return count;
}

describe("owner routing's backstop on a worker with a capacity requester", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("refuses without a retry a turn started without the session's saved owner tag; untagged sessions and matching tags run", async () => {
        const env = getEnv();
        const model = await startScriptedModel({ respond: (_body, position) => ({ content: `ok:${position.lastUserText.slice(0, 24)}` }) });
        const workers = [];
        const requests = [];
        let client;
        let catalog;
        try {
            const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
            const stores = {
                store: env.store,
                duroxideSchema: env.duroxideSchema,
                cmsSchema: env.cmsSchema,
                factsSchema: env.factsSchema,
                modelProvidersPath,
            };
            const startWorker = async (id, options = {}) => {
                const worker = new PilotSwarmWorker({
                    ...stores,
                    sessionStateDir: env.sessionStateDir,
                    workerNodeId: id,
                    disableManagementAgents: true,
                    logLevel: "error",
                    ...options,
                });
                worker.setOwnerCapacityRequester(async (request) => {
                    requests.push({ worker: id, request });
                    return { decision: "ok" };
                });
                await worker.start();
                workers.push(worker);
            };
            // The coordination host: no owner tag, so it claims every untagged turn.
            await startWorker("host");
            // The owner's worker claims only the owner's activities, as a bound
            // VM does. With a requester too, it checks the turns it runs.
            await startWorker("owner-a", { ownerTag: TAG, ownerOnly: true });
            client = new PilotSwarmClient(stores);
            await client.start();
            catalog = await createCatalog(env);

            // A client that doesn't copy the saved tag starts the session.
            const strippedId = randomUUID();
            const strip = patchSessionStartInput(client, ({ ownerTag: _dropped, ...input }) => input, { sessionId: strippedId });
            let refusedAt;
            try {
                const stripped = await client.createSession({ sessionId: strippedId, model: FIXTURE_QUALIFIED_MODEL, ownerTag: TAG });
                await stripped.send("a turn that would run off its owner's workers");
                const row = await waitForSessionState(catalog, strippedId, ["error"], 120_000);
                refusedAt = Date.now();
                // Only the refusal that is not retried writes this error: a retried one writes none before its last attempt.
                expect(row.lastError).toBe(ownerTagMissingText(undefined));
            } finally {
                strip.restore();
            }
            expect(strip.starts.map((s) => "ownerTag" in s.input)).toEqual([false]);
            expect(await catalog.getSessionCreationConfig(strippedId)).toMatchObject({ ownerTag: TAG });

            // An untagged session runs on the host.
            const untagged = await client.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL });
            expect(await untagged.sendAndWait("hello from an untagged session", TIMEOUT)).toContain("ok:");
            expect(await turnWorkers(catalog, untagged.sessionId)).toEqual(["host"]);
            expect(await scheduledTurns(client, untagged.sessionId)).toBe(1);

            // A session whose turns carry its saved tag runs on its owner's worker.
            const tagged = await client.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, ownerTag: TAG });
            expect(await tagged.sendAndWait("hello from the owner's session", TIMEOUT)).toContain("ok:");
            expect(await turnWorkers(catalog, tagged.sessionId)).toEqual(["owner-a"]);
            expect(requests).toEqual([{ worker: "host", request: { sessionId: tagged.sessionId, rootSessionId: tagged.sessionId, ownerTag: TAG } }]);

            // The refused turn was never retried, and never reached the model.
            await sleep(Math.max(0, refusedAt + RETRY_WINDOW_MS - Date.now()));
            expect(await scheduledTurns(client, strippedId)).toBe(1);
            expect(await turnWorkers(catalog, strippedId)).toEqual([]);
            expect(model.sessionRequests("would run off its owner's workers")).toHaveLength(0);
        } finally {
            await client?.stop().catch(() => {});
            for (const worker of workers.reverse()) await worker.stop().catch(() => {});
            await catalog?.close?.();
            await model.close();
        }
    }, TIMEOUT);
});
