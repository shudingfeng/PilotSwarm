import { CopilotClient, CopilotRequestHandler, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotRequestContext, CopilotSession, ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import { createRequire } from "node:module";
import { createParser } from "eventsource-parser";
import { cliHooksDisabled, resetCliHomeSettings } from "./cli-hooks.js";
import { normalizeToolCatalog, type ToolCatalogCapability } from "./model-providers.js";

type JsonObject = Record<string, any>;
type ToolGroup = { body: JsonObject; name: string; toolNames: Set<string> };
export type ToolCatalogPolicyResolver = (request: Request, context: CopilotRequestContext, model: string) => ToolCatalogCapability | undefined;
const SCHEMA_DOCUMENT_KEYS = new Set(["$ref", "$id", "$schema", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]);

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDocumentScope(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasSchemaDocumentScope);
    if (!isObject(value)) return false;
    return Object.entries(value).some(([key, child]) => SCHEMA_DOCUMENT_KEYS.has(key) || hasSchemaDocumentScope(child));
}

function groupOverflowTools(body: JsonObject, policy?: ToolCatalogCapability): ToolGroup | undefined {
    if (!policy || typeof body.model !== "string" || !body.model
        || !Array.isArray(body.tools) || body.tools.length <= policy.maxDeclarations) return;
    const maxDeclarations = policy.maxDeclarations;
    const choice = body.tool_choice;
    const forcedName = isObject(choice) && choice.type === "function" && isObject(choice.function)
        && typeof choice.function.name === "string" && Object.keys(choice.function).length === 1
        && Object.keys(choice).every(key => key === "type" || key === "function") ? choice.function.name : undefined;
    if (choice != null && !["auto", "none", "required"].includes(choice) && forcedName === undefined) {
        throw new Error(`The ${maxDeclarations}-tool limit cannot be adapted with a restricted or unsupported tool choice. Select a compatible model or reduce the configured tool catalog.`);
    }
    const candidates = body.tools.filter((tool: unknown) => isObject(tool)
        && tool.type === "function" && isObject(tool.function)
        && typeof tool.function.name === "string" && tool.function.name !== forcedName
        && (tool.function.strict === undefined || tool.function.strict === false)
        && isObject(tool.function.parameters) && tool.function.parameters.type === "object"
        && !hasSchemaDocumentScope(tool.function.parameters)
        && Object.keys(tool).every(key => key === "type" || key === "function")
        && Object.keys(tool.function).every(key => ["name", "description", "parameters", "strict"].includes(key)));
    const required = body.tools.length - maxDeclarations + 1;
    if (candidates.length < required) {
        throw new Error(`The ${maxDeclarations}-tool limit cannot be met without changing strict or unsupported tool schemas. Select a compatible model or reduce the configured tool catalog.`);
    }
    const grouped = candidates.slice(-required);
    const groupedSet = new Set(grouped);
    const toolNames = new Set<string>(grouped.map((tool: JsonObject) => tool.function.name));
    const existingNames = new Set(body.tools.map((tool: JsonObject) => tool?.function?.name ?? tool?.custom?.name));
    let name = "pilotswarm_tool_dispatch";
    let suffix = 0;
    while (existingNames.has(name)) name = `pilotswarm_tool_dispatch_${++suffix}`;
    const dispatcher = {
        type: "function",
        function: {
            name,
            description: "Invoke one of the tools described by this schema. Provide a call object with its tool_name and original arguments. Each alternative describes one available tool.",
            parameters: {
                type: "object",
                properties: {
                    // Completions requires an object root; keep the paired selection union nested.
                    call: {
                        anyOf: grouped.map((tool: JsonObject) => ({
                            type: "object",
                            ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
                            properties: {
                                tool_name: { type: "string", enum: [tool.function.name] },
                                arguments: tool.function.parameters,
                            },
                            required: ["tool_name", "arguments"],
                            additionalProperties: false,
                        })),
                    },
                },
                required: ["call"],
                additionalProperties: false,
            },
        },
    };
    const messages = Array.isArray(body.messages) ? body.messages.map((message: JsonObject) => {
        if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
        return { ...message, tool_calls: message.tool_calls.map((call: JsonObject) => {
            if (!toolNames.has(call.function?.name) || typeof call.function.arguments !== "string") return call;
            let args;
            try { args = JSON.parse(call.function.arguments); } catch { return call; }
            if (!isObject(args)) return call;
            return { ...call, function: { ...call.function, name, arguments: JSON.stringify({ call: { tool_name: call.function.name, arguments: args } }) } };
        }) };
    }) : body.messages;
    return { name, toolNames, body: { ...body, tools: [...body.tools.filter((tool: JsonObject) => !groupedSet.has(tool)), dispatcher], ...(messages ? { messages } : {}) } };
}

