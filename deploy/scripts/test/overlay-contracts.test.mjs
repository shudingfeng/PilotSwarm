// Regression tests for deploy/scripts/lib/overlay-contracts.mjs.
//
// The scan-based assertion below is the recurrence guard for the
// "operator only discovers the missing key when substitute-env.mjs
// fails mid-deploy" class of bug — every key in every overlay's actual
// .env file must have a documented role in the contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readFileSync as _read, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTAL_CONFIG_KEYS } from "../lib/portal-config.mjs";
import { DATABASE_INPUT_KEYS } from "../lib/database-env.mjs";
import { parseEnvFile, templateEnvPath } from "../lib/common.mjs";

import {
  OVERLAY_CONTRACTS,
  resolveOverlayKey,
  getContract,
  validateRequiredEnv,
  validateVpnGatewayCombo,
  validateSfiCombo,
  validateWinWorkersCombo,
  applyStubKeys,
  EDGE_MODES,
  TLS_SOURCES,
  DEFAULT_EDGE_MODE,
  DEFAULT_TLS_SOURCE,
  databaseOverlayOmittedKeys,
} from "../lib/overlay-contracts.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OVERLAYS_DIR = join(REPO_ROOT, "deploy", "providers", "azure", "gitops", "portal", "overlays");

function readOverlayEnvKeys(overlay) {
  const path = join(OVERLAYS_DIR, overlay, ".env");
  const raw = readFileSync(path, "utf8");
  const keys = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    keys.push(key);
  }
  return keys;
}

test("resolveOverlayKey collapses akv-selfsigned to akv", () => {
  assert.equal(
    resolveOverlayKey({ edgeMode: "afd", tlsSource: "akv-selfsigned" }),
    "afd-akv",
  );
  assert.equal(
    resolveOverlayKey({ edgeMode: "private", tlsSource: "akv-selfsigned" }),
    "private-akv",
  );
});

test("database overlay contract removes secrets and AAD-only requirements for password BYO", () => {
  assert.deepEqual(databaseOverlayOmittedKeys({
    DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "0",
  }), ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL", "PILOTSWARM_DB_AAD_USER"]);
  assert.deepEqual(databaseOverlayOmittedKeys({
    DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "true",
  }), ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL"]);
  assert.deepEqual(databaseOverlayOmittedKeys({ PILOTSWARM_USE_MANAGED_IDENTITY: "1" }), []);
});

test("resolveOverlayKey honors JS defaults when inputs are blank", () => {
  assert.equal(resolveOverlayKey({}), `${DEFAULT_EDGE_MODE}-${DEFAULT_TLS_SOURCE}`);
});

test("EDGE_MODES + TLS_SOURCES match the canonical contract universe", () => {
  assert.deepEqual([...EDGE_MODES].sort(), ["afd", "private", "public"]);
  assert.deepEqual([...TLS_SOURCES].sort(), ["akv", "akv-selfsigned", "letsencrypt"]);
});

test("OVERLAY_CONTRACTS has an entry for every (edge,tls) overlay directory", () => {
  for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv", "public-letsencrypt"]) {
    assert.ok(
      OVERLAY_CONTRACTS[overlay],
      `OVERLAY_CONTRACTS missing entry for overlay '${overlay}'`,
    );
  }
});

// Scanner: every literal key in every overlay's .env file must appear in
// exactly one role bucket. Adding a new key to an overlay .env without
// adding it to the contract fails this test.
for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv", "public-letsencrypt"]) {
  test(`overlay-contracts: '${overlay}' projects every declared portal policy key`, () => {
    const envKeys = new Set(readOverlayEnvKeys(overlay));
    assert.deepEqual(PORTAL_CONFIG_KEYS.map(({ env }) => env).filter(key => !envKeys.has(key)), []);
  });
  test(`overlay-contracts: every '${overlay}' .env key has a contract role`, () => {
    const envKeys = readOverlayEnvKeys(overlay);
    const c = OVERLAY_CONTRACTS[overlay];
    const allRoles = new Set([
      ...c.userRequiredEnvKeys,
      ...c.composedEnvKeys,
      ...c.stubKeys,
      ...c.bicepOutputKeys,
      ...c.settingKeys,
    ]);
    const missing = envKeys.filter((k) => !allRoles.has(k));
    assert.deepEqual(
      missing,
      [],
      `Overlay '${overlay}' has env keys with no role in OVERLAY_CONTRACTS: ${missing.join(", ")}.`,
    );
  });
}

test("afd-akv requires SSL_CERT_DOMAIN_SUFFIX", () => {
  assert.ok(
    OVERLAY_CONTRACTS["afd-akv"].userRequiredEnvKeys.includes("SSL_CERT_DOMAIN_SUFFIX"),
    "afd-akv must require SSL_CERT_DOMAIN_SUFFIX",
  );
});

