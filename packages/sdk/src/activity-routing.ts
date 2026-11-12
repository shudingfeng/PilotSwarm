/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Orchestrations 1.0.75 and later opt into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
/**
 * Contracts:
 * - "agent-handoff-v2" (1.0.75+): handoff activity names and tag.
 * - "turn-control-v1" (1.0.81+): turns run as runTurnV4/runTurnEpochV4 with
 *   TURN_CONTROL_CAPABILITY; every other routed activity keeps the handoff
 *   names and tag.
 * - "workflow-intake-v1" (1.0.83+): turns run as
 *   runTurnV5/runTurnEpochV5 with WORKFLOW_REQUEST_CAPABILITY; their input
 *   may carry `intake` and their result carries `intakeDispatch`; every other
 *   routed activity keeps the handoff names and tag, as under turn-control-v1.
 *   An owner-tagged session's turns (1.0.84) carry its owner tag instead.
 */
export type ActivityRoutingContract = "agent-handoff-v2" | "turn-control-v1" | "workflow-intake-v1";
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
    getSessionStatus: "getSessionStatusV2",
    listChildSessions: "listChildSessionsV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(AGENT_HANDOFF_CAPABILITY);
}

/**
 * Session workspaces (1.0.80): the turns of a session that has, or had, a
 * workspace, and the checkWorkspace and releaseWorkspace activities, go only
 * to workers that declare this tag. During a rolling deploy, an older worker
 * would run such a turn in its own folder, and it lacks the two activities.
 * The tag stands for the handoff contract as well: every worker that
 * declares it also declares AGENT_HANDOFF_CAPABILITY.
 */
export const WORKSPACE_CAPABILITY = "pilotswarm.workspaces.v1";

export function routeWorkspaceActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Session workspaces require Duroxide activity tag routing support");
    }
    return task.withTag(WORKSPACE_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any, versionedHandler = handler): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], versionedHandler);
}

/**
 * Session turn control (1.0.81): turns whose Stop and Steer go through the
 * CMS run only on workers that declare this tag. An older worker would run
 * the turn without listening for controls, while 1.0.81 no longer races a
 * Stop event. Every worker that declares it also declares
 * AGENT_HANDOFF_CAPABILITY and WORKSPACE_CAPABILITY.
 */
export const TURN_CONTROL_CAPABILITY = "pilotswarm.turn-control.v1";
export const TURN_CONTROL_ACTIVITY_NAMES = {
    runTurn: "runTurnV4",
    runTurn2: "runTurnEpochV4",
} as const;

/**
 * Route a V4 turn with only the turn-control capability tag. Fail closed
 * when the runtime cannot express that tag; never schedule an untagged turn.
 */
export function routeTurnControlActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Session turn control requires Duroxide activity tag routing support");
    }
    return task.withTag(TURN_CONTROL_CAPABILITY);
}

/** Register a turn-control activity name. The legacy and handoff names stay registered by registerHandoffActivity. */
export function registerTurnControlActivity(runtime: any, name: keyof typeof TURN_CONTROL_ACTIVITY_NAMES, handler: any): void {
    runtime.registerActivity(TURN_CONTROL_ACTIVITY_NAMES[name], handler);
}

/**
 * Workflow request and durable intake (design workflow-messaging-request.md
 * 8.2, workflow-durable-intake.md section 8): every activity of orchestration
 * 1.0.83's intake goes only to workers that declare this tag, so an older
 * worker never fetches work it cannot run. Every worker declares it
 * (WORKFLOW_MILESTONE_WORKER_TAGS, workflow/milestone-worker.ts).
 */
export const WORKFLOW_REQUEST_CAPABILITY = "pilotswarm.workflow-request.v1";

/** Route an activity with the workflow-request capability tag. Fail closed when the runtime cannot express it. */
export function routeWorkflowRequestActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("The workflow intake requires Duroxide activity tag routing support");
    }
    return task.withTag(WORKFLOW_REQUEST_CAPABILITY);
}

/**
 * The turn activities of orchestration 1.0.83 (design
 * workflow-durable-intake.md section 8): the turn-control turn, whose input
 * may carry an invocation's `intake` field and whose result carries the
 * `intakeDispatch` witness. An older worker would ignore the field and drop
 * the items, so they have names of their own and go only to workers that
 * declare WORKFLOW_REQUEST_CAPABILITY. Every worker registers them
 * (registerActivities, session-proxy.ts), and every 1.0.83 turn runs under
 * them.
 */