function restoreToolCall(call: JsonObject, group: ToolGroup): JsonObject {
    if (call.function?.name !== group.name) return call;
    let args;
    try { args = JSON.parse(call.function.arguments); } catch {
        throw new Error("Tool dispatcher returned invalid JSON; refusing this tool call.");
    }
    const invocation = isObject(args) ? args.call : undefined;
    if (!isObject(args) || Object.keys(args).some(key => key !== "call") || !isObject(invocation)
        || typeof invocation.tool_name !== "string" || !group.toolNames.has(invocation.tool_name)
        || !isObject(invocation.arguments) || Object.keys(invocation).some(key => key !== "tool_name" && key !== "arguments")) {
        throw new Error("Tool dispatcher returned an invalid tool or arguments; refusing this tool call.");
    }
    return { ...call, function: { ...call.function, name: invocation.tool_name, arguments: JSON.stringify(invocation.arguments) } };
}

async function restoreGroupedResponse(response: Response, group: ToolGroup): Promise<Response> {
    if (!response.ok || !response.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (contentType.includes("application/json")) {
        const body = await response.json() as JsonObject;
        if (isObject(body) && Array.isArray(body.choices)) {
            body.choices = body.choices.map((choice: JsonObject) => Array.isArray(choice.message?.tool_calls)
                ? { ...choice, message: { ...choice.message, tool_calls: choice.message.tool_calls.map((call: JsonObject) => restoreToolCall(call, group)) } }
                : choice);
        }
        return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
    }
    if (!contentType.includes("text/event-stream")) return response;
    const pending = new Map<number, Map<number, JsonObject>>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let parser: ReturnType<typeof createParser>;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
            parser = createParser({ onEvent(event) {
                const emit = (data: string) => controller.enqueue(encoder.encode(
                    `${event.event ? `event: ${event.event}\n` : ""}${event.id !== undefined ? `id: ${event.id}\n` : ""}data: ${data}\n\n`,
                ));
                if (event.data === "[DONE]") {
                    if (pending.size) throw new Error("Provider ended the stream before completing its tool calls.");
                    emit(event.data);
                    return;
                }
                let chunk: JsonObject;
                try { chunk = JSON.parse(event.data); } catch { emit(event.data); return; }
                if (!isObject(chunk) || !Array.isArray(chunk.choices)) { emit(event.data); return; }
                const choices = chunk.choices.map((choice: JsonObject) => {
                    if (!isObject(choice)) return choice;
                    const delta = isObject(choice.delta) ? { ...choice.delta } : {};
                    if (Array.isArray(delta.tool_calls)) {
                        let calls = pending.get(choice.index);
                        if (!calls) { calls = new Map(); pending.set(choice.index, calls); }
                        for (const part of delta.tool_calls) {
                            if (!isObject(part) || !Number.isInteger(part.index) || part.index < 0) throw new Error("Provider returned an invalid streamed tool-call index.");
                            const previous = calls.get(part.index) ?? { index: part.index, function: { name: "", arguments: "" } };
                            calls.set(part.index, { ...previous, ...part, function: {
                                ...previous.function, ...part.function,
                                name: previous.function.name + (part.function?.name ?? ""),
                                arguments: previous.function.arguments + (part.function?.arguments ?? ""),
                            } });
                        }
                        delete delta.tool_calls;
                    }
                    if (choice.finish_reason != null && pending.has(choice.index)) {
                        const calls = [...pending.get(choice.index)!.values()]
                            .sort((left, right) => left.index - right.index)
                            .map(call => restoreToolCall(call, group));
                        const { usage, ...envelope } = chunk;
                        emit(JSON.stringify({ ...envelope, choices: [{ index: choice.index, delta: { tool_calls: calls }, finish_reason: null }] }));
                        pending.delete(choice.index);
                    }
                    return { ...choice, delta };
                });
                emit(JSON.stringify({ ...chunk, choices }));
            } });
        },
        transform(bytes) { parser.feed(decoder.decode(bytes, { stream: true })); },
        flush() {
            parser.feed(decoder.decode());
            parser.reset({ consume: true });
            if (pending.size) throw new Error("Provider closed the stream before completing its tool calls.");
        },
    });
    return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers });
}

