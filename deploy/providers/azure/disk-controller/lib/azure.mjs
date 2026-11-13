// The controller's Azure calls, over the Azure SDK clients that server.mjs
// creates: @azure/arm-compute, @azure/arm-network and @azure/arm-monitor.
// Everything else in the controller reaches Azure only through this object,
// so the tests replace the SDK clients with in-memory fakes.
//
// Every write names only what it changes: the scale set's capacity is a PATCH
// of `sku.capacity` alone, a drive's growth a PATCH of `diskSizeGB` alone, and
// an attach or detach goes through `attachDetachDataDisks`, never a write of
// the VM's model.
export const DRIVE_TAG = "pilotswarm-disk-pool";
export const DCR_ASSOCIATION_NAME = "pilotswarm-win-worker";
export const PREMIUM_V2 = "PremiumV2_LRS";

export function isNotFound(err) {
  return err?.statusCode === 404 || err?.code === "ResourceNotFound" || err?.code === "NotFound";
}

function lastSegment(id) {
  const text = String(id ?? "");
  return text.slice(text.lastIndexOf("/") + 1) || null;
}

function sameId(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

function imageVersionOf(vm) {
  const reference = vm.storageProfile?.imageReference;
  if (reference?.exactVersion) return reference.exactVersion;
  const match = /\/versions\/([^/]+)$/i.exec(String(reference?.id ?? ""));
  return match ? match[1] : null;
}

function powerStateOf(instanceView) {
  const status = (instanceView?.statuses ?? []).find((entry) => String(entry.code ?? "").startsWith("PowerState/"));
  return status ? status.code.slice("PowerState/".length) : null;
}

function describeVm(vm) {
  return {
    name: vm.name,
    id: vm.id,
    scaleSetId: vm.virtualMachineScaleSet?.id ?? null,
    inStandbyPool: vm.instanceView?.isVMInStandbyPool === true,
    powerState: powerStateOf(vm.instanceView),
    provisioningState: vm.provisioningState ?? null,
    imageVersion: imageVersionOf(vm),
    dataDisks: (vm.storageProfile?.dataDisks ?? []).map((disk) => ({
      lun: disk.lun,
      diskName: lastSegment(disk.managedDisk?.id) ?? disk.name ?? null,
      toBeDetached: disk.toBeDetached === true,
    })),
    timeCreated: vm.timeCreated ? new Date(vm.timeCreated).getTime() : null,
  };
}

async function ignoreNotFound(promise) {
  try {
    return await promise;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function createAzure({ compute, network, monitor, scaleSet, dcrId = null }) {
  const { subscriptionId, resourceGroup, name: scaleSetName, id: scaleSetId } = scaleSet;
  const base = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute`;
  const ids = {
    vm: (name) => `${base}/virtualMachines/${name}`,
    disk: (name) => `${base}/disks/${name}`,
    snapshot: (name) => `${base}/snapshots/${name}`,
  };

  return {
    ids,
    resourceGroup,

    /** The scale set's capacity, region and zones, or null before it exists. */
    async scaleSet() {
      const found = await ignoreNotFound(compute.virtualMachineScaleSets.get(resourceGroup, scaleSetName));
      if (!found) return null;
      return { capacity: found.sku?.capacity ?? 0, location: found.location, zones: found.zones ?? [] };
    },

    async setCapacity(capacity) {
      await compute.virtualMachineScaleSets.update(resourceGroup, scaleSetName, { sku: { capacity } });
    },

    /** The scale set's VMs with their instance views, standby VMs included. */
    async listVms() {
      const vms = [];
      const filter = `'virtualMachineScaleSet/id' eq '${scaleSetId}'`;
      for await (const vm of compute.virtualMachines.list(resourceGroup, { filter, expand: "instanceView" })) {
        if (sameId(vm.virtualMachineScaleSet?.id, scaleSetId)) vms.push(describeVm(vm));
      }
      return vms;
    },

    async getVm(name) {
      const vm = await ignoreNotFound(compute.virtualMachines.get(resourceGroup, name, { expand: "instanceView" }));
      return vm && sameId(vm.virtualMachineScaleSet?.id, scaleSetId) ? describeVm(vm) : null;
    },

    /** Deletes a VM by name and waits until Azure reports it gone. Its data disks detach (deleteOption Detach). */
    async deleteVm(name) {
      await ignoreNotFound(compute.virtualMachines.delete(resourceGroup, name));
    },

    async protectVm(name) {
      await compute.virtualMachineScaleSetVMs.update(resourceGroup, scaleSetName, name, {
        protectionPolicy: { protectFromScaleSetActions: true },
      });
    },

    async attachDisk(vmName, diskName) {
      await compute.virtualMachines.attachDetachDataDisks(resourceGroup, vmName, {
        dataDisksToAttach: [{ diskId: ids.disk(diskName), lun: 0, caching: "None", deleteOption: "Detach" }],
      });
    },

    async detachDisk(vmName, diskName) {
      await compute.virtualMachines.attachDetachDataDisks(resourceGroup, vmName, {
        dataDisksToDetach: [{ diskId: ids.disk(diskName) }],
      });
    },

    /** Starts a Managed Run Command and returns once Azure accepted it; the script runs on. */
    async startRunCommand(vmName, commandName, script, { location, timeoutSeconds }) {
      await compute.virtualMachineRunCommands.createOrUpdate(resourceGroup, vmName, commandName, {
        location,
        source: { script },
        asyncExecution: true,
        timeoutInSeconds: timeoutSeconds,
        treatFailureAsDeploymentFailure: false,
      });
    },

    /** The run command's execution state, exit code and output, or null when it does not exist. */
    async runCommandResult(vmName, commandName) {
      const found = await ignoreNotFound(compute.virtualMachineRunCommands.getByVirtualMachine(resourceGroup, vmName, commandName, { expand: "instanceView" }));
      if (!found) return null;
      const view = found.instanceView ?? {};
      return { state: view.executionState ?? "Unknown", exitCode: view.exitCode ?? null, output: view.output ?? "", error: view.error ?? "" };
    },

    async deleteRunCommand(vmName, commandName) {
      await ignoreNotFound(compute.virtualMachineRunCommands.delete(resourceGroup, vmName, commandName));
    },

    /** Private IPv4 address -> the VM its NIC belongs to, for the resource group's NICs. */
    async nicAddresses() {
      const addresses = new Map();
      for await (const nic of network.networkInterfaces.list(resourceGroup)) {
        const vmName = nic.virtualMachine?.id ? lastSegment(nic.virtualMachine.id) : null;
        for (const configuration of nic.ipConfigurations ?? []) {
          if (configuration.privateIPAddress) {
            addresses.set(configuration.privateIPAddress, { vmName, ipForwarding: nic.enableIPForwarding === true });
          }
        }
      }
      return addresses;
    },

    async associateDcr(vmName) {
      if (!dcrId) return false;
      // The SDK puts `resourceUri` after the host's own slash.
      await monitor.dataCollectionRuleAssociations.create(ids.vm(vmName).slice(1), DCR_ASSOCIATION_NAME, { body: { dataCollectionRuleId: dcrId } });
      return true;
    },

    async dissociateDcr(vmName) {
      if (!dcrId) return;
      await ignoreNotFound(monitor.dataCollectionRuleAssociations.delete(ids.vm(vmName).slice(1), DCR_ASSOCIATION_NAME));
    },

    async createDisk(name, { snapshotId, sizeGb, iops, mbps, location, zones }) {
      await compute.disks.createOrUpdate(resourceGroup, name, {
        location,
        ...(zones?.length ? { zones: [...zones] } : {}),
        sku: { name: PREMIUM_V2 },
        creationData: { createOption: "Copy", sourceResourceId: snapshotId },
        diskSizeGB: sizeGb,
        diskIopsReadWrite: iops,
        diskMBpsReadWrite: mbps,
        tags: { [DRIVE_TAG]: "drive" },
      });
    },

    async getDisk(name) {
      const disk = await ignoreNotFound(compute.disks.get(resourceGroup, name));
      if (!disk) return null;
      return {
        name: disk.name,
        sizeGb: disk.diskSizeGB ?? null,
        completionPercent: disk.completionPercent ?? null,
        managedBy: disk.managedBy ? lastSegment(disk.managedBy) : null,
        provisioningState: disk.provisioningState ?? null,
      };
    },

    async growDisk(name, sizeGb) {
      await compute.disks.update(resourceGroup, name, { diskSizeGB: sizeGb });
    },

    async deleteDisk(name) {
      await ignoreNotFound(compute.disks.delete(resourceGroup, name));
    },

    async createSnapshot(name, { diskName, location }) {
      await compute.snapshots.createOrUpdate(resourceGroup, name, {
        location,
        incremental: true,
        creationData: { createOption: "Copy", sourceResourceId: ids.disk(diskName) },
        tags: { [DRIVE_TAG]: "golden-snapshot" },
      });
      return ids.snapshot(name);
    },

    /** A snapshot by its resource ID: completion and state, or null when it does not exist. */
    async getSnapshot(snapshotId) {
      const { group, name } = groupAndName(snapshotId, resourceGroup);
      const snapshot = await ignoreNotFound(compute.snapshots.get(group, name));
      if (!snapshot) return null;
      return { id: snapshot.id ?? snapshotId, completionPercent: snapshot.completionPercent ?? null, provisioningState: snapshot.provisioningState ?? null };
    },

    async deleteSnapshot(snapshotId) {
      const { group, name } = groupAndName(snapshotId, resourceGroup);
      await ignoreNotFound(compute.snapshots.delete(group, name));
    },
  };
}

function groupAndName(id, fallbackGroup) {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(String(id ?? ""));
  return { group: match ? match[1] : fallbackGroup, name: lastSegment(id) };
}
