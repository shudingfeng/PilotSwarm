/**
 * External personal secrets in the runTurn activity, with the session
 * manager and the catalog stubbed (the session-proxy-events harness): the
 * turn's key is resolved before anything is created, a busy answer returns
 * the busy-workspace wait, a refusal and an outage return errors the
 * orchestration ends or retries, a model 401 drops the cached key, and the
 * stored turn result is redacted. Needs no database and no model.
 *
 * Run: npx vitest run test/local/personal-credential-turn.test.js
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerActivities } from "../../src/session-proxy.ts";
import { PersonalCredentialError } from "../../src/personal-secret-store.ts";

const CLASSIC = `ghp_${"b".repeat(36)}`;

function makeHarness({ credential, turnResult } = {}) {
    const handlers = {};
    const session = {
        abort: vi.fn(),
        runTurn: vi.fn(async () => turnResult ?? { type: "completed", content: "ok", events: [] }),
    };
    const sessionManager = {
        withRunTurnLock: vi.fn(async (_sessionId, _operation, fn) => await fn()),
        refreshModelProviders: vi.fn(async () => {}),
        normalizeModelRef: vi.fn((model) => model),
        preparePersonalCredential: vi.fn(async () => {
            if (credential) throw credential;
        }),
        forgetPersonalCredential: vi.fn(),
        getOrCreate: vi.fn(async () => session),
        getModelSummary: vi.fn(() => undefined),
        getWorkspaceProvider: vi.fn(() => null),
        invalidateWarmSession: vi.fn(async () => {}),
        resetSessionState: vi.fn(async () => {}),
    };
    const recordedEvents = [];
    const row = { sessionId: "s1", model: "carol-ghcp:claude-opus-5", owner: { provider: "test", subject: "carol" } };
    const catalog = {
        getSession: vi.fn(async () => row),
        recordEvents: vi.fn(async (_sessionId, events) => { recordedEvents.push(...events); }),
        upsertSessionMetricSummary: vi.fn(async () => {}),
        updateSession: vi.fn(async () => {}),
    };
    registerActivities(
        { registerActivity: (name, handler) => { handlers[name] = handler; } },
        sessionManager, null, undefined, catalog,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1",
    );
    const runTurn = (activityCtx = {}) => handlers.runTurn(
        { traceInfo: () => {}, isCancelled: () => false, ...activityCtx },
        { sessionId: "s1", prompt: "check the build", config: { model: "carol-ghcp:claude-opus-5" }, turnIndex: 0 },
    );
    return { runTurn, sessionManager, recordedEvents, session, row };
}

describe("runTurn with a key in the deployment's secret store", () => {
    afterEach(() => {
        delete process.env.PILOTSWARM_PERSONAL_SECRETS;
    });

    it("resolves the key before the session is created", async () => {
        const { runTurn, sessionManager, row } = makeHarness();
        const result = await runTurn();
        expect(result.type).toBe("completed");
        expect(sessionManager.preparePersonalCredential).toHaveBeenCalledWith("s1", "carol-ghcp:claude-opus-5", row);
        expect(sessionManager.preparePersonalCredential.mock.invocationCallOrder[0])
            .toBeLessThan(sessionManager.getOrCreate.mock.invocationCallOrder[0]);
    });

    it("returns the busy-workspace wait for a busy answer, and creates nothing", async () => {
        const busy = new PersonalCredentialError("busy", "carol-ghcp", 'The key of provider "carol-ghcp" is not available right now: parked', 900_000);
        const { runTurn, sessionManager, recordedEvents } = makeHarness({ credential: busy });
        const result = await runTurn();
        expect(result).toEqual({
            type: "wait", seconds: 30, reason: busy.message, gate: "workspace", code: "WORKSPACE_BUSY",
            workerNodeId: "worker-1", retryAfterMs: 900_000,
        });
        expect(sessionManager.getOrCreate).not.toHaveBeenCalled();
        expect(recordedEvents).toEqual([{
            eventType: "session.workspace_unavailable",
            data: { code: "WORKSPACE_BUSY", message: busy.message, workerNodeId: "worker-1", credential: true },
        }]);
    });

    it("returns a refusal and an outage as turn errors, and creates nothing", async () => {
        for (const outcome of ["refused", "unavailable"]) {
            const error = new PersonalCredentialError(outcome, "carol-ghcp", `${outcome} message`);
            const { runTurn, sessionManager } = makeHarness({ credential: error });
            expect(await runTurn()).toEqual({ type: "error", message: `${outcome} message` });
            expect(sessionManager.getOrCreate).not.toHaveBeenCalled();
        }
    });

    it("returns a busy answer as an error that is retried to an orchestration without the workspace hold", async () => {
        const busy = new PersonalCredentialError("busy", "carol-ghcp", 'The key of provider "carol-ghcp" is not available right now: parked', 900_000);
        for (const orchestrationVersion of ["1.0.79", "1.0.47"]) {
            const { runTurn, sessionManager, recordedEvents } = makeHarness({ credential: busy });
            expect(await runTurn({ orchestrationVersion })).toEqual({ type: "error", message: busy.message });
            expect(sessionManager.getOrCreate).not.toHaveBeenCalled();
            expect(recordedEvents).toEqual([]);
        }
        const { runTurn } = makeHarness({ credential: busy });
        expect((await runTurn({ orchestrationVersion: "1.0.80" })).type).toBe("wait");
    });

    it("drops the cached key when the model refuses it", async () => {
        const { runTurn, sessionManager } = makeHarness({
            turnResult: { type: "error", message: "Authentication failed: Failed to validate SDK token (401)" },
        });
        await runTurn();
        expect(sessionManager.forgetPersonalCredential).toHaveBeenCalledWith("s1");
    });

    it("stores the turn result with secrets redacted in external mode", async () => {
        process.env.PILOTSWARM_PERSONAL_SECRETS = "external";
        const { runTurn } = makeHarness({ turnResult: { type: "completed", content: `found ${CLASSIC}`, events: [] } });
        const result = await runTurn();
        expect(result.content).toBe("found ghp_[REDACTED]");
    });
});
