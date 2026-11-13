/**
 * Provider budgets — the data access layer.
 *
 * One class over the `cms_provider_*` stored procedures from migrations
 * 0049-0053. It is deliberately thin: every rule about who may do what, and
 * every counter decision, lives in SQL (see the migration headers for why),
 * so nothing here re-implements a policy. What it does add is shape — the
 * database's snake_case rows become the objects the API, the MCP server, the
 * agent tools and the portal all share — and a typed error, so a refusal
 * arrives at the caller as a code rather than a string to grep.
 */
import type { Pool } from "pg";
import type { BudgetPeriod, BudgetRuleState, TurnAdmission } from "./provider-budgets.js";
import { toTurnAdmission } from "./provider-budgets.js";
import {
    EXTERNAL_SECRET_KIND,
    externalSecretRef,
    personalSecretsMode,
    withoutSecretValues,
    type ExternalSecretRef,
    type PersonalSecretStore,
} from "./personal-secret-store.js";

export type ProviderClass = "shared" | "personal";

/**
 * What a workload-identity provider stores instead of a key.
 *
 * It holds no secret. It exists so the row is distinguishable from one whose
 * credential was never set: `has_credential` in SQL is `secret_ref <> '{}'`,
 * and everything from the portal's greying-out of a provider to refusing it
 * as a default reads that. Nothing ever reads a value out of it — the token
 * is minted at the moment of use from the worker's own identity.
 */
export const WORKLOAD_IDENTITY_KIND = "workloadIdentity";

/** Does this stored blob say "authenticate as the worker"? */
export function isWorkloadIdentitySecret(secretRef: Record<string, unknown> | null | undefined): boolean {
    return secretRef?.kind === WORKLOAD_IDENTITY_KIND;
}
export type ChargeClass = "user" | "system" | "unattributed";

/** A refusal from the database, with the marker turned into a code. */
export class ProviderError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ProviderError";
        this.code = code;
    }
}

const PROVIDER_ERROR = /^(PROVIDER_[A-Z_]+):\s*(.*)$/s;

/**
 * Stored-procedure refusals arrive as `PROVIDER_FORBIDDEN: ...`. Everything
 * else — a dropped connection, a constraint the procs did not anticipate —
 * is passed through untouched, so a real fault is never mistaken for a
 * policy decision.
 */
function rethrow(err: any): never {
    const raw = String(err?.message ?? "");
    const m = PROVIDER_ERROR.exec(raw);
    if (m) throw new ProviderError(m[1], m[2].trim());
    // A check constraint is the schema refusing the same class of thing the
    // procs refuse in words; name it so callers do not have to read pg codes.
    if (err?.code === "23514" && /provider_instances_name_shape/.test(raw)) {
        throw new ProviderError("PROVIDER_INVALID",
            "A provider name may use letters, numbers, dot, dash and underscore, and may not contain a colon.");
    }
    throw err;
}

export interface ProviderRow {
    name: string;
    typeId: string;
    class: ProviderClass;
    ownerUserId: number | null;
    ownerEmail: string | null;
    ownerDisplayName: string | null;
    baseUrl: string | null;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    hasCredential: boolean;
    /** False for another person's provider, which an admin can see but not run. */
    usableByMe: boolean;
    systemUseEnabled: boolean;
    systemEligible: boolean;
    isClusterDefault: boolean;
    isMyDefault: boolean;
    isSystemDefault: boolean;
    ruleCount: number;
    createdAt: string;
}

export interface ProviderStatusRow {
    name: string;
    class: ProviderClass;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    rules: BudgetRuleState[];
}

/**
 * One period's cell on the provider table, for one row.
 *
 * Four numbers, because the screen shows two of them at a time and must never
 * mix them up: `usedTokens / quotaTokens` is what everyone spent against the
 * limit, `yourUsedTokens / yourQuotaTokens` is what you spent against your
 * share of it.
 *
 * A null quota means no limit for that period. The used number beside it is
 * still real — the meter runs whether or not anybody capped it. A null
 * `yourUsedTokens` means nobody is signed in, which is not zero.
 */
export interface UsageGridCell {
    /** The limit that set this quota, or null when the period is uncapped. */
    ruleId: string | null;
    quotaTokens: number | null;
    usedTokens: number;
    yourQuotaTokens: number | null;
    /**
     * The four parts of usedTokens / yourUsedTokens (0069): same window,
     * scope and turns as the meter, so they add up to it. The viewer's four
     * are null when nobody is signed in, like yourUsedTokens.
     */
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    yourInputTokens: number | null; yourOutputTokens: number | null;
    yourCacheReadTokens: number | null; yourCacheWriteTokens: number | null;
    yourUsedTokens: number | null;
    windowStartUtc: string;
    resetsAtUtc: string;
}

/**
 * One line of the provider table: a provider, or one model it has a limit on.
 * Both kinds carry the same three cells, so a model limit reads exactly like
 * the provider above it.
 */
export interface UsageGridRow {
    providerName: string;
    rowKind: "provider" | "model";
    /** '*' on a provider row; the qualified model reference on a model row. */
    scope: string;
    class: ProviderClass;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    /** How many model rows follow this provider. Always 0 on a model row. */
    modelRowCount: number;
    /**
     * Yours to read as your own — your provider, or a shared one, which is
     * everyone's. False is somebody ELSE's personal provider, which only an
     * administrator ever sees: it has no share for you, so its `yourQuota`
     * cells are null rather than a headroom figure you cannot spend.
     */
    ownedByMe: boolean;
    /**
     * Yours to CHANGE: admin on a shared provider, owner on a personal one —
     * the same rule `cms_provider_assert_manage` enforces. The screen greys
     * out what this refuses instead of arming a control the server will
     * reject after the form is filled in.
     */
    manageable: boolean;
    /**
     * Whose provider this is, written out — the display name, or the email,
     * or "user <id>" for a sparse row. Null on a shared provider, which is
     * everybody's and has no owner to name.
     */
    ownerLabel: string | null;
    periods: { day: UsageGridCell; week: UsageGridCell; month: UsageGridCell };
}

export interface DefaultTuple {
    provider: string | null;
    model: string | null;
    reasoning: string | null;
    context: string | null;
}

export interface SystemAgentModelOverride extends DefaultTuple {
    agentId: string;
    updatedBy: number;
    updatedAt: string;
}

export interface ProviderDefaults {
    cluster: DefaultTuple;
    mine: DefaultTuple;
    system: DefaultTuple;
    systemUpdatedBy: number | null;
    systemUpdatedAt: string | null;
}

export interface LegacyProviderMigrationStatus {
    regularKeys: number;
    migratedRegularKeys: number;
    systemKeyPresent: boolean;
    systemKeyAdopted: boolean;
}

export interface SystemRestartRolloutState {
    agentId: string;
    operationId: string;
    targetModel: string;
    targetReasoning: string | null;
    targetContext: string | null;
    disposition: "complete" | "terminate" | "hard_delete";
    status: "in_progress" | "failed" | "complete";
    claimedAt: string;
    completedAt: string | null;
    lastError: string | null;
}

