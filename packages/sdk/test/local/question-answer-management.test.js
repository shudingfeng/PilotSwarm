import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import {
    QUESTION_ANSWER_PROTOCOL, QUESTION_ANSWER_KV_SOFT_LIMIT, questionAnswerReceipt, questionAnswerReceiptKey, questionAnswerRequestHash,
} from "../../src/question-answer.ts";
import { ApiClient, HttpApiTransport, buildOperationRequest, getOperation } from "../../api/index.js";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";

const request = {
    requestId: "request-1", expectedQuestion: { question: "Choose a color: 青?", occurrenceId: "occurrence-1" }, answer: "blue",
};
const owner = { provider: "test", subject: "owner", displayName: "Owner" };
const auth = principal => ({ principal, authorization: { allowed: true, role: "user" } });

function harness({ protocol = QUESTION_ANSWER_PROTOCOL, version = "1.0.87", state = "input_required", lineage = null, kind = "agent", keyCount = 0 } = {}) {
    const receipts = new Map();
    const enqueues = [];
    let reads = 0;
    const row = {
        sessionId: "s1", sessionKind: kind, state, createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"), owner, parentSessionId: null,
    };
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._started = true;
    mgmt._catalog = {
        getSession: async () => row, updateSession: async () => {},
        workflowStore: () => ({ readWorkflowLineage: async () => lineage }),
        recordAuthzAudit: async () => {},
    };
    mgmt._duroxideClient = {
        getInstanceInfo: async () => ({ status: "Running", orchestrationVersion: version }),
        getStatus: async () => ({
            status: "Running", customStatusVersion: 1,
            customStatus: JSON.stringify({
                status: state, iteration: 4, pendingQuestion: request.expectedQuestion.question,
                questionIteration: 3, questionOccurrenceId: request.expectedQuestion.occurrenceId,
                ...(protocol ? { questionAnswerProtocol: protocol } : {}),
            }),
        }),
        getValue: async (_id, key) => { reads++; return receipts.get(key) ?? null; },
        getOrchestrationStats: async () => ({ kvUserKeyCount: keyCount }),
        enqueueEvent: async (id, queue, payload) => enqueues.push({ id, queue, payload: JSON.parse(payload) }),
    };
    const transport = Object.create(NodeSdkTransport.prototype);
    transport.mgmt = mgmt;
    transport.getSessionAccess = async (_id, viewer) => ({
        rootSessionId: "s1", visibility: "private", isSystem: false, owner,
        viewerIsOwner: viewer?.subject === "owner",
        viewerShareAccess: viewer?.subject === "reader" ? "read" : null,
    });
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted", dispatcherSubject: null };
    runtime.transport = transport;
    return { mgmt, runtime, receipts, enqueues, reads: () => reads };
}

