# Latest-1.0.84 correspondence

Code: `packages/sdk/src/` at `34e73cb1`: `76e4af8f` (the tip of `feature/windows-workers`) with the two commits the
owner-routing review asked of 1.0.84, `e94c62e4` and `34e73cb1`. 1.0.84 is the latest version in `orchestration/`;
1.0.83 is frozen in `orchestration_1_0_83/`, the code v0.8.11 released but for its version literal.
Labels: **Code** (code behavior), **Rule** (a rule to evaluate), **Simplification** (a model simplification). "The
proposal" is `docs/proposals/windows-worker-pool.md`, cited by section.

## Checks at 34e73cb1 before binding

| Item | Verdict | Evidence at 34e73cb1 |
|---|---|---|
| Each version maps to its exact module | holds | `orchestration-registry.ts` 84 `{ version: "1.0.83", handler: durableSessionOrchestration_1_0_83 }` (from the frozen `orchestration_1_0_83/`), 85 `{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_84 }` (from `orchestration/`); `orchestration-version.ts` 15 `"1.0.84"`; registered by the loop at `worker.ts` 1149-1150 |
| The frozen 1.0.83 stamps "1.0.83" | holds | `orchestration_1_0_83/runtime.ts` 23; 1.0.84's `runtime.ts` 24 follows the latest constant |
| The frozen copies are unchanged | holds | `git diff --stat 76e4af8f 34e73cb1 -- packages/sdk/src/orchestration_*` is empty |
| What 1.0.84 changes against 1.0.83 | listed | `git diff --no-index orchestration_1_0_83 orchestration`: only `agents.ts`, `index.ts`, `lifecycle.ts`, `runtime.ts`, `state.ts` and `turn.ts`. `queue.ts`, `intake-machine.ts`, `intake-state.ts`, `intake-wiring.ts`, `utils.ts` and `workflow-turn-failure.ts` are byte-identical |
| What the two commits change in the bound code | listed | `orchestration/turn.ts` only (`agents.ts`, `lifecycle.ts`, `state.ts`, `client.ts`, `session-manager.ts`, `managed-session.ts`, `worker.ts`, `wait-affinity.ts` and the registry are byte-identical to `76e4af8f`); `session-proxy.ts` gains the backstop at 2168-2194, so its lines after that move by 28; `owner-routing.ts` gains two exports after line 189 |
| Every change is behind an input | holds | Each 1.0.84 change reads `options.ownerTag` or `options.workspaceBusyFastRelease`: the post-turn reset is gated at `turn.ts` 1447-1448; an uncounted hold comes only from the capacity branch inside `if (runtime.options.ownerTag)` (497-524); the deny's second status publish only from that branch (502) |

## The two commits, as bound

| Commit | Change | Code at 34e73cb1 | Model switch |
|---|---|---|---|
| `e94c62e4` | The post-turn reset of a session without a workspace only with an owner tag or the fast flag | `turn.ts` 1440-1451 | `CapacityHold` `ResetRule = "flagged"`; `"all"` is `76e4af8f`; `"both"` (tag and flag) is a mutation that must fail |
| `e94c62e4` | An uncounted hold keeps the step | `turn.ts` 1319 | `StepRule = "keep"`; `"advance"` is `76e4af8f` |
| `34e73cb1` | An uncounted hold waits its `retryAfterMs`, `CAPACITY_UNAVAILABLE_RETRY_MS` (60 s) without one, whatever the step; it keeps the step and the failure count and releases nothing | `turn.ts` 1309-1319 (`delayMs`, step), 1304-1308 (failures), 1332, 1338 (releases only when counted); `owner-routing.ts` 30 | `StepRule = "flat"`: every bound case |
| `34e73cb1` | A capacity deny publishes the error status again after the response is written, before `updateCmsState` | `turn.ts` 301, 315-317 (`statusAfterResponse`), 502 (only the deny passes it) | none: see "Not modelled" |

### Where the code and the description differ

1. **An unanswered request waits its `retryAfterMs`** (`Inv_UncountedWait`, in every bound case). The earlier rule of
   `e94c62e4` kept the step and waited `max(schedule[step], retryAfterMs)` on the default schedule, so after k busy
   answers an unanswered request waited 60, 120, 300 or 900 s, also under the fast policy
   (`ref.ch-e94c62e4-unanswered-after-busy`). `34e73cb1` waits `retryAfterMs` whatever the step.
