-------------------------- MODULE QuestionAnswers --------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxEnvelopes, FifoCap, ReceiptCap, OldQuestion, Fault
ASSUME MaxEnvelopes \in 1..4 /\ FifoCap \in 1..2 /\ ReceiptCap \in 1..2 /\ OldQuestion \in BOOLEAN
ASSUME Fault \in {"none", "text-only", "overwrite", "replay-cache", "fifo-clears", "can-token", "ignore-cap"}

Ids == 1..2
Bodies == 1..2
Tokens == 0..2
Unknown == <<0, 0>>
EmptyReceipt == [status |-> "unknown", fp |-> Unknown]
Statuses == {"unknown", "pending", "accepted", "stale", "refused"}

VARIABLES question, token, pending, mayOpen, fifo, receipts, first, final,
          owned, effects, received, replayed, continued, badStale, badRefusal
vars == <<question, token, pending, mayOpen, fifo, receipts, first, final,
          owned, effects, received, replayed, continued, badStale, badRefusal>>

Init ==
    /\ question = 1 /\ token = IF OldQuestion THEN 0 ELSE 1
    /\ pending = TRUE /\ mayOpen = FALSE /\ fifo = <<>>
    /\ receipts = [id \in Ids |-> EmptyReceipt]
    /\ first = [id \in Ids |-> Unknown]
    /\ final = [id \in Ids |-> "unknown"]
    /\ owned = {} /\ effects = [id \in Ids |-> 0] /\ received = 0
    /\ replayed = FALSE /\ continued = FALSE /\ badStale = FALSE /\ badRefusal = FALSE

