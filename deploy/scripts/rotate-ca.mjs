#!/usr/bin/env node
// Rotates the disk controller's private CA on a stamp with the Windows worker
// pool (deploy/providers/azure/disk-controller/README.md, "Rotating the CA"):
//
//   npm run deploy:rotate-ca -- <env> status|start|cleanup
//   npm run deploy:rotate-ca -- <env> promote|finish [--force]
//
//   status   the CAs (certificates only), and the checks of the next step
//   start    make the next CA; every deploy after it ships both CAs
//   promote  once every trust store holds the next CA, make it the current
//            one and switch the controller's leaf to it; --force skips the
//            checks
//   finish   stop trusting the previous CA; the next deploy drops it
//   cleanup  delete App Gateway trusted roots that hold no trusted CA
//
// The env map is the one `npm run deploy` composes (the env file, the Bicep
// outputs cache and the composed values). Like the deploy, it checks the
// Azure CLI's subscription, and in a GitHub Actions run signs in again first.
// The work is deploy/providers/azure/deploy-steps/ca-rotation.mjs's.

import { pathToFileURL } from "node:url";
import { assertCli, assertSubscription, log, stagingDir, validateEnv } from "./lib/common.mjs";
import { DISK_CONTROLLER_SERVICE } from "./lib/aks-env.mjs";
import { refreshAzureOidcLogin } from "./lib/push-image.mjs";
import { loadStampEnv } from "./lib/stamp-env.mjs";
import { OPERATIONS, formatCaRotation, runCaRotation } from "../providers/azure/deploy-steps/ca-rotation.mjs";

// --force skips the checks of the operations that have them.
const FORCEABLE = Object.freeze(["promote", "finish"]);
const USAGE = [
  `Usage: npm run deploy:rotate-ca -- <env> ${OPERATIONS.filter((operation) => !FORCEABLE.includes(operation)).join("|")}`,
  `       npm run deploy:rotate-ca -- <env> ${FORCEABLE.join("|")} [--force]`,
].join("\n");
// The operations that read the cluster: their checks and promote's restart.
const NEEDS_KUBECTL = new Set(["status", "promote", "finish"]);

/** The command's arguments: { envName, operation, force }, or { help: true }. */
export function parseRotateArgs(argv) {
  const positional = [];
  let force = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--force") force = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new Error(USAGE);
  const [envName, operation] = positional;
  if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation '${operation}'.\n${USAGE}`);
  if (force && !FORCEABLE.includes(operation)) throw new Error(`--force applies to promote and finish only.\n${USAGE}`);
  return { envName, operation, force };
}

async function main(argv) {
  let args;
  try {
    args = parseRotateArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\nSee "Rotating the CA" in deploy/providers/azure/disk-controller/README.md.\n`);
    return 0;
  }
  validateEnv(args.envName);
  const env = loadStampEnv(args.envName);
  assertCli("az", "https://aka.ms/azcli (winget install Microsoft.AzureCLI / brew install azure-cli)");
  if (NEEDS_KUBECTL.has(args.operation)) assertCli("kubectl", "https://kubernetes.io/docs/tasks/tools/", ["version", "--client"]);
  assertSubscription(env.SUBSCRIPTION_ID);
  await refreshAzureOidcLogin(env, "the CA rotation");
  const report = runCaRotation({
    env,
    operation: args.operation,
    force: args.force,
    stagingDir: stagingDir(DISK_CONTROLLER_SERVICE, args.envName),
  });
  for (const line of formatCaRotation(report, args.envName)) process.stdout.write(`${line}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    log("err", error.message);
    process.exit(1);
  });
}
