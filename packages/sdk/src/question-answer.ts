import { createHash } from "node:crypto";

export const QUESTION_ANSWER_PROTOCOL = "question-answer-v1" as const;
// Leave space under the runtime's 150-key limit for FIFO buckets and legacy controls.
export const QUESTION_ANSWER_KV_SOFT_LIMIT = 100;
export type QuestionAnswerStatus = "accepted" | "stale" | "conflict" | "pending" | "unavailable" | "refused";

export interface QuestionAnswerRequest {
    requestId: string;
    expectedQuestion: { question: string; occurrenceId: string };
    answer: string;
}

export type QuestionAnswerReceipt = {
    protocol: typeof QUESTION_ANSWER_PROTOCOL;
    requestId: string;
    occurrenceId: string;
    requestHash: string;
} & ({ status: "accepted"; receiptId: string }
    | { status: Exclude<QuestionAnswerStatus, "accepted">; receiptId?: never });

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;

function invalid(message: string): never {
    throw Object.assign(new Error(message), { code: "INVALID_REQUEST", status: 400 });
}

export function validateQuestionAnswerId(value: unknown, name = "requestId"): string {
    if (typeof value !== "string" || !ID.test(value)) {
        invalid(`${name} must be 1-128 ASCII letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit`);
    }
    return value;
}

function text(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
        invalid(`${name} must be nonblank text without NUL, at most ${MAX_TEXT_BYTES} UTF-8 bytes`);
    }
    return value;
}

/** Return only the contract fields; caller-supplied identity and hashes are never forwarded. */
export function validateQuestionAnswerRequest(value: unknown): QuestionAnswerRequest {
    const raw = value as Partial<QuestionAnswerRequest> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("request must be an object");
    const expected = raw.expectedQuestion;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) invalid("expectedQuestion must be an object");
    const request = {
        requestId: validateQuestionAnswerId(raw.requestId),
        expectedQuestion: {
            question: text(expected.question, "expectedQuestion.question"),
            occurrenceId: validateQuestionAnswerId(expected.occurrenceId, "expectedQuestion.occurrenceId"),
        },
        answer: text(raw.answer, "answer"),
    };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_PAYLOAD_BYTES) {
        invalid(`request must encode to at most ${MAX_PAYLOAD_BYTES} UTF-8 bytes`);
    }
    return request;
}

export function questionAnswerRequestHash(request: QuestionAnswerRequest): string {
    return createHash("sha256").update(JSON.stringify([
        request.expectedQuestion.occurrenceId, request.expectedQuestion.question, request.answer,
    ]), "utf8").digest("hex");
}

export function questionAnswerReceiptKey(requestId: string): string {
    return `question-answer.${validateQuestionAnswerId(requestId)}`;
}

export function questionAnswerReceipt(
    request: QuestionAnswerRequest,
    status: QuestionAnswerStatus,
    sessionId?: string,
): QuestionAnswerReceipt {
    const base = {
        protocol: QUESTION_ANSWER_PROTOCOL,
        requestId: request.requestId,
        occurrenceId: request.expectedQuestion.occurrenceId,
        requestHash: questionAnswerRequestHash(request),
    };
    if (status !== "accepted") return { ...base, status };
    if (!sessionId) throw new Error("An accepted question answer requires its session identity");
    const receiptId = createHash("sha256").update(JSON.stringify([sessionId, base.requestId, base.requestHash]), "utf8").digest("hex");
    return { ...base, status, receiptId };
}

export function parseQuestionAnswerReceipt(raw: string | null): QuestionAnswerReceipt | null {
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (value?.protocol !== QUESTION_ANSWER_PROTOCOL
        || typeof value.requestId !== "string" || !ID.test(value.requestId)
        || typeof value.occurrenceId !== "string" || !ID.test(value.occurrenceId)
        || typeof value.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(value.requestHash)
        || !["accepted", "stale", "conflict", "pending", "unavailable", "refused"].includes(value.status)
        || (value.status === "accepted" && (typeof value.receiptId !== "string" || !value.receiptId.trim()))) {
        throw new Error("Invalid durable question-answer receipt");
    }
    const base = {
        protocol: QUESTION_ANSWER_PROTOCOL, requestId: value.requestId, occurrenceId: value.occurrenceId,
        requestHash: value.requestHash,
    };
    return value.status === "accepted" ? { ...base, status: "accepted", receiptId: value.receiptId } : { ...base, status: value.status };
}

export function questionAnswerResult(request: QuestionAnswerRequest, receipt: QuestionAnswerReceipt): QuestionAnswerReceipt {
    if (receipt.requestId !== request.requestId) throw new Error("Durable question-answer request identity mismatch");
    return receipt.occurrenceId === request.expectedQuestion.occurrenceId && receipt.requestHash === questionAnswerRequestHash(request)
        ? receipt : questionAnswerReceipt(request, "conflict");
}
