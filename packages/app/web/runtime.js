import { NodeSdkTransport } from "pilotswarm/host";
import {
    factsManagerPrefixFor,
    personalSecretsMode,
    requiresFineGrainedGitHubTokens,
    resolveSessionMessageScope,
    secretRedactionEnabled,
} from "pilotswarm-sdk";
import { adminCanAccessResource, adminCapabilities, ADMIN_SCOPE_POLICY_VERSION } from "pilotswarm-sdk/api";
import { projectFleetAccounting, projectUserAccounting, projectAgentWorkerState, projectWorker } from "pilotswarm-sdk/api";
import {
    loadAuthzConfig,
    normalizeVisibility,
    getMethodAccess,
    evaluateSessionAccess,
    relationFor,
    forbiddenError,
    notFoundError,
    isDispatcherPrincipal,
    parseOnBehalfOfOwner,
    delegationRevokedError,
    auditUnavailableError,
} from "./authz.js";

/**
 * Agent-package copy selector off the wire ({scope, ownerProvider,
 * ownerSubject}) — which same-named copy an op targets. `scopeless` drops the
 * scope field for ops where `scope` means something else (setAgentPackageScope's
 * TARGET). Authorization stays in the registry procs, which re-check the
 * RESOLVED row against the actor.
 */
function packageSelectorParams(params, opts = {}) {
    const scope = params?.scope === "shared" || params?.scope === "user" ? params.scope : null;
    const provider = typeof params?.ownerProvider === "string" && params.ownerProvider.trim() ? params.ownerProvider.trim() : null;
    const subject = typeof params?.ownerSubject === "string" && params.ownerSubject.trim() ? params.ownerSubject.trim() : null;
    const selector = {
        ...(!opts.scopeless && scope ? { scope } : {}),
        ...(provider && subject ? { ownerProvider: provider, ownerSubject: subject } : {}),
    };
    return Object.keys(selector).length > 0 ? selector : null;
}

function normalizeParams(params) {
    return params && typeof params === "object" ? params : {};
}

function clampInteger(value, defaultValue, min, max) {
    if (value == null) return defaultValue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultValue;
    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function normalizeSessionPageOptions(params) {
    const limit = clampInteger(params.limit, 50, 1, 200);
    const includeDeleted = params.includeDeleted === true;
    const systemFilter = params.systemFilter == null ? "all" : String(params.systemFilter);
    if (!new Set(["all", "only", "exclude"]).has(systemFilter)) {
        throw new Error("listSessionsPage systemFilter must be one of: all, only, exclude");
    }
    if (params.cursor != null && typeof params.cursor !== "object") {
        throw new Error("listSessionsPage cursor must be an object when provided");
    }
    const rawCursor = params.cursor ?? null;
    let cursor = null;

    if (rawCursor) {
        const updatedAt = Number(rawCursor.updatedAt);
        const sessionId = String(rawCursor.sessionId || "").trim();
        if (!Number.isFinite(updatedAt)) {
            throw new Error("listSessionsPage cursor.updatedAt must be a finite number");
        }
        if (!sessionId) {
            throw new Error("listSessionsPage cursor.sessionId must be a non-empty string");
        }
        cursor = { updatedAt, sessionId };
    }

    return { limit, cursor, includeDeleted, systemFilter };
}

function normalizeTopEventEmitterOptions(params) {
    if (params.since == null) {
        throw new Error("getTopEventEmitters since is required");
    }
    const since = new Date(params.since);
    if (Number.isNaN(since.getTime())) {
        throw new Error("getTopEventEmitters since must be a valid date");
    }
    return {
        since,
        limit: clampInteger(params.limit, 20, 1, 100),
    };
}

function normalizeSessionOwner(authContext) {
    const principal = authContext?.principal;
    return normalizeOwnerPrincipal(principal);
}

function normalizeOwnerPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    if (!provider || !subject) return null;
    return {
        provider,
        subject,
        email: String(principal?.email || "").trim() || null,
        displayName: String(principal?.displayName || "").trim() || null,
    };
}

// Placement identity: group placements are keyed off the same principal as
// owner stamping. No-auth deployments fall back to a shared anonymous user
// (lazily registered by the placement proc) so grouping keeps working there.
function placementPrincipal(authContext) {
    const principal = normalizeSessionOwner(authContext);
    if (principal) return { provider: principal.provider, subject: principal.subject };
    return { provider: "anonymous", subject: "anonymous" };
}

function requireUserPrincipal(authContext, methodName) {
    const principal = normalizeSessionOwner(authContext);
    if (!principal) {
        const err = new Error(`Portal RPC '${methodName}' requires an authenticated principal.`);
        err.code = "PORTAL_AUTH_REQUIRED";
        throw err;
    }
    return principal;
}

/**
 * The legacy key RPCs store a GitHub token in the database, unchecked. With
 * PILOTSWARM_REQUIRE_FINE_GRAINED_GH_PAT on they refuse a key, and so does
 * the personal one with PILOTSWARM_PERSONAL_SECRETS=external, which keeps
 * personal tokens out of the database. Clearing one stays allowed, since
 * that stores nothing.
 */
function assertLegacyKeyAccepted(refusal, methodName, key) {
    if (!refusal || typeof key !== "string" || key.trim().length === 0) return;
    throw forbiddenError(
        `Portal RPC '${methodName}' is disabled on this deployment, which ${refusal}. `
        + "Add one, or use Update Key on yours.",
    );
}

const FINE_GRAINED_ONLY = "accepts GitHub tokens only through a GitHub Copilot provider, where they are checked";
const EXTERNAL_PERSONAL_SECRETS = "keeps personal GitHub tokens only in its secret store, through a GitHub Copilot provider";

// Break-glass audit coverage: every non-read session op, plus the reads that
// expose content (transcript, artifacts, history). Status polling and list
// metadata are excluded to keep the audit stream signal-dense.
const BREAK_GLASS_AUDITED = {
    any: true,
    getSessionEvents: true,
    getSessionEventsBefore: true,
    downloadArtifact: true,
    readArtifactBase64: true,
    getExecutionHistory: true,
    getLatestResponse: true,
    listSessionShares: true,
};

// What the deployment's dispatcher may do, beyond its targeted write share,
// on a session of a user who allows delegation.
const DELEGATED_END_OF_WORK = new Set(["completeSession", "cancelSession", "deleteSession"]);

// How often an unchanged role is re-confirmed in the users table.
//
// This is a heartbeat, not a cache of the decision: the request's own
// authorization always comes from the token it just presented. What it bounds
// is how stale `role_seen_at` can be for an ACTIVE portal user, which is in
// turn what the worker's staleness ceiling is measured against — so it must
// stay comfortably below that ceiling. A role that CHANGED bypasses this
// entirely and writes at once.
const SIGNIN_ROLE_REFRESH_MS = 5 * 60 * 1000;


function coerceShareSlot(raw) {
    // POST body params arrive as { slot } objects or bare numbers depending
    // on the caller; accept both, validate downstream.
    if (raw && typeof raw === "object" && raw.slot !== undefined) return Number(raw.slot);
    return Number(raw);
}

function principalLabel(authContext) {
    const p = authContext?.principal;
    return p?.email || p?.displayName || p?.subject || "";
}

// A ProviderStore refusal arrives as a ProviderError carrying one of these
// codes. Stamping `status` is how authz.js already hands the API router a
// decision (see forbiddenError/notFoundError); without it a policy refusal
// would fall through to the 500 branch and lose its message.
const PROVIDER_ERROR_STATUS = {
    PROVIDER_NOT_FOUND: 404,
    PROVIDER_FORBIDDEN: 403,
    PROVIDER_CONFLICT: 409,
    PROVIDER_INVALID: 400,
    // "…is selected by a default or system-agent override; clear that
    // routing first" — a refusal whose message is the whole value. Without
    // a status it falls to the 500 branch, which scrubs the message.
    PROVIDER_IN_USE: 409,
    // External personal secrets: the secret store did not answer. The
    // message is fixed text, so it is shown although the status is a 5xx.
    PROVIDER_SECRET_STORE_UNAVAILABLE: 503,
};

/** `?names=a,b` off the wire, or an array from the legacy /api/rpc caller. */
function providerNames(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    return list.map((name) => String(name || "").trim()).filter(Boolean);
}

/**
 * The Facts Manager prefix (`skills/`, `asks/`, `config/facts-manager/`) of
 * the shared facts a storeFact/deleteFact input writes, or null. The stores
 * write a shared fact only for `shared: true`; a pattern delete reaches
 * shared facts unless its scope is "session", and every key its LIKE pattern
 * could match counts.
 */
function sharedKnowledgePrefix(method, input) {
    const key = String(input?.key ?? "");
    if (method === "deleteFact" && input?.pattern === true) {
        const scope = input.scope ?? (input.shared === true ? "shared" : "session");
        return scope === "session" ? null : factsManagerPrefixFor(key, { pattern: true });
    }
    return input?.shared === true ? factsManagerPrefixFor(key) : null;
}

export class PortalRuntime {
    constructor({ store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser, personalSecretStore } = {}) {
        this.transport = new NodeSdkTransport({
            store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser,
            ...(personalSecretStore ? { personalSecretStore } : {}),
        });
        this.mode = mode;
        this.started = false;
        this.startPromise = null;
        this.authz = loadAuthzConfig();
        // Read once, like the authz settings: a malformed value stops the
        // portal at startup.
        this.requireFineGrainedGitHubTokens = requiresFineGrainedGitHubTokens();
        this.personalSecretsExternal = personalSecretsMode() === "external";
        secretRedactionEnabled();
        // The workers' setting, read here too: "owner" also keeps non-admins
        // out of the shared knowledge every session's prompt reads.
        this.sessionMessageScope = resolveSessionMessageScope(process.env.PILOTSWARM_SESSION_MESSAGE_SCOPE);
        // Throttle repeated break-glass audit rows for the same actor+session
        // (the portal polls events continuously while a session is open).
        this._breakGlassSeen = new Map(); // key -> expiry epoch ms
        // Last role written per principal, so the sign-in write does not fire
        // on every poll. See noteSignInRole.
        this._signInRoleSeen = new Map(); // key -> { role, at }
    }

    // ── Sign-in role persistence ────────────────────────────────────────

    /**
     * Record the role this request authenticated with, so the WORKER can see
     * it later.
     *
     * The portal knows the role because it just validated a token; a worker
     * holds a session OWNER and no token, and runs turns where no request
     * exists at all (cron firings, sub-agent turns, crash recovery, replay).
     * The users table is the only place the two can meet.
     *
     * Fire-and-forget and best-effort: this is an observation, never part of
     * the request's own authorization decision, so a write failure must not
     * fail the request. The worker fails closed on a missing or stale role.
     *
     * Throttled per principal: an open portal polls continuously, and a DB
     * write per poll would be pure noise. A CHANGED role always writes
     * immediately — a demotion must not wait out the refresh interval.
     */
    noteSignInRole(authContext) {
        if (typeof this.transport.recordUserRole !== "function") return;
        const principal = normalizeSessionOwner(authContext);
        if (!principal) return;
        const role = authContext?.authorization?.role ?? null;

        const key = `${principal.provider}\u0001${principal.subject}`;
        const now = Date.now();
        const last = this._signInRoleSeen.get(key);
        if (last && last.role === role && now - last.at < SIGNIN_ROLE_REFRESH_MS) return;
        if (this._signInRoleSeen.size > 5000) this._signInRoleSeen.clear();
        this._signInRoleSeen.set(key, { role, at: now });

        this.start()
            .then(() => this.transport.recordUserRole(principal, role))
            .catch(() => {
                // Let the next request retry rather than caching a failure as
                // if it had been written.
                const current = this._signInRoleSeen.get(key);
                if (current && current.at === now) this._signInRoleSeen.delete(key);
            });
    }

