// Contract tests for the Key Vault personal secret store
// (keyvault-personal-secret-store.mjs) against an in-memory Key Vault
// (fake-key-vault.mjs). They need neither Azure nor this package's own
// dependencies, so `npm run test:deploy-scripts` runs them from the root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import loadedByDefault, {
  createKeyVaultPersonalSecretStore,
  createPersonalSecretStore,
} from "../keyvault-personal-secret-store.mjs";
import { FakeKeyVault, restError } from "./fake-key-vault.mjs";

const STORE = "keyvault:myvault.vault.azure.net";
const OTHER_STORE = "keyvault:test-vault.vault.azure.net";
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TOKEN = `github_pat_${"Kq7".repeat(27)}`;
const NEW_TOKEN = `github_pat_${"Zm4".repeat(27)}`;
const EXPIRES = "2026-12-01T08:30:00.000Z";
const OWNER_SECRET = new RegExp(`^ghcp-${OWNER}-[0-9a-f]{32}$`);

function setup() {
  const vault = new FakeKeyVault();
  return { vault, store: createKeyVaultPersonalSecretStore({ client: vault, storeName: STORE }) };
}

function owner(subject = OWNER) {
  return { userId: 7, principal: { provider: "entra", subject } };
}

function put(store, overrides = {}) {
  return store.put({ provider: "my-ghcp", owner: owner(), token: TOKEN, expiresOn: EXPIRES, previous: null, ...overrides });
}

const ref = (written) => ({ kind: "externalSecret", ...written });

test("a registration writes a new ghcp-<owner>-<random ID> secret, tagged with its owner and expiring with the token", async () => {
  const { vault, store } = setup();
  const written = await put(store);
  assert.deepEqual(Object.keys(written).sort(), ["expiresOn", "name", "store", "version"]);
  assert.match(written.name, OWNER_SECRET);
  assert.equal(written.store, STORE);
  assert.equal(written.expiresOn, EXPIRES);
  const [version] = vault.versionsOf(written.name);
  assert.equal(written.version, version.version);
  assert.equal(version.value, TOKEN);
  assert.deepEqual(version.tags, { ownerOid: OWNER });
  assert.equal(version.expiresOn.toISOString(), EXPIRES);

  const unknownExpiry = await put(store, { expiresOn: null });
  assert.match(unknownExpiry.name, OWNER_SECRET);
  assert.notEqual(unknownExpiry.name, written.name, "every registration gets a fresh ID");
  assert.equal(unknownExpiry.expiresOn, null);
  assert.equal(vault.versionsOf(unknownExpiry.name)[0].expiresOn, undefined);
});

test("an update writes a new version of the reference's secret", async () => {
  const { vault, store } = setup();
  const first = await put(store);
  const later = "2026-12-20T00:00:00.000Z";
  const updated = await put(store, { token: NEW_TOKEN, expiresOn: later, previous: ref(first) });
  assert.equal(updated.name, first.name);
  assert.notEqual(updated.version, first.version);
  assert.equal(updated.expiresOn, later);
  const versions = vault.versionsOf(first.name);
  assert.deepEqual(versions.map((version) => version.value), [TOKEN, NEW_TOKEN]);
  assert.deepEqual(versions[1].tags, { ownerOid: OWNER });
  assert.equal(versions[1].expiresOn.toISOString(), later);
});

test("an update refuses a secret of this store that belongs to another owner, by its name or by its tag", async () => {
  const { vault, store } = setup();
  const theirs = await put(store, { owner: owner(OTHER_OWNER) });
  await assert.rejects(put(store, { previous: ref(theirs) }), /belongs to another owner/);

  const misTagged = `ghcp-${OWNER}-${"0".repeat(32)}`;
  const planted = await vault.setSecret(misTagged, "planted", { tags: { ownerOid: OTHER_OWNER } });
  const previous = { kind: "externalSecret", store: STORE, name: misTagged, version: planted.properties.version, expiresOn: null };
  await assert.rejects(put(store, { previous }), /tagged with another owner/);

  assert.deepEqual(vault.versionsOf(theirs.name).map((version) => version.value), [TOKEN]);
  assert.deepEqual(vault.versionsOf(misTagged).map((version) => version.value), ["planted"]);
  assert.equal(vault.calls.filter(([method]) => method === "setSecret").length, 2, "nothing written after the refusals");
});

