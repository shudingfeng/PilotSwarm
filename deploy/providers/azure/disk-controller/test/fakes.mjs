// In-memory stand-ins for everything the controller reaches outside its
// process, so the tests run from the repository root without Azure and
// without this package's dependencies:
//
// - FakeCloud: a Flexible scale set with a standby pool, its VMs and NICs,
//   managed disks, snapshots, Managed Run Commands and data collection rule
//   associations, behind objects shaped like the @azure/arm-compute,
//   @azure/arm-network and @azure/arm-monitor clients. Every call is logged
//   with its arguments, so tests can check exactly what was sent.
// - MemoryBackend and FakeContainerClient: the state store's backend with
//   ETag compare-and-swap, and an @azure/storage-blob ContainerClient.
// - FakeSecretClient: the parts of @azure/keyvault-secrets the broker uses.
// - FakeClock, a memory logger and unsigned test tokens.
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { createLogger } from "../lib/log.mjs";
import { callerFromClaims } from "../lib/auth.mjs";

export const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
export const TENANT = "99999999-9999-9999-9999-999999999999";
export const APP = "11111111-1111-1111-1111-111111111111";
export const WORKER_OID = "22222222-2222-2222-2222-222222222222";
export const DISPATCHER_OID = "33333333-3333-3333-3333-333333333333";
export const COORDINATOR_OID = "44444444-4444-4444-4444-444444444444";
export const DEPLOYER_OID = "55555555-5555-5555-5555-555555555555";
export const OWNER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const DEVELOPER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
export const GROUP = "stamp-rg";
export const COMPUTE = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/Microsoft.Compute`;
export const SCALE_SET_ID = `${COMPUTE}/virtualMachineScaleSets/win-workers`;
export const GOLDEN_ID = `${COMPUTE}/snapshots/golden-0`;
export const DCR_ID = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/Microsoft.Insights/dataCollectionRules/win-workers`;

export function restError(statusCode, code, message = code) {
  return Object.assign(new Error(message), { name: "RestError", statusCode, code });
}

const notFound = (what) => restError(404, "ResourceNotFound", `${what} was not found.`);

export class FakeClock {
  constructor(start = Date.parse("2026-11-02T16:00:00.000Z")) {
    this.time = start;
  }

  now() {
    return this.time;
  }

  advance(ms) {
    this.time += ms;
    return this.time;
  }
}

export function createMemoryLogger() {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line));
  return {
    ...logger,
    lines,
    records,
    events: (event) => records().filter((record) => record.event === event),
    text: () => lines.join("\n"),
  };
}

// ── tokens ───────────────────────────────────────────────────────────

/** An unsigned test token carrying `claims`; only fakeVerifier reads it. */
export function token(claims) {
  const body = Buffer.from(JSON.stringify({ ver: "2.0", tid: TENANT, aud: APP, ...claims })).toString("base64url");
  return `test.${body}.unsigned`;
}

export const TOKENS = {
  worker: token({ oid: WORKER_OID, roles: ["worker"] }),
  workerWrongOid: token({ oid: DEVELOPER, roles: ["worker"] }),
  workerNoRole: token({ oid: WORKER_OID, roles: [] }),
  dispatcher: token({ oid: DISPATCHER_OID, roles: ["user"] }),
  dispatcherNoRole: token({ oid: DISPATCHER_OID, roles: [] }),
  developer: token({ oid: DEVELOPER, roles: ["user"], scp: "user_impersonation" }),
  admin: token({ oid: DEVELOPER, roles: ["admin"], scp: "user_impersonation" }),
  deployer: token({ oid: DEPLOYER_OID, roles: ["deployer"] }),
  coordinator: token({ oid: COORDINATOR_OID, roles: ["coordinator"] }),
  v1: token({ oid: WORKER_OID, roles: ["worker"], ver: "1.0" }),
  otherTenant: token({ oid: WORKER_OID, roles: ["worker"], tid: "88888888-8888-8888-8888-888888888888" }),
  invalid: "test.e30.bad",
};

/** Stands in for the jose-backed verifier: decodes a test token, then applies the real claim checks. */
export async function fakeVerifier(text) {
  const [, body, signature] = text.split(".");
  if (signature !== "unsigned") throw new Error("signature verification failed");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (claims.aud !== APP) throw new Error("unexpected audience");
  return callerFromClaims(claims, { tenantId: TENANT });
}

// ── state backends ───────────────────────────────────────────────────

/** The state backend's contract in memory, with a way to write behind the store's back. */
export class MemoryBackend {
  constructor() {
    this.blobs = new Map();
    this.writes = [];
    this.counter = 0;
  }

