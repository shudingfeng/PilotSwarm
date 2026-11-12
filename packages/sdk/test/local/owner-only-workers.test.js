/**
 * Owner-only workers on PostgreSQL with Duroxide: a default worker and an
 * owner-only worker for one owner, in one process, with the real Copilot CLI
 * and the scripted model. The owner-only worker runs that owner's
 * session-scoped activities and every orchestration, and nothing else; the
 * default worker runs the rest.
 *
 * Each worker reaches the model through its own scripted endpoint, so every
 * model request shows which worker made it.
 *
 * Run: npx vitest run test/local/owner-only-workers.test.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { requestPosition, startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { patchSessionStartInput } from "../helpers/pinned-start.mjs";
import { PilotSwarmClient, PilotSwarmManagementClient, PilotSwarmWorker } from "../../src/index.ts";
import { WORKSPACE_RELEASE_CAP_MS } from "../../src/orchestration/state.ts";

const TIMEOUT = 300_000;
const SUBJECT = "6f1c2b0e-0a5d-4a8e-9c61-1b7f3c9d2a01";
const OWNER_TAG = `owner.${SUBJECT}`;
const OWNER = { provider: "test", subject: SUBJECT, displayName: "user a" };
const TITLE = "Owner only pair";
const TITLE_PROMPT = "Write a short, specific title";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, what, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
}

/** The worker that started each of a session's turns. */
async function turnWorkers(catalog, sessionId) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, ["session.turn_started"]);
    return events.map((e) => e.workerNodeId);
}

/** The worker that recorded each event of these types. */
async function eventWorkers(catalog, sessionId, eventTypes) {
    const events = await catalog.getSessionEvents(sessionId, undefined, 1000, eventTypes);
    return events.map((e) => [e.eventType, e.data?.cmd, e.workerNodeId].filter(Boolean).join(" "));
}

