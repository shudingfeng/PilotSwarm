/**
 * Live model discovery for GitHub Copilot provider types.
 *
 * A `github` provider type may set `discoverModels: true` in the model
 * catalog. Each provider of that type then offers the models its own GitHub
 * token can use, as reported by the Copilot runtime's `listModels()`, instead
 * of the type's hand-written list alone:
 *
 * - a catalog model the token can use keeps its curated metadata (cost,
 *   reasoning efforts, context tiers) and its place in the catalog order;
 * - a model the token can use that the catalog does not name is added after
 *   them, with what the Copilot runtime reports about it;
 * - a catalog model the token cannot use is not offered by that provider.
 *
 * When discovery fails (no network, a CLI that will not start, a revoked
 * token) the provider offers the catalog list unchanged, as it would with
 * discovery off. Results are cached per token, so a picker, a session create
 * and the worker's 30-second registry refresh share one listing.
 *
 * @module
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createCopilotClient } from "./copilot-client.js";
import { isReasoningEffort, type ModelEntry, type ReasoningEffort } from "./model-providers.js";

/** What discovery keeps of one Copilot `ModelInfo`. */
export interface DiscoveredModel {
    id: string;
    name?: string;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string;
    billingMultiplier?: number;
    policyState?: string;
}

/**
 * Lists the models one GitHub token can use. Injectable for tests. The signal
 * aborts when the listing times out, so the lister can release what it holds.
 */
export type CopilotModelLister = (token: string, signal?: AbortSignal) => Promise<DiscoveredModel[]>;

const FRESH_MS = 10 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
// Each listing starts a Copilot CLI process; a cluster with many personal
// tokens must not start them all at once.
const MAX_CONCURRENT_LISTINGS = 4;

/**
 * `auto` asks Copilot to pick a model per request. It reports no limits and
 * no reasoning efforts, so it cannot carry the per-session choices the
 * pickers offer; it is not listed.
 */
const EXCLUDED_MODEL_IDS = new Set(["auto"]);

interface CacheEntry {
    models: DiscoveredModel[] | null;
    fetchedAt: number;
    /** A listing has finished, successfully or not. */
    listed: boolean;
    inflight?: Promise<DiscoveredModel[] | null>;
}

const cache = new Map<string, CacheEntry>();

/** A stable, non-reversible key for a token, so the cache never holds one. */
export function modelDiscoveryKey(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** The default lister: a short-lived Copilot client on the token. */
export const listCopilotModelsWithSdk: CopilotModelLister = async (token, signal) => {
    const client = createCopilotClient({
        gitHubToken: token,
        logLevel: "error",
        // Keep the listing client's CLI state out of the user's ~/.copilot and
        // away from any session state directory.
        env: { ...process.env, COPILOT_HOME: path.join(os.tmpdir(), "pilotswarm-model-discovery") },
    });
    // A timed-out listing must not leave its CLI process running.
    const forceStop = () => { void client.forceStop().catch(() => {}); };
    signal?.addEventListener("abort", forceStop, { once: true });
    try {
        await client.start();
        const models = await client.listModels();
        return models.map((model: any) => ({
            id: String(model?.id ?? ""),
            ...(model?.name ? { name: String(model.name) } : {}),
            ...(Array.isArray(model?.supportedReasoningEfforts)
                ? { supportedReasoningEfforts: model.supportedReasoningEfforts.map(String) }
                : {}),
            ...(model?.defaultReasoningEffort ? { defaultReasoningEffort: String(model.defaultReasoningEffort) } : {}),
            ...(Number.isFinite(model?.billing?.multiplier) ? { billingMultiplier: Number(model.billing.multiplier) } : {}),
            ...(model?.policy?.state ? { policyState: String(model.policy.state) } : {}),
        }));
    } finally {
        signal?.removeEventListener("abort", forceStop);
        if (!signal?.aborted) await client.stop().catch(() => {});
    }
};

/** Models a session can run: named, not `auto`, not disabled by policy. */
export function usableDiscoveredModels(models: DiscoveredModel[]): DiscoveredModel[] {
    const seen = new Set<string>();
    const out: DiscoveredModel[] = [];
    for (const model of models) {
        const id = String(model?.id ?? "").trim();
        if (!id || id.includes(":") || EXCLUDED_MODEL_IDS.has(id) || seen.has(id)) continue;
        if (model.policyState === "disabled") continue;
        seen.add(id);
        out.push({ ...model, id });
    }
    return out;
}

let activeListings = 0;
const waitingListings: Array<() => void> = [];

async function withListingSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeListings >= MAX_CONCURRENT_LISTINGS) {
        await new Promise<void>((resolve) => waitingListings.push(resolve));
    } else {
        activeListings++;
    }
    try {
        return await run();
    } finally {
        // Hand the slot straight to the next waiter, or release it.
        const next = waitingListings.shift();
        if (next) next();
        else activeListings--;
    }
}

