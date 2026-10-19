# reasoning

The shared execution engine (blueprint §15): attempt accounting for external, possibly paid calls.
It owns no role; roles live in their modules and call `executeModelStep`. Owns:
`reasoning.business_runs`, `reasoning.external_attempts` (migration `0006_reasoning_ledger`),
personal records keyed `(universe_id, id)` with each attempt tied to its own run by a composite
foreign key.

`executeModelStep(authority, step, signal)`:

1. Ledger inspection (no authority): an attempt recorded with another request hash is refused
   (`request_mismatch`); one left `dispatched` by an earlier delivery becomes `unknown` and is
   never resent; a settled one is answered from the ledger — a stored successful output is
   returned again (after the eligibility check), so a crash or busy lock between settlement and
   use never costs a second paid call.
2. Admission (personal scope; authority checked): admit the run, re-read the attempt under the
   lock (concurrent deliveries serialise here), reserve it if absent. Refused → a reserved attempt
   becomes `not_sent`.
3. Dispatch intent (personal scope; authority rechecked): `reserved → dispatched`. Refused →
   `not_sent`; lost to a concurrent delivery → `dispatch_lost`, nothing sent by this delivery.
4. No transaction: `ModelPort.invoke` (every port is wrapped by `guardedModelPort`).
5. Ledger-owned settlement (own short transaction, independent of current authority):
   `succeeded` with outcome `SUCCEEDED` and the output stored on the attempt (`{v: 1, text}`, at
   most `MAX_STORED_OUTPUT_BYTES` = 64 KiB of JSON; a larger answer is recorded
   `OUTPUT_TOO_LARGE`, not stored, and reported `failed` on every delivery), `failed` with the
   provider's rejection code, or `unknown` (`TRANSPORT_OUTCOME_UNKNOWN`). If a concurrent delivery
   already marked the attempt `unknown`, a conclusive answer is recorded as `reconciled` with its
   real outcome code (and output). `settled_at` is set only for settled outcomes, never for
   `unknown`.
6. Output eligibility (identity's `AuthorityHolds`: a lock-free read, nothing written): an answer
   produced for an authority that no longer holds is `ineligible` and must not be applied. If the
   read fails, the error propagates and the job is retried; the output stays stored.

States: `reserved`, `not_sent`, `dispatched`, `succeeded`, `failed`, `unknown`, `reconciled`,
`written_off`. Adapters: `adapters/nest-providers.ts` exports `makeAttemptLedger(db)` and
`guardedModelPort` for composition roots and tests.

Skeleton scope (S1.2): no real provider (S2.2), no protected request or output store (S2.2 moves
large or sensitive outputs there and keeps a reference on the attempt), no reconciliation job, no
budget reservation. The integration tests use a labelled fixture model. Erasure: settled attempts
(with their outputs) and their runs per universe; attempts still `dispatched` or `unknown` are
kept as open liability and the erasure reports `pending` (`adapters/erasure.ts`).
