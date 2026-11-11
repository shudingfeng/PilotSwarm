// The CA rotation's command (deploy/scripts/rotate-ca.mjs) and its checks
// (deploy/providers/azure/deploy-steps/ca-rotation.mjs): promote's
// preconditions on every trust store, the controller's restart after promote,
// finish's condition, the cleanup of App Gateway's stale roots, and the
// command end to end with an Azure CLI, kubectl and openssl on PATH that the
// test answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, parseEnvFile, templateEnvPath } from "../lib/common.mjs";
import { AKS_ENV_DEFAULTS } from "../lib/aks-env.mjs";
import { caBundleHash } from "../lib/coordination-host.mjs";
import { parseRotateArgs } from "../rotate-ca.mjs";
import {
  CONTROLLER_DEPLOYMENT,
  formatCaRotation,
  readGatewayTrust,
  rolloutWaiting,
  runCaRotation,
  workersLackingCa,
} from "../../providers/azure/deploy-steps/ca-rotation.mjs";
import { controllerTlsInputs, trustedRootName, winWorkerResourceNames } from "../../providers/azure/deploy-steps/win-workers.mjs";
import {
  CA_CERT_SECRET,
  NEXT_CA_CERT_SECRET,
  NEXT_CA_KEY_SECRET,
  PREVIOUS_CA_CERT_SECRET,
  caFingerprint,
  ensureDiskControllerTls,
} from "../../providers/azure/disk-controller/tls.mjs";
import { createFakeAppGateway, createFakeAz, createFakeOpenssl, createTestPki } from "../../providers/azure/disk-controller/test/x509.mjs";

