// Test helpers for the TLS step and the controller's listeners: a small X.509
// builder on node:crypto, so tests make real certificates without openssl,
// and fakes of the openssl and Azure CLI commands that the TLS step runs and
// of App Gateway's trusted roots, which hold the CAs for the dispatcher.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DAY_MS = 86_400_000;
export const FAKE_VAULT_HOST = "https://test-vault.vault.azure.net";

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = (buffer) => tlv(0x04, buffer);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
// DER needs the minimal two's-complement form: no redundant leading zero
// byte, and a zero byte in front of a set high bit, which keeps it positive.
function integer(buffer) {
  let start = 0;
  while (start < buffer.length - 1 && buffer[start] === 0 && !(buffer[start + 1] & 0x80)) start++;
  const value = buffer.subarray(start);
  return tlv(0x02, value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const NULL = Buffer.from([0x05, 0x00]);

function oid(dotted) {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  const year = d.getUTCFullYear();
  return year >= 2050 ? tlv(0x18, Buffer.from(`${year}${rest}`)) : tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`));
}

const name = (commonName) => seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const bits = (unused, byte) => tlv(0x03, Buffer.from([unused, byte]));

function alternativeName(entry) {
  if (entry.startsWith("DNS:")) return tlv(0x82, Buffer.from(entry.slice(4)));
  if (entry.startsWith("IP:")) return tlv(0x87, Buffer.from(entry.slice(3).split(".").map(Number)));
  throw new Error(`unsupported name ${entry}`);
}

export function toPem(label, der) {
  const body = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** An RSA key pair, with the private key as PKCS#8 PEM. */
export function createKey(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return { privateKey, publicKey, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

/**
 * A certificate as PEM, signed with SHA-256 and `signingKey`: a CA
 * (basicConstraints CA:TRUE, keyCertSign) or a server leaf with `names`
 * (`IP:` and `DNS:` entries).
 */
export function createCertificate({ subject, issuer = subject, publicKey, signingKey, notBefore, notAfter, ca = false, names = [] }) {
  const algorithm = seq(oid("1.2.840.113549.1.1.11"), NULL);
  const extensions = ca
    ? [
      extension("2.5.29.19", true, seq(bool(true), integer(Buffer.from([0])))),
      extension("2.5.29.15", true, bits(1, 0x06)),
    ]
    : [
      extension("2.5.29.19", true, seq()),
      extension("2.5.29.15", true, bits(5, 0xa0)),
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
      ...(names.length ? [extension("2.5.29.17", false, seq(...names.map(alternativeName)))] : []),
    ];
  const spki = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    algorithm,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    spki.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign("sha256", tbs, signingKey);
  return toPem("CERTIFICATE", seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

/** A CA and a leaf it signed, for serving tests. */
export function createTestPki({ now = Date.now(), names = ["IP:127.0.0.1", "DNS:localhost"], commonName = "localhost", leafDays = 365, caName = "Test CA" } = {}) {
  const caKey = createKey();
  const caPem = createCertificate({ subject: caName, publicKey: caKey.publicKey, signingKey: caKey.privateKey, notBefore: now - DAY_MS, notAfter: now + 1826 * DAY_MS, ca: true });
  const issueLeaf = ({ leafNames = names, leafCommonName = commonName, days = leafDays } = {}) => {
    const key = createKey();
    const pem = createCertificate({
      subject: leafCommonName, issuer: caName, publicKey: key.publicKey, signingKey: caKey.privateKey,
      notBefore: now - DAY_MS, notAfter: now + days * DAY_MS, names: leafNames,
    });
    return { pem, keyPem: key.privateKeyPem, bundle: `${pem.trim()}\n${caPem.trim()}\n${key.privateKeyPem.trim()}\n` };
  };
  return { caPem, caKeyPem: caKey.privateKeyPem, issueLeaf };
}

function option(args, flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * Answers the TLS step's openssl commands with node:crypto and the builder
 * above. Keys are 2048-bit whatever the command asks, to keep tests fast.
 */
export function createFakeOpenssl({ now = () => Date.now() } = {}) {
  const calls = [];
  const commonName = (path) => /^CN\s*=\s*(.+)$/m.exec(readFileSync(path, "utf8"))?.[1].trim();
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const openssl = (args) => {
    calls.push(args);
    const [command] = args;
    if (command === "genpkey") {
      writeFileSync(option(args, "-out"), createKey().privateKeyPem);
      return ok();
    }
    if (command === "req" && args.includes("-x509")) {
      const key = createPrivateKey(readFileSync(option(args, "-key"), "utf8"));
      const config = readFileSync(option(args, "-config"), "utf8");
      writeFileSync(option(args, "-out"), createCertificate({
        subject: commonName(option(args, "-config")), publicKey: key, signingKey: key, ca: /CA:TRUE/.test(config),
        notBefore: now(), notAfter: now() + Number(option(args, "-days")) * DAY_MS,
      }));
      return ok();
    }
    if (command === "req") {
      const key = createPrivateKey(readFileSync(option(args, "-key"), "utf8"));
      writeFileSync(option(args, "-out"), JSON.stringify({
        commonName: commonName(option(args, "-config")),
        publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }),
      }));
      return ok();
    }
    if (command === "x509" && args.includes("-req")) {
      const request = JSON.parse(readFileSync(option(args, "-in"), "utf8"));
      const ca = new X509Certificate(readFileSync(option(args, "-CA"), "utf8"));
      const names = /^subjectAltName\s*=\s*(.+)$/m.exec(readFileSync(option(args, "-extfile"), "utf8"))[1].split(",").map((entry) => entry.trim());
      writeFileSync(option(args, "-out"), createCertificate({
        subject: request.commonName, issuer: /CN=(.+)/.exec(ca.subject)[1], publicKey: request.publicKey,
        signingKey: createPrivateKey(readFileSync(option(args, "-CAkey"), "utf8")),
        notBefore: now(), notAfter: now() + Number(option(args, "-days")) * DAY_MS, names,
      }));
      return ok();
    }
    if (command === "x509" && args.includes("-ext")) {
      const certificate = new X509Certificate(readFileSync(option(args, "-in"), "utf8"));
      return ok(`X509v3 Subject Alternative Name: \n    ${certificate.subjectAltName}\n`);
    }
    return { status: 1, stdout: "", stderr: `fake openssl does not know ${args.join(" ")}` };
  };
  return { openssl, calls };
}

/**
 * Answers the TLS step's Azure CLI commands from in-memory vaults. A secret
 * keeps one value; `disabled(vault)` holds the names whose latest version is
 * disabled, which `show` refuses as Key Vault does, and which the next `set`
 * enables again with a new version. `written(vault)` keeps each secret's
 * last write time, from `now`.
 */
export function createFakeAz({ now = () => Date.now() } = {}) {
  const vaults = new Map();
  const disabledNames = new Map();
  const writes = new Map();
  const events = [];
  let grantAnswer = { status: 0, stdout: "", stderr: "" };
  const vault = (vaultName) => {
    if (!vaults.has(vaultName)) vaults.set(vaultName, new Map());
    return vaults.get(vaultName);
  };
  const disabled = (vaultName) => {
    if (!disabledNames.has(vaultName)) disabledNames.set(vaultName, new Set());
    return disabledNames.get(vaultName);
  };
  const written = (vaultName) => {
    if (!writes.has(vaultName)) writes.set(vaultName, new Map());
    return writes.get(vaultName);
  };
  const notFound = (secretName) => ({ status: 3, stdout: "", stderr: `ERROR: (SecretNotFound) A secret with (name/id) ${secretName} was not found in this key vault.\n` });
  const az = (args) => {
    if (args[0] === "keyvault" && args[1] === "secret") {
      const vaultName = option(args, "--vault-name");
      const secretName = option(args, "--name");
      if (args[2] === "show") {
        events.push(`read ${vaultName}/${secretName}`);
        const value = vault(vaultName).get(secretName);
        if (value === undefined) return notFound(secretName);
        if (disabled(vaultName).has(secretName)) {
          return { status: 1, stdout: "", stderr: "ERROR: (Forbidden) Operation get is not allowed on a disabled secret.\n" };
        }
        return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
      }
      if (args[2] === "list") {
        events.push(`list ${vaultName}`);
        const items = [...vault(vaultName).keys()].map((name) => ({
          id: `${FAKE_VAULT_HOST}/secrets/${name}`,
          name,
          attributes: { enabled: !disabled(vaultName).has(name), created: new Date(written(vaultName).get(name) ?? 0).toISOString() },
          contentType: "application/x-pem-file",
        }));
        return { status: 0, stdout: JSON.stringify(items), stderr: "" };
      }
      if (args[2] === "list-versions") {
        events.push(`versions ${vaultName}/${secretName}`);
        if (!vault(vaultName).has(secretName)) return notFound(secretName);
        const created = new Date(written(vaultName).get(secretName) ?? 0).toISOString();
        return { status: 0, stdout: JSON.stringify([{ id: `${FAKE_VAULT_HOST}/secrets/${secretName}/v1`, attributes: { enabled: true, created } }]), stderr: "" };
      }
      if (args[2] === "set") {
        events.push(`write ${vaultName}/${secretName}`);
        vault(vaultName).set(secretName, readFileSync(option(args, "--file"), "utf8"));
        disabled(vaultName).delete(secretName);
        written(vaultName).set(secretName, now());
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[2] === "set-attributes") {
        const enable = option(args, "--enabled");
        events.push(`${enable === "false" ? "disable" : "enable"} ${vaultName}/${secretName}`);
        if (!vault(vaultName).has(secretName)) return notFound(secretName);
        if (enable === "false") disabled(vaultName).add(secretName);
        else disabled(vaultName).delete(secretName);
        return { status: 0, stdout: "", stderr: "" };
      }
    }
    if (args[0] === "role" && args[1] === "assignment" && args[2] === "create") {
      events.push(`grant ${option(args, "--role")} ${option(args, "--scope")} ${option(args, "--assignee-object-id")}`);
      return grantAnswer;
    }
    return { status: 2, stdout: "", stderr: `fake az does not know ${args.join(" ")}` };
  };
  return {
    az,
    events,
    vault,
    disabled,
    written,
    // The vaults' whole state, to try something and put everything back.
    snapshot() {
      return {
        vaults: new Map([...vaults].map(([name, secrets]) => [name, new Map(secrets)])),
        disabled: new Map([...disabledNames].map(([name, names]) => [name, new Set(names)])),
        writes: new Map([...writes].map(([name, times]) => [name, new Map(times)])),
      };
    },
    restore(state) {
      for (const [target, source, copy] of [[vaults, state.vaults, (v) => new Map(v)], [disabledNames, state.disabled, (v) => new Set(v)], [writes, state.writes, (v) => new Map(v)]]) {
        target.clear();
        for (const [name, value] of source) target.set(name, copy(value));
      }
    },
    answerGrant(answer) {
      grantAnswer = answer;
    },
  };
}

// The DER of a trusted root's `data`, which is the uploaded file's bytes in
// base64: PEM text or DER.
function rootDer(data) {
  const bytes = Buffer.from(String(data ?? ""), "base64");
  const text = bytes.toString("latin1");
  return text.includes("-----BEGIN CERTIFICATE-----") ? new X509Certificate(text).raw : bytes;
}

/**
 * Answers the Azure CLI's App Gateway commands for trusted roots from an
 * in-memory gateway, with the rules Azure applies: no two trusted roots hold
 * the same certificate (compared by content, whatever their names), a name is
 * created once, and a root that a backend setting names cannot be deleted.
 * `roots` maps a root's name to its `data` (base64 of the uploaded file);
 * `settings` are backend settings as { name, hostName, roots: [root names] }.
 * `az(args)` returns null for a command it does not answer.
 */
export function createFakeAppGateway({ name = "psstamp-appgw", roots = {}, settings = [] } = {}) {
  const state = {
    roots: new Map(Object.entries(roots)),
    settings: settings.map((setting) => ({ ...setting, roots: [...(setting.roots ?? [])] })),
  };
  const writes = [];
  const id = (root) => `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/stamp-rg/providers/Microsoft.Network/applicationGateways/${name}/trustedRootCertificates/${root}`;
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const refuse = (message) => ({ status: 1, stdout: "", stderr: `ERROR: ${message}\n` });
  const find = (rootName) => [...state.roots.keys()].find((key) => key.toLowerCase() === String(rootName).toLowerCase());
  const holder = (der, except) => [...state.roots].find(([key, data]) => key !== except && rootDer(data).equals(der))?.[0];
  const listRoots = () => [...state.roots].map(([key, data]) => ({ name: key, id: id(key), data }));
  const named = (rootName) => state.settings.filter((setting) => setting.roots.some((root) => root.toLowerCase() === rootName.toLowerCase()));
  const az = (args) => {
    const is = (...words) => words.every((word, i) => args[i] === word);
    const option = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
    if (is("network", "application-gateway", "show")) {
      return ok(JSON.stringify({
        name,
        trustedRootCertificates: listRoots(),
        backendHttpSettingsCollection: state.settings.map((setting) => ({
          name: setting.name,
          hostName: setting.hostName,
          trustedRootCertificates: setting.roots.map((root) => ({ id: id(root) })),
        })),
      }));
    }
    if (!is("network", "application-gateway", "root-cert")) return null;
    const verb = args[3];
    const rootName = option("--name");
    const existing = rootName === undefined ? undefined : find(rootName);
    if (verb === "list") return ok(JSON.stringify(listRoots()));
    if (verb === "show") {
      if (!existing) return refuse(`(NotFound) Trusted Root Certificate ${rootName} was not found in application gateway ${name}.`);
      return ok(option("--query") === "data" ? `${state.roots.get(existing)}\n` : `${JSON.stringify(listRoots().find((root) => root.name === existing))}\n`);
    }
    if (verb === "create" || verb === "update") {
      if (verb === "create" && existing) return refuse(`Trusted Root Certificate ${rootName} already exists in application gateway ${name}.`);
      if (verb === "update" && !existing) return refuse(`(NotFound) Trusted Root Certificate ${rootName} was not found in application gateway ${name}.`);
      const data = readFileSync(option("--cert-file")).toString("base64");
      if (holder(rootDer(data), existing)) {
        return refuse(`(ApplicationGatewayTrustedRootCertificateDuplicate) Application Gateway ${name} cannot have same certificate used across two Trusted Root Certificate elements.`);
      }
      state.roots.set(existing ?? rootName, data);
      writes.push(`${verb} ${rootName}`);
      return ok();
    }
    if (verb === "delete") {
      if (existing && named(existing).length > 0) {
        return refuse(`(ApplicationGatewayTrustedRootCertificateInUse) Trusted Root Certificate ${existing} is used by backend settings ${named(existing).map((setting) => setting.name).join(", ")}.`);
      }
      if (existing) state.roots.delete(existing);
      writes.push(`delete ${rootName}`);
      return ok();
    }
    return null;
  };
  return {
    az,
    state,
    writes,
    // The root that holds a certificate (PEM), by content, or undefined.
    holderOf: (pem) => holder(new X509Certificate(pem).raw),
  };
}
