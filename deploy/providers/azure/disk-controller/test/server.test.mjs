// The controller's process: the Azure clients it builds, its server
// certificate (loading, checking and reloading the PEM bundle) and its three
// HTTPS listeners, end to end over real sockets with fake Azure modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAzureClients, main } from "../server.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createTlsSource, parsePemBundle } from "../lib/serving-tls.mjs";
import { APP, FakeContainerClient, FakeSecretClient, SCALE_SET_ID, SUBSCRIPTION, TENANT, WORKER_OID, createMemoryLogger } from "./fakes.mjs";
import { createTestPki } from "./x509.mjs";

const ENV = {
  PS_DISK_POOL_STATE_URL: "https://placeholder.blob.core.windows.net/disk-pool-state",
  PS_DISK_CONTROLLER_TOKEN_SCOPE: `api://${APP}/.default`,
  AZURE_TENANT_ID: TENANT,
  EXPECTED_WIN_WORKER_OID: WORKER_OID,
};
const VAULT = "https://myvault.vault.azure.net";

function fakeModules({ container = new FakeContainerClient(), secrets = new FakeSecretClient() } = {}) {
  const made = [];
  const imported = [];
  const tracked = (name, instance) => class {
    constructor(...args) {
      made.push({ name, args });
      return instance ?? this;
    }
  };
  const modules = {
    "@azure/identity": { DefaultAzureCredential: tracked("DefaultAzureCredential") },
    "@azure/storage-blob": { ContainerClient: tracked("ContainerClient", container) },
    "@azure/keyvault-secrets": { SecretClient: tracked("SecretClient", secrets) },
    "@azure/arm-compute": { ComputeManagementClient: tracked("ComputeManagementClient") },
    "@azure/arm-network": { NetworkManagementClient: tracked("NetworkManagementClient") },
    "@azure/arm-monitor": { MonitorClient: tracked("MonitorClient") },
  };
  const importModule = async (specifier) => {
    imported.push(specifier);
    if (!modules[specifier]) throw new Error(`unexpected import ${specifier}`);
    return modules[specifier];
  };
  return { importModule, made, imported, container };
}

test("the Azure clients share the pod's credential, and the ARM clients exist only with a scale set", async () => {
  const bare = fakeModules();
  const clients = await createAzureClients(loadConfig(ENV), { importModule: bare.importModule });
  assert.deepEqual(bare.imported.sort(), ["@azure/identity", "@azure/keyvault-secrets", "@azure/storage-blob"]);
  assert.equal(clients.container, bare.container);
  assert.deepEqual(bare.made.find((m) => m.name === "ContainerClient").args, [ENV.PS_DISK_POOL_STATE_URL, clients.credential]);
  assert.equal(clients.secrets, null, "no personal vault, no secret client");
  assert.equal(clients.compute, null);

  const full = fakeModules();
  const all = await createAzureClients(loadConfig({ ...ENV, PILOTSWARM_PERSONAL_SECRET_VAULT_URI: `${VAULT}/`, WIN_WORKER_SCALE_SET_ID: SCALE_SET_ID }), {
    importModule: full.importModule,
  });
  assert.deepEqual(full.made.find((m) => m.name === "SecretClient").args, [VAULT, all.credential]);
  for (const name of ["ComputeManagementClient", "NetworkManagementClient", "MonitorClient"]) {
    assert.deepEqual(full.made.find((m) => m.name === name).args, [all.credential, SUBSCRIPTION], name);
  }
  assert.equal(full.made.filter((m) => m.name === "DefaultAzureCredential").length, 1);
});

test("a TLS bundle must hold a certificate and the key that belongs to its first certificate", () => {
  const pki = createTestPki();
  const one = pki.issueLeaf();
  const other = pki.issueLeaf();
  const parsed = parsePemBundle(one.bundle);
  assert.equal(parsed.leaf.fingerprint256, new X509Certificate(one.pem).fingerprint256);
  assert.equal(parsed.cert.match(/BEGIN CERTIFICATE/g).length, 2, "the chain is served with the leaf");
  assert.throws(() => parsePemBundle(`${one.pem}${other.keyPem}`), /does not belong/);
  assert.throws(() => parsePemBundle(one.keyPem), /no certificate/);
  assert.throws(() => parsePemBundle(one.pem), /no private key/);
});

