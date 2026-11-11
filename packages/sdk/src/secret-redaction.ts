/**
 * Secret redaction for what PilotSwarm persists: session events (tool output
 * included), turn results and logs.
 *
 * With PILOTSWARM_PERSONAL_SECRETS=external, GitHub tokens (`github_pat_`,
 * `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) are redacted. Prefixes listed in
 * PILOTSWARM_REDACT_SECRET_PREFIXES are redacted in either mode. With
 * neither setting, everything passes through untouched.
 *
 * A match keeps its prefix, so a reader can tell which kind of secret was
 * there: `ghp_abc…` becomes `ghp_[REDACTED]`.
 */
import { createRequire } from "node:module";
import { PERSONAL_SECRETS_SETTING, personalSecretsMode } from "./personal-secret-store.js";

export const REDACT_SECRET_PREFIXES_SETTING = "PILOTSWARM_REDACT_SECRET_PREFIXES";

const REDACTED = "[REDACTED]";
const GITHUB_TOKEN_PREFIXES = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
// GitHub tokens are letters, digits and underscores. A deployment's own
// token may be base64, base64url or a JWT, so its match runs to the next
// space, quote, bracket, comma or semicolon.
const GITHUB_TOKEN_PATTERN = "(?:github_pat_|gh[opusr]_)[A-Za-z0-9_]+";
const LISTED_TOKEN_BODY = "[^\\s\"'`<>()\\[\\]{},;]+";

/**
 * The prefixes listed in PILOTSWARM_REDACT_SECRET_PREFIXES (comma-separated).
 * Each must be at least three characters, letters, digits, `_` and `-`,
 * starting with a letter or digit: a shorter one would redact ordinary words.
 */
export function redactSecretPrefixes(env: Record<string, string | undefined> = process.env): string[] {
    const prefixes = [...new Set(String(env[REDACT_SECRET_PREFIXES_SETTING] ?? "")
        .split(",").map((entry) => entry.trim()).filter(Boolean))];
    for (const prefix of prefixes) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/.test(prefix)) {
            throw new Error(
                `${REDACT_SECRET_PREFIXES_SETTING}: "${prefix}" is not a token prefix. `
                + "Use at least three letters, digits, _ or -, starting with a letter or digit.",
            );
        }
    }
    return prefixes;
}

interface Redaction {
    pattern: RegExp;
    prefixes: string[];
}

let compiled: { key: string; redaction: Redaction | null } | null = null;

/** What these settings redact, or null when they redact nothing. Throws on a malformed setting. */
function redactionFor(env: Record<string, string | undefined>): Redaction | null {
    const key = `${env[PERSONAL_SECRETS_SETTING] ?? ""}\u0000${env[REDACT_SECRET_PREFIXES_SETTING] ?? ""}`;
    if (compiled?.key === key) return compiled.redaction;
    const github = personalSecretsMode(env) === "external";
    const listed = redactSecretPrefixes(env);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    const alternatives = [
        ...(github ? [GITHUB_TOKEN_PATTERN] : []),
        ...listed.map((prefix) => `${escape(prefix)}${LISTED_TOKEN_BODY}`),
    ];
    const redaction = alternatives.length === 0 ? null : {
        // Not inside a longer word: `my_ghp_setting` is left alone.
        pattern: new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives.join("|")})`, "g"),
        // Longest first, so a listed prefix that extends a GitHub one is kept whole.
        prefixes: [...(github ? GITHUB_TOKEN_PREFIXES : []), ...listed].sort((a, b) => b.length - a.length),
    };
    compiled = { key, redaction };
    return redaction;
}

/** Is anything redacted under these settings? Throws on a malformed setting. */
export function secretRedactionEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return redactionFor(env) !== null;
}

function redactWith(redaction: Redaction, text: string): string {
    return text.replace(redaction.pattern, (match) =>
        `${redaction.prefixes.find((prefix) => match.startsWith(prefix)) ?? ""}${REDACTED}`);
}

/** The text with every secret replaced by its prefix and `[REDACTED]`. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
    const redaction = redactionFor(env);
    return redaction ? redactWith(redaction, text) : text;
}

/**
 * A copy of a JSON-shaped value (strings, arrays and plain objects, keys
 * included) with every secret redacted. Returns the value itself when the
 * settings redact nothing.
 */
export function redactSecretsIn<T>(value: T, env: Record<string, string | undefined> = process.env): T {
    const redaction = redactionFor(env);
    if (!redaction) return value;
    const seen = new WeakMap<object, unknown>();
    const walk = (item: unknown): unknown => {
        if (typeof item === "string") return redactWith(redaction, item);
        if (!item || typeof item !== "object") return item;
        if (seen.has(item)) return seen.get(item);
        if (Array.isArray(item)) {
            const out: unknown[] = [];
            seen.set(item, out);
            for (const entry of item) out.push(walk(entry));
            return out;
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) return item;
        const out: Record<string, unknown> = {};
        seen.set(item, out);
        for (const [key, entry] of Object.entries(item)) out[redactWith(redaction, key)] = walk(entry);
        return out;
    };
    return walk(value) as T;
}

const INSTALLED = Symbol.for("pilotswarm.secretRedaction");

function redactChunk(chunk: unknown): unknown {
    if (typeof chunk === "string") return redactSecrets(chunk);
    if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
        const redacted = redactSecrets(text);
        return redacted === text ? chunk : Buffer.from(redacted, "utf8");
    }
    return chunk;
}

function redactStream(stream: NodeJS.WriteStream): void {
    const original = stream.write as typeof stream.write & { [INSTALLED]?: boolean };
    if (original[INSTALLED]) return;
    const write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
        return (original as (...args: unknown[]) => boolean).call(stream, redactChunk(chunk), ...rest);
    } as typeof stream.write & { [INSTALLED]?: boolean };
    write[INSTALLED] = true;
    stream.write = write;
}

function redactDurableTraces(): void {
    let durable: Record<string, any>;
    try {
        durable = createRequire(import.meta.url)("duroxide");
    } catch {
        return;
    }
    for (const context of [durable.OrchestrationContext, durable.ActivityContext]) {
        const prototype = context?.prototype;
        if (!prototype) continue;
        for (const method of ["traceInfo", "traceWarn", "traceError", "traceDebug"]) {
            const original = prototype[method];
            if (typeof original !== "function" || original[INSTALLED]) continue;
            const traced = function (this: unknown, message: unknown) {
                return original.call(this, redactSecrets(String(message)));
            } as ((message: unknown) => unknown) & { [INSTALLED]?: boolean };
            traced[INSTALLED] = true;
            prototype[method] = traced;
        }
    }
}

/**
 * Redact secrets from this process's logs: everything written to stdout and
 * stderr, and the orchestration and activity traces. Does nothing when the
 * settings redact nothing; installing twice changes nothing. A secret split
 * across two writes is not recognized.
 */
export function installLogRedaction(env: Record<string, string | undefined> = process.env): boolean {
    if (!redactionFor(env)) return false;
    redactStream(process.stdout);
    redactStream(process.stderr);
    redactDurableTraces();
    return true;
}
