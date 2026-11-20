/**
 * Agent tools for session clones (docs/proposals/session-workspaces.md, 12.1).
 * They call the repo service, so the agent never runs git on a mirror.
 *
 *   list_repos()                     the repos served, and whether (and from where) more can be added
 *   add_repo({ url, name? })         serve one more repo, when the deployment allows its URL
 *   create_session_clone({ repo })   a clone for this session tree; returns the workspace record
 *   list_session_clones()            this tree's clones, and the ones that were removed
 *   remove_session_clone({ repo })   delete one (refused while a session is using it)
 *
 * A clone no session uses for a while is removed (the service's idle
 * cleanup; the answers say after how many hours). Pushed branches stay in the
 * remote.
 *
 * Clones belong to the session tree: the tools look up the calling session's
 * root in the worker's catalog.
 */
async function callService(baseUrl, method, pathname, body, { timeoutMs = 60_000 } = {}) {
    const response = await fetch(new URL(pathname, baseUrl), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${data?.error?.code ?? `HTTP ${response.status}`}: ${data?.error?.message ?? ""}`.trim());
    return data;
}

/** add_repo waits longer than the service, which answers "mirroring" after two minutes. */
const ADD_REPO_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.serviceUrl
 * @param {() => ({ getSession(id: string): Promise<any> } | null)} [options.getCatalog]  the worker's session catalog
 */
export function createRepoTools({ serviceUrl, getCatalog }) {
    const treeOf = async (invocation) => {
        const sessionId = invocation?.durableSessionId;
        if (!sessionId) throw new Error("this tool needs the calling session's id");
        const row = await getCatalog?.()?.getSession(sessionId).catch(() => null);
        return row?.rootSessionId || sessionId;
    };
    const json = (value) => JSON.stringify(value);
    return [
        {
            name: "list_repos",
            description:
                "List the repos you can clone here (create_session_clone takes their names), the repos still being "
                + "added, the adds that failed, and under `add` whether add_repo is allowed and from which URL prefixes.",
            parameters: { type: "object", properties: {} },
            handler: async () => json(await callService(serviceUrl, "GET", "/v1/repos")),
        },
        {
            name: "add_repo",
            description:
                "Serve one more repo from its clone URL, so create_session_clone can clone it. Allowed only for URLs "
                + "under the prefixes list_repos shows; the service fetches it with its own credentials (never put a "
                + "token in the URL). The first mirror of a large repo can take minutes: on status \"mirroring\", call "
                + "add_repo again with the same arguments to keep waiting. An added repo's clones push to a sandbox "
                + "remote on this deployment, never to the URL; its agents, skills and instructions are not loaded.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The repo's https clone URL, e.g. https://github.com/<owner>/<repo>.git" },
                    name: { type: "string", description: "Optional repo name; defaults to the URL's last segment without .git" },
                },
                required: ["url"],
            },
            handler: async (args) => json(await callService(serviceUrl, "POST", "/v1/repos", {
                upstream: args.url,
                ...(args.name ? { name: args.name } : {}),
            }, { timeoutMs: ADD_REPO_TIMEOUT_MS })),
        },
        {
            name: "create_session_clone",
            description:
                "Make a clone of a repo for this session tree (or return the existing one) and give back its workspace "
                + "record { root, folder }. Then call set_session_workspace with it to work there, or pass it to "
                + "spawn_agent as workspace to give a sub-agent its own checkout. A clone that no session uses for "
                + "removedAfterIdleHours is removed, and unpushed work with it: push your branch before you stop.",
            parameters: {
                type: "object",
                properties: { repo: { type: "string", description: "The repo name, as the deployment lists it" } },
                required: ["repo"],
            },
            handler: async (args, invocation) => json(await callService(serviceUrl, "POST", "/v1/clones", {
                rootSessionId: await treeOf(invocation),
                repo: args.repo,
                // The caller sees the answer; the service tells only the other sessions about an earlier removal.
                ...(invocation?.durableSessionId ? { sessionId: invocation.durableSessionId } : {}),
            })),
        },
        {
            name: "list_session_clones",
            description: "List this session tree's repo clones and their workspace records, when each was last used, "
                + "and the clones that were removed (when, why, and their last branch and commit).",
            parameters: { type: "object", properties: {} },
            handler: async (_args, invocation) => json(await callService(serviceUrl, "GET",
                `/v1/clones?rootSessionId=${encodeURIComponent(await treeOf(invocation))}`)),
        },
        {
            name: "remove_session_clone",
            description: "Delete one of this session tree's clones. Refused while any session is using it. Uncommitted work is lost.",
            parameters: {
                type: "object",
                properties: { repo: { type: "string", description: "The repo name of the clone to delete" } },
                required: ["repo"],
            },
            handler: async (args, invocation) => json(await callService(serviceUrl, "DELETE", "/v1/clones", {
                rootSessionId: await treeOf(invocation),
                repo: args.repo,
            })),
        },
    ];
}