test("PORTAL_HOSTNAME is tracked as a bicep-output on all overlays", () => {
  for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv", "public-letsencrypt"]) {
    assert.ok(
      OVERLAY_CONTRACTS[overlay].bicepOutputKeys.includes("PORTAL_HOSTNAME"),
      `${overlay} must list PORTAL_HOSTNAME in bicepOutputKeys`,
    );
  }
});

test("public ingress requires Entra auth and a valid app registration", () => {
  const env = {
    ACME_EMAIL: "operator@example.com",
    PORTAL_HOSTNAME: "portal.westus3.cloudapp.azure.com",
    PORTAL_AUTH_PROVIDER: "entra",
    PORTAL_AUTH_ENTRA_TENANT_ID: "22222222-2222-2222-2222-222222222222",
    AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222",
    PORTAL_AUTH_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  };
  assert.deepEqual(validateRequiredEnv({ edgeMode: "public", tlsSource: "letsencrypt", env }).missing, []);
  env.PORTAL_AUTH_ENTRA_CLIENT_ID = "__PS_UNSET__";
  assert.ok(validateRequiredEnv({ edgeMode: "public", tlsSource: "letsencrypt", env }).missing.includes("PORTAL_AUTH_ENTRA_CLIENT_ID"));
  env.PORTAL_AUTH_ENTRA_CLIENT_ID = "11111111-1111-1111-1111-111111111111";
  env.PORTAL_AUTH_ALLOW_UNAUTHENTICATED = "true";
  assert.ok(validateRequiredEnv({ edgeMode: "public", tlsSource: "letsencrypt", env }).missing.includes("PORTAL_AUTH_ALLOW_UNAUTHENTICATED"));
});

// === validateRequiredEnv ====================================================

test("validateRequiredEnv passes on a fully-populated afd-akv env", () => {
  const env = { SSL_CERT_DOMAIN_SUFFIX: "portal.example.com" };
  const result = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.combo, []);
});

test("validateRequiredEnv reports SSL_CERT_DOMAIN_SUFFIX missing on afd-akv", () => {
  const env = {};
  const { missing, combo } = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(missing.includes("SSL_CERT_DOMAIN_SUFFIX"));
  assert.deepEqual(combo, []);
});

test("validateRequiredEnv reports ACME_EMAIL missing on afd-letsencrypt", () => {
  const env = {};
  const { missing } = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv catches malformed ACME_EMAIL", () => {
  const env = { ACME_EMAIL: "not-an-email" };
  const { missing } = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv requires HOST/PRIVATE_DNS_ZONE/AKS_VNET_ID for private-akv", () => {
  const env = {};
  const { missing } = validateRequiredEnv({
    edgeMode: "private",
    tlsSource: "akv",
    env,
  });
  for (const k of ["HOST", "PRIVATE_DNS_ZONE", "AKS_VNET_ID"]) {
    assert.ok(missing.includes(k), `expected ${k} missing, got ${missing.join(",")}`);
  }
});

// === applyStubKeys ==========================================================

test("applyStubKeys stamps `unused` for blank stubKeys on private-akv", () => {
  const env = {};
  applyStubKeys({ edgeMode: "private", tlsSource: "akv", env });
  for (const k of [
    "FRONT_DOOR_PROFILE_NAME",
    "APPLICATION_GATEWAY_NAME",
    "SSL_CERT_DOMAIN_SUFFIX",
    "ACME_EMAIL",
  ]) {
    assert.equal(env[k], "unused", `${k} should be stubbed`);
  }
});

test("applyStubKeys stamps `unused` for blank stubKeys on afd-akv", () => {
  const env = {};
  applyStubKeys({ edgeMode: "afd", tlsSource: "akv", env });
  for (const k of ["PRIVATE_DNS_ZONE", "AKS_VNET_ID", "ACME_EMAIL"]) {
    assert.equal(env[k], "unused", `${k} should be stubbed`);
  }
});

test("applyStubKeys does not overwrite a non-empty existing value", () => {
  const env = { ACME_EMAIL: "real@example.com" };
  applyStubKeys({ edgeMode: "afd", tlsSource: "akv", env });
  assert.equal(env.ACME_EMAIL, "real@example.com");
});

test("getContract throws for an unknown overlay key", () => {
  assert.throws(
    () => getContract({ edgeMode: "nonsense", tlsSource: "letsencrypt" }),
    /no contract for resolved overlay/,
  );
});

