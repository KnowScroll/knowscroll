> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: architecture-proposal
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Reviewable design, not implemented or measured behavior. Code is illustrative pseudocode.
---

# Worked traces: fourteen journeys through the engine

The original T1–T9 experiences remain. T10–T14 exercise the semantic and execution layer. Event families follow [04](04-EVENT-ARCHITECTURE.md); record names are proposed logical contracts, and timings/costs are not measured. The [interactive journey](core-engine-review.html) and [code/ER companion](25-JOURNEY-AND-DATA-FLOWS.md) show the same boundaries.

## T1 · A reel is watched, then a branch is taken

| Actor | Action | Durable result |
|---|---|---|
| Composer | Select eligible ready inventory; record policy and candidate exclusions. | Selection receipt, slate |
| Person | Actually watches and requests a deepen branch. | Exposure, episode, explicit branch intent and mark |
| Composer | Bind and serve an already eligible branch; record actual playback separately. | Binding, branch selection, route with origin |
| Accounts / Cartographer | Update bounded evidence and test eligibility. One session does not establish a durable place. | Account projection; no structural change if gates fail |
| Quartermaster / Steward | Describe optional horizon gaps; perform a deterministic no-op if no meaningful new evidence. | ContentDemand or no-op outcome; no automatic model call |

## T2 · “Continue this reel” when nothing is ready

| Actor | Action | Durable result |
|---|---|---|
| Composer | Preserve exact branch request and show pending or a sourced alternative. | Intent; served remains false |
| Quartermaster / supply planner | Try suitable inventory, then compatible in-flight work; otherwise evaluate funded generation. | ContentDemand, suitability and waiter |
| Admission / host adapter | Reserve job budget and attempt resources; persist request ID before Cutroom POST. | GenerationJob, Attempt, Permit, external intent |
| Cutroom / adapter | Observe run.finished, fetch result and record, import safely and apply KnowScroll gates. No promised latency. | Asset revision, availability, cost or unknown liability |
| Composer / person | Recheck waiter authorization; offer ready content. Mark fulfilled only when the relevant fulfillment/consumption rule occurs. | Binding, selection and actual exposure |
| Person leaves | Cancel an obsolete speculative waiter; preserve explicit request outcome. Other funded waiters can continue. | Independent cancellation or saved pending intent |

## T3 · A night, from digest to morning card

| Actor | Action | Durable result |
|---|---|---|
| Clock / code | Build digest of new episodes, due commitments, source changes and gaps; skip an empty night. | Frozen H and no-op or Job |
| Steward | Resume useful investigations; propose budget allocations and structure review. No fixed number of calls is required. | Scoped bundles and typed proposals |
| Runtime | Optionally schedule bounded child research; waiting parent yields. Every child, repair and synthesis is admitted. | Child Jobs, Steps, Attempts and receipts |
| Keeper / residents / verifier | Run a funded room episode, check citations and preserve disagreement. | Room posts, positions, citations and verdicts |
| Cartographer / reducer | Evaluate semantic and navigation usefulness as well as temporal gates; apply only fresh valid changes. | WorldDelta with lineage, or rejected proposal |
| Supply planner / Scribe | Reuse or fund the needed Reel/Scroll; narrate only actual committed changes and gated artifacts. | Inventory and concise chronicle invitation |

## T4 · A friend’s continent

| Actor | Action | Durable result |
|---|---|---|
| Projector | Expose only the friend’s current shareable subset. | Versioned VisitProjection |
| Visitor | Watch and keep within visit scope. | Social exposure and marks; no automatic own-universe growth |
| Later, own universe | Voluntarily return through a valid invitation or exploration. Retain social origin and actual selection lineage. | Own episode with origin lineage |
| Accounts / Cartographer | Evaluate repeated voluntary evidence and useful structure under policy. Days or repeated exposures alone do not prove independence. | Own account; optional sighting or validated world change |
| No return | Sighting can expire under policy without manufacturing an interest. | Expiry with lineage |

## T5 · A request inside a Blend

| Actor | Action | Durable result |
|---|---|---|
| Projector | Combine only authorized current projections. | Blend state and permission dependencies |
| Composer / person | Request an opposing explanation; record social-origin intent. | Blend-scoped demand |
| Planner / admission | Try reuse; agree and reserve any sponsor split before spending. | Waiter and optional generation job |
| Gates / people | Publish eligible Reel or Scroll; record each person’s own keep/exposure. | Shared artifact, independent bindings and social marks |
| Member leaves | Revoke affected access. Kept artifacts persist only under continuing rights/grants; private access is not granted by keep alone. | Revocations; unrelated public assets remain |

## T6 · “Wrong connection”

| Actor | Action | Durable result |
|---|---|---|
| Person | Open Why this appeared, then reject the perception–flocking connection. | Receipt lookup and exact correction |
| Reducer | Suppress the personal relation and revise dependent hypothesis; do not mute the whole topic. | PersonalizationSuppression, hypothesis revision |
| Cartographer | If a personal chart edge depends on it, apply an explicit revision with lineage. | WorldDelta if needed |
| Composer / runtime | Exclude suppressed route; reject late proposals built on the old premise. | Fresh eligibility; stale disposition and cost receipt |

