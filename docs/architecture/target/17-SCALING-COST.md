> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: architecture-proposal
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Design only. Token counts are estimates from the context schemas in this folder; dollar rates are dated snapshots from the cited MiniMax pricing page; **provider account quotas are unverified** and remain the binding constraint at production scale. The 1M-user scenario is illustrative arithmetic, not a forecast.
---

# Scaling and cost: dated rates, illustrative scenarios, no false guarantees

The product is for the owner and a few friends. The engine is designed so that cost tracks **what people did**, not how many agents exist or how long the app was open. This document gives the envelope per module, the idle-day floor, the growth path if the product ever needs it, the places where cost is the design, and the dated rates the arithmetic uses. Every number described as a "scenario" or "initial setting" is engineering work, not measured capacity and not a provider entitlement.

The runtime review §20 is the authority for the scaling arithmetic. The [reasoning runtime chapter](21-REASONING-RUNTIME.md) is the authority for what counts as one attempt. The [global execution chapter](22-GLOBAL-EXECUTION.md) is the authority for what admission must check.

## 1. Two currencies and a metered provider port

- **Text and vision model tokens** flow through the MiniMax pay-as-you-go text endpoint and (separately) the cached-input pathway, behind the [reasoning runtime](21-REASONING-RUNTIME.md) port. Initial general-reasoning model is **MiniMax-M3** (documented 1,000,000-token context, native multimodal input and tool use). The community provider in MiniMax’s AI SDK guide currently marks image/file input unsupported. Witness/reconciler use therefore requires an evaluated image-capable adapter to the native endpoint, under the same runtime/admission contract; it is not enabled merely by selecting M3. No live adapter compatibility is claimed here. Embeddings use a separate, versioned port whose model and index are recorded.
- **Video** flows through Cutroom on a separate cost lane under the [content demand and inventory chapter](23-CONTENT-DEMAND-AND-INVENTORY.md). The Quartermaster emits ContentDemand and never a renderer call; Cutroom's supplier steps cross the same metered provider boundary or a conservative capacity partition until the integration is in place.

A subscription or token-plan entitlement is a **different quota system** and must not be mistaken for backend pay-as-you-go capacity. The two have distinct replenish rates and distinct limit shapes; mixing them is how budgets are silently exceeded.

## 2. Dated rates (verified 2026-09-15)

The MiniMax pay-as-you-go page at the date of this document lists M3 standard rates for input lengths up to 512k tokens at:

| Field | Rate (dated 2026-09-15) |
|---|---|
| Input tokens | **$0.30 / M** |
| Output tokens | **$1.20 / M** |
| Cache-read tokens (passive prompt caching) | **$0.06 / M** |

The page lists higher long-context and priority rates that the runtime's router does not select by default. The runtime applies the long-context tier only when the bundle exceeds 512k tokens and the policy explicitly permits it; the priority tier only when the route is explicitly marked `priority`. Other token-plan entitlements, batch discounts, and account-level overrides are distinct and not reflected here.

The runtime review §4.3 establishes that pricing fields are dated and versioned in the ProviderCapabilityProfile. The runtime's budget arithmetic reads the active `tariff_version`; a stale rate is a budget leak the operator console catches.

A call's illustrative dollar cost at the dated rates is:

```
cost_usd = (uncached_input_tokens / 1_000_000) * input_per_million
         + (output_tokens_including_thinking / 1_000_000) * output_per_million
         + (cached_input_tokens / 1_000_000) * cache_read_per_million
// Buckets are disjoint: do not add thinking or cached input twice.
// Normalize each provider's usage semantics before applying this formula.
```

Unknown fields stay null; an Attempt whose usage is unknown is settled as an upper-bound liability, not as zero and not as a guess.

## 3. A high-activity day: explicit input and output assumptions

This is an illustrative **high-activity envelope**, not a typical-user forecast or a prescribed number of calls. Empty wakes use code only. Children, verification and research run only when useful and funded. The input counts below include any vision tokens only after an image-capable adapter has passed its contract tests. Output includes reasoning tokens once. No cache discount is assumed.