export const WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES = {
    runTurn: "runTurnV5",
    runTurn2: "runTurnEpochV5",
} as const;

/** Register a workflow-intake turn activity name. */
export function registerWorkflowIntakeTurnActivity(runtime: any, name: keyof typeof WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES, handler: any): void {
    runtime.registerActivity(WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES[name], handler);
}

/**
 * Owner routing (1.0.84): every session-scoped activity of an owner-tagged
 * session carries the owner's tag, `owner.<subject>`, so only that owner's
 * workers run it. duroxide gives an activity one tag, so on the turn (with or
 * without an intake invocation) and the two workspace activities the owner
 * tag replaces the capability tag. It stands for those capabilities as well:
 * only a release that has them lets a worker declare an owner tag. The
 * intake's own writes and the report of a failed Workflow agent turn are
 * catalog writes that run no session: they keep the workflow-request tag, as
 * the manager activities keep theirs.
 */
export function routeOwnerActivity(task: any, ownerTag: string): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Owner routing requires Duroxide activity tag routing support");
    }
    return task.withTag(ownerTag);
}

/**
 * Owner routing (1.0.84): the requestOwnerCapacity activity goes only to
 * workers that have a capacity requester, which declare this tag.
 */
export const OWNER_CAPACITY_CAPABILITY = "pilotswarm.owner-capacity.v1";

export function routeOwnerCapacityActivity(task: any): any {
    if (typeof task.withTag !== "function") {
        throw new Error("Owner capacity requests require Duroxide activity tag routing support");
    }
    return task.withTag(OWNER_CAPACITY_CAPABILITY);
}

/**
 * duroxide's MAX_WORKER_TAGS. duroxide-node 0.2.4 does not check it when a
 * runtime starts, so workerTagFilter keeps every filter within it.
 */
export const MAX_WORKER_TAGS = 5;

/**
 * A worker's tag filter: untagged work and the capability tags every worker
 * declares (`workflowTags` is WORKFLOW_MILESTONE_WORKER_TAGS), plus the
 * owner's tag when the worker has one, or the capacity tag when it has a
 * capacity requester. Without either it is the default filter exactly. With
 * four capability tags either one makes five, so a worker that has both, six,
 * is refused.
 *
 * An owner-only worker names its owner's tag alone, so it claims only that
 * owner's session-scoped activities: no untagged work, no capability-tagged
 * activity (Workflow activities included) and no capacity request, whose tag
 * is not owner-scoped. duroxide applies the filter to activities only, so
 * every worker still runs orchestration turns; their ctx.utcNow() and
 * ctx.newGuid() are untagged duroxide activities, which another worker must
 * run.
 */
export function workerTagFilter(
    opts: { ownerTag?: string; ownerCapacity?: boolean; ownerOnly?: boolean; workflowTags?: readonly string[] } = {},
): { defaultAnd: string[] } | { tags: string[] } {
    if (opts.ownerOnly) {
        // duroxide-node passes { tags: [] } on without duroxide's check for an
        // empty list, and the worker would then claim nothing.
        if (!opts.ownerTag) throw new TypeError("an owner-only worker needs an owner tag");
        return { tags: [opts.ownerTag] };
    }
    if (opts.ownerTag && opts.ownerCapacity) {
        throw new TypeError("a worker with an owner tag takes no capacity requests: give the capacity requester to a worker without an owner tag, or make this worker owner-only");
    }
    const tags = [
        AGENT_HANDOFF_CAPABILITY,
        WORKSPACE_CAPABILITY,
        TURN_CONTROL_CAPABILITY,
        ...(opts.workflowTags ?? [WORKFLOW_REQUEST_CAPABILITY]),
        ...(opts.ownerTag ? [opts.ownerTag] : []),
        ...(opts.ownerCapacity ? [OWNER_CAPACITY_CAPABILITY] : []),
    ];
    if ((opts.ownerTag || opts.ownerCapacity) && tags.length > MAX_WORKER_TAGS) {
        throw new TypeError(`a worker's filter holds at most ${MAX_WORKER_TAGS} tags, duroxide's limit, not ${tags.length}`);
    }
    return { defaultAnd: tags };
}
