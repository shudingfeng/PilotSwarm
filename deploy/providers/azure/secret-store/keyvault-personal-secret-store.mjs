/**
 * A PilotSwarm personal secret store backed by Azure Key Vault.
 *
 * With PILOTSWARM_PERSONAL_SECRETS=external, the portal hands each personal
 * GitHub token to the store that PILOTSWARM_PERSONAL_SECRET_STORE_MODULE names
 * and keeps only the reference the store returns. Naming this file there keeps
 * the tokens in the vault at PILOTSWARM_PERSONAL_SECRET_VAULT_URI, written with
 * the portal's own identity (DefaultAzureCredential, the workload identity in
 * AKS).
 *
 * That identity needs only three data actions on the vault: setSecret (put),
 * delete (delete) and readMetadata (describe, and the owner check of an
 * update). The store never reads a value back, recovers or purges, so a role
 * without those rights is enough.
 *
 * A registration writes a new secret, ghcp-<owner subject>-<random ID>, and an
 * update writes a new version of it. Key Vault keeps a deleted secret's name
 * reserved until it is purged, and the store never writes a removed name
 * again.
 *
 * Only `createPersonalSecretStore` imports the Azure SDKs, so the store itself
 * runs against any SecretClient-shaped object, such as the tests' fake vault.
 */
import { randomBytes } from "node:crypto";

export const PERSONAL_SECRET_VAULT_URI_SETTING = "PILOTSWARM_PERSONAL_SECRET_VAULT_URI";

const NAME_PREFIX = "ghcp-";
const ID_HEX_LENGTH = 32;
// Key Vault secret names are 1 to 127 letters, digits and hyphens.
const MAX_SUBJECT_LENGTH = 127 - NAME_PREFIX.length - 1 - ID_HEX_LENGTH;
const SUBJECT = new RegExp(`^[0-9A-Za-z-]{1,${MAX_SUBJECT_LENGTH}}$`);
// The ID's fixed length makes the owner part unambiguous even when the
// subject itself contains hyphens.
const SECRET_NAME = new RegExp(`^${NAME_PREFIX}([0-9A-Za-z-]{1,${MAX_SUBJECT_LENGTH}})-[0-9a-f]{${ID_HEX_LENGTH}}$`);

function redact(text, token) {
  return token ? String(text).split(token).join("[REDACTED]") : String(text);
}

/**
 * Key Vault's error reduced to its status, code and message. The SDK's error
 * also carries the request, whose body holds the value on a write, so it is
 * never passed on.
 */
function vaultError(action, err, token) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const label = [status, code].filter((part) => part !== null).join(" ");
  const error = new Error(redact(`Key Vault could not ${action}${label ? ` (${label})` : ""}: ${err?.message ?? err}`, token));
  if (status !== null) error.statusCode = status;
  if (code !== null && redact(code, token) === code) error.code = code;
  return error;
}

function ownerSubject(owner) {
  const subject = owner?.principal?.subject;
  if (typeof subject !== "string" || !subject) {
    throw new Error("The Key Vault personal secret store names each secret after its owner's signed-in principal, and this owner has none.");
  }
  if (!SUBJECT.test(subject)) {
    throw new Error(
      `The Key Vault personal secret store needs an owner subject of 1 to ${MAX_SUBJECT_LENGTH} letters, digits or hyphens, `
      + "such as an Entra object ID; this owner's subject is not.",
    );
  }
  return subject;
}

function expiry(value) {
  if (value === null || value === undefined) return undefined;
  const date = new Date(value instanceof Date ? value.getTime() : typeof value === "string" ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) throw new TypeError("A personal secret's expiresOn must be an ISO 8601 date or null.");
  return date;
}

function newSecretName(subject) {
  return `${NAME_PREFIX}${subject}-${randomBytes(ID_HEX_LENGTH / 2).toString("hex")}`;
}

/**
 * The PersonalSecretStore over a Key Vault SecretClient. `storeName` is the
 * store's name for itself, recorded in every reference it returns.
 */
