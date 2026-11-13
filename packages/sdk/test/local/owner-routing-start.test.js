/**
 * Owner routing at start, on PostgreSQL with PilotSwarm workers: the client
 * that starts a session copies the owner tag saved with its creation config,
 * on whichever process receives the first message and whatever that
 * process's own settings. A session saved without a tag gets none, even from
 * a process with PILOTSWARM_OWNER_ROUTING=1, which only the portal reads.
 *
 * The workers run the real Copilot CLI and the scripted model, so it needs no
 * model token.
 *
 * Run: npx vitest run test/local/owner-routing-start.test.js
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../../src/index.ts";

const TIMEOUT = 300_000;
const SUBJECT = "6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01";
const TAG = `owner.${SUBJECT}`;
const OWNER = { provider: "test", subject: SUBJECT, displayName: "user a" };
const ROUTING_SETTINGS = ["PILOTSWARM_OWNER_ROUTING", "PILOTSWARM_WORKSPACE_BUSY_FAST_RELEASE"];

/** The input of each of a session's executions, from Duroxide's history. */
async function executionInputs(client, sessionId) {
    const duroxide = client._getDuroxideClient();
    const instanceId = `session-${sessionId}`;
    const inputs = [];
    for (const executionId of await duroxide.listExecutions(instanceId)) {
        const history = await duroxide.readExecutionHistory(instanceId, executionId);
        const started = history.find((e) => /Orchestrat.*Started/.test(e.kind) && e.data);
        const payload = JSON.parse(started.data);
        inputs.push(typeof payload.input === "string" ? JSON.parse(payload.input) : payload.input);
    }
    return inputs;
}

/** The worker that started each of a session's turns. */
async function turnWorkers(catalog, sessionId) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.turn_started"]);
    return events.map((e) => e.workerNodeId);
}

describe("owner routing at start", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("copies the stored owner tag on a process with no owner routing setting, and derives none for a session saved without one", async () => {
        const env = getEnv();
        const saved = Object.fromEntries(ROUTING_SETTINGS.map((name) => [name, process.env[name]]));
        for (const name of ROUTING_SETTINGS) delete process.env[name];
        const model = await startScriptedModel({ respond: (_body, position) => ({ content: `ok:${position.lastUserText.slice(0, 24)}` }) });
        const workers = [];
        const clients = [];
        const requests = [];
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
            const startWorker = async (id, options, requester) => {
                const worker = new PilotSwarmWorker({
                    ...stores,
                    sessionStateDir: env.sessionStateDir,
                    workerNodeId: id,
                    disableManagementAgents: true,
                    logLevel: "error",
                    ...options,
                });
                if (requester) {
                    worker.setOwnerCapacityRequester(async (request) => {
                        requests.push({ worker: id, ...request });
                        return { decision: "ok" };
                    });
                }
                await worker.start();
                workers.push(worker);
            };
            const startClient = async () => {
                const client = new PilotSwarmClient(stores);
                await client.start();
                clients.push(client);
                return client;
            };
            // A worker with the capacity requester, as the coordination host, and one of the owner's.
            await startWorker("coordinator", {}, true);
            await startWorker("owner-a", { ownerTag: TAG }, false);
            catalog = await createCatalog(env);

            // The process that creates the sessions saves the tag, as the portal does for a dispatcher's delegated creation.
            const creator = await startClient();
            const routed = await creator.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, owner: OWNER, ownerTag: TAG });
            const plain = await creator.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, owner: OWNER });
            const plainToo = await creator.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, owner: OWNER });

            // Another process, with no owner routing setting, receives the first messages.
            const starter = await startClient();
            expect(await (await starter.resumeSession(routed.sessionId)).sendAndWait("hello routed", TIMEOUT)).toContain("ok:");
            expect(await (await starter.resumeSession(plain.sessionId)).sendAndWait("hello plain", TIMEOUT)).toContain("ok:");
            // A process with the portal's setting tags nothing at start either.
            process.env.PILOTSWARM_OWNER_ROUTING = "1";
            const withSetting = await startClient();
            expect(await (await withSetting.resumeSession(plainToo.sessionId)).sendAndWait("hello again", TIMEOUT)).toContain("ok:");

            const [routedInput] = await executionInputs(starter, routed.sessionId);
            expect(routedInput.ownerTag).toBe(TAG);
            expect(routedInput).not.toHaveProperty("workspaceBusyFastRelease");
            expect(await turnWorkers(catalog, routed.sessionId)).toEqual(["owner-a"]);
            const asked = requests.filter((r) => r.sessionId === routed.sessionId);
            expect(asked[0]).toEqual({ worker: "coordinator", sessionId: routed.sessionId, rootSessionId: routed.sessionId, ownerTag: TAG });
            expect(asked.every((r) => r.worker === "coordinator")).toBe(true);
            for (const session of [plain, plainToo]) {
                const [input] = await executionInputs(starter, session.sessionId);
                expect(input).not.toHaveProperty("ownerTag");
                expect(input).not.toHaveProperty("workspaceBusyFastRelease");
                expect(requests.some((r) => r.sessionId === session.sessionId)).toBe(false);
            }
        } finally {
            for (const client of clients.reverse()) await client.stop().catch(() => {});
            for (const worker of workers.reverse()) await worker.stop().catch(() => {});
            await catalog?.close?.();
            await model.close();
            for (const name of ROUTING_SETTINGS) {
                if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
            }
        }
    }, TIMEOUT);
});
