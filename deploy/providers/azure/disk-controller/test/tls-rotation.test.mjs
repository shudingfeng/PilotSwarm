// The rotation of the controller's CA (tls.mjs): the trusted set each deploy
// hands the trust stores, start, promote and finish, their refusals, a run
// after an interruption at each of their writes, and TLS from either CA to a
// client that holds the two-CA bundle. The fakes answer openssl and the Azure
// CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";

import {
  CA_CERT_SECRET,
  CA_KEY_SECRET,
  LEAF_SECRET,
  NEXT_CA_CERT_SECRET,
  NEXT_CA_KEY_SECRET,
  PREVIOUS_CA_CERT_SECRET,
  caBundle,
  caClusterManifest,
  caRotationStatus,
  ensureDiskControllerTls,
  finishCaRotation,
  leafWrittenAt,
  parseCaCertificates,
  promoteCaRotation,
  readTrustedCas,
  startCaRotation,
} from "../tls.mjs";
import { parsePemBundle } from "../lib/serving-tls.mjs";
import { createFakeAz, createFakeOpenssl, createKey, createTestPki } from "./x509.mjs";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const DEPLOY_VAULT = "stamp-kv-deploy";
const STAMP_VAULT = "stamp-kv";
const INPUTS = Object.freeze({
  namespace: "pilotswarm",
  stampVaultName: STAMP_VAULT,
  stampVaultResourceId: "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/stamp-rg/providers/Microsoft.KeyVault/vaults/stamp-kv",
  deployVaultName: DEPLOY_VAULT,
  controllerPrincipalId: "66666666-6666-6666-6666-666666666666",
});
const DISPATCHER_DNS = "pilotswarm-disk-controller-dispatcher.pilotswarm.svc";
const WRITE = /^(?:write|disable|enable) /;