/** Only OpenAI-compatible BYOK clients need the CLI 1.0.83 workaround. */
export function needsByokRequestCompatibility(provider: unknown): boolean {
    if (!provider || typeof provider !== "object") return false;
    const { type, wireApi } = provider as { type?: string; wireApi?: string };
    return (!type || type === "openai" || type === "azure") && (!wireApi || wireApi === "completions");
}

/**
 * CLI 1.0.83 leaks CAPI's `snippy: { enabled: false }` into BYOK chat
 * completions for GPT-5.6 models. Azure rejects the request before inference.
 * Keep this shim at the model HTTP boundary, not in prompts or model aliases.
 *
 * Attach ONLY to a dedicated OpenAI/Azure BYOK client: requestHandler forwards
 * all model traffic through Node, including WebSockets. Never attach it to a
 * GitHub Copilot client (native transport/auth and CAPI parameters must remain
 * intact), or an Anthropic/WIF client. Remove once the provider compatibility
 * tests pass without it. An explicit toolCatalog capability may group catalogs
 * above its declared limit through a typed dispatch function; restore calls
 * before the runtime's permission/tool hooks. Deployment names never enable it.
 */
export class ByokRequestCompatibility extends CopilotRequestHandler {
    private readonly toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver;

    constructor(toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver) {
        super();
        this.toolCatalog = typeof toolCatalog === "function" ? toolCatalog : normalizeToolCatalog(toolCatalog);
    }

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext,
    ): Promise<Response> {
        let group: ToolGroup | undefined;
        if (request.method === "POST" && /\/chat\/completions\/?$/.test(new URL(request.url).pathname)
            && request.headers.get("content-type")?.includes("application/json")) {
            // Invalid/non-object JSON remains the upstream's responsibility.
            const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
            if (isObject(body)) {
                const hasSnippy = Object.prototype.hasOwnProperty.call(body, "snippy");
                if (hasSnippy) delete body.snippy;
                const policy = typeof this.toolCatalog === "function"
                    ? (typeof body.model === "string" ? normalizeToolCatalog(this.toolCatalog(request, context, body.model)) : undefined)
                    : this.toolCatalog;
                group = groupOverflowTools(body, policy);
                if (hasSnippy || group) {
                    const headers = new Headers(request.headers);
                    headers.delete("content-length");
                    request = new Request(request, { headers, body: JSON.stringify(group?.body ?? body) });
                }
            }
        }
        const response = await super.sendRequest(request, context);
        return group ? restoreGroupedResponse(response, group) : response;
    }
}

