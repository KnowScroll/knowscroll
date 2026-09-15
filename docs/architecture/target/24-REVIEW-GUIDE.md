> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: architecture-proposal
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Reviewable design, not implemented or measured behavior. Code is illustrative pseudocode.
---

# Founder review guide

## The proposal in one paragraph

Keep KnowScroll’s full world: Cable, planets, regions, systems, galaxies, rooms, residents, social visits and Blend. Add the missing semantic layer that turns exact questions and observed behavior into revisable hypotheses, evidence-backed conceptual bridges and useful next experiences. Run that work through a small KnowScroll-owned durable runtime using AI SDK, with global admission for every expensive attempt. Models propose; deterministic code serves, validates and commits.

## Read it in this order

1. [Open the interactive architecture review](core-engine-review.html): step through the black-hole → clock → GPS journey, then explore waiting, stale results, shared generation, rooms, Blend and reset.
2. [01 — Overview](01-OVERVIEW.md): the whole system and its responsibilities.
3. [03 — Architecture](03-ARCHITECTURE.md): ownership, modules and process boundaries.
4. [21 — Reasoning runtime](21-REASONING-RUNTIME.md), [22 — Global execution](22-GLOBAL-EXECUTION.md), [23 — Content demand](23-CONTENT-DEMAND-AND-INVENTORY.md): the new contracts.
5. [25 — Journey, code and ER diagrams](25-JOURNEY-AND-DATA-FLOWS.md): follow the records through the design.
6. [19 — Open questions](19-OPEN-QUESTIONS.md) and [18 — Implementation phases](18-IMPLEMENTATION-PHASES.md): distinguish the remaining decisions from the proof required to ship.

## What stayed, and what became more precise

| Area | Retained | Refinement |
|---|---|---|
| Product world | Every world scale, rooms, persistent inhabitants, social/Blend, Reel and Scroll | Each visible change needs a meaningful explanation and explicit authority |
| Ledger | Durable ordered history, causal lineage, replay, receipts | Separate domain history from provider execution journals and operational receipts |
| User understanding | Attention accounts and tentative hypotheses | Exact questions, alternatives, counterevidence, expiry and permitted uses |
| Recommendations | Composer, candidate families, branches, frontier and diversity | Validated bridges and encounter plans affect candidates; similarity alone is insufficient |
| Steward and residents | Persistent memory, commitments, night work and research | Identity outlives workers; bounded child jobs share budgets and waiting parents yield |
| Runtime | Worker-only model/provider execution | AI SDK as invocation library; KnowScroll owns steps, retries, context, permissions and recovery |
| Capacity | Pools and practical cost controls | Global class fairness, per-user credits, atomic quotas, unknown liability and every paid retry |
| Supply | Three horizons, continuation, variants, quality and coverage | ContentDemand → reuse/adapt/join/fund → host adapter → gates → private binding |
| Cutroom | External media engine | Current HTTP contract, local path import, source ownership and explicit missing integration proofs |
| Feedback | Corrections, evidence checks and anti-slop policy | Exposure is an intervention; shared supply can confound comparisons; watch analytics are descriptive |
| Deployment | Recorded SQLite single-host phase | PostgreSQL proposed at a real hosted multi-host boundary, with contracts kept stable |

Original chapters 00–20 remain in place. New chapters 21–25 give the runtime, supply and review material a clear home. The original HTML remains as a dated earlier explainer, with a link to the revised one. The earlier critical review and source manifest remain historical research artifacts.

## The actual go-ahead being requested by these documents

Approval would accept this **architecture direction** and the staged validation plan. It would not mean the runtime is implemented, that MiniMax compatibility has passed live tests, that Cutroom meters every supplier attempt, or that recommendation usefulness has been demonstrated.

The main unresolved choices are captured in [19](19-OPEN-QUESTIONS.md): exact initial route/adapter, measured budget and fairness settings, usefulness evaluation, semantic admission thresholds, metered Cutroom integration, and deployment boundary. These can be settled during the appropriate phase without removing the full product architecture.

## What must be demonstrated

- One meaningful bridge journey where the proposed mechanism changes the available experience and a correction changes it back.
- Crash-after-send recovery, separate retry charging, unknown spend and stale-proposal rejection.
- Fair service under competing interactive/background load, including oversize requests and a waiting parent with children.
- Two demands sharing a run, independent cancellation, rights/source withdrawal and privacy reset during generation.
- Exact provider continuation, structured-output handling, cancellation behavior and adapter capability tests.
- Real artifact import and evidence/quality gates; ready content serving remains responsive while background work runs.

## Evidence and research boundaries

Research and source pins are in [02](02-RESEARCH-FINDINGS.md), the [runtime review](../2026-09-15-RUNTIME-AND-GLOBAL-EXECUTION-REVIEW.md) and the [source manifest](../2026-09-15-CORE-ENGINE-REVIEW-SOURCES.md). AI SDK invocation and tool-loop behavior must be verified against the version selected for implementation. MiniMax endpoint capability is distinct from what its chosen AI SDK adapter preserves. Published limits and prices are dated inputs to scenarios, never account entitlements or benchmarks.

The review HTML is a deterministic explanation, not a live system simulation. Its steps and example records are scripted. Its diagrams and code sketches are also available as Markdown for later editing.

## Documentation validation

Completed on 2026-09-15:

- All 21 original Markdown chapters remain; the folder now has 26 chapters. Original question IDs 1–32 and journey IDs T1–T9 remain, with five additional recovery/semantic traces.
- All 307 local Markdown links resolve. Git whitespace checks pass.
- All 44 Markdown Mermaid blocks parse. The HTML's 14 flow diagrams and 4 ER diagrams render to embedded SVG.
- Browser validation passed 136 assertions across the seven scenarios, step navigation/restart, keyboard navigation, diagram selection/search, zoom/fit and SVG download.
- Desktop and 390-pixel mobile views were inspected. No page-level mobile overflow, JavaScript errors or external network requests were observed; reduced-motion mode was checked.
- The earlier HTML was retained and labeled as the previous proposal. Prior review/source artifacts, accepted decisions, steering state and application code were not changed by this refinement.

These checks validate the documents and explainer only. Provider compatibility, recommendation quality, real cost accounting and implementation behavior remain to be proved in the phases above.
