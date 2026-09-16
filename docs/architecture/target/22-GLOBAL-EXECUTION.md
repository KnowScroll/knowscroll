> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: architecture-proposal
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Design only. Policy numbers are illustrative and dated; they are proposals, not measured capacity. Quota dimensions are explained in the runtime review §8 and may need to be tightened or expanded after replay.
---

# Global execution: one scheduler, one admission gate, every expensive attempt

This chapter is the boundary that wraps every expensive attempt the system makes. It defines the scheduler's classes and shares, the admission vector that guards every Attempt, the lease and fencing tokens that workers and replacements negotiate, the way dirt and coalescing work, and the observability surface the operator needs to see why work ran, what it cost, and what it changed. It does not define the runtime step journal (see [21-REASONING-RUNTIME.md](21-REASONING-RUNTIME.md)) or the content demand path (see [23-CONTENT-DEMAND-AND-INVENTORY.md](23-CONTENT-DEMAND-AND-INVENTORY.md)).

The companion [runtime review](../../research/2026-09-15-RUNTIME-AND-GLOBAL-EXECUTION-REVIEW.md) §§6–9, §11 and §17 are the authority for the contracts this chapter depends on; this chapter deepens them into the shape the worker's job loop, the admission service and the receipts store actually use.

## 1. What the global plane owns

The runtime, the agents, the runtime's own step journal and the world reducer all run inside the worker. The global plane is the layer above them: one scheduler, one admission gate, one receipt store. It does not know the meaning of a BridgeCandidate, the rules of a hypothesis, or the score of a recommendation. It owns four things and only four things:

| Owns | Does not own |
|---|---|
| Admitting, scheduling and dispatching durable Jobs | Interpreting their outputs or applying their proposals |
| Reserving the vector of resources every Attempt needs | Knowing what the Attempt intends to do |
| Tracking high-water marks, dirty reasons and coalescing state for any signal that says "look again" | Knowing what the signal means |
| Producing the causal and cost receipts that link work to outcome | Knowing whether the outcome was correct |

The runtime review §6 establishes this separation. The point of the separation is that every expensive action in the system crosses the same gate, so the same fairness, quota, observability and recovery machinery governs every such action. A new model call type, a new repair, a new compaction or a new subagent all become new rows in the same tables; they do not become new schedulers.

## 2. What the global plane is not

Three things it is deliberately not:

1. **Not a stateful multi-agent orchestrator.** Multiple agents are different Job kinds with the same admission and the same receipts. There is one scheduler, not one per agent.
2. **Not a provider of durable workflow execution.** Workflow execution is the runtime's job; the global plane only schedules and admits it. Recovery, step journaling and effect-specific reconciliation live in [21-REASONING-RUNTIME.md](21-REASONING-RUNTIME.md) and the worker, not in the global plane.
3. **Not a broker, queue, or distributed log.** A broker is a possible substrate for partitioned scale, not a default. For the recorded single-host phase the durable queue is the database's job table; for the hosted multi-host phase a transactional shared reservation table is the proposed boundary. Redis, Kafka, K8s and Temporal are deliberately not adopted at this scale.

The only infrastructure the global plane presumes is a database with atomic transactions and compare-and-set on the job and admission tables.

## 3. A simple worked example

A Steward investigation on a universe wakes from a structure-evaluation subscription. The global plane does the following:

1. The wake coalesces with a backlogged resident's research-completed wake and a frontier family marker; the dirty reasons union keeps all three.
2. The Steward Job is created with kind `investigation_parent`, scope `{kind: 'universe', id: u17}`, class `accumulated_interpretation`, budget owner `u17`, parent credit quantum and a privacy epoch.
3. The scheduler picks a class share weighted by the universe's `interactive+active_continuity` weight, dispatches when the credit quantum admits the job, and the Steward begins compiling its bundle.
4. When separate evidence tasks warrant it, the Steward spawns bounded focused children under the same budget. Each child reserves its own Attempt permits through the admission gate; the parent's worker slot is released while children run, the parent is reactivated when all three settle.
5. Children produce typed proposals or refusals; the parent synthesises a BridgeCandidate; the reducer validates it; the Composer's candidate cache receives an admitted BridgeCandidate; the deterministic Composer decides whether to use it.