export function createKeyVaultPersonalSecretStore({ client, storeName } = {}) {
  for (const method of ["setSecret", "beginDeleteSecret", "listPropertiesOfSecretVersions"]) {
    if (typeof client?.[method] !== "function") {
      throw new TypeError(`The Key Vault personal secret store needs a SecretClient; this client has no ${method}.`);
    }
  }
  if (typeof storeName !== "string" || !storeName) throw new TypeError("The Key Vault personal secret store needs its store name.");

  /**
   * The secret a reference names when this store wrote it, or null for
   * another store's reference or a name this store never writes. Such a
   * secret is out of this store's reach, so it is left alone: a provider
   * saved under another store can still be updated and deleted.
   */
  function ownSecret(ref) {
    if (!ref || typeof ref !== "object" || typeof ref.store !== "string"
      || typeof ref.name !== "string" || typeof ref.version !== "string") {
      throw new TypeError("A personal secret reference needs a store, a name and a version.");
    }
    if (ref.store !== storeName) return null;
    const match = SECRET_NAME.exec(ref.name);
    return match ? { name: ref.name, version: ref.version, owner: match[1] } : null;
  }

  // Metadata only: Key Vault lists versions without their values. It lists
  // nothing for a name that does not exist or is deleted.
  async function versionsOf(name) {
    const versions = [];
    try {
      for await (const properties of client.listPropertiesOfSecretVersions(name)) versions.push(properties);
    } catch (err) {
      if (err?.statusCode === 404) return [];
      throw vaultError(`list the versions of secret ${name}`, err);
    }
    return versions;
  }

  async function nameToWrite(previous, subject) {
    const own = previous ? ownSecret(previous) : null;
    if (!own) return newSecretName(subject);
    if (own.owner !== subject) {
      throw new Error(`Secret ${own.name} belongs to another owner, so the store does not write it.`);
    }
    const versions = await versionsOf(own.name);
    // The secret was removed. Its name is never written again.
    if (versions.length === 0) return newSecretName(subject);
    const current = versions.find((properties) => properties.version === own.version);
    if (!current) throw new Error(`Secret ${own.name} has no version that the reference names, so the store does not write it.`);
    if (current.tags?.ownerOid !== subject) {
      throw new Error(`Secret ${own.name} is tagged with another owner, so the store does not write it.`);
    }
    return own.name;
  }

  return Object.freeze({
    async put(secret) {
      const token = secret?.token;
      if (typeof token !== "string" || !token) throw new TypeError("A personal secret needs a token.");
      const subject = ownerSubject(secret.owner);
      const expiresOn = expiry(secret.expiresOn);
      const name = await nameToWrite(secret.previous ?? null, subject);
      let written;
      try {
        written = await client.setSecret(name, token, { tags: { ownerOid: subject }, ...(expiresOn ? { expiresOn } : {}) });
      } catch (err) {
        throw vaultError(`write secret ${name}`, err, token);
      }
      const version = written?.properties?.version;
      if (typeof version !== "string" || !version) throw new Error(`Key Vault returned no version for secret ${name}.`);
      const recorded = written.properties.expiresOn;
      return {
        store: storeName,
        name,
        version,
        expiresOn: recorded instanceof Date ? recorded.toISOString() : expiresOn?.toISOString() ?? null,
      };
    },

    async delete(ref) {
      const own = ownSecret(ref);
      if (!own) return;
      try {
        const poller = await client.beginDeleteSecret(own.name);
        await poller.pollUntilDone();
      } catch (err) {
        if (err?.statusCode === 404) return;
        // A deletion that is already under way answers 409 until it ends.
        if (err?.statusCode === 409 && (await versionsOf(own.name)).length === 0) return;
        throw vaultError(`delete secret ${own.name}`, err);
      }
    },

    async describe(ref) {
      const own = ownSecret(ref);
      if (!own) return null;
      const properties = (await versionsOf(own.name)).find((candidate) => candidate.version === own.version);
      if (!properties) return null;
      return {
        enabled: properties.enabled !== false,
        expiresOn: properties.expiresOn instanceof Date ? properties.expiresOn.toISOString() : null,
      };
    },
  });
}

function personalSecretVault(value) {
  const configured = typeof value === "string" ? value.trim() : "";
  if (!configured) {
    throw new Error(
      `${PERSONAL_SECRET_VAULT_URI_SETTING} must name the Key Vault that keeps personal secrets, `
      + "for example https://myvault.vault.azure.net/.",
    );
  }
  let url = null;
  try {
    url = new URL(configured);
  } catch {
    // Reported below, without repeating the value.
  }
  if (url?.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `${PERSONAL_SECRET_VAULT_URI_SETTING} must be the vault's https URI and nothing more, `
      + "for example https://myvault.vault.azure.net/.",
    );
  }
  return { url: url.origin, storeName: `keyvault:${url.hostname}` };
}

/**
 * The portal's entry point. Reads PILOTSWARM_PERSONAL_SECRET_VAULT_URI from
 * `env` and only then imports the Azure SDKs this package installs.
 * `importModule` lets tests stand in for them.
 */
export async function createPersonalSecretStore({ env = process.env } = {}, { importModule = (specifier) => import(specifier) } = {}) {
  const vault = personalSecretVault(env?.[PERSONAL_SECRET_VAULT_URI_SETTING]);
  const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([
    importModule("@azure/keyvault-secrets"),
    importModule("@azure/identity"),
  ]);
  return createKeyVaultPersonalSecretStore({
    client: new SecretClient(vault.url, new DefaultAzureCredential()),
    storeName: vault.storeName,
  });
}

export default createPersonalSecretStore;