// One stamp's vaults, openssl and clock. `interrupt` stops the operation at
// its n-th vault write: "after" applies the write first, as a process that
// dies just after it; "fail" refuses it, as Key Vault would.
function setup(t, { start = START } = {}) {
  let clock = start;
  const now = () => clock;
  const tmpRoot = mkdtempSync(join(tmpdir(), "dc-tls-test-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const openssl = createFakeOpenssl({ now });
  const az = createFakeAz({ now });
  const logs = [];
  let interruption = null;
  let writes = 0;
  const runFn = (name, args) => {
    if (name === "openssl") return openssl.openssl(args);
    if (name !== "az") throw new Error(`unexpected command ${name}`);
    const isWrite = args[0] === "keyvault" && args[1] === "secret" && ["set", "set-attributes"].includes(args[2]);
    if (isWrite && interruption) {
      writes += 1;
      if (writes === interruption.at) {
        if (interruption.mode === "fail") return { status: 1, stdout: "", stderr: "ERROR: (ServiceUnavailable) try again later\n" };
        az.az(args);
        throw new Error(`interrupted after write ${writes}`);
      }
    }
    return az.az(args);
  };
  const options = (extra = {}) => ({ runFn, now, tmpRoot, log: (level, message) => logs.push({ level, message }), ...extra });
  return {
    az,
    openssl,
    logs,
    now,
    tmpRoot,
    runFn,
    advance(days) {
      clock += days * DAY;
    },
    interrupt(at, mode = "after") {
      interruption = { at, mode };
      writes = 0;
    },
    resume() {
      interruption = null;
    },
    deploy: () => ensureDiskControllerTls(INPUTS, options()),
    start: () => startCaRotation({ deployVaultName: DEPLOY_VAULT }, options()),
    promote: (extra) => promoteCaRotation(INPUTS, options(extra)),
    finish: (extra) => finishCaRotation({ deployVaultName: DEPLOY_VAULT, stampVaultName: STAMP_VAULT }, options(extra)),
    status: () => caRotationStatus({ deployVaultName: DEPLOY_VAULT }, { runFn, now }),
    secret: (name) => az.vault(DEPLOY_VAULT).get(name),
    enabled: (name) => az.vault(DEPLOY_VAULT).has(name) && !az.disabled(DEPLOY_VAULT).has(name),
    certificate: (name) => new X509Certificate(az.vault(DEPLOY_VAULT).get(name)),
    leaf: () => parsePemBundle(az.vault(STAMP_VAULT).get(LEAF_SECRET)).leaf,
    writes: () => az.events.filter((event) => WRITE.test(event)),
  };
}

const fingerprintOf = (pem) => new X509Certificate(pem).fingerprint256;
const keyMatches = (env, certificateName, keyName) => env.certificate(certificateName).checkPrivateKey(createPrivateKey(env.secret(keyName)));
const signedBy = (leaf, pem) => {
  const ca = new X509Certificate(pem);
  return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
};

// A stamp whose first CA (A) serves a leaf, with a rotation started (B).
function started(t) {
  const env = setup(t);
  const a = env.deploy().caPem;
  const b = env.start().next.pem;
  return { env, a, b };
}

test("a rotation hands the trust stores the current CA first, then the next one, then the previous one, and each new CA is named apart", (t) => {
  const env = setup(t);
  const first = env.deploy();
  const a = first.caPem;
  assert.deepEqual(first.trustedCas.map((ca) => ca.role), ["current"]);
  assert.equal(first.caBundle, a, "one CA: the bundle is that certificate, as before");
  assert.equal(env.status().phase, "none");

  env.az.events.length = 0;
  const started = env.start();
  assert.equal(started.created, true);
  assert.equal(started.next.subject, "CN=PilotSwarm disk controller CA 20260101");
  assert.notEqual(started.next.subject, env.certificate(CA_CERT_SECRET).subject);
  assert.equal(env.certificate(NEXT_CA_CERT_SECRET).ca, true);
  assert.ok(keyMatches(env, NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET));
  assert.deepEqual(env.az.events, [`list ${DEPLOY_VAULT}`, `read ${DEPLOY_VAULT}/${CA_CERT_SECRET}`,
    `write ${DEPLOY_VAULT}/${NEXT_CA_KEY_SECRET}`, `write ${DEPLOY_VAULT}/${NEXT_CA_CERT_SECRET}`], "no key is read");
  const b = started.next.pem;

  // Started: the next CA is trusted everywhere and signs nothing yet.
  env.az.events.length = 0;
  const during = env.deploy();
  assert.deepEqual(during.trustedCas.map((ca) => [ca.role, ca.pem]), [["current", a], ["next", b]]);
  assert.equal(during.caBundle, `${a.trim()}\n${b.trim()}\n`);
  assert.equal(during.leafRenewed, false);
  assert.ok(!env.az.events.some((event) => event.includes("-key")), "no key is read or written");
  assert.deepEqual(readTrustedCas({ deployVaultName: DEPLOY_VAULT }, { runFn: env.runFn, now: env.now }), {
    trustedCas: during.trustedCas, caBundle: during.caBundle,
  });
  assert.equal(env.status().phase, "started");

  // Promoted: the new CA signs the leaf at once; the former one stays trusted.
  const promoted = env.promote();
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.tls.reason, "another CA signed the stored leaf");
  assert.equal(env.secret(CA_CERT_SECRET), b);
  assert.ok(keyMatches(env, CA_CERT_SECRET, CA_KEY_SECRET));
  assert.equal(env.secret(PREVIOUS_CA_CERT_SECRET), a);
  assert.ok(!env.enabled(NEXT_CA_CERT_SECRET) && !env.enabled(NEXT_CA_KEY_SECRET), "the next CA is disabled, not deleted");
  assert.ok(env.az.vault(DEPLOY_VAULT).has(NEXT_CA_CERT_SECRET));
  assert.ok(signedBy(env.leaf(), b));
  const after = env.deploy();
  assert.deepEqual(after.trustedCas.map((ca) => [ca.role, ca.pem]), [["current", b], ["previous", a]]);
  assert.equal(env.status().phase, "promoted");

  // Finished: the previous CA is disabled, and the set is the new CA alone.
  assert.equal(env.finish().finished, true);
  assert.ok(!env.enabled(PREVIOUS_CA_CERT_SECRET));
  assert.deepEqual(env.deploy().trustedCas.map((ca) => [ca.role, ca.pem]), [["current", b]]);
  assert.equal(env.status().phase, "none");

  // A second rotation the same day still gets a name of its own, and writes
  // the retired names again as new, enabled versions.
  const again = env.start();
  assert.equal(again.next.subject, "CN=PilotSwarm disk controller CA 20260101-2");
  assert.ok(env.enabled(NEXT_CA_CERT_SECRET) && env.enabled(NEXT_CA_KEY_SECRET));
  env.advance(400);
  env.promote();
  assert.equal(env.secret(PREVIOUS_CA_CERT_SECRET), b);
  assert.equal(env.certificate(CA_CERT_SECRET).subject, "CN=PilotSwarm disk controller CA 20260101-2");
  assert.deepEqual(readdirSync(env.tmpRoot), [], "no key file stays behind");
});

test("start reports a next CA that exists, and refuses while the previous CA is still trusted or the vault has no CA", (t) => {
  const { env, b } = started(t);
  env.az.events.length = 0;
  assert.deepEqual(env.start(), { created: false, next: env.status().next });
  assert.equal(env.status().next.pem, b);
  assert.deepEqual(env.writes(), [], "nothing changes");

  env.promote();
  assert.throws(() => env.start(), /still trusts the previous CA \(disk-controller-ca-cert-previous\): finish the last rotation first/);
  env.finish();
  assert.equal(env.start().created, true, "once finished, a new rotation starts");

  const empty = setup(t);
  assert.throws(() => empty.start(), /holds no disk-controller-ca-cert yet/);
  // A next certificate whose key is gone cannot be promoted: start says so.
  const keyless = started(t).env;
  keyless.az.disabled(DEPLOY_VAULT).add(NEXT_CA_KEY_SECRET);
  assert.throws(() => keyless.start(), /holds disk-controller-ca-cert-next without disk-controller-ca-key-next/);
});

test("a rotation abandoned before promote, by disabling the next certificate and key, leaves the current CA alone, and start makes another", (t) => {
  const { env, a, b } = started(t);
  for (const name of [NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET]) {
    env.runFn("az", ["keyvault", "secret", "set-attributes", "--vault-name", DEPLOY_VAULT, "--name", name, "--enabled", "false"]);
  }
  assert.equal(env.status().phase, "none");
  const deployed = env.deploy();
  assert.deepEqual(deployed.trustedCas.map((ca) => [ca.role, ca.pem]), [["current", a]]);
  assert.equal(deployed.caBundle, a);
  const again = env.start();
  assert.equal(again.created, true);
  assert.notEqual(again.next.pem, b);
  assert.ok(env.enabled(NEXT_CA_CERT_SECRET) && keyMatches(env, NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET));
  assert.deepEqual(env.deploy().trustedCas.map((ca) => [ca.role, ca.pem]), [["current", a], ["next", again.next.pem]]);
});

test("promote checks the next CA's key before its first write: a disabled, missing, unreadable or foreign key leaves the vault as it was", (t) => {
  for (const [label, spoil, message] of [
    ["disabled", (env) => env.az.disabled(DEPLOY_VAULT).add(NEXT_CA_KEY_SECRET),
      /disk-controller-ca-key-next in vault stamp-kv-deploy is disabled: enable its latest version again, or disable disk-controller-ca-cert-next too and start the rotation again/],
    ["missing", (env) => env.az.vault(DEPLOY_VAULT).delete(NEXT_CA_KEY_SECRET),
      /holds disk-controller-ca-cert-next without disk-controller-ca-key-next: disable disk-controller-ca-cert-next, then start the rotation again/],
    ["unreadable", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_KEY_SECRET, "not a key\n"),
      /disk-controller-ca-key-next in vault stamp-kv-deploy is not a private key: disable both, then start the rotation again/],
    ["another CA's", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_KEY_SECRET, createKey().privateKeyPem),
      /disk-controller-ca-key-next does not belong to disk-controller-ca-cert-next in vault stamp-kv-deploy: disable both, then start the rotation again/],
  ]) {
    const { env, a, b } = started(t);
    spoil(env);
    const before = env.az.snapshot();
    env.az.events.length = 0;
    assert.throws(() => env.promote(), message, label);
    assert.deepEqual(env.writes(), [], `${label}: nothing written`);
    assert.deepEqual(env.az.snapshot(), before, `${label}: the vault is as it was`);
    // Nothing waits on a promote: the deploys still trust both CAs, and the
    // rotation can be given up and started again.
    assert.deepEqual(env.deploy().trustedCas.map((ca) => [ca.role, ca.pem]), [["current", a], ["next", b]], label);
    env.az.disabled(DEPLOY_VAULT).add(NEXT_CA_CERT_SECRET);
    assert.equal(env.start().created, true, label);
    assert.equal(env.promote().promoted, true, label);
  }
});