  #etag() {
    this.counter += 1;
    return `"0x${this.counter.toString(16)}"`;
  }

  async list() {
    return [...this.blobs].map(([name, blob]) => ({ name, etag: blob.etag, value: structuredClone(blob.value) }));
  }

  async get(name) {
    const blob = this.blobs.get(name);
    return blob ? { etag: blob.etag, value: structuredClone(blob.value) } : null;
  }

  async put(name, value, etag) {
    const { StateConflictError } = await import("../lib/state-store.mjs");
    const blob = this.blobs.get(name);
    if (etag ? blob?.etag !== etag : blob) throw new StateConflictError(name);
    const next = this.#etag();
    this.blobs.set(name, { etag: next, value: structuredClone(value) });
    this.writes.push(name);
    return next;
  }

  async remove(name, etag) {
    const { StateConflictError } = await import("../lib/state-store.mjs");
    const blob = this.blobs.get(name);
    if (!blob) return;
    if (blob.etag !== etag) throw new StateConflictError(name);
    this.blobs.delete(name);
  }

  /** Another writer changes the blob. */
  externalWrite(name, value) {
    this.blobs.set(name, { etag: this.#etag(), value: structuredClone(value) });
  }

  value(name) {
    return structuredClone(this.blobs.get(name)?.value ?? null);
  }
}

/** The parts of @azure/storage-blob's ContainerClient the blob backend uses, with Azure's conditional-write answers. */
export class FakeContainerClient {
  constructor() {
    this.blobs = new Map();
    this.calls = [];
    this.counter = 0;
  }

  #blob(name) {
    const container = this;
    return {
      async download() {
        container.calls.push(["download", name]);
        const blob = container.blobs.get(name);
        if (!blob) throw restError(404, "BlobNotFound");
        return { etag: blob.etag, readableStreamBody: Readable.from([Buffer.from(blob.body, "utf8")]) };
      },
      async delete(options = {}) {
        container.calls.push(["delete", name, options]);
        const blob = container.blobs.get(name);
        if (!blob) throw restError(404, "BlobNotFound");
        if (options.conditions?.ifMatch && options.conditions.ifMatch !== blob.etag) throw restError(412, "ConditionNotMet");
        container.blobs.delete(name);
      },
      async upload(body, length, options = {}) {
        container.calls.push(["upload", name, options]);
        const blob = container.blobs.get(name);
        const { ifMatch, ifNoneMatch } = options.conditions ?? {};
        if (ifNoneMatch === "*" && blob) throw restError(409, "BlobAlreadyExists");
        if (ifMatch && ifMatch !== blob?.etag) throw restError(412, "ConditionNotMet");
        if (Buffer.byteLength(body) !== length) throw new Error("length mismatch");
        container.counter += 1;
        const etag = `"0x${container.counter}"`;
        container.blobs.set(name, { etag, body: String(body), contentType: options.blobHTTPHeaders?.blobContentType });
        return { etag };
      },
    };
  }

  getBlobClient(name) {
    return this.#blob(name);
  }

  getBlockBlobClient(name) {
    return this.#blob(name);
  }

  listBlobsFlat() {
    const names = [...this.blobs.keys()];
    return (async function* list() {
      for (const name of names) yield { name };
    })();
  }
}

// ── Key Vault ────────────────────────────────────────────────────────

/** getSecret by name and version, and listPropertiesOfSecrets without values; every read is logged. */
export class FakeSecretClient {
  constructor() {
    this.secrets = new Map();
    this.reads = [];
    this.failure = null;
  }

  set(name, value, { ownerOid, enabled = true, expiresOn, updatedOn = new Date("2026-11-01T00:00:00Z") } = {}) {
    const version = randomBytes(16).toString("hex");
    const versions = this.secrets.get(name.toLowerCase())?.versions ?? [];
    versions.push({ version, value, tags: ownerOid ? { ownerOid } : {}, enabled, expiresOn, updatedOn, createdOn: updatedOn });
    this.secrets.set(name.toLowerCase(), { name, versions });
    return version;
  }

  async getSecret(name, { version } = {}) {
    this.reads.push([name, version]);
    if (this.failure) throw this.failure;
    const secret = this.secrets.get(name.toLowerCase());
    const found = secret?.versions.find((v) => v.version === version);
    if (!found) throw restError(404, "SecretNotFound");
    return {
      name: secret.name,
      value: found.value,
      properties: { name: secret.name, version: found.version, enabled: found.enabled, expiresOn: found.expiresOn, tags: { ...found.tags } },
    };
  }

