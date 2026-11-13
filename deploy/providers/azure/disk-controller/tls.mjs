// The disk controller's TLS: a deploy step of the Azure provider, which the
// deploy tool calls with the stamp's values. The Azure CLI's
// `az keyvault certificate create` cannot put an IP address in a
// certificate, so the step keeps a private CA of its own and signs the
// controller's leaf certificate with openssl (1.1.1 or later):
//
// - the CA (5 years) is made once. Its key lives only in the deploy-only
//   vault, as `disk-controller-ca-key`, beside its certificate
//   (`disk-controller-ca-cert`). Reading the key is meant to raise an alert,
//   so the step reads it only to sign a leaf;
// - the leaf (1 year, ending at least a day before its CA) names the worker
//   port's address and the cluster DNS names of the dispatcher and
//   coordination Services, with the dispatcher Service's name as its common
//   name, for App Gateway's host name check. A deploy issues a new one when
//   fewer than 60 days remain, when the names change or when another CA
//   signed it, and stores the leaf, the CA's certificate and the leaf's key as
//   the PEM bundle `disk-controller-tls` in the stamp vault. The controller
//   reloads it without a restart;
// - after writing the leaf, the step grants the controller's identity
//   Key Vault Secrets User on that one secret.
//
// The trust stores hold the trusted CA set, as one PEM bundle with the current
// CA first: that CA alone, or, while a rotation runs, that CA and the next or
// the previous one (README, "Rotating the CA"). The rotation's operations are
// at the end of this file; each can run again after an interruption at any of
// its writes and still converges.
//
// Keys and secret values never appear on a command line: openssl and the
// Azure CLI read and write them as files in a private temporary folder that
// the step removes when it ends. Every command goes through `runFn`, so tests
// can answer it.
import { X509Certificate, createHash, createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log as defaultLog, run } from "../../../scripts/lib/common.mjs";

export const CA_KEY_SECRET = "disk-controller-ca-key";
export const CA_CERT_SECRET = "disk-controller-ca-cert";
// The CA rotation's own secrets in the deploy-only vault (README, "Rotating
// the CA"): the next CA, which every trust store holds before it signs
// anything, and the previous CA's certificate, trusted until the rotation
// finishes. A used one is disabled, never deleted: soft delete would keep its
// name from being written again.
export const NEXT_CA_CERT_SECRET = "disk-controller-ca-cert-next";
export const NEXT_CA_KEY_SECRET = "disk-controller-ca-key-next";
export const PREVIOUS_CA_CERT_SECRET = "disk-controller-ca-cert-previous";
export const LEAF_SECRET = "disk-controller-tls";
export const CA_CLUSTER_OBJECT = "pilotswarm-disk-controller-ca";
export const DISPATCHER_SERVICE = "pilotswarm-disk-controller-dispatcher";
export const COORDINATION_SERVICE = "pilotswarm-disk-controller-coordination";
export const DEFAULT_WORKER_PORT_IP = "10.20.15.250";
export const CA_COMMON_NAME = "PilotSwarm disk controller CA";
export const CA_DAYS = 1826;
export const LEAF_DAYS = 365;
export const RENEW_BEFORE_DAYS = 60;
// The current CA and, while a rotation runs, one other.
export const MAX_TRUSTED_CAS = 2;
const DAY_MS = 86_400_000;
const NOT_FOUND = /SecretNotFound|was not found|could not be found|\(NotFound\)/i;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
// One PEM certificate exactly: base64 lines between its two markers.
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----/g;
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const CA_EXTENSIONS = Object.freeze([
  "basicConstraints = critical,CA:TRUE,pathlen:0",
  "keyUsage = critical,keyCertSign,cRLSign",
  "subjectKeyIdentifier = hash",
]);

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0].slice(0, 300);
}

function assertNamespace(namespace) {
  if (!NAMESPACE.test(String(namespace ?? ""))) {
    throw new Error("The disk controller's TLS step needs the Kubernetes namespace the controller runs in.");
  }
}

/** The leaf's common name and subject alternative names for a namespace. */
export function leafIdentity({ namespace, workerPortIp = DEFAULT_WORKER_PORT_IP }) {
  assertNamespace(namespace);
  const octets = String(workerPortIp).split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    throw new Error("The worker port's address must be an IPv4 address.");
  }
  const dispatcher = `${DISPATCHER_SERVICE}.${namespace}.svc`;
  const coordination = `${COORDINATION_SERVICE}.${namespace}.svc`;
  return {
    commonName: dispatcher,
    names: [`IP:${workerPortIp}`, `DNS:${dispatcher}`, `DNS:${coordination}`],
  };
}

/** A certificate's subject alternative names as sorted `IP:` and `DNS:` entries. */
export function alternativeNames(text) {
  return String(text ?? "")
    .split(/,\s*|\r?\n/)
    .map((entry) => entry.trim().replace(/^IP Address:/i, "IP:"))
    .filter((entry) => /^(?:IP|DNS):/.test(entry))
    .sort();
}

/**
 * Why the stored leaf must be issued again, or null when it can stay: none
 * stored, unreadable, not signed by the CA, other names, or fewer than 60
 * days left.
 */
