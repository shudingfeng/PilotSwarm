// The rotation of the disk controller's CA, behind `npm run deploy:rotate-ca --
// <env> status|start|promote|finish|cleanup` (deploy/scripts/rotate-ca.mjs;
// deploy/providers/azure/disk-controller/README.md, "Rotating the CA"). The
// vault's state and its writes are tls.mjs's; this module checks the stamp
// around them:
//
//   promote's preconditions: before the leaf switches to the next CA, every
//   client that checks the controller's certificate must trust that CA.
//     vms      the scale set model's userData and every VM's own include it.
//              A changed model leaves an existing VM's userData as it was;
//              the controller replaces outdated VMs, standby ones included;
//     appgw    (EDGE_MODE=afd) a trusted root holds it, and every backend
//              setting of the dispatcher's host names such a root, so AGIC
//              has applied the dispatcher Ingress's annotation;
//     cluster  the Secret and the ConfigMap pilotswarm-disk-controller-ca hold
//              it, for NGINX and the coordination host;
//     host     the coordination host's pod template
//              carries the hash of the rotation's bundle and its rollout has
//              finished: the host reads NODE_EXTRA_CA_CERTS only when it
//              starts;
//   after promote, the controller restarts if a pod of it started before the
//   new leaf was written: the Secrets Store CSI driver rewrites a mounted
//   secret only every 30 minutes, and promote switches the leaf at once;
//   finish's condition: no controller pod started before the current leaf
//   was written, so none serves the previous CA's leaf any more;
//   cleanup (afd): deletes the App Gateway trusted roots of the prefix that
//   hold no trusted CA and that no backend setting names, such as the root
//   named after the prefix itself that a stamp from before CA rotations has
//   its first CA on, once a rotation has replaced that CA.
//
// Every Azure CLI and kubectl call goes through `runFn`, so tests can answer
// it. Nothing here reads a key; promote's own key reads are tls.mjs's.

import { X509Certificate } from "node:crypto";
import { log as defaultLog, run } from "../../../scripts/lib/common.mjs";
import { settingValue, winWorkersEnabled } from "../../../scripts/lib/aks-env.mjs";
import {
  COORDINATION_HOST_CA_ANNOTATION,
  WORKER_DEPLOYMENT,
  caBundleHash,
} from "../../../scripts/lib/coordination-host.mjs";
import {
  CA_CLUSTER_OBJECT,
  DISPATCHER_SERVICE,
  LEAF_DAYS,
  NEXT_CA_CERT_SECRET,
  NEXT_CA_KEY_SECRET,
  RENEW_BEFORE_DAYS,
  caRotationStatus,
  finishCaRotation,
  leafWrittenAt,
  promoteCaRotation,
  readTrustedCas,
  startCaRotation,
} from "../disk-controller/tls.mjs";
import {
  controllerTlsInputs,
  edgeMode,
  kubeconfigEnv,
  readGatewayTrust,
  trustedRootPrefix,
  winWorkerResourceNames,
} from "./win-workers.mjs";

export const OPERATIONS = Object.freeze(["status", "start", "promote", "finish", "cleanup"]);
// App Gateway's trust, read in one snapshot as the deploy step reads it.
export { readGatewayTrust };
export const CONTROLLER_DEPLOYMENT = "pilotswarm-disk-controller";
const CONTROLLER_SELECTOR = "app.kubernetes.io/component=disk-controller";
const NOT_FOUND = /ResourceNotFound|ResourceGroupNotFound|NotFound|was not found|could not be found|not found/i;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0].slice(0, 300);
}

