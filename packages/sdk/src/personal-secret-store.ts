/**
 * External personal secrets.
 *
 * With PILOTSWARM_PERSONAL_SECRETS=external, a personal GitHub provider's
 * token is kept in a secret store outside PostgreSQL. The portal hands the
 * token to a `PersonalSecretStore` and the provider row keeps only the
 * store's reference. A worker never reads the token from the database: on
 * every turn it asks the deployment's resolver
 * (`worker.setPersonalCredentialResolver`) for the referenced secret.
 *
 * Core defines the contracts and nothing else. The deployment supplies the
 * store (a module the portal loads from PILOTSWARM_PERSONAL_SECRET_STORE_MODULE)
 * and the resolver, with whatever SDK their own secret service needs.
 */

export const PERSONAL_SECRETS_SETTING = "PILOTSWARM_PERSONAL_SECRETS";

/** `database` keeps personal credentials in the provider rows, as PilotSwarm always has. */
export type PersonalSecretsMode = "database" | "external";

/**
 * Where personal provider credentials live. Unset, empty and `database` mean
 * the provider rows; `external` means the deployment's secret store. Any
 * other value throws: a typo must not quietly keep tokens in the database.
 */
export function personalSecretsMode(env: Record<string, string | undefined> = process.env): PersonalSecretsMode {
    const value = String(env[PERSONAL_SECRETS_SETTING] ?? "").trim().toLowerCase();
    if (value === "" || value === "database") return "database";
    if (value === "external") return "external";
    throw new Error(`${PERSONAL_SECRETS_SETTING} must be database or external.`);
}

export const EXTERNAL_SECRET_KIND = "externalSecret";

/**
 * What a provider row keeps for a token held in the secret store. It names
 * the secret; it never holds it.
 */
export interface ExternalSecretRef {
    kind: typeof EXTERNAL_SECRET_KIND;
    /** The store's own name for itself, as its `put` returned it. */
    store: string;
    name: string;
    /** Changes whenever the token does, so a worker knows to fetch it again. */
    version: string;
    /** When the token expires (ISO 8601), or null when unknown. */
    expiresOn: string | null;
}

function nonEmpty(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The reference in a stored credential, or null when it is not a complete one. */
export function externalSecretRef(secretRef: unknown): ExternalSecretRef | null {
    if (!secretRef || typeof secretRef !== "object") return null;
    const raw = secretRef as Record<string, unknown>;
    if (raw.kind !== EXTERNAL_SECRET_KIND) return null;
    const store = nonEmpty(raw.store);
    const name = nonEmpty(raw.name);
    const version = nonEmpty(raw.version);
    if (!store || !name || !version) return null;
    return { kind: EXTERNAL_SECRET_KIND, store, name, version, expiresOn: nonEmpty(raw.expiresOn) };
}

/**
 * A stored credential as the runtime may see it: a reference is reduced to
 * its own fields, so nothing stored beside it travels on. Any other
 * credential is returned unchanged.
 */
export function withoutSecretValues(secretRef: Record<string, unknown>): Record<string, unknown> {
    if (secretRef?.kind !== EXTERNAL_SECRET_KIND) return secretRef;
    return { ...(externalSecretRef(secretRef) ?? { kind: EXTERNAL_SECRET_KIND }) };
}

/** Whose token it is: the numeric user id, and the signed-in principal when the caller knows it. */
export interface PersonalSecretOwner {
    userId: number;
    principal: { provider: string; subject: string } | null;
}

export interface PersonalSecretPut {
    /** The provider's name. */
    provider: string;
    owner: PersonalSecretOwner;
    token: string;
    /** When the token expires (ISO 8601), when it is known. */
    expiresOn: string | null;
    /** The provider's current reference on an update, so the store can write a new version of it. */
    previous: ExternalSecretRef | null;
}

export interface PersonalSecretWritten {
    store: string;
    name: string;
    /** Must differ from every earlier version of the same name. */
    version: string;
    expiresOn?: string | null;
}

/** A secret's attributes, never its value. */
export interface PersonalSecretAttributes {
    enabled: boolean;
    expiresOn: string | null;
}

/**
 * Where the portal keeps personal tokens in external mode.
 *
 * - `put` stores a token and returns the reference the provider row keeps.
 *   With `previous` set it writes a new version of that secret.
 * - `delete` removes the referenced secret. A secret that is already gone
 *   is not an error.
 * - `describe` returns the referenced secret's attributes, or null when it
 *   does not exist. It never returns the token.
 */
export interface PersonalSecretStore {
    put(secret: PersonalSecretPut): Promise<PersonalSecretWritten>;
    delete(ref: ExternalSecretRef): Promise<void>;
    describe(ref: ExternalSecretRef): Promise<PersonalSecretAttributes | null>;
}

/** Refuse anything that does not implement the store contract. */
export function assertPersonalSecretStore(value: unknown, source = "The personal secret store"): PersonalSecretStore {
    const missing = ["put", "delete", "describe"]
        .filter((method) => typeof (value as Record<string, unknown> | null)?.[method] !== "function");
    if (missing.length > 0) {
        throw new Error(`${source} must implement put, delete and describe; it lacks ${missing.join(", ")}.`);
    }
    return value as PersonalSecretStore;
}

// ── the worker side ──────────────────────────────────────────────

/** One turn's request for the token behind a provider's reference. */
export interface PersonalCredentialRequest {
    sessionId: string;
    rootSessionId: string;
    /** The provider's name. */
    provider: string;
    secret: ExternalSecretRef;
}

/**
 * The resolver's answer:
 * - `ok`: the token;
 * - `refused`: the token may not be used for this session. The turn fails as
 *   an authentication failure and is not retried;
 * - `busy`: not now. The session waits and tries again, as it does for a busy
 *   workspace, after `retryAfterMs` when given;
 * - `unavailable`: the resolver could not answer. The turn fails and is
 *   retried. A resolver that throws means the same.
 */
export type PersonalCredentialAnswer =
    | { status: "ok"; token: string }
    | { status: "refused"; message?: string }
    | { status: "busy"; message?: string; retryAfterMs?: number }
    | { status: "unavailable"; message?: string };

export type PersonalCredentialResolver = (request: PersonalCredentialRequest) => Promise<PersonalCredentialAnswer>;

export type PersonalCredentialOutcome = "refused" | "busy" | "unavailable";

/** A turn's credential could not be used. `outcome` says how the turn ends. */
export class PersonalCredentialError extends Error {
    readonly outcome: PersonalCredentialOutcome;
    readonly provider: string;
    readonly retryAfterMs?: number;
    constructor(outcome: PersonalCredentialOutcome, provider: string, message: string, retryAfterMs?: number) {
        super(message);
        this.name = "PersonalCredentialError";
        this.outcome = outcome;
        this.provider = provider;
        if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    }
}