  listPropertiesOfSecrets() {
    const failure = this.failure;
    const items = [...this.secrets.values()].map((secret) => {
      const latest = secret.versions.at(-1);
      return { name: secret.name, version: latest.version, enabled: latest.enabled, expiresOn: latest.expiresOn, tags: { ...latest.tags }, updatedOn: latest.updatedOn, createdOn: latest.createdOn };
    });
    return (async function* list() {
      if (failure) throw failure;
      yield* items;
    })();
  }
}

// ── Azure ────────────────────────────────────────────────────────────

/**
 * A Flexible scale set and its resource group. Raising the capacity starts a
 * standby VM when one is there and creates a VM otherwise; deleting a VM
 * lowers the capacity and detaches its data disks.
 */
export class FakeCloud {
  constructor({ capacity = 0, standby = 0, imageVersion = "1.0.1", location = "westus3", zones = ["1"], scaleSetExists = true } = {}) {
    this.scaleSet = scaleSetExists ? { name: "win-workers", capacity: 0, location, zones } : null;
    this.vms = new Map();
    this.disks = new Map();
    this.snapshots = new Map([["golden-0", { name: "golden-0", id: GOLDEN_ID, completionPercent: 100, provisioningState: "Succeeded", tags: {} }]]);
    this.runCommands = new Map();
    this.dcr = new Map();
    this.calls = [];
    this.counter = 0;
    this.imageVersion = imageVersion;
    this.copyPercent = 100;
    this.failDeletes = new Set();
    this.failAttach = null;
    this.autoRunCommands = null;
    for (let i = 0; i < standby; i++) this.#newVm({ standby: true });
    if (capacity) this.#setCapacity(capacity);
    this.compute = this.#compute();
    this.network = this.#network();
    this.monitor = this.#monitor();
  }

