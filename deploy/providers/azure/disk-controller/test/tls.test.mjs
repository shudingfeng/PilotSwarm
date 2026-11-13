// The TLS deploy step: the private CA, the leaf's names and renewal, where the
// secrets go, the secret-scoped grant, and the CA objects for the cluster.
// The fakes answer openssl and the Azure CLI; one test uses the real openssl
// when it is on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";

import {
  CA_CERT_SECRET,
  CA_KEY_SECRET,
  LEAF_SECRET,
  alternativeNames,
  applyCaToCluster,
  caClusterManifest,
  ensureDiskControllerTls,
  leafIdentity,
  leafRenewalReason,
  promoteCaRotation,
  startCaRotation,
} from "../tls.mjs";
import { parsePemBundle } from "../lib/serving-tls.mjs";
import { createFakeAz, createFakeOpenssl, createTestPki } from "./x509.mjs";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const VAULT_ID = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/stamp-rg/providers/Microsoft.KeyVault/vaults/stamp-kv";
const CONTROLLER = "66666666-6666-6666-6666-666666666666";
const INPUTS = {
  namespace: "pilotswarm",
  stampVaultName: "stamp-kv",
  stampVaultResourceId: VAULT_ID,
  deployVaultName: "stamp-kv-deploy",
  controllerPrincipalId: CONTROLLER,
};
const DISPATCHER_DNS = "pilotswarm-disk-controller-dispatcher.pilotswarm.svc";
const COORDINATION_DNS = "pilotswarm-disk-controller-coordination.pilotswarm.svc";
const GRANT = `grant Key Vault Secrets User ${VAULT_ID}/secrets/disk-controller-tls ${CONTROLLER}`;

