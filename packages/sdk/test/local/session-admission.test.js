/**
 * Session admission (PilotSwarmWorker.setSessionAdmission) on a real worker
 * with the real Copilot CLI and the scripted model: `busy` holds the prompt as
 * a busy workspace does, and the turn runs once when it is admitted; `deny`
 * fails the turn without a retry and calls no model.
 *
 * Run: npx vitest run test/local/session-admission.test.js
 */
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { patchSessionStartInput } from "../helpers/pinned-start.mjs";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("session admission", () => {
    it("busy holds the prompt as a busy workspace does, and the turn runs once when admitted", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond: () => ({ content: "admitted" }),
        }, async ({ client, worker, model, qualifiedModel }) => {
            const sessionId = randomUUID();
            const asked = [];
            worker.setSessionAdmission((request) => {
                if (request.sessionId !== sessionId) return { decision: "admit" };
                asked.push(request);
                return asked.length <= 2 ? { decision: "busy", message: "the owner's VM is busy" } : { decision: "admit" };
            });
            const patch = patchSessionStartInput(client, (input) => ({ ...input, workspaceRetryScheduleMs: [400, 400, 400] }), { sessionId });
            const startedAt = Date.now();
            try {
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                await session.send("held prompt text");
                assertEqual(await session.wait(TIMEOUT), "admitted");
            } finally {
                patch.restore();
            }
            assert(Date.now() - startedAt < 60_000, "the shortened schedule was followed");
            assertEqual(JSON.stringify(asked), JSON.stringify(Array(3).fill({ sessionId, rootSessionId: sessionId, isSystem: false })),
                "two busy answers, then the turn that ran");

            const requests = model.sessionRequests();
            assertEqual(requests.length, 1, "one model call, after admission");
            assert(requests[0].position.lastUserText.includes("held prompt text"), "the held prompt reached the model");

            const catalog = await createCatalog(env);
            try {
                const users = (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "user.message");
                assertEqual(users.length, 1, "the held prompt was recorded once");
                assertEqual(users[0].data.content, "held prompt text");
            } finally {
                await catalog.close?.();
            }
        });
    });

    it("deny fails the turn without a retry and calls no model", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond: () => ({ content: "should not run" }),
        }, async ({ client, worker, model, qualifiedModel }) => {
            const sessionId = randomUUID();
            let asked = 0;
            worker.setSessionAdmission((request) => {
                if (request.sessionId !== sessionId) return { decision: "admit" };
                asked += 1;
                return { decision: "deny", message: "no drive is leased for this session here" };
            });
            const session = await client.createSession({ sessionId, model: qualifiedModel });
            await session.send("denied prompt");
            const catalog = await createCatalog(env);
            try {
                const row = await waitForSessionState(catalog, sessionId, ["error"], 60_000);
                assert(String(row.lastError).includes("Session admission denied this turn: no drive is leased for this session here"),
                    `the session shows the hook's reason: ${row.lastError}`);
            } finally {
                await catalog.close?.();
            }
            assertEqual(asked, 1, "the denied turn was not retried");
            assertEqual(model.sessionRequests().length, 0, "no model call");
        });
    });
});
