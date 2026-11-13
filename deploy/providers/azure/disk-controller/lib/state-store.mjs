// The controller's state, kept as one JSON blob per record in the state
// container: `controller.json`, `disks/<name>.json` and `vms/<name>.json`.
//
// The controller is the only writer, one replica with `Recreate`, so the
// records are cached in memory and every write is a compare-and-swap on the
// blob's ETag: a new record is written only if the blob does not exist yet,
// a changed one only if nobody wrote it since it was read. A conflict, which
// means a second controller process overlapped this one, re-reads the blob
// and applies the change again. Writes to one record queue behind each other.
import { KeyedMutex } from "./mutex.mjs";

const KINDS = { controller: null, disk: "disks/", vm: "vms/" };
const ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

export class StateConflictError extends Error {
  constructor(name) {
    super(`State record ${name} changed while it was being written.`);
    this.name = "StateConflictError";
    this.record = name;
  }
}

export function recordName(kind, id) {
  if (!(kind in KINDS)) throw new TypeError(`Unknown state record kind ${kind}.`);
  if (kind === "controller") return "controller.json";
  if (!ID.test(String(id))) throw new TypeError(`State record ${kind} has an invalid ID.`);
  return `${KINDS[kind]}${id}.json`;
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The state backend over an @azure/storage-blob ContainerClient. */
export function createBlobStateBackend(container) {
  async function get(name) {
    let response;
    try {
      response = await container.getBlobClient(name).download();
    } catch (err) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
    return { etag: response.etag, value: JSON.parse(await streamText(response.readableStreamBody)) };
  }
  return {
    async list() {
      const records = [];
      for await (const item of container.listBlobsFlat()) {
        const record = await get(item.name);
        if (record) records.push({ name: item.name, ...record });
      }
      return records;
    },
    get,
    async put(name, value, etag) {
      const body = JSON.stringify(value);
      try {
        const response = await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
          conditions: etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
          blobHTTPHeaders: { blobContentType: "application/json" },
        });
        return response.etag;
      } catch (err) {
        if (err?.statusCode === 412 || err?.statusCode === 409) throw new StateConflictError(name);
        throw err;
      }
    },
    async remove(name, etag) {
      try {
        await container.getBlobClient(name).delete({ conditions: { ifMatch: etag } });
      } catch (err) {
        if (err?.statusCode === 404) return;
        if (err?.statusCode === 412) throw new StateConflictError(name);
        throw err;
      }
    },
  };
}

export function createStateStore({ backend, maxAttempts = 5 }) {
  const records = new Map();
  const writes = new KeyedMutex();

  const clone = (value) => (value === undefined || value === null ? null : structuredClone(value));

  async function refetch(name) {
    const fresh = await backend.get(name);
    if (fresh) records.set(name, fresh);
    else records.delete(name);
  }

  return {
    async load() {
      records.clear();
      for (const { name, etag, value } of await backend.list()) records.set(name, { etag, value });
    },

    get(kind, id) {
      return clone(records.get(recordName(kind, id))?.value);
    },

    all(kind) {
      const prefix = KINDS[kind];
      if (!prefix) throw new TypeError(`State record kind ${kind} has no list.`);
      const out = [];
      for (const [name, record] of records) if (name.startsWith(prefix)) out.push(clone(record.value));
      return out;
    },

    /**
     * Applies `mutate` to a copy of the record (null when it does not exist)
     * and writes what it returns: an object replaces the record, null removes
     * it, undefined changes nothing. On a conflict the record is read again
     * and `mutate` runs again, so it must depend only on its argument.
     */
    async update(kind, id, mutate) {
      const name = recordName(kind, id);
      return writes.run(name, async () => {
        for (let attempt = 1; ; attempt++) {
          const current = records.get(name);
          const next = mutate(clone(current?.value));
          if (next && typeof next.then === "function") throw new TypeError("A state change must be synchronous.");
          if (next === undefined) return clone(current?.value);
          try {
            if (next === null) {
              if (current) await backend.remove(name, current.etag);
              records.delete(name);
              return null;
            }
            const etag = await backend.put(name, next, current?.etag ?? null);
            records.set(name, { etag, value: clone(next) });
            return clone(next);
          } catch (err) {
            if (!(err instanceof StateConflictError) || attempt >= maxAttempts) throw err;
            await refetch(name);
          }
        }
      });
    },
  };
}