  #log(...call) {
    this.calls.push(call);
  }

  callsOf(op) {
    return this.calls.filter((call) => call[0] === op);
  }

  #newVm({ standby = false } = {}) {
    this.counter += 1;
    const name = `vm-${this.counter}`;
    this.vms.set(name, {
      name,
      id: `${COMPUTE}/virtualMachines/${name}`,
      scaleSetId: SCALE_SET_ID,
      standby,
      powerState: standby ? "deallocated" : "running",
      provisioningState: "Succeeded",
      imageVersion: this.imageVersion,
      dataDisks: [],
      ip: `10.20.32.${this.counter + 3}`,
      ipForwarding: false,
      protection: null,
      timeCreated: new Date("2026-11-01T00:00:00Z"),
    });
    return name;
  }

  #activeCount() {
    return [...this.vms.values()].filter((vm) => !vm.standby && vm.scaleSetId).length;
  }

  #setCapacity(capacity) {
    while (this.#activeCount() < capacity) {
      const standby = [...this.vms.values()].find((vm) => vm.standby);
      if (standby) {
        standby.standby = false;
        standby.powerState = "running";
      } else this.#newVm();
    }
    this.scaleSet.capacity = capacity;
  }

  /** A VM that is not a member of the scale set, with an address in the worker subnet. */
  addStrangerVm(ip) {
    this.counter += 1;
    const name = `stranger-${this.counter}`;
    this.vms.set(name, { name, id: `${COMPUTE}/virtualMachines/${name}`, scaleSetId: null, standby: false, powerState: "running", provisioningState: "Succeeded", dataDisks: [], ip, ipForwarding: false });
    return name;
  }

  vm(name) {
    return this.vms.get(name);
  }

  activeVmNames() {
    return [...this.vms.values()].filter((vm) => !vm.standby && vm.scaleSetId).map((vm) => vm.name);
  }

  #deleteVm(name) {
    const vm = this.vms.get(name);
    if (!vm) return;
    for (const disk of vm.dataDisks) {
      const record = this.disks.get(disk.diskName);
      if (record) record.managedBy = null;
    }
    this.vms.delete(name);
    // Azure documents no removal of a VM's data collection rule association
    // with the VM, so it stays here until the controller removes it.
    if (!vm.standby && vm.scaleSetId) this.scaleSet.capacity = Math.max(0, this.scaleSet.capacity - 1);
  }

  completeRunCommand(vmName, commandName, { state = "Succeeded", exitCode = 0, output = "" } = {}) {
    const command = this.runCommands.get(`${vmName}/${commandName}`);
    if (!command) throw new Error(`no run command ${commandName} on ${vmName}`);
    Object.assign(command, { state, exitCode, output });
  }

  runCommandsOn(vmName) {
    return [...this.runCommands.entries()].filter(([key]) => key.startsWith(`${vmName}/`)).map(([, command]) => command);
  }

  #vmModel(vm) {
    return {
      name: vm.name,
      id: vm.id,
      virtualMachineScaleSet: vm.scaleSetId ? { id: vm.scaleSetId } : undefined,
      provisioningState: vm.provisioningState,
      timeCreated: vm.timeCreated,
      storageProfile: {
        imageReference: { id: `${COMPUTE}/galleries/g/images/pilotswarm-win-worker/versions/${vm.imageVersion}`, exactVersion: vm.imageVersion },
        dataDisks: vm.dataDisks.map((disk) => ({ lun: disk.lun, name: disk.diskName, managedDisk: { id: `${COMPUTE}/disks/${disk.diskName}` }, createOption: "Attach" })),
      },
      instanceView: {
        isVMInStandbyPool: vm.standby,
        statuses: [{ code: "ProvisioningState/succeeded" }, { code: `PowerState/${vm.powerState}` }],
      },
    };
  }

  #compute() {
    const cloud = this;
    const scaleSetOf = (group, name) => {
      if (group !== GROUP || !cloud.scaleSet || name !== cloud.scaleSet.name) throw notFound("The scale set");
      return cloud.scaleSet;
    };
    const vmOf = (group, name) => {
      const vm = group === GROUP ? cloud.vms.get(name) : null;
      if (!vm) throw notFound(`VM ${name}`);
      return vm;
    };
    return {
      virtualMachineScaleSets: {
        async get(group, name) {
          cloud.#log("vmss.get", group, name);
          const scaleSet = scaleSetOf(group, name);
          return { name, id: SCALE_SET_ID, location: scaleSet.location, zones: [...scaleSet.zones], sku: { name: "Standard_D16ds_v5", capacity: scaleSet.capacity } };
        },
        async update(group, name, parameters) {
          cloud.#log("vmss.update", group, name, structuredClone(parameters));
          scaleSetOf(group, name);
          if (parameters.sku?.capacity !== undefined) cloud.#setCapacity(parameters.sku.capacity);
          return {};
        },
      },
      virtualMachineScaleSetVMs: {
        async update(group, scaleSetName, instanceId, parameters) {
          cloud.#log("vmssvm.update", group, scaleSetName, instanceId, structuredClone(parameters));
          vmOf(group, instanceId).protection = parameters.protectionPolicy ?? null;
          return {};
        },
      },
      virtualMachines: {
        list(group, options) {
          cloud.#log("vm.list", group, options);
          const models = [...cloud.vms.values()].map((vm) => cloud.#vmModel(vm));
          return (async function* list() {
            yield* models;
          })();
        },
        async get(group, name, options) {
          cloud.#log("vm.get", group, name, options);
          return cloud.#vmModel(vmOf(group, name));
        },
        delete(group, name) {
          cloud.#log("vm.delete", group, name);
          if (!cloud.vms.has(name)) return Promise.reject(notFound(`VM ${name}`));
          if (cloud.failDeletes.has(name)) return Promise.reject(restError(500, "InternalServerError", "delete failed"));
          cloud.#deleteVm(name);
          return Promise.resolve();
        },
        async attachDetachDataDisks(group, name, parameters) {
          cloud.#log("vm.attachDetach", group, name, structuredClone(parameters));
          const vm = vmOf(group, name);
          if (cloud.failAttach) {
            const failure = cloud.failAttach;
            cloud.failAttach = null;
            throw failure;
          }
          for (const disk of parameters.dataDisksToDetach ?? []) {
            const diskName = disk.diskId.slice(disk.diskId.lastIndexOf("/") + 1);
            vm.dataDisks = vm.dataDisks.filter((d) => d.diskName !== diskName);
            const record = cloud.disks.get(diskName);
            if (record) record.managedBy = null;
          }
          for (const disk of parameters.dataDisksToAttach ?? []) {
            const diskName = disk.diskId.slice(disk.diskId.lastIndexOf("/") + 1);
            const record = cloud.disks.get(diskName);
            if (!record) throw notFound(`Disk ${diskName}`);
            if (record.managedBy) throw restError(409, "Conflict", `Disk ${diskName} is attached to another VM.`);
            if (vm.dataDisks.some((d) => d.lun === disk.lun)) throw restError(409, "Conflict", "The LUN is in use.");
            vm.dataDisks.push({ lun: disk.lun, diskName, deleteOption: disk.deleteOption, caching: disk.caching });
            record.managedBy = vm.id;
          }
          return {};
        },
      },
      virtualMachineRunCommands: {
        async createOrUpdate(group, vmName, name, parameters) {
          cloud.#log("runCommand.create", group, vmName, name, structuredClone(parameters));
          vmOf(group, vmName);
          const command = { name, vmName, script: parameters.source?.script, state: "Running", exitCode: null, output: "", parameters: structuredClone(parameters) };
          cloud.runCommands.set(`${vmName}/${name}`, command);
          if (cloud.autoRunCommands) Object.assign(command, cloud.autoRunCommands(command));
          return {};
        },
        async getByVirtualMachine(group, vmName, name, options) {
          cloud.#log("runCommand.get", group, vmName, name, options);
          const command = cloud.runCommands.get(`${vmName}/${name}`);
          if (!command || !cloud.vms.has(vmName)) throw notFound(`Run command ${name}`);
          return { name, instanceView: { executionState: command.state, exitCode: command.exitCode, output: command.output } };
        },
        delete(group, vmName, name) {
          cloud.#log("runCommand.delete", group, vmName, name);
          cloud.runCommands.delete(`${vmName}/${name}`);
          return Promise.resolve();
        },
      },
      disks: {
        async createOrUpdate(group, name, parameters) {
          cloud.#log("disk.create", group, name, structuredClone(parameters));
          cloud.disks.set(name, {
            name,
            diskSizeGB: parameters.diskSizeGB,
            completionPercent: cloud.copyPercent,
            provisioningState: "Succeeded",
            managedBy: null,
            parameters: structuredClone(parameters),
          });
          return {};
        },
        async get(group, name) {
          cloud.#log("disk.get", group, name);
          const disk = cloud.disks.get(name);
          if (!disk) throw notFound(`Disk ${name}`);
          return { name, diskSizeGB: disk.diskSizeGB, completionPercent: disk.completionPercent, managedBy: disk.managedBy, provisioningState: disk.provisioningState };
        },
        async update(group, name, parameters) {
          cloud.#log("disk.update", group, name, structuredClone(parameters));
          const disk = cloud.disks.get(name);
          if (!disk) throw notFound(`Disk ${name}`);
          if (parameters.diskSizeGB !== undefined) disk.diskSizeGB = parameters.diskSizeGB;
          return {};
        },
        delete(group, name) {
          cloud.#log("disk.delete", group, name);
          const disk = cloud.disks.get(name);
          if (!disk) return Promise.reject(notFound(`Disk ${name}`));
          if (disk.managedBy) return Promise.reject(restError(409, "OperationNotAllowed", "The disk is attached."));
          cloud.disks.delete(name);
          return Promise.resolve();
        },
      },
      snapshots: {
        async createOrUpdate(group, name, parameters) {
          cloud.#log("snapshot.create", group, name, structuredClone(parameters));
          cloud.snapshots.set(name, { name, id: `${COMPUTE}/snapshots/${name}`, completionPercent: cloud.copyPercent, provisioningState: "Succeeded", parameters: structuredClone(parameters) });
          return {};
        },
        async get(group, name) {
          cloud.#log("snapshot.get", group, name);
          const snapshot = cloud.snapshots.get(name);
          if (!snapshot) throw notFound(`Snapshot ${name}`);
          return { name, id: snapshot.id, completionPercent: snapshot.completionPercent, provisioningState: snapshot.provisioningState };
        },
        delete(group, name) {
          cloud.#log("snapshot.delete", group, name);
          cloud.snapshots.delete(name);
          return Promise.resolve();
        },
      },
    };
  }

  #network() {
    const cloud = this;
    return {
      networkInterfaces: {
        list(group) {
          cloud.#log("nic.list", group);
          const nics = [...cloud.vms.values()].map((vm) => ({
            name: `${vm.name}-nic`,
            virtualMachine: { id: vm.id },
            enableIPForwarding: vm.ipForwarding,
            ipConfigurations: [{ name: "ipconfig1", privateIPAddress: vm.ip }],
          }));
          nics.push({ name: "pe-blob-nic", ipConfigurations: [{ privateIPAddress: "10.20.33.4" }] });
          return (async function* list() {
            yield* nics;
          })();
        },
      },
    };
  }

  #monitor() {
    const cloud = this;
    return {
      dataCollectionRuleAssociations: {
        async create(resourceUri, name, options) {
          cloud.#log("dcr.create", resourceUri, name, structuredClone(options));
          cloud.dcr.set(resourceUri.toLowerCase(), { name, ruleId: options?.body?.dataCollectionRuleId });
          return {};
        },
        async delete(resourceUri, name) {
          cloud.#log("dcr.delete", resourceUri, name);
          cloud.dcr.delete(resourceUri.toLowerCase());
        },
      },
    };
  }
}
