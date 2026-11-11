// Fixtures used by the Windows worker tests: certificates (public parts
// only), a userData document, and a runner for PowerShell test drivers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(WINDOWS_DIR, "..", "..", "..", "..");

/** A self-signed CA certificate (CA:TRUE); its key was never kept. */
export const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBnzCCAUWgAwIBAgIUBf+DF2KjUDn3n3nLFmytJfyBFZQwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSVGVzdCBDb250cm9sbGVyIENBMB4XDTI2MTExMTA1NTE1NVoX
DTM2MTEwODA1NTE1NVowHTEbMBkGA1UEAwwSVGVzdCBDb250cm9sbGVyIENBMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaw2/CwECDjrWHG3h64EcpJn2ygdoKqCi
OWX8uvMtYj8aF1tCFJvUCovPJ10YBfOeupqUgeQvFpBrK2U8TPgJ0qNjMGEwHQYD
VR0OBBYEFFMnxZwVIpNRur7khlN2PBLYc6NYMB8GA1UdIwQYMBaAFFMnxZwVIpNR
ur7khlN2PBLYc6NYMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoG
CCqGSM49BAMCA0gAMEUCIQCDNGerpIQkWxbK06W9lQWmcfcxfH14dtrmhXa03u2I
TgIgDb+Uy2/vlA6DaGtaxnIy1Guk8VHsxpgmy2JYfNENN0M=
-----END CERTIFICATE-----
`;

/** A self-signed certificate that is not a CA (CA:FALSE). */
export const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBezCCASCgAwIBAgIUTBmw2slvl+MWZ9nQ8lSXxxWYMSwwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJVGVzdCBMZWFmMB4XDTI2MTExMTA1NTE1NVoXDTM2MTEwODA1
NTE1NVowFDESMBAGA1UEAwwJVGVzdCBMZWFmMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEy+KIK6yU1mNZXTG5BXQ51m21942NDMX++kSrAarYn3Nu6Ea8i0tqtchU
oNVaqYmPUNlHTW2RO2ZojAn5GG8pqKNQME4wHQYDVR0OBBYEFMaFY88nSMeOiCw2
FNpVBdWsVQUNMB8GA1UdIwQYMBaAFMaFY88nSMeOiCw2FNpVBdWsVQUNMAwGA1Ud
EwEB/wQCMAAwCgYIKoZIzj0EAwIDSQAwRgIhAOltVGA3EkwIYNli5ztZdeVW/EED
RI4odSitGbUGSEd6AiEAw3C4hipHIHzqJz0qS7+Pqjc+CyzgflkushMB/CML6k0=
-----END CERTIFICATE-----
`;