What did **not** happen: a child waited forever because the parent occupied a worker slot; the parent doubled its own budget by spawning children; the model bypassed admission because it was "in the same loop"; an attempt's outcome was invented from a stale cache.

## 4. Scheduling classes

### 4.1 Why classes exist

A scheduler that admits work without distinguishing interactive from background will either starve interactive work (because background is cheaper and always wins) or starve background work (because interactive is always re-queued first). The runtime review §7.2 names four classes; this chapter adds the share and borrowing rules that make them operational.

| Class | Examples | Service intent | Default share (illustrative) |
|---|---|---|---|
| `interactive` | Explicit Ask, direct resident question, requested explanation, branch request resolved by reasoning | Dispatch promptly when capacity exists; return `pending` when it does not | 25% of admit budget |
| `active_continuity` | Resolve an explicit branch gap, update an investigation during an active session | Seconds to a few minutes, with inventory fallback | 30% |
| `accumulated_interpretation` | Analyse meaningful recent episodes, revise bridge candidates, summarise a place | Minutes to an hour | 20% |
| `background_inquiry` | Dormant interests, public enrichment, optional room research | Hours, or until a stated deadline | 15% |
| `housekeeping` | Coalesced night sessions, decay sweeps, replay diffs, index rebuilds | Bounded by a daily cap | 10% |

The percentages are illustrative. What matters is that classes have explicit capacity shares and borrowing rules, and that the per-user scheduler within a class uses a weighted deficit round robin that charges the estimated cost of an Attempt, not its request count.

### 4.2 Per-user weighted credit within a class

Within a class, each universe has a credit balance that is replenished by a small per-tick quantum and spent on the estimated cost of admitted Attempts. The cost estimate uses the dominant share of the constrained token/request capacity, charged forward with a bounded estimator error. A universe that idles does not accumulate unlimited credit; idle credits decay to a cap.

The scheduler admits an Attempt when:

1. The universe's credit balance is sufficient to cover the estimated cost.
2. The class has free share at the moment of admission.
3. Its class retains a nonzero service floor; higher-priority arrivals do not veto that floor indefinitely.
4. The route's permit is reservable at the moment of dispatch (see §5).

Admitted Attempt deducts the estimated cost. On completion, actual usage is settled and the difference refunded or charged. A bounded estimator error that consistently over-estimates is a calibration problem; a consistent under-estimate is a budget leak. Both are visible in the operator console.

### 4.3 Borrowing and starvation

A class may borrow idle share from another class up to a hard ceiling, never to exceed the total capacity. Idle shares may be borrowed by eligible classes, but the next admission restores a backlogged class's floor; already-running calls are not preempted. Aging improves service within a class and a bounded credit cap must admit the largest allowed request or route it to an explicit large-work lane. A class that is starved for longer than its `starvation_grace` is escalated to the operator console and rebalanced; a class that has permanent excess demand is recorded as `capacity_saturation` and the relevant queue reports its age and deadline miss rate.

Crucially: a universe that offers too much work does not get to consume everyone else's reserved service. Idle capacity is borrowable, not transferable; a very active user can finish their queue sooner but cannot starve a quiet user out of the floor.

### 4.4 No impossible-capacity starve

A request that can never fit any eligible route's per-request or bucket limits must not wait forever for impossible capacity. The scheduler rejects or reshapes such a request on admission with a recorded reason; the universe's intent record stays, the Attempt is not created, and the operator console records `request_too_large_for_any_route` with the relevant dimensions.

## 5. Admission: the vector every Attempt must check

### 5.1 The vector

For every Attempt, the admission gate checks every applicable dimension and reserves each one atomically. A reservation that conflicts with an active reservation fails the gate and the Attempt is not dispatched. The dimensions are:

```
global_spend       ∩   budget_owner   ∩   provider_account
∩   endpoint_or_model_quota
∩   request_rate        (RPM)
∩   input_token_rate    (TPM_in)
∩   output_token_rate   (TPM_out)
∩   combined_token_rate (TPM_in+out)
∩   in_flight_concurrency
∩   job_or_generation_budget
```