test("promote refuses a next CA too near its end to sign a leaf, with nothing written, and a new one starts in its place", (t) => {
  for (const [days, message] of [
    [1800, /disk-controller-ca-cert-next in vault stamp-kv-deploy expires on .*, too soon to sign a leaf: disable disk-controller-ca-cert-next and disk-controller-ca-key-next, then start the rotation again/],
    [1830, /disk-controller-ca-cert-next in vault stamp-kv-deploy expired on .*, too soon to sign a leaf/],
  ]) {
    const { env, a } = started(t);
    env.advance(days);
    const before = env.az.snapshot();
    assert.throws(() => env.promote(), message, `${days} days`);
    assert.deepEqual(env.az.snapshot(), before, `${days} days: nothing written`);
    for (const name of [NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET]) env.az.disabled(DEPLOY_VAULT).add(name);
    const fresh = env.start().next.pem;
    assert.equal(env.promote({ check: () => [{ name: "vms", detail: "lacks it" }], force: true }).promoted, true, `${days} days`);
    assert.ok(signedBy(env.leaf(), fresh), `${days} days`);
    assert.equal(env.secret(PREVIOUS_CA_CERT_SECRET), a, `${days} days`);
  }
});

test("a promote after the current CA has expired completes: the deploys leave the expired CA out, with a warning, and finish is clean", (t) => {
  const env = setup(t);
  const a = env.deploy().caPem;
  env.advance(1820);
  const b = env.start().next.pem;
  env.advance(10); // the first CA expired 4 days ago
  const lacking = () => [{ name: "vms", detail: "psstamp-win-workers_1 lacks the next CA" }];
  const promoted = env.promote({ check: lacking, force: true });
  assert.equal(promoted.promoted, true);
  assert.ok(signedBy(env.leaf(), b), "the new CA signed the leaf");
  assert.deepEqual(promoted.tls.trustedCas.map((ca) => [ca.role, ca.pem]), [["current", b]], "an expired CA anchors nothing");
  assert.ok(env.logs.some((l) => l.level === "warn" && /disk-controller-ca-cert-previous in vault stamp-kv-deploy expired on .*: the trust stores no longer get it/.test(l.message)));
  assert.deepEqual(env.deploy().trustedCas.map((ca) => [ca.role, ca.pem]), [["current", b]]);
  assert.deepEqual(readTrustedCas({ deployVaultName: DEPLOY_VAULT }, { runFn: env.runFn, now: env.now, log: () => {} }).trustedCas.map((ca) => ca.pem), [b]);
  assert.deepEqual([env.status().phase, env.status().problem], ["promoted", null]);
  // Promote again changes nothing, and finish is clean, without --force.
  env.az.events.length = 0;
  assert.equal(env.promote().promoted, false);
  assert.deepEqual(env.writes(), []);
  const finished = env.finish();
  assert.deepEqual([finished.finished, finished.forced], [true, false]);
  assert.equal(env.secret(PREVIOUS_CA_CERT_SECRET), a);
  assert.ok(!env.enabled(PREVIOUS_CA_CERT_SECRET));
  assert.deepEqual(env.deploy().trustedCas.map((ca) => ca.pem), [b]);
  assert.equal(env.status().phase, "none");
});