| Workload assumption | New input tokens | Output tokens | Text cost/day |
|---|---:|---:|---:|
| Ask: 5 calls at 3k / 0.5k | 15,000 | 2,500 | $0.00750 |
| Steward: 6 meaningful wakes at 6.5k / 0.6k | 39,000 | 3,600 | $0.01602 |
| Night: 6 parent calls at 8k / 0.6k plus 4 optional child calls at 4k / 0.4k | 64,000 | 5,200 | $0.02544 |
| Cartographer: 2 candidate evaluations at 4k / 0.2k | 8,000 | 400 | $0.00288 |
| Brief planning: 3 calls at 3k / 0.8k | 9,000 | 2,400 | $0.00558 |
| Research: aggregate allowance across 3 episodes | 84,000 | 6,000 | $0.03240 |
| Two room episodes: aggregate per room 40k / 5k | 80,000 | 10,000 | $0.03600 |
| Room reflex work: 10 calls at 2k / 0.3k | 20,000 | 3,000 | $0.00960 |
| Four witness checks, conditional on a tested vision adapter | 80,000 | 4,000 | $0.02880 |
| Scribe: 3 calls at 2k / 0.1k | 6,000 | 300 | $0.00216 |
| **Total** | **405,000** | **37,400** | **$0.16638** |

Composer serving requires no model call, but still consumes CPU, database and network resources. Deterministic idle checks and storage also have infrastructure cost. A truly empty day with no due evidence work has **zero model calls**; an idle user with a due commitment or source correction can still incur explicitly admitted work.

## 4. Reading the cost envelope

The high-activity scenario totals **442,400 tokens and $0.16638/day**, or about **$4.99 for 30 such days**, at the dated rates. This excludes video generation, embeddings, external tools, retries, hosting, storage and tax. It is deliberately different from §5’s lighter population scenario of six 8k-token calls per active user/day. Do not scale one using the other’s activity assumptions.

Cache savings require measured hit rates and the route's actual tariff. Unknown spend remains liability; an estimate is not settlement. Existing pool caps remain policy ceilings, while every real attempt contributes its own receipt. The supply planner must price video independently from this text envelope.

## 5. The 1M-user scenario (illustrative arithmetic, not a forecast)

The runtime review §20.1 walks this arithmetic in detail; this chapter restates it with the dated M3 rates and the boundary conditions.

**Scenario assumptions** (illustrative, not measured):