## T7 · Privacy reset during a render

| Actor | Action | Durable result |
|---|---|---|
| Person / reducer | Advance universe privacy epoch atomically; erase or tombstone dependent private state. | Epoch and deletion lineage |
| Scheduler / planner | Cancel private queued work and affected demand waiters; revoke bindings and request supported remote cancellation. | Cancelled jobs/waiters; publication fence |
| Late result | Reject old-epoch attachment. Do not persist revoked private output merely for debugging. | Minimal receipt; private payload erased or quarantined under bounded retention |
| Accounting | Reconcile known spend; unknown supplier liability remains unknown. | Settlement evidence |
| Public substrate | Independently public knowledge and other authorized waiters remain. | No change to unrelated public assets |

## T8 · Dormancy and rediscovery

| Actor | Action | Durable result |
|---|---|---|
| Decay sweep | After policy-specific inactivity, dim salience and mark eligible places dormant. | Account and place projection |
| Composer | Offer a bounded revisit if suitable; its exposure has its own treatment lineage. | Selection and exposure |
| Person skips | Record exposure and skip; do not infer renewed interest. | Observation only |
| Later person enters and keeps | Evaluate fresh voluntary evidence and revisable meaning. | Episode and marks |
| Cartographer / Scribe | Reawaken under the configured rule, preserving regions and lineage; describe the actual return. | WorldDelta and quiet chronicle line |

## T9 · A first session

| Actor | Action | Durable result |
|---|---|---|
| Composer | Offer ready doors across domains and experience kinds. | Selection receipt with initial policy |
| Person | Watch, skip and request an example. | Exposure separately from branch intent and voluntary mark |
| Chart | Show the first trace and provisional sightings where justified. | No invented established planet |
| Composer | Use the branch target while retaining eligible frontier opportunities. | New candidate set |
| Steward | Store a modest question and uncertainty; skip model interpretation if unnecessary. | Scoped summary or bounded investigation |

## T10 · An explicit question becomes a bridge

| Actor | Action | Durable result |
|---|---|---|
| Person | Ask about clock differences near a black hole. | Exact Intent |
| Investigation | Consider competing explanations of usefulness and retrieve relevant evidence. | Hypothesis alternatives, ContextBundle |
| Model / validator | Propose a clock-mechanism connection to GPS with prerequisites and limits; validate evidence and freshness. | BridgeCandidate and EncounterPlan |
| Supply / Composer | Find an explanation that teaches that connection, then offer it optionally. | Demand, binding and selection receipt |
| Person | Accept, ignore or correct it; never convert one reaction into a learning fact. | Outcome with exposure lineage |

## T11 · Crash after send, before receipt

| Actor | Action | Durable result |
|---|---|---|
| Worker | Persist Step and Attempt intent then dispatch. | Stable external request identity |
| Crash | A replacement obtains the job lease but cannot assume the call stopped. | New fencing token, unresolved original attempt |
| Reconciler | Look up the same request where supported; otherwise preserve unknown outcome and liability. | Reconciliation receipt |
| Retry decision | A policy-authorized retry gets a new Attempt/Permit; its success does not settle the original unknown cost. | Separate attempt lineage |
| Reducer | Only a fresh valid proposal may apply; duplicate effect keys are rejected. | At most one committed domain effect under its transaction |

## T12 · Two users share a generation job

| Actor | Action | Durable result |
|---|---|---|
| Planner | Join compatible demands only under valid content scope, rights and suitability. | Two demands, one GenerationJob, two waiter links |
| User A | Cancel or reset. | Waiter A cancelled; its private binding revoked |
| Generation | Continue if user B or independent sponsor still authorizes useful work. | One settled generation cost |
| Planner | Validate result and recheck user B before binding. | Shared revision, private binding B |
| Analytics | Record common asset and generation policy when comparing outcomes; deduplication is not causal isolation. | Cross-cohort lineage |

## T13 · Dirty work arrives during processing

| Actor | Action | Durable result |
|---|---|---|
| Signals | Coalesce events through 120 with unioned reasons. | latest=120, processed=100 |
| Worker | Freeze H=120 and process authorized state through it. | Bundle high-water=120 |
| Signal | Event 121 arrives before completion. | latest=121 |
| Completion | Mark processed=120, retain event 121’s reason and continuation. | Dirty scope remains armed |
| Direct question | Do not merge its identity or outcome into the dirty signal. | Separate Intent and Job |

## T14 · Provider capacity is exhausted

| Actor | Action | Durable result |
|---|---|---|
| Request | Save the user’s exact question. | Intent and queued job |
| Scheduler | Class floors and per-user credits choose eligible work; route checks find no current capacity. | Durable wait; no held provider slot |
| Oversize request | If no route can ever admit it, reshape within intent or return cannot_meet rather than wait forever. | Explicit disposition |
| Capacity returns | Reserve all applicable dimensions atomically and journal before invoking once. | Permit, Attempt and BudgetReservation |
| Completion | Report result or specific failure, settle known usage, and expose queue/fairness metrics. | Outcome and receipts |
