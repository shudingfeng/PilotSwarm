/**
 * Owner routing: tags that keep a user's sessions on that user's workers, and
 * the capacity requests that tell a deployment an owner needs a worker.
 *
 * The client records `ownerTag` in the orchestration input of a top-level
 * user session (`PilotSwarmClientOptions.ownerRouting`). Orchestration 1.0.84
 * then tags every session-scoped activity with it, and a worker with the
 * same `PilotSwarmWorkerOptions.ownerTag` runs them. Before each turn the
 * orchestration asks for capacity (`requestOwnerCapacity`); a worker with a
 * capacity requester answers.
 *
 * A Workflow carries no owner tag: its activities carry the workflow-request
 * tag, its agent steps are created inside an activity, outside any turn, and
 * its scripts' tool sessions attach the root's workspace on whichever worker
 * runs them. So a Workflow is not started or tested in an owner-routed tree,
 * and no new root session is created from one.
 */
import { SYSTEM_USER_PRINCIPAL } from "./cms.js";
import type { OwnerCapacityRequest, OwnerCapacityRequester } from "./types.js";

export const OWNER_TAG_PREFIX = "owner.";

/** duroxide's MAX_TAG_NAME_BYTES: the longest tag an activity or a worker may carry. */
export const MAX_OWNER_TAG_BYTES = 256;

/** How long the requestOwnerCapacity activity waits for the requester. */
export const OWNER_CAPACITY_TIMEOUT_MS = 15_000;

/** How long a session waits before it asks again when the requester did not answer. */
export const CAPACITY_UNAVAILABLE_RETRY_MS = 60_000;

/** The requester did not answer, failed, or this worker has none. Not a busy refusal: it releases no worker. */
export const CAPACITY_UNAVAILABLE = "CAPACITY_UNAVAILABLE";

/** The default code of a `deny` answer. */
export const CAPACITY_DENIED = "CAPACITY_DENIED";

const BUSY_CODE = "WORKSPACE_BUSY";
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** True for `owner.<subject>`: no whitespace or control characters, at most 256 bytes. */
export function isOwnerRoutingTag(value: unknown): value is string {
    if (typeof value !== "string" || !value.startsWith(OWNER_TAG_PREFIX) || value.length === OWNER_TAG_PREFIX.length) return false;
    if (/[\s\p{Cc}]/u.test(value)) return false;
    return Buffer.byteLength(value, "utf8") <= MAX_OWNER_TAG_BYTES;
}

/**
 * The owner routing tag of a session row: `owner.<subject>` of its owner.
 * None for a system session, a session the system user owns, or a row
 * without an owner.
 */
export function ownerRoutingTagForRow(row: {
    owner?: { provider?: string | null; subject?: string | null } | null;
    isSystem?: boolean | null;
} | null | undefined): string | undefined {
    if (!row || row.isSystem) return undefined;
    const provider = row.owner?.provider;
    const subject = row.owner?.subject;
    if (!provider || !subject) return undefined;
    if (provider === SYSTEM_USER_PRINCIPAL.provider && subject === SYSTEM_USER_PRINCIPAL.subject) return undefined;
    const tag = `${OWNER_TAG_PREFIX}${subject}`;
    return isOwnerRoutingTag(tag) ? tag : undefined;
}

/** The code of a Workflow start or test refused in an owner-routed tree. */
export const WORKFLOW_OWNER_ROUTED = "WORKFLOW_OWNER_ROUTED";

/** Its words. */
export const WORKFLOW_OWNER_ROUTED_TEXT = "This session tree runs on its owner's workers (owner routing), and a Workflow would run "
    + "off them, without the owner's drive or credentials: a Workflow is not started or tested here. Nothing was started.";

/** The refusal as the workflow tools answer it: their JSON refusal with its code. */
export function workflowOwnerRoutedRefusal(): string {
    return JSON.stringify({ ok: false, error: { code: WORKFLOW_OWNER_ROUTED, message: WORKFLOW_OWNER_ROUTED_TEXT } });
}

/** create_agent_session's refusal in an owner-routed tree. */
export const NEW_ROOT_OWNER_ROUTED_TEXT = "[SYSTEM: create_agent_session refused — this session tree runs on its owner's workers "
    + "(owner routing), and a new root session would hold no drive there. Use spawn_agent for a sub-agent of this session; "
    + "the deployment's dispatcher creates any other root session. Nothing was created.]";

/**
 * The owner tag a session's turns carry, as far as the catalog tells: the tag
 * saved with its creation config (a session created during a tagged turn, or
 * created with one) or its root's, else, with owner routing on, the tag its
 * root takes when the client starts it (client.ts, _routingForStart). A root
 * started before owner routing was on has no tag but counts as tagged here.
 */
