------------------------------ MODULE OwnerCapped ------------------------------
(***************************************************************************)
(* Orchestration 1.0.84 (orchestration/ at 34e73cb1): the waits of an      *)
(* owner-tagged session that are capped with timers, so that a missing     *)
(* owner worker never holds the session's lifecycle commands for good.     *)
(*  - Every session-scoped activity of a tagged session carries the owner  *)
(*    tag (createSessionProxy, session-proxy.ts 863-1030): only a worker   *)
(*    started with that tag runs it; duroxide keeps it queued until one    *)
(*    polls. An untagged session's activities run on the default workers.  *)
(*  - complete, cancel, delete and a failed graceful shutdown end with     *)
(*    destroySession (agents.ts 492-512; called at 565, 600, 653): for a   *)
(*    tagged session it is raced against WORKSPACE_RELEASE_CAP_MS (10 s),  *)
(*    and the session ends either way. An untagged one yields it.          *)
(*  - A set-workspace command of a tagged session (lifecycle.ts 1154-      *)
(*    1192) first yields requestOwnerCapacity: deny or busy answer the     *)
(*    command and keep the workspace; then checkWorkspace is raced against *)
(*    WORKSPACE_CHECK_CAP_MS (20 min): the cap answers WORKSPACE_BUSY and  *)
(*    keeps the workspace. An untagged session yields the check.           *)
(*  - A turn's activity is never raced (turn.ts 655-668): the commands     *)
(*    wait for it. The capacity request before the turn (turn.ts 497-524)  *)
(*    is an activity only a worker with a capacity requester runs; it is   *)
(*    not raced either.                                                    *)
(*  - duroxide's race: the first completion wins; a loser still queued is  *)
(*    dropped and never starts, also when a worker polls later; a loser    *)
(*    already running finishes on its worker, and its result is ignored    *)
(*    (the proposal's local duroxide-node 0.2.4 tests).                    *)
(*  - A check attaches on the worker that runs it. What the record does    *)
(*    not adopt is held while the session is on that worker and released   *)
(*    with its folders (a destroy, the idle eviction), else at once        *)
(*    (settleCheckAttaches, session-manager.ts 4004-4020; session-proxy.ts *)
(*    1567-1605, 6291-6316).                                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Tagged,     \* the session's input carries an owner tag
    Capped,     \* the tagged destroy and check are raced against their caps (1.0.84); FALSE: 1.0.83's plain yields
    Owner,      \* the owner's worker: "up" (it holds the session), "late" (it starts later), "never"
    MayStop,    \* the owner's worker may stop once (its VM is deleted)
    Host,       \* a worker with a capacity requester: "up", "late", "never"
    Cmds,       \* the commands, in order: "end" or "set-end" (end: done, cancel, delete or a failed shutdown)
    TurnFirst,  \* a prompt's turn attempt comes before the commands
    Fault       \* "none", "adopt-late"

ASSUME {Tagged, Capped, MayStop, TurnFirst} \subseteq BOOLEAN
ASSUME Owner \in {"up", "late", "never"} /\ Host \in {"up", "late", "never"} /\ Fault \in {"none", "adopt-late"}
ASSUME Cmds \in {"end", "set-end"}

CmdSeq == IF Cmds = "end" THEN <<"end">> ELSE <<"set", "end">>
NoAct == [kind |-> "none", st |-> "none", ok |-> FALSE]

VARIABLES
    cmds,          \* the commands not yet taken
    orch,          \* "turnAsk", "turnRun", "idle", "setAsk", "setCheck", "endDestroy", "ended"
    capq,          \* the capacity request: "none", "queued"
    act,           \* the activity the orchestration waits for: [kind, st ("none", "queued", "running", "done"), ok]
    timer,         \* the cap's timer: "none", "armed", "fired"
    first,         \* the first of the race to complete: "none", "act", "timer"
    lateRun,       \* kinds of the activities that lost their race while running
    ownerUp, ownerStarted, ownerStopped, hostUp,
    warm,          \* the session is in memory on the owner's worker
    stray,         \* a folder a check attached, which the record does not name, is held on the owner's worker
    ws,            \* the record's workspace: "old", "new"
    okTimely,      \* the record took "new" from a check that won its race with ok (ghost)
    setAnswer,     \* how the set-workspace command was answered: "none", "changed", "refused" (ghost)
    answered,      \* commands answered
    destroys,      \* destroySession runs that finished
    gh
vars == <<cmds, orch, capq, act, timer, first, lateRun, ownerUp, ownerStarted, ownerStopped, hostUp,
          warm, stray, ws, okTimely, setAnswer, answered, destroys, gh>>
env == <<ownerUp, ownerStarted, ownerStopped, hostUp>>

Init ==
    /\ cmds = CmdSeq
    /\ orch = IF TurnFirst THEN (IF Tagged THEN "turnAsk" ELSE "turnRun") ELSE "idle"
    /\ capq = IF TurnFirst /\ Tagged THEN "queued" ELSE "none"
    /\ act = IF TurnFirst /\ ~Tagged THEN [kind |-> "turn", st |-> "queued", ok |-> FALSE] ELSE NoAct
    /\ timer = "none" /\ first = "none" /\ lateRun = {}
    /\ ownerUp = (Owner = "up") /\ ownerStarted = (Owner = "up") /\ ownerStopped = FALSE /\ hostUp = (Host = "up")
    /\ warm = (Tagged /\ Owner = "up") /\ stray = FALSE /\ ws = "old" /\ okTimely = FALSE /\ setAnswer = "none"
    /\ answered = 0 /\ destroys = 0 /\ gh = {}

Raced == Tagged /\ Capped
(* A worker that may claim the activity: the owner's for a tagged session, *)
(* a default worker (always up here) for an untagged one.                  *)
Claimable == IF Tagged THEN ownerUp ELSE TRUE

(* --- the environment --------------------------------------------------- *)
OwnerStart ==
    /\ Owner = "late" /\ ~ownerStarted
    /\ ownerUp' = TRUE /\ ownerStarted' = TRUE
    /\ UNCHANGED <<cmds, orch, capq, act, timer, first, lateRun, ownerStopped, hostUp, warm, stray, ws, okTimely, setAnswer, answered, destroys, gh>>
(* The owner's VM is deleted: its memory and held folders go; an activity  *)
(* it was running goes back to the queue (its lock lapses); late ones end. *)
OwnerStop ==
    /\ Tagged /\ MayStop /\ ownerUp /\ ~ownerStopped
    /\ ownerUp' = FALSE /\ ownerStopped' = TRUE /\ warm' = FALSE /\ stray' = FALSE /\ lateRun' = {}
    /\ act' = IF act.st = "running" THEN [act EXCEPT !.st = "queued"] ELSE act
    /\ UNCHANGED <<cmds, orch, capq, timer, first, ownerStarted, hostUp, ws, okTimely, setAnswer, answered, destroys, gh>>
HostStart ==
    /\ Host = "late" /\ ~hostUp
    /\ hostUp' = TRUE
    /\ UNCHANGED <<cmds, orch, capq, act, timer, first, lateRun, ownerUp, ownerStarted, ownerStopped, warm, stray, ws, okTimely, setAnswer, answered, destroys, gh>>

(* --- the orchestration ------------------------------------------------- *)
TakeCmd ==
    /\ orch = "idle" /\ cmds # <<>>
    /\ cmds' = Tail(cmds)
    /\ IF Head(cmds) = "set"
       THEN IF Tagged
            THEN /\ orch' = "setAsk" /\ capq' = "queued"
                 /\ UNCHANGED <<act, timer, first>>
            ELSE /\ orch' = "setCheck" /\ act' = [kind |-> "check", st |-> "queued", ok |-> FALSE]
                 /\ timer' = "none" /\ first' = "none"
                 /\ UNCHANGED capq
       ELSE /\ orch' = "endDestroy" /\ act' = [kind |-> "destroy", st |-> "queued", ok |-> FALSE]
            /\ timer' = (IF Raced THEN "armed" ELSE "none") /\ first' = "none"
            /\ UNCHANGED capq
    /\ UNCHANGED <<lateRun, warm, stray, ws, okTimely, setAnswer, answered, destroys, gh>> /\ UNCHANGED env

(* requestOwnerCapacity runs on a worker with a requester; it answers.     *)
CapAnswer ==
    /\ capq = "queued" /\ hostUp
    /\ capq' = "none"
    /\ \E ans \in {"ok", "busy", "deny"} :
         IF orch = "turnAsk"
         THEN \* ok: the turn is scheduled; busy holds the prompt on its timer and deny ends the attempt:
              \* either way the run loop goes on and takes commands
              /\ orch' = IF ans = "ok" THEN "turnRun" ELSE "idle"
              /\ act' = IF ans = "ok" THEN [kind |-> "turn", st |-> "queued", ok |-> FALSE] ELSE act
              /\ UNCHANGED <<timer, first, ws, setAnswer, answered>>
         ELSE IF ans = "ok"
         THEN /\ orch' = "setCheck" /\ act' = [kind |-> "check", st |-> "queued", ok |-> FALSE]
              /\ timer' = (IF Raced THEN "armed" ELSE "none") /\ first' = "none"
              /\ UNCHANGED <<ws, setAnswer, answered>>
         ELSE \* the refusal answers the command; the workspace is kept
              /\ orch' = "idle" /\ setAnswer' = "refused" /\ answered' = answered + 1
              /\ UNCHANGED <<act, timer, first, ws>>
    /\ UNCHANGED <<cmds, lateRun, warm, stray, okTimely, destroys, gh>> /\ UNCHANGED env

(* --- the activities ---------------------------------------------------- *)
Claim ==
    /\ act.st = "queued" /\ Claimable
    /\ act' = [act EXCEPT !.st = "running"]
    /\ warm' = (warm \/ (Tagged /\ act.kind = "turn"))
    /\ UNCHANGED <<cmds, orch, capq, timer, first, lateRun, stray, ws, okTimely, setAnswer, answered, destroys, gh>> /\ UNCHANGED env

Finish ==
    /\ act.st = "running"
    /\ \E ok \in BOOLEAN :
         /\ act' = [act EXCEPT !.st = "done", !.ok = (act.kind = "check" /\ ok)]
         /\ first' = IF first = "none" THEN "act" ELSE first
         /\ IF act.kind = "destroy"
            THEN /\ warm' = FALSE /\ stray' = FALSE /\ destroys' = destroys + 1
            ELSE \* a refused check's attach is held if the session is on that worker
                 /\ stray' = (stray \/ (act.kind = "check" /\ ~ok /\ warm))
                 /\ UNCHANGED <<warm, destroys>>
    /\ UNCHANGED <<cmds, orch, capq, timer, lateRun, ws, okTimely, setAnswer, answered, gh>> /\ UNCHANGED env

TimerFire ==
    /\ timer = "armed"
    /\ timer' = "fired" /\ first' = IF first = "none" THEN "timer" ELSE first
    /\ UNCHANGED <<cmds, orch, capq, act, lateRun, warm, stray, ws, okTimely, setAnswer, answered, destroys, gh>> /\ UNCHANGED env

(* The orchestration takes the result: the activity's when it won (or was  *)
(* not raced), the cap's when the timer won. A queued loser is dropped; a  *)
(* running one goes on on its worker. A check that ended ok after its cap  *)
(* attached a folder the record does not take.                             *)
Resolve ==
    /\ orch \in {"turnRun", "setCheck", "endDestroy"}
    /\ LET actWon == act.st = "done" /\ (timer = "none" \/ first = "act")
           capWon == timer = "fired" /\ first = "timer"
           lostDoneCheck == capWon /\ act.st = "done" /\ act.kind = "check"
       IN /\ actWon \/ capWon
          /\ act' = NoAct /\ timer' = "none" /\ first' = "none"
          /\ lateRun' = IF capWon /\ act.st = "running" THEN lateRun \cup {act.kind} ELSE lateRun
          /\ stray' = (stray \/ (lostDoneCheck /\ act.ok /\ warm))
          /\ gh' = gh \cup (IF lostDoneCheck THEN {"lateCheck"} ELSE {})
          /\ IF orch = "turnRun"
             THEN /\ orch' = "idle" /\ UNCHANGED <<ws, okTimely, setAnswer, answered>>
             ELSE IF orch = "setCheck"
             THEN /\ orch' = "idle" /\ answered' = answered + 1
                  /\ ws' = IF actWon /\ act.ok THEN "new" ELSE ws
                  /\ okTimely' = (okTimely \/ (actWon /\ act.ok))
                  /\ setAnswer' = IF actWon /\ act.ok THEN "changed" ELSE "refused"
             ELSE /\ orch' = "ended" /\ answered' = answered + 1
                  /\ UNCHANGED <<ws, okTimely, setAnswer>>
    /\ UNCHANGED <<cmds, capq, warm, destroys>> /\ UNCHANGED env

(* A loser that was running finishes on the owner's worker, after the      *)
(* orchestration moved on: its result is ignored.                          *)
LateFinish ==
    /\ ownerUp /\ lateRun # {}
    /\ \E k \in lateRun :
         /\ lateRun' = lateRun \ {k}
         /\ IF k = "destroy"
            THEN /\ warm' = FALSE /\ stray' = FALSE /\ destroys' = destroys + 1
                 /\ gh' = gh \cup {"destroyAfterEnd"}
                 /\ UNCHANGED ws
            ELSE \E ok \in BOOLEAN :
                 /\ stray' = (stray \/ warm)
                 /\ ws' = IF Fault = "adopt-late" /\ ok THEN "new" ELSE ws
                 /\ gh' = gh \cup {"lateCheck"}
                 /\ UNCHANGED <<warm, destroys>>
    /\ UNCHANGED <<cmds, orch, capq, act, timer, first, okTimely, setAnswer, answered>> /\ UNCHANGED env

(* The owner's worker evicts an idle session (the backstop), with its held *)
(* folders.                                                                *)
Evict ==
    /\ warm /\ ownerUp /\ orch \in {"idle", "ended"} /\ act.st # "running" /\ lateRun = {}
    /\ warm' = FALSE /\ stray' = FALSE
    /\ UNCHANGED <<cmds, orch, capq, act, timer, first, lateRun, ws, okTimely, setAnswer, answered, destroys, gh>> /\ UNCHANGED env

Done == (orch = "ended" \/ (orch = "idle" /\ cmds = <<>>)) /\ UNCHANGED vars

Next == OwnerStart \/ OwnerStop \/ HostStart \/ TakeCmd \/ CapAnswer \/ Claim \/ Finish \/ TimerFire
        \/ Resolve \/ LateFinish \/ Evict \/ Done
Spec == Init /\ [][Next]_vars
Fairness == /\ WF_vars(OwnerStart) /\ WF_vars(HostStart) /\ WF_vars(TakeCmd) /\ WF_vars(CapAnswer)
            /\ WF_vars(Claim) /\ WF_vars(Finish) /\ WF_vars(TimerFire) /\ WF_vars(Resolve)
            /\ WF_vars(LateFinish) /\ WF_vars(Evict)
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ cmds \in Seq({"set", "end"}) /\ orch \in {"turnAsk", "turnRun", "idle", "setAsk", "setCheck", "endDestroy", "ended"}
          /\ capq \in {"none", "queued"} /\ act.kind \in {"none", "turn", "check", "destroy"}
          /\ act.st \in {"none", "queued", "running", "done"} /\ timer \in {"none", "armed", "fired"}
          /\ first \in {"none", "act", "timer"} /\ lateRun \subseteq {"check", "destroy"}
          /\ {ownerUp, ownerStarted, ownerStopped, hostUp, warm, stray, okTimely} \subseteq BOOLEAN
          /\ ws \in {"old", "new"} /\ answered \in 0..Len(CmdSeq) /\ destroys \in 0..2
(* The session is destroyed at most once.                                  *)
Inv_DestroyOnce == destroys <= 1
(* The record changes only on a check that answered ok before its cap.     *)
Inv_RecordOnTimelyOk == ws = "new" => okTimely
(* A refused set-workspace command (deny, busy, a failed check, the cap)   *)
(* keeps the workspace.                                                    *)
Inv_RefusalKeepsWorkspace == setAnswer = "refused" => ws = "old"
(* Every command is answered (and an end ends the session).                *)
Prop_AllAnswered == <>(answered = Len(CmdSeq))
(* After the end, the session's memory on the owner's worker is freed: by  *)
(* the destroy, or by the idle eviction when the destroy lost its race.    *)
Prop_MemoryFreed == (orch = "ended") ~> ~warm
(* A folder a check attached and the record does not name is released.     *)
Prop_StrayReleased == stray ~> ~stray

W_NoLateCheck == "lateCheck" \notin gh
W_NoDestroyAfterEnd == "destroyAfterEnd" \notin gh
=============================================================================