export function leafRenewalReason({ bundlePem, caPem, identity, now }) {
  if (!bundlePem) return "no leaf is stored";
  const certificates = String(bundlePem).match(CERTIFICATE) ?? [];
  let leaf;
  let ca;
  try {
    leaf = new X509Certificate(certificates[0]);
    ca = new X509Certificate(caPem);
  } catch {
    return "the stored leaf cannot be read";
  }
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return "another CA signed the stored leaf";
  if (JSON.stringify(alternativeNames(leaf.subjectAltName)) !== JSON.stringify([...identity.names].sort())) return "the leaf's names changed";
  if (!leaf.subject.split("\n").includes(`CN=${identity.commonName}`)) return "the leaf's common name changed";
  const left = Date.parse(leaf.validTo) - now;
  if (left < RENEW_BEFORE_DAYS * DAY_MS) return `the leaf expires in ${Math.max(0, Math.floor(left / DAY_MS))} days`;
  return null;
}

// ─── The trusted CA set ───

/**
 * The certificates in `text`, checked as the workers check their bundle:
 * `min` to `max` PEM certificates, each a CA, and nothing but whitespace
 * around them. Returns them as X509Certificate objects, in order; messages
 * name `what`, never a value.
 */
export function parseCaCertificates(text, what = "The CA bundle", { min = 1, max = MAX_TRUSTED_CAS } = {}) {
  const source = String(text ?? "");
  if (/\S/.test(source.replace(PEM_CERTIFICATE, ""))) throw new Error(`${what} holds something other than PEM certificates.`);
  const blocks = [...source.matchAll(PEM_CERTIFICATE)];
  if (blocks.length < min || blocks.length > max) {
    throw new Error(`${what} must hold ${min === max ? min : `${min} to ${max}`} PEM CA certificate${max === 1 ? "" : "s"}, not ${blocks.length}.`);
  }
  return blocks.map(([, body], index) => {
    const der = Buffer.from(body.replace(/\s/g, ""), "base64");
    let certificate = null;
    try {
      certificate = new X509Certificate(der);
    } catch {
      certificate = null;
    }
    // A certificate parses from the front of its bytes; anything after it is junk.
    if (!certificate?.raw.equals(der)) throw new Error(`${what}: certificate ${index + 1} is not a PEM certificate.`);
    if (!certificate.ca) throw new Error(`${what}: certificate ${index + 1} is not a CA certificate.`);
    return certificate;
  });
}

/** The SHA-256 of a certificate's DER bytes, as lowercase hex. */
export function caFingerprint(certificate) {
  return createHash("sha256").update(certificate.raw).digest("hex");
}

/** The trust stores' PEM bundle: the certificates in order, one newline after each. */
export function caBundle(pems) {
  return `${pems.map((pem) => String(pem).trim()).join("\n")}\n`;
}

// A CA certificate kept in a vault secret, which must hold that one
// certificate. `public` is what callers get: certificates only.
function describeCa({ role, secret, pem, vault }) {
  const [certificate] = parseCaCertificates(pem, `${secret} in vault ${vault}`, { min: 1, max: 1 });
  const text = `${String(pem).trim()}\n`;
  return {
    role,
    secret,
    certificate,
    fingerprint: caFingerprint(certificate),
    public: {
      role,
      secret,
      subject: certificate.subject,
      fingerprint: caFingerprint(certificate),
      notBefore: new Date(certificate.validFrom).toISOString(),
      notAfter: new Date(certificate.validTo).toISOString(),
      pem: text,
      der: certificate.raw.toString("base64"),
    },
  };
}

// The CA set every trust store holds: the current CA first, then the next or
// the previous one while a rotation runs. Both at once means a promote
// stopped half-way, which only promote completes. An expired previous CA
// anchors no valid chain, so it is left out, with a warning (`warn`), and
// finish still retires it; an expired next CA stops the deploys, since it
// must never be promoted.
function trustedSet({ current, next, previous, vault, now, warn = () => {} }) {
  if (next && previous) {
    throw new Error(
      `Vault ${vault} holds both ${NEXT_CA_CERT_SECRET} and ${PREVIOUS_CA_CERT_SECRET}: a promote of the controller's CA stopped ` +
        "before it ended. Run `npm run deploy:rotate-ca -- <env> promote` again to finish it.",
    );
  }
  if (previous && Date.parse(previous.certificate.validTo) <= now) {
    warn(
      `${PREVIOUS_CA_CERT_SECRET} in vault ${vault} expired on ${previous.public.notAfter}: the trust stores no longer get it. ` +
        "Finish the rotation (`npm run deploy:rotate-ca -- <env> finish`).",
    );
    return [current];
  }
  const other = next ?? previous;
  if (!other) return [current];
  if (Date.parse(other.certificate.validTo) <= now) {
    throw new Error(
      `${other.secret} in vault ${vault} expired on ${other.public.notAfter}; ` +
        `disable ${NEXT_CA_CERT_SECRET} and ${NEXT_CA_KEY_SECRET} and start the rotation again.`,
    );
  }
  if (other.fingerprint === current.fingerprint) {
    throw new Error(`${other.secret} in vault ${vault} holds the current CA itself; a trust store needs two different CAs.`);
  }
  return [current, other];
}