2. **No floor** (`wit.ch-uncounted-no-floor`, code behavior). A requester that itself answers `busy` with the code
   `CAPACITY_UNAVAILABLE` and a short `retryAfterMs` makes its sessions ask that often; before `34e73cb1` the schedule's
   30 s first step was a floor. PilotSwarm's own unanswered and failed requests always carry 60 s
   (`owner-routing.ts` 128-130). `design.md` (856-857 at `34e73cb1`) doesn't name this case: its `busy` row's "at
   least `retryAfterMs`" holds for a counted answer.
3. **A capacity `busy` never counts twice on one worker** (code behavior). The refusal it builds has no `workerNodeId`
   (`turn.ts` 510-517), so the failure record is `{ "", 1 }` every time (1304-1308). Under the default policy only the
   hold window can release affinity for it (`planHoldRelease`, `wait-affinity.ts` 45-50); with the default
   `idleTimeout` of 1,800 s and waits of at most 900 s, it never does. The fast policy releases at the first.
4. **At `76e4af8f` the reset changed untagged sessions** (`ref.ch-76e4af8f-reset`): 1.0.83 keeps a gate-held session's
   step and failures after a turn; `76e4af8f` cleared them. `e94c62e4` restores 1.0.83's behavior (`ch.untagged`).
5. **A deny drops only its own prompt** (code behavior, `wit.ch-deny-keeps-held`). Prompts held by earlier busy answers
   stay in the stash (`projectNonRetryableTurnFailure`, `turn.ts` 292-335, does not clear it). No timer is armed, so
   they wait for the person's next message; the next turn that runs delivers them.
6. **The capacity request itself is not capped** (design limit, `oc.no-host`). It is a plain activity
   (`lifecycle.ts` 240); the 15 s limit runs inside it, on a worker with a requester (`owner-routing.ts` 162-189). With
   no such worker, a turn attempt and a set-workspace command wait for one, and so do the commands behind them.
7. **A turn's activity is never raced** (design limit, `oc.turn-vm-lost`), as the proposal says (Capacity requests,
   "Timers, not the queue"): after an `ok` that no worker of the owner follows, the commands wait behind the turn.

### Not modelled: the deny's status

No model tracks the custom status, its `responseVersion` or `response.latest`, and none models the client's cursor
sync (`_syncTurnCursors`): the second publish of `34e73cb1` (`turn.ts` 315-317) changes no state that any model holds.
`CapacityHold`'s deny is bound to `turn.ts` 501-504 and 292-335 for what it does to the hold, the stash and the timer,
which the second publish does not touch.

## CapacityHold

