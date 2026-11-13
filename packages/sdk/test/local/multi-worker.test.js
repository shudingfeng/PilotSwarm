/**
 * Level 3: Multi-worker local topology tests.
 *
 * Purpose: verify behavior when two workers share the same store
 * and local session-state directory.
 *
 * Cases covered:
 *   - worker A starts a session, worker B can observe and later resume it
 *   - long wait started on worker A completes after worker A stops and worker B continues
 *   - session can resume from shared local sessionStateDir
 *   - filesystem-backed rehydration preserves conversation context across workers
 *   - multiple sessions spread across two workers
 *   - no duplicate execution of the same orchestration turn across workers
 *   - a forced delete ends a session tree whose orchestrations no worker runs,
 *     and a start that no worker has taken never runs
 *
 * Run: node --env-file=../../.env test/local/multi-worker.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { Client as DuroxideClient, PostgresProvider, Runtime } from "duroxide";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, withTwoWorkers, createManagementClient, PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { assert, assertEqual, assertIncludes, assertIncludesAny, assertGreaterOrEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, MEMORY_CONFIG } from "../helpers/fixtures.js";
import { createRuntimeFactStore } from "../helpers/fact-store-helpers.js";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FilesystemSessionStore, SessionManager } from "../../src/index.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../src/orchestration-registry.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const EXPECTED_ONE_WORD_ANSWERS = [
    ["2", "two", "Two"],
    ["4", "four", "Four"],
    ["6", "six", "Six"],
    ["8", "eight", "Eight"],
];

// ─── Test: Two Workers Observe Same Session ──────────────────────

async function testTwoWorkersObserveSession(env) {
    await withTwoWorkers(env, async (client, workerA, workerB) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        console.log("  Sending: What is the capital of France?");
        const response = await session.sendAndWait("What is the capital of France?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertIncludesAny(response, ["paris", "Paris"], "Capital of France");

        const v = await validateSessionAfterTurn(env, session.sessionId);
        console.log(`  [CMS] state=${v.cmsRow.state}, events=${v.events.length}, iter=${v.orchStatus.customStatus?.iteration}`);

        // Both workers share CMS — verify the session appears in CMS
        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assert(row !== null, "Session not found in CMS");
            console.log(`  CMS state: ${row.state}`);
            ("Two Workers Observe Same Session");
        } finally {
            await catalog.close();
        }
    });
}

// ─── Test: Session Survives Graceful Restart ─────────────────────

async function testSessionSurvivesGracefulRestart(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    // Phase 1: Start worker A, create session, run a turn
    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    let savedId;
    try {
        const session = await client.createSession(MEMORY_CONFIG);
        savedId = session.sessionId;

        console.log("  Phase 1: Worker A — establish memory");
        const r1 = await session.sendAndWait("Remember this exact code: X123", TIMEOUT);
        console.log(`  Turn 1 response: "${r1}"`);
        assert(r1 && r1.length > 0, "Turn 1 should produce a response on Worker A");
    } finally {
        await client.stop();
        await workerA.gracefulShutdown();
    }

    console.log("  Worker A gracefully shut down. Starting Worker B...");

    // Lifecycle protocol: turns commit version-named tars (<id>.v<N>.tar.gz)
    // referenced by meta.json, and graceful shutdown releases committed
    // sessions without touching the store — resolve through the store's own
    // exists() instead of hard-coding the legacy tar filename.
    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    const probeStore = new FilesystemSessionStore(archiveDir, env.sessionStateDir);
    console.log(`  Checking session snapshot exists in: ${archiveDir}`);
    assert(await probeStore.exists(savedId), "Expected a durable session snapshot after Worker A stop");

    // Phase 2: Start worker B, resume session, run another turn
    // Filesystem-backed session rehydration should preserve the Copilot session's
    // conversation state across workers in local mode.
    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const client2 = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client2.start();

    try {
        const resumed = await client2.resumeSession(savedId);

        console.log("  Phase 2: Worker B — recover remembered context");
        const r2 = await resumed.sendAndWait("What code did I ask you to remember?", TIMEOUT);
        console.log(`  Turn 2 response: "${r2}"`);
        assertIncludesAny(r2, ["X123", "x123"], "Recovered memory on Worker B");

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        ("Session Survives Graceful Restart");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Test: Multiple Sessions Across Two Workers ──────────────────

async function testMultipleSessionsTwoWorkers(env) {
    await withTwoWorkers(env, async (client) => {
        // Create 4 sessions — some will be handled by worker A, some by worker B
        const sessions = [];
        for (let i = 0; i < 4; i++) {
            const s = await client.createSession(ONEWORD_CONFIG);
            sessions.push(s);
        }

        console.log(`  Created ${sessions.length} sessions`);

        // Send a different question to each
        const questions = [
            "What is 1+1?",
            "What is 2+2?",
            "What is 3+3?",
            "What is 4+4?",
        ];
        for (let i = 0; i < sessions.length; i++) {
            console.log(`  Session ${i + 1}: ${questions[i]}`);
            const response = await sessions[i].sendAndWait(questions[i], TIMEOUT);
            console.log(`  Response ${i + 1}: "${response}"`);
            assertIncludesAny(response, EXPECTED_ONE_WORD_ANSWERS[i], `Session ${i + 1} response`);
        }

        // Verify all sessions appear in list
        const listed = await client.listSessions();
        for (const s of sessions) {
            assert(listed.some(l => l.sessionId === s.sessionId), `Session ${s.sessionId.slice(0, 8)} missing from list`);
        }

        ("Multiple Sessions Across Two Workers");
    });
}

// ─── Test: Worker Handoff After Stop ─────────────────────────────

async function testWorkerHandoffAfterStop(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    // Start worker A
    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    let savedId;
    try {
        const session = await client.createSession(MEMORY_CONFIG);
        savedId = session.sessionId;

        console.log("  Phase 1: Worker A — Turn 1");
        const r1 = await session.sendAndWait("What is 10+5?", TIMEOUT);
        console.log(`  Turn 1 response: "${r1}"`);
        assertIncludes(r1, "15", "Turn 1 correct on Worker A");
    } finally {
        await client.stop();
    }

    // Stop worker A (simulates crash/shutdown)
    await workerA.stop();
    console.log("  Worker A stopped.");

    // Start worker B + new client
    // The resumed session should be able to continue from shared local state.
    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "local-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const client2 = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client2.start();

    try {
        console.log("  Phase 2: Worker B — Turn 2");
        const resumed = await client2.resumeSession(savedId);
        const response = await resumed.sendAndWait("What is 7*8?", TIMEOUT);
        console.log(`  Response: "${response}"`);

        assertIncludes(response, "56", "Turn 2 correct on Worker B");

        const v = await validateSessionAfterTurn(env, savedId, { minIteration: 2 });
        console.log(`  [CMS] state=${v.cmsRow.state}, iter=${v.orchStatus.customStatus?.iteration}`);
        ("Worker Handoff After Stop");
    } finally {
        await client2.stop();
        await workerB.stop();
    }
}

// ─── Test: Turn 0 Resets Stale Stored Session ───────────────────

async function testTurnZeroResetsStaleStoredSession(env) {
    const fixedSessionId = "00000000-0000-4000-8000-000000000001";
    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    const store = new FilesystemSessionStore(archiveDir, env.sessionStateDir);
    const factStore = await createRuntimeFactStore(env);

    // Pre-seed stale Copilot session state without any orchestration/CMS history.
    const seedManager = new SessionManager(process.env.GITHUB_TOKEN, store, {}, env.sessionStateDir);
    seedManager.setFactStore(factStore);
    const stale = await seedManager.getOrCreate(fixedSessionId, MEMORY_CONFIG);
    const r1 = await stale.runTurn("Remember this exact code: STALE42");
    assertEqual(r1.type, "completed", "stale seed turn should complete");
    await seedManager.dehydrate(fixedSessionId, "seed");
    await seedManager.shutdown();
    await factStore.close();

    const archivePath = join(archiveDir, `${fixedSessionId}.tar.gz`);
    assert(existsSync(archivePath), "Expected seeded archive before turn-0 reset");

    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "turn-zero-reset",
        disableManagementAgents: true,
    });
    await worker.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    try {
        const session = await client.createSession({ ...MEMORY_CONFIG, sessionId: fixedSessionId });
        const response = await session.sendAndWait(
            'If I already told you a code earlier in this session, answer with just that code. Otherwise answer with just "UNKNOWN".',
            TIMEOUT,
        );
        console.log(`  Turn 0 reset response: "${response}"`);
        assert(!/STALE42/i.test(response), "Turn 0 must not reuse stale stored Copilot session state");
        assert(!existsSync(archivePath), "Turn 0 reset should purge the stale archive before creating a fresh session");
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Test: Turn 1+ Uses Lossy Replay Without Stored Session ─────

async function testTurnOneLossyReplaysWithoutStoredSession(env) {
    const commonOpts = {
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    const workerA = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "missing-state-a",
        disableManagementAgents: true,
    });
    await workerA.start();

    const clientA = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await clientA.start();

    let sessionId;
    try {
        const session = await clientA.createSession({
            systemMessage: {
                mode: "replace",
                content: "Do not call tools. Reply immediately with the exact requested acknowledgement text.",
            },
        });
        sessionId = session.sessionId;
        const response = await session.sendAndWait("Reply with exactly: TURN-ONE-READY", TIMEOUT);
        assert(response && response.length > 0, "Turn 1 response should exist before state deletion");
    } finally {
        await clientA.stop();
        await workerA.gracefulShutdown();
    }

    const archiveDir = join(dirname(env.sessionStateDir), "session-store");
    rmSync(join(archiveDir, `${sessionId}.tar.gz`), { force: true });
    rmSync(join(archiveDir, `${sessionId}.meta.json`), { force: true });
    rmSync(join(env.sessionStateDir, sessionId), { recursive: true, force: true });

    const workerB = new PilotSwarmWorker({
        ...commonOpts,
        githubToken: process.env.GITHUB_TOKEN,
        workerNodeId: "missing-state-b",
        disableManagementAgents: true,
    });
    await workerB.start();

    const clientB = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await clientB.start();

    try {
        const resumed = await clientB.resumeSession(sessionId);
        const response = await resumed.sendAndWait(
            "Do not call tools or wait. Reply immediately with exactly: LOSSY-REPLAY-READY",
            TIMEOUT,
        );
        assertIncludes(response, "LOSSY-REPLAY-READY", "turn 1+ should recover via lossy replay when no resumable session state exists");

        const catalog = await createCatalog(env);
        try {
            const row = await waitForSessionState(catalog, sessionId, ["idle"], 30_000);
            assertEqual(row?.lastError, null, "lossy replay should not leave a terminal lastError");
            const events = await catalog.getSessionEvents(sessionId);
            const lossyEvent = events.find((event) => event.eventType === "session.lossy_handoff");
            assertNotNull(lossyEvent, "missing-state recovery should record a lossy handoff event");
            assertEqual(lossyEvent.data?.cause, "missing_resumable_state_before_run_turn", "lossy event should explain the recovery cause");
        } finally {
            await catalog.close();
        }
    } finally {
        await clientB.stop();
        await workerB.stop();
    }
}

// ─── Tests: Sessions No Worker Runs ──────────────────────────────

const short = (id) => id.slice(0, 8);

async function waitUntil(check, what, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

/**
 * A client, a management client, the session catalog and duroxide, and no
 * worker. The fixture provider only stamps the sessions: no model is called.
 */