Output reservation uses a bounded requested output ceiling, including reasoning where billed; it cannot reserve a guessed future exact token count. Input estimates need conservative margin or a supported count endpoint. Quota windows and dispatch-permit expiry are distinct: an expired worker lease cannot release possibly-live remote concurrency or unknown monetary liability. If the provider has no proven completion bound, retain conservative uncertainty and reduce admission rather than promise a hard remote concurrency bound.

The `endpoint_or_model_quota` is the route's most specific applicable quota; some providers count input and output separately, others publish a combined token limit, and KnowScroll stores the actual topology rather than imposing a universal interpretation. Different API keys may share an account quota, and key rotation does not create extra capacity.

### 5.2 The atomic reservation

Reservation proceeds in one transaction:

```sql
BEGIN IMMEDIATE;
  -- 1. Lock the job row.
  UPDATE job
     SET lease_owner = ?, lease_token = lease_token + 1, lease_deadline = ?
   WHERE job_id = ? AND status IN ('queued', 'leased')
     AND (lease_owner IS NULL OR lease_deadline < ?);

  -- Require affected-row count = 1; otherwise ROLLBACK.
  -- Step intent already exists. Enforce available balances / limits with
  -- conditional updates in this transaction; inserts alone do not enforce caps.
  -- 2. Insert the attempt with permit id, fencing token, and routing.
  INSERT INTO attempt (attempt_id, job_id, step_id, route_id, permit_id, status, deadline)
  VALUES (?, ?, ?, ?, ?, 'reserved', ?);

  -- 3. Insert budget reservations against every applicable account.
  INSERT INTO budget_reservation (...) VALUES (...);

  -- 4. Insert quota reservations against every applicable bucket.
  INSERT INTO quota_reservation (...) VALUES (...);
COMMIT;
```

A reservation that fails any step aborts and the Attempt is not created. No partial reservation is possible. The runtime's dispatch step reads the Attempt and its reservations; if any are missing or inconsistent, the dispatch aborts and the Attempt is reconciled.

### 5.3 Settling and reconciling

When the provider returns, the runtime journals actual usage and the admission gate settles:

| Outcome | What happens |
|---|---|
| Valid terminal response, usage reported | Settle the Attempt with actual usage; release unused monetary liability; reconcile quota by the provider's window rules; charge actual cost to budget |
| Valid terminal response, usage unknown | Mark usage fields as `unknown`; record an upper-bound liability; do not refund until usage is reported |
| Provider 4xx with documented retry advice | Honour the advice; settle the Attempt; the retry is a new Attempt with its own permit |
| Provider 5xx overload | Mark retryable; reschedule with capped exponential backoff and jitter |
| Provider 4xx invalid credentials / unsupported | Pause the route, surface a configuration error, do not loop every user's job through it |
| Provider refusal of prompt content | Record the refusal; the job may be reformulated under policy; never silently switch to a less safe route |
| Provider ack lost / timeout | Mark `Unknown`; bounded reconciliation window; controlled retry under effect-specific policy |

A token-window consumption does not refund immediately. Each quota adapter defines reconciliation semantics; budget reservation refunds are not the same as rate-limit replenishment. The runtime review §8.2 establishes this distinction; this chapter enforces it.

### 5.4 Unknown is a state, not a wait

The admission gate has an explicit `unknown` state for Attempt usage. It does not collapse to `success` on hope, and it does not collapse to `failure` on impatience. An Attempt whose provider usage is unknown carries an upper-bound liability in the budget ledger, is exposed in the operator console with a deadline, and is reconciled by evidence about that original invocation. Success of a later retry does not resolve the original cost or effect. Unknown usage is bounded; unrecorded usage is a leak.

## 6. Leases, fencing and worker ownership

### 6.1 Lease and fencing

Every Job has at most one active lease. The lease is a persisted time-bounded claim, acquired in a short transaction. No database lock is held throughout model execution. A lease carries:

| Field | Purpose |
|---|---|
| `lease_owner` | The worker identity that holds the lease |
| `lease_token` | A monotonically increasing fencing token, incremented by the guarded claim update |
| `lease_deadline` | When the lease expires if not renewed |
| `lease_renewals` | The number of renewals taken in this lease |

