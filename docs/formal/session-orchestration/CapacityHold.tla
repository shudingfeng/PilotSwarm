------------------------------ MODULE CapacityHold ------------------------------
(***************************************************************************)
(* Orchestration 1.0.84 (orchestration/ at 34e73cb1, the owner-routing     *)
(* review's two commits on 76e4af8f): the capacity request before each     *)
(* turn of an owner-tagged session, and the holds on the workspace timer.  *)
(*  - An attempt (a queued prompt, or the hold's timer) of a session whose *)
(*    input carries ownerTag first yields requestOwnerCapacity (turn.ts    *)
(*    492-524): ok runs the turn; deny ends the attempt without a retry    *)
(*    and drops its prompt (projectNonRetryableTurnFailure 292-335); busy  *)
(*    holds the prompt on the workspace timer. No answer within 15 s, a    *)
(*    failed request, no requester or no row is busy with                  *)
(*    CAPACITY_UNAVAILABLE and retryAfterMs 60 s (owner-routing.ts 27-33,  *)
(*    128-130, 162-189), which is not counted as a failure (turn.ts 518-   *)
(*    520). A requester's own busy answer keeps its code (WORKSPACE_BUSY   *)
(*    by default) and its retryAfterMs (owner-routing.ts 136-155).         *)
(*  - A turn the worker refuses at a gate (the workspace check, an         *)
(*    admission hook, a credential resolver) returns a workspace-gate wait *)
(*    with its code and its worker (session-proxy.ts 1152-1216, 2521-      *)
(*    2529): a counted hold.                                               *)
(*  - holdForWorkspace (turn.ts 1276-1362) stashes the prompt and arms the *)
(*    workspace timer. A counted hold waits the schedule's step (30, 120,  *)
(*    300, then 900 s; under the fast policy, for WORKSPACE_BUSY only, 10, *)
(*    20, 60, then 180 s), at least retryAfterMs (state.ts 508, 514, 602-  *)
(*    615), advances the step, and releases affinity at its threshold (the *)
(*    second refusal in a row on one worker; the first under the fast      *)
(*    policy), or else when the wait is longer than the hold window        *)
(*    (wait-affinity.ts 45-50). An uncounted hold keeps the failure record *)
(*    and releases nothing. StepRule, for an uncounted hold: "flat"        *)
(*    (34e73cb1, turn.ts 1309-1319) keeps the step and waits retryAfterMs, *)
(*    60 s without one; "keep" (e94c62e4) keeps the step and waits the     *)
(*    step's delay, at least retryAfterMs; "advance" (76e4af8f) advances   *)
(*    the step and waits its delay.                                        *)
(*  - A turn past the gates ends a hold (turn.ts 1427-1451): with a        *)
(*    workspace, status ready and no retry state (as in 1.0.83); without   *)
(*    one, ResetRule "flagged" (e94c62e4 and 34e73cb1, 1447-1448) only     *)
(*    with an owner tag or the fast flag, "all" (76e4af8f) for every       *)
(*    session, "both" (a mutation of the flagged rule) only with both.     *)
(* The 1.0.83 machine (orchestration_1_0_83/turn.ts 1219-1285, 1353-1365)  *)
(* runs in lockstep on the same worker results: with neither input, 1.0.84 *)
(* must behave exactly as 1.0.83 (C4).                                     *)
(* Not modelled: the custom status. A capacity deny publishes it again     *)
(* after the response (turn.ts 315-317); no model tracks its               *)
(* responseVersion.                                                        *)
(* Model simplifications: blobEnabled is TRUE (every session the pool runs *)
(* has a session store); a gate refusal carries no retryAfterMs; an error  *)
(* result is a turn past the gates (it is, for a session without a         *)
(* workspace); error retries are OwnedRetry's.                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Tagged,        \* the input carries an owner tag (options.ownerTag)
    Fast,          \* the input carries workspaceBusyFastRelease
    HasWorkspace,  \* the session has a workspace (config.workspace)
    StepRule,      \* an uncounted hold: "flat" (34e73cb1), "keep" (e94c62e4) or "advance" (76e4af8f)
    ResetRule,     \* "flagged" (e94c62e4, 34e73cb1), "all" (76e4af8f) or "both" (a mutation)
    Answers,       \* capacity answers: a subset of {"ok", "deny", "busyWB", "busyOther", "busyCU", "unanswered"}
    Results,       \* a turn's results: a subset of {"pass", "gateWB", "gateOther"}
    BusyRetry,     \* a requester's busy answer's retryAfterMs, in seconds (0: none)
    HoldWindow,    \* options.idleTimeout, in seconds: the hold window of planHoldRelease
    MaxPrompts,    \* person prompts that arrive
    MaxRefusals,   \* refused attempts; after that every answer is ok and every turn passes
    Fault          \* "none", "skip-request-when-held", "count-unanswered", "no-timer"

ASSUME {Tagged, Fast, HasWorkspace} \subseteq BOOLEAN
ASSUME StepRule \in {"flat", "keep", "advance"} /\ ResetRule \in {"flagged", "all", "both"}
ASSUME Answers \subseteq {"ok", "deny", "busyWB", "busyOther", "busyCU", "unanswered"} /\ Answers # {}
ASSUME Results \subseteq {"pass", "gateWB", "gateOther"} /\ Results # {}
ASSUME BusyRetry \in Nat /\ HoldWindow \in Nat /\ MaxPrompts \in 1..3 /\ MaxRefusals \in 0..6
ASSUME Fault \in {"none", "skip-request-when-held", "count-unanswered", "no-timer"}

Workers == {"w1", "w2"}
(* Codes: "WB" is WORKSPACE_BUSY, "CU" CAPACITY_UNAVAILABLE, "OTHER" any   *)
(* other code.                                                             *)
NoRecord == [step |-> 0, fw |-> "", fc |-> 0, status |-> "none"]
NoLast == [kind |-> "none", ans |-> "none", code |-> "none", retry |-> 0, wait |-> 0, rel |-> "none",
           worker |-> "", before |-> NoRecord]
Max(a, b) == IF a >= b THEN a ELSE b
Min(a, b) == IF a <= b THEN a ELSE b
Schedule(fastBusy) == IF fastBusy THEN <<10, 20, 60, 180>> ELSE <<30, 120, 300, 900>>
(* workspaceRetryDelayMs: the step's delay (the last one repeats), at      *)
(* least the retry.                                                        *)
WaitOf(step, retry, fastBusy) == Max(Schedule(fastBusy)[Min(step, 3) + 1], retry)
(* An uncounted hold's wait in 34e73cb1: retryAfterMs, else                *)
(* CAPACITY_UNAVAILABLE_RETRY_MS (60 s).                                   *)
FlatWait(retry) == IF retry > 0 THEN retry ELSE 60

(* 1.0.84 holdForWorkspace on a hold record h: a refusal with code, worker *)
(* failedOn ("" for a capacity answer) and retry.                          *)
Hold84(h, code, failedOn, retry) ==
    LET counted == code # "CU" \/ Fault = "count-unanswered"
        fastBusy == Fast /\ code = "WB"
        fw == IF counted THEN failedOn ELSE h.fw
        fc == IF ~counted THEN h.fc ELSE IF failedOn # "" /\ h.fw = failedOn THEN h.fc + 1 ELSE 1
        wait == IF ~counted /\ StepRule = "flat" THEN FlatWait(retry) ELSE WaitOf(h.step, retry, fastBusy)
        step == IF ~counted /\ StepRule \in {"flat", "keep"} THEN h.step ELSE h.step + 1
        rel == IF counted /\ fc >= (IF fastBusy THEN 1 ELSE 2) THEN "unavailable"
               ELSE IF counted /\ wait > HoldWindow THEN "timer"
               ELSE "none"
    IN [rec |-> [step |-> step, fw |-> fw, fc |-> fc, status |-> "unavailable"], wait |-> wait, rel |-> rel]

(* 1.0.83 holdForWorkspace: every hold counts; two in a row on one worker. *)
Hold83(h, code, failedOn, retry) ==
    LET fc == IF failedOn # "" /\ h.fw = failedOn THEN h.fc + 1 ELSE 1
        wait == WaitOf(h.step, retry, FALSE)
        rel == IF fc >= 2 THEN "unavailable" ELSE IF wait > HoldWindow THEN "timer" ELSE "none"
    IN [rec |-> [step |-> h.step + 1, fw |-> failedOn, fc |-> fc, status |-> "unavailable"], wait |-> wait, rel |-> rel]

(* A turn past the gates: what it does to the hold record.                 *)
Resets84(h) ==
    /\ h.status = "unavailable"
    /\ \/ HasWorkspace
       \/ ResetRule = "all"
       \/ ResetRule = "flagged" /\ (Tagged \/ Fast)
       \/ ResetRule = "both" /\ Tagged /\ Fast
Pass84(h) == IF Resets84(h) THEN [NoRecord EXCEPT !.status = IF HasWorkspace THEN "ready" ELSE "none"] ELSE h
Pass83(h) == IF HasWorkspace /\ h.status = "unavailable" THEN [NoRecord EXCEPT !.status = "ready"] ELSE h

VARIABLES
    arrived,    \* person prompts arrived
    queue,      \* person prompts queued, not yet attempted
    stash,      \* person prompts held by holds (budgetStash)
    delivered,  \* person prompts a turn delivered to the model
    dropped,    \* person prompts a deny dropped
    timer,      \* "none" or "hold" (the workspace_retry timer)
    holder,     \* the worker that holds the session (its affinity), or "none"
    refusals,   \* refused attempts
    h84,        \* 1.0.84's hold record: workspaceRetry (step, failures) and workspaceStatus
    h83,        \* 1.0.83's, in lockstep on the same turn results
    last84,     \* what the last attempt did in 1.0.84 (ghost)
    last83,     \* and in 1.0.83 (ghost)
    gh
vars == <<arrived, queue, stash, delivered, dropped, timer, holder, refusals, h84, h83, last84, last83, gh>>

Init ==
    /\ arrived = 0 /\ queue = 0 /\ stash = 0 /\ delivered = 0 /\ dropped = 0
    /\ timer = "none" /\ holder = "none" /\ refusals = 0
    /\ h84 = NoRecord /\ h83 = NoRecord /\ last84 = NoLast /\ last83 = NoLast /\ gh = {}

Arrive ==
    /\ arrived < MaxPrompts
    /\ arrived' = arrived + 1 /\ queue' = queue + 1
    /\ UNCHANGED <<stash, delivered, dropped, timer, holder, refusals, h84, h83, last84, last83, gh>>

Forced == refusals >= MaxRefusals
(* Before each turn of a tagged session, also one that keeps its worker.   *)
Asks == Tagged /\ ~(Fault = "skip-request-when-held" /\ holder # "none")
AnswerChoices == IF ~Asks THEN {"none"} ELSE IF Forced THEN {"ok"} ELSE Answers
ResultChoices == IF Forced THEN {"pass"} ELSE Results
Placements == IF holder = "none" THEN Workers ELSE {holder}

(* The turn runs on worker w (the holder, else any): past the gates, or    *)
(* refused at a gate there.                                                *)
RunTurn(np, a, w, r) ==
    /\ gh' = gh \cup (IF Tagged /\ a = "none" THEN {"turnWithoutRequest"} ELSE {})
    /\ IF r = "pass"
       THEN /\ delivered' = delivered + stash + np /\ stash' = 0 /\ timer' = "none" /\ holder' = w
            /\ h84' = Pass84(h84) /\ h83' = Pass83(h83)
            /\ last84' = [NoLast EXCEPT !.kind = "pass", !.worker = w, !.before = h84]
            /\ last83' = [NoLast EXCEPT !.kind = "pass", !.worker = w, !.before = h83]
            /\ UNCHANGED <<dropped, refusals>>
       ELSE LET code == IF r = "gateWB" THEN "WB" ELSE "OTHER"
                o84 == Hold84(h84, code, w, 0)
                o83 == Hold83(h83, code, w, 0)
            IN /\ stash' = stash + np /\ timer' = "hold"
               /\ holder' = IF o84.rel = "none" THEN w ELSE "none"
               /\ h84' = o84.rec /\ h83' = o83.rec
               /\ refusals' = refusals + 1
               /\ last84' = [kind |-> "hold", ans |-> r, code |-> code, retry |-> 0, wait |-> o84.wait,
                             rel |-> o84.rel, worker |-> w, before |-> h84]
               /\ last83' = [kind |-> "hold", ans |-> r, code |-> code, retry |-> 0, wait |-> o83.wait,
                             rel |-> o83.rel, worker |-> w, before |-> h83]
               /\ UNCHANGED <<delivered, dropped>>

(* The capacity request answered deny or busy: no turn ran, so no turn     *)
(* index, nothing delivered (only a tagged session gets here).             *)
Refused(np, a) ==
    /\ refusals' = refusals + 1
    /\ UNCHANGED <<delivered, h83, last83, gh>>
    /\ IF a = "deny"
       THEN /\ dropped' = dropped + np /\ timer' = "none"
            /\ last84' = [NoLast EXCEPT !.kind = "deny", !.ans = "deny", !.before = h84]
            /\ UNCHANGED <<stash, holder, h84>>
       ELSE LET code == CASE a = "busyWB" -> "WB" [] a = "busyOther" -> "OTHER" [] OTHER -> "CU"
                retry == IF a = "unanswered" THEN 60 ELSE BusyRetry
                o84 == Hold84(h84, code, "", retry)
            IN /\ stash' = stash + np
               /\ timer' = IF Fault = "no-timer" /\ code = "CU" THEN "none" ELSE "hold"
               /\ holder' = IF o84.rel = "none" THEN holder ELSE "none"
               /\ h84' = o84.rec
               /\ last84' = [kind |-> "hold", ans |-> a, code |-> code, retry |-> retry, wait |-> o84.wait,
                             rel |-> o84.rel, worker |-> "", before |-> h84]
               /\ UNCHANGED dropped

(* An attempt: a queued person prompt, or the hold's timer fired (the      *)
(* drain releases a gate's timer for a queued prompt: the turn asks again).*)
Attempt(src) ==
    /\ IF src = "prompt" THEN queue > 0 ELSE timer = "hold"
    /\ queue' = queue - (IF src = "prompt" THEN 1 ELSE 0)
    /\ arrived' = arrived
    /\ LET np == IF src = "prompt" THEN 1 ELSE 0
       IN \E a \in AnswerChoices :
            IF a \in {"none", "ok"}
            THEN \E w \in Placements, r \in ResultChoices : RunTurn(np, a, w, r)
            ELSE Refused(np, a)

Done == arrived = MaxPrompts /\ queue = 0 /\ timer = "none" /\ UNCHANGED vars

Next == Arrive \/ Attempt("prompt") \/ Attempt("timer") \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(Attempt("prompt")) /\ WF_vars(Attempt("timer"))
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
Rec == [step: 0..(MaxRefusals + 1), fw: {"", "w1", "w2"}, fc: 0..(MaxRefusals + 1), status: {"none", "unavailable", "ready"}]
TypeOK == /\ arrived \in 0..MaxPrompts /\ queue \in 0..MaxPrompts /\ stash \in 0..MaxPrompts
          /\ delivered \in 0..MaxPrompts /\ dropped \in 0..MaxPrompts
          /\ timer \in {"none", "hold"} /\ holder \in Workers \cup {"none"} /\ refusals \in 0..MaxRefusals
          /\ h84 \in Rec /\ h83 \in Rec
(* C4: with neither input, 1.0.84 holds, waits and releases as 1.0.83.     *)
Inv_SameAs83 == (~Tagged /\ ~Fast) =>
    /\ h84 = h83
    /\ last84.kind = last83.kind /\ last84.wait = last83.wait /\ last84.rel = last83.rel
(* A turn of a tagged session runs only after an ok answer to its request. *)
Inv_RequestBeforeTurn == "turnWithoutRequest" \notin gh
(* CAPACITY_UNAVAILABLE is no failure: it keeps the failure record and     *)
(* releases no affinity (proposal "Capacity requests": a controller outage *)
(* releases no affinity).                                                  *)
Inv_UncountedReleasesNothing == (last84.kind = "hold" /\ last84.code = "CU")
    => (last84.rel = "none" /\ h84.fw = last84.before.fw /\ h84.fc = last84.before.fc)
(* An uncounted hold keeps the schedule's step (e94c62e4).                 *)
Inv_UncountedKeepsStep == (last84.kind = "hold" /\ last84.code = "CU") => h84.step = last84.before.step
(* An uncounted hold waits its retryAfterMs, 60 s without one, whatever    *)
(* the step: before or after busy answers, under either policy (34e73cb1). *)
Inv_UncountedWait == (last84.kind = "hold" /\ last84.code = "CU") => last84.wait = FlatWait(last84.retry)
(* The thresholds: a counted hold releases affinity as "workspace_         *)
(* unavailable" at the first WORKSPACE_BUSY refusal under the fast policy, *)
(* else at the second refusal in a row on one worker; below that, as       *)
(* "timer" when its wait is longer than the hold window.                   *)
Inv_ReleaseRule == (last84.kind = "hold" /\ last84.code # "CU") =>
    LET first == Fast /\ last84.code = "WB"
        again == last84.worker # "" /\ last84.before.fw = last84.worker
    IN /\ (last84.rel = "unavailable") = (first \/ again)
       /\ (last84.rel = "timer") = (~(first \/ again) /\ last84.wait > HoldWindow)
(* A turn past the gates ends the hold of a tagged or flagged session,     *)
(* with or without a workspace, and of any session with one (e94c62e4).    *)
Inv_HoldEndsAfterTurn == (last84.kind = "pass" /\ (Tagged \/ Fast \/ HasWorkspace))
    => (h84.status # "unavailable" /\ h84.step = 0 /\ h84.fc = 0)
(* A deny holds nothing: no hold, no timer.                                *)
Inv_DenyHoldsNothing == last84.kind = "deny" => (h84 = last84.before /\ timer = "none")
(* Every person prompt is queued, held, delivered or dropped by a deny.    *)
Inv_NothingLost == arrived = queue + stash + delivered + dropped

Prop_HeldDelivered == (stash > 0) ~> (stash = 0)

W_FastRelease == ~(last84.kind = "hold" /\ Fast /\ last84.rel = "unavailable")
W_DenyLeavesHeld == ~(last84.kind = "deny" /\ stash > 0)
(* No floor: a requester's own busy answer with CAPACITY_UNAVAILABLE and a *)
(* short retryAfterMs is waited as given, below the schedule's first step. *)
W_UncountedBelowSchedule == ~(last84.kind = "hold" /\ last84.code = "CU" /\ last84.wait < 30)
=============================================================================