test("promote and finish refuse out of order, on a failed precondition unless forced, and before the new leaf is stored", (t) => {
  const idle = setup(t);
  idle.deploy();
  assert.throws(() => idle.promote(), /No rotation of the controller's CA has started/);
  assert.deepEqual(idle.finish(), { finished: false, previous: null, forced: false, failures: [] });

  const { env, a, b } = started(t);
  assert.throws(() => env.finish(), /The next CA is not promoted yet/);
  const seen = [];
  const failing = ({ next, caBundle: bundle }) => {
    seen.push({ next: next.pem, bundle });
    return [{ name: "vms", detail: "psstamp-win-workers_1 lacks the next CA" }];
  };
  env.az.events.length = 0;
  assert.throws(() => env.promote({ check: failing }), (error) => {
    assert.match(error.message, /Not promoting the next CA:\n {2}- vms: psstamp-win-workers_1 lacks the next CA\n.*--force promotes anyway/s);
    return true;
  });
  assert.deepEqual(seen, [{ next: b, bundle: `${a.trim()}\n${b.trim()}\n` }], "the checks see the next CA and the bundle the stores hold");
  assert.deepEqual(env.writes(), [], "a refused promote writes nothing");
  assert.equal(env.secret(CA_CERT_SECRET), a);

  const forced = env.promote({ check: failing, force: true });
  assert.equal(forced.forced, true);
  assert.ok(env.logs.some((l) => l.level === "warn" && /PROMOTING WITH --force/.test(l.message) && /lacks the next CA/.test(l.message)));
  assert.equal(env.secret(CA_CERT_SECRET), b);

  // The stored leaf must be the new CA's before the old one goes.
  const newLeaf = env.az.vault(STAMP_VAULT).get(LEAF_SECRET);
  const oldLeaf = createTestPki({ caName: "Other CA" }).issueLeaf().bundle;
  env.az.vault(STAMP_VAULT).set(LEAF_SECRET, oldLeaf);
  assert.throws(() => env.finish(), /disk-controller-tls in vault stamp-kv is not the current CA's leaf yet: run promote again/);
  env.az.vault(STAMP_VAULT).set(LEAF_SECRET, newLeaf);
  const stale = () => [{ name: "controller", detail: "its pod started before the leaf was written" }];
  assert.throws(() => env.finish({ check: stale }), /Not finishing the rotation:\n {2}- controller: its pod started before the leaf was written/);
  assert.ok(env.enabled(PREVIOUS_CA_CERT_SECRET));
  assert.equal(env.finish({ check: stale, force: true }).forced, true);
  assert.ok(env.logs.some((l) => l.level === "warn" && /FINISHING WITH --force/.test(l.message)));
  assert.ok(!env.enabled(PREVIOUS_CA_CERT_SECRET));
});

test("each start can stop at any of its writes, and running it again converges", (t) => {
  for (const mode of ["after", "fail"]) {
    for (const at of [1, 2]) {
      const env = setup(t);
      env.deploy();
      env.interrupt(at, mode);
      assert.throws(() => env.start(), mode === "after" ? /interrupted after write/ : /Could not write secret/, `${mode} ${at}`);
      env.resume();
      // A deploy in between trusts only a next CA that is whole.
      const between = env.deploy().trustedCas.map((ca) => ca.role);
      assert.deepEqual(between, mode === "after" && at === 2 ? ["current", "next"] : ["current"], `${mode} ${at}`);
      const again = env.start();
      assert.equal(again.created, !(mode === "after" && at === 2), `${mode} ${at}`);
      assert.ok(keyMatches(env, NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET), `${mode} ${at}: the next key is the certificate's`);
      assert.deepEqual(env.deploy().trustedCas.map((ca) => ca.role), ["current", "next"]);
    }
  }
});

test("each promote can stop at any of its writes; a deploy in between refuses or keeps the leaf's CA trusted, and promote again converges", (t) => {
  // previous, current key, current certificate, next key, next certificate, leaf.
  const WRITES = 6;
  for (const mode of ["after", "fail"]) {
    for (let at = 1; at <= WRITES; at++) {
      const label = `${mode} at write ${at}`;
      const { env, a, b } = started(t);
      env.interrupt(at, mode);
      assert.throws(() => env.promote(), mode === "after" ? /interrupted after write/ : /Could not (?:write|disable) secret/, label);
      env.resume();

      // A deploy now either refuses, until promote finishes, or trusts the CA
      // that signed the stored leaf. It runs on a copy: the run below must
      // converge from the interrupted state itself.
      const leafCa = signedBy(env.leaf(), a) ? a : b;
      const saved = env.az.snapshot();
      let between = null;
      try {
        between = ensureDiskControllerTls(INPUTS, { runFn: env.runFn, now: env.now, tmpRoot: env.tmpRoot, log: () => {} });
      } catch (error) {
        assert.match(error.message, /a promote of the controller's CA stopped before it ended\. Run `npm run deploy:rotate-ca -- <env> promote` again/, label);
      }
      env.az.restore(saved);
      if (between) {
        const pems = between.trustedCas.map((ca) => ca.pem);
        assert.ok(pems.includes(leafCa), `${label}: the stores keep the CA that signed the served leaf`);
        assert.ok(pems.length <= 2, label);
      }

      const again = env.promote();
      assert.ok(again.promoted || again.resumed, label);
      assert.equal(env.secret(CA_CERT_SECRET), b, `${label}: the next CA is current`);
      assert.ok(keyMatches(env, CA_CERT_SECRET, CA_KEY_SECRET), `${label}: with its own key`);
      assert.equal(env.secret(PREVIOUS_CA_CERT_SECRET), a, `${label}: the former CA, never the new one, is previous`);
      assert.ok(env.enabled(PREVIOUS_CA_CERT_SECRET), label);
      assert.ok(!env.enabled(NEXT_CA_CERT_SECRET) && !env.enabled(NEXT_CA_KEY_SECRET), label);
      assert.ok(signedBy(env.leaf(), b), `${label}: the leaf is the new CA's`);
      assert.deepEqual(env.deploy().trustedCas.map((ca) => [ca.role, ca.pem]), [["current", b], ["previous", a]], label);
      // And once more changes nothing.
      env.az.events.length = 0;
      assert.equal(env.promote().promoted, false, label);
      assert.deepEqual(env.writes(), [], label);
    }
  }
});

test("finish can stop at its write, and running it again converges", (t) => {
  for (const mode of ["after", "fail"]) {
    const { env, b } = started(t);
    env.promote();
    env.interrupt(1, mode);
    assert.throws(() => env.finish(), mode === "after" ? /interrupted after write/ : /Could not disable secret/, mode);
    env.resume();
    const again = env.finish();
    assert.equal(again.finished, mode === "fail", mode);
    assert.ok(!env.enabled(PREVIOUS_CA_CERT_SECRET), mode);
    assert.deepEqual(env.deploy().trustedCas.map((ca) => ca.pem), [b], mode);
  }
});

test("the trusted set holds CAs only, unexpired and different from the current one, and never two besides it", (t) => {
  const pki = createTestPki({ caName: "Another CA" });
  const cases = [
    ["a leaf as the next CA", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, pki.issueLeaf().pem), /disk-controller-ca-cert-next in vault stamp-kv-deploy: certificate 1 is not a CA certificate/],
    ["two certificates in one secret", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, `${pki.caPem}${pki.caPem}`), /must hold 1 PEM CA certificate, not 2/],
    ["text after the certificate", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, `${pki.caPem}trailing words\n`), /holds something other than PEM certificates/],
    ["the current CA as the next one", (env) => env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, env.secret(CA_CERT_SECRET)), /disk-controller-ca-cert-next in vault stamp-kv-deploy holds the current CA itself/],
    ["a next and a previous CA", (env) => {
      env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, pki.caPem);
      env.az.vault(DEPLOY_VAULT).set(PREVIOUS_CA_CERT_SECRET, createTestPki({ caName: "Third CA" }).caPem);
    }, /holds both disk-controller-ca-cert-next and disk-controller-ca-cert-previous/],
    ["an expired next CA", (env) => {
      env.advance(-3000);
      const old = createTestPki({ now: env.now(), caName: "Old CA" });
      env.advance(3000);
      env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, old.caPem);
    }, /disk-controller-ca-cert-next in vault stamp-kv-deploy expired on .*; disable disk-controller-ca-cert-next and disk-controller-ca-key-next and start the rotation again/],
  ];
  for (const [label, change, message] of cases) {
    const env = setup(t);
    env.deploy();
    change(env);
    assert.throws(() => env.deploy(), message, label);
    assert.throws(() => readTrustedCas({ deployVaultName: DEPLOY_VAULT }, { runFn: env.runFn, now: env.now }), message, label);
    assert.match(env.status().problem, message, label);
  }

  // An expired previous CA anchors no chain: it is left out, with a warning,
  // and finish still retires it.
  const expired = setup(t);
  const current = expired.deploy().caPem;
  expired.advance(-3000);
  const old = createTestPki({ now: expired.now(), caName: "Old CA" });
  expired.advance(3000);
  expired.az.vault(DEPLOY_VAULT).set(PREVIOUS_CA_CERT_SECRET, old.caPem);
  assert.deepEqual(expired.deploy().trustedCas.map((ca) => ca.pem), [current]);
  assert.ok(expired.logs.some((l) => l.level === "warn" && /disk-controller-ca-cert-previous in vault stamp-kv-deploy expired on .*: the trust stores no longer get it/.test(l.message)));
  const warnings = [];
  assert.deepEqual(readTrustedCas({ deployVaultName: DEPLOY_VAULT }, { runFn: expired.runFn, now: expired.now, log: (level) => warnings.push(level) })
    .trustedCas.map((ca) => ca.pem), [current]);
  assert.deepEqual(warnings, ["warn"]);
  assert.deepEqual([expired.status().phase, expired.status().problem], ["promoted", null]);
  assert.equal(expired.finish().finished, true);

  // A disabled next or previous CA counts as absent; a disabled current one stops the step.
  const env = setup(t);
  const a = env.deploy().caPem;
  env.az.vault(DEPLOY_VAULT).set(NEXT_CA_CERT_SECRET, pki.caPem);
  env.az.disabled(DEPLOY_VAULT).add(NEXT_CA_CERT_SECRET);
  assert.deepEqual(env.deploy().trustedCas.map((ca) => ca.pem), [a]);
  env.az.disabled(DEPLOY_VAULT).add(CA_CERT_SECRET);
  assert.throws(() => env.deploy(), /disk-controller-ca-cert in vault stamp-kv-deploy is disabled; enable its latest version again/);
});