// FR-004: bicep tlsSource default matches the JS DEFAULT_TLS_SOURCE.
test("bicep portal main.bicep tlsSource default matches DEFAULT_TLS_SOURCE", () => {
  const bicepPath = join(
    REPO_ROOT,
    "deploy",
    "providers", "azure", "services",
    "portal",
    "bicep",
    "main.bicep",
  );
  const raw = readFileSync(bicepPath, "utf8");
  // Locate the `param tlsSource string = '<default>'` declaration.
  const m = raw.match(/param\s+tlsSource\s+string\s*=\s*'([^']+)'/);
  assert.ok(m, "tlsSource param default declaration not found in portal main.bicep");
  assert.equal(
    m[1],
    DEFAULT_TLS_SOURCE,
    `bicep tlsSource default '${m[1]}' must match overlay-contracts DEFAULT_TLS_SOURCE '${DEFAULT_TLS_SOURCE}'`,
  );
});

// === validateVpnGatewayCombo ================================================

const VPN_BASE_ENV = Object.freeze({
  VPN_GATEWAY_ENABLED: "true",
  SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
  VPN_CLIENT_ADDRESS_POOL: "172.16.200.0/24",
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
});

test("validateVpnGatewayCombo: disabled (unset) → empty regardless of other VPN env", () => {
  const env = {
    EDGE_MODE: "private",
    TLS_SOURCE: "letsencrypt",
    VPN_CLIENT_ADDRESS_POOL: "10.20.50.0/24", // would overlap default VNet
  };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "letsencrypt", env }),
    [],
  );
});

test("validateVpnGatewayCombo: disabled (literal 'false') → empty", () => {
  const env = { ...VPN_BASE_ENV, VPN_GATEWAY_ENABLED: "false" };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "letsencrypt", env }),
    [],
  );
});

test("validateVpnGatewayCombo: valid combo (afd + akv + suffix + non-overlapping pool) → empty", () => {
  const env = { ...VPN_BASE_ENV };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env }),
    [],
  );
});