function setup(t, { start = START, runFor } = {}) {
  let clock = start;
  const now = () => clock;
  const tmpRoot = mkdtempSync(join(tmpdir(), "dc-tls-test-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const openssl = createFakeOpenssl({ now });
  const az = createFakeAz();
  const commands = [];
  const runFn = (name, args, opts) => {
    commands.push({ name, args, opts });
    if (runFor?.[name]) return runFor[name](args, opts);
    if (name === "openssl") return openssl.openssl(args);
    if (name === "az") return az.az(args);
    throw new Error(`unexpected command ${name}`);
  };
  const logs = [];
  const log = (level, message) => logs.push({ level, message });
  return {
    openssl,
    az,
    commands,
    logs,
    now,
    tmpRoot,
    runFn,
    advance(days) {
      clock += days * DAY;
    },
    deploy(inputs = INPUTS) {
      return ensureDiskControllerTls(inputs, { runFn, now, tmpRoot, log });
    },
    leftovers: () => readdirSync(tmpRoot),
    leaf: () => parsePemBundle(az.vault("stamp-kv").get(LEAF_SECRET)).leaf,
    ca: () => new X509Certificate(az.vault("stamp-kv-deploy").get(CA_CERT_SECRET)),
  };
}

const daysValid = (certificate, from) => Math.round((Date.parse(certificate.validTo) - from) / DAY);

test("the leaf names the worker address and both Service names, with the dispatcher's as its common name", () => {
  assert.deepEqual(leafIdentity({ namespace: "pilotswarm" }), {
    commonName: DISPATCHER_DNS,
    names: ["IP:10.20.15.250", `DNS:${DISPATCHER_DNS}`, `DNS:${COORDINATION_DNS}`],
  });
  assert.deepEqual(leafIdentity({ namespace: "ps-b", workerPortIp: "10.20.15.9" }).names[0], "IP:10.20.15.9");
  assert.throws(() => leafIdentity({ namespace: "Not_A_Namespace" }), /namespace/);
  assert.throws(() => leafIdentity({ namespace: "pilotswarm", workerPortIp: "10.20.15.256" }), /IPv4/);
  assert.deepEqual(
    alternativeNames(`X509v3 Subject Alternative Name: \n    IP Address:10.20.15.250, DNS:${DISPATCHER_DNS}, DNS:${COORDINATION_DNS}\n`),
    [`DNS:${COORDINATION_DNS}`, `DNS:${DISPATCHER_DNS}`, "IP:10.20.15.250"],
  );
});

test("a first deploy creates the CA in the deploy-only vault and stores a 1-year leaf bundle in the stamp vault", (t) => {
  const env = setup(t);
  const result = env.deploy();
  assert.equal(result.caCreated, true);
  assert.equal(result.leafRenewed, true);
  assert.equal(result.reason, "no leaf is stored");

  const deployVault = env.az.vault("stamp-kv-deploy");
  const ca = env.ca();
  assert.equal(result.caPem, deployVault.get(CA_CERT_SECRET));
  assert.equal(ca.ca, true);
  assert.equal(ca.subject, "CN=PilotSwarm disk controller CA");
  assert.equal(daysValid(ca, START), 1826);
  assert.ok(ca.checkPrivateKey(createPrivateKey(deployVault.get(CA_KEY_SECRET))));
  assert.deepEqual([...env.az.vault("stamp-kv").keys()], [LEAF_SECRET], "the CA key never goes to the stamp vault");

  const bundle = env.az.vault("stamp-kv").get(LEAF_SECRET);
  assert.deepEqual([...bundle.matchAll(/-----BEGIN ([A-Z ]+)-----/g)].map((m) => m[1]), ["CERTIFICATE", "CERTIFICATE", "PRIVATE KEY"]);
  const { leaf } = parsePemBundle(bundle);
  assert.equal(leaf.subject, `CN=${DISPATCHER_DNS}`);
  assert.equal(leaf.subjectAltName, `IP Address:10.20.15.250, DNS:${DISPATCHER_DNS}, DNS:${COORDINATION_DNS}`);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.equal(daysValid(leaf, START), 365);
  for (const host of ["10.20.15.250", DISPATCHER_DNS, COORDINATION_DNS]) {
    assert.equal(checkServerIdentity(host, leaf.toLegacyObject()), undefined, host);
  }
  assert.ok(checkServerIdentity("127.0.0.1", leaf.toLegacyObject()) instanceof Error, "a port-forward must name 10.20.15.250");

  assert.deepEqual(env.az.events, [
    "list stamp-kv-deploy",
    "write stamp-kv-deploy/disk-controller-ca-key",
    "write stamp-kv-deploy/disk-controller-ca-cert",
    "read stamp-kv/disk-controller-tls",
    "write stamp-kv/disk-controller-tls",
    GRANT,
  ]);
  const grant = env.commands.find((c) => c.name === "az" && c.args[0] === "role");
  assert.deepEqual(grant.args, [
    "role", "assignment", "create",
    "--assignee-object-id", CONTROLLER,
    "--assignee-principal-type", "ServicePrincipal",
    "--role", "Key Vault Secrets User",
    "--scope", `${VAULT_ID}/secrets/disk-controller-tls`,
    "--output", "none",
  ]);
  const keySizes = env.openssl.calls.filter((args) => args[0] === "genpkey").map((args) => args[args.indexOf("-pkeyopt") + 1]);
  assert.deepEqual(keySizes, ["rsa_keygen_bits:4096", "rsa_keygen_bits:2048"]);
  assert.ok(env.openssl.calls.some((args) => args[0] === "x509" && args.includes("-noout") && args.at(-1) === "subjectAltName"),
    "the signed leaf's names are read back with openssl");
  for (const { args } of env.commands) {
    for (const arg of args) assert.doesNotMatch(String(arg), /-----BEGIN/, "no key or certificate on a command line");
  }
  for (const { args } of env.commands.filter((c) => c.name === "az" && c.args[2] === "set")) {
    assert.ok(args.includes("--file"), "secret values go through files");
  }
  assert.deepEqual(env.leftovers(), [], "the private temporary folder is removed");
});

test("a later deploy with a current leaf reads no CA key, writes nothing and keeps the grant", (t) => {
  const env = setup(t);
  const first = env.deploy();
  env.az.events.length = 0;
  env.openssl.calls.length = 0;
  env.advance(100);
  env.az.answerGrant({ status: 1, stdout: "", stderr: "ERROR: (RoleAssignmentExists) The role assignment already exists.\n" });
  const again = env.deploy();
  assert.deepEqual({ ...again, trustedCas: undefined }, {
    caPem: first.caPem, caCreated: false, leafRenewed: false, reason: null, trustedCas: undefined, caBundle: first.caPem,
  });
  assert.deepEqual(again.trustedCas.map((ca) => [ca.role, ca.secret, ca.pem]), [["current", CA_CERT_SECRET, first.caPem]]);
  assert.deepEqual(env.az.events, ["list stamp-kv-deploy", "read stamp-kv-deploy/disk-controller-ca-cert", "read stamp-kv/disk-controller-tls", GRANT]);
  assert.equal(env.openssl.calls.length, 0);
});

test("the leaf is issued again only when fewer than 60 days remain, and only then is the CA key read", (t) => {
  const env = setup(t);
  env.deploy();
  const firstLeaf = env.leaf();
  env.advance(304);
  assert.equal(env.deploy().leafRenewed, false, "61 days left");
  env.az.events.length = 0;
  env.advance(2);
  const renewed = env.deploy();
  assert.equal(renewed.reason, "the leaf expires in 59 days");
  assert.equal(renewed.caCreated, false);
  assert.deepEqual(env.az.events, [
    "list stamp-kv-deploy",
    "read stamp-kv-deploy/disk-controller-ca-cert",
    "read stamp-kv/disk-controller-tls",
    "read stamp-kv-deploy/disk-controller-ca-key",
    "write stamp-kv/disk-controller-tls",
    GRANT,
  ]);
  const leaf = env.leaf();
  assert.notEqual(leaf.serialNumber, firstLeaf.serialNumber);
  assert.ok(leaf.verify(env.ca().publicKey));
  assert.equal(daysValid(leaf, env.now()), 365);
});

test("the leaf is issued again when its names change, another CA signed it or it cannot be read", (t) => {
  const env = setup(t);
  env.deploy();
  assert.equal(env.deploy({ ...INPUTS, namespace: "pilotswarm-b" }).reason, "the leaf's names changed");
  assert.match(env.leaf().subjectAltName, /DNS:pilotswarm-disk-controller-dispatcher\.pilotswarm-b\.svc/);
  assert.equal(env.deploy({ ...INPUTS, namespace: "pilotswarm-b", workerPortIp: "10.20.15.251" }).reason, "the leaf's names changed");
  assert.match(env.leaf().subjectAltName, /^IP Address:10\.20\.15\.251,/);

  const identity = leafIdentity({ namespace: "pilotswarm" });
  const other = createTestPki({ now: env.now(), names: identity.names, commonName: identity.commonName, caName: "PilotSwarm disk controller CA" });
  env.az.vault("stamp-kv").set(LEAF_SECRET, other.issueLeaf().bundle);
  assert.equal(env.deploy().reason, "another CA signed the stored leaf");
  assert.ok(env.leaf().verify(env.ca().publicKey));

  env.az.vault("stamp-kv").set(LEAF_SECRET, "not a bundle");
  assert.equal(env.deploy().reason, "the stored leaf cannot be read");
});

test("leafRenewalReason checks the common name and the time left", () => {
  const identity = leafIdentity({ namespace: "pilotswarm" });
  const pki = createTestPki({ now: START, names: identity.names, commonName: identity.commonName });
  const check = (bundlePem) => leafRenewalReason({ bundlePem, caPem: pki.caPem, identity, now: START });
  assert.equal(check(pki.issueLeaf().bundle), null);
  assert.equal(check(pki.issueLeaf({ leafCommonName: "someone-else" }).bundle), "the leaf's common name changed");
  assert.equal(check(pki.issueLeaf({ days: 30 }).bundle), "the leaf expires in 30 days");
  assert.equal(check(pki.issueLeaf({ leafNames: identity.names.slice(1) }).bundle), "the leaf's names changed");
  assert.equal(check(null), "no leaf is stored");
});

test("a CA certificate lost from the vault is issued again from the kept key, so existing trust holds", (t) => {
  const env = setup(t);
  env.deploy();
  const oldCa = env.ca();
  env.az.vault("stamp-kv-deploy").delete(CA_CERT_SECRET);
  env.openssl.calls.length = 0;
  const result = env.deploy();
  assert.equal(result.caCreated, false);
  assert.equal(result.leafRenewed, false, "the stored leaf still verifies against the same key and name");
  const ca = env.ca();
  assert.notEqual(ca.serialNumber, oldCa.serialNumber);
  assert.equal(ca.subject, oldCa.subject);
  assert.equal(ca.publicKey.export({ type: "spki", format: "pem" }), oldCa.publicKey.export({ type: "spki", format: "pem" }));
  assert.ok(!env.openssl.calls.some((args) => args[0] === "genpkey"), "no new CA key");
  assert.ok(env.logs.some((l) => l.level === "warn" && /not its certificate/.test(l.message)));
});

test("without the CA key the step stops before writing anything", (t) => {
  const env = setup(t);
  env.deploy();
  env.az.vault("stamp-kv-deploy").delete(CA_KEY_SECRET);
  env.az.vault("stamp-kv").delete(LEAF_SECRET);
  env.az.events.length = 0;
  assert.throws(() => env.deploy(), /holds no disk-controller-ca-key to sign the leaf with/);
  assert.deepEqual(env.az.events.filter((e) => /^(?:write|disable|grant) /.test(e)), []);
  assert.deepEqual(env.leftovers(), []);
});

test("a CA near its end limits the leaf's validity, and one with 60 days or fewer stops the step", (t) => {
  const env = setup(t);
  env.deploy();
  env.advance(1626);
  env.deploy();
  assert.equal(daysValid(env.leaf(), env.now()), 199, "one day before the CA's end");
  assert.ok(env.logs.some((l) => l.level === "warn" && /CA expires in 200 days/.test(l.message)));
  env.advance(140);
  assert.throws(() => env.deploy(), /CA expires in 60 days, too soon to sign a leaf; rotate the CA first/);
});

test("command failures stop the step with the command's first error line and remove the temporary folder", (t) => {
  const failing = setup(t, { runFor: { openssl: () => ({ status: 1, stdout: "", stderr: "genpkey: bad option\nusage..." }) } });
  assert.throws(() => failing.deploy(), /openssl could not create the CA's key: genpkey: bad option$/);
  assert.deepEqual(failing.leftovers(), []);

  const forbidden = setup(t, { runFor: { az: () => ({ status: 1, stdout: "", stderr: "ERROR: (Forbidden) Caller is not authorized.\n" }) } });
  assert.throws(() => forbidden.deploy(), /Could not list the secrets in vault stamp-kv-deploy: ERROR: \(Forbidden\)/);

  const env = setup(t);
  env.az.answerGrant({ status: 1, stdout: "", stderr: "ERROR: (AuthorizationFailed) no write access\n" });
  assert.throws(() => env.deploy(), /Could not grant the controller's identity read access to disk-controller-tls: ERROR: \(AuthorizationFailed\)/);

  for (const key of Object.keys(INPUTS)) {
    assert.throws(() => ensureDiskControllerTls({ ...INPUTS, [key]: "" }, { runFn: () => assert.fail("no command runs") }), new RegExp(key));
  }
});

test("the CA objects for the cluster carry the CA certificate as ca.crt, and kubectl applies them from a private file", (t) => {
  const pki = createTestPki();
  const text = caClusterManifest({ namespace: "pilotswarm", caPem: pki.caPem });
  const [secret, configMap] = text.split("\n---\n");
  for (const [doc, kind] of [[secret, "Secret"], [configMap, "ConfigMap"]]) {
    assert.match(doc, new RegExp(`^kind: ${kind}$`, "m"));
    assert.match(doc, /^ {2}name: pilotswarm-disk-controller-ca$/m);
    assert.match(doc, /^ {2}namespace: pilotswarm$/m);
  }
  assert.equal(Buffer.from(/^ {2}ca\.crt: (\S+)$/m.exec(secret)[1], "base64").toString(), `${pki.caPem.trim()}\n`);
  const block = configMap.split("  ca.crt: |\n")[1].trimEnd().split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
  assert.equal(block, pki.caPem.trim());
  assert.throws(() => caClusterManifest({ namespace: "pilotswarm", caPem: "not a certificate" }), /PEM certificate/);

  const tmpRoot = mkdtempSync(join(tmpdir(), "dc-tls-test-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  let seen;
  const runFn = (name, args, opts) => {
    seen = { name, args, opts, content: readFileSync(args[2], "utf8") };
    return { status: 0, stdout: "", stderr: "" };
  };
  applyCaToCluster({ namespace: "pilotswarm", caPem: pki.caPem }, { runFn, tmpRoot, kubeEnv: { KUBECONFIG: "kubeconfig" } });
  assert.equal(seen.name, "kubectl");
  assert.deepEqual(seen.args.slice(0, 2), ["apply", "--filename"]);
  assert.equal(seen.content, text);
  assert.equal(seen.opts.env.KUBECONFIG, "kubeconfig");
  assert.deepEqual(readdirSync(tmpRoot), []);
  assert.throws(() => applyCaToCluster({ namespace: "pilotswarm", caPem: pki.caPem }, {
    runFn: () => ({ status: 1, stdout: "", stderr: "error: forbidden\n" }), tmpRoot,
  }), /Could not apply pilotswarm-disk-controller-ca: error: forbidden/);
});

const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

test("with the real openssl, the signed leaf carries the names and serves TLS that the CA alone verifies, and a promoted CA's leaf names its key", { skip: !hasOpenssl && "openssl is not on PATH" }, async (t) => {
  const env = setup(t, {
    start: Date.now(),
    runFor: {
      openssl: (args) => {
        const result = spawnSync("openssl", args, { encoding: "utf8" });
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    },
  });
  const result = env.deploy();
  assert.equal(result.leafRenewed, true);
  const ca = env.ca();
  assert.equal(ca.ca, true);
  assert.equal(ca.subject, "CN=PilotSwarm disk controller CA");
  const leaf = env.leaf();
  assert.equal(leaf.subject, `CN=${DISPATCHER_DNS}`);
  assert.deepEqual(alternativeNames(leaf.subjectAltName), [`DNS:${COORDINATION_DNS}`, `DNS:${DISPATCHER_DNS}`, "IP:10.20.15.250"]);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.ok(Math.abs(daysValid(leaf, Date.now()) - 365) <= 1);
  assert.equal(env.deploy().leafRenewed, false, "a second deploy keeps the leaf");

  const { cert, key } = parsePemBundle(env.az.vault("stamp-kv").get(LEAF_SECRET));
  const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const body = await new Promise((resolve, reject) => {
    https.get({
      host: "127.0.0.1",
      port: server.address().port,
      ca: result.caPem,
      checkServerIdentity: (_host, peer) => checkServerIdentity("10.20.15.250", peer),
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
  assert.equal(body, "ok");

  // A rotation: the next CA has a name of its own, and the leaf it signs once
  // promoted names its key, which a client that holds both CAs verifies.
  const options = { runFn: env.runFn, now: env.now, tmpRoot: env.tmpRoot, log: () => {} };
  const next = startCaRotation({ deployVaultName: "stamp-kv-deploy" }, options).next;
  assert.match(next.subject, /^CN=PilotSwarm disk controller CA \d{8}$/);
  const promoted = promoteCaRotation(INPUTS, options);
  assert.equal(promoted.tls.reason, "another CA signed the stored leaf");
  const newCa = env.ca();
  assert.equal(newCa.subject, next.subject);
  const rotatedLeaf = env.leaf();
  assert.ok(rotatedLeaf.checkIssued(newCa) && rotatedLeaf.verify(newCa.publicKey));
  const extension = (pem, name) => {
    const shown = spawnSync("openssl", ["x509", "-noout", "-ext", name], { input: pem, encoding: "utf8" });
    return /([0-9A-F]{2}(?::[0-9A-F]{2}){19})/i.exec(shown.stdout)?.[1];
  };
  assert.ok(extension(newCa.toString(), "subjectKeyIdentifier"));
  assert.equal(extension(rotatedLeaf.toString(), "authorityKeyIdentifier"), extension(newCa.toString(), "subjectKeyIdentifier"));
  const rotated = parsePemBundle(env.az.vault("stamp-kv").get(LEAF_SECRET));
  const second = https.createServer({ cert: rotated.cert, key: rotated.key }, (req, res) => res.end("ok"));
  await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
  t.after(() => second.close());
  const answer = await new Promise((resolve, reject) => {
    https.get({
      host: "127.0.0.1",
      port: second.address().port,
      ca: promoted.tls.caBundle,
      agent: false,
      checkServerIdentity: (_host, peer) => checkServerIdentity("10.20.15.250", peer),
    }, (res) => {
      res.resume();
      res.on("end", () => resolve("ok"));
    }).on("error", reject);
  });
  assert.equal(answer, "ok");
});
