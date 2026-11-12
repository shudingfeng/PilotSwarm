/**
 * PilotSwarm workers for owner-routing tests, with the real Copilot CLI and
 * the scripted model: a client and a management client with default settings,
 * and workers that a test starts and stops by name. A session is owner-routed
 * by the tag stored in its creation config (`client.createSession({ ownerTag })`,
 * plus `workspaceBusyFastRelease: true` for the fast busy policy), which is
 * what the starting client copies into the orchestration input.
 *
 * `startWorker(id, { requester: true })` gives the worker a capacity requester
 * that records each request and its time and answers `capacity(request)`
 * (default ok), as the coordination host does.
 */
import { PilotSwarmClient, PilotSwarmManagementClient, PilotSwarmWorker } from "../../src/index.ts";
import { createCatalog } from "./cms-helpers.js";
import { startScriptedModel } from "./scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "./scripted-workers.js";

const SUBJECT = {
    a: "6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01",
    b: "9d2e4c71-3b6a-4f0d-8e25-5c8a1f6b7e02",
    c: "2a7b9e13-6c4d-4b1f-a3e8-7d5c0f9b4e03",
};
export const OWNER_TAG = Object.fromEntries(Object.entries(SUBJECT).map(([who, subject]) => [who, `owner.${subject}`]));
export const ownerOf = (who) => ({ provider: "test", subject: SUBJECT[who], displayName: `user ${who}` });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function eventually(check, what, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
}

export async function withOwnerCluster(env, { respond, respondAuxiliary, capacity }, fn) {
    const model = await startScriptedModel({ respond, respondAuxiliary });
    const requests = [];
    const workers = new Map();
    let client;
    let mgmt;
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
        async function startWorker(id, { requester = false, ...options } = {}) {
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
                    requests.push({ worker: id, request, at: Date.now() });
                    return capacity ? capacity(request) : { decision: "ok" };
                });
            }
            await worker.start();
            workers.set(id, worker);
            return worker;
        }
        async function stopWorker(id) {
            await workers.get(id)?.stop();
            workers.delete(id);
        }
        client = new PilotSwarmClient(stores);
        mgmt = new PilotSwarmManagementClient(stores);
        catalog = await createCatalog(env);
        await fn({
            startWorker,
            stopWorker,
            startClients: async () => { await client.start(); await mgmt.start(); },
            client,
            mgmt,
            catalog,
            model,
            requests,
            asked: (sessionId) => requests.filter((r) => r.request.sessionId === sessionId),
            qualifiedModel: FIXTURE_QUALIFIED_MODEL,
        });
    } finally {
        await mgmt?.stop().catch(() => {});
        await client?.stop().catch(() => {});
        for (const worker of [...workers.values()].reverse()) await worker.stop().catch(() => {});
        await catalog?.close?.();
        await model.close();
    }
}

/** The worker that started each of a session's turns. */
export async function turnWorkers(catalog, sessionId) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.turn_started"]);
    return events.map((e) => e.workerNodeId);
}

/** The events of a session orchestration's history, every execution. */
export async function sessionHistory(client, sessionId) {
    const duroxide = client._getDuroxideClient();
    const instanceId = `session-${sessionId}`;
    const events = [];
    for (const executionId of await duroxide.listExecutions(instanceId).catch(() => [])) {
        events.push(...await duroxide.readExecutionHistory(instanceId, executionId));
    }
    return events;
}

/** The name of an ActivityScheduled event's activity. Its data is not always valid JSON past the name. */
export function activityName(event) {
    return /^\{"name":"([^"]+)"/.exec(event.data ?? "")?.[1];
}

/** The activities a session's orchestration scheduled, in order. */
export async function scheduledActivities(client, sessionId) {
    return (await sessionHistory(client, sessionId))
        .filter((e) => e.kind === "ActivityScheduled")
        .map(activityName);
}

/** The input of each of a session's executions. */
export async function executionInputs(client, sessionId) {
    return (await sessionHistory(client, sessionId))
        .filter((e) => /Orchestrat.*Started/.test(e.kind) && e.data)
        .map((e) => {
            const input = JSON.parse(e.data).input;
            return typeof input === "string" ? JSON.parse(input) : input;
        });
}