test("during a rotation, a leaf that still serves stays when the current CA is too near its end to sign another", (t) => {
  const env = setup(t);
  env.deploy();
  env.advance(1626);
  env.deploy(); // a leaf for the CA's last 199 days
  env.advance(150); // 50 days left on the CA, 49 on the leaf
  assert.throws(() => env.deploy(), /CA expires in 50 days, too soon to sign a leaf; rotate the CA first/);
  env.start();
  const during = env.deploy();
  assert.equal(during.leafRenewed, false);
  assert.deepEqual(during.trustedCas.map((ca) => ca.role), ["current", "next"], "the deploy still carries the next CA");
  assert.ok(env.logs.some((l) => l.level === "warn" && /the leaf expires in 49 days, and the current CA is too near its end to sign another; promote the next CA/.test(l.message)));
  env.promote();
  assert.equal(Math.round((Date.parse(env.leaf().validTo) - env.now()) / DAY), 365, "the new CA signs a full year");
  // An expired leaf cannot wait for the promote: the deploy points to it, and
  // a promote, forced while a trust store still lacks the next CA, is the way
  // out, though the first CA has reached its end by then.
  const late = setup(t);
  late.deploy();
  late.advance(1626);
  late.deploy();
  late.start();
  late.advance(200);
  assert.throws(() => late.deploy(), new RegExp("too soon to sign a leaf, and the stored leaf no longer serves: promote the next CA now " +
    "\\(`npm run deploy:rotate-ca -- <env> promote`, with --force while a trust store still lacks it\\)"));
  late.promote({ check: () => [{ name: "vms", detail: "lacks it" }], force: true });
  assert.deepEqual(late.deploy().trustedCas.map((ca) => ca.role), ["current"]);
});

