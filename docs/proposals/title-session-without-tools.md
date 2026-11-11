# No Tools for the Title Session by Default

## Summary

Make the session that writes session titles a text-only session by default:
no tools offered to its model, and every permission request refused. Today
that is opt-in (`PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS=1`); this proposal flips
the default and keeps `PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS=0` as the opt-out.

## Problem

The `summarizeSession` activity (`packages/sdk/src/session-proxy.ts`) titles
every session except system sessions and those whose title is locked. The
orchestration runs it at the end of a turn, once a minute has passed since the
session's first turn and then at most every five minutes, on any worker. It:

1. reads the session's last 50 events and builds a transcript of the user and
   assistant messages, up to 200 characters each;
2. starts a one-shot Copilot session through `createCopilotClient` with no
   tool filter and `approvePermissionForSession` as its permission handler;
3. sends the transcript with the title instructions and keeps the answer.

So the transcript, which can carry anything the session's agent read (a web
page, a file in a repository, another agent's message), reaches a model that
is offered the CLI's built-in tools with every permission approved. Measured
with the SDK's bundled CLI runtime on Windows
(`test/local/title-session-tools.test.js` without the limit), the title
request offered the model 21 tools, among them the shell (`powershell`; `bash`
on Linux and macOS), file tools (`view`, `create`, `edit`), `web_fetch`,
`web_search`, `task` and the GitHub MCP server's tools.

A transcript crafted to steer that model can therefore run commands on the
worker, read its files and send data out, outside the policy of the session it
came from. A session whose own tools are limited, or a deployment that limits
what its system sessions may do, still has this path, because the title
session is separate from both and needs no tool for its job.

## Proposal

1. `summarizeSession` creates its session with `availableTools: []`, a
   permission handler that refuses every request, `enableSessionStore: false`
   and `skipEmbeddingRetrieval: true`, unless the deployment sets
   `PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS=0`. The last two keep a session that
   reads every user's messages out of the CLI's cross-session store and
   embedding cache, which the SDK advises turning off where users share a
   deployment.
2. The configuration reference documents the new default and the opt-out.
3. Nothing else changes: the same prompt, model, provider, fallback title and
   schedule.

The code is the opt-in that exists today with its default flipped. The local
test shows that the CLI honors an empty `availableTools`, that the model then
gets a request with no tools, and that the title is still written.

## Compatibility

- Titles are text. The prompt asks for the title only, and the answer is
  stored as plain text, so no deployment should depend on a tool here.
- A deployment that does can set `PILOTSWARM_LIMIT_TITLE_SESSION_TOOLS=0`.
- When the model fails or answers nothing usable, the existing fallback
  title from the first user message still applies.

## Alternatives

- **Exclude the risky tools** with `excludedTools`. A new CLI version can add a
  tool, which would then be offered by default. Allowing nothing does not age.
- **Call the model API without the CLI.** That removes the CLI process from
  titling, but it repeats the provider, credential and request handling that
  `createCopilotClient` already does for every model PilotSwarm supports. A
  larger change for the same result.

## Non-Goals

- The session regeneration distiller (`regen-worker.ts`) also starts a CLI
  session that approves every permission. It runs only with
  `PILOTSWARM_REGEN_LLM_DISTILLER`, so it is left to a separate change.
- System sessions' tools are a separate setting.

## Test Plan

`test/local/title-session-tools.test.js` changes its expectations: with the
setting unset, and with `1`, the title request offers no tool and the title is
written; with `0`, the request carries the CLI's built-in tools.
