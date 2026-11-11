// The Azure adapter: what each call sends to the Azure SDK clients, and how
// it reads their answers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAzure, isNotFound } from "../lib/azure.mjs";
import { parseScaleSetId } from "../lib/config.mjs";
import { COMPUTE, DCR_ID, FakeCloud, GOLDEN_ID, SCALE_SET_ID } from "./fakes.mjs";

function setup(options) {
  const cloud = new FakeCloud(options);
  const azure = createAzure({ compute: cloud.compute, network: cloud.network, monitor: cloud.monitor, scaleSet: parseScaleSetId(SCALE_SET_ID), dcrId: DCR_ID });
  return { cloud, azure };
}

test("the scale set: capacity, region and zones; the capacity changes with a PATCH of sku.capacity alone", async () => {
  const { cloud, azure } = setup({ capacity: 1 });
  assert.deepEqual(await azure.scaleSet(), { capacity: 1, location: "westus3", zones: ["1"] });
  await azure.setCapacity(2);
  assert.deepEqual(cloud.callsOf("vmss.update")[0].slice(1), ["stamp-rg", "win-workers", { sku: { capacity: 2 } }]);
  const missing = setup({ scaleSetExists: false });
  assert.equal(await missing.azure.scaleSet(), null, "before the scale set exists");
});

test("VMs: listed with the scale set filter and instance views, members only, standby and image version read", async () => {
  const { cloud, azure } = setup({ capacity: 1, standby: 2 });
  cloud.addStrangerVm("10.20.32.99");
  const vms = await azure.listVms();
  const [, group, options] = cloud.callsOf("vm.list")[0];
  assert.equal(group, "stamp-rg");
  assert.deepEqual(options, { filter: `'virtualMachineScaleSet/id' eq '${SCALE_SET_ID}'`, expand: "instanceView" });
  assert.deepEqual(vms.map((vm) => [vm.name, vm.inStandbyPool, vm.powerState, vm.imageVersion]).sort(), [["vm-1", false, "running", "1.0.1"], ["vm-2", true, "deallocated", "1.0.1"]]);
  assert.equal(await azure.getVm("stranger-3"), null, "a VM outside the scale set is not ours");
  assert.equal(await azure.getVm("vm-404"), null);
});

test("attach and detach go through attachDetachDataDisks: LUN 0, no caching, and a VM deletion only detaches the drive", async () => {
  const { cloud, azure } = setup({ capacity: 1 });
  await cloud.compute.disks.createOrUpdate("stamp-rg", "psdrive-0123456789ab", { diskSizeGB: 1024 });
  await azure.attachDisk("vm-1", "psdrive-0123456789ab");
  assert.deepEqual(cloud.callsOf("vm.attachDetach")[0][3], {
    dataDisksToAttach: [{ diskId: `${COMPUTE}/disks/psdrive-0123456789ab`, lun: 0, caching: "None", deleteOption: "Detach" }],
  });
  assert.deepEqual((await azure.getVm("vm-1")).dataDisks, [{ lun: 0, diskName: "psdrive-0123456789ab", toBeDetached: false }]);
  assert.equal((await azure.getDisk("psdrive-0123456789ab")).managedBy, "vm-1");
  await azure.detachDisk("vm-1", "psdrive-0123456789ab");
  assert.deepEqual(cloud.callsOf("vm.attachDetach")[1][3], { dataDisksToDetach: [{ diskId: `${COMPUTE}/disks/psdrive-0123456789ab` }] });
});

test("drives: Premium SSD v2 copies of a snapshot in the scale set's zone; growth patches diskSizeGB alone", async () => {
  const { cloud, azure } = setup();
  await azure.createDisk("psdrive-0123456789ab", { snapshotId: GOLDEN_ID, sizeGb: 1024, iops: 6000, mbps: 250, location: "westus3", zones: ["1"] });
  assert.deepEqual(cloud.callsOf("disk.create")[0][3], {
    location: "westus3",
    zones: ["1"],
    sku: { name: "PremiumV2_LRS" },
    creationData: { createOption: "Copy", sourceResourceId: GOLDEN_ID },
    diskSizeGB: 1024,
    diskIopsReadWrite: 6000,
    diskMBpsReadWrite: 250,
    tags: { "pilotswarm-disk-pool": "drive" },
  });
  await azure.growDisk("psdrive-0123456789ab", 1280);
  assert.deepEqual(cloud.callsOf("disk.update")[0][3], { diskSizeGB: 1280 });
  assert.deepEqual(await azure.getDisk("psdrive-0123456789ab"), { name: "psdrive-0123456789ab", sizeGb: 1280, completionPercent: 100, managedBy: null, provisioningState: "Succeeded" });
  await azure.deleteDisk("psdrive-0123456789ab");
  await azure.deleteDisk("psdrive-0123456789ab");
  assert.equal(await azure.getDisk("psdrive-0123456789ab"), null, "deleting a missing drive is fine");
});