test("the status shows certificates only, never a key, and leafWrittenAt reads the leaf's versions without their value", (t) => {
  const { env, a, b } = started(t);
  env.az.events.length = 0;
  const status = env.status();
  assert.equal(status.phase, "started");
  assert.equal(status.nextKey, true);
  assert.deepEqual([status.current.pem, status.next.pem, status.previous], [a, b, null]);
  assert.match(status.next.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(status.next.fingerprint, fingerprintOf(b).replace(/:/g, "").toLowerCase());
  assert.equal(status.caBundle, caBundle([a, b]));
  assert.ok(!env.az.events.some((event) => /-key/.test(event)), "no key is read");
  assert.ok(!JSON.stringify(status).includes("PRIVATE"), "no key in the answer");

  const written = leafWrittenAt({ stampVaultName: STAMP_VAULT }, { runFn: env.runFn });
  assert.equal(written, START);
  assert.deepEqual(env.az.events.slice(-1), [`versions ${STAMP_VAULT}/${LEAF_SECRET}`]);
  assert.equal(leafWrittenAt({ stampVaultName: "empty-kv" }, { runFn: () => ({ status: 0, stdout: "[]", stderr: "" }) }), null);
});

test("a cluster bundle and a parsed bundle take one or two CA certificates and nothing else", () => {
  const a = createTestPki({ caName: "First CA" });
  const b = createTestPki({ caName: "Second CA" });
  const two = caBundle([a.caPem, b.caPem]);
  assert.equal(parseCaCertificates(two).length, 2);
  const manifest = caClusterManifest({ namespace: "pilotswarm", caPem: two });
  assert.equal(Buffer.from(/^ {2}ca\.crt: (\S+)$/m.exec(manifest)[1], "base64").toString(), two);
  for (const [bundle, message] of [
    [caBundle([a.caPem, b.caPem, createTestPki({ caName: "Third CA" }).caPem]), /must hold 1 to 2 PEM CA certificates, not 3/],
    [caBundle([a.caPem, a.issueLeaf().pem]), /certificate 2 is not a CA certificate/],
    [`${two}not a certificate\n`, /holds something other than PEM certificates/],
    [two.replace(/^MII/m, "MII!"), /holds something other than PEM certificates/],
    ["", /must hold 1 to 2 PEM CA certificates, not 0/],
  ]) {
    assert.throws(() => parseCaCertificates(bundle), message);
    assert.throws(() => caClusterManifest({ namespace: "pilotswarm", caPem: bundle }), message);
  }
});

// ── TLS from either CA ──────────────────────────────────────────────

async function serve(t, bundlePem) {
  const { cert, key } = parsePemBundle(bundlePem);
  const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return server.address().port;
}

function get(port, ca) {
  return new Promise((resolve) => {
    https.get({
      host: "127.0.0.1",
      port,
      ca,
      agent: false,
      checkServerIdentity: (_host, peer) => checkServerIdentity("10.20.15.250", peer),
    }, (res) => {
      res.resume();
      res.on("end", () => resolve("ok"));
    }).on("error", (error) => resolve(error.code ?? error.message));
  });
}

// A new Node process that trusts the bundle file only through
// NODE_EXTRA_CA_CERTS, as the workers and the coordination host do.
function getWithExtraCaCerts(port, caFile) {
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: caFile };
  for (const name of ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_TEST_CONTEXT", "NODE_OPTIONS"]) delete env[name];
  const script = [
    "import https from 'node:https';",
    "import { checkServerIdentity } from 'node:tls';",
    `https.get({ host: '127.0.0.1', port: ${port}, agent: false, checkServerIdentity: (_h, peer) => checkServerIdentity('10.20.15.250', peer) },`,
    "  (res) => { res.resume(); res.on('end', () => console.log('ok')); }).on('error', (error) => console.log(error.code ?? error.message));",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

test("with the two-CA bundle, a client accepts the controller's leaf from the old CA before promote and from the new one after it", { timeout: 60_000 }, async (t) => {
  const env = setup(t, { start: Date.now() });
  const a = env.deploy().caPem;
  env.start();
  const bundle = env.deploy().caBundle;
  const before = await serve(t, env.az.vault(STAMP_VAULT).get(LEAF_SECRET));
  env.promote();
  assert.equal(env.deploy().caBundle, caBundle([env.secret(CA_CERT_SECRET), a]), "after promote, the same two CAs, the new one first");
  const after = await serve(t, env.az.vault(STAMP_VAULT).get(LEAF_SECRET));
  const stranger = createTestPki({ names: ["IP:10.20.15.250", `DNS:${DISPATCHER_DNS}`], commonName: DISPATCHER_DNS, caName: "Stranger CA" });
  const other = await serve(t, stranger.issueLeaf().bundle);

  assert.equal(await get(before, bundle), "ok", "the old CA's leaf");
  assert.equal(await get(after, bundle), "ok", "the new CA's leaf");
  assert.match(await get(other, bundle), /CERT|VERIFY|SIGNATURE|ISSUER/, "no other CA's leaf");
  assert.match(await get(after, a), /CERT|VERIFY|SIGNATURE|ISSUER/, "the old CA alone refuses the new leaf");

  const dir = mkdtempSync(join(tmpdir(), "dc-tls-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caFile = join(dir, "ca.crt");
  writeFileSync(caFile, bundle);
  assert.equal(await getWithExtraCaCerts(before, caFile), "ok");
  assert.equal(await getWithExtraCaCerts(after, caFile), "ok");
  assert.match(await getWithExtraCaCerts(other, caFile), /CERT|VERIFY|SIGNATURE|ISSUER/);
});
