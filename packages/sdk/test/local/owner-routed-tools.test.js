/**
 * The agent tools that owner routing refuses in an owner-routed tree, on
 * PostgreSQL with PilotSwarm workers, the real Copilot CLI and the scripted
 * model (docs/proposals/windows-worker-pool.md, "New roots" and "Workflows"):
 * a Workflow's start and test (workflow_definition), and a new root
 * (create_agent_session), with nothing started; a person's start through the
 * management client too. spawn_workflow is no longer declared to the model,
 * so only its handler's unit test reaches it (test/unit/owner-routed-workflows.test.mjs).
 *
 * Sessions are owner-routed by the tag stored with their creation config.
 *
 * Run: npx vitest run test/local/owner-routed-tools.test.js
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { waitForSessionState } from "../helpers/cms-helpers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { OWNER_TAG, ownerOf, turnWorkers, withOwnerCluster } from "../helpers/owner-routing-cluster.js";
import { NEW_ROOT_OWNER_ROUTED_TEXT, WORKFLOW_OWNER_ROUTED } from "../../src/owner-routing.ts";

const TIMEOUT = 300_000;
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: tidy, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
/** A manager agent's identity: its sessions get create_agent_session. */
const MANAGER = "generic-superagent";

function codeOf(result) {
    try {
        return JSON.parse(result)?.error?.code ?? null;
    } catch {
        return null;
    }
}

/**
 * A turn that makes each tool call in `calls`, in order, and records each
 * result; the conversation is the one whose first prompt names `prompt`.
 */
function scriptedCalls(scripts) {
    return (_body, position) => {
        const script = scripts.find((s) => position.firstUserText.includes(s.prompt));
        if (!script) return { content: "ok" };
        if (position.step > 0) script.results[position.step - 1] = position.toolResults[0];
        const call = script.calls[position.step];
        return call ? { tools: [call] } : { content: "done" };
    };
}

describe("agent tools in an owner-routed tree", () => {
    const getEnv = useSuiteEnv(import.meta.url);

    it("refuses a Workflow's start and test (WORKFLOW_OWNER_ROUTED) to the agent and a person's start (409) in a tagged session, and starts nothing; save and list go on", async () => {
        const env = getEnv();
        const agent = {
            prompt: "Run the tidy workflow.",
            results: [],
            calls: [
                { name: "workflow_definition", args: { operation: "save", name: "tidy", yaml: YAML } },
                { name: "workflow_definition", args: { operation: "start", name: "tidy" } },
                { name: "workflow_definition", args: { operation: "test", name: "tidy" } },
                { name: "workflow_definition", args: { operation: "list" } },
            ],
        };
        await withOwnerCluster(env, { respond: scriptedCalls([agent]) }, async ({ startWorker, startClients, client, mgmt, catalog, asked, qualifiedModel }) => {
            await startWorker("coordinator", { requester: true });
            await startWorker("owner-a", { ownerTag: OWNER_TAG.a });
            await startClients();
            const session = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), ownerTag: OWNER_TAG.a });
            await turnWorkflowsOn(catalog, session.sessionId);
            expect(await session.sendAndWait(agent.prompt, TIMEOUT)).toBe("done");
            expect(await turnWorkers(catalog, session.sessionId)).toEqual(["owner-a"]);
            expect(asked(session.sessionId)).toHaveLength(1);

            const [saved, started, tested, listed] = agent.results;
            expect(JSON.parse(saved), saved).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
            for (const refused of [started, tested]) {
                expect(JSON.parse(refused), refused).toMatchObject({ ok: false, error: { code: WORKFLOW_OWNER_ROUTED } });
                expect(JSON.parse(refused).error.message).toContain("owner's workers");
            }
            expect(codeOf(listed), listed).not.toBe(WORKFLOW_OWNER_ROUTED);
            expect(listed).toContain("tidy");

            // A person's start of the saved definition is refused too.
            const { definitionId } = JSON.parse(saved);
            const personStart = await mgmt.startSessionWorkflowDefinition(session.sessionId, { definitionId, operationId: randomUUID() },
                { principal: ownerOf("a") }).then(() => null, (error) => error);
            expect([personStart?.code, personStart?.status]).toEqual([WORKFLOW_OWNER_ROUTED, 409]);

            const workflows = (await catalog.listSessions()).filter((row) => row.sessionKind === "workflow");
            expect(workflows).toEqual([]);
        });
    }, TIMEOUT);

    it("refuses create_agent_session in a tagged manager session before it resolves the agent, and creates no root; an untagged manager session's call goes on", async () => {
        const env = getEnv();
        const call = { name: "create_agent_session", args: { agent_name: "missing-agent", prompt: "Check it." } };
        const tagged = { prompt: "Create a root, tagged.", results: [], calls: [call] };
        const untagged = { prompt: "Create a root, untagged.", results: [], calls: [call] };
        await withOwnerCluster(env, { respond: scriptedCalls([tagged, untagged]) }, async ({ startWorker, startClients, client, catalog, qualifiedModel }) => {
            await startWorker("coordinator", { requester: true });
            await startWorker("owner-a", { ownerTag: OWNER_TAG.a });
            await startClients();
            const routed = await client.createSession({
                sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), agentId: MANAGER, ownerTag: OWNER_TAG.a,
            });
            const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: ownerOf("a"), agentId: MANAGER });
            const before = new Set((await catalog.listSessions()).map((row) => row.sessionId));
            expect(await routed.sendAndWait(tagged.prompt, TIMEOUT)).toBe("done");
            expect(await plain.sendAndWait(untagged.prompt, TIMEOUT)).toBe("done");
            await waitForSessionState(catalog, routed.sessionId, ["idle"], 60_000);

            expect(tagged.results).toEqual([NEW_ROOT_OWNER_ROUTED_TEXT]);
            expect(untagged.results[0]).toContain('agent "missing-agent" not found');
            expect(untagged.results[0]).not.toContain("owner routing");
            expect(await turnWorkers(catalog, routed.sessionId)).toEqual(["owner-a"]);
            expect(new Set((await catalog.listSessions()).map((row) => row.sessionId))).toEqual(before);
        });
    }, TIMEOUT);
});