    // ── Authorization (security model) ──────────────────────────────────

    _recordAudit(entry) {
        if (typeof this.transport.recordAuthzAudit !== "function") return;
        this.transport.recordAuthzAudit(entry).catch(() => {});
    }

    _resourceAdmin(isAdmin, snapshot = null) {
        return adminCanAccessResource(isAdmin, this.authz.adminScope, snapshot?.isSystem);
    }

    getAuthorizationPolicy() {
        return { adminScope: this.authz.adminScope ?? "unrestricted", policyVersion: ADMIN_SCOPE_POLICY_VERSION,
            ownershipEnforced: this.authz.enforce, defaultVisibility: this.authz.defaultVisibility,
            systemVisibility: this.authz.systemVisibility };
    }

    _auditActor(authContext) {
        const principal = authContext?.principal;
        return {
            provider: principal?.provider ?? null,
            subject: principal?.subject ?? null,
            display: principal?.displayName ?? principal?.email ?? null,
        };
    }

    _shouldRecordBreakGlass(actorKey, sessionId) {
        const key = `${actorKey}\u0001${sessionId}`;
        const now = Date.now();
        const expiry = this._breakGlassSeen.get(key);
        if (expiry && expiry > now) return false;
        if (this._breakGlassSeen.size > 5000) this._breakGlassSeen.clear();
        this._breakGlassSeen.set(key, now + 15 * 60 * 1000);
        return true;
    }

