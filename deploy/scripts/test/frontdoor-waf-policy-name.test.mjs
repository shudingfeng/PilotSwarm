// Front Door WAF policy name (global-infra/bicep/main.bicep).
//
// Azure accepts only letters and digits in a Front Door WAF policy name, so a
// resource prefix with a hyphen or an underscore used to fail the deploy with
// "Policy ArmResourceId has incorrect formatting". The name now drops both
// and keeps the case, so every name that could deploy before stays the same.
//
// The test evaluates the bicep `var` itself: it turns the interpolated string
// into a JavaScript template literal and gives it bicep's `replace`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bicep = readFileSync(resolve(here, "../../providers/azure/services/global-infra/bicep/main.bicep"), "utf8");

function wafPolicyNameFor(resourcePrefix) {
    const match = /^var wafPolicyName = '(.*)'\s*$/m.exec(bicep);
    assert.ok(match, "main.bicep declares var wafPolicyName as one interpolated string");
    const template = match[1];
    // bicep's replace() replaces every occurrence.
    const replace = (value, from, to) => String(value).split(from).join(to);
    return new Function("resourcePrefix", "replace", `return \`${template}\`;`)(resourcePrefix, replace);
}

test("a prefix with hyphens or underscores gets a WAF policy name of letters and digits", () => {
    assert.equal(wafPolicyNameFor("my-stamp_dev"), "mystampdevafdwafpolicy");
    for (const prefix of ["ps-west-3", "team_a", "a-b_c-1"]) {
        assert.match(wafPolicyNameFor(prefix), /^[A-Za-z0-9]+$/, prefix);
    }
});

test("every name that could deploy before stays the same, case included", () => {
    for (const prefix of ["pilotswarm", "PilotSwarmDev", "ps01"]) {
        assert.equal(wafPolicyNameFor(prefix), `${prefix}afdwafpolicy`);
    }
});
