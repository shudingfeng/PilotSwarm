/**
 * The full-engine worker module (workflow/milestone-worker.ts): what every worker serves since 1.0.83 became the latest
 * version (owner decision 2026-11-08T15:30Z). 1.0.84, the latest now, is 1.0.83 plus owner routing and keeps its intake.
 *
 * - Its activity tag is the workflow-request capability; every worker adds it to its tag filter (worker.ts).
 * - It registers 1.0.83's two intake activities, and no orchestration: the registry registers 1.0.84 as the latest and
 *   keeps 1.0.83, frozen.
 * - A client starts sessions at the latest version unless a test tells it to start them at another registered version
 *   (an upgrade test), and refuses a version that is not registered.
 * - A stored reasoning effort is used only when it names one.
 *
 * Run: node --test test/unit/workflow-milestone-worker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKFLOW_MILESTONE_WORKER_TAGS, registerWorkflowMilestoneSessions } from "../../dist/workflow/milestone-worker.js";
import { WORKFLOW_REQUEST_CAPABILITY, workerTagFilter } from "../../dist/activity-routing.js";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../dist/workflow/intake.js";
import { WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY } from "../../dist/workflow/agent-turn-failure.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { isReasoningEffort } from "../../dist/model-providers.js";

const WORKER = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");

test("every worker declares the workflow-request tag and serves the full engine, with no test option", () => {
    assert.deepEqual([...WORKFLOW_MILESTONE_WORKER_TAGS], [WORKFLOW_REQUEST_CAPABILITY]);
    assert.match(WORKER, /const milestone = await import\("\.\/workflow\/milestone-worker\.js"\);/);
    // Owner routing builds the filter in workerTagFilter (activity-routing.ts), from the milestone's tags.
    assert.match(WORKER, /workerTagFilter\(\{\s+workflowTags: milestone\.WORKFLOW_MILESTONE_WORKER_TAGS,/);
    assert.ok(workerTagFilter({ workflowTags: WORKFLOW_MILESTONE_WORKER_TAGS }).defaultAnd.includes(WORKFLOW_REQUEST_CAPABILITY));
    assert.match(WORKER, /\n\s+agentNodes: milestone\.workflowMilestoneAgentNodes\(/);
    assert.doesNotMatch(WORKER, /workflowRequests/);
});

test("it registers 1.0.83's intake activities, its failed-turn report and no orchestration; the registry's latest version is 1.0.84, and 1.0.83 is registered", () => {
    const orchestrations = [];
    const activities = [];
    registerWorkflowMilestoneSessions({
        registerOrchestrationVersioned: (name, version) => orchestrations.push({ name, version }),
        registerActivity: name => activities.push(name),
    }, { store: null });
    assert.deepEqual(orchestrations, []);
    assert.deepEqual(activities, [WORKFLOW_INTAKE_ACTIVITIES.claim, WORKFLOW_INTAKE_ACTIVITIES.settle, WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY]);
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, DURABLE_SESSION_LATEST_VERSION);
    assert.ok(DURABLE_SESSION_ORCHESTRATION_REGISTRY.some(entry => entry.version === "1.0.83"));
});

test("a client starts sessions at the latest version unless a test names another registered one, and refuses any other", () => {
    const client = new PilotSwarmClient({ store: "postgres://unused.invalid/pilotswarm" });
    for (const version of ["1.0.85", "1.0.46", ""]) {
        assert.throws(() => client._startSessionsAt(version), /New sessions start at a registered version/, version);
    }
    client._startSessionsAt("1.0.82");
    client._startSessionsAt("1.0.83");
    client._startSessionsAt(DURABLE_SESSION_LATEST_VERSION);
});

test("a stored reasoning effort is used only when it names one", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(isReasoningEffort(effort), true, effort);
    for (const value of ["", "HIGH", "extreme", null, undefined, 3]) assert.equal(isReasoningEffort(value), false, String(value));
});
