# Reasoning storage and privacy boundary

Issue [#44](https://github.com/KnowScroll/knowscroll/issues/44) implements the storage portion of [ADR-0012](../decisions/0012-reasoning-admission-and-reconciliation.md). Migration `0004_reasoning_storage.sql` adds a separate reasoning graph; the existing deterministic `job` table and worker keep their meaning. [Admission, dispatch authorization, cumulative settlement and recovery primitives](reasoning-runtime.md) are implemented by #45; J004 belongs to #46. Product provider execution remains disabled.

## Private graph and retained accounting

| Records | Purpose | History clear |
|---|---|---|
| `reasoning_job`, `reasoning_step`, `reasoning_attempt` | Private execution identity, retry lineage, request hash and lease fence | Delete scoped rows |
| `reasoning_context`, `reasoning_context_read` | Context hash and typed, scoped revision dependencies | Delete scoped rows |
| `reasoning_accounting` | Original universe/epoch, request/dispatch binding, route/profile, liability, remote and retention duties | Withdraw output authority; retain minimal identity |
| `reasoning_permit`, `reasoning_reservation` | One-use authorization and typed bucket commitments | Close unconsumed commitments; preserve possibly sent commitments |
| `reasoning_receipt`, `reasoning_settlement`, `reasoning_settlement_adjustment` | Append-only usage evidence and accounting revision metadata | Retain under accounting policy |
| `reasoning_bucket` | Shared capacity, reservation and consumption counters | Release only proven unconsumed reservations |

No prompt, native thinking, tool arguments/results, response content or semantic proposal is persisted by these tables. Retained accounting has no Job, Step or context foreign key. It keeps its restricted universe and original epoch to bind authentic late usage; it is not personalization history.

Composite foreign keys enforce universe/epoch/context ownership, ordered same-Step retries, route/request/dispatch receipt binding and bucket units. Unique constraints cover ordinals, request/dispatch IDs, one active Attempt per Step and one reservation per Attempt/bucket. Database triggers protect immutable identities and append-only evidence. They are storage safeguards, not a complete admission controller: coherent creation, authorization, counters, authentication and transaction fencing are implemented in the #45 internal factories; their configured authority callbacks remain trusted server responsibilities.

## Transaction helpers

The internal helpers in `packages/db/src/reasoning-storage.ts` require an explicit caller transaction. Hold the universe lock before private Job/Step/Attempt and accounting rows, then acquire shared bucket locks in UUID order. Never hold these locks across a provider call.

- `eraseReasoningForHistoryClear` runs inside the authenticated history-clear transaction. Exact replay of an existing clear receipt returns before this helper runs. A new clear withdraws all scoped accounting output authority, closes provably unconsumed permits/reservations and erases the private graph. Possibly sent work keeps its liability and remote-capacity duties. Any failure rolls back the epoch, session rollover, graph erasure and accounting changes together.
- `appendRestrictedReasoningReceipt` parses strict metadata and binds the original Attempt, universe/epoch, request, dispatch and route/profile. Identical receipt retries are no-ops; conflicting reuse fails. An old epoch does not prevent original usage evidence from being recorded after clear, but the helper never recreates private context or output authority. The internal worker/reconciler origin is a caller contract, not a public authentication mechanism; #45 wraps this helper in a trusted internal reconciliation factory; a public authenticated sink remains unimplemented. New evidence reopens reconciliation duties; this helper does not calculate settlement or release usage reservations.
- `purgeClosedReasoningAccounting` performs bounded cleanup after all duties have been closed for at least 30 days. Financial closure alone is insufficient. Held liability, unconfirmed remote duties, reconciliation or idempotency holds block removal. A surviving private Attempt also blocks cleanup; autonomous retirement of completed private graphs and a scheduled cleanup worker remain future work. Eligible accounting deletion cascades retained evidence; direct child deletion stays forbidden.

Evidence-based closure requires terminal remote evidence or proven not-sent state. Explicit operator-risk closure is distinguishable and rejects new receipts; it does not turn an unknown outcome into success. Unknown liability is never refunded merely because time passed.

## Migration and release

Migrations 0001–0003 remain byte-for-byte unchanged. Apply the new ordered migration using `pnpm db:migrate`; do not rewrite migration history or reset owner data. Deploy migration and matching clear helpers together before any future caller admits reasoning rows.

Run `pnpm typecheck`, `pnpm test` and the isolated J001/J002/J003 runners. The storage and privacy suites use disposable PostgreSQL data, including populated upgrade, full retention cascade, clear rollback, old-epoch receipts and exact-clear retry after later activity. These are database/helper checks; they do not prove J004 crash boundaries, live reasoning dispatch or production operation.

Current verification receipts are linked from [Project state](../PROJECT-STATE.md). The [implementation plan](reasoning-implementation-plan.md) tracks remaining gates.
