/**
 * Live model discovery for `github` provider types (`discoverModels: true`).
 *
 * Each provider offers what its OWN token can use: catalog models it can use
 * keep their curated entries, models the catalog does not name are added, and
 * catalog models the token cannot use are refused — never silently routed. A
 * failed listing leaves the catalog list in force. No test here reaches the
 * network: listings are injected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    discoverCopilotModels,
    mergeDiscoveredModels,
    usableDiscoveredModels,
} from "../../dist/model-discovery.js";
import {
    applyModelDiscovery,
    buildRuntimeRegistry,
    firstRuntimeModel,
    ModelUnresolvedError,
    resolveRuntimeModelSelection,
} from "../../dist/provider-catalog.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";

const typesWith = (discoverModels) => new ModelProviderRegistry({
    providers: [
        {
            id: "github-copilot", type: "github", discoverModels,
            models: [
                { name: "claude-sonnet-5", description: "Curated", cost: "medium" },
                { name: "gpt-5.4", cost: "low" },
            ],
        },
        {
            id: "azure-openai", type: "openai", baseUrl: "https://cluster.example/openai/v1",
            models: [{ name: "gpt-5.4" }],
        },
    ],
}, { keepUncredentialed: true });

const ghcp = (name, token) => ({
    name, typeId: "github-copilot", class: "shared", ownerUserId: null, baseUrl: null,
    secretRef: { kind: "githubToken", value: token },
});
const azure = { name: "azure", typeId: "azure-openai", class: "shared", ownerUserId: null, baseUrl: null,
    secretRef: { kind: "apiKey", value: "AZ-KEY" } };
const everyone = () => true;

const LISTINGS = {
    "TOKEN-A": [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "gpt-6-sol", name: "GPT-6 Sol", supportedReasoningEfforts: ["low", "high", "bogus"], defaultReasoningEffort: "high", billingMultiplier: 3 },
    ],
    "TOKEN-B": [{ id: "claude-haiku-5.5", name: "Claude Haiku 5.5", billingMultiplier: 0.33 }],
};
const discover = async (token) => LISTINGS[token] ?? null;
const modelNames = (registry, provider) => registry.getModelsByProvider()
    .find((group) => group.providerId === provider)?.models.map((model) => model.modelName);

test("a listing drops auto, disabled, unnamed, qualified and repeated models", () => {
    const usable = usableDiscoveredModels([
        { id: "auto" }, { id: "" }, { id: "x:y" }, { id: "off", policyState: "disabled" },
        { id: "gpt-6-sol", policyState: "enabled" }, { id: "gpt-6-sol" }, { id: "no-policy" },
    ]);
    assert.deepEqual(usable.map((model) => model.id), ["gpt-6-sol", "no-policy"]);
});

test("discovered models follow the catalog, which is never rewritten", () => {
    const catalog = [{ name: "claude-sonnet-5", description: "Curated", cost: "medium" }, "gpt-5.4"];
    const merged = mergeDiscoveredModels(catalog, [LISTINGS["TOKEN-A"], LISTINGS["TOKEN-B"]]);
    assert.deepEqual(merged.slice(0, 2), catalog);
    assert.deepEqual(merged.slice(2), [
        { name: "gpt-6-sol", description: "GPT-6 Sol", cost: "high",
            supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
        { name: "claude-haiku-5.5", description: "Claude Haiku 5.5", cost: "low" },
    ]);
});

test("each provider offers exactly what its own token can use", async () => {
    const credentials = [ghcp("alice-ghcp", "TOKEN-A"), ghcp("bob-ghcp", "TOKEN-B"), azure];
    const types = await applyModelDiscovery(typesWith(true), credentials, { discover });
    const runtime = buildRuntimeRegistry(types, credentials);

    assert.deepEqual(modelNames(runtime, "alice-ghcp"), ["claude-sonnet-5", "gpt-6-sol"]);
    assert.deepEqual(modelNames(runtime, "bob-ghcp"), ["claude-haiku-5.5"]);
    assert.deepEqual(modelNames(runtime, "azure"), ["gpt-5.4"], "other types are untouched");
    assert.equal(runtime.getDescriptor("alice-ghcp:claude-sonnet-5").description, "Curated");

    // A bare name goes to the one provider whose token offers it.
    const picked = resolveRuntimeModelSelection(types, credentials, { requestedModel: "gpt-6-sol", eligible: everyone });
    assert.equal(picked.model, "alice-ghcp:gpt-6-sol");
    assert.equal(picked.reasoning, "high");
    // A catalog model the token cannot use is refused, not routed.
    assert.throws(() => resolveRuntimeModelSelection(types, credentials, {
        requestedModel: "bob-ghcp:claude-sonnet-5", eligible: everyone,
    }), ModelUnresolvedError);
    // Bob's first usable model is a discovered one: the catalog's first is not his.
    assert.equal(firstRuntimeModel(types, [ghcp("bob-ghcp", "TOKEN-B")], everyone)?.model, "bob-ghcp:claude-haiku-5.5");
});

test("a failed listing leaves that provider on the catalog list", async () => {
    const credentials = [ghcp("alice-ghcp", "TOKEN-A"), ghcp("carol-ghcp", "TOKEN-FAILS")];
    const types = await applyModelDiscovery(typesWith(true), credentials, {
        discover: async (token) => { if (token === "TOKEN-FAILS") throw new Error("offline"); return LISTINGS[token]; },
    });
    const runtime = buildRuntimeRegistry(types, credentials);
    assert.deepEqual(modelNames(runtime, "carol-ghcp"), ["claude-sonnet-5", "gpt-5.4"],
        "not the models other providers' tokens were found to offer");
    assert.deepEqual(modelNames(runtime, "alice-ghcp"), ["claude-sonnet-5", "gpt-6-sol"]);
});

test("without the flag, or with no listing, the catalog is used as is", async () => {
    const credentials = [ghcp("alice-ghcp", "TOKEN-A")];
    const off = typesWith(undefined);
    assert.equal(await applyModelDiscovery(off, credentials, { discover }), off);
    const on = typesWith(true);
    assert.equal(await applyModelDiscovery(on, credentials, { discover: async () => null }), on);
});

test("tokens the deployment does not use are not listed", async () => {
    const listed = [];
    const recordingDiscover = async (token) => { listed.push(token); return LISTINGS[token] ?? null; };
    const external = {
        name: "dave-ghcp", typeId: "github-copilot", class: "personal", ownerUserId: "dave", baseUrl: null,
        secretRef: { kind: "externalSecret", store: "vault", name: "dave-ghcp", version: "1" },
    };
    const personalInRow = { ...ghcp("erin-ghcp", "TOKEN-B"), class: "personal", ownerUserId: "erin" };
    const credentials = [ghcp("alice-ghcp", "TOKEN-A"), external, personalInRow];

    const types = await applyModelDiscovery(typesWith(true), credentials, {
        discover: recordingDiscover, personalSecrets: "external",
    });
    assert.deepEqual(listed, ["TOKEN-A"], "neither the store reference nor the ignored row key is listed");
    const runtime = buildRuntimeRegistry(types, credentials, null, { personalSecrets: "external" });
    assert.deepEqual(modelNames(runtime, "dave-ghcp"), ["claude-sonnet-5", "gpt-5.4"],
        "a store-held token keeps the catalog list, not what other tokens were found to offer");
    assert.deepEqual(modelNames(runtime, "alice-ghcp"), ["claude-sonnet-5", "gpt-6-sol"]);
    assert.throws(() => resolveRuntimeModelSelection(types, credentials, {
        requestedModel: "dave-ghcp:gpt-6-sol", eligible: everyone,
    }), ModelUnresolvedError);

    listed.length = 0;
    await applyModelDiscovery(typesWith(true), credentials, { discover: recordingDiscover, personalSecrets: "database" });
    assert.deepEqual(listed.sort(), ["TOKEN-A", "TOKEN-B"], "in database mode the personal row key is used and listed");
});

test("only a github type may set discoverModels, and only to a boolean", () => {
    assert.throws(() => new ModelProviderRegistry({ providers: [
        { id: "x", type: "openai", baseUrl: "https://x", apiKey: "k", discoverModels: true, models: ["m"] },
    ] }), /discoverModels/);
    assert.throws(() => new ModelProviderRegistry({ providers: [
        { id: "x", type: "github", githubToken: "t", discoverModels: "yes", models: ["m"] },
    ] }), /discoverModels/);
});

test("listings are cached per token, and a failure keeps the last good list", async () => {
    let clock = 1_000_000;
    let calls = 0;
    let fail = false;
    const lister = async () => {
        calls += 1;
        if (fail) throw new Error("offline");
        return [{ id: "gpt-6-sol" }];
    };
    const now = () => clock;
    const token = `CACHE-${process.pid}`;

    assert.deepEqual((await discoverCopilotModels(token, { lister, now })).map((m) => m.id), ["gpt-6-sol"]);
    await discoverCopilotModels(token, { lister, now });
    assert.equal(calls, 1, "a fresh listing is reused");

    clock += 11 * 60_000;
    fail = true;
    const stale = await discoverCopilotModels(token, { lister, now });
    assert.deepEqual(stale.map((m) => m.id), ["gpt-6-sol"], "a stale list is served while it refreshes");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.deepEqual((await discoverCopilotModels(token, { lister, now })).map((m) => m.id), ["gpt-6-sol"],
        "a failed refresh keeps the last good list");
    assert.equal(calls, 2, "and does not retry at once");

    const never = `NEVER-${process.pid}`;
    assert.equal(await discoverCopilotModels(never, { lister, now }), null, "nothing listed yet means no list");
});

test("only a first listing is awaited; a failed token retries in the background", async () => {
    let clock = 5_000_000;
    const now = () => clock;
    let release;
    let calls = 0;
    let mode = "fail";
    const lister = async () => {
        calls += 1;
        if (mode === "fail") throw new Error("expired token");
        await new Promise((resolve) => { release = resolve; });
        return [{ id: "gpt-6-sol" }];
    };
    const token = `RETRY-${process.pid}`;

    assert.equal(await discoverCopilotModels(token, { lister, now }), null);
    clock += 61_000;
    mode = "slow";
    // The retry is due, but the caller gets the catalog list at once.
    assert.equal(await discoverCopilotModels(token, { lister, now }), null);
    assert.equal(calls, 2, "the retry started in the background");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await discoverCopilotModels(token, { lister, now })).map((m) => m.id), ["gpt-6-sol"]);

    // Callers that arrive during a token's FIRST listing all wait for it.
    const fresh = `FIRST-${process.pid}`;
    const both = Promise.all([discoverCopilotModels(fresh, { lister, now }), discoverCopilotModels(fresh, { lister, now })]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual((await both).map((list) => list?.map((m) => m.id)), [["gpt-6-sol"], ["gpt-6-sol"]]);
    assert.equal(calls, 3, "one listing serves both");
});

test("a listing that times out is aborted", async () => {
    let signal;
    const lister = (_token, s) => { signal = s; return new Promise(() => {}); };
    assert.equal(await discoverCopilotModels(`HANG-${process.pid}`, { lister, timeoutMs: 20 }), null);
    assert.equal(signal?.aborted, true, "the lister is told to release its CLI process");
});

test("a default the provider's token does not offer falls back instead of emptying the registry", async () => {
    const credentials = [ghcp("team-ghcp", "TOKEN-A")];
    // A catalog model the token cannot use.
    const listed = await applyModelDiscovery(typesWith(true), credentials, { discover });
    const runtime = buildRuntimeRegistry(listed, credentials, "team-ghcp:gpt-5.4");
    assert.equal(runtime.defaultModel, "team-ghcp:claude-sonnet-5");
    // A discovered model, on a worker whose own listing failed.
    const failed = await applyModelDiscovery(typesWith(true), credentials, { discover: async () => { throw new Error("offline"); } });
    assert.equal(buildRuntimeRegistry(failed, credentials, "team-ghcp:gpt-6-sol").defaultModel, "team-ghcp:claude-sonnet-5");
    // A default the provider does offer is kept.
    assert.equal(buildRuntimeRegistry(listed, credentials, "team-ghcp:gpt-6-sol").defaultModel, "team-ghcp:gpt-6-sol");
});
