/**
 * A stand-in for GitHub's API and the Copilot API, so the real Copilot CLI's
 * native GitHub transport runs offline with whatever token a test hands it.
 *
 * The pinned CLI (1.0.83) takes GitHub's API address from
 * COPILOT_DEBUG_GITHUB_API_URL. It asks `GET /copilot_internal/user` with the
 * token, whose answer names this server as the Copilot API too, then lists
 * `GET /models` and sends chat completions here. Session requests are
 * answered by `respond(body, position)`, as with the scripted model;
 * auxiliary ones (titles) get "Fixture title". Every request is recorded
 * with its Authorization header, so a test can tell which token the CLI used.
 * With `refuse: true` every request gets GitHub's 401, as a bad token does;
 * a session on its own provider (BYOK) still runs then.
 */
import { createServer } from "node:http";
import { isSessionRequest, requestPosition } from "./scripted-model.mjs";

export const FAKE_GITHUB_MODEL = "fixture-model";

const MODEL_LIST = {
    data: [{
        id: FAKE_GITHUB_MODEL, name: "Fixture model", object: "model", vendor: "fixture", version: "1",
        model_picker_enabled: true, preview: false, policy: { state: "enabled" }, supported_endpoints: ["/chat/completions"],
        capabilities: {
            type: "chat", family: "fixture", object: "model_capabilities", tokenizer: "o200k_base",
            limits: { max_context_window_tokens: 128000, max_output_tokens: 4096, max_prompt_tokens: 100000 },
            supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
        },
    }],
};

function writeCompletion(res, body, answer, id) {
    const calls = answer.tools?.map((tool, index) => ({
        id: `${id}-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) },
    }));
    const message = { role: "assistant", content: answer.content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) };
    const finishReason = calls?.length ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = calls?.length ? { ...message, tool_calls: calls.map((call, index) => ({ index, ...call })) } : message;
    for (const [part, finish] of [[delta, null], [{}, finishReason]]) {
        res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", model: body.model,
            choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage } : {}),
        })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
}

/**
 * Start the stand-in. Returns `{ baseUrl, requests, close }`; set
 * COPILOT_DEBUG_GITHUB_API_URL to `baseUrl` in the CLI's environment.
 */
export async function startFakeGitHubCopilot({ respond = () => ({ content: "ok" }), refuse = false } = {}) {
    const requests = [];
    let baseUrl = "";
    const server = createServer(async (req, res) => {
        const json = (status, payload) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(payload));
        };
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString();
            const path = new URL(req.url, baseUrl).pathname;
            const record = { method: req.method, path, authorization: req.headers.authorization ?? null };
            requests.push(record);
            if (refuse) return json(401, { message: "Bad credentials" });
            if (req.method === "GET" && path === "/copilot_internal/user") {
                return json(200, { login: "fixture", copilot_plan: "individual", chat_enabled: true, endpoints: { api: baseUrl } });
            }
            if (req.method === "GET" && path === "/models") return json(200, MODEL_LIST);
            if (req.method === "POST" && path.endsWith("/chat/completions")) {
                const body = JSON.parse(raw);
                record.body = body;
                record.position = requestPosition(body);
                record.session = isSessionRequest(body);
                const answer = record.session ? await respond(body, record.position) : { content: "Fixture title" };
                return writeCompletion(res, body, answer ?? { content: "ok" }, `fake-github-${requests.length}`);
            }
            json(404, { message: "Not Found" });
        } catch (error) {
            if (!res.destroyed) json(500, { message: String(error?.stack ?? error) });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl,
        requests,
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
