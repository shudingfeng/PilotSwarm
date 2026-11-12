// Tests for render-params.mjs.
//
// Run: node --test deploy/scripts/test/render-params.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderParams } from "../lib/render-params.mjs";
import { parseEnvFile, templateEnvPath, REPO_ROOT } from "../lib/common.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "render-params-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("substitutes ${VAR} placeholders against the env map", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: {
          name: { value: "${RESOURCE_PREFIX}" },
          loc: { value: "${LOCATION}" },
        },
      }),
    );
    const r = renderParams({
      module: "T",
      templatePath: tpl,
      envMap: { RESOURCE_PREFIX: "psfoo", LOCATION: "westus3" },
      outDir: dir,
    });

    const json = JSON.parse(readFileSync(r.renderedPath, "utf8"));
    assert.equal(json.parameters.name.value, "psfoo");
    assert.equal(json.parameters.loc.value, "westus3");
    assert.deepEqual(r.substituted.sort(), ["LOCATION", "RESOURCE_PREFIX"]);
  });
});

test("empty string is a legitimate value, not unresolved (OSS-path SSL_CERT_DOMAIN_SUFFIX case)", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: {
          suffix: { value: "${SSL_CERT_DOMAIN_SUFFIX}" },
        },
      }),
    );
    const r = renderParams({
      module: "T",
      templatePath: tpl,
      envMap: { SSL_CERT_DOMAIN_SUFFIX: "" },
      outDir: dir,
    });
    const json = JSON.parse(readFileSync(r.renderedPath, "utf8"));
    assert.equal(json.parameters.suffix.value, "");
  });
});

test("undefined / missing key is reported as unresolved", () => {
  withTmp((dir) => {
    const tpl = join(dir, "T.params.template.json");
    writeFileSync(
      tpl,
      JSON.stringify({
        $schema: "x",
        contentVersion: "1",
        parameters: { foo: { value: "${UNSET_KEY}" } },
      }),
    );
    assert.throws(
      () => renderParams({ module: "T", templatePath: tpl, envMap: {}, outDir: dir }),
      /unresolved placeholders: UNSET_KEY/,
    );
  });
});

test("real base-infra template renders a boolean for new, legacy, and pre-key envs", () => {
  withTmp((dir) => {
    const templatePath = join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep/base-infra.params.template.json");
    for (const [flag, expected] of [
      ["true", true], ["false", false], ["1", true], ["0", false],
      [" FALSE ", false], [false, false], [true, true], [undefined, true],
    ]) {
      const envMap = {
        ...parseEnvFile(templateEnvPath()),
        FRONT_DOOR_ID: "fixture-front-door",
        FRONT_DOOR_PROFILE_NAME: "fixture-profile",
        FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg",
      };
      if (flag === undefined) delete envMap.DEPLOY_POSTGRES;
      else envMap.DEPLOY_POSTGRES = flag;
      const { renderedPath } = renderParams({ module: "base-infra", templatePath, envMap, outDir: dir });
      const params = JSON.parse(readFileSync(renderedPath, "utf8"));
      assert.equal(typeof params.parameters.deployPostgres.value, "boolean");
      assert.equal(params.parameters.deployPostgres.value, expected);
    }
  });
});

test("invalid DEPLOY_POSTGRES cannot render as a number or bypass validation", () => {
  withTmp((dir) => {
    const templatePath = join(dir, "bool.json");
    writeFileSync(templatePath, '{"parameters":{"deployPostgres":{"value":${DEPLOY_POSTGRES}}}}');
    for (const flag of ["", "2", "no"]) {
      assert.throws(
        () => renderParams({ module: "base-infra", templatePath, envMap: { DEPLOY_POSTGRES: flag }, outDir: dir }),
        /DEPLOY_POSTGRES must be true or false/,
      );
    }
  });
});