async function withoutWorker(env, fn) {
    const modelProvidersPath = await registerScriptedProvider(env, "http://127.0.0.1:9");
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        modelProvidersPath,
    });
    await client.start();
    const mgmt = await createManagementClient(env);
    const catalog = await createCatalog(env);
    const duroxide = new DuroxideClient(await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema));
    // A started session: its orchestration start is queued and its row says
    // running.
    const start = async (parentSessionId) => {
        const session = await client.createSession(parentSessionId ? { parentSessionId } : undefined);
        await session.send("Start.");
        return session.sessionId;
    };
    const rows = async () => new Map((await catalog.listSessionsPage({ limit: 100, includeDeleted: true }))
        .map((row) => [row.sessionId, row]));
    const orchestration = async (id) => (await duroxide.getStatus(`session-${id}`)).status;
    try {
        await fn({ mgmt, catalog, duroxide, start, rows, orchestration });
    } finally {
        await catalog.close();
        await mgmt.stop();
        await client.stop();
    }
}

/** Runs the session orchestrations but no activity, so no turn. */
async function startOrchestrationsOnly(env) {
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const runtime = new Runtime(provider, { workerTagFilter: "none" });
    for (const registration of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        runtime.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, registration.version, registration.handler);
    }
    await runtime.start();
    return runtime;
}