/** Two more self-signed CA certificates, for bundles; their keys were never kept. */
export const CA2_PEM = `-----BEGIN CERTIFICATE-----
MIIBojCCAUmgAwIBAgIUBAp+Nj45rM4jNMMhmw6yQNroDzkwCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUVGVzdCBDb250cm9sbGVyIENBIDIwHhcNMjYxMTExMDk0MjE0
WhcNMzYxMTA4MDk0MjE0WjAfMR0wGwYDVQQDDBRUZXN0IENvbnRyb2xsZXIgQ0Eg
MjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKHdxxybLtmwC5IjJ5PFhZP6EDTm
RkdK1Y72rkrrf1IRt/fZt2pqnB30SLNjZS4QEdZnIYPSObyy4qxAyHtIBfOjYzBh
MB0GA1UdDgQWBBSzPUq21trr+UCmpTtUHbOZYK4srTAfBgNVHSMEGDAWgBSzPUq2
1trr+UCmpTtUHbOZYK4srTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIB
BjAKBggqhkjOPQQDAgNHADBEAiBc5Db2oSySU3J0/RLTZqcsnCELlz4bhnNNXDt/
tjlMmgIgS9/6oo7V5ZlSp/BVqCa2BhL7VQ0bsSU9pkh6kIynvRY=
-----END CERTIFICATE-----
`;
export const CA3_PEM = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUmgAwIBAgIUNJLeYSXEfMnObnqMq9OT9sETjtkwCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUVGVzdCBDb250cm9sbGVyIENBIDMwHhcNMjYxMTExMDk0MjE0
WhcNMzYxMTA4MDk0MjE0WjAfMR0wGwYDVQQDDBRUZXN0IENvbnRyb2xsZXIgQ0Eg
MzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABG6jClYTG6WwdA2elTCwzvJkEki6
V2yGo0IlPrUMrGj1c/mSRFyL+RQA0DrIydY/3QuZv45zxtLoFWs2cUxrBkejYzBh
MB0GA1UdDgQWBBSksRH+FqjPYwWXDe0EE2gYIWhw/jAfBgNVHSMEGDAWgBSksRH+
FqjPYwWXDe0EE2gYIWhw/jAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIB
BjAKBggqhkjOPQQDAgNJADBGAiEA4uWbiH2XpDoikJbzI7nizCBXQM8eJnSNq8N1
0HjN4U0CIQC+CX+InBZIwdNON1wwo4pv1fLmL4ptHcls/4hBhp/2Qg==
-----END CERTIFICATE-----
`;

/** A PEM certificate with three bytes after its DER. */
function withBytesAfter(pem) {
    const der = Buffer.concat([Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64"), Buffer.from([1, 2, 3])]);
    return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * controllerCaCert values each reader must refuse, with the part of its
 * message that names the fault: three CAs, a second certificate that is not
 * a CA, text around the certificates, and a broken second certificate.
 */
export const BAD_CA_BUNDLES = Object.freeze([
    ["three certificates", `${CA_PEM}${CA2_PEM}${CA3_PEM}`, /holds 3 certificates; it takes one, or two during a CA rotation/],
    ["a second certificate that is not a CA", `${CA_PEM}${LEAF_PEM}`, /certificate 2 is not a CA certificate/],
    ["text after the certificates", `${CA_PEM}${CA2_PEM}trailing text\n`, /holds something other than PEM certificates/],
    ["text before the certificate", `note\n${CA_PEM}`, /holds something other than PEM certificates/],
    ["a key between the certificates", `${CA_PEM}-----BEGIN ${"PRIVATE"} KEY-----\nAAAA\n-----END ${"PRIVATE"} KEY-----\n${CA2_PEM}`, /holds something other than PEM certificates/],
    ["a broken second certificate", `${CA_PEM}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`, /certificate 2 is not a certificate/],
    ["a second certificate with bytes after it", `${CA_PEM}${withBytesAfter(CA2_PEM)}`, /certificate 2 is not a certificate/],
]);

export const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
export const WORKER_OID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
export const OWNER_OID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

/** Every userData value the launcher requires, valid. */
export function userDataEnv(overrides = {}) {
    return {
        DATABASE_URL: "postgresql://worker@db.example.test:5432/pilotswarm?sslmode=require",
        PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://worker@db.example.test:5432/pilotswarm?sslmode=require",
        PILOTSWARM_DB_AAD_USER: "example-worker-identity",
        AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net/",
        PS_DISK_POOL_CONTROLLER_URL: "https://10.0.0.4:3003",
        PS_DISK_CONTROLLER_TOKEN_SCOPE: "api://controller-app/.default",
        AZURE_CLIENT_ID: CLIENT_ID,
        EXPECTED_WIN_WORKER_OID: WORKER_OID,
        ARTIFACTS_CREDENTIALPROVIDER_FEED_ENDPOINTS: '{"endpointCredentials":[]}',
        WIN_WORKER_CONFIG_VERSION: "cfg-0001",
        PILOTSWARM_WORKER_OWNER_ONLY: "0",
        ...overrides,
    };
}

/** userData as IMDS returns it: base64 of the JSON document. */
export function encodeUserData(document) {
    return Buffer.from(typeof document === "string" ? document : JSON.stringify(document), "utf8").toString("base64");
}

export function userData({ env = {}, extraEnv, controllerCaCert = CA_PEM, version = 1, extra = {} } = {}) {
    return encodeUserData({ version, env: userDataEnv(env), ...(extraEnv ? { extraEnv } : {}), controllerCaCert, ...extra });
}

/** An unsigned JWT with these claims (IMDS tokens are only read, never verified, by the launcher). */
export function fakeJwt(claims) {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.signature`;
}

export function tempDir(prefix) {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

let pwshPath;
/** The pwsh executable, or null when PowerShell 7 is not installed. */
export function pwsh() {
    if (pwshPath === undefined) {
        const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true });
        pwshPath = probe.status === 0 ? "pwsh" : null;
    }
    return pwshPath;
}

/** Windows PowerShell 5.1, by its full path, on Windows only. */
export function windowsPowerShell() {
    if (process.platform !== "win32") return null;
    const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return fs.existsSync(exe) ? exe : null;
}

/**
 * The environment a service gives Windows PowerShell 5.1: without the
 * PSModulePath PowerShell 7 leaves for its children, which names module
 * folders 5.1 cannot load.
 */
export function serviceEnv(env = process.env) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
}

/**
 * Runs a PowerShell driver script (written to `dir`) and returns its exit
 * code, its output and the last JSON line it printed.
 */
export function runDriver(dir, name, script, { shell = pwsh(), env = process.env, timeoutMs = 120_000 } = {}) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, script);
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
        encoding: "utf8", env: shell === windowsPowerShell() ? serviceEnv(env) : env, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let json = null;
    for (let index = lines.length - 1; index >= 0 && json === null; index--) {
        if (!lines[index].startsWith("{") && !lines[index].startsWith("[")) continue;
        try {
            json = JSON.parse(lines[index]);
        } catch {
            // Not the result line.
        }
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", lastLine: lines.at(-1) ?? "", json };
}

/** A single-quoted PowerShell string. */
export const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** An environment for git in tests: its own global configuration, no system one. */
export function gitTestEnv(home) {
    const config = path.join(home, "gitconfig");
    fs.writeFileSync(config, [
        "[user]", "\tname = Test", "\temail = test@example.com",
        "[protocol \"file\"]", "\tallow = always",
        "[init]", "\tdefaultBranch = main",
        "[core]", "\tautocrlf = false",
        "[advice]", "\tdetachedHead = false",
        "",
    ].join("\n"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of Object.keys(env)) {
        if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_|COMMITTER_|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key) || /^COPILOT_/i.test(key)) delete env[key];
    }
    return env;
}
