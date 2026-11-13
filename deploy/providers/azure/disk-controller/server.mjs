#!/usr/bin/env node
// The disk controller and credential broker for PilotSwarm's Windows worker
// pool on Azure. One replica runs in the cluster, next to the portal; see
// README.md for its routes, settings and permissions.
//
//   node server.mjs
//
// Only this file imports the Azure SDKs and `jose`, and only when it starts,
// so the controller's modules and tests need none of this package's
// dependencies.
import https from "node:https";
import { pathToFileURL } from "node:url";

import { COORDINATION_PORT, DISPATCHER_PORT, WORKER_PORT, loadConfig } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { createAzure } from "./lib/azure.mjs";
import { createBlobStateBackend, createStateStore } from "./lib/state-store.mjs";
import { createTokenVerifier } from "./lib/auth.mjs";
import { createController } from "./lib/controller.mjs";
import { createTlsSource } from "./lib/serving-tls.mjs";

const SHUTDOWN_GRACE_MS = 20_000;

/** The Azure SDK clients the controller needs, all signed in as the pod's workload identity. */
export async function createAzureClients(config, { importModule = (specifier) => import(specifier) } = {}) {
  const [identity, storage, secrets] = await Promise.all([
    importModule("@azure/identity"),
    importModule("@azure/storage-blob"),
    importModule("@azure/keyvault-secrets"),
  ]);
  const credential = new identity.DefaultAzureCredential();
  const clients = {
    credential,
    container: new storage.ContainerClient(config.stateUrl, credential),
    secrets: config.personalVaultUri ? new secrets.SecretClient(config.personalVaultUri, credential) : null,
    compute: null,
    network: null,
    monitor: null,
  };
  if (config.scaleSet) {
    const [compute, network, monitor] = await Promise.all([
      importModule("@azure/arm-compute"),
      importModule("@azure/arm-network"),
      importModule("@azure/arm-monitor"),
    ]);
    const subscriptionId = config.scaleSet.subscriptionId;
    clients.compute = new compute.ComputeManagementClient(credential, subscriptionId);
    clients.network = new network.NetworkManagementClient(credential, subscriptionId);
    clients.monitor = new monitor.MonitorClient(credential, subscriptionId);
  }
  return clients;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

/**
 * Starts the controller: its state, its three HTTPS listeners and its timers.
 * Returns { controller, ports, close }. `tlsWatch` ({ watch, unwatch })
 * replaces the file watch that reloads the certificate, for tests.
 */
export async function main({
  env = process.env,
  importModule,
  log = createLogger(),
  ports = { worker: WORKER_PORT, dispatcher: DISPATCHER_PORT, coordination: COORDINATION_PORT },
  host = "0.0.0.0",
  timers,
  tlsWatch = {},
} = {}) {
  const config = loadConfig(env);
  const clients = await createAzureClients(config, { importModule });
  const azure = config.scaleSet
    ? createAzure({ compute: clients.compute, network: clients.network, monitor: clients.monitor, scaleSet: config.scaleSet, dcrId: config.dcrId })
    : null;
  const controller = createController({
    config,
    azure,
    state: createStateStore({ backend: createBlobStateBackend(clients.container) }),
    secrets: clients.secrets,
    log,
    verifyToken: createTokenVerifier(config.tokens, { importModule }),
    ...(timers ? { timers } : {}),
  });

  const tls = createTlsSource(config.tlsFile, { log, ...tlsWatch });
  const servers = Object.entries(ports).map(([name, port]) => {
    const server = https.createServer({
      ...tls.options(),
      minVersion: "TLSv1.2",
      requestTimeout: 30_000,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
    }, controller.apps[name].nodeHandler);
    return { name, port, server };
  });
  tls.onChange((options) => {
    for (const { server } of servers) server.setSecureContext({ ...options, minVersion: "TLSv1.2" });
  });
  const bound = {};
  // The listeners answer first, `503 STARTING` until the state is loaded,
  // so the health probe sees the controller come up.
  for (const entry of servers) bound[entry.name] = await listen(entry.server, entry.port, host);
  await controller.start();
  controller.startTimers();
  log.info("controller.listening", bound);

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      tls.close();
      await Promise.race([controller.stop(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref())]);
      await Promise.all(servers.map(({ server }) => new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      })));
    })();
    return closing;
  };
  return { controller, ports: bound, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger();
  main({ log }).then(({ close }) => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => {
        log.info("controller.stopping", { signal });
        close().then(() => process.exit(0), () => process.exit(1));
      });
    }
  }).catch((err) => {
    log.error("controller.failed", { error: err?.message ?? String(err) });
    process.exit(1);
  });
}