export interface PausedSessionRow {
    sessionId: string;
    title: string | null;
    model: string | null;
    ownerUserId: number | null;
    ownerEmail: string | null;
    state: string;
    pause: Record<string, unknown> | null;
    updatedAt: string;
}

export interface UsageFilters {
    days?: number;
    ownerUserId?: number | null;
    provider?: string | null;
    model?: string | null;
    sessionId?: string | null;
    chargeClass?: ChargeClass | null;
}

export interface SettleTurnInput {
    sessionId: string;
    turnIndex: number;
    providerName: string | null;
    modelQualified: string | null;
    ownerUserId: number | null;
    chargeClass: ChargeClass;
    agentId?: string | null;
    tokensInput?: number;
    tokensOutput?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
}

/** What the runtime needs to actually talk to a provider's backend. */
export interface ProviderCredential {
    name: string;
    typeId: string;
    class: ProviderClass;
    ownerUserId: number | null;
    baseUrl: string | null;
    secretRef: Record<string, unknown>;
    systemUseEnabled?: boolean;
}

/**
 * What a caller may put in a credential, and what they may not.
 *
 * A credential that arrives in a request is a VALUE. The deployment's config
 * file may store a POINTER instead (`env:AZURE_KEY`, resolved against the
 * worker's own environment), and that indirection is safe only because the
 * deployment wrote it. Honouring it on a request let anyone with an account
 * name a variable — the cluster's API key, the database URL, anything the
 * worker holds — pair it with a base URL of their own, and have the worker
 * post that secret to them.
 *
 * So: one shape in, one shape stored. Every friendly spelling people
 * actually send (`{apiKey}`, `{githubToken}`, `{token}`, a bare string) is
 * accepted and stored as a literal under `value`. `ref` and `source` are
 * dropped, and a literal that looks like a pointer is refused outright
 * rather than silently stored as something that will never resolve.
 *
 * `requireFineGrainedGitHubToken` is the synchronous half of the
 * fine-grained GitHub token gate below: whichever field carries the key, it
 * must be a `github_pat_` token.
 *
 * A reference to an external secret (`kind: "externalSecret"`) is refused
 * too: only the store writes one, after it has stored the key itself.
 */
export function normalizeCallerSecret(
    input: Record<string, unknown> | string | null | undefined,
    options: { workloadIdentity?: boolean; requireFineGrainedGitHubToken?: boolean } = {},
): Record<string, unknown> {
    const raw = typeof input === "string" ? { value: input } : (input ?? {});

    if (typeof raw.kind === "string" && raw.kind.trim().toLowerCase() === EXTERNAL_SECRET_KIND.toLowerCase()) {
        throw new ProviderError(
            "PROVIDER_INVALID",
            "A credential must be the key itself. A reference to a secret store is written only by PilotSwarm, after it stores the key there.",
        );
    }

    // A workload-identity provider is credential-less by design. It stores a
    // marker rather than nothing at all, so the row is distinguishable from
    // one whose key was never set (`has_credential` is `secret_ref <> '{}'`).
    // Whatever the caller sent is DISCARDED rather than merged: this type has
    // no use for a key, and keeping one would leave a real secret sitting in
    // a row nothing ever reads it from.
    //
    // Only the CALLER'S OPTION reaches this, never anything in the blob. A
    // request that declares its own `kind` looked harmless — the provider
    // still runs only if its TYPE is a workload-identity type, decided from
    // the deployment's config file — but it is a way to write a
    // credential-less row on ANY type: on a create, a provider the portal
    // shows as credentialed (`has_credential` is `secret_ref <> '{}'`) that
    // can never run a turn; on an update, a real key silently REPLACED by a
    // marker, reported as a successful rotation. The type is known one layer
    // up, and that is the only place allowed to decide this.
    if (options.workloadIdentity) {
        return { kind: WORKLOAD_IDENTITY_KIND };
    }

    const isGithub = typeof raw.githubToken === "string" || raw.kind === "githubToken";
    const candidate = [raw.value, raw.apiKey, raw.githubToken, raw.token, raw.key]
        .find((v) => typeof v === "string" && v.length > 0);

    if (typeof candidate !== "string") {
        // A provider with no credential cannot run a single turn, and there
        // is no way to add one afterwards. Refusing here beats creating a
        // name that resolves to nothing and waits for ever.
        throw new ProviderError(
            "PROVIDER_INVALID",
            "A provider needs a credential: send the key itself, as apiKey for an API provider or githubToken for GitHub Copilot.",
        );
    }

    // Compared on a TRIMMED, case-folded copy: " Env:AZURE_KEY" is the same
    // pointer with a space in front of it, and a guard that misses it stores
    // a value that later resolves against the worker's own environment.
    if (candidate.trim().toLowerCase().startsWith("env:")) {
        throw new ProviderError(
            "PROVIDER_INVALID",
            "A credential must be the key itself, not a reference to one. Only the deployment's own configuration may point at an environment variable.",
        );
    }

    if (options.requireFineGrainedGitHubToken && !candidate.startsWith(FINE_GRAINED_GITHUB_TOKEN_PREFIX)) {
        const kind = GITHUB_TOKEN_KINDS.find(([prefix]) => candidate.startsWith(prefix))?.[1]
            ?? "not a GitHub personal access token";
        throw new ProviderError(
            "PROVIDER_INVALID",
            "This deployment accepts only fine-grained personal access tokens (github_pat_…) for GitHub providers, "
            + `and this key is ${kind}.`,
        );
    }

    const apiVersion = typeof raw.apiVersion === "string" ? { apiVersion: raw.apiVersion } : {};
    return { kind: isGithub ? "githubToken" : "apiKey", value: candidate, ...apiVersion };
}

// ── the fine-grained GitHub token gate ───────────────────────────
//
// With PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT on, a GitHub-type provider
// takes only a fine-grained personal access token that reaches no private
// or internal repository, expires within 30 days, and holds none of the
// account permissions that would let a stolen copy outlive it. The store
// knows a type only by its name, so the caller that holds the type catalog
// says when the gate applies (`requireFineGrainedGitHubToken`), exactly as
// it does for workload identity.

const FINE_GRAINED_GITHUB_TOKEN_SETTING = "PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT";
const FINE_GRAINED_GITHUB_TOKEN_PREFIX = "github_pat_";

/**
 * Is the fine-grained GitHub token gate on? Off unless set.
 *
 * `1`, `true`, `yes` and `on` turn it on; unset, empty, `0`, `false`, `no`
 * and `off` leave it off. Anything else throws rather than guessing: a typo
 * that quietly left a security gate off is the one outcome worse than a
 * refusal.
 */
export function requiresFineGrainedGitHubTokens(
    env: Record<string, string | undefined> = process.env,
): boolean {
    const value = String(env[FINE_GRAINED_GITHUB_TOKEN_SETTING] ?? "").trim().toLowerCase();
    if (["", "0", "false", "no", "off"].includes(value)) return false;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    throw new Error(`${FINE_GRAINED_GITHUB_TOKEN_SETTING} must be 1 or 0 (true/false, yes/no and on/off also work).`);
}