/** The activities a session's orchestration scheduled, in order, and whether each finished. */
async function activitiesOf(client, sessionId) {
    const duroxide = client._getDuroxideClient();
    const instanceId = `session-${sessionId}`;
    const activities = [];
    for (const executionId of await duroxide.listExecutions(instanceId).catch(() => [])) {
        const history = await duroxide.readExecutionHistory(instanceId, executionId);
        const finished = new Set(history.filter((e) => /^Activity(Completed|Failed)$/.test(e.kind)).map((e) => e.sourceEventId));
        for (const e of history) {
            if (e.kind !== "ActivityScheduled") continue;
            activities.push({ name: /^\{"name":"([^"]+)"/.exec(e.data ?? "")?.[1], done: finished.has(e.eventId) });
        }
    }
    return activities;
}

const unfinished = (activities) => activities.filter((a) => !a.done).map((a) => a.name);

/** The session-scoped activities that carry an owner-tagged session's owner tag. */
const OWNER_TAGGED = new Set([
    "runTurnV5", "runTurnEpochV5", "hydrateSession", "dehydrateSession", "needsHydrationSession",
    "checkpointSession", "abortTurn", "checkWorkspace", "releaseWorkspace", "destroySession",
]);

/** Which conversation a model request belongs to, from its first prompt. */
function conversation(record) {
    const text = record.position.firstUserText;
    if (text.includes(TITLE_PROMPT)) return "title";
    if (text.includes("child-task")) return "child";
    if (text.includes("spawn the child")) return "user";
    if (text.includes("system hello")) return "system";
    return "other";
}

describe("owner-only workers", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("runs a user's turns and its spawned child only on the owner-only worker, and the title, the system session, capacity requests and manager activities only on the default worker; a delete ends at once on the owner's worker", async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            const text = position.lastUserText;
            if (text.includes(TITLE_PROMPT)) return { content: TITLE };
            if (text.includes("child-task")) return { content: "child done" };
            if (text.includes("spawn the child")) {
                return position.step === 0
                    ? { tools: [{ name: "spawn_agent", args: { task: "child-task: say hi" } }] }
                    : { content: "spawned" };
            }
            return { content: `ok:${text.slice(0, 24)}` };
        };
        const respondAuxiliary = (body) => ({ content: requestPosition(body).lastUserText.includes(TITLE_PROMPT) ? TITLE : "Fixture title" });
        const models = {};
        const workers = new Map();
        const requests = [];
        let client;
        let mgmt;
        let catalog;
        try {
            models.default = await startScriptedModel({ respond, respondAuxiliary });
            models["owner-a"] = await startScriptedModel({ respond, respondAuxiliary });
            const stores = { store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema };
            const providersPath = {
                default: await registerScriptedProvider(env, models.default.baseUrl),
                "owner-a": path.join(env.baseDir, `model-providers.owner-only-${env.runId}.json`),
            };
            const providers = JSON.parse(fs.readFileSync(providersPath.default, "utf8"));
            providers.providers[0].baseUrl = models["owner-a"].baseUrl;
            fs.writeFileSync(providersPath["owner-a"], JSON.stringify(providers, null, 2));

            // Both workers have a capacity requester: only the default worker
            // may take capacity requests.
            const startWorker = async (id, options = {}) => {
                const worker = new PilotSwarmWorker({
                    ...stores,
                    modelProvidersPath: providersPath[id],
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
                workers.set(id, worker);
            };
            const stopWorker = async (id) => {
                await workers.get(id).stop();
                workers.delete(id);
            };

            client = new PilotSwarmClient({ ...stores, modelProvidersPath: providersPath.default, ownerRouting: true });
            mgmt = new PilotSwarmManagementClient({ ...stores, modelProvidersPath: providersPath.default });
            catalog = await createCatalog(env);

            // 1. The default worker alone runs the system session and the
            // manager activities before the user's turn, which waits for a
            // worker of its owner.
            await startWorker("default");
            await client.start();
            await mgmt.start();
            const user = await client.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, owner: OWNER });
            // The first title comes a minute after the first turn; start the
            // session as one whose title is due, as a continue-as-new would.
            const titleDue = patchSessionStartInput(client, (input) => ({ ...input, nextSummarizeAt: 1 }), { sessionId: user.sessionId });
            try {
                await user.send("spawn the child");
            } finally {
                titleDue.restore();
            }
            expect(titleDue.starts).toHaveLength(1);
            const system = await client.createSystemSession({ title: "Owner-only check" });
            expect(await system.sendAndWait("system hello", TIMEOUT)).toContain("ok:");
            await waitForSessionState(catalog, system.sessionId, ["idle"], 120_000);
            await eventually(async () => (await activitiesOf(client, user.sessionId)).some((a) => a.name === "runTurnV5"), "the user's turn");
            const beforeTurn = await activitiesOf(client, user.sessionId);
            expect(unfinished(beforeTurn)).toEqual(["runTurnV5"]);
            expect(beforeTurn.map((a) => a.name)).toEqual(expect.arrayContaining(["getWorkerSessionPolicy", "requestOwnerCapacity", "loadKnowledgeIndex"]));
            expect(await turnWorkers(catalog, user.sessionId)).toEqual([]);

            // 2. The owner-only worker alone runs the user's turn, which spawns
            // the child through the spawn_agent tool, and every orchestration
            // up to an activity it must not run: a manager activity, a
            // capacity request, or one of Duroxide's system activities behind
            // ctx.utcNow() and ctx.newGuid(), which are untagged too. The
            // title, the child's turn and the system session's next turn wait.
            await stopWorker("default");
            await startWorker("owner-a", { ownerTag: OWNER_TAG, ownerOnly: true });
            const childId = await eventually(async () => {
                const events = await catalog.getSessionEvents(user.sessionId, undefined, 1000, ["session.agent_spawned"]);
                return events[0]?.data?.childSessionId;
            }, "the spawned child");
            await system.send("system again");
            const sessions = { user: user.sessionId, child: childId, system: system.sessionId };
            const waiting = {};
            for (const [who, sessionId] of Object.entries(sessions)) {
                waiting[who] = await eventually(async () => {
                    const names = unfinished(await activitiesOf(client, sessionId));
                    return names.length > 0 && names.every((name) => !OWNER_TAGGED.has(name)) ? names : null;
                }, `the ${who} session's orchestration`);
            }
            await sleep(3_000);
            // The clock read after the user's turn, the child's capacity
            // request before its first turn, and the system session's
            // knowledge index before its next turn.
            expect(waiting).toEqual({
                user: ["__duroxide_syscall:utc_now_ms"],
                child: ["requestOwnerCapacity"],
                system: ["loadKnowledgeIndex"],
            });
            for (const [who, sessionId] of Object.entries(sessions)) {
                expect(unfinished(await activitiesOf(client, sessionId)), who).toEqual(waiting[who]);
            }
            expect((await activitiesOf(client, user.sessionId)).filter((a) => a.name === "runTurnV5").map((a) => a.done)).toEqual([true]);
            expect(await turnWorkers(catalog, user.sessionId)).toEqual(["owner-a"]);
            expect(await turnWorkers(catalog, childId)).toEqual([]);
            expect(await turnWorkers(catalog, system.sessionId)).toEqual(["default"]);
            expect(requests.map((r) => r.worker)).toEqual(["default"]);
            expect((await catalog.getSession(user.sessionId)).title).not.toBe(TITLE);

            // 3. With both workers, the waiting work runs on the default
            // worker and the child's turn on the owner-only worker.
            await startWorker("default");
            await eventually(async () => (await catalog.getSession(user.sessionId))?.title === TITLE, "the title");
            await eventually(async () => (await turnWorkers(catalog, childId)).length >= 1, "the child's turn");
            await waitForSessionState(catalog, childId, ["idle"], 120_000);
            await waitForSessionState(catalog, user.sessionId, ["idle"], 120_000);

            // 4. Completing the child and deleting the user session end at
            // once: the owner-only worker, which holds them, runs their destroy.
            await mgmt.completeSession(childId, "done before the delete");
            const startedAt = Date.now();
            await mgmt.deleteSession(user.sessionId, "deleted on the owner's worker");
            const deleteMs = Date.now() - startedAt;
            console.log(`  delete took ${deleteMs} ms`);
            expect(deleteMs).toBeLessThan(WORKSPACE_RELEASE_CAP_MS);
            for (const sessionId of [user.sessionId, childId]) {
                expect((await activitiesOf(client, sessionId)).filter((a) => a.name === "destroySession").map((a) => a.done)).toEqual([true]);
            }
            expect(await eventWorkers(catalog, user.sessionId, ["session.agent_spawned", "session.command_received", "session.command_completed"])).toEqual([
                "session.agent_spawned owner-a",
                "session.command_received delete default",
                "session.command_completed delete default",
            ]);

            await eventually(async () => (await turnWorkers(catalog, system.sessionId)).length >= 2, "the system session's second turn");
            await waitForSessionState(catalog, system.sessionId, ["idle"], 120_000);
            expect(new Set(await turnWorkers(catalog, user.sessionId))).toEqual(new Set(["owner-a"]));
            expect(new Set(await turnWorkers(catalog, childId))).toEqual(new Set(["owner-a"]));
            expect(await turnWorkers(catalog, system.sessionId)).toEqual(["default", "default"]);

            // Every capacity request ran on the default worker, never on the
            // owner-only worker, though it has a requester too.
            expect(requests.every((r) => r.worker === "default")).toBe(true);
            expect(requests.map((r) => r.request)).toEqual(expect.arrayContaining([
                { sessionId: user.sessionId, rootSessionId: user.sessionId, ownerTag: OWNER_TAG },
                { sessionId: childId, rootSessionId: user.sessionId, ownerTag: OWNER_TAG },
            ]));

            // The model requests of each worker: the owner-only worker made the
            // user's and the child's, the default worker the title and the
            // system session's.
            const madeBy = (id) => new Set(models[id].requests.map(conversation));
            expect(madeBy("owner-a")).toEqual(new Set(["user", "child"]));
            expect(madeBy("default")).toEqual(new Set(["title", "system"]));
        } finally {
            await mgmt?.stop().catch(() => {});
            await client?.stop().catch(() => {});
            for (const worker of [...workers.values()].reverse()) await worker.stop().catch(() => {});
            await catalog?.close?.();
            for (const model of Object.values(models)) await model.close();
        }
    }, TIMEOUT);
});