test("an update whose reference this store cannot own writes a new secret and leaves the old one alone", async () => {
  const { vault, store } = setup();
  const name = `ghcp-${OWNER}-${"1".repeat(32)}`;
  const lookalike = await vault.setSecret(name, "same name, this vault");
  const unrelated = await vault.setSecret("unrelated", "not this store's");
  vault.calls.length = 0;

  for (const previous of [
    { kind: "externalSecret", store: OTHER_STORE, name, version: lookalike.properties.version, expiresOn: null },
    { kind: "externalSecret", store: STORE, name: "unrelated", version: unrelated.properties.version, expiresOn: null },
  ]) {
    const written = await put(store, { previous });
    assert.match(written.name, OWNER_SECRET);
    assert.equal(written.store, STORE);
    assert.notEqual(written.name, previous.name);
    assert.deepEqual(vault.calls, [["setSecret", written.name]], "only the new secret is touched");
    vault.calls.length = 0;
  }
  assert.equal(vault.versionsOf(name).length, 1);
  assert.equal(vault.versionsOf("unrelated").length, 1);
});

test("delete soft-deletes the secret, never purges it, and a secret already gone is no error", async () => {
  const { vault, store } = setup();
  const written = await put(store);
  await store.delete(ref(written));
  assert.deepEqual(vault.versionsOf(written.name), []);
  assert.ok(vault.isSoftDeleted(written.name));

  await store.delete(ref(written));
  await store.delete({ ...ref(written), name: `ghcp-${OWNER}-${"2".repeat(32)}` });

  const deleting = await put(store);
  vault.startDeletion(deleting.name);
  await store.delete(ref(deleting));

  const outage = await put(store);
  vault.failNext("beginDeleteSecret", () => restError(503, "ServiceUnavailable", "Try again later."));
  await assert.rejects(store.delete(ref(outage)), /Key Vault could not delete secret ghcp-\S+ \(503 ServiceUnavailable\): Try again later\./);
  assert.equal(vault.versionsOf(outage.name).length, 1);
  assert.deepEqual(vault.forbiddenCalls, []);
});

test("delete of a reference this store cannot own does nothing and calls Key Vault for nothing", async () => {
  const { vault, store } = setup();
  const mine = await put(store);
  vault.calls.length = 0;
  await store.delete({ ...ref(mine), store: OTHER_STORE });
  await store.delete({ ...ref(mine), name: "unrelated" });
  assert.deepEqual(vault.calls, []);
  assert.equal(vault.versionsOf(mine.name).length, 1);
});

test("describe returns the version's attributes, never its value, and null once the secret or version is gone", async () => {
  const { vault, store } = setup();
  const written = await put(store);
  assert.deepEqual(await store.describe(ref(written)), { enabled: true, expiresOn: EXPIRES });
  vault.disable(written.name, written.version);
  assert.deepEqual(await store.describe(ref(written)), { enabled: false, expiresOn: EXPIRES });
  assert.equal(await store.describe({ ...ref(written), version: "3".repeat(32) }), null);

  await store.delete(ref(written));
  assert.equal(await store.describe(ref(written)), null);
  assert.deepEqual(vault.forbiddenCalls, []);
});

test("describe of a reference this store cannot own is null, without a Key Vault call", async () => {
  const { vault, store } = setup();
  const mine = await put(store);
  vault.calls.length = 0;
  assert.equal(await store.describe({ ...ref(mine), store: OTHER_STORE }), null);
  assert.equal(await store.describe({ ...ref(mine), name: "unrelated" }), null);
  assert.deepEqual(vault.calls, []);
});

test("an owner can register, remove and register again; a removed name is never written again", async () => {
  const { vault, store } = setup();
  const first = await put(store);
  await store.delete(ref(first));
  const again = await put(store, { token: NEW_TOKEN });
  assert.match(again.name, OWNER_SECRET);
  assert.notEqual(again.name, first.name);

  const replacement = await put(store, { token: NEW_TOKEN, previous: ref(first) });
  assert.match(replacement.name, OWNER_SECRET);
  assert.notEqual(replacement.name, first.name);
  assert.equal(vault.calls.filter(([method, name]) => method === "setSecret" && name === first.name).length, 1);
  assert.ok(vault.isSoftDeleted(first.name));
});

