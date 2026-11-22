/**
 * Shared durable-session orchestration version constants.
 *
 * The latest version is the canonical target for new starts and every
 * continue-as-new handoff. Frozen orchestration files keep their own
 * CURRENT_ORCHESTRATION_VERSION for replay/tracing, but must not hard-code
 * the latest target themselves.
 *
 * The compatibility floor documents the oldest orchestration input wire
 * format that the latest handler must continue to normalize while that
 * version remains registered in the repo.
 *
 * The latest version is this fork's own (FORK_ORCHESTRATION_BASES below).
 *
 * @internal
 */
export const DURABLE_SESSION_LATEST_VERSION = "1.0.1000";
export const DURABLE_SESSION_COMPATIBILITY_FLOOR_VERSION = "1.0.47";

/**
 * This fork's own orchestration versions, each with the upstream version it is built on: its handler is that
 * version's plus this fork's changes. Upstream numbers its versions one after another, so a fork version takes a patch
 * number from 1000 up and a sync never changes what a recorded fork version means. Every version gate answers for a
 * fork version as it does for its base (test/unit/orchestration-gate-parity.test.mjs).
 */
export const FORK_ORCHESTRATION_BASES: Readonly<Record<string, string>> = Object.freeze({
    "1.0.1000": "1.0.86", // owner routing, on upstream's 1.0.86 (spawn workspace selection)
});

/**
 * Session workspaces: the first orchestration version that applies the
 * results of set_session_workspace and the spawn `workspace` parameter.
 */
export const WORKSPACE_ORCHESTRATION_MIN_VERSION = "1.0.80";