// The Azure CLI and openssl calls the CA's operations make, through `runFn`.
function tools(runFn) {
  const failure = (result) => firstLine(result.stderr) || `exit ${result.status}`;
  const az = (args, what) => {
    const result = runFn("az", args, { capture: true, allowFail: true });
    if (result.status !== 0) throw new Error(`Could not ${what}: ${failure(result)}`);
    return result.stdout;
  };
  return {
    az,
    showSecret(vault, name) {
      const result = runFn("az", ["keyvault", "secret", "show", "--vault-name", vault, "--name", name, "--query", "value", "--output", "json"],
        { capture: true, allowFail: true });
      if (result.status === 0) return JSON.parse(result.stdout);
      if (NOT_FOUND.test(String(result.stderr ?? ""))) return null;
      throw new Error(`Could not read secret ${name} from vault ${vault}: ${failure(result)}`);
    },
    // Each secret's attributes, never a value: reading a CA key is meant to
    // raise an alert, and the list reads none. A disabled secret counts as
    // absent.
    listSecrets(vault) {
      let listed;
      try {
        listed = JSON.parse(az(["keyvault", "secret", "list", "--vault-name", vault, "--output", "json"], `list the secrets in vault ${vault}`) || "[]");
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Could not list the secrets in vault ${vault}: the Azure CLI returned no JSON.`);
        throw error;
      }
      const secrets = new Map();
      for (const item of Array.isArray(listed) ? listed : []) {
        const name = item?.name ?? /\/secrets\/([^/?]+)/.exec(String(item?.id ?? ""))?.[1];
        if (name) secrets.set(name, { enabled: item?.attributes?.enabled !== false, created: item?.attributes?.created ?? null });
      }
      return secrets;
    },
    setSecret(vault, name, path) {
      az(["keyvault", "secret", "set", "--vault-name", vault, "--name", name, "--file", path,
        "--encoding", "utf-8", "--content-type", "application/x-pem-file", "--output", "none"], `write secret ${name} to vault ${vault}`);
    },
    // Retires a secret by disabling its latest version; a later write makes a
    // new, enabled one.
    disableSecret(vault, name) {
      az(["keyvault", "secret", "set-attributes", "--vault-name", vault, "--name", name, "--enabled", "false", "--output", "none"],
        `disable secret ${name} in vault ${vault}`);
    },
    openssl(args, what) {
      const result = runFn("openssl", args, { capture: true, allowFail: true });
      if (result.status !== 0) throw new Error(`openssl could not ${what}: ${failure(result)}`);
      return result.stdout;
    },
  };
}

// The rotation's state in the deploy-only vault: the enabled CA
// certificates, read by name, and which secrets the list shows. `lenient`
// (for the status) records a certificate it cannot take in `problems`
// instead of throwing.
function readCaState(t, vault, { lenient = false } = {}) {
  const listed = t.listSecrets(vault);
  const problems = [];
  const refuse = (message) => {
    if (!lenient) throw new Error(message);
    problems.push(message);
    return null;
  };
  const enabled = (name) => listed.get(name)?.enabled === true;
  const certificate = (name, role) => {
    if (!enabled(name)) return null;
    const pem = t.showSecret(vault, name);
    if (pem === null) return null;
    try {
      return describeCa({ role, secret: name, pem, vault });
    } catch (error) {
      return refuse(error.message);
    }
  };
  const currentEntry = listed.get(CA_CERT_SECRET);
  const current = currentEntry && !currentEntry.enabled
    ? refuse(`${CA_CERT_SECRET} in vault ${vault} is disabled; enable its latest version again.`)
    : certificate(CA_CERT_SECRET, "current");
  return {
    listed,
    enabled,
    problems,
    current,
    next: certificate(NEXT_CA_CERT_SECRET, "next"),
    previous: certificate(PREVIOUS_CA_CERT_SECRET, "previous"),
  };
}

// The common name of a new CA, which no trusted CA shares, so no client ever
// has to choose between two CAs of one name.
function newCaCommonName(now, taken) {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const names = new Set(taken);
  let name = `${CA_COMMON_NAME} ${day}`;
  for (let n = 2; names.has(name); n++) name = `${CA_COMMON_NAME} ${day}-${n}`;
  return name;
}

const commonNameOf = (certificate) => /^CN=(.*)$/m.exec(certificate.subject)?.[1] ?? "";

/**
 * The trusted CA set and its bundle, read from the deploy-only vault without
 * writing anything or reading a key: for the workers' userData before
 * base-infra, and for the rotation's checks. Returns { trustedCas, caBundle },
 * or null while the vault holds no CA.
 */
export function readTrustedCas({ deployVaultName }, { runFn = run, now = () => Date.now(), log = defaultLog } = {}) {
  const state = readCaState(tools(runFn), deployVaultName);
  if (!state.current) return null;
  const trusted = trustedSet({ ...state, vault: deployVaultName, now: now(), warn: (message) => log("warn", `[disk-controller-tls] ${message}`) });
  return { trustedCas: trusted.map((ca) => ca.public), caBundle: caBundle(trusted.map((ca) => ca.public.pem)) };
}

/**
 * The trusted CAs as `ca.crt` in a Secret, for the NGINX ingress's
 * `proxy-ssl-secret`, and in a ConfigMap, for the coordination host's
 * NODE_EXTRA_CA_CERTS: the bundle of one or two CA certificates. Both carry
 * only public material.
 */
export function caClusterManifest({ namespace, caPem }) {
  assertNamespace(namespace);
  const pem = `${String(caPem ?? "").trim()}\n`;
  parseCaCertificates(pem, "The CA bundle for the cluster");
  const metadata = [
    "metadata:",
    `  name: ${CA_CLUSTER_OBJECT}`,
    `  namespace: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/name: pilotswarm",
    "    app.kubernetes.io/component: disk-controller",
  ];
  return [
    "apiVersion: v1",
    "kind: Secret",
    ...metadata,
    "type: Opaque",
    "data:",
    `  ca.crt: ${Buffer.from(pem).toString("base64")}`,
    "---",
    "apiVersion: v1",
    "kind: ConfigMap",
    ...metadata,
    "data:",
    "  ca.crt: |",
    ...pem.trimEnd().split(/\r?\n/).map((line) => `    ${line}`),
    "",
  ].join("\n");
}

function privateFolder(tmpRoot) {
  const dir = mkdtempSync(join(tmpRoot, "pilotswarm-dc-tls-"));
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
}

function requestConfig(commonName, extensions) {
  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    ...(extensions ? ["x509_extensions = ext"] : []),
    "[dn]",
    `CN = ${commonName}`,
    ...(extensions ? ["[ext]", ...extensions] : []),
    "",
  ].join("\n");
}

// A self-signed CA certificate (5 years) for the key at `keyPath`.
function issueCaCertificate(t, file, keyPath, commonName) {
  writePrivate(file("ca.cnf"), requestConfig(commonName, CA_EXTENSIONS));
  t.openssl(["req", "-x509", "-new", "-key", keyPath, "-config", file("ca.cnf"), "-sha256", "-days", String(CA_DAYS),
    "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-out", file("ca.crt")], "create the CA's certificate");
  return readFileSync(file("ca.crt"), "utf8");
}

// The stored leaf's end, or null when no leaf can be read.
function leafNotAfter(bundlePem) {
  try {
    return Date.parse(new X509Certificate((String(bundlePem ?? "").match(CERTIFICATE) ?? [])[0]).validTo);
  } catch {
    return null;
  }
}

/**
 * Makes sure the CA and a current leaf exist, and returns the trusted CA set
 * for the deployment's trust stores (worker VMs, App Gateway's trusted roots,
 * the NGINX proxy secret and the coordination host).
 *
 * Inputs: { namespace, stampVaultName, stampVaultResourceId, deployVaultName,
 * controllerPrincipalId, workerPortIp }. Returns { caPem, caCreated,
 * leafRenewed, reason, trustedCas, caBundle }: caPem is the current CA's
 * certificate; trustedCas lists the trusted CAs, current first, as
 * { role, secret, subject, fingerprint, notBefore, notAfter, pem, der }; and
 * caBundle is their PEM bundle.
 */
export function ensureDiskControllerTls(inputs, { runFn = run, now = () => Date.now(), tmpRoot = tmpdir(), log = defaultLog } = {}) {
  for (const key of ["namespace", "stampVaultName", "stampVaultResourceId", "deployVaultName", "controllerPrincipalId"]) {
    if (!inputs?.[key]) throw new Error(`The disk controller's TLS step needs ${key}.`);
  }
  const identity = leafIdentity(inputs);
  const deployVault = inputs.deployVaultName;
  const stampVault = inputs.stampVaultName;
  const t = tools(runFn);

  const dir = privateFolder(tmpRoot);
  const file = (name) => join(dir, name);
  try {
    const state = readCaState(t, deployVault);
    let caPem = state.current?.public.pem ?? null;
    let caKey = null;
    let caCreated = false;
    if (!caPem) {
      const keyEntry = state.listed.get(CA_KEY_SECRET);
      if (keyEntry && !keyEntry.enabled) throw new Error(`${CA_KEY_SECRET} in vault ${deployVault} is disabled; enable its latest version again.`);
      if (keyEntry) {
        // A first deploy that stopped between its two writes, or a lost
        // certificate: the same key and name make a certificate that
        // whatever trusted the old one still accepts.
        caKey = t.showSecret(deployVault, CA_KEY_SECRET);
        if (!caKey) throw new Error(`Vault ${deployVault} lists ${CA_KEY_SECRET} but returns no value for it.`);
        writePrivate(file("ca.key"), caKey);
        log("warn", `[disk-controller-tls] vault ${deployVault} holds the CA's key but not its certificate; issuing the certificate again from that key`);
      } else {
        t.openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:4096", "-out", file("ca.key")], "create the CA's key");
        t.setSecret(deployVault, CA_KEY_SECRET, file("ca.key"));
        caKey = readFileSync(file("ca.key"), "utf8");
        caCreated = true;
      }
      caPem = issueCaCertificate(t, file, file("ca.key"), CA_COMMON_NAME);
      t.setSecret(deployVault, CA_CERT_SECRET, file("ca.crt"));
      if (caCreated) log("ok", `[disk-controller-tls] created the controller's private CA in vault ${deployVault}`);
    }
    const current = describeCa({ role: "current", secret: CA_CERT_SECRET, pem: caPem, vault: deployVault });
    const ca = current.certificate;
    const trusted = trustedSet({
      current, next: state.next, previous: state.previous, vault: deployVault, now: now(),
      warn: (message) => log("warn", `[disk-controller-tls] ${message}`),
    });
    const caLeft = Date.parse(ca.validTo) - now();
    const caDaysLeft = Math.floor(caLeft / DAY_MS);
    const caEnd = caLeft <= 0 ? `expired ${Math.floor(-caLeft / DAY_MS)} days ago` : `expires in ${caDaysLeft} days`;
    if (caDaysLeft < LEAF_DAYS + RENEW_BEFORE_DAYS) {
      log("warn", state.next
        ? `[disk-controller-tls] the controller's CA ${caEnd}; its rotation has started: promote the next CA once every trust store holds it`
        : `[disk-controller-tls] the controller's CA ${caEnd}; plan its rotation (deploy/providers/azure/disk-controller/README.md, "Rotating the CA")`);
    }

    const storedLeaf = t.showSecret(stampVault, LEAF_SECRET);
    const reason = leafRenewalReason({ bundlePem: storedLeaf, caPem, identity, now: now() });
    let renew = Boolean(reason);
    if (renew && caDaysLeft <= RENEW_BEFORE_DAYS) {
      // The next CA signs nothing before it is promoted. Until then a leaf
      // that still serves stays, so a deploy can still carry the next CA to
      // the trust stores.
      const leafServes = leafNotAfter(storedLeaf) > now();
      if (state.next && /^the leaf expires in /.test(reason) && leafServes) {
        log("warn", `[disk-controller-tls] ${reason}, and the current CA is too near its end to sign another; promote the next CA before then`);
        renew = false;
      } else if (state.next) {
        // Nothing trusts the controller now: promote is the way forward,
        // with --force while a trust store still lacks the next CA.
        throw new Error(
          `The controller's CA ${caEnd}, too soon to sign a leaf, and ${leafServes ? reason : "the stored leaf no longer serves"}: ` +
            "promote the next CA now (`npm run deploy:rotate-ca -- <env> promote`, with --force while a trust store still lacks it), then deploy again.",
        );
      } else {
        throw new Error(
          `The controller's CA ${caEnd}, too soon to sign a leaf; rotate the CA first ` +
            "(`npm run deploy:rotate-ca -- <env> start`; deploy/providers/azure/disk-controller/README.md, \"Rotating the CA\").",
        );
      }
    }
    if (renew) {
      if (caKey === null) {
        const keyEntry = state.listed.get(CA_KEY_SECRET);
        if (keyEntry && !keyEntry.enabled) throw new Error(`${CA_KEY_SECRET} in vault ${deployVault} is disabled; enable its latest version again.`);
        caKey = keyEntry ? t.showSecret(deployVault, CA_KEY_SECRET) : null;
        if (!caKey) {
          throw new Error(`Vault ${deployVault} holds no ${CA_KEY_SECRET} to sign the leaf with; recover the deleted secret, or rotate the CA.`);
        }
        writePrivate(file("ca.key"), caKey);
      }
      if (!ca.checkPrivateKey(createPrivateKey(caKey))) throw new Error(`${CA_KEY_SECRET} does not belong to ${CA_CERT_SECRET}.`);
      writePrivate(file("ca.crt"), caPem);
      const days = Math.min(LEAF_DAYS, caDaysLeft - 1);
      t.openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", file("leaf.key")], "create the leaf's key");
      writePrivate(file("leaf.cnf"), requestConfig(identity.commonName));
      t.openssl(["req", "-new", "-key", file("leaf.key"), "-config", file("leaf.cnf"), "-out", file("leaf.csr")], "create the leaf's request");
      // The authority key identifier names the signing CA's key, so a client
      // that trusts two CAs finds the issuer without guessing.
      writePrivate(file("leaf.ext"), [
        `subjectAltName = ${identity.names.join(",")}`,
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "authorityKeyIdentifier = keyid:always",
        "",
      ].join("\n"));
      t.openssl(["x509", "-req", "-in", file("leaf.csr"), "-CA", file("ca.crt"), "-CAkey", file("ca.key"),
        "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-days", String(days), "-sha256", "-extfile", file("leaf.ext"),
        "-out", file("leaf.crt")], "sign the leaf");
      const shown = alternativeNames(t.openssl(["x509", "-in", file("leaf.crt"), "-noout", "-ext", "subjectAltName"], "read the leaf's names"));
      if (JSON.stringify(shown) !== JSON.stringify([...identity.names].sort())) {
        throw new Error(`The signed leaf names ${shown.join(", ") || "nothing"}, not ${identity.names.join(", ")}.`);
      }
      const leafPem = readFileSync(file("leaf.crt"), "utf8");
      const leafKey = readFileSync(file("leaf.key"), "utf8");
      const leaf = new X509Certificate(leafPem);
      if (!leaf.verify(ca.publicKey) || !leaf.checkPrivateKey(createPrivateKey(leafKey))) throw new Error("The signed leaf does not verify.");
      writePrivate(file("bundle.pem"), `${leafPem.trim()}\n${caPem.trim()}\n${leafKey.trim()}\n`);
      t.setSecret(stampVault, LEAF_SECRET, file("bundle.pem"));
      log("ok", `[disk-controller-tls] issued the controller's leaf certificate (${reason}), valid ${days} days`);
    }

    const grant = runFn("az", ["role", "assignment", "create",
      "--assignee-object-id", inputs.controllerPrincipalId,
      "--assignee-principal-type", "ServicePrincipal",
      "--role", "Key Vault Secrets User",
      "--scope", `${inputs.stampVaultResourceId}/secrets/${LEAF_SECRET}`,
      "--output", "none"], { capture: true, allowFail: true });
    if (grant.status !== 0 && !/RoleAssignmentExists|already exists/i.test(String(grant.stderr ?? ""))) {
      throw new Error(`Could not grant the controller's identity read access to ${LEAF_SECRET}: ${firstLine(grant.stderr) || `exit ${grant.status}`}`);
    }
    return {
      caPem: current.public.pem,
      caCreated,
      leafRenewed: renew,
      reason: renew ? reason : null,
      trustedCas: trusted.map((entry) => entry.public),
      caBundle: caBundle(trusted.map((entry) => entry.public.pem)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Applies caClusterManifest with kubectl, from a private temporary file. */
export function applyCaToCluster({ namespace, caPem }, { runFn = run, tmpRoot = tmpdir(), kubeEnv } = {}) {
  const manifest = caClusterManifest({ namespace, caPem });
  const dir = privateFolder(tmpRoot);
  try {
    const path = join(dir, "ca.yaml");
    writePrivate(path, manifest);
    const result = runFn("kubectl", ["apply", "--filename", path], { capture: true, allowFail: true, ...(kubeEnv ? { env: kubeEnv } : {}) });
    if (result.status !== 0) throw new Error(`Could not apply ${CA_CLUSTER_OBJECT}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── The CA rotation (README, "Rotating the CA") ───

const promoteUnfinished = (vault) =>
  `Vault ${vault} holds both ${NEXT_CA_CERT_SECRET} and ${PREVIOUS_CA_CERT_SECRET}: a promote of the controller's CA stopped before ` +
  "it ended. Run `npm run deploy:rotate-ca -- <env> promote` again to finish it.";

/**
 * The rotation's state, certificates only, never a key: { phase, current,
 * next, nextKey, previous, trustedCas, caBundle, problem }. `phase` is
 * "none", "started" (a next CA is trusted), "promoting" (a promote stopped
 * part-way) or "promoted" (the previous CA is still trusted); `problem` says
 * why no trust store could take the set now, or is null.
 */
export function caRotationStatus({ deployVaultName }, { runFn = run, now = () => Date.now() } = {}) {
  const state = readCaState(tools(runFn), deployVaultName, { lenient: true });
  const phase = state.next && state.previous ? "promoting" : state.next ? "started" : state.previous ? "promoted" : "none";
  let trusted = null;
  let problem = state.problems[0] ?? (state.current ? null : `Vault ${deployVaultName} holds no ${CA_CERT_SECRET} yet.`);
  if (!problem) {
    try {
      trusted = trustedSet({ ...state, vault: deployVaultName, now: now() });
    } catch (error) {
      problem = error.message;
    }
  }
  return {
    phase,
    current: state.current?.public ?? null,
    next: state.next?.public ?? null,
    nextKey: state.enabled(NEXT_CA_KEY_SECRET),
    previous: state.previous?.public ?? null,
    trustedCas: trusted?.map((ca) => ca.public) ?? null,
    caBundle: trusted ? caBundle(trusted.map((ca) => ca.public.pem)) : null,
    problem,
  };
}

/**
 * Starts a rotation: makes the next CA (RSA 4096, 5 years) with a common
 * name of its own, as NEXT_CA_KEY_SECRET, then NEXT_CA_CERT_SECRET. It signs
 * nothing until it is promoted; the next deploy puts it in every trust
 * store. With a next CA there already, reports it and changes nothing.
 * Returns { created, next }.
 */
export function startCaRotation({ deployVaultName }, { runFn = run, now = () => Date.now(), tmpRoot = tmpdir(), log = defaultLog } = {}) {
  const t = tools(runFn);
  const vault = deployVaultName;
  const state = readCaState(t, vault);
  if (!state.current) throw new Error(`Vault ${vault} holds no ${CA_CERT_SECRET} yet: the disk-controller service's deploy makes the controller's CA.`);
  if (state.next && state.previous) throw new Error(promoteUnfinished(vault));
  if (state.previous) {
    throw new Error(
      `Vault ${vault} still trusts the previous CA (${PREVIOUS_CA_CERT_SECRET}): finish the last rotation first ` +
        "(`npm run deploy:rotate-ca -- <env> finish`), so that no more than two CAs are ever trusted.",
    );
  }
  if (state.next) {
    if (!state.enabled(NEXT_CA_KEY_SECRET)) {
      throw new Error(`Vault ${vault} holds ${NEXT_CA_CERT_SECRET} without ${NEXT_CA_KEY_SECRET}: disable ${NEXT_CA_CERT_SECRET}, then start again.`);
    }
    log("info", `[disk-controller-tls] the next CA exists already: ${state.next.public.subject}, SHA-256 ${state.next.fingerprint}`);
    return { created: false, next: state.next.public };
  }
  const dir = privateFolder(tmpRoot);
  const file = (name) => join(dir, name);
  try {
    // A new key each time: a key that an interrupted start left without its
    // certificate has signed nothing, and making another reads no key.
    t.openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:4096", "-out", file("ca.key")], "create the next CA's key");
    t.setSecret(vault, NEXT_CA_KEY_SECRET, file("ca.key"));
    const pem = issueCaCertificate(t, file, file("ca.key"), newCaCommonName(now(), [commonNameOf(state.current.certificate)]));
    const next = describeCa({ role: "next", secret: NEXT_CA_CERT_SECRET, pem, vault });
    if (!next.certificate.checkPrivateKey(createPrivateKey(readFileSync(file("ca.key"), "utf8")))) {
      throw new Error("The next CA's certificate does not belong to its key.");
    }
    t.setSecret(vault, NEXT_CA_CERT_SECRET, file("ca.crt"));
    log("ok", `[disk-controller-tls] created the next CA in vault ${vault}: ${next.public.subject}, SHA-256 ${next.fingerprint}`);
    return { created: true, next: next.public };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Promotes the next CA, in writes that a run after an interruption picks up:
 *
 *   1. the previous CA's certificate := the current one;
 *   2. the current key, then the current certificate := the next CA's;
 *   3. the next key, then the next certificate, disabled;
 *   4. a leaf from the new CA, at once (ensureDiskControllerTls: "another CA
 *      signed the stored leaf").
 *
 * The next certificate is the last to go, so while it is enabled beside a
 * previous one, the promote has not ended. Before the first write, promote
 * makes sure the next CA can sign a leaf and that its key is listed, enabled,
 * a private key and the next certificate's, and refuses otherwise with
 * nothing written; and `check({ next, caBundle })` returns the deployment's
 * failed preconditions as [{ name, detail }], any of which refuses the
 * promote unless `force`. A run that resumes skips those preconditions and
 * only completes the remaining writes: it never copies the new CA into the
 * previous one. Inputs are ensureDiskControllerTls's. Returns { promoted,
 * resumed, forced, failures, next, tls }.
 */
export function promoteCaRotation(inputs, {
  runFn = run, now = () => Date.now(), tmpRoot = tmpdir(), log = defaultLog, force = false, check = () => [],
} = {}) {
  const t = tools(runFn);
  const vault = inputs?.deployVaultName;
  if (!vault) throw new Error("The disk controller's TLS step needs deployVaultName.");
  const tlsOptions = { runFn, now, tmpRoot, log };
  const { current, next, previous, enabled, listed: secrets } = readCaState(t, vault);
  if (!current) throw new Error(`Vault ${vault} holds no ${CA_CERT_SECRET}: there is no CA to promote from.`);
  if (!next) {
    if (!previous) throw new Error("No rotation of the controller's CA has started: run `npm run deploy:rotate-ca -- <env> start` first.");
    // Promoted already, or stopped after step 3: only the leaf may be left.
    log("info", "[disk-controller-tls] the next CA is promoted already; making sure the leaf is the current CA's");
    return { promoted: false, resumed: true, forced: false, failures: [], next: current.public, tls: ensureDiskControllerTls(inputs, tlsOptions) };
  }
  const copied = previous?.fingerprint === current.fingerprint;
  const moved = current.fingerprint === next.fingerprint;
  if (previous && !copied && !moved) {
    throw new Error(`Vault ${vault} still trusts the previous CA of an earlier rotation: finish that rotation first.`);
  }
  if (moved && !previous) {
    throw new Error(
      `Vault ${vault} holds the next CA as its current one, but no ${PREVIOUS_CA_CERT_SECRET}: the former CA is no longer known. ` +
        `Write it back as ${PREVIOUS_CA_CERT_SECRET} from an older version of ${CA_CERT_SECRET}, then run promote again.`,
    );
  }
  const resumed = copied || moved;
  // Everything promote needs is checked before its first write: a promote
  // that wrote the previous CA and then stopped on the next one's key would
  // hold every deploy until it completed. The next CA must be able to sign a
  // leaf, and while its key has not moved, the key must be listed and
  // enabled (from the list, which reads no value)...
  if (!moved) {
    const nextLeft = Date.parse(next.certificate.validTo) - now();
    if (nextLeft <= RENEW_BEFORE_DAYS * DAY_MS) {
      throw new Error(
        `${NEXT_CA_CERT_SECRET} in vault ${vault} ${nextLeft <= 0 ? "expired" : "expires"} on ${next.public.notAfter}, too soon to sign a leaf: ` +
          (resumed
            ? `disable ${NEXT_CA_CERT_SECRET}, ${NEXT_CA_KEY_SECRET} and ${PREVIOUS_CA_CERT_SECRET} (which holds the current CA), then start the rotation again.`
            : `disable ${NEXT_CA_CERT_SECRET} and ${NEXT_CA_KEY_SECRET}, then start the rotation again.`),
      );
    }
    const keyEntry = secrets.get(NEXT_CA_KEY_SECRET);
    if (!keyEntry) {
      throw new Error(`Vault ${vault} holds ${NEXT_CA_CERT_SECRET} without ${NEXT_CA_KEY_SECRET}: ` +
        (resumed ? `restore ${NEXT_CA_KEY_SECRET}, then run promote again to finish it.` : `disable ${NEXT_CA_CERT_SECRET}, then start the rotation again.`));
    }
    if (!keyEntry.enabled) {
      throw new Error(`${NEXT_CA_KEY_SECRET} in vault ${vault} is disabled: enable its latest version again` +
        (resumed ? ", then run promote again to finish it." : `, or disable ${NEXT_CA_CERT_SECRET} too and start the rotation again.`));
    }
  }
  let failures = [];
  if (resumed) {
    log("info", "[disk-controller-tls] a promote stopped part-way; completing its remaining writes");
  } else {
    failures = check({ next: next.public, caBundle: caBundle([current.public.pem, next.public.pem]) }) ?? [];
    const summary = failures.map((failure) => `  - ${failure.name}: ${failure.detail}`).join("\n");
    if (failures.length > 0 && !force) {
      throw new Error(`Not promoting the next CA:\n${summary}\nRun promote again once these hold; --force promotes anyway.`);
    }
    if (failures.length > 0) {
      log("warn", `[disk-controller-tls] PROMOTING WITH --force: every client that lacks the next CA will refuse the controller's new leaf.\n${summary}`);
    }
  }
  // ...and then it must be a private key that belongs to the next CA.
  let key = null;
  if (!moved) {
    const fix = resumed
      ? `restore the version of ${NEXT_CA_KEY_SECRET} that belongs to it, then run promote again to finish it`
      : "disable both, then start the rotation again";
    key = t.showSecret(vault, NEXT_CA_KEY_SECRET);
    let privateKey = null;
    try {
      privateKey = createPrivateKey(String(key ?? ""));
    } catch {
      throw new Error(`${NEXT_CA_KEY_SECRET} in vault ${vault} is not a private key: ${fix}.`);
    }
    if (!next.certificate.checkPrivateKey(privateKey)) {
      throw new Error(`${NEXT_CA_KEY_SECRET} does not belong to ${NEXT_CA_CERT_SECRET} in vault ${vault}: ${fix}.`);
    }
  }
  const dir = privateFolder(tmpRoot);
  const file = (name) => join(dir, name);
  try {
    if (!resumed) {
      writePrivate(file("previous.crt"), current.public.pem);
      t.setSecret(vault, PREVIOUS_CA_CERT_SECRET, file("previous.crt"));
    }
    if (!moved) {
      writePrivate(file("ca.key"), key);
      writePrivate(file("ca.crt"), next.public.pem);
      // The key first: once the current certificate is the next one, both have moved.
      t.setSecret(vault, CA_KEY_SECRET, file("ca.key"));
      t.setSecret(vault, CA_CERT_SECRET, file("ca.crt"));
    }
    if (enabled(NEXT_CA_KEY_SECRET)) t.disableSecret(vault, NEXT_CA_KEY_SECRET);
    t.disableSecret(vault, NEXT_CA_CERT_SECRET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log("ok", `[disk-controller-tls] promoted the next CA: ${next.public.subject}, SHA-256 ${next.fingerprint}; the former CA stays trusted as the previous one`);
  return { promoted: true, resumed, forced: failures.length > 0, failures, next: next.public, tls: ensureDiskControllerTls(inputs, tlsOptions) };
}

/**
 * When the stored leaf's newest version was written, as milliseconds, from
 * its versions' attributes (no value is read); null without a leaf.
 */
export function leafWrittenAt({ stampVaultName }, { runFn = run } = {}) {
  const versions = JSON.parse(tools(runFn).az(["keyvault", "secret", "list-versions", "--vault-name", stampVaultName, "--name", LEAF_SECRET,
    "--output", "json"], `list the versions of ${LEAF_SECRET} in vault ${stampVaultName}`) || "[]");
  const times = (Array.isArray(versions) ? versions : [])
    .filter((version) => version?.attributes?.enabled !== false)
    .map((version) => Date.parse(version?.attributes?.created ?? ""))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Finishes a rotation: disables the previous CA's certificate, which the
 * trust stores drop at the next deploy. Refuses while a promote is
 * unfinished or the stored leaf is not the current CA's; `check({ current,
 * previous })` returns the deployment's own failed conditions (the controller
 * serves that leaf), which only `force` overrides. Without a previous CA it
 * does nothing. Returns { finished, previous, forced, failures }.
 */
export function finishCaRotation({ deployVaultName, stampVaultName }, { runFn = run, log = defaultLog, force = false, check = () => [] } = {}) {
  const t = tools(runFn);
  const { current, next, previous } = readCaState(t, deployVaultName);
  if (next && previous) throw new Error(promoteUnfinished(deployVaultName));
  if (next) throw new Error("The next CA is not promoted yet: promote it before finishing the rotation.");
  if (!previous) {
    log("info", "[disk-controller-tls] no previous CA is trusted: there is no rotation to finish");
    return { finished: false, previous: null, forced: false, failures: [] };
  }
  const bundle = t.showSecret(stampVaultName, LEAF_SECRET);
  let leaf = null;
  try {
    leaf = new X509Certificate((String(bundle ?? "").match(CERTIFICATE) ?? [])[0]);
  } catch {
    leaf = null;
  }
  if (!leaf?.checkIssued(current.certificate) || !leaf.verify(current.certificate.publicKey)) {
    throw new Error(`${LEAF_SECRET} in vault ${stampVaultName} is not the current CA's leaf yet: run promote again, which issues it, before finishing.`);
  }
  const failures = check({ current: current.public, previous: previous.public }) ?? [];
  const listed = failures.map((failure) => `  - ${failure.name}: ${failure.detail}`).join("\n");
  if (failures.length > 0 && !force) throw new Error(`Not finishing the rotation:\n${listed}\nRun finish again once these hold; --force finishes anyway.`);
  if (failures.length > 0) log("warn", `[disk-controller-tls] FINISHING WITH --force: a client may still be served the previous CA's leaf.\n${listed}`);
  t.disableSecret(deployVaultName, PREVIOUS_CA_CERT_SECRET);
  log("ok", `[disk-controller-tls] the previous CA (${previous.public.subject}) is no longer trusted; the next deploy drops it from every trust store`);
  return { finished: true, previous: previous.public, forced: failures.length > 0, failures };
}