export async function ownerRoutedTreeTag(
    catalog: {
        getSession(sessionId: string): Promise<{
            sessionId?: string;
            parentSessionId?: string | null;
            rootSessionId?: string | null;
            isSystem?: boolean | null;
            owner?: { provider?: string | null; subject?: string | null } | null;
        } | null | undefined>;
        getSessionCreationConfig?(sessionId: string): Promise<Record<string, unknown> | null | undefined>;
    },
    sessionId: string,
    ownerRouting: boolean,
): Promise<string | undefined> {
    const savedTag = async (id: string): Promise<string | undefined> => {
        const saved = catalog.getSessionCreationConfig ? await catalog.getSessionCreationConfig(id) : null;
        return isOwnerRoutingTag(saved?.ownerTag) ? saved!.ownerTag as string : undefined;
    };
    const row = await catalog.getSession(sessionId);
    if (!row) return undefined;
    const own = await savedTag(sessionId);
    if (own) return own;
    const rootId = row.rootSessionId && row.rootSessionId !== sessionId ? row.rootSessionId : null;
    const root = rootId ? await catalog.getSession(rootId) : row;
    if (!root) return undefined;
    if (rootId) {
        const rootTag = await savedTag(rootId);
        if (rootTag) return rootTag;
    }
    return ownerRouting && !root.parentSessionId ? ownerRoutingTagForRow(root) : undefined;
}

/** A capacity answer as the orchestration acts on it. */
export type OwnerCapacityDecision =
    | { decision: "ok" }
    | { decision: "deny"; code: string; message: string }
    | { decision: "busy"; code: string; message: string; retryAfterMs?: number };

export function capacityUnavailable(message: string): OwnerCapacityDecision {
    return { decision: "busy", code: CAPACITY_UNAVAILABLE, message, retryAfterMs: CAPACITY_UNAVAILABLE_RETRY_MS };
}

/**
 * Normalize a requester's answer. `deny` and `busy` keep their message, code
 * and wait; any other answer lets the turn run.
 */
export function normalizeOwnerCapacityAnswer(answer: unknown): OwnerCapacityDecision {
    const value = answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
    const message = typeof value.message === "string" && value.message.trim() ? value.message.trim().slice(0, 2_000) : undefined;
    const code = typeof value.code === "string" && CODE_PATTERN.test(value.code) ? value.code : undefined;
    if (value.decision === "deny") {
        return { decision: "deny", code: code ?? CAPACITY_DENIED, message: message ?? "The capacity request for this session was denied." };
    }
    if (value.decision === "busy") {
        const retryAfterMs = typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs > 0
            ? Math.floor(value.retryAfterMs)
            : undefined;
        return {
            decision: "busy",
            code: code ?? BUSY_CODE,
            message: message ?? "The workers of this session's owner are busy.",
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
    }
    return { decision: "ok" };
}

/**
 * Ask the requester, for at most `timeoutMs`. When the time is up its signal
 * fires and the answer is CAPACITY_UNAVAILABLE, as it is when the requester
 * throws or none is registered.
 */
export async function askOwnerCapacityRequester(
    requester: OwnerCapacityRequester | null | undefined,
    request: OwnerCapacityRequest | (() => Promise<OwnerCapacityRequest>),
    timeoutMs = OWNER_CAPACITY_TIMEOUT_MS,
): Promise<OwnerCapacityDecision> {
    if (!requester) return capacityUnavailable("No capacity requester is registered on the worker that took this request.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<OwnerCapacityDecision>((resolve) => {
        timer = setTimeout(() => {
            controller.abort(new Error(`no answer within ${timeoutMs} ms`));
            resolve(capacityUnavailable(`The capacity request got no answer within ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
    });
    const asked = (async (): Promise<OwnerCapacityDecision> => {
        try {
            const resolved = typeof request === "function" ? await request() : request;
            return normalizeOwnerCapacityAnswer(await requester(resolved, controller.signal));
        } catch (err: any) {
            return capacityUnavailable(`The capacity request failed: ${err?.message ?? String(err)}`);
        }
    })();
    try {
        return await Promise.race([asked, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The code of a turn that a worker with a capacity requester refuses: the
 * session's creation config holds an owner tag that the turn doesn't carry.
 */
export const OWNER_TAG_MISSING = "OWNER_TAG_MISSING";

/**
 * Its words. The orchestration carries the tag it started with to every later
 * turn, so a retry would be refused again.
 */
export function ownerTagMissingText(turnOwnerTag: unknown): string {
    const started = typeof turnOwnerTag === "string" && turnOwnerTag ? "with another owner's tag" : "without its owner tag";
    return `${OWNER_TAG_MISSING}: This session runs only on its owner's workers (owner routing), but its orchestration `
        + `was started ${started}, so this turn would run on another worker. The turn was refused and is not retried.`;
}