A worker that holds the current token can write the next checkpoint and dispatch the next Attempt. A worker whose token does not match cannot commit a checkpoint or obtain a new dispatch authorization. The transport checks the live authorization immediately before send; a pause between check and remote send still leaves an external ambiguity window unless the provider itself honors fencing/idempotency. This is the operational meaning of "stable scoped readsets/privacyepoch/OCC rejectstale".

### 6.2 Lease expiry and provider ambiguity

A lease can expire while a remote call is still in flight. The expiry permits another worker to recover the Job, but it does not prove the remote call has stopped. The replacement worker:

1. Sees the in-flight Attempt under `Sent`.
2. Does not dispatch a fresh Attempt; the existing one is the live call.
3. May extend the lease once a reconciliation probe returns or a documented outcome arrives.
4. Records `Unknown` if the deadline elapses with no provider response.

A late result arriving for an `Unknown` Attempt is journaled with its `request_id`; the runtime treats it as the canonical outcome, settles the Attempt with actual usage, and credits the boundary that produced the response. If the response is the original success, the worker that took the lease writes `Completed`. If the response is a refusal or error, the worker writes `Failed`. Duplicate spend on a reconciled retry is visible in the receipt store, never hidden.

### 6.3 Privacy epoch fence

The runtime review §11 names the privacy epoch fence. The global plane enforces it on every step boundary: an Attempt whose recorded epoch is older than the universe's current epoch is rejected at its next step. The worker cannot dispatch new private work and the proposal pipeline cannot apply. A restricted receipt sink still records late usage and minimal reconciliation metadata; it does not restore revoked private output. The reconciliation path for an in-flight Attempt whose epoch changes is to journal `Withdrawn` and settle the Attempt's reservation as best it can without applying its proposals.

## 7. Coalescing and the dirty high-water mark

### 7.1 The two signals

The global plane distinguishes two kinds of arrival:

1. **Direct intents.** A branch request, a correction, an explicit message, a privacy reset, a budget change. These never collapse. Each is its own intent record; its own job, in its own attempt, with its own outcome. Sharing retrieval work is allowed; collapsing the intents themselves is not.
2. **"Something changed" signals.** Account updates, world deltas, substrate revisions, readiness changes. These coalesce. The relevant scope stores:

```ts
type DirtyScope = {
  scope: { kind: 'universe' | 'room' | 'public'; id: string };
  job_family: string;
  first_dirty_at: string;
  latest_event_seq: number;
  processed_event_seq: number;     // last successfully processed high-water mark
  reasons: string[];               // union, never overwritten
  pending_job_id: string | null;
  high_water_at_run: number | null;
  high_water_at_complete: number | null;
};
```

### 7.2 The freeze-and-retain rule

When a job is admitted and starts running against a dirty scope, it snapshots `latest_event_seq` as input high-water mark `H`; `processed_event_seq` stays at the previous completed value until the run commits. The job reads through `H`. If new events arrive that push `latest_event_seq` to `H2`, the in-flight job does not see them; its completion marks only the work through `H` as processed.

In the same completion transaction, the global plane detects `H2 > H`, preserves the dirty scope with `latest_event_seq = H2`, and either schedules a continuation job or keeps the dirty marker armed for the next coalescing run. The boolean dirty flag is **never** cleared unconditionally; that loses new work. It is cleared only when `processed_event_seq` reaches `latest_event_seq` for that the scope.

A `H2 > H` arrival also writes a coalescing reason into `reasons` so the operator console can see why a continuation was needed. A direct intent arrival does not touch `reasons`; it is its own job.

### 7.3 Coalescing windows and trailing debounces

Coalescing has a debounce so that ten rapid signals become one wake, not ten. The default debounce is ninety seconds; a hot active session may set a tighter debounce, a quiet universe a looser one. A trailing debounce that never fires would starve a continuously active person of interpretation; the rule is that the debounce is bounded by a maximum wait whose default is five minutes during activity and longer when the universe is quiet.

An explicit intent bypasses the debounce entirely. A pending continuation job can be superseded by a newer one only if it targets the same scope and the same job family; otherwise both run. Supersession records the lineage.

### 7.4 The no-op dispatch

