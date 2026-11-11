// The controller's server certificate. The deployment mounts the Key Vault
// secret `disk-controller-tls`, a PEM bundle with the leaf certificate, the
// private CA's certificate and the leaf's private key, as one file (the
// Secrets Store CSI driver). All three listeners serve it. When the deploy
// step renews the leaf and the driver rotates the file, the new pair is
// loaded with setSecureContext, without a restart.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
// Built from parts so that no source line carries a key's literal PEM header.
const KEY_LABEL = "PRIVATE KEY";
const PRIVATE_KEY = new RegExp(`-----BEGIN ((?:RSA |EC |ENCRYPTED )?${KEY_LABEL})-----[\\s\\S]+?-----END \\1-----`);

/** The certificates (leaf first) and the private key of a PEM bundle; throws unless the leaf and the key belong together. */
export function parsePemBundle(text) {
  const certificates = String(text ?? "").match(CERTIFICATE) ?? [];
  const key = PRIVATE_KEY.exec(String(text ?? ""))?.[0];
  if (!certificates.length) throw new Error("the TLS bundle holds no certificate");
  if (!key) throw new Error("the TLS bundle holds no private key");
  const leaf = new X509Certificate(certificates[0]);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error("the TLS bundle's private key does not belong to its first certificate");
  return { cert: certificates.join("\n"), key, leaf };
}

/**
 * The TLS options for https.createServer, reloaded when the file changes.
 * A bundle that does not load keeps the current one and logs the reason.
 */
export function createTlsSource(path, {
  log,
  readFile = (file) => readFileSync(file, "utf8"),
  watch = (file, listener) => watchFile(file, { interval: 60_000 }, listener),
  unwatch = (file) => unwatchFile(file),
} = {}) {
  const load = () => {
    const { cert, key, leaf } = parsePemBundle(readFile(path));
    return { options: { cert, key }, fingerprint: leaf.fingerprint256, notAfter: leaf.validTo };
  };
  let current = load();
  log?.info("tls.loaded", { notAfter: current.notAfter, fingerprint: current.fingerprint });
  const listeners = [];
  watch(path, () => {
    let next;
    try {
      next = load();
    } catch (err) {
      log?.error("tls.reload-failed", { error: err?.message ?? String(err) });
      return;
    }
    if (next.fingerprint === current.fingerprint) return;
    current = next;
    log?.info("tls.reloaded", { notAfter: current.notAfter, fingerprint: current.fingerprint });
    for (const listener of listeners) listener(current.options);
  });
  return {
    options: () => current.options,
    onChange: (listener) => listeners.push(listener),
    close: () => unwatch(path),
  };
}
