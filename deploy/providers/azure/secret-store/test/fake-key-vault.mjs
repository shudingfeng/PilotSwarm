// An in-memory stand-in for @azure/keyvault-secrets' SecretClient that keeps
// the Key Vault rules the personal secret store relies on:
// - setSecret adds a version (a new 32-hex-digit ID) to a name, with its tags
//   and an expiry stored in whole seconds; names compare without case;
// - beginDeleteSecret soft-deletes the whole secret, and a missing name
//   answers 404 SecretNotFound. A soft-deleted name stays reserved: setSecret
//   answers 409 ObjectIsDeletedButRecoverable, and nothing ever purges it;
// - listPropertiesOfSecretVersions returns properties without values, and
//   nothing for a missing or deleted name.
// The methods outside the store's role (reading a value, recovering, purging,
// updating, backup and restore) throw.
import { randomBytes } from "node:crypto";

const OUTSIDE_THE_ROLE = [
  "getSecret",
  "purgeDeletedSecret",
  "beginRecoverDeletedSecret",
  "updateSecretProperties",
  "backupSecret",
  "restoreSecretBackup",
];

export function restError(statusCode, code, message, innerCode) {
  return Object.assign(new Error(message), {
    name: "RestError",
    statusCode,
    code,
    details: { error: { code, message, ...(innerCode ? { innerError: { code: innerCode } } : {}) } },
  });
}

export class FakeKeyVault {
  constructor({ vaultUrl = "https://myvault.vault.azure.net" } = {}) {
    this.vaultUrl = vaultUrl;
    this.secrets = new Map();
    this.deleted = new Map();
    this.deleting = new Map();
    this.calls = [];
    this.forbiddenCalls = [];
    this.failures = new Map();
    for (const method of OUTSIDE_THE_ROLE) {
      this[method] = () => {
        this.forbiddenCalls.push(method);
        throw new Error(`${method} is outside the personal secret store's role.`);
      };
    }
  }

  // The next call of `method` throws makeError(...its arguments).
  failNext(method, makeError) {
    this.failures.set(method, makeError);
  }

  #failure(method, ...args) {
    const makeError = this.failures.get(method);
    if (!makeError) return null;
    this.failures.delete(method);
    return makeError(...args);
  }

  #properties(secret, version) {
    return {
      name: secret.name,
      version: version.version,
      enabled: version.enabled,
      expiresOn: version.expiresOn,
      createdOn: version.createdOn,
      tags: { ...version.tags },
      vaultUrl: this.vaultUrl,
      id: `${this.vaultUrl}/secrets/${secret.name}/${version.version}`,
    };
  }

  async setSecret(name, value, options = {}) {
    this.calls.push(["setSecret", name]);
    const failure = this.#failure("setSecret", name, value);
    if (failure) throw failure;
    if (!/^[0-9a-zA-Z-]{1,127}$/.test(name)) throw restError(400, "BadParameter", `The secret name ${name} is not valid.`);
    const key = name.toLowerCase();
    if (this.deleted.has(key) || this.deleting.has(key)) {
      throw restError(
        409,
        "Conflict",
        `Secret ${name} is currently in a deleted but recoverable state, and its name cannot be reused; in this state, the secret can only be recovered or purged.`,
        "ObjectIsDeletedButRecoverable",
      );
    }
    const secret = this.secrets.get(key) ?? { name, versions: [] };
    this.secrets.set(key, secret);
    const version = {
      version: randomBytes(16).toString("hex"),
      value,
      tags: { ...options.tags },
      enabled: options.enabled ?? true,
      expiresOn: options.expiresOn ? new Date(Math.floor(options.expiresOn.getTime() / 1000) * 1000) : undefined,
      createdOn: new Date(),
    };
    secret.versions.push(version);
    return { name: secret.name, value, properties: this.#properties(secret, version) };
  }

  async beginDeleteSecret(name) {
    this.calls.push(["beginDeleteSecret", name]);
    const failure = this.#failure("beginDeleteSecret", name);
    if (failure) throw failure;
    const key = name.toLowerCase();
    if (this.deleting.has(key)) throw restError(409, "Conflict", `Secret ${name} is currently being deleted.`, "ObjectIsBeingDeleted");
    const secret = this.secrets.get(key);
    if (!secret) throw restError(404, "SecretNotFound", `A secret with (name/id) ${name} was not found in this key vault.`);
    this.secrets.delete(key);
    this.deleted.set(key, secret);
    const result = { name: secret.name, properties: { name: secret.name, recoveryId: `${this.vaultUrl}/deletedsecrets/${secret.name}` } };
    return { pollUntilDone: async () => result, getResult: () => result, isDone: () => true };
  }

  listPropertiesOfSecretVersions(name) {
    this.calls.push(["listPropertiesOfSecretVersions", name]);
    const failure = this.#failure("listPropertiesOfSecretVersions", name);
    const secret = this.secrets.get(name.toLowerCase());
    const items = secret ? secret.versions.map((version) => this.#properties(secret, version)) : [];
    return (async function* list() {
      if (failure) throw failure;
      yield* items;
    })();
  }

  // ── for the tests ──────────────────────────────────────────────

  // Every version of an active secret, values included.
  versionsOf(name) {
    return this.secrets.get(name.toLowerCase())?.versions ?? [];
  }

  isSoftDeleted(name) {
    return this.deleted.has(name.toLowerCase());
  }

  // Puts a secret in the state between a delete request and its completion.
  startDeletion(name) {
    const key = name.toLowerCase();
    this.deleting.set(key, this.secrets.get(key));
    this.secrets.delete(key);
  }

  disable(name, version) {
    this.versionsOf(name).find((candidate) => candidate.version === version).enabled = false;
  }
}