test("a renewed bundle replaces the served one, and a broken one keeps the current", () => {
  const pki = createTestPki();
  const first = pki.issueLeaf();
  const second = pki.issueLeaf();
  let content = first.bundle;
  let fire;
  const unwatched = [];
  const log = createMemoryLogger();
  const source = createTlsSource("/mnt/tls/bundle", {
    log,
    readFile: () => content,
    watch: (path, listener) => {
      fire = listener;
    },
    unwatch: (path) => unwatched.push(path),
  });
  const seen = [];
  source.onChange((options) => seen.push(options));
  assert.equal(source.options().key, first.keyPem.trim());

  fire();
  assert.equal(seen.length, 0, "the same certificate is not loaded again");
  content = second.bundle;
  fire();
  assert.equal(seen.length, 1);
  assert.equal(source.options().key, second.keyPem.trim());
  content = "garbage";
  fire();
  assert.equal(seen.length, 1);
  assert.equal(source.options().key, second.keyPem.trim());
  assert.equal(log.events("tls.reload-failed").length, 1);
  assert.equal(log.events("tls.reloaded").length, 1);
  assert.doesNotMatch(log.text(), /PRIVATE KEY/);
  source.close();
  assert.deepEqual(unwatched, ["/mnt/tls/bundle"]);
});

function call(port, { method = "GET", path, headers = {}, body, ca, abortAfter } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, method, path, headers, ca, agent: false }, (res) => {
      const fingerprint = res.socket.getPeerCertificate().fingerprint256;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, fingerprint }));
    });
    req.on("error", reject);
    if (abortAfter) {
      req.write(abortAfter);
      setTimeout(() => {
        req.destroy();
        resolve(null);
      }, 50);
      return;
    }
    req.end(body);
  });
}

test("the three listeners serve HTTPS with the bundle, answer health without a token and survive bad callers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dc-server-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pki = createTestPki({ names: ["IP:127.0.0.1"] });
  const first = pki.issueLeaf();
  const file = join(dir, "disk-controller-tls");
  writeFileSync(file, first.bundle);
  const modules = fakeModules();
  const log = createMemoryLogger();
  let fire;
  const intervals = [];
  const server = await main({
    env: { ...ENV, PS_DISK_CONTROLLER_TLS_FILE: file },
    importModule: modules.importModule,
    log,
    ports: { worker: 0, dispatcher: 0, coordination: 0 },
    host: "127.0.0.1",
    timers: { setInterval: (fn, ms) => intervals.push(ms), clearInterval: () => {} },
    tlsWatch: { watch: (path, listener) => { fire = listener; }, unwatch: () => {} },
  });
  let closed = false;
  t.after(() => (closed ? undefined : server.close()));
  assert.equal(intervals.length, 2, "the tick and the snapshot refresh timers start");
  const ca = pki.caPem;

  const health = await call(server.ports.dispatcher, { path: "/disk-pool/v1/healthz", ca });
  assert.equal(health.status, 200);
  assert.equal(health.body, "");
  assert.equal(health.fingerprint, new X509Certificate(first.pem).fingerprint256);
  assert.equal((await call(server.ports.worker, { path: "/disk-pool/v1/healthz", ca })).status, 404);
  assert.equal((await call(server.ports.coordination, { method: "POST", path: "/v1/coordination/demand", ca, body: "{}" })).status, 401);

  const unauthenticated = await call(server.ports.dispatcher, { method: "POST", path: "/disk-pool/v1/disks/claim", ca, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers["www-authenticate"], "Bearer");
  const large = await call(server.ports.dispatcher, { method: "POST", path: "/disk-pool/v1/disks/claim", ca, body: "x".repeat(70 * 1024) });
  assert.equal(large.status, 413);
  assert.equal(JSON.parse(large.body).error, "TOO_LARGE");

  await call(server.ports.worker, { method: "POST", path: "/v1/vms/heartbeat", ca, headers: { "content-length": "1000" }, abortAfter: "{\"partial\":" });
  for (let i = 0; i < 50 && !log.events("request.aborted").length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(log.events("request.aborted").length, 1, "a caller that goes away mid-body is logged, not fatal");
  assert.equal((await call(server.ports.dispatcher, { path: "/disk-pool/v1/healthz", ca })).status, 200);

  const second = pki.issueLeaf();
  writeFileSync(file, second.bundle);
  fire();
  for (const port of Object.values(server.ports)) {
    const answer = await call(port, { path: "/disk-pool/v1/healthz", ca });
    assert.equal(answer.fingerprint, new X509Certificate(second.pem).fingerprint256, "every listener serves the renewed leaf without a restart");
  }

  await server.close();
  closed = true;
  await assert.rejects(call(server.ports.dispatcher, { path: "/disk-pool/v1/healthz", ca }), /ECONNREFUSED/);
});
