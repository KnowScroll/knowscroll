# Reasoning admission and reconciliation primitives

[#45](https://github.com/KnowScroll/knowscroll/issues/45) implements the internal database operations defined by [ADR-0012](../decisions/0012-reasoning-admission-and-reconciliation.md), on top of [#44 storage](reasoning-storage.md). Migration 0005 adds immutable policy/input bindings and cumulative accounting metadata. Migrations 0001–0004 remain unchanged.

These are development primitives. The ordinary worker still processes deterministic keeps only; `reasoningReadiness()` remains false. No provider adapter or public endpoint is connected to these operations. [#46](https://github.com/KnowScroll/knowscroll/issues/46) adds [J004](../journeys/J004.md), which verifies the protocol in a separate-process synthetic runtime harness. This does not enable product calls.

The separate [fairness model](reasoning-fairness.md) and [ADR-0013](../decisions/0013-bounded-reasoning-fairness.md) define the scheduling policy before its SQL implementation. [Durable SQL fairness](reasoning-sql-fairness.md) now composes the internal transaction helpers into one atomic fair claim/reservation operation. The split methods below remain the earlier development primitives.

## Trust and policy boundary

`createReasoningAdmission(pool, authority)` receives trusted server configuration with two required callbacks:

- `resolvePolicy(client, scope)` returns a versioned route policy and the complete bucket bindings for that Job/universe. Callers of admission do not choose buckets. Baseline global/owner/job budgets, provider account, route quota and remote concurrency are mandatory; additional rate dimensions must have matching windows. Different provider keys sharing an account must resolve to the same account buckets.
- `validateContext(client, scope)` rechecks the scoped context and current permissions/read dependencies before admission and dispatch. There is no permissive default. The full context compiler and typed proposal validator remain future work; the tests supply explicit fixture implementations.

Callbacks perform short local/SQL work within the transaction, never provider or network I/O. Context validation must lock or conditionally guard its relevant dependency versions through commit; a boolean from an earlier external read is insufficient. The factories repeat validation after bucket-lock waits. They are internal authorities, not values supplied by mobile or HTTP clients. Policy validation checks duplicate/missing bindings, scope, units, interpretation and version. Monetary bindings require a declared price basis and a conservative ceiling; this does not authorize a live monetary experiment.

Each admitted identity retains its policy version, price basis, binding fingerprint and input ceiling. Each reservation retains its usage basis and handling mode. Settlement uses these immutable records after restart or privacy clear, without looking up a potentially changed policy. The fingerprint omits private Job/universe scope identifiers; private request/context hashes remain in the erasable graph.

## Transaction ownership and operations

The factory methods own `BEGIN`/`COMMIT`/`ROLLBACK`; call them with a pool, not inside another transaction. A result granting transport authority returns only after successful commit acknowledgement. No transaction spans a transport call.

| Operation | Behavior |
|---|---|
| `claimJob` | Selects queued work with universe `SKIP LOCKED`, checks epoch/deadline, and advances a bigint fence. Returns a claim or no available claim; this is not fair scheduling |
| `reserveAttempt` | Validates the current lease/context/policy; locks all required buckets in UUID order; inserts private Attempt, retained identity, Permit and complete reservations with conditional debits in one transaction. Denials leave no partial writes |
| `authorizeDispatch` | Rechecks the original body hash, input/output ceilings, policy binding, context, fence and database deadlines, including after bucket-lock waits. Consumes one Permit and commits one dispatch identity; an existing intent never grants another invocation |
| `markAttemptUnknown` | Preserves possible-send liability after transport failure, abort or deadline. Accounting withdrawal is monotonic; stale callers cannot advance private execution state |
| `withdrawJob` | Withdraws output authority across the Job, releases only unconsumed reservations, and preserves possibly sent commitments. Multi-attempt withdrawal takes all affected bucket locks in one order |
| `recoverAttempt` | Closes provably unconsumed work as not_sent or preserves a consumed intent as unknown, fences obsolete execution and never resends it |

Lock order is universe → Job → Step → Attempt/accounting → shared buckets sorted by UUID. Late reconciliation after private erasure needs only universe → retained accounting → sorted buckets. Job/Step completion, automatic retries, lease-renewal scheduling and general background execution are not supplied by these primitives. Explicit retry policy and dependency compilation remain later gates. Fair scheduling now uses the separate combined SQL entry point.

## One invocation boundary

`apps/worker/src/reasoning/invoke.ts` provides `invokeReasoningOnce` with an injected transport. It copies the serialized request, checks its SHA-256 hash and conservative input ceiling, obtains a fresh committed grant and invokes transport at most once. V1 requires the input ceiling to cover the full serialized UTF-8 byte length; provider-specific token/pricing calibration remains a later route-policy gate.

A lost commit acknowledgement yields no invocation. An abort/deadline after authorization remains potentially sent, even if this caller did not reach transport. Transport failure never causes an automatic retry. Only strictly parsed minimal usage/outcome metadata enters reconciliation; raw provider content/errors are not persisted. Late usage still reaches accounting after cancellation or privacy clear. There is no output application path.

The local HTTP integration test observes the committed intent before accepting its synthetic request, clears private history while the response is pending and settles original old-epoch usage once. This proves the integrated SQL/HTTP path in one test process; it does not prove killed-worker recovery, remote cancellation or exactly-once provider execution. J004 supplies separate-process fault evidence.

## Cumulative settlement

`createReasoningReconciliation(pool).recordAndSettleReceipt(input, origin)` owns one transaction for restricted receipt append and accounting. The origin is a trusted internal worker/reconciler classification; no public authentication endpoint is implemented.

- Original Attempt/request/dispatch/route binding remains required after clear. Neither a new epoch nor a lost lease can grant private output authority.
- Exact receipt retry posts no second charge. Conflicting same-ID evidence fails. Different receipt IDs append cumulative revisions, charging only the newly recognized difference.
- Nullable usage merges with prior known dimensions; null never turns into zero or erases earlier evidence. Cache counters remain independent of input totals.
- Budget reservations move to measured consumption when their basis becomes known. Rate reservations retain a consumption floor for their original window, so a refund cannot refill a rate bucket early. Remote slots release only on terminal evidence, independently of unknown financial usage.
- Overage is recorded and pauses affected buckets. Decreasing cumulative counts, contradictory terminal outcomes or incomplete legacy interpretation freeze reconciliation for review. Frozen evidence does not silently rewrite accepted totals.
- All financial, remote, reconciliation and idempotency duties must close before the 30-day retention clock starts. Unresolved work does not expire into free capacity. Scheduled cleanup and private-graph retirement remain later work.

## Reproduce and continue

Source `scripts/env.sh`, then run `pnpm typecheck`, `pnpm test`, the verifier rejection tests and isolated J001/J002/J003 runners. All new reasoning tests require disposable `knowscroll_test_*` databases. They use local fixtures and no provider credentials. Evidence is linked from [Project state](../PROJECT-STATE.md).

J004 now runs separate worker processes, records durable observations before crash/acknowledgement boundaries, checks exact local fixture request counts and independently verifies interruption cleanup. Its lease scenario proves expiry and recovery fencing; automatic requeue and a new execution claim remain absent. Keep product provider execution disabled. The complete Reasoning Plane, full privacy lifecycle, context/proposal authorization and a separately bounded provider experiment remain open under #7 and related epics.
