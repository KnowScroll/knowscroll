# Reasoning admission: implementation and verification plan

Status: storage/privacy implemented in #44 and atomic execution primitives in #45; J004 synthetic process proof implemented in #46, following [ADR-0012](../decisions/0012-reasoning-admission-and-reconciliation.md). Shared metadata schemas, SQL storage, history-clear integration, a restricted receipt append helper and bounded retention cleanup exist. Atomic admission, cumulative settlement and an unwired single-invocation worker boundary also exist. J004 covers process faults and interruption cleanup with local fixtures. [ADR-0013 and the fairness model](reasoning-fairness.md) are accepted in #54; [Durable SQL fairness](reasoning-sql-fairness.md) implements #55; product dispatch remains disabled. Parent [#7](https://github.com/KnowScroll/knowscroll/issues/7) remains open.

## Release order and ownership

| Slice | Owner / paths | Dependency and completion condition |
|---|---|---|
| [Storage and privacy #44](https://github.com/KnowScroll/knowscroll/issues/44) | Core: new ordered migration, `packages/db`, scoped tests | Implement private reasoning graph plus separate accounting identities, constraints and clear-history erasure together. Preserve existing migrations/data and ADR-0010 behavior. Coordinator allocates migration number after checking current main |
| [Atomic execution primitives #45](https://github.com/KnowScroll/knowscroll/issues/45) | Reasoning: worker runtime and scoped tests, DB helper seams agreed centrally | Consume released storage contracts; implement reserve, one-time dispatch authorization, receipt settlement, withdrawal and crash recovery. Keep all provider dispatch disabled; fake transport only in tests |
| [J004 protocol proof #46](https://github.com/KnowScroll/knowscroll/issues/46) | Verification: new isolated runner/verifier, journey and receipts | Consume both slices. Run real separate processes and disposable PostgreSQL against a local fake transport; observe durable state before request and crash/recovery boundaries. Label all provider responses as fixtures |
| [Fairness policy/model #54](https://github.com/KnowScroll/knowscroll/issues/54) | Coordinator ADR-0013, Terra pure model and independent counterexamples | Settle class/universe service, bounded borrowing, accounting and replay before changing SQL |
| [Durable SQL fairness #55](https://github.com/KnowScroll/knowscroll/issues/55) | Coordinator schema/accounting and atomic scheduler; Terra/Sol independent SQL tests/review | Persist service turns and combine claim/reservation, with concurrency, clear/late correction and actual PostgreSQL restart evidence |
| [Authorized frozen context #60](https://github.com/KnowScroll/knowscroll/issues/60) | Coordinator schema/authority, Terra compiler/SQL adversaries, Sol privacy review | Freeze literal selected Keep/Scroll evidence with typed reads, immutable original-session binding and concrete admission validation; no provider or proposal application |
| [Seven-day private retirement #62](https://github.com/KnowScroll/knowscroll/issues/62) | Coordinator retention/migration/process proof, Terra runtime + independent review, Sol privacy tests | Safely withdrawn cancelled/expired graphs retire after 168 hours; separate 30-day accounting purge preserves unknown liabilities; no completed-job or new withdrawal authority |
| [Literal Ask facts #64](https://github.com/KnowScroll/knowscroll/issues/64) | Coordinator source contract/migration/HTTP proof, Terra admission and review, Sol privacy adversaries | Durable exposure-anchored literal input with recorded-only receipt, exact session replay and immediate clear; no job/provider/answer |
| Integration | Coordinator: shared contracts/ADRs, lockfile/root wiring/CI, review and release | Review actual diffs; full tests, J001–J004, migration preservation and privacy regressions. Update truth and close only the bounded completed issues |

No worker shares a checkout, database, API port or file-edit lane. No provider credential is required. A migration-only merge must leave new tables unused; no caller may admit rows before the matching clear/accounting helpers are present. Schema and clear behavior are one reviewed PR. First implementation must not import the certification adapter into the ordinary worker loop.

## Required transaction interfaces

Exact SQL/API names may evolve within the accepted ADR, but each operation must expose these outcomes distinctly:

- `claimJob`: claimed with new lease fence, unavailable/locked, cancelled/expired, or obsolete epoch. Database time owns expiry.
- `reserveAttempt`: atomically admitted identity+permit+all bucket reservations, or a typed denial with no partial writes. Request identity/hash and output ceiling are immutable.
- `authorizeDispatch`: one committed dispatch identity returned only to the successful current caller, or a refusal. Reading an existing committed intent never authorizes transport.
- `recordReceipt`: authenticated original evidence into the minimal sink; identical retry is a no-op, conflicting reuse is rejected, stale/withdrawn content is discarded.
- `settleReceipt`: append one cumulative settlement revision and bucket adjustment; independently retain unknown usage and unconfirmed remote capacity.
- `withdrawJob` / `recoverAttempt`: fence execution and preserve accounting uncertainty. A lease takeover or restart never replays possibly sent work.

Application/HTTP clients do not supply universe authority or call the restricted receipt sink. There is no public paid-job endpoint in this wave. The runtime helper API needs fault-test hooks at durable transaction boundaries, not production failure flags or provider URLs supplied by clients.

## Adversarial acceptance matrix

| Case | Required observation | Proof layer |
|---|---|---|
| Fresh and populated upgrade | 0001–0003 checksums unchanged; existing rows preserved; new constraints reject cross-scope links | Real PostgreSQL migration tests |
| Concurrent budget admission | Exactly the allowed reservations win; failed transaction leaves no Attempt/Permit/partial debit | Concurrent PostgreSQL clients |
| Missing/wrong route bucket or unit | Admission denied; no request; shared-account limits cannot be bypassed by changing key | Contract + DB integration |
| Largest request / impossible request | Fitting request is representable; permanently impossible work gets a reason, not endless queueing | Admission tests; fairness later |
| Reserved but no dispatch intent | Cancel/expiry/clear closes not_sent and releases only unconsumed reservation dimensions | DB + J004 |
| Committed intent before socket send, worker killed | No claim of not_sent; possible-send state survives; replacement never dispatches it | Two worker processes + local HTTP count |
| Bytes observed then worker killed | One observed invocation, unresolved remote outcome and held liability/concurrency after restart | Local HTTP fixture + PostgreSQL |
| Lost authorization commit acknowledgement | Original and replacement both refuse replay; operator can inspect uncertainty | Fault at transaction acknowledgement |
| Lease A expires; B claims; A resumes | Old fence cannot authorize/checkpoint/apply; authentic late original receipt can settle usage only | Two workers + DB clock predicates |
| Cancel/deadline after dispatch | Output withdrawn; local abort never supplies remote cancellation proof; unknown usage remains null | Delayed HTTP fixture |
| Clear during a possible remote call | Existing J003 effects hold; private graph/read sets/hashes erased; minimal accounting survives; late output creates nothing | Real API clear + delayed fixture + DB |
| Replay an older clear after later reasoning activity | Exact original receipt is returned before any reasoning/accounting mutation; later work and reservations survive | API/DB J004 regression |
| Duplicate/conflicting receipt | Exact replay posts no second debit; conflicting same-ID payload rejected; new cumulative revision posts only delta | DB settlement tests |
| Partial/late usage and overage | Unknown dimensions stay held; late known counts settle once; overage recorded and affected admission paused | DB + fixture receipts |
| Unconfirmed remote completion | Missing terminal guarantee keeps conservative remote capacity even if monetary accounting closes | Recovery tests |
| One universe row held | Another ready universe can be claimed/admitted; canonical bucket locking completes without deadlock | Concurrent DB clients + bounded timeout |
| Context changes vs unrelated keep | Foreign scope/stale required dependency rejected; unrelated revision alone is not an application veto | Contract tests now; apply tests before proposals |
| Retention cleanup | Only all-duties-closed identities begin the policy horizon; financial closure with unresolved remote duty cannot purge identity; unknown liability is never TTL-refunded; erased payload never recreated | DB clock-controlled tests |
| J004 interrupted | Disposable DB/processes cleaned up; owner DB, normal emulator and ignored credentials untouched | Cancellation/cleanup test |

J004 must report commit, database/process isolation, exact fixture request count, attempt/dispatch/settlement identities, nullable usage and the invariant checks. It must not call those fixture results live MiniMax certification or user usefulness. Evidence must contain no private payloads, raw provider IDs, credentials or raw errors.

## Later gates before product enablement

1. [#55](https://github.com/KnowScroll/knowscroll/issues/55) implements durable SQL fairness and atomic claim/reservation after the accepted [#54 contract/model](reasoning-fairness.md). Prove bounded class/per-universe service under stated finite-capacity assumptions, idle-credit caps, blocked-candidate progress, cumulative corrections and no unknown-call capacity reset with real concurrent clients and restart/privacy tests.
2. [#60](reasoning-context.md) implements authorized context compilation and typed read validation for literal selected Scroll evidence. Typed proposal validation remains a separate gate; no user-state mutation follows from transport success alone.
3. [#64](explicit-asks.md) implements source-only literal Ask durability. Ask-specific context, exact direct-intent Job lifecycle and H/H2 coalescing remain required when those execution consumers are introduced; optional children must inherit budget and release waiting-parent execution slots.
4. [#62](reasoning-retirement.md) integrates the retained-accounting purge with seven-day safely withdrawn cancelled/expired private-graph retirement in a separate scheduled worker. Completed/failed-job lifecycle and product privacy controls/copy remain required before sending private context. Account deletion and backup retention remain separate unresolved requirements.
5. Select a current route capability/price policy and an explicitly bounded product-provider experiment. Certification's historical three-call run is not a standing authorization for unlimited inference.

All later work remains visible under #7 and related #4/#6. This plan does not reduce the semantic, recommendation, cosmic or social product target.

## Design acceptance — September 16, 2026

A read-only Sol audit checked the existing PostgreSQL/clear implementation and reviewed privacy/retention. Terra independently reviewed the state machine and schemas. Corrections put retry lineage on each Attempt, made post-clear late-receipt authorization explicit, represented permit/settlement state, rejected inconsistent output authority, preserved the exact-clear replay early return and required all accounting/reconciliation duties to close before retention expiry. Both reviews accepted the final design.

`pnpm typecheck` and `pnpm test` passed locally: 75 total tests (12 baseline + 63 additional), including nine new adversarial reasoning-contract tests. These validate strict metadata and existing regression behavior; no SQL admission state machine, J004, live provider call or new product journey was executed for #42. CI continues running the existing J001/J002/J003 regressions. Database proof remains required by #44–#46.