const START = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000003";
const CONTROLLER_OID = "55555555-5555-5555-5555-555555555555";
const PREFIX = "pilotswarm-disk-controller-ca";
const DISPATCHER_HOST = "pilotswarm-disk-controller-dispatcher.pilotswarm.svc";
const ENV = Object.freeze({
  WIN_WORKERS_ENABLED: "true",
  WIN_WORKER_COORDINATION_HOST: "true",
  SUBSCRIPTION_ID: SUBSCRIPTION,
  RESOURCE_GROUP: "stamp-rg",
  RESOURCE_PREFIX: "psstamp",
  NAMESPACE: "pilotswarm",
  EDGE_MODE: "afd",
  DISK_CONTROLLER_IDENTITY_PRINCIPAL_ID: CONTROLLER_OID,
});
const NAMES = winWorkerResourceNames(ENV);
const VMS = ["psstamp-win-workers_1", "psstamp-win-workers_2"].map((name) => `${NAMES.resourceGroupId}/providers/Microsoft.Compute/virtualMachines/${name}`);
const option = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const ok = (value) => ({ status: 0, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" });
const notFound = (what) => ({ status: 3, stdout: "", stderr: `ERROR: (ResourceNotFound) The Resource '${what}' was not found.` });
const base64 = (text) => Buffer.from(text).toString("base64");
const derOf = (pem) => pem.replace(/-----[^-]+-----|\s/g, "");

// A stamp: its vaults and openssl (the TLS step's fakes), the scale set and
// its VMs, App Gateway, the cluster's CA objects, the coordination host and
// the controller's pods. `ship()` does what the deploys do with a trusted set;
// each part can be left behind.
function fakeStamp(t) {
  let clock = START;
  const now = () => clock;
  const tmpRoot = mkdtempSync(join(tmpdir(), "ps-rotate-ca-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const az = createFakeAz({ now });
  const openssl = createFakeOpenssl({ now });
  const gateway = createFakeAppGateway({
    name: NAMES.applicationGatewayName,
    settings: [{ name: "bp-pilotswarm-dispatcher-3004", hostName: DISPATCHER_HOST, roots: [] }, { name: "bp-pilotswarm-portal-3001", hostName: "portal.example.com", roots: [] }],
  });
  const state = {
    model: null,
    vms: new Map(VMS.map((id) => [id, null])),
    roots: gateway.state.roots,
    settings: gateway.state.settings,
    secret: null,
    configMap: null,
    host: { annotation: undefined, generation: 3, observedGeneration: 3, replicas: 2, updatedReplicas: 2, availableReplicas: 2, total: 2 },
    pods: [{ name: "pilotswarm-disk-controller-old", startTime: new Date(START - 60_000).toISOString() }],
    restarts: 0,
  };
  const calls = [];
  const runFn = (name, args, opts = {}) => {
    calls.push({ name, args, env: opts.env });
    const is = (...words) => words.every((word, i) => args[i] === word);
    if (name === "openssl") return openssl.openssl(args);
    if (name === "kubectl") {
      if (is("get", "secret")) return state.secret === null ? { status: 1, stdout: "", stderr: 'Error from server (NotFound): secrets "pilotswarm-disk-controller-ca" not found' } : ok({ data: { "ca.crt": base64(state.secret) } });
      if (is("get", "configmap")) return state.configMap === null ? { status: 1, stdout: "", stderr: "Error from server (NotFound): not found" } : ok({ data: { "ca.crt": state.configMap } });
      if (is("get", "deployment")) {
        const h = state.host;
        return ok({
          metadata: { generation: h.generation },
          spec: { replicas: h.replicas, template: { metadata: { annotations: { "pilotswarm.dev/spc-keys-hash": "x", ...(h.annotation ? { "pilotswarm.dev/disk-controller-ca-sha256": h.annotation } : {}) } } } },
          status: { observedGeneration: h.observedGeneration, replicas: h.total, updatedReplicas: h.updatedReplicas, availableReplicas: h.availableReplicas },
        });
      }
      if (is("get", "pods")) return ok({ items: state.pods.map((pod) => ({ metadata: { name: pod.name }, status: { startTime: pod.startTime } })) });
      if (is("rollout", "restart")) {
        state.restarts += 1;
        state.pods = [{ name: `pilotswarm-disk-controller-new${state.restarts}`, startTime: new Date(clock + 30_000).toISOString() }];
        return ok();
      }
      if (is("rollout", "status") || is("apply")) return ok();
      return { status: 9, stdout: "", stderr: `unexpected kubectl ${args.join(" ")}` };
    }
    if (is("aks", "get-credentials")) return ok();
    if (is("vmss", "show")) return state.model === undefined ? notFound("virtualMachineScaleSets/psstamp-win-workers") : ok({ name: NAMES.scaleSetName, virtualMachineProfile: { userData: state.model } });
    if (is("vm", "list")) return ok([...state.vms.keys()]);
    if (is("vm", "show")) {
      const id = option(args, "--ids");
      return state.vms.has(id) ? ok(state.vms.get(id)) : notFound(id);
    }
    const answer = gateway.az(args);
    if (answer) return answer;
    return az.az(args);
  };
  const userData = (bundle) => base64(JSON.stringify({ version: 1, env: {}, controllerCaCert: bundle }));
  const env = { ...ENV };
  return {
    az,
    gateway,
    state,
    calls,
    runFn,
    env,
    advance(ms) {
      clock += ms;
    },
    run(operation, extra = {}) {
      return runCaRotation({ env, operation, stagingDir: tmpRoot, ...extra }, { runFn, now, tmpRoot, log: () => {} });
    },
    deployTls() {
      return ensureDiskControllerTls(controllerTlsInputs(env), { runFn, now, tmpRoot, log: () => {} });
    },
    // What the deploys of base-infra, disk-controller and worker do with the
    // trusted set, and what the controller and AGIC then do. As the deploy
    // step does (win-workers.mjs, ensureTrustedRoots), a CA on a root keeps
    // it, and only a CA on none gets a root named after it. The host's pod
    // template carries the bundle's hash only while two CAs are trusted.
    ship({ vms = true, skipVms = [], agic = true } = {}) {
      const { trustedCas, caBundle } = this.deployTls();
      if (vms) {
        state.model = userData(caBundle);
        for (const id of state.vms.keys()) if (!skipVms.some((name) => id.endsWith(name))) state.vms.set(id, userData(caBundle));
      }
      const rootNames = trustedCas.map((ca) => {
        const holder = gateway.holderOf(ca.pem);
        if (holder) return holder;
        state.roots.set(trustedRootName(PREFIX, ca), base64(ca.pem));
        return trustedRootName(PREFIX, ca);
      });
      if (agic) state.settings[0].roots = rootNames;
      state.secret = caBundle;
      state.configMap = caBundle;
      const annotation = trustedCas.length > 1 ? caBundleHash(caBundle) : undefined;
      if (annotation !== state.host.annotation) {
        state.host = { ...state.host, annotation, generation: state.host.generation + 1, observedGeneration: state.host.generation + 1 };
      }
      return { trustedCas, caBundle, rootNames };
    },
    secret: (name) => az.vault(NAMES.deployKeyVaultName).get(name),
    enabled: (name) => az.vault(NAMES.deployKeyVaultName).has(name) && !az.disabled(NAMES.deployKeyVaultName).has(name),
  };
}

const failing = (report) => report.checks.filter((check) => !check.ok).map((check) => check.name);

test("status and promote check every trust store for the next CA, and promote refuses until each holds", (t) => {
  const stamp = fakeStamp(t);
  stamp.ship();
  const started = stamp.run("start");
  assert.equal(started.created, true);

  // Before any deploy, no store holds the next CA.
  const before = stamp.run("status");
  assert.equal(before.phase, "started");
  assert.deepEqual(failing(before), ["vms", "appgw", "cluster", "host"]);
  assert.match(before.checks[0].detail, /^the scale set model psstamp-win-workers, psstamp-win-workers_1, psstamp-win-workers_2 lack the next CA/);
  assert.match(before.checks[1].detail, /no trusted root holds the next CA yet/);
  assert.match(before.checks[2].detail, /the Secret pilotswarm-disk-controller-ca and the ConfigMap pilotswarm-disk-controller-ca in namespace pilotswarm lack the next CA/);
  assert.match(before.checks[3].detail, /has no pilotswarm\.dev\/disk-controller-ca-sha256: deploy the worker service/);
  assert.throws(() => stamp.run("promote"), /Not promoting the next CA:\n {2}- vms: .*\n {2}- appgw: .*\n {2}- cluster: .*\n {2}- host: /);
  assert.ok(stamp.enabled(NEXT_CA_CERT_SECRET) && stamp.enabled(NEXT_CA_KEY_SECRET), "a refused promote writes nothing");
  assert.ok(!stamp.az.vault(NAMES.deployKeyVaultName).has(PREVIOUS_CA_CERT_SECRET));

  // The deploys ship the bundle, but a standby VM is not replaced yet and AGIC
  // has not applied the Ingress: its setting still names the old root only.
  stamp.ship({ skipVms: ["_2"], agic: false });
  const partway = stamp.run("status");
  assert.deepEqual(failing(partway), ["vms", "appgw"]);
  assert.match(partway.checks[0].detail, /^psstamp-win-workers_2 lacks the next CA/);
  assert.match(partway.checks[1].detail, /backend settings bp-pilotswarm-dispatcher-3004 do not name the next CA's root yet/);

  // The host's rollout with the new bundle has not finished.
  stamp.ship();
  stamp.state.host.updatedReplicas = 1;
  const rolling = stamp.run("status");
  assert.deepEqual(failing(rolling), ["host"]);
  assert.match(rolling.checks.at(-1).detail, /its rollout with the rotation's CA bundle has not finished: 1 of 2 pods run the new template/);
  stamp.state.host.updatedReplicas = 2;

  const ready = stamp.run("status");
  assert.deepEqual(failing(ready), []);
  assert.equal(ready.checks[0].detail, "the scale set model and its 2 VM(s) hold it");
  assert.match(formatCaRotation(ready, "mystamp").at(-1), /every check holds; `npm run deploy:rotate-ca -- mystamp promote`/);

  // Promote: the new CA is current, its leaf at once, and the controller,
  // whose pod predates the leaf, restarts to serve it.
  stamp.advance(60_000);
  const promoted = stamp.run("promote");
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.restarted, true);
  assert.equal(stamp.state.restarts, 1);
  const kube = stamp.calls.filter(({ name }) => name === "kubectl").map(({ args }) => args.slice(0, 3).join(" "));
  assert.deepEqual(kube.slice(-2), [`rollout restart deployment/${CONTROLLER_DEPLOYMENT}`, `rollout status deployment/${CONTROLLER_DEPLOYMENT}`]);
  assert.ok(stamp.calls.filter(({ name }) => name === "kubectl").every(({ env }) => env?.KUBECONFIG?.endsWith("kubeconfig")), "kubectl uses the stamp's kubeconfig");
  assert.equal(promoted.current.fingerprint, started.next.fingerprint);
  assert.equal(caFingerprint(new X509Certificate(stamp.secret(CA_CERT_SECRET))), started.next.fingerprint);
  // Once more: nothing to promote, and no second restart.
  assert.equal(stamp.run("promote").restarted, false);
  assert.equal(stamp.state.restarts, 1);
});

test("finish waits until no controller pod predates the new leaf; --force finishes anyway", (t) => {
  const stamp = fakeStamp(t);
  stamp.ship();
  stamp.run("start");
  stamp.ship();
  stamp.run("promote", { force: false });
  // As if the controller had not restarted: its pod predates the leaf.
  stamp.state.pods = [{ name: "pilotswarm-disk-controller-old", startTime: new Date(START - 1000).toISOString() }];
  const status = stamp.run("status");
  assert.equal(status.phase, "promoted");
  assert.deepEqual(failing(status), ["controller"]);
  assert.throws(() => stamp.run("finish"), /Not finishing the rotation:\n {2}- controller: pilotswarm-disk-controller-old started before the current leaf was written .* run promote again, which restarts the controller/);
  assert.ok(stamp.enabled(PREVIOUS_CA_CERT_SECRET));
  const forced = stamp.run("finish", { force: true });
  assert.equal(forced.finished, true);
  assert.equal(forced.forced, true);
  assert.ok(!stamp.enabled(PREVIOUS_CA_CERT_SECRET));

  // Without --force, once the controller restarted.
  const other = fakeStamp(t);
  other.ship();
  other.run("start");
  other.ship();
  other.run("promote");
  assert.deepEqual(failing(other.run("status")), []);
  assert.equal(other.run("finish").finished, true);
  assert.equal(other.run("finish").finished, false, "a second finish has nothing to do");
});

test("the VMs' check reads the model and each VM's own userData; a VM deleted meanwhile is skipped, one without userData lacks the CA", (t) => {
  const stamp = fakeStamp(t);
  const der = stamp.ship().trustedCas[0].der;
  stamp.state.vms.set(VMS[0], null);
  assert.deepEqual(workersLackingCa(NAMES, der, { runFn: stamp.runFn }), { scaleSet: true, checked: 2, lacking: ["psstamp-win-workers_1"] });
  const deletedMeanwhile = (name, args, opts) => (args[0] === "vm" && args[1] === "show" && option(args, "--ids") === VMS[0] ? notFound(VMS[0]) : stamp.runFn(name, args, opts));
  assert.deepEqual(workersLackingCa(NAMES, der, { runFn: deletedMeanwhile }), { scaleSet: true, checked: 1, lacking: [] });
  const other = derOf(createTestPki({ caName: "Other CA" }).caPem);
  assert.equal(workersLackingCa(NAMES, other, { runFn: stamp.runFn }).lacking.length, 3, "another CA: neither the model nor a VM holds it");
  stamp.state.model = undefined;
  assert.deepEqual(workersLackingCa(NAMES, der, { runFn: stamp.runFn }), { scaleSet: false, checked: 0, lacking: [] });
  const calls = stamp.calls.filter(({ args }) => args[0] === "vm" || args[0] === "vmss").map(({ args }) => args);
  assert.ok(calls.some((args) => args[0] === "vm" && args[1] === "list" && option(args, "--vmss") === NAMES.scaleSetId));
  assert.ok(calls.filter((args) => args[1] === "show").every((args) => args.includes("--include-user-data")));
});

test("App Gateway's trust is read in one snapshot: its roots by content, and the HTTP and TLS backend settings that name them", (t) => {
  const pki = createTestPki();
  const gateway = {
    trustedRootCertificates: [{ name: "Root-A", data: base64(pki.caPem) }, { name: "other", properties: { data: derOf(pki.caPem) } }],
    backendHttpSettingsCollection: [{ name: "http", hostName: "Host.Example", trustedRootCertificates: [{ id: "/x/trustedRootCertificates/Root-A" }] }],
    backendSettingsCollection: [{ name: "tls", properties: { trustedRootCertificates: [{ id: "/x/trustedRootCertificates/other" }] } }],
  };
  const trust = readGatewayTrust(NAMES, { runFn: (name, args) => (args[2] === "show" ? ok(gateway) : assert.fail(args.join(" "))) });
  assert.deepEqual(trust.roots, [{ name: "Root-A", der: derOf(pki.caPem) }, { name: "other", der: derOf(pki.caPem) }]);
  assert.deepEqual(trust.settings, [{ name: "http", hostName: "host.example", roots: ["root-a"] }, { name: "tls", hostName: "", roots: ["other"] }]);
});

test("a rollout has finished by kubectl's rule", () => {
  const deployment = (status, extra = {}) => ({ metadata: { generation: 2 }, spec: { replicas: 2 }, status: { observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2, ...status }, ...extra });
  assert.equal(rolloutWaiting(deployment({})), null);
  assert.equal(rolloutWaiting(deployment({ observedGeneration: 1 })), "its new pod template is not observed yet");
  assert.equal(rolloutWaiting(deployment({ updatedReplicas: 1 })), "1 of 2 pods run the new template");
  assert.equal(rolloutWaiting(deployment({ replicas: 3 })), "1 old pods are still terminating");
  assert.equal(rolloutWaiting(deployment({ availableReplicas: 1 })), "1 of 2 new pods are available");
  assert.equal(rolloutWaiting(deployment({ conditions: [{ type: "Progressing", reason: "ProgressDeadlineExceeded" }] })), "it exceeded its progress deadline");
  assert.equal(rolloutWaiting({ metadata: { generation: 1 }, spec: { replicas: 0 }, status: { observedGeneration: 1 } }), null, "an upgrade freeze's 0 replicas");
});

test("on a stamp from before CA rotations, cleanup deletes the root of the old name once a finished rotation and a deploy leave it unused, and only roots of the prefix", (t) => {
  const stamp = fakeStamp(t);
  // Its first CA, on the root named after the prefix itself.
  const first = stamp.deployTls().trustedCas[0];
  stamp.state.roots.set(PREFIX, base64(first.pem));
  stamp.state.roots.set("another-app-root", base64(createTestPki({ caName: "Outsider CA" }).caPem));
  assert.deepEqual(stamp.ship().rootNames, [PREFIX], "the deploy keeps the CA on that root");
  assert.deepEqual(stamp.run("cleanup").deleted, [], "it holds the trusted CA");

  stamp.run("start");
  const during = stamp.ship();
  assert.deepEqual(during.rootNames, [PREFIX, trustedRootName(PREFIX, during.trustedCas[1])]);
  stamp.run("promote");
  stamp.run("finish");
  assert.deepEqual(stamp.run("cleanup").deleted, [], "until a deploy drops it, the Ingress still names the old root");
  const last = stamp.ship();
  assert.deepEqual(last.rootNames, [trustedRootName(PREFIX, last.trustedCas[0])]);
  // Another app's setting names the old root: it stays.
  stamp.state.settings.push({ name: "bp-another-app", hostName: "app.example.com", roots: [PREFIX] });
  assert.deepEqual(stamp.run("status").staleRoots, []);
  assert.deepEqual(stamp.run("cleanup").deleted, []);
  stamp.state.settings.pop();
  assert.deepEqual(stamp.run("status").staleRoots, [PREFIX]);
  assert.deepEqual(stamp.run("cleanup").deleted, [PREFIX]);
  assert.deepEqual([...stamp.state.roots.keys()].sort(), ["another-app-root", last.rootNames[0]].sort());
  assert.deepEqual(stamp.run("cleanup").deleted, []);
  // Private edge: no App Gateway.
  stamp.env.EDGE_MODE = "private";
  assert.match(stamp.run("cleanup").reason, /no App Gateway/);
});

test("status names the root that holds each CA, found by content: on a stamp from before CA rotations, the root of the old name", (t) => {
  const stamp = fakeStamp(t);
  const first = stamp.deployTls().trustedCas[0];
  stamp.state.roots.set(PREFIX, base64(first.pem));
  stamp.ship();
  stamp.run("start");
  const lines = formatCaRotation(stamp.run("status"), "mystamp");
  assert.match(lines[1], new RegExp(`^ {2}current {3}CN=PilotSwarm disk controller CA, SHA-256 [0-9a-f]{64}, valid \\S+ to \\S+, App Gateway root ${PREFIX}$`));
  assert.match(lines[2], /^ {2}next {6}CN=PilotSwarm disk controller CA \d{8}, SHA-256 [0-9a-f]{64}, valid \S+ to \S+, on no App Gateway root yet$/);
  stamp.ship();
  assert.match(formatCaRotation(stamp.run("status"), "mystamp")[2], new RegExp(`, App Gateway root ${PREFIX}-[0-9a-f]{12}$`));
  assert.equal(stamp.calls.filter(({ args }) => args[1] === "application-gateway").length, 2, "one read of App Gateway per status, the check's included");
});

test("status never calls a rotation ready while the next CA's key is missing or disabled, and promote then refuses with nothing written", (t) => {
  const stamp = fakeStamp(t);
  stamp.ship();
  stamp.run("start");
  stamp.ship();
  assert.match(formatCaRotation(stamp.run("status"), "mystamp").at(-1), /every check holds/);
  stamp.az.disabled(NAMES.deployKeyVaultName).add(NEXT_CA_KEY_SECRET);
  const lines = formatCaRotation(stamp.run("status"), "mystamp");
  assert.ok(lines.includes("  The next CA's key is missing or disabled: it cannot be promoted."));
  assert.equal(lines.at(-1), "Next: enable the latest version of disk-controller-ca-key-next again, or disable disk-controller-ca-cert-next and " +
    "`npm run deploy:rotate-ca -- mystamp start` again.");
  const before = stamp.az.snapshot();
  assert.throws(() => stamp.run("promote"), /disk-controller-ca-key-next in vault psstampkvdep is disabled: enable its latest version again/);
  assert.deepEqual(stamp.az.snapshot(), before, "nothing written");
  assert.doesNotThrow(() => stamp.ship(), "the deploys go on");
});

test("after the current CA has expired, a deploy points to promote, promote --force carries on, the deploys drop the expired CA and finish is clean", (t) => {
  const stamp = fakeStamp(t);
  stamp.ship();
  stamp.advance(1820 * DAY);
  stamp.run("start");
  stamp.advance(10 * DAY);
  assert.throws(() => stamp.ship(), /CA expired 4 days ago, too soon to sign a leaf, and the stored leaf no longer serves: promote the next CA now .*--force/);
  const promoted = stamp.run("promote", { force: true });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.forced, true);
  assert.equal(promoted.restarted, true);
  const lines = formatCaRotation(stamp.run("status"), "mystamp");
  assert.ok(lines.includes("  The previous CA has expired: the deploys no longer ship it, and finish retires it."));
  assert.equal(lines.at(-1), "Next: `npm run deploy:rotate-ca -- mystamp finish`.");
  assert.deepEqual(stamp.ship().trustedCas.map((ca) => ca.role), ["current"]);
  assert.equal(stamp.run("finish").finished, true);
  assert.deepEqual(stamp.ship().trustedCas.map((ca) => ca.role), ["current"]);
});

test("the report reads as the next step to take", (t) => {
  const stamp = fakeStamp(t);
  stamp.ship();
  const lines = formatCaRotation(stamp.run("status"), "mystamp");
  assert.equal(lines[0], "The disk controller's CA: no rotation is running.");
  assert.match(lines[1], /^ {2}current {3}CN=PilotSwarm disk controller CA, SHA-256 [0-9a-f]{64}, valid 2026-01-01 to 2031-01-01, App Gateway root pilotswarm-disk-controller-ca-[0-9a-f]{12}$/);
  assert.match(lines.at(-1), /each deploy warns from 425 days before\), `npm run deploy:rotate-ca -- mystamp start`/);
  stamp.run("start");
  const status = formatCaRotation(stamp.run("status"), "mystamp");
  assert.ok(status.includes("Promote's preconditions:"));
  assert.ok(status.some((line) => /^ {2}NOT YET {2}vms: /.test(line)));
  assert.match(formatCaRotation(stamp.run("start"), "mystamp")[0], /The next CA exists already:/);
});

test("the command takes an env and one operation, and --force only with promote or finish", () => {
  assert.deepEqual(parseRotateArgs(["mystamp", "status"]), { envName: "mystamp", operation: "status", force: false });
  assert.deepEqual(parseRotateArgs(["--force", "mystamp", "promote"]), { envName: "mystamp", operation: "promote", force: true });
  assert.deepEqual(parseRotateArgs(["mystamp", "finish", "--force"]), { envName: "mystamp", operation: "finish", force: true });
  assert.deepEqual(parseRotateArgs(["--help"]), { help: true });
  for (const [argv, message] of [
    [["mystamp"], /Usage: npm run deploy:rotate-ca -- <env> status\|start\|cleanup\n {7}npm run deploy:rotate-ca -- <env> promote\|finish \[--force\]$/],
    [["mystamp", "rotate"], /Unknown operation 'rotate'/],
    [["mystamp", "status", "--force"], /--force applies to promote and finish only/],
    [["mystamp", "start", "--yes"], /Unknown flag: --yes/],
    [["mystamp", "start", "extra"], /Usage/],
  ]) {
    assert.throws(() => parseRotateArgs(argv), message, argv.join(" "));
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["deploy:rotate-ca"], "node deploy/scripts/rotate-ca.mjs");
});

// ── End to end ──────────────────────────────────────────────────────

// An Azure CLI on PATH that logs each call and keeps the vaults in a state
// file; a kubectl that only answers its version; and openssl, the TLS step's
// fake.
const FAKE_AZ = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const option = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const is = (...words) => words.every((word, i) => args[i] === word);
const state = JSON.parse(fs.readFileSync(process.env.RC_TEST_STATE, "utf8"));
const save = () => fs.writeFileSync(process.env.RC_TEST_STATE, JSON.stringify(state));
fs.appendFileSync(process.env.RC_TEST_CALLS, JSON.stringify({ tool: "az", args }) + "\n");
if (is("--version")) { console.log("azure-cli (test)"); process.exit(0); }
if (is("account", "show")) { console.log(state.subscription); process.exit(0); }
const vault = () => (state.vaults[option("--vault-name")] ??= {});
if (is("keyvault", "secret", "list")) { console.log(JSON.stringify(Object.keys(vault()).map((name) => ({ name, attributes: { enabled: true } })))); process.exit(0); }
if (is("keyvault", "secret", "show")) {
  const value = vault()[option("--name")];
  if (value === undefined) { console.error("ERROR: (SecretNotFound) A secret with (name/id) " + option("--name") + " was not found in this key vault."); process.exit(3); }
  console.log(JSON.stringify(value));
  process.exit(0);
}
if (is("keyvault", "secret", "set")) { vault()[option("--name")] = fs.readFileSync(option("--file"), "utf8"); save(); process.exit(0); }
if (is("network", "application-gateway", "show")) { console.log(JSON.stringify({ trustedRootCertificates: [], backendHttpSettingsCollection: [] })); process.exit(0); }
console.error("unexpected az call");
process.exit(9);
`;
const FAKE_KUBECTL = String.raw`
if (process.argv[2] === "version") { console.log("Client Version: test"); process.exit(0); }
console.error("unexpected kubectl call");
process.exit(9);
`;
const fakeOpenssl = () => [
  `import { createFakeOpenssl } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "deploy/providers/azure/disk-controller/test/x509.mjs")).href)};`,
  "const result = createFakeOpenssl().openssl(process.argv.slice(2));",
  "process.stdout.write(result.stdout);",
  "process.stderr.write(result.stderr);",
  "process.exit(result.status);",
].join("\n");

let sequence = 0;
function rotateWithFakes(t, argvFor, { vaults = {}, cache = {} } = {}) {
  const name = `rc${process.pid.toString(36)}${sequence++}`;
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  const dir = mkdtempSync(join(tmpdir(), "ps-rotate-ca-cli-"));
  t.after(() => {
    for (const path of [local, dir, join(REPO_ROOT, "deploy/.tmp", name), join(REPO_ROOT, "deploy/.tmp", `disk-controller-${name}`)]) {
      rmSync(path, { recursive: true, force: true });
    }
  });
  const env = { ...parseEnvFile(templateEnvPath()), ...ENV, AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000002", WIN_WORKER_ALERT_EMAILS: "ops@example.com" };
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  mkdirSync(join(REPO_ROOT, "deploy/.tmp", name), { recursive: true });
  writeFileSync(join(REPO_ROOT, "deploy/.tmp", name, "bicep-outputs.cache.json"), JSON.stringify(cache));
  for (const [tool, source, extension] of [["az", FAKE_AZ, "cjs"], ["kubectl", FAKE_KUBECTL, "cjs"], ["openssl", fakeOpenssl(), "mjs"]]) {
    writeFileSync(join(dir, `${tool}.${extension}`), source);
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${tool}.cmd`), `@"${process.execPath}" "%~dp0${tool}.${extension}" %*\r\n`);
    } else {
      writeFileSync(join(dir, tool), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${tool}.${extension}" "$@"\n`, { mode: 0o755 });
    }
  }
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ subscription: SUBSCRIPTION, vaults }));
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const childEnv = { ...process.env };
  for (const key of [...Object.keys(env), ...Object.keys(AKS_ENV_DEFAULTS), "KV_NAME", "DEPLOY_KEY_VAULT_NAME", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "KUBECONFIG"]) {
    delete childEnv[key];
  }
  const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  childEnv[pathKey] = `${dir}${delimiter}${childEnv[pathKey] ?? ""}`;
  Object.assign(childEnv, { RC_TEST_STATE: stateFile, RC_TEST_CALLS: calls });
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "deploy/scripts/rotate-ca.mjs"), ...argvFor(name)], { cwd: REPO_ROOT, encoding: "utf8", env: childEnv });
  return {
    result,
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    state: JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

test("npm run deploy:rotate-ca: the env map deploy.mjs composes, the subscription checked, then the operation", { timeout: 120_000 }, (t) => {
  const pki = createTestPki();
  // Base-infra's outputs from an earlier deploy, as the outputs cache holds them.
  const cache = { DEPLOY_KEY_VAULT_NAME: "cachedkvdep", KV_NAME: "cachedkv" };
  const status = rotateWithFakes(t, (name) => [name, "status"], { vaults: { cachedkvdep: { [CA_CERT_SECRET]: pki.caPem } }, cache });
  assert.equal(status.result.status, 0, `${status.result.stdout}\n${status.result.stderr}`);
  assert.match(status.result.stdout, /The disk controller's CA: no rotation is running\./);
  assert.match(status.result.stdout, /current {3}CN=Test CA, SHA-256 [0-9a-f]{64}, valid \S+ to \S+, on no App Gateway root yet\n/);
  assert.doesNotMatch(status.result.stdout, /Could not/);
  const vaultCalls = status.calls.filter(({ args }) => args[0] === "keyvault");
  assert.ok(vaultCalls.length > 0 && vaultCalls.every(({ args }) => option(args, "--vault-name") === "cachedkvdep"), "the vault named by the outputs cache");
  assert.ok(status.calls.some(({ args }) => args[0] === "account" && args[1] === "show"), "the subscription is checked");
  assert.ok(!vaultCalls.some(({ args }) => args[2] === "show" && /-key/.test(option(args, "--name"))), "the status reads no key");

  const start = rotateWithFakes(t, (name) => [name, "start"], { vaults: { cachedkvdep: { [CA_CERT_SECRET]: pki.caPem } }, cache });
  assert.equal(start.result.status, 0, `${start.result.stdout}\n${start.result.stderr}`);
  assert.match(start.result.stdout, /Created the next CA:\n {2}next {6}CN=PilotSwarm disk controller CA \d{8}, SHA-256 [0-9a-f]{64}/);
  assert.deepEqual(Object.keys(start.state.vaults.cachedkvdep).sort(), [CA_CERT_SECRET, NEXT_CA_CERT_SECRET, NEXT_CA_KEY_SECRET].sort());

  const usage = rotateWithFakes(t, (name) => [name, "status", "--force"]);
  assert.equal(usage.result.status, 2);
  assert.match(usage.result.stderr, /--force applies to promote and finish only/);
  assert.deepEqual(usage.calls, [], "nothing runs on a usage error");

  const refused = rotateWithFakes(t, (name) => [name, "promote"], { vaults: { cachedkvdep: { [CA_CERT_SECRET]: pki.caPem } }, cache });
  assert.equal(refused.result.status, 1);
  assert.match(refused.result.stderr, /No rotation of the controller's CA has started/);
  assert.ok(!refused.calls.some(({ args }) => args[2] === "set"), "nothing written");
});
