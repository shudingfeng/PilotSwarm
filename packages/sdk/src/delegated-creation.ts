/**
 * Dispatcher delegation: the record of a session that the deployment's
 * dispatcher created for a user (`onBehalfOfOwner` on the portal). The portal
 * passes it to `PilotSwarmClient.createSession`, which saves it with the root
 * session's creation config; no request parameter sets it. The portal reads
 * it back (`PilotSwarmManagementClient.getSessionDelegation`) to keep such a
 * tree shared for reading only.
 */

/** What a delegated creation records. */
export interface DelegatedCreation {
    /** The dispatcher's principal, as it signed in to create the session. */
    dispatcher: { provider: string; subject: string };
}

/** A session tree's delegation record: its root's, with the root's id. */
export interface SessionDelegation extends DelegatedCreation {
    rootSessionId: string;
}

/** The record in its stored form, or null when `value` is not one. */
export function delegatedCreationOf(value: unknown): DelegatedCreation | null {
    const dispatcher = value && typeof value === "object" ? (value as { dispatcher?: unknown }).dispatcher : null;
    if (!dispatcher || typeof dispatcher !== "object") return null;
    const { provider, subject } = dispatcher as { provider?: unknown; subject?: unknown };
    if (typeof provider !== "string" || !provider.trim() || typeof subject !== "string" || !subject.trim()) return null;
    return { dispatcher: { provider: provider.trim(), subject: subject.trim() } };
}