/** A refused token is named by its well-known prefix, never echoed. */
const GITHUB_TOKEN_KINDS: Array<[prefix: string, kind: string]> = [
    ["ghp_", "a classic personal access token (ghp_)"],
    ["gho_", "an OAuth app token (gho_)"],
    ["ghu_", "a GitHub App user token (ghu_)"],
    ["ghs_", "a GitHub App installation token (ghs_)"],
    ["ghr_", "a GitHub refresh token (ghr_)"],
];

/** How the gate reaches GitHub. Tests pass stand-ins, so nothing touches the network. */
export interface GitHubTokenCheckOptions {
    fetch?: typeof globalThis.fetch;
    /** Epoch milliseconds, for the expiry check. */
    now?: () => number;
    /** The bound on each request to GitHub. Default: 10 seconds. */
    timeoutMs?: number;
}

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REPOSITORY_PAGE_SIZE = 100;
const MAX_REPOSITORY_PAGES = 100;

/**
 * Account permissions the token must not hold. Sign-in and signing keys
 * outlive the token that added them; the others read private account data.
 * GitHub has no API that lists a fine-grained token's permissions, so each
 * one is probed, and the token's other account permissions stay unchecked.
 */
const REFUSED_ACCOUNT_PERMISSIONS: Array<[path: string, permission: string]> = [
    ["/user/keys", "Git SSH keys"],
    ["/user/gpg_keys", "GPG keys"],
    ["/user/ssh_signing_keys", "SSH signing keys"],
    ["/user/emails", "Email addresses"],
    ["/user/codespaces/secrets", "Codespaces user secrets"],
];

function refuseToken(message: string): never {
    throw new ProviderError("PROVIDER_INVALID", message);
}

/** Network-layer text, with the token cut out wherever it might appear. */
function withoutToken(text: string, token: string): string {
    const cut = token ? text.split(token).join("[redacted]") : text;
    return cut.replace(/\b(?:github_pat|gh[opusr])_[A-Za-z0-9_]+/g, "[redacted]");
}

function unanswered(err: any, token: string, timeoutMs: number): string {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no answer within ${timeoutMs} ms`;
    return withoutToken(String(err?.cause?.message ?? err?.message ?? err), token);
}

async function askGitHub(
    fetchImpl: typeof globalThis.fetch, path: string, token: string, timeoutMs: number,
): Promise<Response> {
    try {
        return await fetchImpl(`${GITHUB_API_URL}${path}`, {
            method: "GET",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "User-Agent": "PilotSwarm",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            // The token goes to GitHub's API and nowhere else.
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        refuseToken(`GitHub could not be reached to check the token (${unanswered(err, token, timeoutMs)}), so it was not saved. Try again.`);
    }
}

/** Free the connection behind an answer whose body is not needed. */
async function discard(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Nothing left to release.
    }
}

/** `GitHub-Authentication-Token-Expiration`, such as `2026-12-01 09:30:00 UTC`, in epoch ms. */
function parseGitHubTokenExpiry(value: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i
        .exec(value.trim());
    if (!m) return null;
    const [, year, month, day, hour, minute, second, zone = "UTC"] = m;
    const offsetMs = /^[+-]/.test(zone)
        ? (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000
        : 0;
    const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offsetMs;
    return Number.isFinite(at) ? at : null;
}

function expiryProblem(header: string | null, now: number): string | null {
    if (!header) return "GitHub reports no expiry for the token. Create one that expires within 30 days.";
    const expiresAt = parseGitHubTokenExpiry(header);
    if (expiresAt === null) return "GitHub's expiry for the token could not be read, so it was refused.";
    if (expiresAt - now <= MAX_TOKEN_LIFETIME_MS) return null;
    return `The token expires at ${new Date(expiresAt).toISOString()}, more than 30 days from now. `
        + `Create one that expires by ${new Date(now + MAX_TOKEN_LIFETIME_MS).toISOString()}.`;
}

/** GitHub's answer for a permission the token does not hold. A rate limit is not that answer. */
function permissionDenied(response: Response): boolean {
    if (![401, 403, 404].includes(response.status)) return false;
    return response.headers.get("x-ratelimit-remaining") !== "0" && !response.headers.has("retry-after");
}

/**
 * The asynchronous half of the gate: what GitHub says about the token.
 *
 * Every repository the token can list must be public, so it reaches no
 * private or internal one; GitHub must report an expiry at most 30 days
 * away; and none of the refused account permissions may answer. Each request
 * is bounded, and one that gets no usable answer refuses the token: a check
 * that could not be made is not a pass. A token that passes comes back with
 * the expiry GitHub reported.
 */
export async function checkFineGrainedGitHubToken(
    token: string,
    options: GitHubTokenCheckOptions = {},
): Promise<{ expiresOn: string }> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
    const ask = (path: string) => askGitHub(fetchImpl, path, token, timeoutMs);
    let expiresOn = "";

    for (let page = 1; ; page += 1) {
        if (page > MAX_REPOSITORY_PAGES) {
            refuseToken(`The token can list more than ${MAX_REPOSITORY_PAGES * REPOSITORY_PAGE_SIZE} repositories, too many to check, so it was refused.`);
        }
        const response = await ask(`/user/repos?visibility=all&per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`);
        if (!response.ok) {
            await discard(response);
            refuseToken(response.status === 401
                ? "GitHub does not accept the token (HTTP 401): it is wrong, expired or revoked."
                : `GitHub answered HTTP ${response.status} when listing the token's repositories, so it could not be checked. Try again.`);
        }
        if (page === 1) {
            const header = response.headers.get("github-authentication-token-expiration");
            const problem = expiryProblem(header, now());
            if (problem) {
                await discard(response);
                refuseToken(problem);
            }
            expiresOn = new Date(parseGitHubTokenExpiry(header!)!).toISOString();
        }
        let repositories: unknown = null;
        try {
            repositories = await response.json();
        } catch (err) {
            refuseToken(`GitHub's list of the token's repositories could not be read (${unanswered(err, token, timeoutMs)}), so it was refused.`);
        }
        if (!Array.isArray(repositories)) {
            refuseToken("GitHub's list of the token's repositories could not be read, so it was refused.");
        }
        // `visibility` is "public", "private" or "internal"; anything else,
        // missing included, is not public.
        if (repositories.some((repository: any) => repository?.visibility !== "public")) {
            refuseToken("The token can reach a repository that is not public. Create it with access to public repositories only.");
        }
        if (repositories.length < REPOSITORY_PAGE_SIZE) break;
    }

    const answers = await Promise.allSettled(REFUSED_ACCOUNT_PERMISSIONS.map(async ([path]) => {
        const response = await ask(path);
        await discard(response);
        return response;
    }));
    // A permission that answers is a definite refusal, so it is named ahead
    // of a probe that could not be made.
    answers.forEach((answer, i) => {
        if (answer.status === "fulfilled" && answer.value.ok) {
            refuseToken(`The token has the account permission "${REFUSED_ACCOUNT_PERMISSIONS[i][1]}". Create it without that permission.`);
        }
    });
    for (const answer of answers) {
        if (answer.status === "rejected") throw answer.reason;
        if (!permissionDenied(answer.value)) {
            refuseToken(`GitHub answered HTTP ${answer.value.status} when checking the token's account permissions, so it could not be checked. Try again.`);
        }
    }
    return { expiresOn };
}

