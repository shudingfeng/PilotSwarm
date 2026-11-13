/**
 * The Resource Manager's scale_workers refuses on a deployment that turns
 * Kubernetes scaling off (PILOTSWARM_DISABLE_K8S_SCALING=1): its workers are
 * not a deployment the tool may scale. Unset, the tool works as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createResourceManagerTools } from "../../dist/resourcemgr-tools.js";

const scaleTool = (options = {}) => createResourceManagerTools({ catalog: {}, duroxideClient: null, blobStore: null, ...options })
    .find((candidate) => candidate.name === "scale_workers");

test("with scaling turned off, scale_workers refuses before it runs kubectl, and says so in its description", async () => {
    const tool = scaleTool({ k8sScalingDisabled: true });
    assert.deepEqual(await tool.handler({ replicas: 3 }), {
        error: "Scaling workers is disabled on this deployment (PILOTSWARM_DISABLE_K8S_SCALING=1).",
    });
    assert.match(tool.description, /Disabled on this deployment\.$/);
});

test("unset, scale_workers keeps today's description and checks", async () => {
    const tool = scaleTool();
    assert.equal(tool.description,
        "Scale the AKS worker deployment to a specified number of replicas. Min: 1, Max: 12. Requires kubectl access.");
    assert.deepEqual(await tool.handler({ replicas: 13 }), { error: "Replica count must be 1-12 (got 13)." });
});
