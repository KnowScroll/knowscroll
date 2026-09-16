# ADR-0013 — Bounded reasoning fairness

Date: 2026-09-16. Status: proposed for independent review in [#54](https://github.com/KnowScroll/knowscroll/issues/54). This is a scheduling contract and executable model, not a released SQL scheduler or provider authorization. It refines the fairness paragraph of [ADR-0012](0012-reasoning-admission-and-reconciliation.md); all dispatch, accounting and privacy guards there remain required.

## Context

`claimJob` skips locked universes and orders queued work. It has no durable fair-service state. Counting requests would treat a small call like a large one; prioritizing cheap work can indefinitely defer large requests. The model must make these trade-offs inspectable before a migration or a new admission transaction is designed.

## Decision

Use two levels of weighted deficit round robin (DRR): classes first, then universes within the selected class. Each visit earns a bounded quantum of credit; several small requests or one large request can spend it. The universe's backlog length does not increase its weight. V1 gives every universe equal weight within each class; no engagement, inferred learning or identity characteristic changes this weight. Each universe can participate in multiple classes, but only trusted server policy assigns a Job's class.

### Policy and service unit

The reproducible fixture uses base quantum 100 and maximum normalized request charge `M = 100`:

| Class | Weight | Quantum | Maximum positive credit / visit spend |
|---|---:|---:|---:|
| interactive | 5 | 500 | 600 |
| active_continuity | 6 | 600 | 700 |
| accumulated_interpretation | 4 | 400 | 500 |
| background_inquiry | 3 | 300 | 400 |
| housekeeping | 2 | 200 | 300 |
| Each universe within a class | 1 | 100 | 200 |

These weights retain ADR-0012's initial tuning choice. They are not calibrated production percentages, requests per second, token throughput or latency promises. A runtime deployment needs its own versioned, reviewed route policy and measured capacity. Support for arbitrary user weights is deferred.

For a fixed policy basis `B[d] > 0`, compute `C(e) = max(1, max_d ceil(scale * e[d] / B[d]))`, where `e` is the conservative reservation estimate and `d` ranges over the configured constrained token/request dimensions. Use exact integer arithmetic, rounding upward; require a positive request dimension. Include input, full output ceiling and combined tokens where applicable, without adding unlike units. Basis values use one declared service horizon; do not normalize against the changing currently free balance. Store the basis, scale and policy revision with the charge. The model is not the multi-resource DRF allocator and claims none of its strategy-proofness or efficiency results.

Money, route/account budgets, per-job limits, rates and remote slots remain independent hard admission checks. A dominant scalar cannot prove those vector inequalities. Unknown call duration is not made into a guessed remote slot-time fairness cost. Reject invalid dimensions, unsafe integers and any request with `C(e) > M` or a demand above an absolute applicable capacity. There is no hidden large-work lane: return an explicit impossible decision for reshape/new policy. `M` must fit the smallest universe quantum and its cap. Capacity temporarily held by another request is exhausted capacity, not permanent impossibility.

### Visits, borrowing and bounded work

Persist the class ring, per-class universe rings, credits and open visits. A new eligible visit earns its quantum once. Drain fitting work while credit and that visit's separate spend allowance remain; one request per visit is not DRR. A tick with a finite probe/admission budget resumes the same open visit later without another quantum. Every candidate probe counts, including blocked, impossible, expired and empty work; discovery cannot hide an unbounded eligibility scan. Cursor progress survives a tick boundary and restart. A temporarily blocked candidate cannot pin all other universes. Ordering within a universe is stable enqueue order with bounded bypass of blocked work; a later ready job must not be hidden behind a permanently impossible head.

An empty lane loses positive credit; idle time earns none. Temporary ineligibility earns no repeated quantum, and retained credit stays capped. Negative settlement debt survives empty/blocked periods. No request-count, new-Job-ID, restart or idle-return credit reset bypass is allowed. An open visit has an independent maximum spend of `quantum + M`, so a receipt refund cannot lengthen it indefinitely. Once it finishes, move to the next class/universe. A continuously replenished queue cannot keep one visit open forever.

Skipping a class with no presently eligible, physically fitting work lends only its current opportunity. Borrowing creates no ownership transfer, future repayment claim or unlimited stored credit. Its ceiling is the physical admission vector plus each borrower's per-visit spend cap. A newly eligible class participates on the next complete traversal; it does not wait for a borrower's entire queue to drain. This refines the target's ambiguous “next admission restores the floor”: it restores a bounded turn, not necessarily the immediately following admission or a preempted remote slot. No per-class physical slot reservation is claimed.

### Reservation, correction and uncertainty

Fairness credit is neither a provider permit nor a budget. Atomically debit both class and universe by the conservative charge when the Attempt and full resource vector are reserved. A failed reservation debits neither. Hold that charge while usage is unknown. Only a provably unconsumed `not_sent` closure can undo its reservation without a receipt; timeout, lease loss and restart cannot.

For an authenticated cumulative receipt, retain original basis/version, merge known usage with retained estimates for unknown fields, recompute the normalized charge, and apply only the difference from the previously recognized charge to both balances. Positive refunds are capped; discarded excess is recorded, not banked elsewhere. Negative balances are debt and are not clipped away. Exact receipt replay is a no-op. Conflicting identity, decreasing cumulative usage or contradictory terminal disposition freezes automatic changes for review. No receipt supplies new scheduling authority or changes historical selections.

Physical resource accounting retains ADR-0012's rules: budgets settle known amounts; rate consumption is at least the reservation within its original window; rollover may renew that rate window but cannot erase remote or budget holds. Late adjustments address the original window. Proven terminal disposition can release a remote slot while usage is still unknown. Overage is fully recorded and pauses affected admission; recovery does not silently forgive it. No automatic retry or re-use of a consumed dispatch identity is introduced. Clearing private work cannot remove the debt or uncertain liability used to protect the shared system.

### Observable limits and service claim

Record distinct outcomes for ineligible work, locked/temporarily blocked scope, impossible request, insufficient credit, exhausted physical capacity, and paused policy. Preserve queue age, deadline misses, scan exhaustion and saturation observations. A missed hard deadline withdraws future execution eligibility; a consumed Attempt still carries its accounting duties. A bounded scan returning no selection is not proof that no eligible request exists.

The model's conditional claim is service **opportunity**, not elapsed response time. For a stable finite active set, fitting requests, continuously available physical capacity, bounded probes, no settlement debt/pauses, and continuously backlogged queues, completed DRR rounds allocate the configured quanta up to request-size residuals. Tests must measure unequal costs, not just equal-size call counts. Each continuously eligible class receives a turn per completed class traversal; each such universe receives a turn per completed inner traversal. The `quantum + M` visit cap bounds a borrower's burst. The model traces demonstrate these properties for their recorded workloads; they are not a general mathematical proof for arbitrary arrivals, route topology or estimation error.

An unknown call can occupy the last slot forever. Replenishing a rate window does not ensure a large request will find sufficient simultaneous free capacity among small calls. Permanent overload cannot meet all deadlines. Record and escalate such cases rather than claiming universal no-starvation, wall-clock bounds or useful personalization. A stronger physical-capacity reservation/aging policy requires a separate reviewed design and tests.

## Durable runtime seam (follow-up, not implemented here)

The scheduler owns policy versions, stable ring membership/cursors, open-visit generation and spend, class/universe credit, recognized Attempt charges and idempotent settlement deltas. Discovery is advisory. Future SQL must revalidate candidate readiness, privacy epoch, deadlines, context, policy and cursor generation within the existing admission transaction.

Preserve ADR-0012's order: universe → Job → Step → Attempt/accounting → all shared scheduler/quota/budget rows in a single canonical order. Scheduler rows join that final ordered resource namespace; no shared class lock may be held while waiting to acquire a universe. A short transaction locks the selected universe first, then CAS-checks the observed shared cursor generation. On conflict, roll back and rediscover; it cannot keep a stale selection or debit credit twice. All candidates and mutable policy dependencies must be rechecked after waits.

The runtime follow-up must refactor internal transaction helpers so cursor/visit progression, successful claim/fence, fairness debit, Attempt/Permit and full vector reservations commit atomically. Calling today's separately committed `claimJob` then a second fairness-debit transaction is insufficient. Failed admission must not consume service credit; bounded scan progress can commit separately under a generation check without claiming a Job or granting a permit. Scheduling opportunities and attempts are separate identifiers. Shared serialization is a correctness cost to measure, not an asserted scalability result.

Settlement joins its original retained accounting identity and matching class/universe balances under the same canonical lock order, appending one delta per accepted receipt revision. After privacy clear, retain only minimal policy/class/credit accounting and original random accounting identities needed for liability and idempotency; erase queue/context/read-set payloads. Idle/restarted memberships cannot forgive debt. Scheduled cleanup and lifecycle disclosures remain separate gates. Pending dispatch uncertainty is never recreated as a queued attempt.

Concurrent-worker tests must prove cursor CAS retries, no duplicate quantum, no skipped returner from stale snapshots, all-or-nothing rollback, database restart replay, privacy clear versus late settlement, and old-window rate corrections. Model JSON snapshots do not prove any of these SQL lock/commit behaviors. The existing one-invocation boundary remains the only intended future transport path; no provider loop is part of this slice.

## Alternatives and consequences

- Strict priority loses background service under sustained interactive demand.
- Request round robin rewards larger calls; cheapest-first can indefinitely defer large ones.
- Fixed physical partitions avoid some contention but waste idle capacity and require provider topology and duration evidence unavailable here.
- A full DRF allocator solves a different allocation problem. This bounded scalar-charge DRR model deliberately preserves the hard vector gate and makes narrower claims.
- Per-tick credit grants tied to polling frequency reward extra workers/restarts. Durable visits remove that dependency but add serialized state and replay obligations.

## Sources and verification

The source concepts are [Shreedhar and Varghese, Deficit Round Robin](https://openscholarship.wustl.edu/cse_research/339/) (variable-size work and carried deficit) and [Ghodsi et al., Dominant Resource Fairness](https://www.usenix.org/conference/nsdi11/dominant-resource-fairness-fair-allocation-multiple-resource-types) (normalizing heterogeneous resource shares). The hierarchy, caps, settlement and uncertainty rules here are KnowScroll policy decisions, not results proved by those papers.

Model source, policy parameters, reproducible commands, traces, counterexamples and independent review will be recorded in the linked operations/evidence guide before acceptance. #54 closes on those artifacts, not SQL runtime or a new product journey. Create one named runtime implementation follow-up only after this contract is accepted; keep #7 and the context/proposal/privacy gates open.