test("validateVpnGatewayCombo: TLS_SOURCE=letsencrypt → vpn-requires-akv", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env });
  assert.ok(errs.includes("vpn-requires-akv"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: EDGE_MODE=private → vpn-requires-afd", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-afd"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: missing SSL_CERT_DOMAIN_SUFFIX → vpn-requires-domain-suffix", () => {
  const env = { ...VPN_BASE_ENV, SSL_CERT_DOMAIN_SUFFIX: "" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-domain-suffix"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: overlapping pool (10.20.50.0/24 inside default 10.20.0.0/16) → vpn-pool-overlap", () => {
  const env = { ...VPN_BASE_ENV, VPN_CLIENT_ADDRESS_POOL: "10.20.50.0/24" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: non-overlapping pool (172.16.200.0/24) → no overlap error", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(!errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: malformed pool CIDR → vpn-pool-overlap (fail-closed)", () => {
  const env = { ...VPN_BASE_ENV, VPN_CLIENT_ADDRESS_POOL: "not-a-cidr" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: respects VNET_CIDR override when supplied", () => {
  // If operator overrides VNET_CIDR to 10.99.0.0/16, the default-pool
  // 172.16.200.0/24 still doesn't overlap. Sanity: 10.99.50.0/24 would.
  const env = { ...VPN_BASE_ENV, VNET_CIDR: "10.99.0.0/16", VPN_CLIENT_ADDRESS_POOL: "10.99.50.0/24" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateRequiredEnv returns vpn combo errors in a separate channel from missing[]", () => {
  // afd-akv overlay so the baseline required key (SSL_CERT_DOMAIN_SUFFIX)
  // is exercised; with VPN enabled and TLS_SOURCE=letsencrypt we'd switch
  // overlays, so use afd-akv + letsencrypt? No — overlay is resolved from
  // (edgeMode,tlsSource). Use afd-akv overlay = (afd, akv); but then the
  // VPN combo is satisfied. To get a vpn-* error through the validator
  // entrypoint, flip EDGE_MODE to 'private' and use the private-akv
  // overlay which requires HOST/PRIVATE_DNS_ZONE/AKS_VNET_ID anyway.
  const env = {
    VPN_GATEWAY_ENABLED: "true",
    SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    HOST: "h",
    PRIVATE_DNS_ZONE: "z",
    AKS_VNET_ID: "v",
  };
  const { missing, combo } = validateRequiredEnv({ edgeMode: "private", tlsSource: "akv", env });
  // Combo errors live in `combo`, NOT in `missing` — that's the contract
  // change being guarded here (regression: pre-Phase-2-followup the
  // vpn-requires-afd code was pushed onto `missing` and rendered with the
  // wrong error string + a misleading scaffolder hint).
  assert.deepEqual(missing, [], `combo errors leaked into missing[]: ${missing.join(",")}`);
  const codes = combo.map((c) => c.code);
  assert.ok(codes.includes("vpn-requires-afd"), `got: ${codes.join(",")}`);
  // Each combo entry is a {code, message, hint} object with non-empty
  // strings — guards against accidental shape drift.
  for (const e of combo) {
    assert.equal(typeof e.code, "string");
    assert.ok(e.message && typeof e.message === "string", `empty message on ${e.code}`);
    assert.ok(e.hint && typeof e.hint === "string", `empty hint on ${e.code}`);
    // The hint MUST NOT direct operators at the scaffolder — re-running
    // new-env.mjs would clobber operator edits, and the underlying problem
    // isn't an unset key, it's a bad combination of values.
    assert.ok(
      !/new-env|deploy:new-env/i.test(e.hint),
      `combo hint for ${e.code} must not point at the scaffolder: ${e.hint}`,
    );
  }
});

test("validateRequiredEnv: vpn-requires-tenant-id surfaces a hint pointing at the env file", () => {
  // IMPROVE-1: blanked AZURE_TENANT_ID with VPN enabled should fail-closed
  // pre-deploy with a clear named error, instead of falling through to
  // the bicep `param tenantId string = ''` default.
  const env = {
    VPN_GATEWAY_ENABLED: "true",
    SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
    AZURE_TENANT_ID: "   ", // whitespace-only → treated as empty
    VPN_CLIENT_ADDRESS_POOL: "172.16.200.0/24",
  };
  const { combo } = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  const tenantErr = combo.find((c) => c.code === "vpn-requires-tenant-id");
  assert.ok(tenantErr, `expected vpn-requires-tenant-id; got: ${combo.map((c) => c.code).join(",")}`);
  assert.match(tenantErr.message, /AZURE_TENANT_ID/);
  assert.match(tenantErr.hint, /\.env/);
});

test("validateVpnGatewayCombo: missing AZURE_TENANT_ID → vpn-requires-tenant-id", () => {
  const env = { ...VPN_BASE_ENV, AZURE_TENANT_ID: "" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-tenant-id"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: whitespace-only AZURE_TENANT_ID → vpn-requires-tenant-id", () => {
  const env = { ...VPN_BASE_ENV, AZURE_TENANT_ID: "   " };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-tenant-id"), `got: ${errs.join(",")}`);
});

test("VPN combo-error hints never reference the nonexistent deploy/docs/ tree", () => {
  // describeVpnComboError is a private function — scan the source as the
  // regression guard. Any reintroduction (in a hint or even a comment) of
  // a `deploy/docs/` path would be a regression: that directory doesn't
  // exist; the canonical operator doc is `docs/developer/deploy/aks.md`.
  // Final-review C-1 follow-up.
  const src = readFileSync(
    join(REPO_ROOT, "deploy", "scripts", "lib", "overlay-contracts.mjs"),
    "utf8",
  );
  assert.ok(
    !src.includes("deploy/docs/"),
    "overlay-contracts.mjs still contains a deploy/docs/ reference",
  );
});

// === SFI_COMPLIANT combo checks =============================================

const SFI_ENV = Object.freeze({
  SFI_COMPLIANT: "true",
  ACME_EMAIL: "operator@example.com",
  SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
  HOST: "portal",
  PRIVATE_DNS_ZONE: "example.internal",
  AKS_VNET_ID: "vnet",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
});

function sfiErrors(edgeMode, tlsSource, extra = {}) {
  const { combo } = validateRequiredEnv({ edgeMode, tlsSource, env: { ...SFI_ENV, ...extra } });
  return combo;
}
const codes = (errors) => errors.map((e) => e.code);

test("SFI_COMPLIANT refuses the akv TLS sources, which issue the certificate with deployment scripts", () => {
  for (const tlsSource of ["akv", "akv-selfsigned"]) {
    const errors = sfiErrors("afd", tlsSource);
    assert.deepEqual(codes(errors), ["sfi-requires-letsencrypt"], tlsSource);
    assert.match(errors[0].message, new RegExp(`TLS_SOURCE='${tlsSource}'.*deployment scripts`));
    // Off, the same settings pass: the setting gates every check.
    for (const flag of [undefined, "", "false", "FALSE"]) {
      const env = { ...SFI_ENV, SFI_COMPLIANT: flag, PERIMETER_OPERATOR_IP_PREFIXES: "nope", PILOTSWARM_USE_MANAGED_IDENTITY: "0" };
      assert.deepEqual(validateSfiCombo({ edgeMode: "afd", tlsSource, env }), [], `SFI_COMPLIANT=${flag}`);
    }
  }
  assert.deepEqual(sfiErrors("afd", "letsencrypt"), []);
});

test("SFI_COMPLIANT supports EDGE_MODE=afd only", () => {
  // private mode has only akv TLS sources, so both refusals apply.
  assert.deepEqual(codes(sfiErrors("private", "akv")), ["sfi-requires-afd", "sfi-requires-letsencrypt"]);
  assert.deepEqual(codes(sfiErrors("private", "akv-selfsigned")), ["sfi-requires-afd", "sfi-requires-letsencrypt"]);
  const publicMode = sfiErrors("public", "letsencrypt");
  assert.deepEqual(codes(publicMode), ["sfi-requires-afd"]);
  assert.match(publicMode[0].message, /public mode has no stamp VNet/);
});

test("SFI_COMPLIANT refuses bad operator prefixes and password sign-in to the stamp's database", () => {
  const prefixes = sfiErrors("afd", "letsencrypt", { PERIMETER_OPERATOR_IP_PREFIXES: "203.0.113.7, 198.51.100.1/24" });
  assert.deepEqual(codes(prefixes), ["sfi-operator-prefixes"]);
  assert.match(prefixes[0].message, /'198\.51\.100\.1\/24' has host bits set/);

  for (const value of ["0", "", "maybe"]) {
    assert.deepEqual(codes(sfiErrors("afd", "letsencrypt", { PILOTSWARM_USE_MANAGED_IDENTITY: value })),
      ["sfi-requires-database-identity"], `PILOTSWARM_USE_MANAGED_IDENTITY=${value}`);
  }
  // A bring-your-own database keeps its own sign-in.
  assert.deepEqual(sfiErrors("afd", "letsencrypt", { DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "0" }), []);

  for (const e of [...prefixes, ...sfiErrors("private", "akv")]) {
    assert.ok(e.message && e.hint, e.code);
    assert.ok(!/new-env|deploy:new-env/i.test(e.hint), `combo hint for ${e.code} must not point at the scaffolder`);
  }
});

test("SFI_COMPLIANT refuses a Blob client without managed identity, judged as the runtime judges it", () => {
  // Storage shared keys are off, so a Blob flag that isn't truthy is refused,
  // even with database managed identity on.
  for (const value of ["0", "false", "no", "off", "maybe"]) {
    assert.deepEqual(codes(sfiErrors("afd", "letsencrypt", { PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: value })),
      ["sfi-requires-blob-identity"], `PILOTSWARM_BLOB_USE_MANAGED_IDENTITY=${value}`);
  }
  const [refused] = sfiErrors("afd", "letsencrypt", { PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0" });
  assert.match(refused.message, /denies Storage shared keys.*PILOTSWARM_BLOB_USE_MANAGED_IDENTITY must be 1/);
  assert.ok(!/new-env|deploy:new-env/i.test(refused.hint));

  // Without the key the deploy path's default (1) applies; truthy values pass.
  for (const value of [undefined, "1", "true", " YES ", "on"]) {
    assert.deepEqual(sfiErrors("afd", "letsencrypt", { PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: value }), [], `${value}`);
  }
  assert.deepEqual(validateSfiCombo({
    edgeMode: "afd", tlsSource: "letsencrypt", env: { ...parseEnvFile(templateEnvPath()), SFI_COMPLIANT: "true" },
  }), [], "an env scaffolded from template.env passes");

  // An empty Blob flag falls back to the database flag, as at runtime. A
  // bring-your-own database keeps password sign-in apart from Blob.
  const byo = { DEPLOY_POSTGRES: "false" };
  assert.deepEqual(codes(sfiErrors("afd", "letsencrypt", {
    ...byo, PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "", PILOTSWARM_USE_MANAGED_IDENTITY: "0",
  })), ["sfi-requires-blob-identity"]);
  assert.deepEqual(sfiErrors("afd", "letsencrypt", {
    ...byo, PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: " ", PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  }), []);
  assert.deepEqual(sfiErrors("afd", "letsencrypt", {
    ...byo, PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1", PILOTSWARM_USE_MANAGED_IDENTITY: "0",
  }), []);

  // The setting off never refuses.
  for (const flag of [undefined, "", "false"]) {
    const env = { ...SFI_ENV, SFI_COMPLIANT: flag, PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0" };
    assert.deepEqual(validateSfiCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env }), [], `SFI_COMPLIANT=${flag}`);
  }
});

// Runs `deploy.mjs portal <env> --steps manifests` with `settings` as the env
// file and an Azure CLI on PATH that answers only `--version` and logs every
// call. Returns the process result and the logged calls.
let manifestsRuns = 0;
function manifestsOnlyPortalRun(t, settings) {
  const name = `sfim${process.pid.toString(36)}${manifestsRuns++}`;
  const local = join(REPO_ROOT, "deploy", "envs", "local", name);
  const dir = mkdtempSync(join(tmpdir(), "ps-sfi-combo-"));
  t.after(() => {
    rmSync(local, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".env"), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");

  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(join(dir, "az.cjs"), [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.SFI_TEST_CALLS, JSON.stringify(args) + '\\n');",
    "process.exit(args[0] === '--version' ? 0 : 9);",
  ].join("\n"));
  if (process.platform === "win32") {
    writeFileSync(join(dir, "az.cmd"), `@"${process.execPath}" "%~dp0az.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, "az"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/az.cjs" "$@"\n`, { mode: 0o755 });
  }

  const env = { ...process.env, SFI_TEST_CALLS: calls };
  const ambient = [...Object.keys(settings), ...DATABASE_INPUT_KEYS, "TLS_SOURCE", "ACME_EMAIL", "SSL_CERT_DOMAIN_SUFFIX",
    "PERIMETER_OPERATOR_IP_PREFIXES", "WORKSPACES_ENABLED", "USER_POOL_MIN_COUNT", "PILOTSWARM_NATIVE_SUBAGENTS",
    "NPM_REGISTRY", "DEPLOY_PROVIDER"];
  for (const key of ambient) delete env[key];
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${dir}${delimiter}${env[pathKey] ?? ""}`;
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "deploy", "scripts", "deploy.mjs"), "portal", name, "--steps", "manifests", "--image-tag", "fixture",
  ], { cwd: REPO_ROOT, encoding: "utf8", env });
  const logged = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, logged };
}

const SFI_STAMP = Object.freeze({
  SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
  EDGE_MODE: "afd",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  SFI_COMPLIANT: "true",
});

test("SFI_COMPLIANT refuses an akv TLS source on a portal run that only publishes manifests, before any step", (t) => {
  const { result, logged } = manifestsOnlyPortalRun(t, {
    ...SFI_STAMP, TLS_SOURCE: "akv", SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[sfi-requires-letsencrypt\] SFI_COMPLIANT=true refuses TLS_SOURCE='akv'/);
  assert.deepEqual(logged, [["--version"]], "no Azure call besides the CLI check");
});

test("SFI_COMPLIANT refuses Blob without managed identity on a portal run that only publishes manifests, before any step", (t) => {
  const { result, logged } = manifestsOnlyPortalRun(t, {
    ...SFI_STAMP, TLS_SOURCE: "letsencrypt", ACME_EMAIL: "operator@example.com", PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[sfi-requires-blob-identity\] SFI_COMPLIANT=true denies Storage shared keys/);
  assert.deepEqual(logged, [["--version"]], "no Azure call besides the CLI check");
});

// === Windows worker pool combo checks =======================================

const POOL_ENV = Object.freeze({
  WIN_WORKERS_ENABLED: "true",
  WIN_WORKER_ALERT_EMAILS: "ops@example.com",
  PORTAL_AUTH_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  ACME_EMAIL: "operator@example.com",
  SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
  HOST: "portal",
  PRIVATE_DNS_ZONE: "example.internal",
  AKS_VNET_ID: "vnet",
});

function poolErrors(edgeMode, tlsSource, extra = {}) {
  const env = { ...POOL_ENV, ...extra };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return validateRequiredEnv({ edgeMode, tlsSource, env }).combo;
}

test("the pool's settings at their defaults refuse nothing, whatever the edge", () => {
  const template = parseEnvFile(templateEnvPath());
  for (const [edgeMode, tlsSource] of [["afd", "letsencrypt"], ["afd", "akv"], ["private", "akv"], ["public", "letsencrypt"]]) {
    assert.deepEqual(validateWinWorkersCombo({ edgeMode, tlsSource, env: {} }), [], `${edgeMode} empty env`);
    assert.deepEqual(validateWinWorkersCombo({ edgeMode, tlsSource, env: template }), [], `${edgeMode} template.env`);
  }
  // A complete pool in afd and private mode passes too.
  assert.deepEqual(poolErrors("afd", "letsencrypt"), []);
  assert.deepEqual(poolErrors("private", "akv"), []);
});

test("WIN_WORKERS_ENABLED=true needs the stamp VNet: EDGE_MODE afd or private", () => {
  const errors = poolErrors("public", "letsencrypt");
  assert.deepEqual(codes(errors), ["win-workers-requires-vnet"]);
  assert.match(errors[0].message, /needs EDGE_MODE='afd' or 'private', not 'public'/);
  assert.ok(!/new-env|deploy:new-env/i.test(errors[0].hint), "the hint does not point at the scaffolder");
});

test("WIN_WORKERS_ENABLED=true needs at least one alert receiver, and refuses a malformed one", () => {
  for (const emails of [undefined, "", "__PS_UNSET__", " , "]) {
    assert.deepEqual(codes(poolErrors("afd", "letsencrypt", { WIN_WORKER_ALERT_EMAILS: emails })),
      ["win-workers-requires-alert-emails"], `WIN_WORKER_ALERT_EMAILS=${emails}`);
  }
  const bad = poolErrors("afd", "letsencrypt", { WIN_WORKER_ALERT_EMAILS: "ops@example.com, not-an-address" });
  assert.deepEqual(codes(bad), ["win-workers-settings"]);
  assert.match(bad[0].message, /'not-an-address' is not an email address/);
  assert.deepEqual(poolErrors("afd", "letsencrypt", { WIN_WORKER_ALERT_EMAILS: "a@example.com,b@example.com" }), []);
});

test("WIN_WORKER_MIN_RUNNING=0 needs the coordination host", () => {
  const errors = poolErrors("afd", "letsencrypt", { WIN_WORKER_MIN_RUNNING: "0" });
  assert.deepEqual(codes(errors), ["win-workers-min-running-requires-coordination-host"]);
  assert.match(errors[0].message, /only the coordination host runs orchestrations and timers/);
  // Without the pool, too: the coordination host itself needs the pool.
  assert.deepEqual(codes(validateWinWorkersCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env: { WIN_WORKER_MIN_RUNNING: "0" } })),
    ["win-workers-min-running-requires-coordination-host"]);
  assert.deepEqual(poolErrors("afd", "letsencrypt", {
    WIN_WORKER_MIN_RUNNING: "0", WIN_WORKER_COORDINATION_HOST: "true", PILOTSWARM_OWNER_ROUTING: "1",
  }), []);
});

test("the coordination host needs the pool and owner routing", () => {
  const off = validateWinWorkersCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env: { WIN_WORKER_COORDINATION_HOST: "true" } });
  assert.deepEqual(codes(off), ["coordination-host-requires-win-workers", "coordination-host-requires-owner-routing"]);
  const noTags = poolErrors("afd", "letsencrypt", { WIN_WORKER_COORDINATION_HOST: "true" });
  assert.deepEqual(codes(noTags), ["coordination-host-requires-owner-routing"]);
  assert.match(noTags[0].message, /without owner tags no user turn would run/);
});

test("the coordination host runs no session workspace, and its own settings are checked before any step", () => {
  const host = { WIN_WORKER_COORDINATION_HOST: "true", PILOTSWARM_OWNER_ROUTING: "1" };
  const errors = poolErrors("afd", "letsencrypt", { ...host, WORKSPACES_ENABLED: "true" });
  assert.deepEqual(codes(errors), ["coordination-host-excludes-workspaces"]);
  assert.match(errors[0].message, /needs WORKSPACES_ENABLED=false/);
  assert.deepEqual(poolErrors("afd", "letsencrypt", { WORKSPACES_ENABLED: "true" }), [], "the pool alone does not refuse them");
  for (const bad of [
    { WIN_WORKER_COORDINATION_HOST_REPLICAS: "21" },
    { WIN_WORKER_COORDINATION_HOST_PLUGIN_CONFIGMAP: "Not_A_Name" },
    { WIN_WORKER_COORDINATION_HOST_REDACT_SECRET_PREFIXES: "x" },
  ]) {
    assert.deepEqual(codes(poolErrors("afd", "letsencrypt", { ...host, ...bad })), ["win-workers-settings"], JSON.stringify(bad));
  }
});

test("owner routing needs the pool, and takes only 1 or 0", () => {
  const errors = validateWinWorkersCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env: { PILOTSWARM_OWNER_ROUTING: "1" } });
  assert.deepEqual(codes(errors), ["owner-routing-requires-win-workers"]);
  assert.match(errors[0].message, /only a bound Windows worker serves an owner tag/);
  assert.deepEqual(poolErrors("afd", "letsencrypt", { PILOTSWARM_OWNER_ROUTING: "1" }), []);
  for (const value of ["0", "", "__PS_UNSET__"]) {
    assert.deepEqual(validateWinWorkersCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env: { PILOTSWARM_OWNER_ROUTING: value } }), []);
  }
  // The portal records owner tags only for exactly 1; "true" would quietly be off.
  assert.deepEqual(codes(validateWinWorkersCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env: { PILOTSWARM_OWNER_ROUTING: "true" } })),
    ["win-workers-settings"]);
});

test("the pool needs the portal's Entra app, the stamp's own database and database managed identity", () => {
  assert.deepEqual(codes(poolErrors("afd", "letsencrypt", { PORTAL_AUTH_ENTRA_CLIENT_ID: "__PS_UNSET__" })),
    ["win-workers-requires-entra-app"]);
  assert.deepEqual(codes(poolErrors("afd", "letsencrypt", { DEPLOY_POSTGRES: "false" })),
    ["win-workers-requires-stamp-database"]);
  assert.deepEqual(codes(poolErrors("afd", "letsencrypt", { PILOTSWARM_USE_MANAGED_IDENTITY: "0" })),
    ["win-workers-requires-database-identity"]);
});

test("the pool refuses unreadable settings and reserved WIN_WORKER_EXTRA_ENV names", () => {
  for (const [key, value, message] of [
    ["WIN_WORKERS_ENABLED", "yes", /WIN_WORKERS_ENABLED must be true or false/],
    ["WIN_WORKER_COORDINATION_HOST", "1", /WIN_WORKER_COORDINATION_HOST must be true or false/],
    ["WIN_WORKER_COUNT", "0", /WIN_WORKER_COUNT must be a whole number from 1 to 100/],
    ["WIN_WORKER_MIN_RUNNING", "6", /WIN_WORKER_MIN_RUNNING must not be above WIN_WORKER_COUNT/],
    ["WIN_WORKER_STANDBY_MIN", "-1", /WIN_WORKER_STANDBY_MIN must be a whole number/],
    ["WIN_WORKER_VM_SIZE", "D16ds v5", /WIN_WORKER_VM_SIZE must be a VM size/],
    ["WIN_WORKER_IMAGE_VERSION", "latest", /WIN_WORKER_IMAGE_VERSION must be a gallery image version/],
    ["WIN_WORKER_FEED_ENDPOINTS", "http://feed.example.com/", /is not a plain https URL/],
  ]) {
    const errors = poolErrors("afd", "letsencrypt", { [key]: value });
    assert.ok(errors.some((e) => e.code === "win-workers-settings" && message.test(e.message)), `${key}=${value}: ${JSON.stringify(errors)}`);
  }
  const reserved = poolErrors("afd", "letsencrypt", { WIN_WORKER_EXTRA_ENV: "EXAMPLE_URL=https://api.example.com;path=C:\\tools" });
  assert.deepEqual(codes(reserved), ["win-workers-extra-env"]);
  assert.match(reserved[0].message, /may not set path/);
  assert.deepEqual(poolErrors("afd", "letsencrypt", { WIN_WORKER_EXTRA_ENV: "EXAMPLE_URL=https://api.example.com;EXAMPLE_MODE=on" }), []);
});

const POOL_STAMP = Object.freeze({
  SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000003",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  TLS_SOURCE: "letsencrypt",
  ACME_EMAIL: "operator@example.com",
  PORTAL_AUTH_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  WIN_WORKER_ALERT_EMAILS: "ops@example.com",
  WIN_WORKER_MIN_RUNNING: "1",
  WIN_WORKER_COORDINATION_HOST: "false",
  PILOTSWARM_OWNER_ROUTING: "0",
  WIN_WORKERS_ENABLED: "false",
});

test("the pool's refusals stop a portal run that only publishes manifests, before any step", (t) => {
  for (const [settings, expected] of [
    [{ EDGE_MODE: "public", WIN_WORKERS_ENABLED: "true" }, [/\[win-workers-requires-vnet\]/]],
    [{ EDGE_MODE: "afd", WIN_WORKERS_ENABLED: "true", WIN_WORKER_ALERT_EMAILS: "" }, [/\[win-workers-requires-alert-emails\]/]],
    [{ EDGE_MODE: "afd", WIN_WORKERS_ENABLED: "true", WIN_WORKER_MIN_RUNNING: "0" }, [/\[win-workers-min-running-requires-coordination-host\]/]],
    [{ EDGE_MODE: "afd", WIN_WORKERS_ENABLED: "true", WIN_WORKER_COORDINATION_HOST: "true" }, [/\[coordination-host-requires-owner-routing\]/]],
    [{ EDGE_MODE: "afd", WIN_WORKER_COORDINATION_HOST: "true", PILOTSWARM_OWNER_ROUTING: "1" },
      [/\[coordination-host-requires-win-workers\]/, /\[owner-routing-requires-win-workers\]/]],
  ]) {
    const { result, logged } = manifestsOnlyPortalRun(t, { ...POOL_STAMP, ...settings });
    assert.equal(result.status, 1, result.stderr);
    for (const pattern of expected) assert.match(result.stderr, pattern, JSON.stringify(settings));
    assert.deepEqual(logged, [["--version"]], "no Azure call besides the CLI check");
  }
});