A job may be admitted whose only purpose is to discover that nothing meaningful has changed. The global plane's deterministic idle check (§8) lets that job return `no_new_evidence` without dispatching a model call. Only work through the frozen H is marked processed; H2 arrivals remain dirty. No external Attempt or provider permit is created. This is how a Steward wake that finds nothing does not become a model call by habit.

## 8. Deterministic idle checks

A Job that wakes on a dirty signal does not always need a model call. Before reserving a provider permit, the runtime asks the deterministic idle check whether anything material has changed since the last successful attempt:

| Check | Question | Material change |
|---|---|---|
| `dirty_scope_empty` | Are there new events between `processed_event_seq` and the current `latest_event_seq` for the scope? | No |
| `evidence_unchanged` | Has any cited source been corrected or withdrawn? | No |
| `hypothesis_unchanged` | Has any competing hypothesis gained a new accepted evidence ref? | No |
| `inventory_unchanged` | For an inventory-driven plan, has any referenced asset changed revision? | No |
| `budget_unchanged` | Has the budget owner crossed an allocation threshold? | No |
| `route_unchanged` | Has the route's `evidence_status` or pricing changed? | No |
| `privacy_epoch_unchanged` | Has any relevant authorization epoch changed? | No |

If all seven answer "No", the runtime journals a deterministic `no_new_evidence` step and completes the Job through H. No external attempt was reserved; arrivals beyond H remain pending. The operator console records the no-op as a deliberate choice, so cost analysis does not misread the scheduler as broken.

The runtime review §9.1 names "skip no-new-evidence model calls" as a discipline. This chapter makes it a contract.

## 9. The dispatch permit and budget reservation

### 9.1 The permit

A `Permit` is the durable record that an Attempt has reserved its share of every applicable resource. The permit is one aggregate row per admitted Attempt; its child quota reservations cover the applicable dimensions:

```ts
interface Permit {
  permit_id: string;
  attempt_id: string;
  job_id: string;
  budget_owner: string;            // the account that absorbs the cost
  dimensions: Array<{
    kind: 'rpm' | 'tpm_in' | 'tpm_out' | 'tpm_combined' | 'concurrency';
    reserved: number;
    scope: string;                 // the bucket id
    window_kind: 'minute' | 'day' | 'month' | 'job';
    window_started_at: string;
  }>;
  reserved_at: string;
  reserved_until: string;
  settled_at: string | null;
  actual_usage: Record<string, number> | null;   // unknown fields stay null
};
```

Money lives on `BudgetReservation`, not a second USD balance inside `Permit`. The permit aggregates resource/quota reservations; idempotent monetary settlement updates the budget ledger, while quota consumption follows route-specific window rules. Reconciliation can append adjustment entries keyed uniquely to the original attempt without charging the same settlement twice.

### 9.2 The BudgetReservation

A `BudgetReservation` is the durable record that an Account has set aside the cost estimate for an Attempt. It is independent of the rate-limit permit; refunding the BudgetReservation does not necessarily replenish a token window, and vice versa.

```ts
interface BudgetReservation {
  reservation_id: string;
  attempt_id: string;
  account_id: string;              // user | room | investigation | system | experiment
  estimate_microusd: number;        // integer micro-USD
  reserved_at: string;
  expires_at: string;
  settled_at: string | null;
  actual_microusd: number | null;       // unknown stays null
  refund_microusd: number | null;       // computed on settlement
  reason: 'attempt' | 'verification' | 'repair' | 'compaction' | 'subagent';
};
```

### 9.3 The settled attempt

When the provider returns and usage is known, the runtime writes the Attempt's settled state:

```ts
interface AttemptSettlement {
  attempt_id: string;
  status: 'completed' | 'refused' | 'truncated' | 'failed' | 'unknown' | 'cancelled' | 'superseded';
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    thinking_tokens: number | null;
    cached_input_tokens: number | null;
    image_units: number | null;
    audio_units: number | null;
    video_units: number | null;
  };
  cost_usd: number | null;
  settlement_key: string;          // unique, idempotent
  receipt_ref: string;
};
```

A duplicate charge is rejected by unique attempt/settlement identity. Subsequent reconciliation is an append-only adjustment referencing that original settlement, with its own idempotent key; it cannot silently charge the full attempt a second time. This is one of the operational reasons the Attempt is a separate durable entity.