\* A command's recorded self-read precedes this atomic FIFO/receipt write.
\* Duplicate/conflicting copies never append another item or replace a result.
Conditional(id, occurrence, body) ==
    /\ received < MaxEnvelopes
    /\ LET fp == <<occurrence, body>>
           seen == receipts[id].status # "unknown"
           conflict == seen /\ receipts[id].fp # fp
           overwrite == conflict /\ Fault = "overwrite"
           available == Cardinality({key \in Ids : receipts[key].status # "unknown"}) < ReceiptCap \/ Fault = "ignore-cap"
           admit == (~seen /\ available) \/ overwrite
           full == Len(fifo) >= FifoCap
       IN /\ receipts' = IF admit
                         THEN [receipts EXCEPT ![id] = [status |-> IF full THEN "refused" ELSE "pending", fp |-> fp]]
                         ELSE receipts
          /\ first' = IF ~seen /\ admit THEN [first EXCEPT ![id] = fp] ELSE first
          /\ final' = IF ~seen /\ admit /\ full THEN [final EXCEPT ![id] = "refused"] ELSE final
          /\ fifo' = IF admit /\ ~full
                     THEN Append(fifo, [kind |-> "conditional", id |-> id, occ |-> occurrence, body |-> body])
                     ELSE fifo
          /\ pending' = IF ~seen /\ admit /\ full /\ Fault = "fifo-clears" THEN FALSE ELSE pending
          /\ badRefusal' = (badRefusal \/ (~seen /\ admit /\ full /\ pending /\ Fault = "fifo-clears"))
    /\ received' = received + 1
    /\ UNCHANGED <<question, token, mayOpen, owned, effects, replayed, continued, badStale>>

Legacy(body) ==
    /\ received < MaxEnvelopes
    /\ fifo' = IF Len(fifo) < FifoCap
               THEN Append(fifo, [kind |-> "legacy", id |-> 0, occ |-> IF pending THEN question ELSE 0, body |-> body])
               ELSE fifo
    /\ received' = received + 1
    /\ UNCHANGED <<question, token, pending, mayOpen, receipts, first, final, owned, effects,
                   replayed, continued, badStale, badRefusal>>

\* All question text is identical in this model. Only occurrence identity
\* can distinguish the later question; the text-only fault removes that fence.
ConsumeConditional ==
    /\ Len(fifo) > 0 /\ Head(fifo).kind = "conditional"
    /\ \E fits \in BOOLEAN :
         LET item == Head(fifo)
             id == item.id
             eligible == receipts[id].status = "pending" /\ receipts[id].fp = <<item.occ, item.body>>
             matches == pending /\ token # 0 /\ (item.occ = token \/ Fault = "text-only")
             accept == eligible /\ matches /\ fits
             refused == eligible /\ matches /\ ~fits
             settle == IF accept THEN "accepted" ELSE IF refused THEN "refused" ELSE "stale"
         IN /\ receipts' = IF eligible THEN [receipts EXCEPT ![id].status = settle] ELSE receipts
            /\ final' = IF eligible THEN [final EXCEPT ![id] = settle] ELSE final
            /\ owned' = IF accept THEN owned \cup {id} ELSE owned
            /\ pending' = IF accept \/ (refused /\ Fault = "fifo-clears") THEN FALSE ELSE pending
            /\ badStale' = (badStale \/ (accept /\ item.occ # token))
            /\ badRefusal' = (badRefusal \/ (refused /\ Fault = "fifo-clears"))
    /\ fifo' = Tail(fifo)
    /\ UNCHANGED <<question, token, mayOpen, first, effects, received, replayed, continued>>

\* A stale legacy answer remains ordinary input; it never consumes a later
\* question, but its turn still runs. LLM execution is abstracted to one step.
ConsumeLegacy ==
    /\ Len(fifo) > 0 /\ Head(fifo).kind = "legacy"
    /\ pending' = IF Head(fifo).occ = question THEN FALSE ELSE pending
    /\ mayOpen' = TRUE /\ fifo' = Tail(fifo)
    /\ UNCHANGED <<question, token, receipts, first, final, owned, effects, received,
                   replayed, continued, badStale, badRefusal>>

Run(id) ==
    /\ id \in owned
    /\ owned' = owned \ {id}
    /\ effects' = [effects EXCEPT ![id] = @ + 1]
    /\ mayOpen' = TRUE
    /\ UNCHANGED <<question, token, pending, fifo, receipts, first, final, received,
                   replayed, continued, badStale, badRefusal>>

OpenLater ==
    /\ ~pending /\ mayOpen /\ owned = {} /\ question < 2
    /\ question' = question + 1 /\ token' = question + 1
    /\ pending' = TRUE /\ mayOpen' = FALSE
    /\ UNCHANGED <<fifo, receipts, first, final, owned, effects, received,
                   replayed, continued, badStale, badRefusal>>

\* A recorded read reconstructs the original prompt even when the external
\* materialized receipt has advanced. The fault models skipping that prompt
\* after a crash because a non-recorded cache lookup sees "accepted".
Replay ==
    /\ ~replayed /\ replayed' = TRUE
    /\ owned' = IF Fault = "replay-cache" THEN {} ELSE owned
    /\ UNCHANGED <<question, token, pending, mayOpen, fifo, receipts, first, final, effects,
                   received, continued, badStale, badRefusal>>

\* Input snapshots carry the same pending token; instance KV retains the FIFO
\* and canonical receipts. Old pending questions stay tokenless until replaced.
Continue ==
    /\ ~continued /\ continued' = TRUE
    /\ token' = IF pending /\ Fault = "can-token" /\ token # 0 THEN (IF token = 1 THEN 2 ELSE 1) ELSE token
    /\ UNCHANGED <<question, pending, mayOpen, fifo, receipts, first, final, owned, effects,
                   received, replayed, badStale, badRefusal>>

Idle == UNCHANGED vars
Next ==
    \/ \E id \in Ids, occurrence \in 1..2, body \in Bodies : Conditional(id, occurrence, body)
    \/ \E body \in Bodies : Legacy(body)
    \/ ConsumeConditional \/ ConsumeLegacy
    \/ \E id \in Ids : Run(id)
    \/ OpenLater \/ Replay \/ Continue \/ Idle

TypeOK ==
    /\ question \in 1..2 /\ token \in Tokens /\ pending \in BOOLEAN /\ mayOpen \in BOOLEAN
    /\ Len(fifo) <= FifoCap
    /\ receipts \in [Ids -> [status : Statuses, fp : Tokens \X Tokens]]
    /\ first \in [Ids -> Tokens \X Tokens] /\ final \in [Ids -> Statuses]
    /\ owned \subseteq Ids /\ effects \in [Ids -> 0..MaxEnvelopes]
    /\ received \in 0..MaxEnvelopes /\ replayed \in BOOLEAN /\ continued \in BOOLEAN
    /\ badStale \in BOOLEAN /\ badRefusal \in BOOLEAN

InvNoStale == ~badStale
InvCanonical == \A id \in Ids :
    /\ receipts[id].fp = first[id]
    /\ (final[id] # "unknown" => receipts[id].status = final[id])
InvOwned == \A id \in Ids :
    /\ (receipts[id].status = "accepted" => id \in owned \/ effects[id] = 1)
    /\ effects[id] + (IF id \in owned THEN 1 ELSE 0) <= 1
InvRefused == ~badRefusal
InvToken == pending => token = (IF OldQuestion /\ question = 1 THEN 0 ELSE question)
InvCapacity == Cardinality({id \in Ids : receipts[id].status # "unknown"}) <= ReceiptCap

Spec == Init /\ [][Next]_vars
=============================================================================