test("a put needs the owner's principal, with a subject that fits a Key Vault name", async () => {
  const { vault, store } = setup();
  for (const principal of [null, { provider: "entra", subject: "" }]) {
    await assert.rejects(put(store, { owner: { userId: 7, principal } }), /owner's signed-in principal/);
  }
  for (const subject of ["alice@example.com", "a_b", "x".repeat(90)]) {
    await assert.rejects(put(store, { owner: owner(subject) }), /1 to 89 letters, digits or hyphens/, subject);
  }
  assert.deepEqual(vault.calls, []);

  const longest = await put(store, { owner: owner("x".repeat(89)) });
  assert.equal(longest.name.length, 127);
});

test("the factory refuses a missing or malformed PILOTSWARM_PERSONAL_SECRET_VAULT_URI before importing an Azure SDK", async () => {
  const imported = [];
  const importModule = async (specifier) => {
    imported.push(specifier);
    throw new Error("no Azure SDK in this test");
  };
  await assert.rejects(createPersonalSecretStore({ env: {} }), /PILOTSWARM_PERSONAL_SECRET_VAULT_URI must name the Key Vault/);
  await assert.rejects(createPersonalSecretStore({ env: {} }, { importModule }), /PILOTSWARM_PERSONAL_SECRET_VAULT_URI must name the Key Vault/);
  for (const uri of [
    "http://myvault.vault.azure.net/",
    "myvault.vault.azure.net",
    "https://myvault.vault.azure.net/secrets/name",
    "https://myvault.vault.azure.net/?api-version=1",
    "https://reader:hunter2@myvault.vault.azure.net/",
  ]) {
    await assert.rejects(
      createPersonalSecretStore({ env: { PILOTSWARM_PERSONAL_SECRET_VAULT_URI: uri } }, { importModule }),
      (err) => /must be the vault's https URI and nothing more/.test(err.message) && !err.message.includes("hunter2"),
      uri,
    );
  }
  assert.deepEqual(imported, []);
});

test("the factory builds a SecretClient for the configured vault with DefaultAzureCredential", async () => {
  const built = [];
  class DefaultAzureCredential {}
  class SecretClient extends FakeKeyVault {
    constructor(vaultUrl, credential) {
      super({ vaultUrl });
      built.push({ vaultUrl, credential });
    }
  }
  const modules = { "@azure/keyvault-secrets": { SecretClient }, "@azure/identity": { DefaultAzureCredential } };
  const env = { PILOTSWARM_PERSONAL_SECRET_VAULT_URI: " https://MyVault.vault.azure.net/ " };
  const store = await loadedByDefault({ env }, { importModule: async (specifier) => modules[specifier] });
  assert.equal(loadedByDefault, createPersonalSecretStore);
  assert.equal(built.length, 1);
  assert.equal(built[0].vaultUrl, "https://myvault.vault.azure.net");
  assert.ok(built[0].credential instanceof DefaultAzureCredential);
  assert.equal((await put(store)).store, STORE, "the store is named after the vault's host");
});

test("no error or log line carries the token, even when Key Vault's error does", async (t) => {
  const logged = [];
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    t.mock.method(console, level, (...args) => logged.push(args.map((arg) => inspect(arg)).join(" ")));
  }
  const { vault, store } = setup();
  vault.failNext("setSecret", (name, value) => Object.defineProperty(
    restError(500, "InternalError", `The service echoed ${value}.`),
    "request",
    { value: { body: JSON.stringify({ value }) }, enumerable: false },
  ));
  const failures = [await put(store).catch((err) => err)];
  assert.match(failures[0].message, /^Key Vault could not write secret ghcp-\S+ \(500 InternalError\): The service echoed \[REDACTED\]\.$/);
  assert.equal(failures[0].statusCode, 500);

  const written = await put(store);
  vault.failNext("listPropertiesOfSecretVersions", () => restError(503, "ServiceUnavailable", "Try again later."));
  failures.push(await put(store, { previous: ref(written) }).catch((err) => err));
  failures.push(await put(store, { owner: { userId: 7, principal: null } }).catch((err) => err));
  failures.push(await put(store, { owner: owner("not a name") }).catch((err) => err));
  failures.push(await put(store, { expiresOn: "soon" }).catch((err) => err));
  failures.push(await put(store, { previous: ref(await put(store, { owner: owner(OTHER_OWNER) })) }).catch((err) => err));

  for (const failure of failures) {
    assert.ok(failure instanceof Error, String(failure));
    const shown = [failure.message, String(failure), failure.stack, inspect(failure, { showHidden: true, depth: 8 }), JSON.stringify(failure)];
    assert.equal(shown.join("\n").includes(TOKEN), false, failure.message);
  }
  assert.equal(logged.join("\n").includes(TOKEN), false);
});
