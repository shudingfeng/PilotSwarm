----------------------------- MODULE OwnerTagCarry -----------------------------
(***************************************************************************)
(* Orchestration 1.0.84 (orchestration/ at 34e73cb1): the owner tag and    *)
(* the fast busy flag through continue-as-new and to the sessions a        *)
(* session creates.                                                        *)
(*  - deriveOptions (state.ts 852-877) takes ownerTag only from a non-     *)
(*    system input with a valid owner.<subject> tag, and the fast flag     *)
(*    when it is true. buildContinueInput (lifecycle.ts 714-717) carries   *)
(*    both, when set, into every continue-as-new. 1.0.83 has neither       *)
(*    option and carries neither (orchestration_1_0_83/state.ts 413-421,   *)
(*    lifecycle.ts 683-692): a session started on 1.0.83 stays untagged    *)
(*    after its move to 1.0.84 (design.md, "For 1.0.84, deploy the workers *)
(*    before turning on owner routing").                                   *)
(*  - Sub-agents: spawn_agent runs inside the turn (managed-session.ts     *)
(*    2973-2980; session-proxy.ts 3637-3875) with the turn's               *)
(*    createdSessionRouting (turn.ts 655-656; session-proxy.ts 2939-2947): *)
(*    every child it creates takes the tag and the flag (it creates no     *)
(*    is_system child). The orchestration's own spawn (agents.ts 982-1000; *)
(*    spawnChildSession, session-proxy.ts 1306-1316, 6788-6795) gives      *)
(*    them to a non-system child only. The regeneration distiller takes    *)
(*    them (lifecycle.ts 1396-1397; session-proxy.ts 7418-7428, 7525-      *)
(*    7544). A child's start input takes its stored routing (client.ts     *)
(*    346, 960-981, 892-911), modelled here as one step.                   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    RootTag,    \* the root's first input carries the owner tag
    RootFast,   \* the root's first input carries the fast flag
    RootOn83,   \* the root started on 1.0.83 (before the upgrade) and moves to 1.0.84 at its next continue-as-new
    MaxCan,     \* continue-as-new per session
    Fault       \* "none", "drop-at-can", "child-untagged", "system-child-tagged"

ASSUME {RootTag, RootFast, RootOn83} \subseteq BOOLEAN /\ MaxCan \in 0..2
ASSUME Fault \in {"none", "drop-at-can", "child-untagged", "system-child-tagged"}

(* R: the root. C: R's sub-agent (spawn_agent in R's turn). G: C's sub-    *)
(* agent at nesting level 2 (the orchestration's spawn). S: R's system     *)
(* sub-agent (the orchestration's spawn, agentIsSystem). D: C's            *)
(* regeneration distiller.                                                 *)
Sessions == {"R", "C", "G", "S", "D"}
Parent(s) == CASE s = "C" -> "R" [] s = "S" -> "R" [] s = "G" -> "C" [] s = "D" -> "C" [] OTHER -> "none"
IsSystem(s) == s = "S"
StartVer(s) == IF s = "R" /\ RootOn83 THEN "83" ELSE "84"

VARIABLES
    started,    \* session -> its orchestration has started
    ver,        \* session -> the version of its running execution: "83", "84"
    tag,        \* session -> options.ownerTag (the root owner's tag)
    fast,       \* session -> options.workspaceBusyFastRelease
    cans,       \* session -> continue-as-new taken
    startTag,   \* session -> its first input carried the tag (ghost)
    startFast   \* session -> its first input carried the flag (ghost)
vars == <<started, ver, tag, fast, cans, startTag, startFast>>

Init ==
    /\ started = [s \in Sessions |-> s = "R"]
    /\ ver = [s \in Sessions |-> StartVer(s)]
    \* 1.0.83 derives neither option, whatever its input carries
    /\ tag = [s \in Sessions |-> s = "R" /\ RootTag /\ ~RootOn83]
    /\ fast = [s \in Sessions |-> s = "R" /\ RootFast /\ ~RootOn83]
    /\ cans = [s \in Sessions |-> 0]
    /\ startTag = [s \in Sessions |-> s = "R" /\ RootTag]
    /\ startFast = [s \in Sessions |-> s = "R" /\ RootFast]

(* A continue-as-new into the latest version, 1.0.84.                      *)
Can(s) ==
    /\ started[s] /\ cans[s] < MaxCan
    /\ LET carried == ver[s] = "84" /\ Fault # "drop-at-can"
       IN /\ tag' = [tag EXCEPT ![s] = carried /\ tag[s]]
          /\ fast' = [fast EXCEPT ![s] = carried /\ fast[s]]
    /\ ver' = [ver EXCEPT ![s] = "84"]
    /\ cans' = [cans EXCEPT ![s] = cans[s] + 1]
    /\ UNCHANGED <<started, startTag, startFast>>

(* A turn (or the regeneration step) of the parent creates c, which starts *)
(* at the latest version with what its creation passed.                    *)
Create(c) ==
    LET p == Parent(c)
        routed == ver[p] = "84" /\ Fault # "child-untagged"   \* a 1.0.83 parent passes no routing
        inTag == IF IsSystem(c) THEN (Fault = "system-child-tagged" /\ ver[p] = "84" /\ tag[p]) ELSE routed /\ tag[p]
        inFast == IF IsSystem(c) THEN (Fault = "system-child-tagged" /\ ver[p] = "84" /\ fast[p]) ELSE routed /\ fast[p]
    IN /\ c # "R" /\ ~started[c] /\ started[p]
       /\ started' = [started EXCEPT ![c] = TRUE]
       \* deriveOptions: no tag for a system input; the flag as given
       /\ tag' = [tag EXCEPT ![c] = inTag /\ ~IsSystem(c)]
       /\ fast' = [fast EXCEPT ![c] = inFast]
       /\ startTag' = [startTag EXCEPT ![c] = inTag]
       /\ startFast' = [startFast EXCEPT ![c] = inFast]
       /\ UNCHANGED <<ver, cans>>

Done == (\A s \in Sessions : started[s] /\ cans[s] = MaxCan) /\ UNCHANGED vars

Next == (\E s \in Sessions : Can(s) \/ Create(s)) \/ Done
Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK == /\ started \in [Sessions -> BOOLEAN] /\ ver \in [Sessions -> {"83", "84"}]
          /\ tag \in [Sessions -> BOOLEAN] /\ fast \in [Sessions -> BOOLEAN] /\ cans \in [Sessions -> 0..MaxCan]
(* A 1.0.84 session whose first input carried the tag (the flag) keeps it  *)
(* in every execution.                                                     *)
Inv_TagKept == \A s \in Sessions : (started[s] /\ startTag[s] /\ StartVer(s) = "84" /\ ~IsSystem(s)) => tag[s]
Inv_FastKept == \A s \in Sessions : (started[s] /\ startFast[s] /\ StartVer(s) = "84") => fast[s]
(* In a tree whose root started tagged (flagged) on 1.0.84, every non-     *)
(* system session carries the tag (the flag).                              *)
Inv_TreeTagged == (RootTag /\ ~RootOn83) => \A s \in Sessions \ {"S"} : started[s] => tag[s]
Inv_TreeFast == (RootFast /\ ~RootOn83) => \A s \in Sessions \ {"S"} : started[s] => fast[s]
(* A system sub-agent gets neither.                                        *)
Inv_SystemUntagged == started["S"] => (~tag["S"] /\ ~fast["S"])
(* No tag or flag appears that the root's first input did not carry.       *)
Inv_NothingFromNowhere == \A s \in Sessions : (tag[s] => RootTag) /\ (fast[s] => RootFast)
(* A tree whose root started on 1.0.83 stays untagged and unflagged.       *)
Inv_83Untagged == RootOn83 => \A s \in Sessions : ~tag[s] /\ ~fast[s]

W_NoGrandchildTagged == ~(started["G"] /\ tag["G"] /\ cans["G"] > 0)
=============================================================================
