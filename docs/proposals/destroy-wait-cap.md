# Cap the Destroy Wait for Every Session

## Summary

Complete, cancel and delete wait for the session's `destroySession` activity
without a limit, so a session whose destroy can't run, or hangs, holds the
command: the caller gets no answer, a delete leaves the row, and every later
command for the session waits behind it. Orchestration `1.0.83` caps that wait
at `WORKSPACE_RELEASE_CAP_MS` (10 seconds) for sessions with an owner tag
([Windows worker pools](./windows-worker-pool.md)). This proposal applies the
same cap to every session, in a new orchestration version.

## Problem

`completeSession`, `cancelSession` (which also deletes) and
`failPendingShutdown` in `packages/sdk/src/orchestration/agents.ts` each
`yield runtime.session.destroy()` before they answer the command. The
orchestration reads its next command only after that activity returns, so
until then:

- the command gets no `done` answer, and a delete doesn't remove the
  session's descendants or its row;
- every later command for the session waits too.

`destroySession` (`packages/sdk/src/session-proxy.ts`) is session-affined: it
runs only on the worker that holds the session, where it releases the
session's workspace, which cancels its shells, and frees the session's
memory. The workspace release inside it is bounded at 5 seconds
(`SessionManager.releaseWorkspace`); the activity as a whole has no timeout.
It keeps a command waiting when:

1. the worker holding the session died, until duroxide's lock on the session
   expires;
2. that worker is alive but has no free activity slot, for example while long
   turns run;
3. the activity waits on something that doesn't return: the session's lock in
   `SessionManager.destroySession`, held for example by a turn still unwinding
   after a stop, or a Copilot CLI process that stopped answering.

`releaseAffinity` already guards the same kind of wait: it races
`releaseWorkspace` against `WORKSPACE_RELEASE_CAP_MS`, because "a
session-pinned activity has no timeout of its own, and a dead or hung worker
must not hold the session" (`packages/sdk/src/orchestration/lifecycle.ts`).
The forced delete (`deleteSession(sessionId, reason, { force: true })`) ends a
tree that doesn't settle, but only for a delete.

## Proposal

1. In a new orchestration version, `completeSession`, `cancelSession` and
   `failPendingShutdown` race `runtime.session.destroy()` against
   `ctx.scheduleTimer(WORKSPACE_RELEASE_CAP_MS)` for every session, as
   `1.0.83` does for owner-tagged sessions and `releaseAffinity` does for
   `releaseWorkspace`.
2. When the timer wins, the orchestration traces it and goes on: it answers
   the command, and a delete removes the descendants and the row, as today.
3. Every older version keeps its frozen handler, so a running session changes
   behavior only when it moves to the new version at `continueAsNew`.

What happens to a destroy that loses the race was measured with
duroxide-node 0.2.4 and PilotSwarm's lock settings:

- **Not started yet:** duroxide cancels it, and it never runs. The worker that
  holds the session reclaims its memory, shells and folder at its eviction
  sweep (`PILOTSWARM_SESSION_EVICT_MS`, 35 minutes by default), which runs only
  on workers with a session store. If no worker holds the session, there is
  nothing to reclaim.
- **Already running:** it runs to the end. duroxide flags `isCancelled()` only
  at the activity's next lock renewal, and `destroySession` doesn't check the
  flag, so the cleanup still happens, after the command has been answered.

Complete, cancel and delete end the orchestration, so a destroy that runs on
can't overlap a later turn of the same orchestration.

## Trade-offs

- **A prompt answer or a prompt cleanup.** In case 2, the destroy hasn't
  started when the cap fires, so it no longer runs when a slot frees: the
  session's shells and folder stay until the eviction sweep, or, on a worker
  without a session store, until the worker restarts. Today the command waits
  for the slot instead. The sweep also dehydrates a session that has no
  snapshot marker (an old one) instead of deleting it, which would write state
  for a session already deleted; the resource manager's
  `purge_orphaned_blobs` removes such state. Options: accept it; have the
  eviction sweep reclaim a session whose catalog row is terminal without
  waiting for its idle window, and without dehydrating it; or use a longer,
  separate cap for the destroy.
- **What `done` means.** Today a `done` answer means the session's shells were
  cancelled and its folder released. With the cap, it means the cleanup ran,
  is running or was given up, and the eviction sweep is the backstop. No
  caller in this repository relies on the stronger meaning; an application
  that does would see the difference only when a destroy takes longer than the
  cap.

## Compatibility

- Versioned: sessions on older versions replay and run as they do today.
- On a healthy worker the destroy returns well within the cap, because its
  slowest step, the workspace release, is bounded at 5 seconds. The common
  path doesn't change.
- A delete still removes the descendants and the row, in the same order.

## Alternatives

- **Keep the cap for owner-tagged sessions only.** Every other session keeps
  an unbounded wait, though cases 1 to 3 apply to it too.
- **A setting.** Orchestration code doesn't read `process.env`, so the setting
  would travel in the session's input, as `workspaceBusyFastRelease` does in
  `1.0.83`. Possible, but a bound that only shortens a wait is simpler as the
  default.
- **Stop a late destroy.** Checking `isCancelled()` in `destroySession` would
  end it early, which is the opposite of what is wanted: the cleanup should
  finish.

## Non-Goals

- A lifecycle command still waits for a turn activity in flight; this changes
  only the wait for the destroy.
- The forced delete stays the way to end a tree whose sessions don't settle.

## Test Plan

- `test/local/durability.test.js`: a session started on the previous version
  replays with its frozen handler and moves to the new version at
  `continueAsNew`.
- A new local test holds a session on a worker whose `destroySession` is held
  back: complete, cancel and delete each answer within
  `WORKSPACE_RELEASE_CAP_MS` plus a margin, the delete removes the row, and
  once the destroy is let go it still releases the workspace and records
  `session.workspace_released`.
- The existing lifecycle tests (`turn-lifecycle.test.js`,
  `delete-cascade.test.js`, `capability-session-lifecycle.test.js`) pass
  unchanged.

## Open Questions

1. The same 10-second cap as the workspace release, or a separate, longer one
   for the destroy?
2. Should the eviction sweep reclaim a session whose catalog row is terminal
   without waiting out its idle window, and never dehydrate it?