| Model | Code at 34e73cb1 | Label |
|---|---|---|
| `Attempt`, `Asks`: a tagged session asks before each turn, also when it keeps its worker | `turn.ts` 492-524 | Code |
| `AnswerChoices`: ok, deny, busy (`WORKSPACE_BUSY`, another code, `CAPACITY_UNAVAILABLE`), unanswered | `owner-routing.ts` 123-155 (`normalizeOwnerCapacityAnswer`), 128-130 (`capacityUnavailable`, 60 s), 162-189 (15 s, a failure, no requester); `lifecycle.ts` 236-250 (a failed activity); `session-proxy.ts` 7281-7295 (no row) | Code |
| `Refused` deny: no hold, no turn index, the attempt's prompt dropped | `turn.ts` 501-504, 292-335; the turn index rises only for a turn that ran (834) | Code |
| `Refused` busy: a workspace-gate wait, counted unless `CAPACITY_UNAVAILABLE` | `turn.ts` 505-522 (the refusal 510-517, `countsAsFailure` 519) | Code |
| `RunTurn` gate refusals, with the worker | `session-proxy.ts` 1152-1174 (admission busy), 1200-1216 (credential busy), 2521-2529 (attach or check); `turn.ts` 1536-1538 | Code |
| `Hold84`: failures, wait, step, release | `turn.ts` 1276-1362 (1301-1319, 1331-1345); `state.ts` 508, 514, 602-615; `FlatWait`: 1309-1312 | Code (`StepRule = "flat"`) |
| `Hold83` | `orchestration_1_0_83/turn.ts` 1219-1285 | Code |
| `Pass84`, `Resets84` | `turn.ts` 1427-1451 | Code (1447-1448: `ResetRule = "flagged"`) |
| `Pass83` | `orchestration_1_0_83/turn.ts` 1353-1365 | Code |
| `stash`, `delivered` | `stashBudgetRefusedPrompt` `turn.ts` 1095-1190 (person prompts only, once each); 1428-1430 (a turn past the gates folds them in) | Code |
| `timer`: the hold's `workspace_retry` timer; a queued prompt releases it | `turn.ts` 1347-1361; `design.md` §4, "queued work" (a gate is asked again by the turn) | Code |
| `holder`, `Placements` | `releaseAffinity` `lifecycle.ts` 182-226 rotates the affinity key; duroxide routes a session's activities to the worker that holds it | Simplification (two workers) |
| `blobEnabled` TRUE; gate refusals without `retryAfterMs`; the test-only `workspaceRetryScheduleMs` absent; an error result is a turn past the gates (it is, without a workspace), its retry is `OwnedRetry`'s | | Simplification |
| `Inv_SameAs83` | the proposal's C4 and its hooks table ("Sessions without them run exactly as on `1.0.83`") | Rule |
| `Inv_RequestBeforeTurn` | the proposal, Capacity requests | Rule |
| `Inv_UncountedReleasesNothing` | the proposal, Capacity requests (no answer within 15 seconds) | Rule |
| `Inv_UncountedKeepsStep`, `Inv_UncountedWait` | the owner-routing review; `design.md` "Owner routing and capacity requests" (a minute's `retryAfterMs`, whatever the step) | Rule |
| `Inv_ReleaseRule` | the proposal, Capacity requests (the fast busy policy); `design.md` "Fast busy policy" | Rule |
| `Inv_HoldEndsAfterTurn` | the owner-routing review; `design.md` handleTurnResult | Rule |
| `Inv_DenyHoldsNothing`, `Inv_NothingLost`, `Prop_HeldDelivered` | `design.md` "Owner routing and capacity requests" | Rule |

## OwnerCapped

| Model | Code at 34e73cb1 | Label |
|---|---|---|
| `Claimable`: the owner's worker for a tagged session | `createSessionProxy` `session-proxy.ts` 863-1030 (877, 1003-1009, 1017); duroxide-node 0.2.4's tag filter | Code |
| `TakeCmd` end: the destroy, raced for a tagged session | `agents.ts` 498-512; `completeSession` 565, `cancelSession` 600, `failPendingShutdown` 653 | Code |
| `TakeCmd` set, `CapAnswer`: the request first, then the capped check | `lifecycle.ts` 1161-1172, 1184-1188 | Code |
| `CapAnswer` for a turn: ok schedules the turn; busy and deny leave the loop free | `turn.ts` 497-524 | Code |
| `Resolve`: the first completion wins; a queued loser is dropped, a running one goes on | `agents.ts` 506-509; `lifecycle.ts` 1185-1188; the drop: the proposal, What our local tests showed (duroxide-node 0.2.4) | Code (duroxide: observed) |
| `LateFinish`: a destroy or check that lost while running | `session-proxy.ts` 6291-6316 (the destroy checks no cancellation), 6321-6358 | Code |
| `stray`: what a check attached and the record does not name | `session-proxy.ts` 1567-1605 (`checkWorkspaceHere` settles its attaches); `session-manager.ts` 4013-4020 | Code |
| `Evict`: the owner's worker evicts an idle session and its held folders | the worker's eviction clock; duroxide's session idle timeout (`worker.ts` 1081) | Simplification |
| `turnRun` is never raced | `turn.ts` 655-668 | Code |
| untagged: plain yields, as 1.0.83 | `agents.ts` 499-504; `lifecycle.ts` 1189-1190; `orchestration_1_0_83/agents.ts` 543, 580, 635; `orchestration_1_0_83/lifecycle.ts` 1135 | Code |
| `Prop_AllAnswered`, `Prop_MemoryFreed`, `Prop_StrayReleased`, `Inv_RecordOnTimelyOk`, `Inv_RefusalKeepsWorkspace`, `Inv_DestroyOnce` | the proposal, Capacity requests ("Timers, not the queue", "Ending a session"); `design.md` §8 and "Owner routing and capacity requests" | Rule |

## OwnerTagCarry

| Model | Code at 34e73cb1 | Label |
|---|---|---|
| a session's start input: the stored routing | `client.ts` 330-347 (saved in the creation config), 956-981 (read back), 892-911 (`_routingForStart`: a child takes only the stored routing) | Simplification (the root's start rules may change; a child's path does not depend on them) |
| `deriveOptions`: no tag for a system input; the flag as given | `state.ts` 852-877 (874-875) | Code |
| `Can`: 1.0.84 carries both; 1.0.83 has neither | `lifecycle.ts` 606-720 (716-717); `orchestration_1_0_83/state.ts` 414-421, `lifecycle.ts` 580-691 | Code |
| `Create` C: spawn_agent in the turn, every child takes the turn's routing | `managed-session.ts` 2973-2980; `session-proxy.ts` 2939-2947, 3637-3875 (3853-3875); `turn.ts` 655-656 | Code |
| `Create` G, S: the orchestration's spawn, non-system only | `agents.ts` 982-1000; `session-proxy.ts` 1306-1316, 6791-6794 | Code |
| `Create` D: the regeneration distiller | `lifecycle.ts` 1396-1397; `session-proxy.ts` 7418-7428, 7525-7544 | Code |
| `Inv_TagKept`, `Inv_FastKept`, `Inv_TreeTagged`, `Inv_TreeFast`, `Inv_SystemUntagged`, `Inv_NothingFromNowhere`, `Inv_83Untagged` | `design.md` "Owner routing and capacity requests" ("Both fields ride every continue-as-new", "a system child gets neither") and its upgrade paragraph; the proposal, Capacity requests (children inherit the flag) | Rule |

## VersionHandoff, 1.0.83 into 1.0.84

| Model (`From = "83"`) | Code at 34e73cb1 | Label |
|---|---|---|
| `fifo`, `LateCancel`: the KV FIFO and its give-back markers | `queue.ts` byte-identical in both; `giveBackDroppedPromptWork` 506, called at 1619 and 1735 | Code |
| `pend` thrown: carried as `ownedRetry` with its key | `orchestration_1_0_83/lifecycle.ts` 724-739; `state.ts` 382-410, 738 | Code |
| `hold`: `workspaceStatus`, `workspaceRetry` | `orchestration_1_0_83/lifecycle.ts` 659, 670, 674 (as 1.0.84's `lifecycle.ts` 685, 696, 700); `state.ts` 795-804 | Code |
| `intake`, `report` | `orchestration_1_0_83/lifecycle.ts` 730; `lifecycle.ts` 759, 782; `state.ts` 735-736 | Code |
| `ReplaySrc`, `RegistryOK` | `orchestration-registry.ts` 84; duroxide replays with the recorded version | Code |
| no sweep gap | 1.0.83 sweeps before the pop (`CarriedGiveBack`) | Code |
| untagged after the move | `OwnerTagCarry` `ot.from-1083`; without either input 1.0.84 behaves as 1.0.83 (`CapacityHold` `ch.untagged`) | Code |

The `From = "82"` cases keep their binding (`CORRESPONDENCE-latest-1083.md`, 91def26a); only the module's names for
the two versions changed ("src", "dst").

`RollingDeploy` applies unchanged: its "82" is the version every worker has (now 1.0.83) and its "83" the version
only new workers register (now 1.0.84). 1.0.84 adds the capacity tag `pilotswarm.owner-capacity.v1` and owner tags,
which no worker of the previous image polls, so only orchestration items can reach an old worker, as before
(`design.md` 609-622 at `34e73cb1`: stop, deploy, start). Its two cases ran again in this batch.

## Not covered

- The coordination host's backstop (`session-proxy.ts` 2168-2194, a worker-side check) and the client's tagging rules
  (`client.ts`).
- The custom status and the client's response cursor (above).
- duroxide itself: the race's drop of a queued loser is the proposal's observation, not checked here.
- Workflows in owner-routed trees (refused, `owner-routing.ts` 66-81), and the proposal's later owner routing of
  Workflows.
- Error retries and lossy hand-offs of tagged sessions (`OwnedRetry`, `RehydrationNotice` cover them for every session).