// A command's JSON answer; null when it says the object is not there.
function readJson(runFn, tool, args, what, opts = {}) {
  const result = runFn(tool, args, { capture: true, allowFail: true, ...opts });
  if (result.status !== 0) {
    if (NOT_FOUND.test(String(result.stderr ?? ""))) return null;
    throw new Error(`Could not ${what}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(`Could not ${what}: ${tool} returned no JSON.`);
  }
}

// The DER (base64) of each certificate in a PEM text; unreadable ones are left out.
export function certificateDers(text) {
  const ders = new Set();
  for (const pem of String(text ?? "").match(CERTIFICATE) ?? []) {
    try {
      ders.add(new X509Certificate(pem).raw.toString("base64"));
    } catch {
      // Not a certificate: it holds no CA.
    }
  }
  return ders;
}

// Whether a userData value (base64 of the workers' JSON document) trusts the CA.
function userDataHolds(userData, der) {
  try {
    const document = JSON.parse(Buffer.from(String(userData ?? ""), "base64").toString("utf8"));
    return certificateDers(document?.controllerCaCert).has(der);
  } catch {
    return false;
  }
}

/**
 * The scale set model and the VMs whose userData lacks the CA (base64 DER).
 * The VMs of a Flexible scale set are VMs of their own, found with
 * `az vm list --vmss`; each one's userData comes from `az vm show -u`.
 * Returns { scaleSet, checked, lacking: [names] }.
 */
export function workersLackingCa(names, der, { runFn = run } = {}) {
  const scaleSet = readJson(runFn, "az", ["vmss", "show", "--resource-group", names.resourceGroup, "--name", names.scaleSetName,
    "--include-user-data", "--output", "json"], `read the model of scale set ${names.scaleSetName}`);
  // No scale set yet (WIN_WORKER_IMAGE_VERSION unset): no VM to wait for.
  if (scaleSet === null) return { scaleSet: false, checked: 0, lacking: [] };
  const model = property(scaleSet, "virtualMachineProfile")?.userData;
  const lacking = userDataHolds(model, der) ? [] : [`the scale set model ${names.scaleSetName}`];
  const ids = readJson(runFn, "az", ["vm", "list", "--resource-group", names.resourceGroup, "--vmss", names.scaleSetId,
    "--query", "[].id", "--output", "json"], `list the VMs of scale set ${names.scaleSetName}`) ?? [];
  let checked = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const userData = runFn("az", ["vm", "show", "--ids", id, "--include-user-data", "--query", "userData", "--output", "json"],
      { capture: true, allowFail: true });
    if (userData.status !== 0) {
      // Deleted since the list: it serves nobody.
      if (NOT_FOUND.test(String(userData.stderr ?? ""))) continue;
      throw new Error(`Could not read the userData of VM ${id}: ${firstLine(userData.stderr) || `exit ${userData.status}`}`);
    }
    checked += 1;
    let value = null;
    try {
      value = JSON.parse(userData.stdout || "null");
    } catch {
      value = null;
    }
    if (!userDataHolds(value, der)) lacking.push(String(id).split("/").pop());
  }
  return { scaleSet: true, checked, lacking };
}

function property(item, name) {
  return item?.[name] ?? item?.properties?.[name];
}

// Promote's App Gateway condition for the CA (base64 DER); a reason or null.
// `gateway` is a snapshot from readGatewayTrust, or null to read one.
function appGatewayRefusal(names, namespace, der, { runFn, gateway }) {
  const { roots, settings } = gateway ?? readGatewayTrust(names, { runFn });
  const holding = roots.filter((root) => root.der === der).map((root) => root.name.toLowerCase());
  if (holding.length === 0) return "no trusted root holds the next CA yet: deploy the disk-controller service";
  const host = `${DISPATCHER_SERVICE}.${namespace}.svc`;
  const dispatcher = settings.filter((setting) => setting.hostName === host);
  if (dispatcher.length === 0) return `no backend setting is for the dispatcher's host ${host} yet: AGIC has not applied the dispatcher Ingress`;
  const stale = dispatcher.filter((setting) => !setting.roots.some((root) => holding.includes(root))).map((setting) => setting.name);
  return stale.length > 0 ? `the dispatcher's backend settings ${stale.join(", ")} do not name the next CA's root yet: AGIC has not applied the dispatcher Ingress` : null;
}

// Promote's cluster condition: the Secret and the ConfigMap hold the CA.
function clusterRefusal(namespace, der, { runFn, kubeEnv }) {
  const lacking = [];
  for (const [kind, label] of [["secret", "Secret"], ["configmap", "ConfigMap"]]) {
    const object = readJson(runFn, "kubectl", ["get", kind, CA_CLUSTER_OBJECT, "--namespace", namespace, "--output", "json"],
      `read the ${label} ${CA_CLUSTER_OBJECT}`, { env: kubeEnv });
    const value = object?.data?.["ca.crt"];
    const text = kind === "secret" ? Buffer.from(String(value ?? ""), "base64").toString("utf8") : value;
    if (!certificateDers(text).has(der)) lacking.push(`the ${label} ${CA_CLUSTER_OBJECT}`);
  }
  return lacking.length > 0 ? `${lacking.join(" and ")} in namespace ${namespace} lack the next CA: deploy the disk-controller service` : null;
}

/**
 * Why a Deployment's rollout has not finished, or null when it has: kubectl's
 * own rule (`kubectl rollout status`), from the object's status.
 */
export function rolloutWaiting(deployment) {
  const status = deployment?.status ?? {};
  if ((deployment?.metadata?.generation ?? 0) > (status.observedGeneration ?? 0)) return "its new pod template is not observed yet";
  const stuck = (status.conditions ?? []).find((condition) => condition?.type === "Progressing" && condition?.reason === "ProgressDeadlineExceeded");
  if (stuck) return "it exceeded its progress deadline";
  const replicas = deployment?.spec?.replicas ?? 1;
  const updated = status.updatedReplicas ?? 0;
  if (updated < replicas) return `${updated} of ${replicas} pods run the new template`;
  if ((status.replicas ?? 0) > updated) return `${(status.replicas ?? 0) - updated} old pods are still terminating`;
  if ((status.availableReplicas ?? 0) < updated) return `${status.availableReplicas ?? 0} of ${updated} new pods are available`;
  return null;
}

// Promote's coordination host condition: restarted with the rotation's bundle.
function hostRefusal(namespace, bundle, { runFn, kubeEnv }) {
  const deployment = readJson(runFn, "kubectl", ["get", "deployment", WORKER_DEPLOYMENT, "--namespace", namespace, "--output", "json"],
    `read the Deployment ${WORKER_DEPLOYMENT}`, { env: kubeEnv });
  if (!deployment) return `the coordination host's Deployment ${WORKER_DEPLOYMENT} is not in namespace ${namespace}`;
  const annotation = deployment.spec?.template?.metadata?.annotations?.[COORDINATION_HOST_CA_ANNOTATION];
  if (annotation !== caBundleHash(bundle)) {
    return `its pod template ${annotation ? "carries another CA bundle" : `has no ${COORDINATION_HOST_CA_ANNOTATION}`}: deploy the worker service`;
  }
  const waiting = rolloutWaiting(deployment);
  return waiting ? `its rollout with the rotation's CA bundle has not finished: ${waiting}` : null;
}

// Each check, run on its own: it answers a refusal (a string), null when it
// holds, or { ok, detail }; a check that cannot run fails with its error.
function evaluate(checks) {
  return checks.map(([name, check]) => {
    try {
      const answer = check();
      if (answer && typeof answer === "object") return { name, ok: Boolean(answer.ok), detail: answer.detail };
      return answer ? { name, ok: false, detail: answer } : { name, ok: true, detail: "holds" };
    } catch (error) {
      return { name, ok: false, detail: error.message };
    }
  });
}

/**
 * Promote's preconditions for the next CA (tls.mjs's public CA) and the
 * bundle the trust stores hold during the rotation: [{ name, ok, detail }].
 * `gateway` is a snapshot from readGatewayTrust, or omitted to read one.
 */
export function promoteChecks({ env, names, next, caBundle, kube, gateway = null }, { runFn = run } = {}) {
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  const checks = [
    ["vms", () => {
      const { scaleSet, checked, lacking } = workersLackingCa(names, next.der, { runFn });
      if (lacking.length > 0) {
        return `${lacking.join(", ")} lack${lacking.length === 1 ? "s" : ""} the next CA: deploy base-infra, and let the controller replace the outdated VMs`;
      }
      return { ok: true, detail: scaleSet ? `the scale set model and its ${checked} VM(s) hold it` : "no scale set yet" };
    }],
  ];
  if (edgeMode(env) === "afd") checks.push(["appgw", () => appGatewayRefusal(names, namespace, next.der, { runFn, gateway })]);
  checks.push(["cluster", () => clusterRefusal(namespace, next.der, { runFn, kubeEnv: kube() })]);
  checks.push(["host", () => hostRefusal(namespace, caBundle, { runFn, kubeEnv: kube() })]);
  return evaluate(checks);
}

// The controller's pods that started at or before `time` (ms): they may still
// serve the leaf from before it.
export function controllerPodsStartedBefore(namespace, time, { runFn = run, kubeEnv } = {}) {
  const pods = readJson(runFn, "kubectl", ["get", "pods", "--namespace", namespace, "--selector", CONTROLLER_SELECTOR, "--output", "json"],
    "list the disk controller's pods", { env: kubeEnv });
  return (pods?.items ?? [])
    .filter((pod) => pod?.status?.startTime && Date.parse(pod.status.startTime) <= time)
    .map((pod) => String(pod?.metadata?.name ?? ""));
}

// Finish's condition: the controller serves the current leaf.
export function finishChecks({ env, names, kube }, { runFn = run } = {}) {
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  const stampVaultName = settingValue(env, "KV_NAME") || names.stampKeyVaultName;
  return evaluate([["controller", () => {
    const written = leafWrittenAt({ stampVaultName }, { runFn });
    if (written === null) return `the stamp vault ${stampVaultName} holds no leaf`;
    const stale = controllerPodsStartedBefore(namespace, written, { runFn, kubeEnv: kube() });
    return stale.length > 0
      ? `${stale.join(", ")} started before the current leaf was written and may still serve the previous CA's leaf: run promote again, ` +
        `which restarts the controller, or restart it (kubectl rollout restart deployment/${CONTROLLER_DEPLOYMENT} --namespace ${namespace})`
      : null;
  }]]);
}

// Restarts the controller when a pod of it started before the leaf was
// written, so it serves the leaf now. Returns whether it did.
export function restartStaleController({ env, names, kube }, { runFn = run, log = defaultLog } = {}) {
  const namespace = settingValue(env, "NAMESPACE") || "pilotswarm";
  const written = leafWrittenAt({ stampVaultName: settingValue(env, "KV_NAME") || names.stampKeyVaultName }, { runFn });
  if (written === null) return false;
  const kubeEnv = kube();
  const stale = controllerPodsStartedBefore(namespace, written, { runFn, kubeEnv });
  if (stale.length === 0) return false;
  for (const [args, what] of [
    [["rollout", "restart", `deployment/${CONTROLLER_DEPLOYMENT}`, "--namespace", namespace], "restart the disk controller"],
    [["rollout", "status", `deployment/${CONTROLLER_DEPLOYMENT}`, "--namespace", namespace, "--timeout", "10m"], "wait for the disk controller's restart"],
  ]) {
    const result = runFn("kubectl", args, { capture: true, allowFail: true, env: kubeEnv });
    if (result.status !== 0) throw new Error(`Could not ${what}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  }
  log("ok", `[ca-rotation] restarted the disk controller (${stale.join(", ")}), which now serves the new CA's leaf.`);
  return true;
}

/**
 * The App Gateway trusted roots of the prefix, in a snapshot from
 * readGatewayTrust, that hold no trusted CA and that no backend setting
 * names: those a finished rotation left, including the root named after the
 * prefix itself that a stamp from before CA rotations has its first CA on.
 */
export function staleTrustedRoots({ gateway, prefix, trustedDers }) {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-[0-9a-f]{12})?$`, "i");
  const named = new Set(gateway.settings.flatMap((setting) => setting.roots));
  return gateway.roots.filter((root) => pattern.test(root.name) && !trustedDers.has(root.der) && !named.has(root.name.toLowerCase())).map((root) => root.name);
}

// What the report shows of a CA. With a gateway snapshot, `root` is the root
// that holds the CA, found by content, or null while none does.
const quick = (ca, gateway = null) => ca && {
  subject: ca.subject,
  fingerprint: ca.fingerprint,
  notBefore: ca.notBefore,
  notAfter: ca.notAfter,
  ...(gateway ? { root: gateway.roots.find((root) => root.der === ca.der)?.name ?? null } : {}),
};

/**
 * Runs one operation against the stamp whose env map `env` is, and returns
 * what it found or did, for formatCaRotation. `stagingDir` keeps the
 * cluster's kubeconfig.
 */
export function runCaRotation({ env, operation, force = false, stagingDir }, { runFn = run, log = defaultLog, now, tmpRoot } = {}) {
  if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation '${operation}': use ${OPERATIONS.join(", ")}.`);
  if (!winWorkersEnabled(env)) throw new Error("The disk controller's CA exists only with WIN_WORKERS_ENABLED=true.");
  const names = winWorkerResourceNames(env);
  const deployVaultName = settingValue(env, "DEPLOY_KEY_VAULT_NAME") || names.deployKeyVaultName;
  const stampVaultName = settingValue(env, "KV_NAME") || names.stampKeyVaultName;
  const afd = edgeMode(env) === "afd";
  const prefix = afd ? trustedRootPrefix(env) : null;
  let kubeEnv = null;
  const kube = () => (kubeEnv ??= kubeconfigEnv(names, stagingDir, runFn));
  const clock = now ? { now } : {};

  if (operation === "start") {
    const { created, next } = startCaRotation({ deployVaultName }, { runFn, log, tmpRoot, ...clock });
    return { operation, created, next: quick(next) };
  }
  if (operation === "promote") {
    const result = promoteCaRotation(controllerTlsInputs(env, names), {
      runFn, log, tmpRoot, force, ...clock,
      check: ({ next, caBundle }) => promoteChecks({ env, names, next, caBundle, kube }, { runFn }).filter((check) => !check.ok),
    });
    const restarted = restartStaleController({ env, names, kube }, { runFn, log });
    return { operation, promoted: result.promoted, resumed: result.resumed, forced: result.forced, failures: result.failures,
      current: quick(result.next), leafRenewed: result.tls.leafRenewed, restarted };
  }
  if (operation === "finish") {
    const result = finishCaRotation({ deployVaultName, stampVaultName }, {
      runFn, log, force,
      check: () => finishChecks({ env, names, kube }, { runFn }).filter((check) => !check.ok),
    });
    return { operation, finished: result.finished, forced: result.forced, failures: result.failures, previous: quick(result.previous) };
  }
  if (operation === "cleanup") {
    if (!afd) return { operation, deleted: [], reason: "EDGE_MODE is not afd: the stamp has no App Gateway" };
    const trusted = readTrustedCas({ deployVaultName }, { runFn, log, ...clock });
    if (!trusted) throw new Error(`Vault ${deployVaultName} holds no CA yet.`);
    const gateway = readGatewayTrust(names, { runFn });
    const stale = staleTrustedRoots({ gateway, prefix, trustedDers: new Set(trusted.trustedCas.map((ca) => ca.der)) });
    for (const name of stale) {
      const result = runFn("az", ["network", "application-gateway", "root-cert", "delete", "--resource-group", names.resourceGroup,
        "--gateway-name", names.applicationGatewayName, "--name", name, "--output", "none"], { capture: true, allowFail: true });
      if (result.status !== 0 && !NOT_FOUND.test(String(result.stderr ?? ""))) {
        throw new Error(`Could not delete App Gateway trusted root ${name}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
      }
      log("ok", `[ca-rotation] deleted App Gateway trusted root ${name}, which held no trusted CA and which nothing named.`);
    }
    return { operation, deleted: stale };
  }

  const status = caRotationStatus({ deployVaultName }, { runFn, ...clock });
  // One read of App Gateway for the whole report: the roots that hold the
  // CAs, promote's App Gateway check and the stale roots.
  let gateway = null;
  let gatewayProblem = null;
  if (afd) {
    try {
      gateway = readGatewayTrust(names, { runFn });
    } catch (error) {
      gatewayProblem = error.message;
    }
  }
  const report = {
    operation,
    phase: status.phase,
    problem: status.problem,
    current: quick(status.current, gateway),
    next: quick(status.next, gateway),
    nextKey: status.nextKey,
    // Promote still has to read the next key: it has not moved yet.
    keyNeeded: Boolean(status.next && status.current && status.next.fingerprint !== status.current.fingerprint),
    previous: quick(status.previous, gateway),
    previousExpired: Boolean(status.previous && Date.parse(status.previous.notAfter) <= (now ?? Date.now)()),
    checks: [],
    ...(gatewayProblem ? { gatewayProblem } : {}),
  };
  if (status.phase === "started" && status.caBundle) {
    report.checks = promoteChecks({ env, names, next: status.next, caBundle: status.caBundle, kube, gateway }, { runFn });
  } else if (status.phase === "promoted") {
    report.checks = finishChecks({ env, names, kube }, { runFn });
  }
  if (gateway && status.caBundle) {
    report.staleRoots = staleTrustedRoots({ gateway, prefix, trustedDers: new Set(status.trustedCas.map((ca) => ca.der)) });
  }
  return report;
}

const day = (iso) => String(iso ?? "").slice(0, 10);
const describe = (label, ca) => `  ${label.padEnd(9)} ${ca.subject}, SHA-256 ${ca.fingerprint}, valid ${day(ca.notBefore)} to ${day(ca.notAfter)}` +
  (ca.root === undefined ? "" : ca.root === null ? ", on no App Gateway root yet" : `, App Gateway root ${ca.root}`);

/** What runCaRotation returned, as the lines the command prints. */
export function formatCaRotation(report, envName = "<env>") {
  const command = (operation) => `npm run deploy:rotate-ca -- ${envName} ${operation}`;
  const lines = [];
  const checks = (title) => {
    if (!report.checks?.length) return;
    lines.push(title);
    for (const check of report.checks) lines.push(`  ${check.ok ? "ok" : "NOT YET"}  ${check.name}: ${check.detail}`);
  };
  switch (report.operation) {
    case "start":
      lines.push(report.created ? "Created the next CA:" : "The next CA exists already:");
      lines.push(describe("next", report.next));
      lines.push("Next: deploy base-infra, disk-controller and worker, so every trust store holds it;",
        `then watch \`${command("status")}\` until each check holds, and promote.`);
      break;
    case "promote":
      if (report.promoted) {
        lines.push(`Promoted the next CA${report.resumed ? " (completing an interrupted promote)" : ""}${report.forced ? " WITH --force" : ""}:`);
      } else {
        lines.push("The next CA was promoted already:");
      }
      lines.push(describe("current", report.current));
      lines.push(report.leafRenewed ? "The controller's leaf is now the new CA's." : "The controller's leaf is the new CA's.");
      if (report.restarted) lines.push("The disk controller restarted to serve it.");
      lines.push(`Next: \`${command("finish")}\`, then deploy again, which drops the previous CA from every trust store.`);
      break;
    case "finish":
      if (report.finished) {
        lines.push(`The previous CA is no longer trusted${report.forced ? " (finished WITH --force)" : ""}:`);
        lines.push(describe("previous", report.previous));
        lines.push("Next: deploy base-infra, disk-controller and worker again;",
          `after that deploy, \`${command("cleanup")}\` removes its App Gateway root.`);
      } else {
        lines.push("No rotation to finish: no previous CA is trusted.");
      }
      break;
    case "cleanup":
      if (report.reason) lines.push(`Nothing to clean up: ${report.reason}.`);
      else if (report.deleted.length === 0) lines.push("No stale App Gateway trusted root.");
      else lines.push(`Deleted App Gateway trusted roots: ${report.deleted.join(", ")}.`);
      break;
    default: {
      const phases = {
        none: "no rotation is running",
        started: "a rotation has started: the next CA is trusted and signs nothing yet",
        promoting: "a promote stopped part-way",
        promoted: "the next CA is promoted; the previous one is still trusted",
      };
      lines.push(`The disk controller's CA: ${phases[report.phase] ?? "unknown state"}.`);
      for (const [label, ca] of [["current", report.current], ["next", report.next], ["previous", report.previous]]) {
        if (ca) lines.push(describe(label, ca));
      }
      if (report.next && !report.nextKey) lines.push("  The next CA's key is missing or disabled: it cannot be promoted.");
      if (report.previousExpired) lines.push("  The previous CA has expired: the deploys no longer ship it, and finish retires it.");
      if (report.problem) lines.push(`Problem: ${report.problem}`);
      checks(report.phase === "started" ? "Promote's preconditions:" : "Finish's condition:");
      if (report.staleRoots?.length) lines.push(`App Gateway roots that \`${command("cleanup")}\` would delete: ${report.staleRoots.join(", ")}.`);
      if (report.gatewayProblem) lines.push(`Could not read App Gateway: ${report.gatewayProblem}`);
      // A key that is missing or disabled stops promote before its first
      // write; no check of the deployment makes up for it.
      const unusableKey = report.keyNeeded && !report.nextKey;
      const next = {
        none: `Next: when the CA nears its end (each deploy warns from ${LEAF_DAYS + RENEW_BEFORE_DAYS} days before), \`${command("start")}\`.`,
        started: unusableKey
          ? `Next: enable the latest version of ${NEXT_CA_KEY_SECRET} again, or disable ${NEXT_CA_CERT_SECRET} and \`${command("start")}\` again.`
          : report.checks.every((check) => check.ok)
            ? `Next: every check holds; \`${command("promote")}\`.`
            : "Next: deploy what the checks name, and let the controller replace the outdated VMs; then check again.",
        promoting: unusableKey
          ? `Next: enable the latest version of ${NEXT_CA_KEY_SECRET} again, then \`${command("promote")}\` again to finish it.`
          : `Next: \`${command("promote")}\` again to finish it.`,
        promoted: report.checks.every((check) => check.ok) ? `Next: \`${command("finish")}\`.` : `Next: once the condition holds, \`${command("finish")}\`.`,
      };
      if (next[report.phase]) lines.push(next[report.phase]);
    }
  }
  return lines;
}
