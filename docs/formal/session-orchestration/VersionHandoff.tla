----------------------------- MODULE VersionHandoff -----------------------------
(***************************************************************************)
(* A live session of the previous latest version continues as new into     *)
(* the new latest version. From = "82": 1.0.82 into 1.0.83 (the latest-    *)
(* 1.0.83 line, bound to 91def26a). From = "83": 1.0.83, frozen in         *)
(* orchestration_1_0_83/, into 1.0.84 (bound to 34e73cb1). "src" is the    *)
(* older version, "dst" the newer. What a source execution holds, and      *)
(* where it goes:                                                          *)
(*  - fifo:     a prompt queued in the KV FIFO (keys fifo.N; same keys and *)
(*              item shape in every version from 1.0.82; KV is per         *)
(*              instance, kept across continue-as-new; queue.ts is byte-   *)
(*              identical in 1.0.83 and 1.0.84). A 1.0.82 item has no      *)
(*              give-back markers; a 1.0.83 item has them. It may have     *)
(*              taken the child digest into its text.                      *)
(*  - pend:     the continue-as-new input's prompt: plain, a returned      *)
(*              error's retry, a thrown turn's retry (with the thrown key; *)
(*              its model call already ran and its turn may be saved), or  *)
(*              a lossy hand-off (count 0, with the rehydration notice).   *)
(*              1.0.83 converts a 1.0.82 thrown retry to ownedRetry, with  *)
(*              the key, iff the input's sourceOrchestrationVersion is     *)
(*              below 1.0.83 or absent (state.ts 375-404). 1.0.83 carries  *)
(*              its own owed retry as ownedRetry, which 1.0.84 restores    *)
(*              (state.ts 382-410).                                        *)
(*  - unread:   queue messages not yet dequeued (prompts, a set_model      *)
(*              command); duroxide carries at most Cap of them             *)
(*              (MAX_CARRY_FORWARD_EVENTS = 100) to the next execution.    *)
(*  - digest, notice, cron: input fields (pendingChildDigest,              *)
(*              rehydrationMessage, cronSchedule + activeTimerState), read *)
(*              unchanged by the newer version.                            *)
(*  - Extra (From = "83" only): 1.0.83's other carried state, read         *)
(*              unchanged by 1.0.84: "hold" (a workspace hold:             *)
(*              workspaceStatus, workspaceRetry, the stash and its timer), *)
(*              "intake" (the intake state, its retry marker and arrival   *)
(*              flag), "report" (an owed Workflow turn-failure report).    *)
(* A deploy registers the newer version as latest. An execution in flight  *)
(* replays with its recorded version (duroxide resolve_handler_exact), so  *)
(* the older version must stay registered with its frozen code.            *)
(* 1.0.83's continue-as-new input carries no ownerTag and no               *)
(* workspaceBusyFastRelease, so the moved session is untagged in 1.0.84    *)
(* (OwnerTagCarry); without either input 1.0.84 holds and releases as      *)
(* 1.0.83 (CapacityHold, C4).                                              *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    From,              \* "82" (1.0.82 into 1.0.83) or "83" (1.0.83 into 1.0.84)
    PendKind,          \* "none", "plain", "retErr", "thrown", "lossy"
    SourceStamp,       \* what the 1.0.82 handler writes as sourceOrchestrationVersion: "82", "absent" (1.0.47-1.0.81), "83" (fault: the 1.0.82 handler claims 1.0.83); "83" for From = "83"
    RegistryOK,        \* the older version stays registered with its frozen code (FALSE: fault: the registry entry follows the latest version)
    NU,                \* unread prompts at the continue-as-new
    SetModel,          \* a set_model command is unread at the continue-as-new
    Cap,               \* unread messages duroxide carries
    FifoTookDigest,    \* the queued prompt took the child digest into its text
    AllowLateCancel,   \* the queued prompt may be cancelled at its dispatch on the newer version
    AllowSweepSetModel,\* 1.0.82's sweep set_model gap may cause the continue-as-new (known 1.0.82 issue)
    Extra,             \* From = "83": 1.0.83's other carried state, a subset of {"hold", "intake", "report"}
    FieldFault         \* "none", "fifo", "digest", "notice", "cron", "pend", "hold", "intake", "report"

ASSUME From \in {"82", "83"}
ASSUME PendKind \in {"none", "plain", "retErr", "thrown", "lossy"} /\ SourceStamp \in {"82", "absent", "83"}
ASSUME RegistryOK \in BOOLEAN /\ NU \in 0..2 /\ SetModel \in BOOLEAN /\ Cap \in 1..3
ASSUME FifoTookDigest \in BOOLEAN /\ AllowLateCancel \in BOOLEAN /\ AllowSweepSetModel \in BOOLEAN
ASSUME Extra \subseteq {"hold", "intake", "report"} /\ (From = "82" => Extra = {})
ASSUME From = "83" => (SourceStamp = "83" /\ ~AllowSweepSetModel)
ASSUME FieldFault \in {"none", "fifo", "digest", "notice", "cron", "pend", "hold", "intake", "report"}

(* Unread messages in queue order: prompts u1, u2, then the set_model "m". *)
UnreadItems == (IF NU >= 1 THEN {"u1"} ELSE {}) \cup (IF NU >= 2 THEN {"u2"} ELSE {}) \cup (IF SetModel THEN {"m"} ELSE {})
Pos(x) == CASE x = "u1" -> 1 [] x = "u2" -> 2 [] OTHER -> NU + 1
Items == {"fifo", "digest", "cron"} \cup (IF PendKind = "none" THEN {} ELSE {"pend"})
         \cup (IF PendKind = "lossy" THEN {"notice"} ELSE {}) \cup UnreadItems \cup Extra
Fields == {"fifo", "pend", "digest", "notice", "cron", "hold", "intake", "report"}

VARIABLES
    deployed,   \* the newer version is registered as latest
    exec,       \* the running execution's version: "src", "dst"
    replayed,   \* the in-flight source execution has replayed after the deploy
    failed,     \* the session's execution failed (an unregistered version: poison)
    where,      \* item -> "src", "dst", "infifo" (in the queued prompt's text), "done", "cancelled", "lost"
    keyKept,    \* the thrown retry kept its key in the newer version
    calls,      \* model calls for the pending prompt's turn
    gh
vars == <<deployed, exec, replayed, failed, where, keyKept, calls, gh>>

Init ==
    /\ deployed = FALSE /\ exec = "src" /\ replayed = FALSE /\ failed = FALSE
    /\ where = [x \in Items |-> IF x = "digest" /\ FifoTookDigest THEN "infifo" ELSE "src"]
    /\ keyKept = FALSE
    /\ calls = IF PendKind = "thrown" THEN 1 ELSE 0
    /\ gh = {}

Deploy == ~deployed /\ deployed' = TRUE /\ UNCHANGED <<exec, replayed, failed, where, keyKept, calls, gh>>

(* The in-flight source execution's next turn replays it on a new worker.  *)
ReplaySrc ==
    /\ deployed /\ exec = "src" /\ ~replayed /\ ~failed
    /\ replayed' = TRUE /\ failed' = ~RegistryOK
    /\ UNCHANGED <<deployed, exec, where, keyKept, calls, gh>>

Live == ~failed

(* The source version runs its queued prompt before the continue-as-new.   *)
RunSrcFifo ==
    /\ Live /\ exec = "src" /\ where["fifo"] = "src" /\ (deployed => replayed)
    /\ where' = [x \in Items |-> IF x = "fifo" \/ (x = "digest" /\ where[x] = "infifo") THEN "done" ELSE where[x]]
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls, gh>>

Moved(x, w) ==
    IF w \notin {"src", "infifo"} THEN w
    ELSE IF x = FieldFault THEN "lost"
    ELSE IF x = "digest" /\ w = "infifo" THEN (IF FieldFault = "fifo" THEN "lost" ELSE "infifo")
    ELSE IF x \in Fields THEN "dst"
    ELSE IF Pos(x) <= Cap THEN "dst" ELSE "lost"

(* The continue-as-new into the latest version after the deploy.           *)
(* sweepGap: 1.0.82's decide popped the queued prompt, then its sweep      *)
(* handled set_model, which continued as new without it (1.0.83 sweeps     *)
(* before the pop).                                                        *)
CanSrc ==
    /\ Live /\ exec = "src" /\ deployed /\ replayed
    /\ \E sweepGap \in (IF From = "82" /\ AllowSweepSetModel /\ SetModel /\ where["fifo"] = "src" THEN BOOLEAN ELSE {FALSE}) :
         /\ where' = [x \in Items |->
               IF sweepGap /\ (x = "fifo" \/ (x = "digest" /\ where[x] = "infifo")) THEN "lost"
               ELSE IF sweepGap /\ x = "m" THEN "done"
               ELSE Moved(x, where[x])]
         /\ gh' = gh \cup (IF sweepGap THEN {"sweepGap"} ELSE {})
    /\ exec' = "dst"
    \* 1.0.82 into 1.0.83: converted by the source stamp; 1.0.83 into 1.0.84: carried as ownedRetry
    /\ keyKept' = (PendKind = "thrown" /\ (IF From = "82" THEN SourceStamp # "83" ELSE TRUE))
    /\ UNCHANGED <<deployed, replayed, failed, calls>>

(* The newer version runs the owned retry first (priority 2a), adopting    *)
(* the thrown attempt's saved turn when it kept the key; otherwise the     *)
(* pending prompt runs as a new turn. The model takes the case where the   *)
(* thrown attempt saved its turn (otherwise a second call is legitimate).  *)
RunPend ==
    /\ Live /\ exec = "dst" /\ "pend" \in Items /\ where["pend"] = "dst"
    /\ where' = [where EXCEPT !["pend"] = "done"]
    /\ calls' = IF PendKind = "thrown" /\ keyKept THEN calls ELSE calls + 1
    /\ gh' = gh \cup (IF keyKept THEN {"adopted"} ELSE {})
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept>>

(* Any other held item is taken by a turn of the newer version: the queued *)
(* prompt (with the digest in its text), an unread prompt, the set_model   *)
(* command, the digest and notice (with the next turn), the cron schedule  *)
(* (it fires), a hold (its timer fires and a turn runs), the intake's due  *)
(* work, an owed report.                                                   *)
RunOther ==
    /\ Live /\ exec = "dst"
    /\ \E x \in Items \ {"pend"} :
         /\ where[x] = "dst"
         /\ where' = [y \in Items |->
               IF y = x \/ (x = "fifo" /\ y = "digest" /\ where[y] = "infifo") THEN "done" ELSE where[y]]
         /\ gh' = gh \cup (IF x = "m" THEN {"setModel"} ELSE {})
                     \cup (IF x = "cron" THEN {"cronFired"} ELSE {})
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls>>

(* decide drops the source-queued prompt for a cancel. A 1.0.82 item has   *)
(* no markers, so nothing is given back (as on 1.0.82); a 1.0.83 item's    *)
(* markers give the digest back (giveBackDroppedPromptWork).               *)
LateCancel ==
    /\ Live /\ exec = "dst" /\ AllowLateCancel /\ where["fifo"] = "dst"
    /\ where' = [y \in Items |->
          IF y = "fifo" THEN "cancelled"
          ELSE IF y = "digest" /\ where[y] = "infifo" THEN (IF From = "83" THEN "dst" ELSE "lost")
          ELSE where[y]]
    /\ UNCHANGED <<deployed, exec, replayed, failed, keyKept, calls, gh>>

Settled == \A x \in Items : where[x] \in {"done", "cancelled", "lost"}
Done == (failed \/ (exec = "dst" /\ Settled)) /\ UNCHANGED vars

Next == Deploy \/ ReplaySrc \/ RunSrcFifo \/ CanSrc \/ RunPend \/ RunOther \/ LateCancel \/ Done
Spec == Init /\ [][Next]_vars
Fairness == WF_vars(Deploy) /\ WF_vars(ReplaySrc) /\ WF_vars(CanSrc) /\ WF_vars(RunPend) /\ WF_vars(RunOther)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ {deployed, replayed, failed, keyKept} \subseteq BOOLEAN /\ exec \in {"src", "dst"}
          /\ where \in [Items -> {"src", "dst", "infifo", "done", "cancelled", "lost"}] /\ calls \in 0..2
(* Nothing the source execution held is lost.                              *)
Inv_NothingLost == \A x \in Items : where[x] # "lost"
(* The pending turn calls the model at most once (a thrown attempt's call  *)
(* counts; its saved turn is adopted).                                     *)
Inv_ModelOnce == calls <= 1
(* An in-flight source execution replays after the deploy.                 *)
Inv_NoFailure == ~failed
Prop_AllProcessed == <>(failed \/ (exec = "dst" /\ \A x \in Items : where[x] \in {"done", "cancelled"}))

W_NoAdoption == "adopted" \notin gh
W_NoSetModel == "setModel" \notin gh
W_NoCronFired == "cronFired" \notin gh
=============================================================================