test("real base-infra template renders the node-pool settings: the repocache pool follows WORKSPACES_ENABLED", () => {
  withTmp((dir) => {
    const templatePath = join(REPO_ROOT, "deploy/providers/azure/services/base-infra/bicep/base-infra.params.template.json");
    const base = {
      ...parseEnvFile(templateEnvPath()),
      FRONT_DOOR_ID: "fixture-front-door",
      FRONT_DOOR_PROFILE_NAME: "fixture-profile",
      FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg",
    };
    const render = (extra) => {
      const envMap = { ...base, ...extra };
      for (const [key, value] of Object.entries(extra)) if (value === undefined) delete envMap[key];
      const { renderedPath } = renderParams({ module: "base-infra", templatePath, envMap, outDir: dir });
      return JSON.parse(readFileSync(renderedPath, "utf8")).parameters;
    };
    // The template's defaults: no pool, minimum 1.
    assert.equal(render({}).repoCachePoolEnabled.value, false);
    assert.equal(render({}).userPoolMinCount.value, 1);
    for (const [flag, expected] of [["true", true], [" TRUE ", true], ["false", false], ["", false], [undefined, false]]) {
      const params = render({ WORKSPACES_ENABLED: flag });
      assert.equal(params.repoCachePoolEnabled.value, expected, `WORKSPACES_ENABLED=${flag}`);
    }
    for (const [count, expected] of [["2", 2], [" 10 ", 10], ["", 1], [undefined, 1]]) {
      const params = render({ USER_POOL_MIN_COUNT: count });
      assert.equal(params.userPoolMinCount.value, expected, `USER_POOL_MIN_COUNT=${count}`);
    }
    for (const flag of ["yes", "1"]) {
      assert.throws(() => render({ WORKSPACES_ENABLED: flag }), /WORKSPACES_ENABLED must be true or false/);
    }
    for (const count of ["0", "11", "2x", "-1"]) {
      assert.throws(() => render({ USER_POOL_MIN_COUNT: count }), /USER_POOL_MIN_COUNT must be a whole number from 1 to 10/);
    }
  });
});

// ─── AZURE_POLICY_RESTRICTED ───

// Values the base-infra and portal templates need besides template.env.
const STAMP_FIXTURES = {
  RESOURCE_PREFIX: "psfixture",
  PORTAL_RESOURCE_NAME: "psfixture-wus3-portal",
  FRONT_DOOR_ID: "fixture-front-door",
  FRONT_DOOR_PROFILE_NAME: "fixture-profile",
  FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fixture-global-rg",
  FRONT_DOOR_ENDPOINT_NAME: "fixture-endpoint",
  APPLICATION_GATEWAY_NAME: "psfixture-appgw",
  PRIVATE_LINK_CONFIGURATION_NAME: "privateLinkConfig",
  APPROVAL_MANAGED_IDENTITY_ID: "/subscriptions/fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/approver",
  DEPLOYMENT_STORAGE_ACCOUNT_NAME: "psfixturesa",
  AKS_CLUSTER_NAME: "psfixture-aks",
  KV_NAME: "psfixturekv",
  PORTAL_HOSTNAME: "unused",
  PRIVATE_DNS_ZONE: "unused",
  AKS_VNET_ID: "unused",
};

const templateFor = (module) =>
  join(REPO_ROOT, `deploy/providers/azure/services/${module}/bicep/${module}.params.template.json`);

// The rendering before AZURE_POLICY_RESTRICTED existed: every placeholder replaced by
// its value inside the JSON string. The template.env values of the
// normalized keys (true, false, 1) render unchanged, so this is exact here.
function substituteTemplate(raw, env) {
  return raw.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key) =>
    String(env[key]).replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
}

test("AZURE_POLICY_RESTRICTED off renders base-infra and portal byte for byte as before; on adds only the profile's parameters", () => {
  withTmp((dir) => {
    const base = {
      ...parseEnvFile(templateEnvPath()),
      ...STAMP_FIXTURES,
      PERIMETER_OPERATOR_IP_PREFIXES: "203.0.113.7",
      APP_GATEWAY_EXISTS: "true",
    };
    for (const module of ["base-infra", "portal", "worker"]) {
      const templatePath = templateFor(module);
      const raw = readFileSync(templatePath, "utf8");
      for (const flag of [undefined, "", "false", " FALSE "]) {
        const envMap = { ...base, AZURE_POLICY_RESTRICTED: flag };
        if (flag === undefined) delete envMap.AZURE_POLICY_RESTRICTED;
        const { renderedPath } = renderParams({ module, templatePath, envMap, outDir: dir });
        assert.equal(readFileSync(renderedPath, "utf8"), substituteTemplate(raw, envMap), `${module} AZURE_POLICY_RESTRICTED=${flag}`);
      }

      const { renderedPath } = renderParams({ module, templatePath, envMap: { ...base, AZURE_POLICY_RESTRICTED: "true" }, outDir: dir });
      const on = JSON.parse(readFileSync(renderedPath, "utf8")).parameters;
      const off = JSON.parse(substituteTemplate(raw, base)).parameters;
      for (const name of Object.keys(off)) assert.deepEqual(on[name], off[name], `${module} ${name}`);
      const added = Object.fromEntries(Object.entries(on).filter(([name]) => !(name in off)));
      const expected = {
        "base-infra": {
          policyRestricted: { value: true },
          perimeterOperatorIpPrefixes: { value: ["203.0.113.7/32"] },
          appGwExists: { value: true },
        },
        portal: { policyRestricted: { value: true } },
        worker: {},
      };
      assert.deepEqual(added, expected[module], module);
    }
  });
});