const iso = (v: any): string | null =>
    v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v));

export interface ProviderStoreOptions {
    /** How the fine-grained GitHub token gate reaches GitHub. */
    gitHubTokenCheck?: GitHubTokenCheckOptions;
    /**
     * Where personal GitHub tokens go with PILOTSWARM_PERSONAL_SECRETS=external.
     * Only the portal has one; elsewhere, external mode refuses to save a
     * personal credential.
     */
    personalSecretStore?: PersonalSecretStore | null;
}

/** Set by the caller that holds the type catalog: does the gate apply to this credential? */
export interface CredentialGateOptions {
    requireFineGrainedGitHubToken?: boolean;
}

/**
 * What external mode needs to know about a personal credential, from the
 * caller that holds the type catalog and the signed-in principal.
 */
export interface PersonalCredentialContext {
    /** The provider's TYPE is a GitHub one (catalog `type: "github"`). The secret store holds only those. */
    gitHubType?: boolean;
    /** The owner's signed-in principal, which the secret store may record with the token. */
    owner?: { provider: string; subject: string } | null;
}

/** The secret store did not do what was asked. Its message is fixed text, safe to show. */
function secretStoreError(message: string, cause?: unknown): ProviderError {
    const error = new ProviderError("PROVIDER_SECRET_STORE_UNAVAILABLE", message);
    if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

export class ProviderStore {
    private personalSecretStore: PersonalSecretStore | null;

    constructor(
        private readonly pool: Pool,
        private readonly schema: string,
        private readonly options: ProviderStoreOptions = {},
    ) {
        this.personalSecretStore = options.personalSecretStore ?? null;
    }

    /** The store for personal tokens, for a host that builds this store before it has one. */
    setPersonalSecretStore(store: PersonalSecretStore | null): void {
        this.personalSecretStore = store;
    }

    private fn(name: string): string {
        return `"${this.schema}".${name}`;
    }

    /**
     * The fine-grained GitHub token gate, when the caller says it applies:
     * the prefix first, then GitHub's answers, and nothing written until both
     * pass. Off, it costs nothing. Returns the token's expiry when checked.
     */
    private async assertFineGrainedGitHubToken(
        secretRef: Record<string, unknown> | null | undefined,
        gate: CredentialGateOptions | undefined,
    ): Promise<string | null> {
        if (!gate?.requireFineGrainedGitHubToken) return null;
        const { value } = normalizeCallerSecret(secretRef, { requireFineGrainedGitHubToken: true });
        return (await checkFineGrainedGitHubToken(String(value), this.options.gitHubTokenCheck)).expiresOn;
    }

    /**
     * External mode: check the token as the caller asked, store it in the
     * secret store, and return the reference the row will keep instead.
     * Nothing reaches the database here.
     */
    private async putPersonalSecret(input: {
        name: string;
        actor: number;
        secretRef: Record<string, unknown> | null | undefined;
        gate: CredentialGateOptions & PersonalCredentialContext;
        previous: ExternalSecretRef | null;
    }): Promise<ExternalSecretRef> {
        const store = this.personalSecretStore;
        if (!store) {
            throw new ProviderError(
                "PROVIDER_FORBIDDEN",
                "This deployment keeps personal credentials in its secret store, which only the portal can write. "
                + "Add or update the provider in the portal.",
            );
        }
        if (!input.gate.gitHubType) {
            throw new ProviderError(
                "PROVIDER_INVALID",
                "This deployment keeps personal credentials in its secret store, which holds GitHub tokens only. "
                + "Ask an administrator for a shared provider of this type.",
            );
        }
        const { value } = normalizeCallerSecret(input.secretRef, {
            requireFineGrainedGitHubToken: input.gate.requireFineGrainedGitHubToken,
        });
        const expiresOn = await this.assertFineGrainedGitHubToken(input.secretRef, input.gate);
        let written: Awaited<ReturnType<PersonalSecretStore["put"]>>;
        try {
            written = await store.put({
                provider: input.name,
                owner: {
                    userId: input.actor,
                    principal: input.gate.owner?.provider && input.gate.owner?.subject
                        ? { provider: input.gate.owner.provider, subject: input.gate.owner.subject }
                        : null,
                },
                token: String(value),
                expiresOn,
                previous: input.previous,
            });
        } catch (err) {
            throw secretStoreError("The secret store did not store the token, so nothing was saved. Try again.", err);
        }
        const ref = externalSecretRef({
            ...written,
            kind: EXTERNAL_SECRET_KIND,
            expiresOn: written?.expiresOn ?? expiresOn,
        });
        if (!ref) {
            throw secretStoreError("The secret store did not return a complete reference to the token, so nothing was saved.");
        }
        return ref;
    }

    /** Best effort: a secret nothing references any more. */
    private async discardPersonalSecret(ref: ExternalSecretRef): Promise<void> {
        try {
            await this.personalSecretStore?.delete(ref);
        } catch (err: any) {
            console.warn(`[ProviderStore] could not delete the unused secret ${ref.name}: ${String(err?.message ?? err)}`);
        }
    }

    private async createExternalPersonalProvider(
        input: Parameters<ProviderStore["createProvider"]>[0],
        actor: number | null,
        isAdmin: boolean,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        if (actor === null) {
            throw new ProviderError("PROVIDER_FORBIDDEN", "sign in to add a provider of your own");
        }
        const ref = await this.putPersonalSecret({
            name: input.name,
            actor,
            secretRef: input.secretRef,
            gate: input,
            previous: null,
        });
        try {
            const rows = await this.call(
                `SELECT * FROM ${this.fn("cms_provider_create")}($1,$2,$3,$4,$5,$6,$7,$8)`,
                [input.name, input.typeId, input.class, input.ownerUserId ?? null,
                    JSON.stringify(ref), input.baseUrl ?? null, actor, isAdmin]);
            const r = rows[0] ?? {};
            return { name: r.name, typeId: r.type_id, class: r.class };
        } catch (err) {
            await this.discardPersonalSecret(ref);
            throw err;
        }
    }

    private async updateExternalPersonalCredential(
        name: string,
        secretRef: Record<string, unknown> | null | undefined,
        actor: number | null,
        gate: CredentialGateOptions & PersonalCredentialContext,
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        if (actor === null) {
            throw new ProviderError("PROVIDER_FORBIDDEN", "sign in to update a provider of your own");
        }
        // The same refusal the update procedure gives, before anything is stored.
        const current = await this.getCredential(name, actor);
        if (!current || current.class !== "personal" || current.ownerUserId !== actor) {
            throw new ProviderError("PROVIDER_NOT_FOUND", `there is no provider named "${name}"`);
        }
        const previous = externalSecretRef(current.secretRef);
        const ref = await this.putPersonalSecret({ name, actor, secretRef, gate, previous });
        const sameSecret = previous !== null && previous.store === ref.store && previous.name === ref.name;
        let rows: any[];
        try {
            rows = await this.call(
                `SELECT * FROM ${this.fn("cms_provider_update_personal_credential")}($1,$2,$3)`,
                [name, JSON.stringify(ref), actor]);
        } catch (err) {
            // A new version of the row's own secret is harmless: the row
            // still names the version it had.
            if (!sameSecret) await this.discardPersonalSecret(ref);
            throw err;
        }
        if (previous && !sameSecret) await this.discardPersonalSecret(previous);
        const r = rows[0] ?? {};
        return { name: r.name, typeId: r.type_id, class: r.class };
    }

    /**
     * Delete a provider whose token is in the secret store, and the token
     * with it. The row goes in a transaction that commits only once the
     * store has deleted the secret, so a failure keeps both.
     */
    private async deleteProviderWithSecret(
        name: string, actor: number | null, isAdmin: boolean, ref: ExternalSecretRef,
    ): Promise<number> {
        const store = this.personalSecretStore;
        if (!store) {
            throw new ProviderError(
                "PROVIDER_FORBIDDEN",
                `Provider "${name}" keeps its key in the deployment's secret store, which only the portal can reach. Delete it in the portal.`,
            );
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            let waiting: number;
            try {
                const { rows } = await client.query(
                    `SELECT ${this.fn("cms_provider_delete")}($1,$2,$3) AS waiting`, [name, actor, isAdmin]);
                waiting = Number(rows[0]?.waiting ?? 0);
            } catch (err) {
                rethrow(err);
            }
            try {
                await store.delete(ref);
            } catch (err) {
                throw secretStoreError(
                    `The secret store did not delete the key of provider "${name}", so the provider was kept. Try again.`, err);
            }
            await client.query("COMMIT");
            return waiting;
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    private async call(sql: string, params: any[] = []): Promise<any[]> {
        try {
            const { rows } = await this.pool.query(sql, params);
            return rows;
        } catch (err) {
            return rethrow(err);
        }
    }

    // ── identity ─────────────────────────────────────────────────────

    /**
     * Principal → user id, WITHOUT creating the row. Everything here takes a
     * numeric actor; this is the only translation point, and it deliberately
     * returns null for someone who has never signed in rather than minting a
     * user as a side effect of a read.
     */
    async lookupUserId(principal: { provider: string; subject: string } | null | undefined): Promise<number | null> {
        if (!principal?.provider || !principal?.subject) return null;
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_user_id")}($1, $2) AS user_id`,
            [principal.provider, principal.subject]);
        const id = rows[0]?.user_id;
        return id === null || id === undefined ? null : Number(id);
    }

    /**
     * Who owns this session, and is it machinery? Settlement needs both, and
     * the turn activity carries neither — it knows a session id and a model
     * reference, nothing about people. Reading them here keeps the two facts
     * in the one place that already decides charging, rather than threading
     * a principal through the whole turn path so it can be re-derived.
     */
    async sessionChargeFacts(
        sessionId: string,
    ): Promise<{ ownerUserId: number | null; isSystem: boolean }> {
        const rows = await this.call(
            `SELECT so.user_id AS owner_user_id, COALESCE(ss.is_system, FALSE) AS is_system
               FROM "${this.schema}".sessions ss
               LEFT JOIN "${this.schema}".session_owners so ON so.session_id = ss.session_id
              WHERE ss.session_id = $1`,
            [sessionId]);
        const r = rows[0];
        return {
            ownerUserId: r?.owner_user_id === null || r?.owner_user_id === undefined
                ? null : Number(r.owner_user_id),
            isSystem: r?.is_system === true,
        };
    }

    // ── the runtime pair ─────────────────────────────────────────────

    /** The admission call. One round trip, made once per turn. */
    async checkTurn(sessionId: string, model?: string | null): Promise<TurnAdmission> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_check_turn")}($1, $2)`,
            [sessionId, model ?? null]);
        return toTurnAdmission(rows[0] ?? {});
    }

    /**
     * The next free settlement index for a session, across every lifetime
     * the ledger has seen. The ledger PK (session_id, turn_index) is the
     * exactly-once claim; a fresh orchestration for a RETAINED session id
     * (system restart) must count from here or settle silently drops its
     * spend as "already settled".
     */
    async nextLedgerTurnIndex(sessionId: string): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_next_turn_index")}($1) AS next`, [sessionId]);
        return Number(rows[0]?.next ?? 0);
    }

    /**
     * Advance the session's ledger base past every row the session id has,
     * so a fresh orchestration lifetime (system restart) settles on new
     * keys instead of silently colliding with the old lifetime's.
     */
    async bumpLedgerBase(sessionId: string): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_bump_ledger_base")}($1) AS base`, [sessionId]);
        return Number(rows[0]?.base ?? 0);
    }

    /** Settlement. Returns false when this turn was already settled. */
    async settleTurn(input: SettleTurnInput): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_settle_turn")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
            [
                input.sessionId, input.turnIndex, input.providerName ?? null,
                input.modelQualified ?? null, input.ownerUserId ?? null,
                input.chargeClass ?? "user", input.agentId ?? null,
                Math.max(0, Math.trunc(input.tokensInput ?? 0)),
                Math.max(0, Math.trunc(input.tokensOutput ?? 0)),
                Math.max(0, Math.trunc(input.tokensCacheRead ?? 0)),
                Math.max(0, Math.trunc(input.tokensCacheWrite ?? 0)),
            ]);
        return rows[0]?.first === true;
    }

    // ── reads ────────────────────────────────────────────────────────

    async listProviders(viewer: number | null, isAdmin: boolean): Promise<ProviderRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_list")}($1, $2)`, [viewer, isAdmin]);
        return rows.map((r) => ({
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            ownerEmail: r.owner_email ?? null,
            ownerDisplayName: r.owner_display_name ?? null,
            baseUrl: r.base_url ?? null,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            hasCredential: r.has_credential === true,
            usableByMe: r.usable_by_me === true,
            systemUseEnabled: r.system_use_enabled === true,
            systemEligible: r.system_eligible === true,
            isClusterDefault: r.is_cluster_default === true,
            isMyDefault: r.is_my_default === true,
            isSystemDefault: r.is_system_default === true,
            ruleCount: Number(r.rule_count ?? 0),
            createdAt: iso(r.created_at) ?? "",
        }));
    }

    async providerStatus(
        viewer: number | null, isAdmin: boolean, names?: string[] | null,
    ): Promise<ProviderStatusRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_status")}($1, $2, $3)`,
            [viewer, isAdmin, names && names.length ? names : null]);
        return rows.map((r) => ({
            name: r.name,
            class: r.class as ProviderClass,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            rules: (Array.isArray(r.rules) ? r.rules : []).map((x: any) => ({
                ruleId: String(x.ruleId),
                providerName: r.name,
                period: x.period as BudgetPeriod,
                modelQualified: x.modelQualified ?? null,
                limitTokens: Number(x.limitTokens ?? 0),
                usedTokens: Number(x.usedTokens ?? 0),
                ceilingTokens: x.ceilingTokens === null || x.ceilingTokens === undefined
                    ? null : Number(x.ceilingTokens),
                yourUsedTokens: x.yourUsedTokens === null || x.yourUsedTokens === undefined
                    ? null : Number(x.yourUsedTokens),
                windowStartUtc: String(x.windowStartUtc),
                resetsAtUtc: String(x.resetsAtUtc),
            })),
        }));
    }

    /**
     * Everything the provider table draws, in one call.
     *
     * Rows arrive in the order the table renders them: shared providers
     * first, then your own, each immediately followed by its model rows. The
     * caller does not sort and does not make a second call per provider.
     */
    async usageGrid(viewer: number | null, isAdmin: boolean): Promise<UsageGridRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_grid")}($1, $2)`, [viewer, isAdmin]);
        const cell = (x: any): UsageGridCell => ({
            ruleId: x?.ruleId ?? null,
            quotaTokens: x?.quotaTokens === null || x?.quotaTokens === undefined
                ? null : Number(x.quotaTokens),
            usedTokens: Number(x?.usedTokens ?? 0),
            yourQuotaTokens: x?.yourQuotaTokens === null || x?.yourQuotaTokens === undefined
                ? null : Number(x.yourQuotaTokens),
            // Null stays null. Nobody signed in is not the same fact as zero
            // spent, and the table says the two differently.
            yourUsedTokens: x?.yourUsedTokens === null || x?.yourUsedTokens === undefined
                ? null : Number(x.yourUsedTokens),
            windowStartUtc: String(x?.windowStartUtc ?? ""),
            inputTokens: Number(x?.inputTokens ?? 0),
            outputTokens: Number(x?.outputTokens ?? 0),
            cacheReadTokens: Number(x?.cacheReadTokens ?? 0),
            cacheWriteTokens: Number(x?.cacheWriteTokens ?? 0),
            yourInputTokens: x?.yourInputTokens === null || x?.yourInputTokens === undefined ? null : Number(x.yourInputTokens),
            yourOutputTokens: x?.yourOutputTokens === null || x?.yourOutputTokens === undefined ? null : Number(x.yourOutputTokens),
            yourCacheReadTokens: x?.yourCacheReadTokens === null || x?.yourCacheReadTokens === undefined ? null : Number(x.yourCacheReadTokens),
            yourCacheWriteTokens: x?.yourCacheWriteTokens === null || x?.yourCacheWriteTokens === undefined ? null : Number(x.yourCacheWriteTokens),
            resetsAtUtc: String(x?.resetsAtUtc ?? ""),
        });
        return rows.map((r) => ({
            providerName: r.provider_name,
            rowKind: r.row_kind as "provider" | "model",
            scope: r.scope,
            class: r.class as ProviderClass,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            modelRowCount: Number(r.model_row_count ?? 0),
            ownedByMe: r.owned_by_me !== false,
            manageable: r.manageable === true,
            ownerLabel: r.owner_label ?? null,
            periods: {
                day: cell(r.periods?.day),
                week: cell(r.periods?.week),
                month: cell(r.periods?.month),
            },
        }));
    }

    /**
     * The credential the runtime should use, resolved by NAME in the session
     * owner's namespace — the same resolution the gate made, so accounting
     * and the actual API call can never name different credentials.
     */
    /**
     * Every provider with its credential, for the worker's own runtime
     * catalog. Not a viewer-scoped read and never shown to anyone: a worker
     * runs turns for everybody, and what a person may spend from is settled
     * by the admission gate long before a credential is reached for. A token
     * kept in the secret store comes back as its reference alone.
     */
    async allCredentials(): Promise<ProviderCredential[]> {
        const rows = await this.call(
                `SELECT name, type_id, class, owner_user_id, base_url, secret_ref, system_use_enabled
                    FROM "${this.schema}".provider_instances ORDER BY created_at, name`);
        return rows.map((r) => ({
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: withoutSecretValues((r.secret_ref ?? {}) as Record<string, unknown>),
            systemUseEnabled: r.system_use_enabled === true,
        }));
    }

    async getCredential(name: string, viewer: number | null): Promise<ProviderCredential | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_in_namespace")}($1, $2)`, [name, viewer]);
        const r = rows[0];
        if (!r) return null;
        return {
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: withoutSecretValues((r.secret_ref ?? {}) as Record<string, unknown>),
        };
    }

    async getSystemCredential(name: string): Promise<ProviderCredential | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_for_system")}($1)`, [name]);
        const r = rows[0];
        if (!r) return null;
        return {
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: withoutSecretValues((r.secret_ref ?? {}) as Record<string, unknown>),
            systemUseEnabled: true,
        };
    }

    async getDefaults(actor: number | null): Promise<ProviderDefaults> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_get_defaults")}($1)`, [actor]);
        const r = rows[0] ?? {};
        return {
            cluster: {
                provider: r.cluster_provider ?? null, model: r.cluster_model ?? null,
                reasoning: r.cluster_reasoning ?? null, context: r.cluster_context ?? null,
            },
            mine: {
                provider: r.my_provider ?? null, model: r.my_model ?? null,
                reasoning: r.my_reasoning ?? null, context: r.my_context ?? null,
            },
            system: {
                provider: r.system_provider ?? null, model: r.system_model ?? null,
                reasoning: r.system_reasoning ?? null, context: r.system_context ?? null,
            },
            systemUpdatedBy: r.system_updated_by === null || r.system_updated_by === undefined
                ? null : Number(r.system_updated_by),
            systemUpdatedAt: iso(r.system_updated_at),
        };
    }

    async listSystemAgentModels(): Promise<SystemAgentModelOverride[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_list_system_agent_models")}()`);
        return rows.map((r) => ({
            agentId: r.agent_id,
            provider: r.provider_name,
            model: r.model_qualified,
            reasoning: r.reasoning_effort ?? null,
            context: r.context_tier ?? null,
            updatedBy: Number(r.updated_by),
            updatedAt: iso(r.updated_at) ?? "",
        }));
    }

    async listPaused(viewer: number | null, isAdmin: boolean, limit = 100, clusterScoped = false): Promise<PausedSessionRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn(clusterScoped ? "cms_provider_list_paused_cluster" : "cms_provider_list_paused")}($1, $2, $3)`, [viewer, isAdmin, limit]);
        return rows.map((r) => ({
            sessionId: r.session_id,
            title: r.title ?? null,
            model: r.model ?? null,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            ownerEmail: r.owner_email ?? null,
            state: r.state,
            pause: r.pause_state ?? null,
            updatedAt: iso(r.updated_at) ?? "",
        }));
    }

    /** Which sessions are waiting on this provider — the wake query. */
    async pausedFor(name: string): Promise<string[]> {
        const rows = await this.call(
            `SELECT session_id FROM ${this.fn("cms_provider_paused_for")}($1)`, [name]);
        return rows.map((r) => r.session_id);
    }

    // ── usage reporting ──────────────────────────────────────────────

    private usageArgs(viewer: number | null, isAdmin: boolean, f: UsageFilters): any[] {
        return [
            viewer, isAdmin, f.days ?? 7, f.ownerUserId ?? null, f.provider ?? null,
            f.model ?? null, f.sessionId ?? null, f.chargeClass ?? null,
        ];
    }

    async usageTotals(viewer: number | null, isAdmin: boolean, f: UsageFilters = {}) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_totals")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            this.usageArgs(viewer, isAdmin, f));
        const r = rows[0] ?? {};
        return {
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
            sessions: Number(r.sessions ?? 0),
        };
    }

    async usageDaily(viewer: number | null, isAdmin: boolean, f: UsageFilters = {}) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_daily")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            this.usageArgs(viewer, isAdmin, f));
        return rows.map((r) => ({
            dayUtc: iso(r.day_utc)?.slice(0, 10) ?? "",
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
            // The four parts of tokensTotal (0069).
            tokensInput: Number(r.tokens_input ?? 0),
            tokensOutput: Number(r.tokens_output ?? 0),
            tokensCacheRead: Number(r.tokens_cache_read ?? 0),
            tokensCacheWrite: Number(r.tokens_cache_write ?? 0),
        }));
    }

    async usageBreakdown(
        viewer: number | null, isAdmin: boolean,
        dimension: "session" | "user" | "provider" | "model" | "agent",
        f: UsageFilters = {}, limit = 40, clusterScoped = false,
    ) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn(clusterScoped ? "cms_provider_usage_breakdown_cluster" : "cms_provider_usage_breakdown")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [...this.usageArgs(viewer, isAdmin, f), dimension, limit]);
        return rows.map((r) => ({
            key: r.key,
            label: r.label,
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
        }));
    }

    /**
     * The cluster summary: today / week / month totals, a per-UTC-day series
     * and the per-MODEL pivot, all from the ledger over one scope and one
     * provider filter. An admin sees the cluster; anyone else their own
     * turns. `providers` empty or absent means every provider.
     */
    async usageSummary(
        viewer: number | null, isAdmin: boolean, days = 14, providers: string[] | null = null,
    ): Promise<Record<string, unknown>> {
        const names = Array.isArray(providers)
            ? providers.map((p) => String(p ?? "").trim()).filter(Boolean)
            : [];
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_usage_summary")}($1,$2,$3,$4) AS summary`,
            [viewer, isAdmin, days, names.length ? names : null]);
        const summary = rows[0]?.summary;
        return summary && typeof summary === "object" ? summary : {};
    }

    /**
     * The agent pivot over the same ledger rows and viewer scope as
     * usageSummary: per-agent aggregates (models, per-day sparkline) plus a
     * flat day×agent series for the stacked chart. '(none)' collects turns
     * from sessions bound to no agent.
     */
    async usageAgents(
        viewer: number | null, isAdmin: boolean, days = 14, providers: string[] | null = null,
        clusterScoped = false,
    ): Promise<Record<string, unknown>> {
        const names = Array.isArray(providers)
            ? providers.map((p) => String(p ?? "").trim()).filter(Boolean)
            : [];
        const rows = await this.call(
            `SELECT ${this.fn(clusterScoped ? "cms_provider_usage_agents_cluster" : "cms_provider_usage_agents")}($1,$2,$3,$4) AS agents`,
            [viewer, isAdmin, days, names.length ? names : null]);
        const agents = rows[0]?.agents;
        return agents && typeof agents === "object" ? agents : {};
    }

    // ── management ───────────────────────────────────────────────────

    async createProvider(input: {
        name: string; typeId: string; class: ProviderClass;
        ownerUserId?: number | null; secretRef?: Record<string, unknown> | null; baseUrl?: string | null;
        /**
         * The type authenticates as the worker, so no credential is required
         * and none is kept. Decided by the caller, which is the layer that
         * holds the type catalog; the store only knows a type by its name.
         */
        workloadIdentity?: boolean;
        /**
         * The credential must pass the fine-grained GitHub token gate: the
         * type is a GitHub one and the deployment requires the gate. Decided
         * by the caller for the same reason.
         */
        requireFineGrainedGitHubToken?: boolean;
    } & PersonalCredentialContext, actor: number | null, isAdmin: boolean): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        if (input.class === "personal" && !input.workloadIdentity && personalSecretsMode() === "external") {
            return this.createExternalPersonalProvider(input, actor, isAdmin);
        }
        await this.assertFineGrainedGitHubToken(input.secretRef, {
            requireFineGrainedGitHubToken: input.requireFineGrainedGitHubToken,
        });
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_create")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            [input.name, input.typeId, input.class, input.ownerUserId ?? null,
                JSON.stringify(normalizeCallerSecret(input.secretRef, { workloadIdentity: input.workloadIdentity })),
                input.baseUrl ?? null, actor, isAdmin]);
        const r = rows[0] ?? {};
        return { name: r.name, typeId: r.type_id, class: r.class };
    }

    async updatePersonalCredential(
        name: string,
        secretRef: Record<string, unknown> | null | undefined,
        actor: number | null,
        gate: CredentialGateOptions & PersonalCredentialContext = {},
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        if (personalSecretsMode() === "external") {
            return this.updateExternalPersonalCredential(name, secretRef, actor, gate);
        }
        await this.assertFineGrainedGitHubToken(secretRef, gate);
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_update_personal_credential")}($1,$2,$3)`,
            [name, JSON.stringify(normalizeCallerSecret(secretRef)), actor]);
        const r = rows[0] ?? {};
        return { name: r.name, typeId: r.type_id, class: r.class };
    }

    /**
     * Rotate a SHARED provider's key. Admin-only, enforced in SQL by the same
     * manage gate every other shared mutation uses.
     *
     * Merges rather than replaces, like the personal path: the caller is a
     * credential form and sends one field, so anything else stored in the blob
     * (apiVersion, and whatever is added later) has to survive.
     */
    async updateSharedCredential(
        name: string,
        secretRef: Record<string, unknown> | null | undefined,
        actor: number | null,
        isAdmin: boolean,
        gate: CredentialGateOptions = {},
    ): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        await this.assertFineGrainedGitHubToken(secretRef, gate);
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_update_shared_credential")}($1,$2,$3,$4)`,
            [name, JSON.stringify(normalizeCallerSecret(secretRef)), actor, isAdmin]);
        const r = rows[0] ?? {};
        return { name: r.name, typeId: r.type_id, class: r.class };
    }

    /**
     * Returns how many sessions now name a provider that no longer exists.
     * A provider whose token is in the secret store takes the token with it.
     */
    async deleteProvider(name: string, actor: number | null, isAdmin: boolean): Promise<number> {
        // Read only where a secret could be: with a store, or in external mode.
        if (this.personalSecretStore || personalSecretsMode() === "external") {
            const ref = externalSecretRef((await this.getCredential(name, actor))?.secretRef);
            if (ref) return this.deleteProviderWithSecret(name, actor, isAdmin, ref);
        }
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_delete")}($1,$2,$3) AS waiting`, [name, actor, isAdmin]);
        return Number(rows[0]?.waiting ?? 0);
    }

    async clearRoutingDependencies(
        name: string, actor: number | null, isAdmin: boolean,
    ): Promise<{ clusterDefault: number; systemDefault: number; userDefaults: number; systemOverrides: number }> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_clear_routing_dependencies")}($1,$2,$3) AS result`,
            [name, actor, isAdmin]);
        const result = rows[0]?.result ?? {};
        return {
            clusterDefault: Number(result.clusterDefault ?? 0),
            systemDefault: Number(result.systemDefault ?? 0),
            userDefaults: Number(result.userDefaults ?? 0),
            systemOverrides: Number(result.systemOverrides ?? 0),
        };
    }

    async claimSystemRestart(input: {
        agentId: string; operationId: string; claimId: string;
        model: string; reasoning?: string | null; context?: string | null;
        disposition: "complete" | "terminate" | "hard_delete";
    }): Promise<"claimed" | "busy" | "complete"> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_claim_system_restart")}($1,$2,$3,$4,$5,$6,$7) AS result`,
            [input.agentId, input.operationId, input.claimId, input.model,
                input.reasoning ?? null, input.context ?? null, input.disposition]);
        return rows[0]?.result;
    }

    async finishSystemRestart(agentId: string, claimId: string, error?: string | null): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_finish_system_restart")}($1,$2,$3) AS finished`,
            [agentId, claimId, error ?? null]);
        return rows[0]?.finished === true;
    }

    async getSystemRestart(agentId: string): Promise<SystemRestartRolloutState | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_get_system_restart")}($1)`, [agentId]);
        const row = rows[0];
        if (!row) return null;
        return {
            agentId: row.agent_id,
            operationId: row.operation_id,
            targetModel: row.target_model,
            targetReasoning: row.target_reasoning ?? null,
            targetContext: row.target_context ?? null,
            disposition: row.disposition,
            status: row.status,
            claimedAt: iso(row.claimed_at) ?? "",
            completedAt: iso(row.completed_at),
            lastError: row.last_error ?? null,
        };
    }

    async setSystemUse(
        name: string, enabled: boolean, actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_set_system_use")}($1,$2,$3,$4) AS enabled`,
            [name, enabled, actor, isAdmin]);
        return rows[0]?.enabled === true;
    }

    /**
     * Save a limit. Nothing is seeded and nothing is reset — the meter this
     * limit reads has been counting since the provider's first turn.
     *
     * `seededTokens` is what the new limit ALREADY counts in the current
     * period: a read of that meter, so the editor can warn that sessions will
     * pause on their next turn. The name is the old one, kept because four
     * other surfaces send it over the wire.
     */
    async setLimit(input: {
        name: string; period: BudgetPeriod; modelQualified?: string | null; limitTokens: number;
    }, actor: number | null, isAdmin: boolean): Promise<{ ruleId: string; seededTokens: number }> {
        const ruleId = `pbr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_set_limit")}($1,$2,$3,$4,$5,$6,$7)`,
            [input.name, input.period, input.modelQualified ?? null, input.limitTokens, ruleId, actor, isAdmin]);
        const r = rows[0] ?? {};
        return { ruleId: r.rule_id, seededTokens: Number(r.seeded_tokens ?? 0) };
    }

    async removeLimit(
        name: string, period: BudgetPeriod, modelQualified: string | null,
        actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_remove_limit")}($1,$2,$3,$4,$5) AS removed`,
            [name, period, modelQualified ?? null, actor, isAdmin]);
        return rows[0]?.removed === true;
    }

    async setAllowance(name: string, pct: number, actor: number | null, isAdmin: boolean): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_set_allowance")}($1,$2::smallint,$3,$4) AS pct`,
            [name, pct, actor, isAdmin]);
        return Number(rows[0]?.pct ?? pct);
    }

    async setHold(
        name: string, opts: { untilUtc?: string | null; indefinite?: boolean },
        actor: number | null, isAdmin: boolean,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_hold")}($1,$2,$3,$4,$5)`,
            [name, opts.untilUtc ?? null, opts.indefinite === true, actor, isAdmin]);
    }

    async setClusterDefault(t: DefaultTuple, isAdmin: boolean): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_cluster_default")}($1,$2,$3,$4,$5)`,
            [t.provider, t.model, t.reasoning ?? null, t.context ?? null, isAdmin]);
    }

    async setUserDefault(actor: number | null, t: DefaultTuple): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_user_default")}($1,$2,$3,$4,$5)`,
            [actor, t.provider, t.model, t.reasoning ?? null, t.context ?? null]);
    }

    async setSystemDefault(
        actor: number | null, isAdmin: boolean, t: DefaultTuple,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_system_default")}($1,$2,$3,$4,$5,$6)`,
            [t.provider, t.model, t.reasoning ?? null, t.context ?? null, actor, isAdmin]);
    }

    async setSystemAgentModel(
        agentId: string, actor: number | null, isAdmin: boolean, t: DefaultTuple,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_system_agent_model")}($1,$2,$3,$4,$5,$6,$7)`,
            [agentId, t.provider, t.model, t.reasoning ?? null, t.context ?? null, actor, isAdmin]);
    }

    async clearSystemAgentModel(
        agentId: string, actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_clear_system_agent_model")}($1,$2,$3) AS cleared`,
            [agentId, actor, isAdmin]);
        return rows[0]?.cleared === true;
    }

    async adoptLegacySystemGitHubKey(
        name: string, actor: number | null, isAdmin: boolean,
    ): Promise<{ name: string; typeId: string; class: ProviderClass; ownerUserId: number | null }> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_adopt_system_github_key")}($1,$2,$3,$4)`,
            [name, name, actor, isAdmin]);
        const row = rows[0] ?? {};
        return {
            name: row.name,
            typeId: row.type_id,
            class: row.class as ProviderClass,
            ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined
                ? null : Number(row.owner_user_id),
        };
    }

    async getLegacyKeyMigrationStatus(): Promise<LegacyProviderMigrationStatus> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_legacy_key_migration_status")}()`);
        const row = rows[0] ?? {};
        return {
            regularKeys: Number(row.regular_keys ?? 0),
            migratedRegularKeys: Number(row.migrated_regular_keys ?? 0),
            systemKeyPresent: row.system_key_present === true,
            systemKeyAdopted: row.system_key_adopted === true,
        };
    }

    /**
     * The deployment seed. Safe to call on every boot: the claim is atomic
     * and only the first caller on a fresh cluster does anything.
     */
    async bootstrap(
        instances: Array<{ name: string; typeId: string; secretRef?: Record<string, unknown>; baseUrl?: string | null }>,
        defaults: DefaultTuple | null,
    ): Promise<{ claimed: boolean; created: number }> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_bootstrap")}($1::jsonb, $2::jsonb)`,
            [JSON.stringify(instances ?? []), defaults ? JSON.stringify(defaults) : null]);
        const r = rows[0] ?? {};
        return { claimed: r.claimed === true, created: Number(r.created ?? 0) };
    }
}
