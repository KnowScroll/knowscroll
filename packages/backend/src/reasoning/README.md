# reasoning

The shared execution engine (blueprint §15): attempt accounting for external, possibly paid calls.
It owns no role; roles live in their modules and call `executeModelStep`. Owns:
`reasoning.business_runs`, `reasoning.external_attempts` (migration `0006_reasoning_ledger`).

`executeModelStep(authority, step, signal)`:

1. Tx 1 (personal scope): admit the business run (idempotent); reserve an attempt for the step,
   or decide from the existing attempt's state (`domain/attempts.ts`): never-dispatched → continue;
   `dispatched` without outcome → record `unknown` and stop; settled → stop.
2. Tx 2 (fresh lock and authority recheck): `reserved → dispatched` (dispatch intent committed).
3. No transaction: `ModelPort.invoke` — every port is wrapped by `guardedModelPort`, which refuses
   to run inside a transaction.
4. Tx 3: `succeeded`, `failed` (conclusive `ModelRejectedError`) or `unknown` (any other error).

A crash between 2 and 4 leaves `dispatched`; the next delivery records `unknown` and never sends
again. `unknown` leaves only by reconciliation or write-off (later). States: `reserved`,
`not_sent`, `dispatched`, `succeeded`, `failed`, `unknown`, `reconciled`, `written_off`.

Skeleton scope (S1.2): no real provider (S2.2), no protected request store, no reconciliation
job, no budget reservation. The integration tests use a labelled fixture model. Erasure: runs and
attempts per universe (`adapters/erasure.ts`).