/** Shared by durable sessions and the short-lived title/distillation clients. */
export function createCopilotClient(
    options: CopilotClientOptions,
    provider?: unknown,
    toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver,
): CopilotClient {
    if (toolCatalog && !needsByokRequestCompatibility(provider)) {
        throw new Error("toolCatalog requires an OpenAI-compatible Chat Completions provider.");
    }
    const env = scrubbedCliEnvironment(options.env ?? process.env);
    const secretNames = cliSecretEnvVars();
    let clientOptions: CopilotClientOptions;
    if (secretNames) {
        // The SDK refuses a client env next to a connection env, so the
        // caller's environment moves to the connection.
        const { env: callerEnv, ...rest } = options;
        const connectionEnv = definedValues(env ?? callerEnv ?? process.env);
        clientOptions = {
            ...rest,
            connection: RuntimeConnection.forStdio({
                path: connectionEnv.COPILOT_CLI_PATH || copilotCliProgramPath(),
                args: [`--secret-env-vars=${secretNames.join(",")}`],
                env: connectionEnv,
            }),
            ...(needsByokRequestCompatibility(provider) ? { requestHandler: new ByokRequestCompatibility(toolCatalog) } : {}),
        };
    } else {
        clientOptions = {
            ...options,
            ...(env ? { env } : {}),
            // Do not let ambient COPILOT_SDK_DEFAULT_CONNECTION opt a multi-tenant
            // worker into the experimental process-global in-process transport.
            // Stdio uses the pinned SDK runtime and honors COPILOT_CLI_PATH.
            connection: RuntimeConnection.forStdio(),
            ...(needsByokRequestCompatibility(provider) ? { requestHandler: new ByokRequestCompatibility(toolCatalog) } : {}),
        };
    }
    if (cliHooksDisabled()) {
        const home = (options.env ?? process.env).COPILOT_HOME?.trim();
        if (!home) {
            throw new Error("PILOTSWARM_CLI_DISABLE_HOOKS=1 needs COPILOT_HOME for every CLI, so that no account's own ~/.copilot is rewritten.");
        }
        return new HooksOffCopilotClient(clientOptions, home);
    }
    return new CopilotClient(clientOptions);
}

/**
 * With `PILOTSWARM_CLI_DISABLE_HOOKS=1`: puts the CLI home's settings files
 * in their fixed form before the CLI starts and before every session create
 * or resume, and turns off the working folder's hooks for every session.
 */
class HooksOffCopilotClient extends CopilotClient {
    private readonly cliHome: string;

    constructor(options: CopilotClientOptions, cliHome: string) {
        super(options);
        this.cliHome = cliHome;
    }

    override async start(): Promise<void> {
        await resetCliHomeSettings(this.cliHome);
        return super.start();
    }

    override async createSession(config: SessionConfig): Promise<CopilotSession> {
        await resetCliHomeSettings(this.cliHome);
        return super.createSession({ ...config, enableFileHooks: false });
    }

    override async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession> {
        await resetCliHomeSettings(this.cliHome);
        return super.resumeSession(sessionId, { ...config, enableFileHooks: false });
    }
}

/**
 * `PILOTSWARM_CLI_SECRET_ENV_VARS`: environment variables (comma-separated
 * names) that every CLI keeps from agents' shells, MCP servers and hooks,
 * such as `COPILOT_SDK_AUTH_TOKEN`, the token the SDK hands the CLI. The CLI
 * does not redact them from what it prints. Only the Copilot CLI program
 * takes `--secret-env-vars`; the SDK's bundled runtime refuses it, so with
 * names set every CLI starts as that program. Undefined when unset.
 */
export function cliSecretEnvVars(settings: NodeJS.ProcessEnv = process.env): string[] | undefined {
    const names = [...new Set(String(settings.PILOTSWARM_CLI_SECRET_ENV_VARS ?? "")
        .split(",").map((name) => name.trim()).filter(Boolean))];
    for (const name of names) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`PILOTSWARM_CLI_SECRET_ENV_VARS: "${name}" is not an environment variable name`);
        }
    }
    return names.length > 0 ? names : undefined;
}

/**
 * Session options for the Copilot CLI program: it offers its own bundled
 * skills through the `skill` tool, so every session lists none of them
 * (`includedBuiltinSkills: []`). The deployment's skills stay available.
 * Unchanged with the SDK's bundled runtime.
 */
export function withCliProgramSessionOptions<T extends object>(config: T): T {
    return cliSecretEnvVars() ? { ...config, includedBuiltinSkills: [] } : config;
}

