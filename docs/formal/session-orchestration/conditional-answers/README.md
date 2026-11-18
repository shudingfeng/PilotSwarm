# Conditional question answers: bounded safety model

This packet binds the provisional session orchestration `1.0.87`, prepared
from baseline `1863c78b62b75c59db3f0723ff39893500d0f674`. It does not change
Workflow controller behavior or any frozen orchestration history.

## Code correspondence

| Model action/rule | Production boundary |
|---|---|
| `Conditional` | `orchestration/queue.ts` → `enqueueQuestionAnswer`: recorded receipt read, duplicate/conflict suppression, serial capacity guard, atomic FIFO and pending-receipt writes |
| `ConsumeConditional` | `queue.ts` → `processAnswer`: compare pending token and text; stale returns without a turn; accepted atomically prepends an actual FIFO prompt and retains the receipt; formatted-prompt refusal leaves other work and the question intact |
| `Legacy`, `ConsumeLegacy` | Legacy answer FIFO admission and `processAnswer`'s unchanged iteration binding and ordinary-input fallback |
| `Run`, `OpenLater` | `turn.ts` → `processPrompt` and `handleTurnResult`: the answer's turn can open a later question with identical text and a fresh `ctx.newGuid()` token |
| `Replay` | `queue.ts` → `readQuestionAnswer`: a yielded KV self-read replays its recorded answer, never a later receipt cache value |
| `Continue` | `lifecycle.ts` → `buildContinueInput`, `versionedContinueAsNew`; `state.ts` restores the same pending question, with instance KV retained |
| `InvCanonical`, `InvOwned` | `question-answer.ts` payload hash and receipt identities; direct/Web management POST results compare hashes; GET returns the canonical original |
| `InvCapacity` | New requests stop before creating another receipt when total instance KV usage reaches the conservative 100-key soft limit; existing results remain readable |

The existing `DeliveryIdentity` model concerns a bounded client-message dedupe
window, not immutable question occurrences or retained conditional receipts.
This separate module models that new boundary without altering historical cases.

## Bounds and assumptions

- Two question occurrences, always with **identical text**.
- Two request IDs, two answer values and at most three incoming envelopes.
- FIFO capacity one or two; abstract receipt capacity one or two.
- At most one replay and one continue-as-new, at any modeled state.
- Legacy initial questions can lack a token. New questions cannot.
- Acceptance, claim and future-prompt ownership are one serial transition;
  the model's `owned` set abstracts the accepted FIFO prompt and existing
  durable turn/retry path. A nondeterministic fit choice covers formatting
  expansion without modeling byte strings.
- No fairness or liveness claim. `Idle` permits stuttering.
- No HTTP/authentication, cryptographic collision, LLM, provider transaction,
  failure-retry exhaustion or destructive session-deletion model.

The installed Duroxide package is `0.2.4`. Its current-execution KV delta is
committed with history and merged into instance KV at execution boundaries.
The PostgreSQL provider's
[instance-scoped retention migration](https://github.com/microsoft/duroxide-pg/blob/v0.1.38/migrations/0019_add_kv_last_updated.sql)
supersedes the older proposal's execution-owned pruning. Its
[delta migration](https://github.com/microsoft/duroxide-pg/blob/v0.1.38/migrations/0020_add_kv_delta.sql)
provides merged reads. Explicit instance deletion still removes receipts.
These are reviewed dependency contracts, not a local real-provider test result.

## Cases and execution

`gen-cases.py` generates the ten cases using `tlc_cases.py`; never commit the
generated `.cfg` files. The runners are byte-identical copies of the parent
packet's runners and require Java 17+ and checksum-pinned TLA+ tools `1.7.4`.

The four safety cases cover FIFO sizes, a tokenless old-version handoff and
receipt exhaustion. Six deliberate faults must violate their named invariant:
text-only matching, overwriting an original request, a replay-cache shortcut,
clearing the question on FIFO refusal, reminting on continuation and ignoring
receipt capacity. Fault counterexamples are negative controls, not product bugs.

Local results with TLC `1.7.4` and Java `21.0.13`:

| Case | Result | Distinct states |
|---|---|---:|
| `qa.serial-cap1` | PASS | 7,588 |
| `qa.serial-cap2` | PASS | 12,564 |
| `qa.legacy-handoff` | PASS | 6,516 |
| `qa.receipt-cap` | PASS | 4,324 |

All six fault cases exited `12` on their expected invariant. There were no
unexpected, partial or void results. SANY and packet/checksum validation passed.

The implementation fingerprint is
`643d3b4b6a866c0d3d0a8a2125911775f0742e97eb502ea85ba17031674510c2`.
It is SHA256 over the 31 changed/new SDK source, API source and app transport/
runtime files, including the frozen copy: sort repository-relative paths,
then hash each UTF-8 path, NUL, LF-normalized source and NUL.

Production-generator tests separately cover duplicate/conflicting requests,
identical later questions, legacy competition, both FIFO refusal points,
lost replies, replay schedules and continuation before accepted-prompt dispatch.
A bounded model pass and mocked generator histories are not a real native-runtime
or PostgreSQL persistence test; those checks remain required before release.