test("snapshots are incremental copies of a drive", async () => {
  const { cloud, azure } = setup();
  const id = await azure.createSnapshot("pilotswarm-golden-1", { diskName: "psrefresh-0123456789ab", location: "westus3" });
  assert.equal(id, `${COMPUTE}/snapshots/pilotswarm-golden-1`);
  assert.deepEqual(cloud.callsOf("snapshot.create")[0][3], {
    location: "westus3",
    incremental: true,
    creationData: { createOption: "Copy", sourceResourceId: `${COMPUTE}/disks/psrefresh-0123456789ab` },
    tags: { "pilotswarm-disk-pool": "golden-snapshot" },
  });
  assert.equal((await azure.getSnapshot(GOLDEN_ID)).completionPercent, 100);
  await azure.deleteSnapshot(id);
  assert.equal(await azure.getSnapshot(id), null);
});

test("Managed Run Commands run asynchronously for up to 2 hours and report their state", async () => {
  const { cloud, azure } = setup({ capacity: 1 });
  await azure.startRunCommand("vm-1", "pilotswarm-drain-1", "& 'C:\\x.ps1'", { location: "westus3", timeoutSeconds: 7200 });
  assert.deepEqual(cloud.callsOf("runCommand.create")[0].slice(2), ["vm-1", "pilotswarm-drain-1", {
    location: "westus3",
    source: { script: "& 'C:\\x.ps1'" },
    asyncExecution: true,
    timeoutInSeconds: 7200,
    treatFailureAsDeploymentFailure: false,
  }]);
  assert.deepEqual(await azure.runCommandResult("vm-1", "pilotswarm-drain-1"), { state: "Running", exitCode: null, output: "", error: "" });
  cloud.completeRunCommand("vm-1", "pilotswarm-drain-1", { output: "done" });
  assert.equal((await azure.runCommandResult("vm-1", "pilotswarm-drain-1")).state, "Succeeded");
  assert.deepEqual(cloud.callsOf("runCommand.get")[0][4], { expand: "instanceView" });
  assert.equal(await azure.runCommandResult("vm-1", "missing"), null);
});

test("NIC addresses map to their VMs, with IP forwarding; the instance protection and association bodies", async () => {
  const { cloud, azure } = setup({ capacity: 1 });
  cloud.vm("vm-1").ipForwarding = true;
  const addresses = await azure.nicAddresses();
  assert.deepEqual(addresses.get("10.20.32.4"), { vmName: "vm-1", ipForwarding: true });
  assert.deepEqual(addresses.get("10.20.33.4"), { vmName: null, ipForwarding: false }, "a private endpoint's NIC has no VM");
  await azure.protectVm("vm-1");
  assert.deepEqual(cloud.callsOf("vmssvm.update")[0].slice(1), ["stamp-rg", "win-workers", "vm-1", { protectionPolicy: { protectFromScaleSetActions: true } }]);
  await azure.associateDcr("vm-1");
  assert.deepEqual(cloud.callsOf("dcr.create")[0].slice(1), [`${COMPUTE.slice(1)}/virtualMachines/vm-1`, "pilotswarm-win-worker", { body: { dataCollectionRuleId: DCR_ID } }], "the resource URI without its leading slash, which the SDK adds");
  await azure.dissociateDcr("vm-1");
  assert.equal(cloud.callsOf("dcr.delete").length, 1);
  assert.equal(isNotFound({ statusCode: 404 }), true);
  assert.equal(isNotFound({ code: "ResourceNotFound" }), true);
  assert.equal(isNotFound({ statusCode: 409 }), false);
});