## 10. Retries, repairs, compactions, verifications and subagents

The runtime review §5 and the [reasoning runtime chapter](21-REASONING-RUNTIME.md) §9 describe these as "the same boundary, not a new gate". The global plane enforces this:

| Sub-step | Records written | Reservations | Settlement |
|---|---|---|---|
| `retry` | New Attempt under the same Step and Job with a new permit | Fresh permits, never reusing the prior Attempt's permits | Settles against actual usage, keeps the prior Attempt's independently settled usage or unknown liability |
| `repair` | New repair Step under the same Job with its own Attempt | Fresh permits; repair budget drawn from the same Job's reservation | Settles against actual usage; bounded number per Job (default one or two) |
| `compaction` | New compaction Step with its own Attempt; bundle hash recorded | Fresh permits under the same budget | Settles against actual usage; not refundable as a free side effect |
| `verification` | New verification Step with its own Attempt; references the primary's bundle hash | Fresh permits; verification budget separate and bounded | Settles against actual usage; verdict recorded against the primary Proposal, not the world |
| `subagent` | New Job, parent link in the parent Job; the appropriate inherited service class; budget owner inherited | Fresh permits against the parent's budget reservation | Settles against actual usage; charged to the parent's account |

A retry that uses the prior Attempt's permit is double-spending. A repair that runs unbounded is runaway cost. A compaction that bypasses admission is a leak. A verification that uses the same prompt and the same sources is not new evidence. A subagent that opens its own budget owner is an account-creation bug.

The global plane makes each of these a record type the operator console can audit by class and parent job.

## 11. Observability

### 11.1 Receipts that span the system

The receipts the global plane produces are the durable spine of every operator question. They are not a separate analytics layer; they are the records the work itself wrote.

```ts
type Receipt = {
  receipt_id: string;
  scope: { kind: 'universe' | 'room' | 'public'; id: string };
  cause_event_ids: string[];
  trigger: { kind: 'event' | 'timer' | 'human' | 'child'; ref: string };
  job_id: string;
  attempt_id: string;
  route_id: string;
  permit_id: string;
  budget_reservation_id: string;
  policy_version: string;
  bundle_id: string;
  bundle_content_hash: string;
  event_high_water: number;
  result: 'completed' | 'refused' | 'truncated' | 'failed' | 'unknown' | 'cancelled';
  proposal_id: string | null;
  proposal_disposition: 'applied' | 'rejected' | 'superseded' | 'withdrawn' | 'pending' | null;
  usage: AttemptSettlement['usage'];
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
  operator_notes: string;
};
```

A multi-day investigation does not require one open tracing span. Each execution/attempt has its own receipt with a stable cause chain back to the investigation that triggered it.

### 11.2 The dashboards

The operator console exposes, at minimum:

| Dashboard | What it answers |
|---|---|
| Queue age and estimated token work by class | Is anything starving? Where? |
| First-attempt delay versus retry delay | Are retries masking a deeper problem? |
| Deadline misses by class and account | Where is the scheduler under-capacity? |
| Per-user service distribution and quota denials | Is the fairness policy doing its job? |
| Provider RPM/TPM/concurrency utilisation and throttling | Where are we against the published limits? |
| Provider latency tails, unknown outcomes, retry spend | Where is the integration leaking? |
| Coalescing ratio, context size, cache hit rate | Are we doing the cheap thing often enough? |
| Stale / rejected proposal rate | Is the validator working? |
| Evidence failures | Are bundles pointing at stale material? |
| Demand satisfaction, generation reuse, unused assets | Is the supply side well aimed? |
| Bridge usefulness (where measurable), correction rates | Is the semantic layer actually helping? |

The dashboard IDs are deliberately schema-versioned; the runtime review §18 establishes the discipline and the [feedback loops chapter](16-FEEDBACK-LOOPS.md) names the loop each monitor damps.

### 11.3 Admin watch analysis

The runtime review §18.2 authorises admin analysis of the Ledger, the selection receipts, and the recommendation/encounter outcomes. It explicitly does not authorise:

- using watch-time as a positive optimiser signal,
- treating a model's self-reported confidence as a calibrated probability,
- using aggregated satisfaction as a proxy for learning,
- using the engine's own outputs as substrate sources,
- using consensus among agents as evidence of truth.

The receipts store retains the data that supports watch-hours measurement (eligible visible playback intervals, pause/background handling, replay treatment) without using those measurements as the product objective. A later recommendation policy that wants to use a watch-derived feature must cite that feature's permitted use in a new decision.

### 11.4 Scale-aware metric labels

At million-user scale, user IDs do not appear in unbounded metric labels. Scope IDs live in restricted receipts and traces; metrics aggregate by bounded dimensions. Raw context bodies and personal content have deliberate retention and deletion rules; diagnostic access does not create a second private Ledger outside the privacy system.

## 12. Boundaries the drift rule should enforce

The runtime review §3.6 names the boundaries. Proposed import/lint checks catch structural violations. Runtime assertions and fault tests must prove dispatch, scope, and accounting behavior; static analysis alone cannot.

| Rule | What the build fails on |
|---|---|
| No provider SDK outside `apps/worker` | An import of a vendor SDK in `apps/api`, `apps/web`, or any package other than `@knowscroll/providers` |
| No provider SDK inside the runtime port itself | An import of a vendor SDK outside `@knowscroll/providers` and the runtime's own adapters |
| One declared writer per table family | A `Job`, `Attempt`, `Permit`, or `BudgetReservation` mutation outside the runtime or admission gate |
| No model call without a Permit | A `ModelRoute.invokeOnce` call where `permit` is `null` or stale |
| No manual retry outside the runtime | A `setTimeout`-driven retry loop or a sleep-while-holding-permit anywhere in the codebase |
| No bundled provider state in proposals | A `Proposal` whose `payload` field contains opaque provider continuation data |
| No model confidence used as authority | A code path that promotes a `confidence` field to a permission, an authority or a calibrated correctness signal |
| No raw user text in a metric label | A telemetry call whose label field contains user content |

These are the operational form of the architectural invariant. The runtime review's §1.3 statement is that a universe owns its durable meaning; the drift rule is how that statement becomes a build-time check.

## 13. What changes if the deployment target is hosted multi-host

The runtime review §19.1 proposes a future boundary at hosted multi-host deployment:

| Stage | Database | Scheduler | Rationale |
|---|---|---|---|
| Recorded owner-and-friends | SQLite/WAL with short serialized write transactions | One worker process; one scheduler loop | D-001, D-002 unchanged |
| Hosted multi-host (proposed decision) | Managed PostgreSQL with `FOR UPDATE SKIP LOCKED` patterns | One admission service; many workers | Required by write contention, host availability and replication, not user count alone |
| Beyond | Partitioned shards; per-universe outbox/inbox; distributed admission with leader election | Multiple dispatchers with shared atomic reservations | Measured requirements drive this |

The transition is a deployment change, not a redesign. The job, attempt, permit, budget reservation and bundle tables stay the same shape; the only difference is that the database engine supports a richer lock primitive and the scheduler can run as multiple processes against a single shared reservation store. The runtime, the agents and the world contracts do not change.

## 14. Open contracts the global plane does not promise

These are the things the global plane deliberately does not promise, so the operational expectations match the architecture:

- **Exactly-once model calls.** Leases and fencing tokens do not eliminate provider ambiguity; they bound it. The `unknown` state is the contract.
- **Fairness from ordering alone.** A scheduler's admit order is a policy, not a guarantee. Per-class shares and per-user credit balances are what guarantee non-starvation within a saturated system; without capacity, no algorithm can guarantee all deadlines.
- **Calibrated provider capability.** Routes carry explicit `evidence_status`; a documented capability has not been exercised in this codebase; a tested capability has a contract test with a date. The runtime treats unknown capabilities as not available.
- **Cheaper-than-published model use.** Provider pricing changes; budget arithmetic uses the dated tariff. A "0.30/M input, 1.20/M output" price is dated; the runtime reads the active tariff version.
- **Cooperative eviction under outage.** A provider outage stops new dispatches; the system does not pretend it is healthy. Recovery uses hysteresis, not immediate return-to-normal.

These are the limits that let the runtime and the agents make honest decisions under load.