    /**
     * Gate one dispatched method. Returns { snapshot } (the access snapshot
     * for session-scoped ops, so handlers can reuse it — e.g. sender
     * relation) or throws 403/404. With enforcement off, would-be denials
     * are audited and allowed through (dark launch).
     */
    async _authorizeCall(method, safeParams, authContext, { owner, isAdmin }) {
        const spec = getMethodAccess(method);
        const access = spec?.access || "authed";

        if (access === "authed" || access === "session:create" || access === "facts:read" || access === "group:list" || access === "session:list") {
            // List/read scoping happens in the case handlers (viewer-scoped
            // catalog paths); creation stamps owner+visibility there too.
            return { snapshot: null };
        }

        if (access === "fleet:read" || access === "fleet:admin") {
            if (access === "fleet:read" && isAdmin && !this._resourceAdmin(isAdmin)
                && !["getFleetStats", "getUserStats", "getSharedFactsStats", "getFactsTombstoneStats"].includes(method)) {
                throw forbiddenError("Detailed fleet diagnostics may contain private content. Use an authorized session's diagnostics instead.");
            }
            if (!isAdmin) {
                const reason = access === "fleet:admin"
                    ? "This operation requires the admin role."
                    : "Fleet-wide observability requires the admin role.";
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    decision: this.authz.enforce ? "deny" : "would_deny",
                    reason,
                });
                if (this.authz.enforce || access === "fleet:admin") {
                    // fleet:admin has always been enforced (op.admin) —
                    // keep it hard regardless of the dark-launch flag.
                    throw forbiddenError(reason);
                }
            }
            return { snapshot: null };
        }

        if (access === "facts:write") {
            await this._authorizeFactsWrite(method, safeParams, authContext, { owner, isAdmin });
            return { snapshot: null };
        }

        // The canvas KV store: reading and writing both floor on session READ.
        // Whether a read-only viewer may WRITE is the canvas policy's call,
        // decided per request inside the SDK chokepoint (canvas-kv.ts) —
        // never by handing them session:write.
        if (access === "canvas:read" || access === "canvas:write") {
            return this._gateSession(method, "session:read", safeParams.sessionId, authContext, { owner, isAdmin });
        }

        if (access === "group:manage") {
            await this._authorizeGroupManage(method, safeParams, authContext, { owner, isAdmin });
            return { snapshot: null };
        }

        if (access === "authz:audit") {
            const sessionId = safeParams.sessionId ? String(safeParams.sessionId) : null;
            if (this._resourceAdmin(isAdmin)) return { snapshot: null };
            if (!sessionId) throw forbiddenError("Fleet-wide audit requires the admin role. Pass sessionId to read audit for a session you own.");
            // Owner-only, and hard-enforced (session:share) so a missing/deleted
            // session id can't open the audit trail during dark-launch.
            return this._gateSession(method, "session:share", sessionId, authContext, { owner, isAdmin });
        }

        if (access === "session:copy") {
            const [from, to] = await Promise.all([
                this._gateSession(method, "session:read", safeParams.fromSessionId, authContext, { owner, isAdmin }),
                this._gateSession(method, "session:write", safeParams.toSessionId, authContext, { owner, isAdmin }),
            ]);
            return { snapshot: to.snapshot ?? from.snapshot };
        }

        if (access.startsWith("session:")) {
            const sessionId = safeParams[spec.sessionParam];
            return this._gateSession(method, access, sessionId, authContext, { owner, isAdmin, params: safeParams });
        }

        return { snapshot: null };
    }

    /** Whether the deployment's transport can resolve access snapshots at all. */
    _accessSnapshotSupported() {
        return typeof this.transport.getSessionAccess === "function";
    }

    async _getAccessSnapshot(sessionId, owner) {
        if (!sessionId || !this._accessSnapshotSupported()) return null;
        return this.transport.getSessionAccess(String(sessionId), {
            provider: owner?.provider ?? "",
            subject: owner?.subject ?? "",
        });
    }

    async _gateSession(method, accessClass, sessionId, authContext, { owner, isAdmin, params = null }) {
        // session:share is a brand-new capability with no pre-model behavior
        // to preserve, so it is enforced even during the ownership dark-launch
        // — otherwise a user could pre-plant a durable grant that survives the
        // flip to enforce (adversarial review HIGH-2).
        // session:files (the Workspace pane) is new as well: the session's
        // owner only, whatever the ownership switch says.
        const effectiveEnforce = this.authz.enforce || accessClass === "session:share" || accessClass === "session:files";
        const hasSessionId = sessionId != null && String(sessionId).trim() !== "";

        // HIGH-1: a supplied-but-unresolvable id (missing OR soft-deleted —
        // cms_get_session_access returns no row for either) must not open the
        // gate. Only genuinely id-less ops get the permissive null path. Skip
        // when the transport can't resolve snapshots at all (legacy/no-auth).
        // The one exception is a forced delete that finishes a soft-deleted
        // session's tree, for its owner, an admin or the delegated dispatcher.
        if (hasSessionId && this._accessSnapshotSupported()) {
            const snapshot = await this._getAccessSnapshot(sessionId, owner);
            if (!snapshot) {
                if (effectiveEnforce && method === "deleteSession" && params?.force === true) {
                    const retry = await this._gateForcedDeleteOfDeleted(method, accessClass, sessionId, authContext, { owner, isAdmin, params });
                    if (retry) return retry;
                }
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    sessionId: String(sessionId),
                    decision: effectiveEnforce ? "deny" : "would_deny",
                    reason: "session not found or deleted",
                });
                if (!effectiveEnforce) return { snapshot: null };
                throw notFoundError();
            }
            const delegated = await this._gateDelegation(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce, params });
            if (delegated) return delegated;
            return this._decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce });
        }

        const snapshot = await this._getAccessSnapshot(sessionId, owner);
        return this._decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce });
    }

    // ── Dispatcher delegation ───────────────────────────────────────────
    //
    // Everything below is inert unless DISPATCHER_SP_OBJECT_ID names the
    // deployment's dispatcher, and costs other callers one string comparison.

    _isDispatcher(authContext) {
        return isDispatcherPrincipal(authContext?.principal, this.authz);
    }

    /**
     * The user whose opt-in decides the dispatcher's access to a session tree
     * owned by `owner`, or null when the usual rules apply: another caller,
     * the dispatcher's own sessions, unowned trees and the system user's.
     */
    _delegatingOwner(owner, authContext) {
        if (!this._isDispatcher(authContext)) return null;
        const provider = String(owner?.provider || "").trim();
        const subject = String(owner?.subject || "").trim();
        if (!provider || !subject || (provider === "system" && subject === "system")) return null;
        const caller = normalizeSessionOwner(authContext);
        if (caller && caller.provider === provider && caller.subject === subject) return null;
        return { provider, subject };
    }

    /** Read fresh on every call, so turning delegation off holds from the dispatcher's next request. */
    async _ownerAllowsDelegation(owner) {
        if (typeof this.transport.getMyDispatcherDelegation !== "function") return false;
        const status = await this.transport.getMyDispatcherDelegation({ principal: owner });
        return status?.enabled === true;
    }

    /**
     * The dispatcher's rules on another user's session. Without the owner's
     * opt-in it is refused wherever it would otherwise have access — 403
     * DELEGATION_REVOKED rather than the 404 that hides sessions it never
     * had — under the same enforce/would_deny switch as every other session
     * check. With the opt-in it may also complete, cancel and delete a
     * session it holds the targeted write share on, and each such call is
     * audited before it runs. Null leaves the usual decision in charge.
     */
    async _gateDelegation(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce, params }) {
        const owner = snapshot.isSystem ? null : this._delegatingOwner(snapshot.owner, authContext);
        if (!owner) return null;
        const endOfWork = DELEGATED_END_OF_WORK.has(method) && snapshot.viewerShareAccess === "write";
        if (await this._ownerAllowsDelegation(owner)) {
            if (!endOfWork) return null;
            await this._recordDelegatedCall({
                action: method,
                sessionId,
                owner,
                authContext,
                details: method === "deleteSession" ? {
                    ...(params?.force === true ? { force: true } : {}),
                    ...(params?.settleTimeoutMs !== undefined ? { settleTimeoutMs: params.settleTimeoutMs } : {}),
                } : {},
            });
            return { snapshot, delegated: true };
        }
        const usual = evaluateSessionAccess(accessClass, snapshot, {
            isAdmin,
            adminScope: this.authz.adminScope,
            systemReadable: this.authz.systemVisibility === "read",
        });
        if (!usual.allowed && !endOfWork) return null;
        this._recordAudit({
            actor: this._auditActor(authContext),
            action: method,
            sessionId: String(sessionId),
            target: `${owner.provider}/${owner.subject}`,
            decision: effectiveEnforce ? "deny" : "would_deny",
            reason: "the owner does not allow the dispatcher to act for them",
        });
        if (effectiveEnforce) throw delegationRevokedError();
        return { snapshot };
    }

    /**
     * Audit entry and log line of one delegated creation or end of work.
     * Unlike the other audit writes this one is awaited: when it cannot be
     * written, the call fails.
     */
    async _recordDelegatedCall({ action, sessionId, owner, authContext, details = {} }) {
        const entry = {
            actor: this._auditActor(authContext),
            action,
            sessionId: sessionId ? String(sessionId) : null,
            target: `${owner.provider}/${owner.subject}`,
            decision: "delegated",
            reason: "the owner allows the deployment's dispatcher to act for them",
            details: { owner: { provider: owner.provider, subject: owner.subject }, ...details },
        };
        try {
            if (typeof this.transport.recordAuthzAudit !== "function") throw new Error("this transport keeps no authorization audit");
            await this.transport.recordAuthzAudit(entry);
        } catch (error) {
            throw auditUnavailableError(error);
        }
        this._logDelegatedCall(entry);
    }

    /** One JSON line per delegated call, for log-based alerting outside the database. */
    _logDelegatedCall(entry) {
        const { owner: _owner, ...details } = entry.details;
        console.log(JSON.stringify({
            event: "pilotswarm.dispatcher_delegation",
            at: new Date().toISOString(),
            action: entry.action,
            sessionId: entry.sessionId,
            owner: entry.target,
            dispatcher: `${entry.actor.provider}/${entry.actor.subject}`,
            ...details,
        }));
    }

    /**
     * `onBehalfOfOwner` on session creation: only the deployment's dispatcher
     * (never an admin as such), and only for a user who allows it. Enforced
     * whatever AUTHZ_ENFORCE_OWNERSHIP says — creating a session that someone
     * else owns is a new capability with no earlier behavior to keep. Returns
     * the owner, or null when the request does not ask for delegation.
     */
    async _delegatedCreateOwner(method, safeParams, authContext) {
        if (safeParams.onBehalfOfOwner == null) return null;
        if (!this._isDispatcher(authContext)) {
            this._recordAudit({
                actor: this._auditActor(authContext),
                action: method,
                decision: "deny",
                reason: "onBehalfOfOwner is reserved for the deployment's dispatcher",
            });
            throw forbiddenError("onBehalfOfOwner is reserved for the deployment's dispatcher.");
        }
        const requested = parseOnBehalfOfOwner(safeParams.onBehalfOfOwner, authContext?.principal);
        const owner = this._delegatingOwner(requested, authContext);
        if (!owner) {
            throw Object.assign(new Error("onBehalfOfOwner must name another user."), { code: "INVALID_REQUEST" });
        }
        if (safeParams.visibility != null && normalizeVisibility(safeParams.visibility, null) !== "private") {
            throw Object.assign(new Error("A session created on behalf of its owner stays private."), { code: "INVALID_REQUEST" });
        }
        if (!(await this._ownerAllowsDelegation(owner))) {
            this._recordAudit({
                actor: this._auditActor(authContext),
                action: method,
                target: `${owner.provider}/${owner.subject}`,
                decision: "deny",
                reason: "the owner does not allow the dispatcher to act for them",
            });
            throw delegationRevokedError("This user does not allow the deployment's dispatcher to create sessions for them.");
        }
        return { ...requested, ...owner };
    }

    /**
     * Finish a delegated creation: audit it, then give the dispatcher its
     * targeted write share — the private session's only share. On failure the
     * session is removed again, so the dispatcher never holds an unaudited one.
     */
    async _completeDelegatedCreate(method, created, owner, authContext, details = {}) {
        const sessionId = created?.sessionId;
        try {
            await this._recordDelegatedCall({ action: method, sessionId, owner, authContext, details });
            const dispatcher = normalizeSessionOwner(authContext);
            await this.transport.grantSessionShare(sessionId, dispatcher, "write", dispatcher);
        } catch (error) {
            if (sessionId) {
                await this.transport.deleteSession(sessionId, "Delegated creation failed", { force: true, settleTimeoutMs: 0 }).catch(() => {});
            }
            throw error;
        }
    }

    /**
     * Listings leave out, for the dispatcher, the sessions of users who do not
     * allow it — while ownership is enforced, like the gate's refusal.
     */
    async _dropUndelegatedSessions(rows, authContext) {
        if (!this.authz.enforce || !Array.isArray(rows) || !this._isDispatcher(authContext)) return rows;
        const allowed = new Map();
        const kept = [];
        for (const row of rows) {
            const owner = row?.isSystem ? null : this._delegatingOwner(row?.owner, authContext);
            if (owner) {
                const key = `${owner.provider}\u0001${owner.subject}`;
                if (!allowed.has(key)) allowed.set(key, this._ownerAllowsDelegation(owner));
                if (!(await allowed.get(key))) continue;
            }
            kept.push(row);
        }
        return kept;
    }

    /**
     * A forced delete whose target is already soft-deleted, which the access
     * read cannot see: a retry, or the end of what a plain delete left in the
     * target's tree. The target is looked up in the caller's own listing with
     * deleted sessions, which listSessionsPage already shows them, and the
     * decision is made on its tree's root as for a live session: its owner
     * and admins pass, and so does the delegated dispatcher, under
     * _gateDelegation's rules and audit. Only a live session of the tree
     * shows the dispatcher's share, so with none left the dispatcher is
     * refused. Null leaves the caller today's 404.
     */
    async _gateForcedDeleteOfDeleted(method, accessClass, sessionId, authContext, { owner, isAdmin, params }) {
        const tree = await this._deletedTreeAccess(String(sessionId), owner, isAdmin);
        if (!tree) return null;
        const { snapshot, shareKnown } = tree;
        if (!snapshot.isSystem && this._delegatingOwner(snapshot.owner, authContext)) {
            if (!shareKnown) return null;
            const delegated = await this._gateDelegation(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce: true, params });
            if (delegated) return delegated;
        }
        if (!snapshot.viewerIsOwner && !this._resourceAdmin(isAdmin, snapshot)) return null;
        return this._decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce: true });
    }

    /**
     * The access snapshot of a deleted session's tree root, or null when the
     * caller's listing with deleted sessions has no such session. A live
     * session left in the tree gives it through the access read, as for any
     * call. With none left, the root's row gives its owner and system flag,
     * but not the caller's share (`shareKnown: false`).
     */
    async _deletedTreeAccess(sessionId, owner, isAdmin) {
        if (typeof this.transport.mgmt?.listSessionsPage !== "function") return null;
        const viewer = this._listViewer(owner, isAdmin);
        const rows = [];
        let cursor = null;
        for (;;) {
            const page = await this.transport.mgmt.listSessionsPage({
                limit: 200,
                includeDeleted: true,
                ...(cursor ? { cursor } : {}),
                ...(viewer ? { viewer } : {}),
            });
            const sessions = Array.isArray(page?.sessions) ? page.sessions : [];
            rows.push(...sessions);
            const next = page?.hasMore ? page.nextCursor : null;
            if (!next || sessions.length === 0
                || (cursor && next.sessionId === cursor.sessionId && next.updatedAt === cursor.updatedAt)) break;
            cursor = next;
        }
        const target = rows.find((row) => row?.sessionId === sessionId);
        if (!target) return null;
        const rootId = target.rootSessionId || sessionId;
        for (const row of rows) {
            if (row?.sessionId === sessionId || (row?.rootSessionId || row?.sessionId) !== rootId) continue;
            const snapshot = await this._getAccessSnapshot(row.sessionId, owner);
            if (snapshot?.rootSessionId === rootId) return { snapshot, shareKnown: true };
        }
        const root = rows.find((row) => row?.sessionId === rootId) ?? target;
        const rootOwner = normalizeOwnerPrincipal(root.owner);
        return {
            snapshot: {
                rootSessionId: rootId,
                isSystem: root.isSystem === true,
                visibility: root.visibility || "private",
                owner: root.owner ?? null,
                viewerIsOwner: Boolean(rootOwner && owner && rootOwner.provider === owner.provider && rootOwner.subject === owner.subject),
                viewerShareAccess: null,
            },
            shareKnown: false,
        };
    }

    /**
     * Only the owner, an admin or the delegated dispatcher may force a delete.
     * Like session:share, the forced delete is new, so this holds whatever
     * AUTHZ_ENFORCE_OWNERSHIP says for a session the gate finds. With
     * enforcement on, the gate has already refused everyone else, and it
     * finds a target that is already deleted through its tree
     * (_gateForcedDeleteOfDeleted), so a retry can finish. With enforcement
     * off, the gate lets a target it cannot find through, as it does every
     * call in that mode, so there is no snapshot to check and the call passes.
     */
    _assertMayForceDelete(gate, sessionId, authContext, isAdmin) {
        const snapshot = gate?.snapshot;
        if (!snapshot || gate.delegated || snapshot.viewerIsOwner || this._resourceAdmin(isAdmin, snapshot)) return;
        this._recordAudit({
            actor: this._auditActor(authContext),
            action: "deleteSession",
            sessionId: String(sessionId),
            decision: "deny",
            reason: "only the owner, an admin or the delegated dispatcher may force a delete",
        });
        throw forbiddenError("Only the session's owner or an admin, or the delegated dispatcher, can force a delete.");
    }

    _decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce }) {
        const decision = evaluateSessionAccess(accessClass, snapshot, {
            isAdmin,
            adminScope: this.authz.adminScope,
            systemReadable: this.authz.systemVisibility === "read",
        });

        if (decision.allowed) {
            if (decision.breakGlass && BREAK_GLASS_AUDITED[accessClass !== "session:read" ? "any" : method]) {
                const actor = this._auditActor(authContext);
                const actorKey = `${actor.provider}/${actor.subject}`;
                if (this._shouldRecordBreakGlass(actorKey, String(sessionId))) {
                    this._recordAudit({
                        actor,
                        action: method,
                        sessionId: String(sessionId),
                        decision: "break_glass",
                        reason: "Admin access to a private session owned by another user",
                    });
                }
            }
            return { snapshot };
        }

        this._recordAudit({
            actor: this._auditActor(authContext),
            action: method,
            sessionId: sessionId ? String(sessionId) : null,
            decision: effectiveEnforce ? "deny" : "would_deny",
            reason: decision.notFound ? "not visible" : decision.reason,
        });

        if (!effectiveEnforce) return { snapshot };
        throw decision.notFound ? notFoundError() : forbiddenError(decision.reason);
    }

    /**
     * Facts write containment: non-admin callers may write/delete shared
     * facts (the deployment's collaboration memory) and facts of sessions
     * they can WRITE; anything else — in particular pattern deletes over
     * other sessions' private facts — is denied. With the "owner" session
     * message scope, the shared facts under the Facts Manager's prefixes are
     * admin-only too: every session's prompt reads them.
     */
    async _authorizeFactsWrite(method, safeParams, authContext, { owner, isAdmin }) {
        const inputs = Array.isArray(safeParams.input) ? safeParams.input : [safeParams.input];
        if (!isAdmin && this.sessionMessageScope === "owner") {
            for (const input of inputs) {
                const prefix = sharedKnowledgePrefix(method, input);
                if (!prefix) continue;
                const reason = `Only an administrator can store or delete shared facts under '${prefix}'.`;
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    target: String(input?.key ?? ""),
                    decision: "deny",
                    reason,
                });
                throw forbiddenError(reason);
            }
        }
        if (this._resourceAdmin(isAdmin)) return;
        for (const input of inputs) {
            const sessionId = typeof input?.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : null;
            const scopeKey = typeof input?.scopeKey === "string" ? input.scopeKey : "";
            const sessionScopeFromKey = scopeKey.startsWith("session:") ? scopeKey.split(":")[1] || null : null;
            const targetSession = sessionId || sessionScopeFromKey;
            const isSharedScope = !targetSession && (input?.shared === true || scopeKey.startsWith("shared:") || input?.scope === "shared" || (!scopeKey && !sessionId));
            if (isSharedScope) continue;
            await this._gateSession(method, "session:write", targetSession, authContext, { owner, isAdmin });
        }
    }

    async _authorizeGroupManage(method, safeParams, authContext, { owner, isAdmin }) {
        if (this._resourceAdmin(isAdmin)) return;
        const groupId = safeParams.groupId ? String(safeParams.groupId) : null;
        if (groupId) {
            const groups = await this.transport.mgmt.listSessionGroups(this._placementViewer(authContext, isAdmin));
            const group = (groups || []).find((g) => g.groupId === groupId);
            if (!group && this.authz.enforce) throw notFoundError();
            if (group) {
                const groupOwner = normalizeOwnerPrincipal(group.owner);
                const allowed = !groupOwner || (owner && groupOwner.provider === owner.provider && groupOwner.subject === owner.subject);
                if (!allowed) {
                    this._recordAudit({
                        actor: this._auditActor(authContext),
                        action: method,
                        target: `group:${groupId}`,
                        decision: this.authz.enforce ? "deny" : "would_deny",
                        reason: "group owned by another user",
                    });
                    if (this.authz.enforce) {
                        throw forbiddenError("Only the group owner or an admin can manage this group.");
                    }
                }
            }
        }
        // Assign/move (including ungroup, groupId=null) also mutates the
        // sessions themselves — gate each as session:manage so a user can't
        // pull another user's session out of (or into) a group
        // (adversarial review MEDIUM-2).
        const sessionIds = Array.isArray(safeParams.sessionIds) ? safeParams.sessionIds : [];
        for (const sessionId of sessionIds) {
            await this._gateSession(method, "session:manage", sessionId, authContext, { owner, isAdmin });
        }
    }

    /**
     * Placement viewer for the CMS placement procs. canRead inside the procs
     * is permissive when ownership enforcement is off (admin OR NOT enforce);
     * the target-group ownership check is always enforced regardless.
     */
    _placementViewer(authContext, isAdmin) {
        return { ...placementPrincipal(authContext), isAdmin: this._resourceAdmin(isAdmin) || !this.authz.enforce };
    }

    /**
     * Viewer-private placement: upsert (or clear, when groupId is null) the
     * caller's own group placement for each session tree root. Requires read
     * access per session; the target group must be owned by the caller —
     * cross-user placement is structurally impossible.
     */
    async _placeSessionsInGroup(method, safeParams, authContext, { isAdmin }) {
        const groupId = safeParams.groupId == null ? null : String(safeParams.groupId).trim() || null;
        const sessionIds = Array.isArray(safeParams.sessionIds) ? safeParams.sessionIds : [];
        try {
            return await this.transport.mgmt.placeSessionsInGroup(
                this._placementViewer(authContext, isAdmin),
                sessionIds,
                groupId,
            );
        } catch (error) {
            if (/was not found or is not owned by the caller/i.test(String(error?.message || ""))) {
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    target: `group:${groupId}`,
                    decision: "deny",
                    reason: "group not found or not owned by the caller",
                });
                throw forbiddenError("Session group not found or not owned by you.");
            }
            throw error;
        }
    }

    /** A creator-supplied groupId is an initial placement: it must be one of the caller's groups. */
    async _assertPlacementGroupOwned(groupId, authContext, { isAdmin }) {
        const normalized = groupId == null ? null : String(groupId).trim() || null;
        if (!normalized) return;
        const groups = await this.transport.mgmt.listSessionGroups(this._placementViewer(authContext, isAdmin));
        if (!(groups || []).some((group) => group.groupId === normalized)) {
            throw forbiddenError("Session group not found or not owned by you.");
        }
    }

    /**
     * Guarantee a created session lands in the requested group under the
     * placement principal, not the session owner. CMS places in-transaction
     * only when an owner principal reaches it, so no-auth deployments (owner
     * null, placement viewer anonymous) would otherwise drop the group
     * silently. The upsert is idempotent, so the authenticated path (already
     * placed) is skipped via the viewerGroupId check; ownership was verified
     * before create, so a placement failure is unexpected and best-effort.
     */
    async _ensureCreatedPlacement(view, groupId, authContext, isAdmin) {
        const normalized = groupId == null ? null : String(groupId).trim() || null;
        if (!normalized || !view?.sessionId || view.viewerGroupId === normalized) return view;
        try {
            await this.transport.mgmt.placeSessionsInGroup(
                this._placementViewer(authContext, isAdmin),
                [view.sessionId],
                normalized,
            );
            return { ...view, viewerGroupId: normalized };
        } catch {
            return view;
        }
    }

    /**
     * Viewer descriptor for viewer-scoped listing, or null for unfiltered.
     * A non-admin without a resolvable identity in enforce mode gets a viewer
     * that matches no owner and no targeted share, so they see only
     * deployment-shared trees (shared_read/shared_write are visible to every
     * admitted user by design) — never the unfiltered fleet or another user's
     * private sessions (adversarial review LOW-1 / NEW-5).
     */
    _listViewer(owner, isAdmin, forceScoped = false) {
        if (!forceScoped && (this._resourceAdmin(isAdmin) || !this.authz.enforce)) return null;
        if (!owner) return { provider: "\0nomatch", subject: "\0nomatch", systemVisible: false };
        return {
            provider: owner.provider,
            subject: owner.subject,
            systemVisible: isAdmin || this.authz.systemVisibility === "read",
        };
    }

    async start() {
        if (this.started) return;
        if (!this.startPromise) {
            this.startPromise = this.transport.start()
                .then(() => {
                    this.started = true;
                })
                .finally(() => {
                    this.startPromise = null;
                });
        }
        await this.startPromise;
    }

    async stop() {
        if (!this.started && !this.startPromise) return;
        if (this.startPromise) {
            await this.startPromise.catch(() => {});
        }
        if (this.started) {
            await this.transport.stop();
            this.started = false;
        }
    }

    async resolveSessionGroupOwner(input = {}, authOwner = null) {
        // Groups belong to the authenticated creator. Ownership is never
        // inferred from selected sessions, and never null: no-auth
        // deployments use the same anonymous principal as placement so
        // every group can receive placements.
        if (authOwner) return authOwner;
        const inputOwner = normalizeOwnerPrincipal(input?.owner);
        if (inputOwner) return inputOwner;
        return { provider: "anonymous", subject: "anonymous" };
    }

    async getBootstrap() {
        await this.start();
        return {
            mode: this.mode,
            workerCount: typeof this.transport.getWorkerCount === "function"
                ? this.transport.getWorkerCount()
                : null,
            logConfig: typeof this.transport.getLogConfig === "function"
                ? this.transport.getLogConfig()
                : null,
            defaultModel: typeof this.transport.getDefaultModel === "function"
                ? this.transport.getDefaultModel()
                : null,
            modelsByProvider: typeof this.transport.getModelsByProvider === "function"
                ? this.transport.getModelsByProvider()
                : [],
            modelsByProviderKind: "provider_type",
            creatableAgents: typeof this.transport.listCreatableAgents === "function"
                // Viewer-less bootstrap: baked + shared-scope only (null
                // principal, non-admin) so no user-scope package ever rides
                // the shared bootstrap payload. Pickers fetch the
                // viewer-scoped union per open via the listCreatableAgents op.
                ? await this.transport.listCreatableAgents(null, false)
                : [],
            sessionCreationPolicy: typeof this.transport.getSessionCreationPolicy === "function"
                ? this.transport.getSessionCreationPolicy()
                : null,
            // Ownership/visibility posture (security model) so clients (portal,
            // MCP, TUI) can explain why a session isn't listed or a send was
            // refused, and default the share UI correctly.
            authz: {
                adminScope: this.authz.adminScope ?? "unrestricted",
                policyVersion: ADMIN_SCOPE_POLICY_VERSION,
                ownershipEnforced: this.authz.enforce,
                defaultVisibility: this.authz.defaultVisibility,
                systemVisibility: this.authz.systemVisibility,
            },
        };
    }

    async call(method, params = {}, authContext = null) {
        await this.start();
        const safeParams = normalizeParams(params);
        const owner = normalizeSessionOwner(authContext);
        // Privileged when admin-role, or no-auth ("anonymous" = full access on a
        // trusted deployment). Non-admin facts reads are restricted to shared
        // visibility so a plain caller cannot read another session's private facts.
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        const resourceAdmin = this._resourceAdmin(isAdmin);
        if (this.authz.adminScope === "cluster" && (!owner || role === "anonymous")) {
            throw forbiddenError("Cluster-scoped administration requires an authenticated user.");
        }
        // Ownership/visibility gate — the single enforcement point for both
        // the generated /api/v1 routes and the legacy /api/rpc dispatcher.
        const gate = await this._authorizeCall(method, safeParams, authContext, { owner, isAdmin });
        const listViewer = this._listViewer(owner, isAdmin);
        switch (method) {
            case "listSessions": {
                const rows = listViewer
                    ? await this.transport.mgmt.listSessionsVisible(listViewer, placementPrincipal(authContext))
                    : await this.transport.mgmt.listSessions(placementPrincipal(authContext));
                return this._dropUndelegatedSessions(rows, authContext);
            }
            case "listSessionGroups":
                // Viewer-scoped: everyone (admins included) sees only their
                // own groups — a group is a user's private organization.
                return this.transport.mgmt.listSessionGroups(this._placementViewer(authContext, isAdmin));
            case "createSessionGroup":
                return this.transport.createSessionGroup({
                    ...(safeParams.input || {}),
                    owner: await this.resolveSessionGroupOwner(safeParams.input || {}, owner),
                });
            case "updateSessionGroup":
                return this.transport.updateSessionGroup(safeParams.groupId, safeParams.patch || {});
            case "placeSessionsInGroup":
            case "assignSessionsToGroup":
            case "moveSessionsToGroup":
                return this._placeSessionsInGroup(method, safeParams, authContext, { isAdmin });
            case "getChildOutcome":
                return this.transport.getChildOutcome(safeParams.childSessionId);
            case "listChildOutcomes":
                return this.transport.listChildOutcomes(safeParams.parentSessionId);
            case "listSessionsPage": {
                // The portal opts into a personal catalog even when its user
                // also has unrestricted fleet administration. With no signed-in
                // principal (trusted no-auth deployments), retain the legacy
                // unfiltered behavior because there is no "me" to scope to.
                const pageViewer = safeParams.viewerOnly === true && owner
                    ? this._listViewer(owner, isAdmin, true)
                    : listViewer;
                const page = await this.transport.mgmt.listSessionsPage({
                    ...normalizeSessionPageOptions(safeParams),
                    ...(pageViewer ? { viewer: pageViewer } : {}),
                    placement: placementPrincipal(authContext),
                });
                return Array.isArray(page?.sessions)
                    ? { ...page, sessions: await this._dropUndelegatedSessions(page.sessions, authContext) }
                    : page;
            }
            case "getSession":
                return this.transport.mgmt.getSession(safeParams.sessionId, placementPrincipal(authContext));
            case "getOrchestrationStats":
                return this.transport.getOrchestrationStats(safeParams.sessionId);
            case "getSessionMetricSummary":
                return this.transport.getSessionMetricSummary(safeParams.sessionId);
            case "getSessionFootprint":
                return this.transport.getSessionFootprint(safeParams.sessionId);
            case "getSessionWorkspace":
                return this.transport.getSessionWorkspace(safeParams.sessionId);
            // Session workspaces: the wait for the answer holds this request,
            // so the caller's timeout is bounded like the other long waits.
            case "setSessionWorkspace":
                return this.transport.setSessionWorkspace(
                    safeParams.sessionId,
                    { expectedRevision: safeParams.expectedRevision, workspace: safeParams.workspace ?? null },
                    { ...(safeParams.options || {}), timeoutMs: clampInteger(safeParams.options?.timeoutMs, 120_000, 1_000, 300_000) },
                );
            case "retrySessionWorkspace":
                return this.transport.retrySessionWorkspace(
                    safeParams.sessionId,
                    { ...(safeParams.options || {}), timeoutMs: clampInteger(safeParams.options?.timeoutMs, 60_000, 1_000, 300_000) },
                );
            // Workspace files (the Workspace pane): the session's owner only
            // (session:files); the files are on this portal's own mount.
            case "listSessionWorkspaceFolders":
                return this.transport.listSessionWorkspaceFolders(safeParams.sessionId);
            case "sessionWorkspaceFiles":
                return this.transport.sessionWorkspaceFiles(safeParams.sessionId, safeParams.call || {});
            case "canvasWorkspace":
                return this.transport.canvasWorkspace(safeParams.sessionId, safeParams.slot, safeParams.call || {});
            case "regenerateSession":
                return this.transport.regenerateSession(safeParams.sessionId, safeParams.options || {});
            case "getSessionTokensByModel":
                return this.transport.getSessionTokensByModel(safeParams.sessionId);
            case "getSessionTreeStats":
                return this.transport.getSessionTreeStats(safeParams.sessionId);
            case "getFleetStats": {
                const stats = await this.transport.getFleetStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
                return resourceAdmin ? stats : projectFleetAccounting(stats);
            }
            case "getUserStats": {
                const stats = await this.transport.getUserStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
                return resourceAdmin ? stats : projectUserAccounting(stats);
            }
            case "getCurrentUserProfile": {
                const profile = await this.transport.getCurrentUserProfile({
                    principal: requireUserPrincipal(authContext, "getCurrentUserProfile"),
                });
                return profile ? { ...profile, isAdmin, adminScope: this.authz.adminScope ?? "unrestricted", capabilities: adminCapabilities(isAdmin, this.authz.adminScope) } : profile;
            }
            case "setCurrentUserProfileSettings":
                return this.transport.setCurrentUserProfileSettings({
                    principal: requireUserPrincipal(authContext, "setCurrentUserProfileSettings"),
                    settings: safeParams.settings,
                });
            // Bound to the signed-in caller: nobody sets another user's opt-in.
            case "getMyDispatcherDelegation": {
                const status = await this.transport.getMyDispatcherDelegation({
                    principal: requireUserPrincipal(authContext, "getMyDispatcherDelegation"),
                });
                return { enabled: status?.enabled === true, dispatcherConfigured: Boolean(this.authz.dispatcherSubject) };
            }
            case "setMyDispatcherDelegation": {
                const principal = requireUserPrincipal(authContext, "setMyDispatcherDelegation");
                if (typeof safeParams.enabled !== "boolean") {
                    throw Object.assign(new Error("setMyDispatcherDelegation requires enabled: true or false"), { code: "INVALID_REQUEST" });
                }
                const status = await this.transport.setMyDispatcherDelegation({ principal, enabled: safeParams.enabled });
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "setMyDispatcherDelegation",
                    target: `${principal.provider}/${principal.subject}`,
                    decision: "share_change",
                    reason: `dispatcher delegation ${safeParams.enabled ? "on" : "off"}`,
                });
                return { enabled: status?.enabled === true, dispatcherConfigured: Boolean(this.authz.dispatcherSubject) };
            }
            case "setCurrentUserGitHubCopilotKey": {
                const principal = requireUserPrincipal(authContext, "setCurrentUserGitHubCopilotKey");
                assertLegacyKeyAccepted(
                    this.personalSecretsExternal ? EXTERNAL_PERSONAL_SECRETS
                        : this.requireFineGrainedGitHubTokens ? FINE_GRAINED_ONLY : null,
                    "setCurrentUserGitHubCopilotKey", safeParams.key);
                return this.transport.setCurrentUserGitHubCopilotKey({
                    principal,
                    key: typeof safeParams.key === "string" ? safeParams.key : null,
                });
            }
            case "setSystemGitHubCopilotKey": {
                if (!isAdmin) {
                    const err = new Error("Portal RPC 'setSystemGitHubCopilotKey' requires the admin role.");
                    err.code = "PORTAL_ADMIN_REQUIRED";
                    throw err;
                }
                assertLegacyKeyAccepted(this.requireFineGrainedGitHubTokens ? FINE_GRAINED_ONLY : null,
                    "setSystemGitHubCopilotKey", safeParams.key);
                return this.transport.setSystemGitHubCopilotKey({
                    actor: normalizeSessionOwner(authContext),
                    key: typeof safeParams.key === "string" ? safeParams.key : null,
                });
            }
            case "getSystemGitHubCopilotKeyStatus": {
                if (!isAdmin) {
                    const err = new Error("Portal RPC 'getSystemGitHubCopilotKeyStatus' requires the admin role.");
                    err.code = "PORTAL_ADMIN_REQUIRED";
                    throw err;
                }
                return this.transport.getSystemGitHubCopilotKeyStatus();
            }
            case "getSessionSkillUsage":
                return this.transport.getSessionSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionTreeSkillUsage":
                return this.transport.getSessionTreeSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetSkillUsage":
                return this.transport.getFleetSkillUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetRetrievalUsage":
                return this.transport.getFleetRetrievalUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionRetrievalUsage":
                return this.transport.getSessionRetrievalUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionTreeRetrievalUsage":
                return this.transport.getSessionTreeRetrievalUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionGraphNodeUsage":
                return this.transport.getSessionGraphNodeUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                    nodeKeyLike: safeParams.nodeKeyLike,
                    kind: safeParams.kind,
                });
            case "getSessionGraphEdgeSearchUsage":
                return this.transport.getSessionGraphEdgeSearchUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                });
            case "getSessionGraphSearches":
                return this.transport.getSessionGraphSearches(safeParams.sessionId, safeParams.limit);
            case "getFleetGraphNodeUsage":
                return this.transport.getFleetGraphNodeUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                    nodeKeyLike: safeParams.nodeKeyLike,
                    kind: safeParams.kind,
                });
            case "getSessionFactsStats":
                return this.transport.getSessionFactsStats(safeParams.sessionId);
            case "getSessionTreeFactsStats":
                return this.transport.getSessionTreeFactsStats(safeParams.sessionId);
            case "getSharedFactsStats":
                return this.transport.getSharedFactsStats();
            case "getFactsTombstoneStats":
                return this.transport.getFactsTombstoneStats({ ttlSeconds: safeParams.ttlSeconds });

            // ── Facts data-plane ────────────────────────────────────────
            case "factsCapabilities":
                return this.transport.factsCapabilities();
            case "readFacts":
                if (!resourceAdmin && typeof safeParams.sessionId === "string" && safeParams.sessionId.trim()) {
                    const sessionId = safeParams.sessionId.trim();
                    await this._gateSession(method, "session:read", sessionId, authContext, { owner, isAdmin });
                    return this.transport.readFacts(safeParams, { admin: false, sessionId });
                }
                return this.transport.readFacts(safeParams, { admin: resourceAdmin });
            case "storeFact":
                return this.transport.storeFact(safeParams.input);
            case "deleteFact":
                return this.transport.deleteFactRecord(safeParams.input);
            case "searchFacts":
                return this.transport.searchFacts(safeParams.query, safeParams.opts, { admin: resourceAdmin });
            case "similarFacts":
                return this.transport.similarFacts(safeParams.scopeKey, safeParams.opts, { admin: resourceAdmin });
            case "getEmbedderStatus":
                return this.transport.getFactsEmbedderStatus();
            case "startFactsEmbedder":
                return this.transport.startFactsEmbedder({ intervalSeconds: safeParams.intervalSeconds, batch: safeParams.batch });
            case "stopFactsEmbedder":
                return this.transport.stopFactsEmbedder(safeParams.reason);
            case "forcePurgeFacts":
                return this.transport.forcePurgeFacts(safeParams.input);

            // ── Graph data-plane ────────────────────────────────────────
            case "searchGraphNodes":
                return this.transport.searchGraphNodes(safeParams.query);
            case "searchGraphEdges":
                return this.transport.searchGraphEdges(safeParams.query);
            case "graphNeighbourhood":
                return this.transport.graphNeighbourhood(safeParams.nodeKey, safeParams.depth, { namespace: safeParams.namespace });
            case "upsertGraphNode":
                return this.transport.upsertGraphNode(safeParams.input);
            case "upsertGraphEdge":
                return this.transport.upsertGraphEdge(safeParams.input);
            case "deleteGraphNode":
                return this.transport.deleteGraphNode(safeParams.nodeKey, { namespace: safeParams.namespace });
            case "deleteGraphEdge":
                return this.transport.deleteGraphEdge(safeParams.fromKey, safeParams.toKey, safeParams.predicateKey, { namespace: safeParams.namespace });
            case "graphStats":
                return this.transport.graphStats({ namespace: safeParams.namespace });
            case "listGraphNamespaces":
                return this.transport.listGraphNamespaces({ prefix: safeParams.prefix, includeArchived: safeParams.includeArchived, includeDetails: safeParams.includeDetails });
            case "getGraphNamespace":
                return this.transport.getGraphNamespace(safeParams.namespace);
            case "upsertGraphNamespace":
                return this.transport.upsertGraphNamespace(safeParams.input);
            case "deleteGraphNamespace":
                return this.transport.deleteGraphNamespace(safeParams.namespace);
            case "pruneDeletedSummaries":
                return this.transport.pruneDeletedSummaries(new Date(safeParams.olderThan));
            case "getExecutionHistory":
                return this.transport.getExecutionHistory(safeParams.sessionId, safeParams.executionId);
            case "createSession": {
                // With onBehalfOfOwner the group, owner and visibility are the
                // owner's: the dispatcher acts for them, not as itself.
                const delegatedOwner = await this._delegatedCreateOwner(method, safeParams, authContext);
                const placementAuth = delegatedOwner ? { principal: delegatedOwner } : authContext;
                const placementAdmin = delegatedOwner ? false : isAdmin;
                await this._assertPlacementGroupOwned(safeParams.groupId, placementAuth, { isAdmin: placementAdmin });
                const created = await this.transport.createSession({
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    contextTier: safeParams.contextTier,
                    groupId: safeParams.groupId,
                    owner: delegatedOwner ?? owner,
                    visibility: delegatedOwner ? "private" : normalizeVisibility(safeParams.visibility, this.authz.defaultVisibility),
                    ...(safeParams.workspace != null ? { workspace: safeParams.workspace } : {}),
                });
                if (delegatedOwner) await this._completeDelegatedCreate(method, created, delegatedOwner, authContext);
                return this._ensureCreatedPlacement(created, safeParams.groupId, placementAuth, placementAdmin);
            }
            case "createSessionForAgent": {
                const delegatedOwner = await this._delegatedCreateOwner(method, safeParams, authContext);
                const placementAuth = delegatedOwner ? { principal: delegatedOwner } : authContext;
                const placementAdmin = delegatedOwner ? false : isAdmin;
                await this._assertPlacementGroupOwned(safeParams.groupId, placementAuth, { isAdmin: placementAdmin });
                const created = await this.transport.createSessionForAgent(safeParams.agentName, {
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    contextTier: safeParams.contextTier,
                    title: safeParams.title,
                    splash: safeParams.splash,
                    splashMobile: safeParams.splashMobile,
                    initialPrompt: safeParams.initialPrompt,
                    groupId: safeParams.groupId,
                    owner: delegatedOwner ?? owner,
                    // The agent catalog the owner sees, without anyone's admin reach.
                    isAdmin: delegatedOwner ? false : resourceAdmin,
                    visibility: delegatedOwner ? "private" : normalizeVisibility(safeParams.visibility, this.authz.defaultVisibility),
                    ...(safeParams.workspace != null ? { workspace: safeParams.workspace } : {}),
                });
                if (delegatedOwner) {
                    await this._completeDelegatedCreate(method, created, delegatedOwner, authContext, { agentName: safeParams.agentName ?? null });
                }
                return this._ensureCreatedPlacement(created, safeParams.groupId, placementAuth, placementAdmin);
            }
            case "listCreatableAgents":
                return this.transport.listCreatableAgents(owner, resourceAdmin);
            case "getSessionCreationPolicy":
                return this.transport.getSessionCreationPolicy();

            // ── Agent packages (docs/proposals/agent-packages.md) ────
            // access "authed" + creator-or-admin enforcement in the registry
            // procs; viewer filtering in the catalog reads. `owner` is the
            // authenticated principal, `resourceAdmin` the resolved role.
            case "listAgentPackages":
                return this.transport.listAgentPackages(owner, resourceAdmin);
            case "getAgentPackage":
                return this.transport.getAgentPackage(safeParams.name, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "getAgentPackageTree":
                return this.transport.getAgentPackageTree(safeParams.name, safeParams.semver ?? null, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "getAgentPackageFile":
                return this.transport.getAgentPackageFile(safeParams.name, safeParams.semver ?? null, safeParams.filePath, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "uploadAgentPackage":
                return this.transport.uploadAgentPackage(safeParams.files, safeParams.scope, owner, resourceAdmin);
            case "listAgentWorkerState": {
                const rows = await this.transport.listAgentWorkerState();
                return resourceAdmin ? rows : rows.map(projectAgentWorkerState);
            }
            case "listWorkers": {
                const rows = await this.transport.listWorkers();
                return resourceAdmin ? rows : rows.map(projectWorker);
            }
            case "setAgentPackageScope":
                // `scope` here is the TARGET; the copy selector carries only
                // the optional admin owner override (source scope is derived
                // from the direction in the transport).
                return this.transport.setAgentPackageScope(safeParams.name, safeParams.scope, owner, resourceAdmin, packageSelectorParams(safeParams, { scopeless: true }));
            case "setAgentPackageEnabled":
                return this.transport.setAgentPackageEnabled(safeParams.name, safeParams.enabled, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "grantAgentPackageEditor": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                if (!grantee.provider || !grantee.subject) {
                    throw Object.assign(new Error("grantAgentPackageEditor requires user { provider, subject }"), { code: "INVALID_REQUEST" });
                }
                await this.transport.grantAgentPackageEditor(safeParams.name, grantee, owner, resourceAdmin);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "grantAgentPackageEditor",
                    sessionId: null,
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: `package=${safeParams.name}`,
                });
                return { name: safeParams.name, granted: { provider: grantee.provider, subject: grantee.subject } };
            }
            case "revokeAgentPackageEditor": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                if (!grantee.provider || !grantee.subject) {
                    throw Object.assign(new Error("revokeAgentPackageEditor requires user { provider, subject }"), { code: "INVALID_REQUEST" });
                }
                await this.transport.revokeAgentPackageEditor(safeParams.name, grantee, owner, resourceAdmin);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "revokeAgentPackageEditor",
                    sessionId: null,
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: `package=${safeParams.name}`,
                });
                return { name: safeParams.name, revoked: { provider: grantee.provider, subject: grantee.subject } };
            }
            case "listAgentPackageEditors":
                return this.transport.listAgentPackageEditors(safeParams.name);
            case "pinAgentPackageVersion":
                return this.transport.pinAgentPackageVersion(safeParams.name, safeParams.semver, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "deleteAgentPackage":
                return this.transport.deleteAgentPackage(safeParams.name, owner, resourceAdmin, packageSelectorParams(safeParams));
            case "republishAgentPackageVersion":
                return this.transport.republishAgentPackageVersion(
                    safeParams.name, safeParams.semver ?? null, safeParams.targetScope,
                    owner, resourceAdmin, {
                        selector: packageSelectorParams(safeParams),
                        createdBy: principalLabel(authContext),
                    },
                );

            case "listFeatureFlags":
            case "getClusterFeatureFlags":
            case "getMyFeatureFlags":
                return this.transport.mgmt[method]({ principal: owner, isAdmin });
            case "getCurrentMotd":
                return this.transport.mgmt.getCurrentMotd({ principal: owner, isAdmin });
            case "dismissMotd":
            case "deleteMotd":
                return this.transport.mgmt[method]({ principal: owner, isAdmin }, safeParams.motdId);
            case "getMotdImage":
                return this.transport.mgmt.getMotdImage({ principal: owner, isAdmin }, safeParams.motdId, safeParams.mobile);
            case "listMotds":
                return this.transport.mgmt.listMotds({ principal: owner, isAdmin }, safeParams.limit, safeParams.before);
            case "createMotd":
                return this.transport.mgmt.createMotd({ principal: owner, isAdmin }, safeParams);
            case "getUserFeatureFlags":
                return this.transport.mgmt.getUserFeatureFlags({ principal: owner, isAdmin }, Number(safeParams.userId));
            case "setClusterFeatureFlag":
            case "resetClusterFeatureFlag":
            case "setMyFeatureFlag":
            case "unsetMyFeatureFlag":
                return this.transport.mgmt[method]({ principal: owner, isAdmin }, safeParams);
            case "setUserFeatureFlag":
            case "unsetUserFeatureFlag":
                return this.transport.mgmt[method]({ principal: owner, isAdmin }, Number(safeParams.userId), safeParams);
            case "listFeatureFlagChanges":
                return this.transport.mgmt.listFeatureFlagChanges({ principal: owner, isAdmin }, safeParams.limit);
            case "listFeatureFlagUsers":
                return this.transport.mgmt.listFeatureFlagUsers({ principal: owner, isAdmin }, safeParams.query);

            // ── Provider budgets (docs/proposals/providers-and-budgets.md) ──
            // One family, one handler. `owner` is the authenticated
            // principal and `isAdmin` the resolved role — both server-side,
            // never off the wire.
            case "listProviders":
            case "getProviderStatus":
            case "getProviderUsageGrid":
            case "getProviderUsageSummary":
            case "getProviderUsageAgents":
            case "createProvider":
            case "createMyProvider":
            case "updateMyProviderCredential":
            case "updateSharedProviderCredential":
            case "deleteProvider":
            case "deleteMyProvider":
            case "clearProviderRoutingDependencies":
            case "setProviderLimit":
            case "removeProviderLimit":
            case "setProviderAllowance":
            case "setProviderHold":
            case "getDefaults":
            case "getModelDefaults":
            case "setModelDefault":
            case "setProviderSystemUse":
            case "getLegacyProviderMigrationStatus":
            case "adoptLegacySystemGitHubCopilotKey":
            case "setSystemModelDefault":
            case "setSystemSessionModel":
            case "clearSystemSessionModel":
            case "setClusterDefault":
            case "setMyDefault":
            case "getProviderUsage":
            case "listPausedSessions":
                return this._callProvider(method, safeParams, { principal: owner, isAdmin, adminScope: this.authz.adminScope });

            case "sendMessage": {
                // Canvas actions are CREATOR-only — not shared writers, not
                // admins. The canvas mutates: two viewers can be looking at
                // different revisions of the same surface, so only the one
                // person whose view the agent is provably conversing with may
                // answer through it (everyone else has the chat box, which
                // quotes its own words). The prefix is the wire marker the
                // browser bridge stamps on validated actions; enforcement
                // must live HERE because the prefix is trivially forgeable by
                // any API caller. Enforced even during the ownership
                // dark-launch: a brand-new capability has no pre-model
                // behavior to preserve (same rule as session:share). Fails
                // closed when no access snapshot is resolvable.
                if (typeof safeParams.prompt === "string" && safeParams.prompt.startsWith("[canvas-action] ")) {
                    const snapshot = gate.snapshot ?? await this._getAccessSnapshot(safeParams.sessionId, owner);
                    // Anyone who may WRITE the session may ring the doorbell
                    // (interactive-canvas-apps Part E): they can send a chat
                    // message already, so an action is no new power. Read-only
                    // viewers and link bearers are refused — their requests
                    // land in the KV as `suggested` instead.
                    const mayRing = Boolean(snapshot) && (
                        snapshot.viewerIsOwner || this._resourceAdmin(isAdmin, snapshot)
                        || snapshot.viewerShareAccess === "write" || snapshot.visibility === "shared_write");
                    if (!mayRing) {
                        throw forbiddenError("Canvas actions are accepted only from people who can write this session. Use the chat box, or ask the owner.");
                    }
                }
                return this.transport.sendMessage(safeParams.sessionId, safeParams.prompt, {
                    ...(safeParams.options && typeof safeParams.options === "object" ? safeParams.options : {}),
                    // Server-stamped; a client-supplied options.sender is overwritten.
                    sender: this._buildSender(authContext, gate.snapshot, { isAdmin, origin: safeParams.options?.origin }),
                });
            }
            case "sendAnswer":
                return this.transport.sendAnswer(safeParams.sessionId, safeParams.answer, {
                    ...(safeParams.options?.expectedQuestion !== undefined ? { expectedQuestion: safeParams.options.expectedQuestion } : {}),
                    sender: this._buildSender(authContext, gate.snapshot, { isAdmin }),
                });
            case "sendSessionEvent":
                return this.transport.sendSessionEvent(safeParams.sessionId, safeParams.eventName, safeParams.data);

            // ── Session sharing (security model) ────────────────────────
            case "getSessionAccess": {
                const snapshot = gate.snapshot ?? await this._getAccessSnapshot(safeParams.sessionId, owner);
                if (!snapshot) {
                    throw notFoundError();
                }
                const relation = snapshot.viewerIsOwner ? "owner" : (this._resourceAdmin(isAdmin, snapshot) ? "admin" : (snapshot.viewerShareAccess ? "collaborator" : "none"));
                const canWrite = this._resourceAdmin(isAdmin, snapshot) || snapshot.viewerIsOwner || snapshot.visibility === "shared_write" || snapshot.viewerShareAccess === "write";
                const canManage = this._resourceAdmin(isAdmin, snapshot) || snapshot.viewerIsOwner;
                // The caller's private placement of this tree (placements
                // live on the root), never another viewer's.
                const rootView = snapshot.rootSessionId
                    ? await this.transport.mgmt.getSession(snapshot.rootSessionId, placementPrincipal(authContext)).catch(() => null)
                    : null;
                return {
                    sessionId: safeParams.sessionId,
                    rootSessionId: snapshot.rootSessionId,
                    isSystem: snapshot.isSystem,
                    visibility: snapshot.visibility,
                    owner: snapshot.owner,
                    relation,
                    canWrite: snapshot.isSystem ? isAdmin : canWrite,
                    canManage: snapshot.isSystem ? isAdmin : canManage,
                    viewerGroupId: rootView?.viewerGroupId ?? null,
                    enforced: this.authz.enforce,
                };
            }
            case "setSessionVisibility": {
                const visibility = normalizeVisibility(safeParams.visibility, null);
                if (!visibility) {
                    throw Object.assign(new Error("visibility must be private | shared_read | shared_write"), { code: "INVALID_REQUEST" });
                }
                await this.transport.setSessionVisibility(safeParams.sessionId, visibility);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "setSessionVisibility",
                    sessionId: String(safeParams.sessionId),
                    decision: "share_change",
                    reason: `visibility=${visibility}`,
                });
                return { sessionId: safeParams.sessionId, visibility };
            }
            case "grantSessionShare": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                const access = safeParams.access === "write" ? "write" : safeParams.access === "read" ? "read" : null;
                if (!grantee.provider || !grantee.subject || !access) {
                    throw Object.assign(new Error("grantSessionShare requires user { provider, subject } and access read|write"), { code: "INVALID_REQUEST" });
                }
                await this.transport.grantSessionShare(safeParams.sessionId, grantee, access, owner);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "grantSessionShare",
                    sessionId: String(safeParams.sessionId),
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: `access=${access}`,
                });
                return { sessionId: safeParams.sessionId, granted: { ...grantee, access } };
            }
            case "revokeSessionShare": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                if (!grantee.provider || !grantee.subject) {
                    throw Object.assign(new Error("revokeSessionShare requires user { provider, subject }"), { code: "INVALID_REQUEST" });
                }
                await this.transport.revokeSessionShare(safeParams.sessionId, grantee);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "revokeSessionShare",
                    sessionId: String(safeParams.sessionId),
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: "revoked",
                });
                return { sessionId: safeParams.sessionId, revoked: grantee };
            }
            case "listSessionShares":
                return this.transport.listSessionShares(safeParams.sessionId);
            case "listKnownUsers":
                return typeof this.transport.listKnownUsers === "function"
                    ? this.transport.listKnownUsers({ limit: safeParams.limit })
                    : [];
            case "listAuthzAudit":
                return this.transport.listAuthzAudit({
                    limit: safeParams.limit,
                    sessionId: safeParams.sessionId ?? null,
                });
            case "getSessionStatus":
                return this.transport.getSessionStatus(safeParams.sessionId);
            case "waitForStatusChange": {
                // Long-poll: the server holds the request open, capped well
                // below typical ingress idle timeouts. On timeout the
                // underlying wait throws; translate that into "no change"
                // by returning the current status, so the client sees a
                // clean unchanged snapshot and loops (instead of a 500).
                const sessionId = safeParams.sessionId;
                const afterVersion = Number(safeParams.afterVersion) || 0;
                const timeoutMs = clampInteger(safeParams.timeoutMs, 25_000, 1_000, 300_000);
                try {
                    return await this.transport.waitForStatusChange(sessionId, afterVersion, timeoutMs);
                } catch (error) {
                    if (/Timed out waiting/i.test(String(error?.message || ""))) {
                        return this.transport.getSessionStatus(sessionId);
                    }
                    throw error;
                }
            }
            case "getLatestResponse":
                return this.transport.getLatestResponse(safeParams.sessionId);
            case "cancelPendingMessage":
                return this.transport.cancelPendingMessage(safeParams.sessionId, safeParams.clientMessageIds);
            case "renameSession":
                // The caller's own view of the agent catalog: another user's
                // private package must never shape this session's title.
                return this.transport.renameSession(safeParams.sessionId, safeParams.title, { viewer: owner, isAdmin: resourceAdmin });
            case "cancelSession":
                return this.transport.cancelSession(safeParams.sessionId);
            case "cancelSessionGroup":
                return this.transport.cancelSessionGroup(safeParams.groupId, safeParams.reason);
            case "completeSession":
                return this.transport.completeSession(safeParams.sessionId, safeParams.reason);
            case "completeSessionGroup":
                return this.transport.completeSessionGroup(safeParams.groupId, safeParams.options || {});
            case "deleteSession":
                if (safeParams.force === true) this._assertMayForceDelete(gate, safeParams.sessionId, authContext, isAdmin);
                return this.transport.deleteSession(safeParams.sessionId, safeParams.reason, {
                    ...(safeParams.force === true ? { force: true } : {}),
                    ...(safeParams.settleTimeoutMs !== undefined ? { settleTimeoutMs: safeParams.settleTimeoutMs } : {}),
                });
            case "restartSystemSession":
                return this.transport.restartSystemSession(safeParams.agentIdOrSessionId, safeParams.options || {});
            case "setSessionModel":
                return this.transport.setSessionModel(safeParams.sessionId, safeParams.options || {});
            case "stopSessionTurn":
            case "steerSessionTurn":
                // Server-stamped caller (P18): the sender and the viewer that
                // resolves sessions.steering come from the authenticated
                // context; a client-supplied options.caller is overwritten.
                return this.transport[method](safeParams.sessionId, {
                    ...(safeParams.options && typeof safeParams.options === "object" ? safeParams.options : {}),
                    caller: {
                        sender: this._buildSender(authContext, gate.snapshot, { isAdmin, origin: safeParams.options?.origin }),
                        viewer: { principal: owner, isAdmin },
                    },
                });
            case "deleteSessionGroup":
                return this.transport.deleteSessionGroup(safeParams.groupId);
            case "listModels":
                return this.transport.listModels({ principal: owner, isAdmin });
            case "listArtifacts":
                return this.transport.listArtifacts(safeParams.sessionId);
            case "getArtifactMetadata":
                return this.transport.getArtifactMetadata(safeParams.sessionId, safeParams.filename);
            case "deleteArtifact":
                return this.transport.deleteArtifact(safeParams.sessionId, safeParams.filename);
            case "downloadArtifact":
                return this.transport.downloadArtifact(safeParams.sessionId, safeParams.filename);
            case "uploadArtifact":
                return this.transport.uploadArtifactContent(
                    safeParams.sessionId,
                    safeParams.filename,
                    safeParams.content,
                    safeParams.contentType,
                    safeParams.contentEncoding,
                );
            case "copyArtifact":
                return this.transport.copyArtifact(
                    safeParams.fromSessionId,
                    safeParams.fromFilename,
                    safeParams.toSessionId,
                    safeParams.toFilename,
                );
            case "setArtifactPinned":
                return this.transport.setArtifactPinned(safeParams.sessionId, safeParams.filename, safeParams.pinned);
            case "readArtifactBase64":
                return this.transport.readArtifactBase64(safeParams.sessionId, safeParams.filename, safeParams.maxBytes);
            case "exportExecutionHistory":
                return this.transport.exportExecutionHistory(safeParams.sessionId);
            case "getModelsByProvider":
                return this.transport.getModelsByProvider();
            case "getDefaultModel":
                return this.transport.getDefaultModel();
            case "getSessionEvents":
                return this.transport.getSessionEvents(safeParams.sessionId, safeParams.afterSeq, safeParams.limit, safeParams.eventTypes);
            case "getSessionEventsBefore":
                return this.transport.getSessionEventsBefore(safeParams.sessionId, safeParams.beforeSeq, safeParams.limit, safeParams.eventTypes);
            case "getCanvasLive":
                return this.transport.getCanvasLive(safeParams.sessionId);
            case "getLive":
                return this.transport.getLive(safeParams.sessionId, safeParams.topics);
            case "readCanvasKv": {
                const slot = this._canvasKvSlot(safeParams.slot);
                return this.transport.readCanvasKv(safeParams.sessionId, slot, this._canvasKvPrincipal(authContext, owner, this._resourceAdmin(isAdmin, gate.snapshot)), {
                    prefix: safeParams.prefix ?? null,
                    limit: safeParams.limit ?? null,
                    after: safeParams.after ?? null,
                    key: safeParams.key ?? null,
                });
            }
            case "writeCanvasKv": {
                const slot = this._canvasKvSlot(safeParams.slot);
                const ops = Array.isArray(safeParams.ops) ? safeParams.ops : [];
                if (ops.length === 0 || ops.length > 50) {
                    throw Object.assign(new Error("writeCanvasKv requires ops: [{op, key, value?, ifMatch?}] (1-50)"), { code: "INVALID_REQUEST" });
                }
                const who = `${owner?.provider ?? ""}/${owner?.subject ?? ""}`;
                // Rate limits live at the door (Part I): 10 WRITES/s per
                // viewer across the session, 50/s per canvas. Counted per op,
                // not per request, or one 50-op request would be free.
                if (!this._canvasKvRateOk(`${safeParams.sessionId}:${who}`, 10, ops.length) || !this._canvasKvRateOk(`${safeParams.sessionId}:${slot}`, 50, ops.length)) {
                    throw Object.assign(new Error("canvas KV write rate exceeded (10 writes/s per viewer, 50/s per canvas)"), { code: "RATE_LIMITED", status: 429 });
                }
                return this.transport.writeCanvasKv(safeParams.sessionId, slot, this._canvasKvPrincipal(authContext, owner, this._resourceAdmin(isAdmin, gate.snapshot)), ops);
            }
            case "setCanvasKvAccess": {
                const slot = this._canvasKvSlot(safeParams.slot);
                const access = String(safeParams.access ?? "");
                if (!["owner", "readers", "link"].includes(access)) {
                    throw Object.assign(new Error("setCanvasKvAccess requires access: owner | readers | link"), { code: "INVALID_REQUEST" });
                }
                await this.transport.setCanvasKvAccess(safeParams.sessionId, slot, access);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "setCanvasKvAccess",
                    sessionId: String(safeParams.sessionId),
                    decision: "share_change",
                    reason: `slot=${slot} kv-access=${access}`,
                });
                return { sessionId: safeParams.sessionId, slot, access };
            }
            case "getCanvasShareLink":
                return this.transport.getCanvasShareLink(safeParams.sessionId, safeParams.slot);
            case "resetCanvasShareLink": {
                const slot = coerceShareSlot(safeParams.slot);
                const minted = await this.transport.resetCanvasShareLink(safeParams.sessionId, slot, principalLabel(authContext));
                // A public link is a share change (interactive-canvas-apps H.3).
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "resetCanvasShareLink",
                    sessionId: String(safeParams.sessionId),
                    decision: "share_change",
                    reason: `slot=${slot} public view link minted or rotated`,
                });
                return minted;
            }
            case "removeCanvasShareLink": {
                const slot = coerceShareSlot(safeParams.slot);
                const removed = await this.transport.removeCanvasShareLink(safeParams.sessionId, slot);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "removeCanvasShareLink",
                    sessionId: String(safeParams.sessionId),
                    decision: "share_change",
                    reason: `slot=${slot} public view link removed`,
                });
                return removed;
            }
            case "getTopEventEmitters":
                return this.transport.getTopEventEmitters(normalizeTopEventEmitterOptions(safeParams));
            case "getLogConfig":
                return this.transport.getLogConfig();
            case "getWorkerCount":
                return this.transport.getWorkerCount();
            default:
                throw new Error(`Unsupported portal RPC method: ${method}`);
        }
    }

    /**
     * The provider-budget operations
     * (docs/proposals/providers-and-budgets-surface.md).
     *
     * Nothing here asks whether the viewer may do the thing. The
     * `cms_provider_*` procedures decide that — an admin and a plain user
     * call the same operation and the database gives them different answers
     * — so this method only reshapes the wire params and turns the refusal
     * code into an HTTP status.
     *
     * The management client is reached directly rather than through a
     * transport wrapper, like the other viewer-carrying calls above
     * (listSessionsPage, getSession, placeSessionsInGroup): a wrapper would
     * stamp the transport's own current user over the request's viewer.
     */
    async _callProvider(method, params, viewer) {
        const mgmt = this.transport.mgmt;
        try {
            switch (method) {
                case "listProviders":
                    return await mgmt.listProviders(viewer);
                case "getProviderStatus":
                    return await mgmt.getProviderStatus(viewer, providerNames(params.names));
                // The table's one read. The viewer is stamped here, from the
                // authenticated request — the wire carries no user id, so no
                // caller can ask for somebody else's "your usage" column.
                case "getProviderUsageGrid":
                    return await mgmt.getProviderUsageGrid(viewer);
                case "createProvider":
                    return await mgmt.createProvider(viewer, {
                        name: params.name,
                        type: params.type,
                        credentials: params.credentials,
                        baseUrl: params.baseUrl,
                    });
                case "createMyProvider":
                    return await mgmt.createMyProvider(viewer, {
                        name: params.name,
                        type: params.type,
                        credentials: params.credentials,
                        baseUrl: params.baseUrl,
                    });
                case "updateMyProviderCredential":
                    return await mgmt.updateMyProviderCredential(viewer, {
                        name: params.name,
                        credentials: params.credentials,
                    });
                case "updateSharedProviderCredential":
                    return await mgmt.updateSharedProviderCredential(viewer, {
                        name: params.name,
                        credentials: params.credentials,
                    });
                case "deleteProvider":
                    return await mgmt.deleteProvider(viewer, params.name);
                case "deleteMyProvider":
                    return await mgmt.deleteMyProvider(viewer, params.name);
                case "clearProviderRoutingDependencies":
                    return await mgmt.clearProviderRoutingDependencies(viewer, params.name);
                case "setProviderLimit":
                    return await mgmt.setProviderLimit(viewer, {
                        provider: params.name,
                        period: params.period,
                        model: params.model ?? null,
                        tokens: params.tokens,
                    });
                case "removeProviderLimit":
                    return await mgmt.removeProviderLimit(viewer, {
                        provider: params.name,
                        period: params.period,
                        model: params.model ?? null,
                    });
                case "setProviderAllowance":
                    return await mgmt.setProviderAllowance(viewer, { provider: params.name, pct: params.pct });
                case "setProviderHold":
                    return await mgmt.setProviderHold(viewer, {
                        provider: params.name,
                        untilUtc: params.untilUtc ?? null,
                        release: params.release === true,
                    });
                case "getDefaults":
                    return await mgmt.getDefaults(viewer);
                case "getModelDefaults":
                    return await mgmt.getModelDefaults(viewer);
                case "setModelDefault":
                    return await mgmt.setModelDefault(viewer, {
                        scope: params.scope,
                        provider: params.provider ?? null,
                        model: params.model ?? null,
                        reasoningEffort: params.reasoningEffort ?? null,
                        contextTier: params.contextTier ?? null,
                    });
                case "setProviderSystemUse":
                    return await mgmt.setProviderSystemUse(viewer, {
                        provider: params.name,
                        enabled: params.enabled === true,
                    });
                case "getLegacyProviderMigrationStatus":
                    return await mgmt.getLegacyProviderMigrationStatus(viewer);
                case "adoptLegacySystemGitHubCopilotKey":
                    return await mgmt.adoptLegacySystemGitHubCopilotKey(viewer, {
                        name: params.name,
                    });
                case "setSystemModelDefault":
                    return await mgmt.setSystemModelDefault(viewer, {
                        provider: params.provider ?? null,
                        model: params.model ?? null,
                        reasoningEffort: params.reasoningEffort ?? null,
                        contextTier: params.contextTier ?? null,
                        restartExisting: params.restartExisting || false,
                    });
                case "setSystemSessionModel":
                    return await mgmt.setSystemSessionModel(viewer, {
                        agentId: params.agentId,
                        provider: params.provider,
                        model: params.model,
                        reasoningEffort: params.reasoningEffort ?? null,
                        contextTier: params.contextTier ?? null,
                    });
                case "clearSystemSessionModel":
                    return await mgmt.clearSystemSessionModel(viewer, params.agentId);
                case "setClusterDefault":
                    return await mgmt.setClusterDefault(viewer, {
                        provider: params.provider ?? null,
                        model: params.model ?? null,
                        reasoning: params.reasoning ?? null,
                        context: params.context ?? null,
                    });
                case "setMyDefault":
                    return await mgmt.setMyDefault(viewer, {
                        provider: params.provider ?? null,
                        model: params.model ?? null,
                        reasoning: params.reasoning ?? null,
                        context: params.context ?? null,
                    });
                case "getProviderUsageSummary":
                    return await mgmt.getProviderUsageSummary(viewer, {
                        days: params.days,
                        // One comma-separated query value on the wire; names
                        // never contain commas.
                        providers: typeof params.providers === "string"
                            ? params.providers.split(",").map((p) => p.trim()).filter(Boolean)
                            : (Array.isArray(params.providers) ? params.providers : []),
                    });
                case "getProviderUsageAgents":
                    return await mgmt.getProviderUsageAgents(viewer, {
                        days: params.days,
                        providers: typeof params.providers === "string"
                            ? params.providers.split(",").map((p) => p.trim()).filter(Boolean)
                            : (Array.isArray(params.providers) ? params.providers : []),
                    });
                case "getProviderUsage":
                    return await mgmt.getProviderUsage(viewer, {
                        days: params.days,
                        // Resolved from the authenticated caller, not from the
                        // wire: a boolean cannot name somebody else.
                        mine: params.mine === true || params.mine === "true",
                        ownerUserId: params.ownerUserId ?? null,
                        provider: params.provider ?? null,
                        model: params.model ?? null,
                        sessionId: params.sessionId ?? null,
                        chargeClass: params.chargeClass ?? null,
                        dimension: params.dimension ?? null,
                        limit: params.limit,
                    });
                case "listPausedSessions":
                    return await mgmt.listPausedSessions(viewer);
                default:
                    throw new Error(`Unsupported portal RPC method: ${method}`);
            }
        } catch (error) {
            const status = PROVIDER_ERROR_STATUS[error?.code];
            if (status) error.status = status;
            if (error?.code === "PROVIDER_SECRET_STORE_UNAVAILABLE") error.expose = true;
            throw error;
        }
    }

    /**
     * Server-stamped message sender: identity from the validated auth
     * context, relation from the access snapshot. Never trusts
     * client-supplied identity fields; `origin` is client-declared display
     * metadata only.
     */
    _buildSender(authContext, snapshot, { isAdmin = false, origin } = {}) {
        const principal = normalizeSessionOwner(authContext);
        if (!principal) return undefined;
        const allowedOrigins = new Set(["portal", "tui", "mcp", "api"]);
        return {
            kind: "user",
            provider: principal.provider,
            subject: principal.subject,
            display: principal.displayName || principal.email || principal.subject,
            relation: relationFor(snapshot, { isAdmin, adminScope: this.authz.adminScope }),
            origin: allowedOrigins.has(origin) ? origin : "api",
        };
    }

    async downloadArtifact(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("downloadArtifact", sessionId, authContext);
        return this.transport.downloadArtifact(sessionId, filename);
    }

    async getArtifactMetadata(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("getArtifactMetadata", sessionId, authContext);
        if (typeof this.transport.getArtifactMetadata !== "function") return null;
        return this.transport.getArtifactMetadata(sessionId, filename);
    }

    async downloadArtifactBinary(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("downloadArtifact", sessionId, authContext);
        if (typeof this.transport.downloadArtifactBinary === "function") {
            return this.transport.downloadArtifactBinary(sessionId, filename);
        }
        const content = await this.transport.downloadArtifact(sessionId, filename);
        return {
            filename,
            contentType: "text/plain",
            isBinary: false,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            uploadedAt: new Date().toISOString(),
            source: "agent",
            body: Buffer.from(content, "utf8"),
        };
    }

    async downloadAgentPackageBinary(name, semver, authContext = null, selector = null) {
        await this.start();
        const owner = normalizeSessionOwner(authContext);
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        return this.transport.downloadAgentPackage(name, semver ?? null, owner, this._resourceAdmin(isAdmin), selector);
    }

    /** session:read gate for the bespoke (non-dispatched) artifact routes. */
    async _gateBespokeRead(action, sessionId, authContext) {
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        const owner = normalizeSessionOwner(authContext);
        await this._gateSession(action, "session:read", sessionId, authContext, { owner, isAdmin });
    }

    /**
     * WebSocket subscription gate (api/ws.js). Throws 403/404 when the
     * caller cannot read the session; audited like every other decision.
     */
    async authorizeSessionSubscribe(sessionId, authContext) {
        await this.start();
        await this._gateBespokeRead("subscribeSession", sessionId, authContext);
    }

    /**
     * For the dispatcher's subscription to another user's session: a check of
     * the owner's opt-in to run before each delivery, so an open subscription
     * sends nothing more once delegation is off. Null when none is needed —
     * also with enforcement off, where revoking changes no access.
     */
    async dispatcherDeliveryCheck(sessionId, authContext) {
        if (!this.authz.enforce || !this._isDispatcher(authContext)) return null;
        await this.start();
        const snapshot = await this._getAccessSnapshot(sessionId, normalizeSessionOwner(authContext));
        const owner = snapshot && !snapshot.isSystem ? this._delegatingOwner(snapshot.owner, authContext) : null;
        return owner ? () => this._ownerAllowsDelegation(owner) : null;
    }

    /** Log tail is fleet-wide observability: admin (or dark-launch). */
    async authorizeLogSubscribe(authContext) {
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        if (this._resourceAdmin(isAdmin)) return;
        this._recordAudit({
            actor: this._auditActor(authContext),
            action: "subscribeLogs",
            decision: this.authz.enforce ? "deny" : "would_deny",
            reason: "log tail requires the admin role",
        });
        if (this.authz.enforce) {
            throw forbiddenError("The live log tail requires the admin role.");
        }
    }

    subscribeSession(sessionId, handler) {
        return this.transport.subscribeSession(sessionId, handler);
    }

    async getLive(sessionId, topics) {
        await this.start();
        if (typeof this.transport.getLive !== "function") return [];
        return this.transport.getLive(sessionId, topics);
    }

    /**
     * The canvas share-token doors. The raw token is hashed HERE (sha256);
     * only the hash ever reaches the catalog. Returns the canvas the token
     * views, or null — and null is the only error shape, so the doors leak
     * nothing about why a token failed.
     */
    async resolveCanvasShareToken(rawToken) {
        const token = String(rawToken || "").trim();
        if (!token || token.length > 512) return null;
        if (typeof this.transport.resolveCanvasShareTokenHash !== "function") return null;
        const { createHash } = await import("node:crypto");
        const hash = createHash("sha256").update(token, "utf8").digest("hex");
        try {
            return await this.transport.resolveCanvasShareTokenHash(hash);
        } catch {
            return null;
        }
    }

    /** Share door: the canvas document bytes for a validated token. */
    async getCanvasShareDoc(rawToken) {
        const scope = await this.resolveCanvasShareToken(rawToken);
        if (!scope) return null;
        const filename = scope.slot === 1 ? "canvas.html" : `canvas${scope.slot}.html`;
        try {
            // Transport-level fetch, deliberately: the token IS the
            // authorization here; the runtime's auth-gated wrapper is for
            // signed-in principals.
            const artifact = await this.transport.downloadArtifactBinary(scope.sessionId, filename);
            const body = artifact?.body;
            if (!body) return null;
            const html = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
            return { ...scope, html };
        } catch {
            return null;
        }
    }

    /** The KV chokepoint's user principal for a signed-in caller. */
    _canvasKvPrincipal(authContext, owner, isAdmin) {
        // `label` is what other people SEE on a row: the display name, then
        // the email, then the bare subject. (principalLabel prefers email —
        // it was written for share-link provenance, not for attribution.)
        const p = authContext?.principal ?? owner ?? {};
        const label = String(p?.displayName || owner?.displayName || p?.email || owner?.email || p?.subject || "").trim();
        return {
            kind: "user",
            provider: String(owner?.provider ?? ""),
            subject: String(owner?.subject ?? ""),
            isAdmin: Boolean(isAdmin),
            label: label || null,
        };
    }

    /** A canvas slot from a request param: integer 1-5, else INVALID_REQUEST. */
    _canvasKvSlot(raw) {
        const value = raw && typeof raw === "object" && raw.slot !== undefined ? raw.slot : raw;
        const slot = value === undefined || value === null || value === "" ? 1 : Number(value);
        if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
            throw Object.assign(new Error("slot must be an integer 1-5"), { code: "INVALID_REQUEST" });
        }
        return slot;
    }

    /** Sliding one-second window per key; true when `count` more writes fit. */
    _canvasKvRateOk(key, perSecond, count = 1) {
        if (!this._canvasKvRate) this._canvasKvRate = new Map();
        const now = Date.now();
        const stamps = (this._canvasKvRate.get(key) || []).filter((t) => now - t < 1000);
        if (stamps.length + count > perSecond) {
            this._canvasKvRate.set(key, stamps);
            return false;
        }
        for (let i = 0; i < count; i++) stamps.push(now);
        this._canvasKvRate.set(key, stamps);
        // Bound the map: forget idle keys on every 500th check.
        if (this._canvasKvRate.size > 2000) {
            for (const [k, v] of this._canvasKvRate) {
                if (v.length === 0 || now - v[v.length - 1] > 5000) this._canvasKvRate.delete(k);
            }
        }
        return true;
    }

    /**
     * Share door: the KV store for a validated token — READ ONLY. Session
     * and slot come from the token row; the bearer never names them.
     */
    async getCanvasShareKv(rawToken, query = {}) {
        const scope = await this.resolveCanvasShareToken(rawToken);
        if (!scope) return null;
        if (typeof this.transport.readCanvasKvForLink !== "function") return null;
        try {
            const read = await this.transport.readCanvasKvForLink(scope.sessionId, scope.slot, query);
            return { slot: scope.slot, ...read };
        } catch {
            return null;
        }
    }

    /** Share door: the live last-value state for a validated token. */
    async getCanvasShareLive(rawToken) {
        const scope = await this.resolveCanvasShareToken(rawToken);
        if (!scope) return null;
        try {
            const rows = await this.transport.getCanvasLive(scope.sessionId);
            const hit = (rows || []).find((r) => Number(r.slot) === scope.slot) || null;
            return { slot: scope.slot, live: hit };
        } catch {
            return { slot: scope.slot, live: null };
        }
    }

    startLogTail(handler) {
        return this.transport.startLogTail(handler);
    }
}