// ─── Test: Forced Delete Ends A Tree No Worker Runs ──────────────

async function testForcedDeleteEndsTreeNoWorkerRuns(env) {
    await withoutWorker(env, async ({ mgmt, catalog, start, rows, orchestration }) => {
        const root = await start();
        const target = await start(root);
        const sibling = await start(root);
        const child = await start(target);
        const grandchild = await start(child);
        const nephew = await start(sibling);

        // A worker takes every session and is gone before any turn: the
        // orchestrations wait for turns no worker runs, and a delete command
        // never settles.
        const runtime = await startOrchestrationsOnly(env);
        try {
            await waitUntil(async () => {
                for (const id of [root, target, sibling, child, grandchild, nephew]) {
                    if (await orchestration(id) !== "Running") return false;
                }
                return true;
            }, "every orchestration runs");
        } finally {
            await runtime.shutdown(5_000);
        }

        const expectKept = async (ids, when) => {
            const byId = await rows();
            for (const id of ids) {
                assertEqual(byId.get(id)?.deletedAt, null, `${when}: ${short(id)} is not deleted`);
                assertEqual(await orchestration(id), "Running", `${when}: ${short(id)} orchestration`);
            }
        };
        const expectDeleted = async (expected, when) => {
            const byId = await rows();
            for (const [id, lastError] of expected) {
                const row = byId.get(id);
                assert(row?.deletedAt, `${when}: ${short(id)} is soft-deleted`);
                assertEqual(row.state, "failed", `${when}: ${short(id)} state`);
                assertEqual(row.lastError, lastError, `${when}: ${short(id)} lastError`);
                assertEqual(await orchestration(id), "NotFound", `${when}: ${short(id)} orchestration`);
            }
        };

        // The child's orchestration instance can't be deleted once. The leaves
        // go first, so its own child is gone; it and the target stay.
        const reason = "Forced delete test";
        const ancestorGone = `Ancestor ${target} deleted: ${reason}`;
        const managed = mgmt._duroxideClient;
        const deleteInstance = managed.deleteInstance;
        let injected = false;
        managed.deleteInstance = async function (instanceId, force) {
            if (!injected && instanceId === `session-${child}`) {
                injected = true;
                throw new Error("injected: the instance store is unavailable");
            }
            return deleteInstance.call(this, instanceId, force);
        };
        try {
            const startedAt = Date.now();
            await assertThrows(
                () => mgmt.deleteSession(target, reason, { force: true, settleTimeoutMs: 2_000 }),
                `stopped at ${short(child)}: deleting its orchestration instance failed: injected`,
                "the first forced delete",
            );
            assert(Date.now() - startedAt >= 2_000, "the delete command was sent, and waited for, first");
        } finally {
            managed.deleteInstance = deleteInstance;
        }
        await expectDeleted([[grandchild, ancestorGone]], "after the failure");
        await expectKept([target, child, root, sibling, nephew], "after the failure");

        // A retry finishes the tree, without waiting for a command.
        await mgmt.deleteSession(target, reason, { force: true, settleTimeoutMs: 0 });
        await expectDeleted([[target, reason], [child, ancestorGone], [grandchild, ancestorGone]], "after the retry");
        await expectKept([root, sibling, nephew], "after the retry");

        // A cascade that failed on a child still soft-deletes the parent: the
        // sibling's row is gone, but its child and both orchestrations remain.
        // The forced delete finds the child through the rows' parent links.
        await catalog.softDeleteSession(sibling);
        await mgmt.deleteSession(sibling, reason, { force: true });
        await expectDeleted([[nephew, `Ancestor ${sibling} deleted: ${reason}`]], "under a soft-deleted parent");
        assertEqual(await orchestration(sibling), "NotFound", "the soft-deleted parent's orchestration");
        await expectKept([root], "the ancestor");
    });
}