function listWithTimeout(lister: CopilotModelLister, token: string, ms: number): Promise<DiscoveredModel[]> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${ms} ms`));
        }, ms);
        timer.unref?.();
    });
    return Promise.race([lister(token, controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The models one GitHub token can use, or null when they could not be
 * listed. Only a token's first listing is awaited. After that a fresh result
 * is served from cache, a stale one is served while a refresh runs in the
 * background, and a failed one is retried in the background after a minute
 * while callers get null (the catalog list) at once, so one bad token never
 * holds up anyone else's request.
 */
export async function discoverCopilotModels(
    token: string,
    options: { lister?: CopilotModelLister; now?: () => number; timeoutMs?: number } = {},
): Promise<DiscoveredModel[] | null> {
    if (!token) return null;
    const now = options.now ?? Date.now;
    const lister = options.lister ?? listCopilotModelsWithSdk;
    const key = modelDiscoveryKey(token);
    const entry = cache.get(key);
    const age = entry ? now() - entry.fetchedAt : Infinity;

    if (entry?.listed && entry.models && age < FRESH_MS) return entry.models;
    if (entry?.listed && !entry.models && age < RETRY_AFTER_FAILURE_MS) return null;

    const refresh = entry?.inflight ?? (() => {
        const inflight = withListingSlot(() => listWithTimeout(lister, token, options.timeoutMs ?? LIST_TIMEOUT_MS))
            .then((models) => {
                const usable = usableDiscoveredModels(Array.isArray(models) ? models : []);
                if (usable.length === 0) throw new Error("the Copilot runtime listed no usable models");
                cache.set(key, { models: usable, fetchedAt: now(), listed: true });
                return usable;
            })
            .catch((error) => {
                const previous = cache.get(key)?.models ?? null;
                // Keep serving a previous list, and try again in a minute.
                cache.set(key, {
                    models: previous,
                    fetchedAt: previous ? now() - FRESH_MS + RETRY_AFTER_FAILURE_MS : now(),
                    listed: true,
                });
                console.warn(`[model-discovery] listing Copilot models failed; using the catalog list: ${String(error?.message ?? error)}`);
                return previous;
            });
        cache.set(key, {
            models: entry?.models ?? null,
            fetchedAt: entry?.fetchedAt ?? 0,
            listed: entry?.listed ?? false,
            inflight,
        });
        return inflight;
    })();

    // Only a token that has never finished a listing waits for one.
    if (entry?.listed) return entry.models;
    return refresh;
}

function costTier(multiplier: number | undefined): ModelEntry["cost"] | undefined {
    if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier < 0) return undefined;
    if (multiplier < 1) return "low";
    if (multiplier <= 1.5) return "medium";
    return "high";
}

/** A catalog entry for a model the catalog does not name. */
export function discoveredModelEntry(model: DiscoveredModel): ModelEntry {
    const efforts: ReasoningEffort[] = [];
    for (const raw of model.supportedReasoningEfforts ?? []) {
        const value = String(raw).trim().toLowerCase();
        if (isReasoningEffort(value) && !efforts.includes(value)) efforts.push(value);
    }
    const defaultEffort = String(model.defaultReasoningEffort ?? "").trim().toLowerCase();
    const cost = costTier(model.billingMultiplier);
    return {
        name: model.id,
        ...(model.name && model.name !== model.id ? { description: model.name } : {}),
        ...(cost ? { cost } : {}),
        ...(efforts.length > 0 ? { supportedReasoningEfforts: efforts } : {}),
        ...(efforts.includes(defaultEffort as ReasoningEffort) ? { defaultReasoningEffort: defaultEffort as ReasoningEffort } : {}),
    };
}

/**
 * The catalog list followed by every discovered model it does not name, in
 * the order the listings report them. Catalog entries are never rewritten.
 */
export function mergeDiscoveredModels(
    catalog: ReadonlyArray<string | ModelEntry>,
    listings: ReadonlyArray<ReadonlyArray<DiscoveredModel>>,
): (string | ModelEntry)[] {
    const out = catalog.slice();
    const named = new Set(catalog.map((entry) => (typeof entry === "string" ? entry : entry.name)));
    for (const listing of listings) {
        for (const model of listing) {
            if (named.has(model.id)) continue;
            named.add(model.id);
            out.push(discoveredModelEntry(model));
        }
    }
    return out;
}