let programPaths: Map<string, string> | undefined;

/**
 * The Copilot CLI program for this platform: the binary in the platform
 * package of `@github/copilot` that its npm launcher starts.
 */
export function copilotCliProgramPath(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
    const key = `${platform}-${arch}`;
    const known = programPaths?.get(key);
    if (known) return known;
    let fromLauncher: NodeJS.Require | undefined;
    try {
        fromLauncher = createRequire(createRequire(import.meta.url).resolve("@github/copilot/package.json"));
    } catch {
        // Reported below with the platform package's name.
    }
    const variants = platform === "linux" ? (usesMusl() ? ["linuxmusl", "linux"] : ["linux"]) : [platform];
    for (const variant of variants) {
        try {
            const resolved = fromLauncher?.resolve(`@github/copilot-${variant}-${arch}`);
            if (resolved) {
                (programPaths ??= new Map()).set(key, resolved);
                return resolved;
            }
        } catch {
            // Try the next variant.
        }
    }
    throw new Error(`PILOTSWARM_CLI_SECRET_ENV_VARS needs the Copilot CLI program, @github/copilot-${variants[0]}-${arch}, which is not installed.`);
}

function usesMusl(): boolean {
    const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
    return !report.header?.glibcVersionRuntime;
}

function definedValues(source: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined) env[name] = value;
    }
    return env;
}

const WINDOWS_CLI_ENV_BASELINE = [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE",
    "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
    "PSMODULEPATH", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "OS", "COMPUTERNAME",
    "USERNAME", "USERDOMAIN",
];
const POSIX_CLI_ENV_BASELINE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_*", "TERM"];
// COPILOT_HOME holds session state, the SDK picks its CLI by COPILOT_CLI_PATH, and the
// Copilot CLI program runs the unpacked copy of itself in COPILOT_PKG_CACHE_HOME.
const COPILOT_CLI_ENV_SETTINGS = ["COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_CLI_PATH", "COPILOT_PKG_CACHE_HOME"];

/**
 * `PILOTSWARM_SCRUB_CLI_ENV=1`: a CLI starts with only the names of `source`
 * that the platform needs, the Copilot settings and the deployment's own
 * tool settings in `PILOTSWARM_CLI_ENV_ALLOWLIST` (comma-separated; a
 * trailing `*` matches a prefix), compared case-insensitively. Agents' shells
 * and MCP servers then inherit none of the worker's other variables, its
 * credentials included. The SDK adds its own token after this. Returns
 * undefined, so nothing changes, when the setting is off.
 */
export function scrubbedCliEnvironment(
    source: NodeJS.ProcessEnv,
    settings: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): Record<string, string> | undefined {
    if (settings.PILOTSWARM_SCRUB_CLI_ENV !== "1") return undefined;
    const patterns = [
        ...(platform === "win32" ? WINDOWS_CLI_ENV_BASELINE : POSIX_CLI_ENV_BASELINE),
        ...COPILOT_CLI_ENV_SETTINGS,
        ...cliEnvAllowlist(settings.PILOTSWARM_CLI_ENV_ALLOWLIST),
    ];
    const exact = new Set(patterns.filter((pattern) => !pattern.endsWith("*")));
    const prefixes = patterns.filter((pattern) => pattern.endsWith("*")).map((pattern) => pattern.slice(0, -1));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
        if (value === undefined) continue;
        const key = name.toUpperCase();
        if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[name] = value;
    }
    return env;
}

function cliEnvAllowlist(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        if (!/^[A-Za-z0-9_()]+\*?$/.test(entry)) {
            throw new Error(`PILOTSWARM_CLI_ENV_ALLOWLIST: "${entry}" is neither a variable name nor a name prefix followed by *`);
        }
        return entry.toUpperCase();
    });
}

// A separate pool slot keeps the shim off native GHCP/Anthropic clients.
// NUL cannot occur in a GitHub token; this namespace cannot collide with one.
export const BYOK_CLIENT_PREFIX = "byok-openai\0";
