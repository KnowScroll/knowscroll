> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: index
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Refined design for founder review. Illustrative contracts and policies, not implemented behavior or approval to build.
---

# KnowScroll Core Engine

**Start with the experience:** a person finds an idea, follows a useful connection, and comes back to a world that remembers the question. The feed stays quick. The world, rooms and inhabitants can develop over time. Background reasoning helps decide which connections and explanations are worth offering.

**The architecture:** each universe has its own logical Ledger, world state and persistent intelligence. Shared workers run AI SDK jobs when evidence, priority and budget justify them. Models propose; deterministic code validates and applies. The Quartermaster describes missing experiences, and shared inventory and generation services decide how to supply them.

## Start here

1. [Review guide](24-REVIEW-GUIDE.md): what is agreed, what changed, and what your final go-ahead would approve.
2. [The whole engine](01-OVERVIEW.md): a plain-language tour of the product and runtime.
3. [Interactive walkthrough](core-engine-review.html): user journeys, code sketches, flow diagrams and ER diagrams.
4. [Journey and data flows](25-JOURNEY-AND-DATA-FLOWS.md): the same contracts and diagrams in Markdown.

All existing chapters remain. They have been refined, with new chapters for execution and shared content. The original spatial, social and quality ideas remain part of the full architecture. The earlier [core-engine explainer](core-engine-explainer.html) is a preserved previous proposal; use the new walkthrough for this revision.

## Six ideas to keep in mind

- **The Ledger records what happened.** It does not declare why a person cared.
- **Investigations preserve questions.** A Steward or resident can work on one across several sessions, using focused child jobs where useful.
- **The semantic bridge changes the experience.** Evidence-backed hypotheses and conceptual connections become encounter plans and eligible candidates, not just diary entries.
- **Compute is shared.** Every model request, retry, verification and generation competes under global limits and fair per-user budgets.
- **The world has a single application authority.** Models produce proposals against known inputs; the validator/reducer commits accepted changes.
- **Supply starts with reuse.** A reusable explanation can serve several people while their private reasons and narrative bindings stay separate.

## Chapter map

| Chapter | Read it to understand |
|---|---|
| [01 Overview](01-OVERVIEW.md) | The entire design and one concrete journey |
| [02 Research](02-RESEARCH-FINDINGS.md) | Sources, borrowed patterns and decisions we reject |
| [03 Architecture](03-ARCHITECTURE.md) | Modules, processes, owners and call boundaries |
| [04 Events](04-EVENT-ARCHITECTURE.md) | Ledger, ordering, wake signals and privacy epochs |
| [05 Data](05-DATA-STATE-MODEL.md) | Logical stores, entities and relationships |
| [06 User/world model](06-USER-WORLD-MODEL.md) | Observations, accounts, intent and uncertain interpretation |
| [07 Universe evolution](07-UNIVERSE-EVOLUTION.md) | Planets, stars, systems, moons, galaxies, holes and ruins |
| [08 Recommendation](08-RECOMMENDATION.md) | Candidates, useful next experiences and deterministic serving |
| [09 Cable](09-INTERDIMENSIONAL-CABLE.md) | Discovery channels, frontier and continuity |
| [10 Steward](10-CORE-AGENT.md) | Persistent investigations, memory, tools and planning |
| [11 Idea Rooms](11-IDEA-ROOMS.md) | Questions, residents, commitments and shared artifacts |
| [12 Persistent agents](12-PERSISTENT-AGENTS.md) | Identity, bounded steps, children and lifecycle |
| [13 Social/Blend](13-SOCIAL-BLEND.md) | Permissioned visits, shared experiences and revocation |
| [14 Quality](14-QUALITY-ANTI-SLOP.md) | Evidence, visual checks, editorial variety and publication |
| [15 Cutroom integration](15-VIDEO-SDK-INTEGRATION.md) | Quartermaster horizons and the actual HTTP contract |
| [16 Feedback](16-FEEDBACK-LOOPS.md) | How recommendation, generation and interpretation can reinforce mistakes |
| [17 Scale/cost](17-SCALING-COST.md) | Capacity, accounting and growth scenarios |
| [18 Implementation sequence](18-IMPLEMENTATION-PHASES.md) | How to build and prove the complete design in stages |
| [19 Review decisions](19-OPEN-QUESTIONS.md) | Disposition of the original 32 questions and remaining choices |
| [20 Worked traces](20-WORKED-TRACES.md) | Concrete events, state changes and failure cases |
| [21 Reasoning runtime](21-REASONING-RUNTIME.md) | AI SDK, provider ports, durable steps and tool execution |
| [22 Global execution](22-GLOBAL-EXECUTION.md) | Scheduling, fairness, quotas, recovery and observability |
| [23 Shared content](23-CONTENT-DEMAND-AND-INVENTORY.md) | Demand, inventory, reuse, generation and private bindings |
| [24 Review guide](24-REVIEW-GUIDE.md) | A short path to the founder's final architecture decision |
| [25 Journey/data flows](25-JOURNEY-AND-DATA-FLOWS.md) | Code sketches, sequence diagrams and focused ER diagrams |

## Names in plain language

| Name | Meaning |
|---|---|
| Ledger | Causal history for an authorized scope; logical isolation does not require separate physical databases |
| Substrate / sky | Concepts, claims, sources and supported relationships beyond any one universe |
| Chart | The navigable universe with stable place identities and history |
| Accounts | Recomputable observations and tallies; inputs to policy, not a psychological profile |
| Composer | Selects the next eligible Reel or Scroll |
| Cartographer | Proposes and validates useful world structure |
| Quartermaster | Identifies content needs and manages their fulfillment |
| Steward | One persistent coordinating identity per universe, supported by focused jobs |
| Investigation | A durable question, evidence, alternatives, unfinished work and budget |
| Room / residents | A scoped place of inquiry and its persistent inhabitants |
| Gates / Scribe / Projector | Check publication / explain committed changes / produce permissioned social views |
| Runtime | Executes bounded steps using AI SDK and domain tools |
| Scheduler | Decides which eligible work can use shared capacity next |

## What is authoritative

This folder remains a proposed architecture. [Founding product law](../README.md) owns product meaning; [accepted decisions](../../../steering/DECISIONS.md) constrain implementation until superseded through the existing process. The founder has accepted the AI SDK direction and asked for this refinement; final implementation approval is still pending. No production behavior is claimed.

The detailed basis is the [critical review](../2026-09-15-CORE-ENGINE-ARCHITECTURE-REVIEW.md) and [runtime/global-execution review](../2026-09-15-RUNTIME-AND-GLOBAL-EXECUTION-REVIEW.md). New recommendations that differ from recorded implementation choices are called out in 18 and 24. All numerical thresholds are versioned policy candidates to test.