// ─── Test: Forced Delete Of A Start No Worker Has Taken ──────────

async function testForcedDeleteOfStartNoWorkerTook(env) {
    await withoutWorker(env, async ({ mgmt, duroxide, start, rows, orchestration }) => {
        // Started while no worker runs: duroxide reports the queued starts as
        // NotFound, and its deleteInstance won't delete them.
        const root = await start();
        const child = await start(root);
        assertEqual(await orchestration(root), "NotFound", "a start no worker has taken");

        const reason = "Forced delete test";
        await mgmt.deleteSession(root, reason, { force: true });
        const byId = await rows();
        for (const [id, lastError] of [[root, reason], [child, `Ancestor ${root} deleted: ${reason}`]]) {
            assert(byId.get(id)?.deletedAt, `${short(id)} is soft-deleted`);
            assertEqual(byId.get(id).lastError, lastError, `${short(id)} lastError`);
        }

        // A worker that comes later ends both starts at once and runs no turn
        // of a deleted session.
        const runtime = await startOrchestrationsOnly(env);
        try {
            for (const id of [root, child]) {
                await waitUntil(async () => await orchestration(id) === "Failed", `${short(id)}'s start ends`);
                assertIncludes((await duroxide.getStatus(`session-${id}`)).error, "Session deleted", `${short(id)}'s start is cancelled`);
            }
            assertEqual((await duroxide.getQueueDepths()).workerQueue, 0, "no turn waits for a worker");
        } finally {
            await runtime.shutdown(5_000);
        }
    });
}