test("PERIMETER_OPERATOR_IP_PREFIXES: trimmed, empty entries and repeats dropped, a bad entry refused", () => {
  withTmp((dir) => {
    const render = (prefixes) => {
      const envMap = {
        ...parseEnvFile(templateEnvPath()),
        ...STAMP_FIXTURES,
        AZURE_POLICY_RESTRICTED: "true",
        APP_GATEWAY_EXISTS: "false",
        PERIMETER_OPERATOR_IP_PREFIXES: prefixes,
      };
      if (prefixes === undefined) delete envMap.PERIMETER_OPERATOR_IP_PREFIXES;
      const { renderedPath } = renderParams({ module: "base-infra", templatePath: templateFor("base-infra"), envMap, outDir: dir });
      return JSON.parse(readFileSync(renderedPath, "utf8")).parameters.perimeterOperatorIpPrefixes.value;
    };
    assert.deepEqual(
      render(" 203.0.113.7 , 198.51.100.0/24,, 203.0.113.7/32 ,"),
      ["203.0.113.7/32", "198.51.100.0/24"],
    );
    for (const empty of [undefined, "", " , "]) assert.deepEqual(render(empty), [], `'${empty}'`);
    for (const [entry, reason] of [
      ["203.0.113.0/33", /'203\.0\.113\.0\/33' is not an IPv4 address or CIDR prefix/],
      ["203.0.113.256", /'203\.0\.113\.256' is not an IPv4 address/],
      ["2001:db8::/32", /'2001:db8::\/32' is not an IPv4 address/],
      ["portal.example.com", /'portal\.example\.com' is not an IPv4 address/],
      ["10.0.0.1/24", /'10\.0\.0\.1\/24' has host bits set; use 10\.0\.0\.0\/24/],
    ]) {
      assert.throws(() => render(`203.0.113.7, ${entry}`), reason);
    }
  });
});

test("AZURE_POLICY_RESTRICTED=true takes the App Gateway probe's answer in afd mode and refuses to guess it", () => {
  withTmp((dir) => {
    const render = (extra) => {
      const envMap = { ...parseEnvFile(templateEnvPath()), ...STAMP_FIXTURES, AZURE_POLICY_RESTRICTED: "true", ...extra };
      for (const [key, value] of Object.entries(extra)) if (value === undefined) delete envMap[key];
      const { renderedPath } = renderParams({ module: "base-infra", templatePath: templateFor("base-infra"), envMap, outDir: dir });
      return JSON.parse(readFileSync(renderedPath, "utf8")).parameters;
    };
    assert.equal(render({ APP_GATEWAY_EXISTS: "true" }).appGwExists.value, true);
    assert.equal(render({ APP_GATEWAY_EXISTS: " FALSE " }).appGwExists.value, false);
    for (const answer of [undefined, "", "maybe"]) {
      assert.throws(() => render({ APP_GATEWAY_EXISTS: answer }), /AZURE_POLICY_RESTRICTED=true needs APP_GATEWAY_EXISTS/);
    }
    // No App Gateway outside afd mode, so no probe either.
    assert.equal(render({ EDGE_MODE: "private", APP_GATEWAY_EXISTS: undefined }).appGwExists, undefined);
    assert.throws(() => render({ AZURE_POLICY_RESTRICTED: "yes" }), /AZURE_POLICY_RESTRICTED must be true or false, not 'yes'/);
  });
});