- 10% of registered users active each day.
- Two reasoning jobs per active user per day after coalescing.
- Three reasoning-runtime calls per job (parent + 2 children on average; some parents have 0 children and don't dispatch).
- 7,000 new input tokens per call, 1,000 output tokens per call.
- 20 seconds mean call duration.
- No cache discount, no retries, no video, no embeddings, no tool costs.

Applying the dated M3 rates:

```
cost per call = (7_000 / 1_000_000) * 0.30 + (1_000 / 1_000_000) * 1.20
              ≈ 0.0021 + 0.0012
              ≈ $0.0033 / call
```

| Registered users | DAU | Calls/day | Mean calls/minute | Illustrative text cost/day |
|---:|---:|---:|---:|---:|
| 100 | 10 | 60 | 0.042 | $0.20 |
| 500 | 50 | 300 | 0.208 | $0.99 |
| 1,000 | 100 | 600 | 0.417 | $1.98 |
| 10,000 | 1,000 | 6,000 | 4.17 | $19.80 |
| 100,000 | 10,000 | 60,000 | 41.67 | $198.00 |
| 1,000,000 | 100,000 | 600,000 | 416.67 | **$1,980.00** |

At the million-user row, mean demand is approximately **3.33 million tokens per minute** and **139 concurrent calls** at 20 seconds each. At 70% planned utilisation, provision roughly **596 RPM, 4.76 million TPM, and 199 concurrency** before additional peak allowance. The MiniMax M3 page lists a published 200 RPM table for M3 with 10,000,000 combined TPM; the **RPM ceiling binds even though the TPM number looks generous**. Actual account concurrency is unverified at the date of this document.

With 200 RPM and 70% planned utilisation, the request-rate-only envelope under these assumptions is `200 × 0.7 × 1440 / 6 ≈ 33,600 active users per day`. Other limits may reduce it. Coalescing, fewer calls per job, cache use, additional evaluated routes, or negotiated capacity change the result. More worker processes do not.

This arithmetic is **planning arithmetic, not a service guarantee**. The runtime review §8.4 establishes the capacity formula:

```
sustainable_calls_per_minute ≈
  min( RPM,
       input_TPM / mean_input_tokens,
       output_TPM / mean_output_tokens,
       combined_TPM / mean_total_tokens,
       concurrency × 60 / mean_duration_seconds )
```

The illustrative scenario above uses only the RPM dimension (200) and the concurrency dimension (139 at 20 s); the input/output TPM numbers (10M combined) are not the binding dimension under the assumptions. A change in mean input or output tokens, or a change in call duration, can move the binding dimension to TPM. The operator console must surface the binding dimension by attempt, not by assumption.

## 6. Where cost is the design

| Mechanism | Cost effect |
|---|---|
| No model call in the swipe path | No model inference cost in serving; infrastructure and delivery cost remain |
| Deterministic idle check before any reasoning-runtime call | An inactive universe costs a heartbeat a day, not a model call |
| Digest-threshold wakes and backoff | An idle universe is silent |
| Deterministic pre-modules before any resident step | Most resident wakes cost nothing |
| Attention-funded rooms | Rooms nobody returns to stop spending |
| Retrieve before generate; ContentDemand-tied briefs | Generation only for demand or forecast shortage |
| Session pool per session | A fast swiper cannot spend the day's cap |
| Shared content inventory with per-user EncounterBindings | A generation that satisfies one user may satisfy three; the supplier cost is charged once |
| Empty-digest short circuit for the night | Quiet nights make no model calls; scheduler/storage overhead remains |
| Subagent children inherit parent budget; bounded child count | One Investigation does not become ten unbudgeted jobs |
| Freeze-and-retain on dirty scopes; coalesced reasons | Repeated signals do not become repeated model calls |

These mechanisms are not knobs. They are the architectural invariant: cost tracks work, not population or wall-clock time.

## 7. The 1M-user scenario is not a deployment target

The deployment plan is recorded in [18-IMPLEMENTATION-PHASES.md](18-IMPLEMENTATION-PHASES.md) and the runtime review §19. The phases are:

| Phase | Users | Database | Scheduler |
|---|---|---|---|
| Recorded owner-and-friends | 5 | SQLite/WAL with short serialized write transactions | One worker process; one scheduler loop |
| Hosted multi-host (proposed future decision) | small thousands to low tens of thousands | Managed PostgreSQL with `FOR UPDATE SKIP LOCKED` patterns | One admission service; many workers |
| Beyond | partitioned shards | per-universe outbox/inbox | distributed admission with leader election |

The 1M-user scenario is a **planning stress case** the architecture must be able to plan for without redesign, not a target. The runtime review §20 establishes this posture; this chapter restates it because cost conversations drift toward the largest plausible number otherwise.

## 8. Concurrency on one machine (v0.1)

- SQLite/WAL permits one write transaction at a time. The domain reducer and operational runtime/admission writers serialize short transactions; performance must be measured with the actual indexes and payloads. Reads can overlap.
- The dispatcher's concurrency cap is **4** running Jobs at a time across reasoning-runtime call attempts, with additional slots available for short deterministic work. A Job waiting on a child or a timer releases its slot immediately. A Job holding a Permit and a sleep loop is a drift violation.
- The runtime's [admission gate](22-GLOBAL-EXECUTION.md) governs the actual concurrency against provider limits; the dispatcher's cap is a process-local cap on top of it. A worker pool can grow only as far as the provider quota allows.
- The harness's scheduler is inside the same worker process for v0.1 ([03-ARCHITECTURE.md](03-ARCHITECTURE.md) §1); its priority classes favor direct requests while preserving nonzero service floors for background work.
- The Steward's night session and the rooms' episodes are Jobs; four of them may run concurrently; a fifth waits. Night duration depends on workload and provider latency; no completion time is established.

## 9. What grows and what does not

| Grows with | Store | Bound |
|---|---|---|
| events | Ledger | append-only; archive by `seq` range after 12 months |
| concepts met | Accounts | ~3k rows per heavy user per year |
| places | Chart | ~50 per user |
| encounters | Inventory | ~2k per user per year; media bytes in object storage |
| rooms and residents | Rooms | ≤ 12 active rooms × 5 residents; journals a few MB each |
| Investigations | investigation table | bounded by Steward/room open-investigation caps (≤ 12 per universe) |
| Job spine | job, attempt, step, proposal, receipt | bounded by activity; archivable by Job status |
| Steward journal | journal file | a few MB per year; projection keeps context bounded |

Optional inference is driven by evidence or due tasks. Operational timestamps, retention and timer checks still advance with time and must be bounded.

## 10. The growth path, if it were ever needed

The design was chosen so that scaling is a deployment change, not a redesign:

1. **Split the worker by subscription.** Each module already runs off the Ledger with a cursor; run rooms in one process and the Steward in another by moving subscription rows.
2. **Partition by `user_id`.** The Ledger, Accounts, Chart, Rooms, and Steward memory are per user; only the Substrate and the shared inventory are global. A per-user SQLite file, or a Postgres partition, is the natural shard (D-001 already plans the Postgres reassessment at Phase 3).
3. **Move to managed PostgreSQL at the hosted multi-host boundary.** Atomic `FOR UPDATE SKIP LOCKED` claims replace the SQLite lease semantics; the dirty-scope freeze-and-retain rule is preserved; the runtime, the admission gate and the receipts store move unchanged.
4. **Split the admission service** from the workers when contention on the shared reservations table becomes measured. One admission service writes `permit` and `budget_reservation` rows; many workers read them and dispatch.
5. **Partitioned admission with leader election** when one admission service becomes the bottleneck. Slices are checked out conservatively against the parent allowance; reclaiming an expired slice does not refill the bucket to full.
6. **Replace the dispatcher with a stream** (a log with consumer groups) when there are more processes than a `tail` can serve; the envelope and cursors do not change.
7. **Move the harness out of process** with the Cutroom host adapter contract unchanged.

None of this is planned for v0.1. It is listed so that nobody adds a queue, a broker, or a fleet "for scale" before five people have used the engine.

## 11. Provider-account uncertainty

The runtime review §4 establishes what the dated documentation verifies and what remains unknown. The unverified items that matter most to scaling arithmetic:

| Field | Status |
|---|---|
| Account-level RPM (vs published M3 default) | unverified |
| Account-level concurrency | unverified |
| Burstable vs steady-state behaviour | unverified |
| Remote-cancel guarantee | unverified |
| Per-account cache hit rate without explicit cache control | unverified |

Each unverified item is a single capability field on the ProviderCapabilityProfile with `evidence_status: unknown`. The operator console must surface them next to the binding dimension. A scale plan that assumes a published figure is verified is wrong; a scale plan that assumes it is zero is over-conservative. The runtime's policy is neither.

## 12. What this chapter does not promise

- **A specific dollar cost at any user count.** Numbers above are illustrative arithmetic with dated rates and unverified quotas. The actual cost depends on account capacity, call patterns, cache behaviour, repair rates and the route mix.
- **A specific latency at any user count.** Latency targets are engineering bands, not SLA promises ([01-OVERVIEW.md](01-OVERVIEW.md), [10-CORE-AGENT.md](10-CORE-AGENT.md)). p95 serving targets assume warm caches and small local workload; cold serving and large multi-host deployments move them.
- **That a cheaper model is always appropriate.** A cheaper route is a route change subject to quality and permission rules ([22-GLOBAL-EXECUTION.md](22-GLOBAL-EXECUTION.md) §5.4, [12-PERSISTENT-AGENTS.md](12-PERSISTENT-AGENTS.md) §13). Evidence thresholds do not move to fit a budget; the budget moves to fit the evidence.
- **That the 1M-user scenario is reachable at the dated rates.** It is planning arithmetic. Reaching it requires negotiated capacity, evaluated route additions, observed cache behaviour and operational evidence the runtime does not yet have.
- **Zero infrastructure cost for inactivity.** Empty wakes skip model calls, while storage, monitoring and bounded timer checks still consume resources.