describe("conditional answers: management and Web API wiring without services", () => {
    it("advertises only the worker's literal protocol, not the host's version, and preserves question iteration", async () => {
        const supported = await harness().mgmt.getSession("s1");
        expect(supported).toMatchObject({
            questionAnswerProtocol: QUESTION_ANSWER_PROTOCOL,
            pendingQuestion: { ...request.expectedQuestion, iteration: 3 },
        });
        for (const protocol of [null, "question-answer-v0", true]) {
            const h = harness({ protocol, version: "99.0.0" });
            expect(await h.mgmt.getSession("s1")).not.toHaveProperty("questionAnswerProtocol");
            expect((await h.mgmt.answerQuestion("s1", request)).status).toBe("unavailable");
            expect(h.enqueues).toEqual([]);
        }
    });

    it("returns pending promptly after one enqueue, not acceptance or an outcome polling loop", async () => {
        const h = harness();
        const result = await h.mgmt.answerQuestion("s1", request);
        expect(result).toEqual(questionAnswerReceipt(request, "pending"));
        expect(h.reads()).toBe(1);
        expect(h.enqueues).toEqual([{
            id: "session-s1", queue: "messages",
            payload: { type: "cmd", cmd: "answer_question", id: request.requestId, args: { request } },
        }]);
        expect(await h.mgmt.getQuestionAnswer("s1", request.requestId)).toBeNull();
    });

    it("fails closed on exhausted or unknown receipt capacity while preserving existing results", async () => {
        for (const keyCount of [QUESTION_ANSWER_KV_SOFT_LIMIT, 150, null, NaN]) {
            const h = harness({ keyCount });
            expect((await h.mgmt.answerQuestion("s1", request)).status).toBe("unavailable");
            expect(h.enqueues).toEqual([]);
            const accepted = questionAnswerReceipt(request, "accepted", "s1");
            h.receipts.set(questionAnswerReceiptKey(request.requestId), JSON.stringify(accepted));
            expect(await h.mgmt.answerQuestion("s1", request)).toEqual(accepted);
        }
    });

    it("recovers a lost reply from the original durable receipt and reports changed same-ID payloads as conflict", async () => {
        const h = harness();
        await h.mgmt.answerQuestion("s1", request);
        const accepted = questionAnswerReceipt(request, "accepted", "s1");
        h.receipts.set(questionAnswerReceiptKey(request.requestId), JSON.stringify(accepted));
        expect(await h.mgmt.getQuestionAnswer("s1", request.requestId)).toEqual(accepted);
        expect(await h.mgmt.answerQuestion("s1", request)).toEqual(accepted);
        for (const changed of [
            { ...request, answer: "red" },
            { ...request, expectedQuestion: { ...request.expectedQuestion, question: "another question" } },
            { ...request, expectedQuestion: { ...request.expectedQuestion, occurrenceId: "occurrence-2" } },
        ]) {
            expect(await h.mgmt.answerQuestion("s1", changed)).toEqual(questionAnswerReceipt(changed, "conflict"));
        }
        expect(await h.mgmt.getQuestionAnswer("s1", request.requestId)).toEqual(accepted);
        expect(h.enqueues).toHaveLength(1);
        expect(accepted.requestHash).toBe(createHash("sha256").update(JSON.stringify([
            request.expectedQuestion.occurrenceId, request.expectedQuestion.question, request.answer,
        ]), "utf8").digest("hex"));
    });

    for (const status of ["pending", "stale", "refused"]) {
        it(`returns the original ${status} result without re-enqueueing`, async () => {
            const h = harness();
            const original = questionAnswerReceipt(request, status);
            h.receipts.set(questionAnswerReceiptKey(request.requestId), JSON.stringify(original));
            expect(await h.mgmt.answerQuestion("s1", request)).toEqual(original);
            expect((await h.mgmt.answerQuestion("s1", { ...request, answer: "changed" })).status).toBe("conflict");
            expect(h.enqueues).toEqual([]);
        });
    }

    it("does not mistake storage failure or malformed receipts for an unknown request", async () => {
        const h = harness();
        h.receipts.set(questionAnswerReceiptKey(request.requestId), '{"status":"accepted"}');
        await expect(h.mgmt.answerQuestion("s1", request)).rejects.toThrow("Invalid durable");
        h.mgmt._duroxideClient.getValue = async () => { throw new Error("storage unavailable"); };
        await expect(h.mgmt.getQuestionAnswer("s1", request.requestId)).rejects.toThrow("storage unavailable");
        expect(h.enqueues).toEqual([]);
    });

    it("validates and bounds IDs, UTF-8 text and encoded request size before enqueue", async () => {
        const h = harness();
        const invalid = [
            null, [], {}, { ...request, requestId: "../other" }, { ...request, requestId: "r".repeat(129) },
            { ...request, expectedQuestion: { ...request.expectedQuestion, occurrenceId: "" } },
            { ...request, expectedQuestion: { ...request.expectedQuestion, question: " " } },
            { ...request, answer: "" }, { ...request, answer: "has\0nul" },
            { ...request, answer: "😀".repeat(4097) },
            { ...request, answer: "\u0001".repeat(6_000) },
        ];
        for (const value of invalid) {
            await expect(h.mgmt.answerQuestion("s1", value)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        }
        await expect(h.mgmt.getQuestionAnswer("s1", "r".repeat(129))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        expect(h.enqueues).toEqual([]);
    });

    it("preserves workflow conversational and human-input denials", async () => {
        const workflow = harness({ kind: "workflow" });
        await expect(workflow.mgmt.answerQuestion("s1", request)).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
        const h = harness({ lineage: { agentRoot: { workflowSessionId: "wf", nodeExecutionId: "node", controllingSessionId: "parent" } } });
        await expect(h.runtime.call("answerQuestion", { sessionId: "s1", request }, auth(owner)))
            .rejects.toMatchObject({ code: "WORKFLOW_HUMAN_INPUT_DENIED" });
        expect(h.enqueues).toEqual([]);
    });

    it("enforces session write/read and stamps authenticated identity, ignoring impersonation fields", async () => {
        const h = harness();
        const reader = { provider: "test", subject: "reader", displayName: "Reader" };
        const stranger = { provider: "test", subject: "stranger", displayName: "Stranger" };
        await expect(h.runtime.call("answerQuestion", { sessionId: "s1", request }, auth(reader))).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(h.runtime.call("getQuestionAnswer", { sessionId: "s1", requestId: request.requestId }, auth(stranger)))
            .rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await h.runtime.call("getQuestionAnswer", { sessionId: "s1", requestId: request.requestId }, auth(reader))).toBeNull();
        const impersonated = { kind: "agent", sessionId: "other", subject: "other", display: "Other", relation: "owner" };
        await h.runtime.call("answerQuestion", {
            sessionId: "s1", request: { ...request, sender: impersonated }, sender: impersonated, options: { sender: impersonated },
        }, auth(owner));
        expect(h.enqueues).toHaveLength(1);
        expect(h.enqueues[0].payload.args.request).toEqual(request);
        expect(h.enqueues[0].payload.sender).toEqual({
            kind: "user", provider: "test", subject: "owner", display: "Owner", relation: "owner", origin: "api",
        });
        expect(getOperation("answerQuestion").access).toBe("session:write");
        expect(getOperation("getQuestionAnswer").access).toBe("session:read");
    });

    it("carries the exact request/receipt through Web management, transport and protocol operations", async () => {
        const h = harness();
        const wires = [];
        const api = new ApiClient({
            apiUrl: "https://api.example.test",
            fetchImpl: async (url, init) => {
                wires.push({ url, init });
                const post = init.method === "POST";
                const result = await h.runtime.call(post ? "answerQuestion" : "getQuestionAnswer",
                    post ? { sessionId: "s1", ...JSON.parse(init.body) } : { sessionId: "s1", requestId: request.requestId }, auth(owner));
                return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
            },
        });
        const web = new PilotSwarmManagementClient({ apiUrl: api.apiUrl, api });
        expect((await web.answerQuestion("s1", request, { sender: { kind: "agent" } })).status).toBe("pending");
        expect(JSON.parse(wires[0].init.body)).toEqual({ request });
        expect(wires[0].url).toBe("https://api.example.test/api/v1/sessions/s1/question-answers");
        const accepted = questionAnswerReceipt(request, "accepted", "s1");
        h.receipts.set(questionAnswerReceiptKey(request.requestId), JSON.stringify(accepted));
        expect(await web.getQuestionAnswer("s1", request.requestId)).toEqual(accepted);
        const transport = new HttpApiTransport({ api });
        expect(await transport.answerQuestion("s1", request)).toEqual(accepted);
        expect(await transport.getQuestionAnswer("s1", request.requestId)).toEqual(accepted);
        expect(h.enqueues).toHaveLength(1);
        const built = buildOperationRequest("getQuestionAnswer", { sessionId: "s1", requestId: "request:1" });
        expect(built.path).toBe("/api/v1/sessions/s1/question-answers/request%3A1");
        expect(wires).toHaveLength(4);
    });

    it("an old Web host's missing endpoint fails closed without falling back to legacy answers", async () => {
        const calls = [];
        const api = new ApiClient({
            apiUrl: "https://api.example.test",
            fetchImpl: async (url) => {
                calls.push(url);
                return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "route unavailable" } }), { status: 404 });
            },
        });
        const web = new PilotSwarmManagementClient({ apiUrl: api.apiUrl, api });
        await expect(web.answerQuestion("s1", request)).rejects.toMatchObject({ status: 404 });
        expect(calls).toEqual(["https://api.example.test/api/v1/sessions/s1/question-answers"]);
    });

    it("the Web SDK never treats another payload's acceptance as acceptance of a changed request", async () => {
        const accepted = questionAnswerReceipt(request, "accepted", "s1");
        const api = new ApiClient({
            apiUrl: "https://api.example.test",
            fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: accepted }), { status: 200 }),
        });
        const web = new PilotSwarmManagementClient({ apiUrl: api.apiUrl, api });
        const changed = { ...request, answer: "different answer" };
        expect(await web.answerQuestion("s1", changed)).toEqual(questionAnswerReceipt(changed, "conflict"));
        expect(await web.getQuestionAnswer("s1", request.requestId)).toEqual(accepted);
    });

    it("keeps the legacy answer payload and return behavior", async () => {
        const h = harness({ protocol: null });
        expect(await h.mgmt.sendAnswer("s1", "legacy text")).toBeUndefined();
        expect(h.enqueues[0].payload).toMatchObject({
            answer: "legacy text", wasFreeform: true,
            expectedQuestion: { question: request.expectedQuestion.question, iteration: 3 },
        });
        expect(h.enqueues[0].payload).not.toHaveProperty("type");
        expect(questionAnswerRequestHash(request)).not.toBe(questionAnswerRequestHash({ ...request, answer: "red" }));
    });
});