// ─── Runner ──────────────────────────────────────────────────────

describe("Level 3: Multi-Worker Tests", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Two Workers Observe Same Session", { timeout: TIMEOUT }, async () => {
        await testTwoWorkersObserveSession(getEnv());
    });
    it("Session Survives Graceful Restart", { timeout: TIMEOUT * 2 }, async () => {
        await testSessionSurvivesGracefulRestart(getEnv());
    });
    it("Multiple Sessions Across Two Workers", { timeout: TIMEOUT * 2 }, async () => {
        await testMultipleSessionsTwoWorkers(getEnv());
    });
    it("Worker Handoff After Stop", { timeout: TIMEOUT * 2 }, async () => {
        await testWorkerHandoffAfterStop(getEnv());
    });
    it("Turn 0 Resets Stale Stored Session", { timeout: TIMEOUT * 2 }, async () => {
        await testTurnZeroResetsStaleStoredSession(getEnv());
    });
    it("Turn 1+ Uses Lossy Replay Without Stored Session", { timeout: TIMEOUT * 2 }, async () => {
        await testTurnOneLossyReplaysWithoutStoredSession(getEnv());
    });
});

// No worker and no model: these tests need only PostgreSQL.
describe("Level 3: Sessions No Worker Runs", () => {
    it("Forced Delete Ends A Tree No Worker Runs", { timeout: TIMEOUT }, async () => {
        await testForcedDeleteEndsTreeNoWorkerRuns(getEnv());
    });
    it("Forced Delete Of A Start No Worker Has Taken", { timeout: TIMEOUT }, async () => {
        await testForcedDeleteOfStartNoWorkerTook(getEnv());
    });
});
