> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: research
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: What was studied for this design, what transferred, what was rejected, and where this design pushes back on the existing documents and on the framing in the brief. External content is reported, not reproduced; nothing here was executed.
---

# Research findings and pushbacks

The original 2026-09-09 research pass reported reading the existing founding documents (`README.md`, `ARCHITECTURE.md`, `2026-09-08-CORE-ENGINE.md`, `2026-09-08-RESEARCH.md`, `2026-09-08-DECISIONS-AND-EXPERIMENTS.md`, the video-harness folder), the decision ledger, the Living Observatory prototype, and the external work below. The Sept 8 review already covered X's repositories, causal recommendation, Leiden and block models, Project SID's repository, Generative Agents, the H3 surfaces, and the agent-harness inspections; those findings are relied on and not repeated. This document adds what was studied since, in five areas, and then lists the pushbacks.


## Read this research in two layers

Sections A–G preserve the earlier research trail, with superseded conclusions corrected in place. They include literature summaries, abstract-level reports and press claims from that earlier pass; they are not newly reproduced benchmarks. Section H records the source-checked runtime and architecture refinement from 2026-09-15. The decision is based on KnowScroll's responsibilities, not a feature count or the smallest possible number of model calls.

## A. Persistent agents and harnesses

**Headlong** (Laude Institute, released 2026-08-24). Read: the repository README, `design/THINKERS_spec.md`, `design/trajectory_spec.md`, and the announcement post. What it is: ~11K lines of Bash; an agent that "thinks by writing shell commands"; a trajectory that is "a DAG of jsonl files with fork and merge", append-only, with "context is a projection of the trajectory" at exponentially decaying resolution; a message from a human "lands in the agent's thought stream as one more observation"; thinking rate "backs off exponentially when nobody is talking to the agent"; cost "$1 to $2 an hour". The thinkers spec is the part that matters for us: thinkers are independent processes subscribing to trajectory events ("the identity's root trajectory becomes a shared bus"); a busy thinker queues message and action steps FIFO (cap 16) and **coalesces** other wake types last-wins; a liveness watchdog synthesizes an idle trigger after `watchdog_secs` (default 300); concurrency is capped (default 4). The announcement reports the agent doing unprompted code reviews and fixing its own recall, and also killing its own service three times, being "bad at keeping secrets" across a shared stream, and that evaluation is "primarily qualitative".

*Transferred:* the trajectory as an append-only DAG with fork and merge (per agent); context as a projection; observations in one stream; the three dispatch rules (FIFO for direct addresses, coalesce for "look again", watchdog for idle); exponential backoff. *Rejected:* a perpetual self-triggering loop; shell as the only tool; one shared stream across users; continuous thinking as the meaning of persistence. D-011's rejection of Headlong as orchestrator stands; what changes is that its dispatch design becomes ours.

**Ambient agents** (LangChain, 2025): agents that act on event streams rather than prompts and surface to humans through an inbox for notify/question/review. **OpenClaw's heartbeat vs cron** (2026): a periodic wake with a checklist that returns a silent OK when nothing needs attention; cron for timing, heartbeat for "anything need attention?". **Sleep-time compute** (Letta, arXiv 2504.13171): pre-computing over a context while idle yields ~5× less test-time compute and 2.5× lower per-query cost when queries are predictable. **Letta/MemGPT, Mem0, Zep/Graphiti** (2026 comparisons): self-edited memory blocks; extract-and-retrieve facts; bi-temporal knowledge graphs (Zep reports 63.8% vs Mem0's 49.0% on LongMemEval); Letta's sleep-time agent edits core memory while the primary agent idles. **Durable execution** (Temporal, Restate, Inngest, DBOS, 2026): journaled steps so an agent resumes where it stopped; DBOS runs in-process over Postgres with no new infrastructure.

*Transferred:* the Steward is an ambient agent with a backing-off heartbeat and a nightly sleep-time session; its memory is three tiers (structured state it queries, small self-edited blocks with code-owned sections, an append-only journal); agent turns are durable jobs with journaled steps over the existing job table. *Rejected:* a mandatory memory framework or workflow engine before its complexity is justified.

## B. Multi-agent systems

**Project SID / PIANO** (Altera, arXiv 2411.00114): ten concurrent modules with a Cognitive Controller behind an information bottleneck that "gives system designers explicit control over information flow" and broadcasts one decision to condition talk and action; modules at different speeds so "slow mental processes… should not block agents from responding to immediate threats"; emergent roles, tax compliance, meme and religion spread measured by keyword adoption; 500-agent runs, 1000+ exceeded the server; no cost figures. **AgentSociety** (Tsinghua, arXiv 2502.08691): needs, emotions, and attitudes as state; asynchronous state-driven behaviour; event flow and perception flow separated; 10k agents via grouped processes. **OASIS**: up to a million templated agents with an environment server, a recommender, and a time engine. **Generative Agents** (Park et al., 2023): retrieval by recency × importance × relevance; reflection over clusters of memories; known agreeableness and memory errors. **Diversity collapse and sycophancy in multi-agent debate** (arXiv 2604.18005, 2509.23055, 2605.00914, 2604.26561, 2604.24698, 2606.29270): homogeneous agents converge; "peacemaker" personas accelerate disagreement collapse; a "senior" persona pulls juniors into agreement; isolated self-correction beats unguided homogeneous debate; architectural heterogeneity and coherence validation preserve disagreement. **Open-ended agents** (Voyager, OMNI, MAGELLAN, arXiv 2510.14548): automatic curricula; a model of interestingness chooses what to explore; predicted learning progress selects goals.

*Transferred:* the resident step as PIANO-lite (cheap deterministic pre-modules, one controller call, one output channel); state-driven wakes; observed/heard/verified/reflection memory kinds; isolated thinking before exchange; heterogeneity in method, evidence access, and model tier; no status hierarchy; a learning-progress counter for what a resident works on; idea spread measured by citation lineage. *Rejected:* large populations of templated agents; personality prompts as the source of diversity; consensus as an outcome.

## C. Recommendation

**X's 2026 algorithm** (github.com/xai-org/x-algorithm; Grok-based rewrite in January, end-to-end pipeline and a downloadable Phoenix mini model in May): Home Mixer (Rust orchestrator), Thunder (in-memory in-network store), Phoenix (two-tower retrieval and a Grok-architecture ranker predicting 15 engagement types with no hand-engineered features), Candidate Pipeline framework. **Instagram Explore** (Meta engineering, 2023): retrieval, first-stage light ranking, second-stage heavy ranking, final rerank, with caching. **TikTok Monolith** (arXiv 2209.07663): collisionless embeddings, online training with minute-level sync; freshness of state matters more than model size. **Lifelong sequence modelling** (SIM, ETA, TWIN, TWIN V2 at Kuaishou/Alibaba): retrieve the parts of a long history relevant to the target item before scoring, and cluster the life-cycle history hierarchically. **Generative recommendation** (TIGER, OneRec, HSTU, 2026 surveys): hierarchical semantic IDs over items; autoregressive rankers with reported 12% online lifts. **Cold start with LLM priors** (arXiv 2501.01945, 2608.03382, 2604.02527, 2604.14961): LLM-derived priors for Thompson sampling help when calibrated and hurt when noisy; calibration gating is the recommended guard. **Beyond-accuracy** (Kaminskas and Bridge 2016; Steck 2018 calibrated recommendations; ACM TORS 2026 survey). **Long-term satisfaction** (Netflix reward innovation 2023; Spotify impatient bandits arXiv 2501.07761: a Bayesian filter combines early signals with delayed 60-day outcomes; Kuaishou questionnaire-aligned satisfaction arXiv 2601.20215). **Social influence disentanglement** (CDRSB arXiv 2403.03578; SIDR): the social network is a confounder; separate interest from social-influence representations; not all social influence is harmful. **Short-video prefetching** (DeLoad arXiv 2510.18459; the Register on data wastage, 2025): prefetch depth keyed to predicted continuation; every speculative fetch is a cost.

*Transferred:* the staged pipeline; target-conditioned retrieval over the person's own episodes as the `fit` term; hierarchical concept codes as stable addresses; Thompson sampling over families with calibration-gated priors; calibration over places and over kinds of thinking; marks and returns as observable feedback signals, with later review rejecting them as the final objective; the two-context rule for social origin; expected-value prefetch. *Rejected:* an engagement objective; demographic or sensitive features; a learned ranker without data; a generative decoder; per-item bandits.

## D. Structure and hierarchy

**GraphRAG** (Microsoft, arXiv 2404.16130): entity extraction, recursive Leiden communities to leaf level, bottom-up LLM community summaries, global and local query modes. **Pinterest's Interest Taxonomy and Pin2Interest**: a parent–child tree up to 11 levels, mapping 200B+ pins, used for recommendations, ranking features, and safety; user journeys as multi-session intent. **BERTrend** (arXiv 2411.05930): online topic tracking with noise/weak/strong signal states and explicit merge and split over time. The Sept 8 review's Leiden, multilayer (Mucha), and nested block model notes stand.

*Transferred:* graph-assisted hierarchy, semantic candidate proposals and explicit stable-identity matching; taxonomy as address, not geography; weak-signal → strong-signal states for sightings and places; explicit merge and split events with lineage. *Rejected:* re-clustering per build; a taxonomy as the map.

## E. Quality

**YouTube 2026** (CNBC 2026-01-21; TechCrunch 2026-07-20; trade reports): "managing AI slop" as a stated priority; repetitive low-value uploads deprioritized; reported shifts from click-through toward satisfaction and long-term value; reported figures of billions of views and tens of millions of subscriptions removed; a reported one-in-five low-quality share of Shorts recommended to new users. Viewer-facing slop signals in the trade press: audio-visual mismatch, repetitive structure across uploads, vague sourcing, uncanny visuals. **Judge biases** (the Sept 8 review's Anthropic harness notes; 2024–26 literature on self-preference and aesthetic convergence). **Model collapse** (recursive training on generated data degrades distributions).

*Transferred:* a quality vector with separate components that cannot average past a zero; three fingerprints for repetition; pairwise blinded judging against a human reference set with monthly calibration and judge rotation; the fetch blocklist that keeps the engine's outputs out of its sources; an optimizer blind to watch time; corpus monitors that freeze lanes and ask the owner. *Rejected:* a single quality score; a critic loop; automatic tuning from monitors.

## F. Pushbacks

Each item: what is right in the current thinking, the specific weakness, and what this design proposes instead.

1. **"A central/core LLM and an agentic harness around it" (the brief).** Right: someone has to notice cross-cutting patterns, plan research, and write the sentence on the card, and rules cannot. Weakness: a core LLM that "controls" the engine would be in the serving path, would rank, and would be the most expensive and least auditable component. Proposal: one Steward per universe, off the serving path, event-woken with backoff, reading a code-generated digest, emitting typed proposals with receipts, and holding no authority over ranking, publication, or state (`10-…`).

2. **"Should it continuously think, or wake on events?" (the brief).** Right: persistence is the thing that makes it feel like a world. Weakness: continuous thinking at Headlong's $1–2 per hour per agent is the entire D-014 budget in a day, its authors evaluate it qualitatively, and idle time alone does not justify a model call; a due investigation can still make useful progress while the person is absent. Proposal: persistent in identity and memory, never in execution; Headlong's dispatch semantics adopted; a proposed replacement for the queued D-011 experiment, without claiming this folder amends the accepted decision (`03-…` §8, `12-…` §8).

3. **"Idea Rooms as living communities where every important agent runs its own persistent harness" (the brief).** Right: agents need identity, memory, commitments, and the ability to act without the person. Weakness: per-agent loops multiply cost by population and the debate literature shows that more homogeneous agents talking more produces less. Proposal: residents as event-woken subscribers with journals; deterministic pre-modules so most wakes cost nothing; attention-funded episodes; isolated-then-exchange; a disagreement floor with ephemeral visitors; artifact-only influence (`11-…`, `12-…`).

4. **"Planet → richer planet → Star → Solar System → Galaxy, promotion by attention" (the brief and the Cosmos prototype's `isStar` rule).** Right: scale should grow, and attention is what fuels it. Weakness: a threshold on stops across sub-concepts can be met by autoplay; a "star" stage conflates the hub of a system with a foundational idea. Proposal: attention is fuel, structure is the trigger; numeric readiness alone is insufficient; formation needs an organizing relation and exposure lineage. A system hub is distinct from a foundational star, and load-bearing meaning requires evidence (`07-…` §1, §4.4, §4.7).

5. **The Sept 8 Core Engine's hypotheses-only user model.** Right: no interest score, evidence and counterevidence on every inference, decay. Weakness: it gave the Composer and Cartographer nothing numeric to run on without a model, and left "episodes" and "returns" as prose. Proposal: Attention Accounts as a deterministic layer beneath hypotheses, with episode weights, viability tuples, state lines, and routes, so that every structural gate and every ranking term is computable and replayable (`06-…`).

6. **`ARCHITECTURE.md` §11's utility with `expected_mental_model_expansion`.** Right: expansion is the objective. Weakness: unmeasurable as written (the Sept 8 review said so). Proposal: bridgeable distance and kinds of thinking aid candidate discovery, but are not measurements of mental-model expansion. The refined objective considers useful explanation, agency, continuity, quality and diversity; marks and returns are imperfect signals (`08-…` §1, §5).

7. **`ARCHITECTURE.md` §7's per-kind tables as truth.** Right: typed state. Weakness: unlinked histories make causal inspection and replay difficult; multiple physical streams are compatible with one logical causal history. Proposal: one logical scoped Ledger with causal IDs, derived domain views and separate execution receipts; replay checks deterministic projections (`04-…`).

8. **`ARCHITECTURE.md` §9's slow loop as a periodic pass.** Right: two speeds. Weakness: a nightly pass either does too much or misses the moment. Proposal: named modules with subscriptions, debounce, and a heartbeat that backs off, plus the night as one of several clocks (`03-…` §3).

9. **The README's Interdimensional Cable as an infinite mixture "from the person's known universe, its frontier, selected social connections, and live world events".** Right in every word. Weakness: unspecified where the outside comes from and how much. Proposal: guaranteed frontier share with named sources (sightings, probes, rooms, sky, friends), visible channels, and the rule that generation never fills a slot (`09-…`).

10. **Social as "a separately permissioned source" (Sept 8).** Right: separate permission. Weakness: permission does not stop a friend's Cable from being counted as the visitor's interest. Proposal: the two-context rule with a social ledger and explicit conversion (`13-…`).

11. **"No AI slop" as a prompt (the brief's worry).** Right that a prompt cannot do it. Proposal: retrieve-before-generate with gap-tied briefs, external-only sources, a watch-time-blind optimizer, fingerprints, calibrated blinded judging, and monitors that stop lanes and ask (`14-…`).

12. **The brief's example flow ("user watches reel → recommendation state changes → short-term model updates → long-term world evidence updates → maybe planet state changes → maybe Idea Room receives an event → maybe core agent notices…").** Right in shape. Two corrections: watching produces observation and exposure evidence, not a confirmed interpretation of motivation; and rooms receive events about *evidence and questions*, not about a person watching a reel. The corrected trace is `01-…` §6 and `20-…` T1.

## G. What was not done

No external repository was executed; no benchmark was reproduced; no paid model or video call was made. Headlong's design documents are marked "stale" by their authors in places, and its cost figure is theirs. YouTube's 2026 figures are press reports. The debate-collapse papers are read through their abstracts and stated findings. Everything above is input to a design that will be tested by replay before it is tested by a person.

## Sources

- Headlong: https://github.com/laude-institute/headlong · design/THINKERS_spec.md · design/trajectory_spec.md · https://www.laude.org/updates/headlong-a-microharness-for-persistent-agents
- Sleep-time compute: https://arxiv.org/abs/2504.13171
- Project SID / PIANO: https://arxiv.org/html/2411.00114v1
- AgentSociety: https://arxiv.org/html/2502.08691 · OASIS and related: arXiv 2604.18011, 2605.00197, 2509.21862
- Multi-agent debate failure modes: arXiv 2604.18005, 2509.23055, 2605.00914, 2604.26561, 2604.24698, 2606.29270, 2511.07784
- Open-ended agents: Voyager arXiv 2305.16291 · OMNI · MAGELLAN arXiv 2502.07709 · arXiv 2510.14548
- Ambient agents (LangChain, 2025); OpenClaw heartbeat docs: https://docs.openclaw.ai/gateway/heartbeat
- Memory frameworks 2026 comparisons (Mem0, Zep/Graphiti, Letta); Generative Agents (Park et al., 2023)
- Durable execution 2026 (Temporal, Restate, Inngest, DBOS) — trade comparisons
- X algorithm 2026: https://github.com/xai-org/x-algorithm and press coverage of the January and May 2026 releases
- Instagram Explore: https://engineering.fb.com/2023/08/09/ml-applications/scaling-instagram-explore-recommendations-system/
- TikTok Monolith: https://arxiv.org/abs/2209.07663
- Lifelong sequences: TWIN arXiv 2302.02352 · TWIN V2 arXiv 2407.16357
- Generative recommendation: TIGER, OneRec (arXiv 2607.26500), HSTU, CapsID arXiv 2605.05096, TechRxiv 2026 survey
- Cold start: arXiv 2501.01945, 2608.03382, 2604.02527, 2604.14961, 2412.04484; LLMTreeRec (COLING 2025)
- Beyond-accuracy: Kaminskas and Bridge (ACM TiiS 2016); Steck (RecSys 2018); Calibrated Recommendations survey (ACM TORS 2026); arXiv 2405.02156
- Long-term satisfaction: Netflix (RecSys 2023); Spotify impatient bandits https://arxiv.org/abs/2501.07761; arXiv 2601.20215; PrefRec arXiv 2212.02779
- Social influence: CDRSB https://arxiv.org/abs/2403.03578
- Prefetching: DeLoad arXiv 2510.18459; arXiv 2602.09484; The Register 2025-09-23
- GraphRAG: https://arxiv.org/abs/2404.16130 · Pinterest Interest Taxonomy and Pin2Interest (Pinterest Engineering, Medium) · BERTrend arXiv 2411.05930
- YouTube 2026: CNBC 2026-01-21; TechCrunch 2026-07-20; trade coverage
- Spotify Blend (product documentation and coverage)


## H. Source-checked runtime and shared-execution refinement

The [23-section runtime review](../2026-09-15-RUNTIME-AND-GLOBAL-EXECUTION-REVIEW.md) contains the detailed evidence, pins and uncertainty. The founder accepted its AI SDK direction and requested this integrated revision.

| Finding | Source / evidence | Consequence here |
|---|---|---|
| Mature model libraries already supply invocation, streaming and tool primitives | [AI SDK](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) and [middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware) | Adopt the library; own domain durability, context, tools and admission |
| Main-loop interception alone does not cover every request | [Pi compaction source](https://github.com/badlogic/pi-mono/blob/8a7b0c03dfb702663acafb6dc29f8acaa4ffe391/packages/agent/src/harness/compaction/compaction.ts), [Prime compaction](https://github.com/PrimeIntellect-ai/prime-agent/blob/ad426c672327696c42d641379840212ca5a8b85b/packages/coding-agent/src/core/compaction/compaction.ts) | Meter retries, compaction, children and verification at the actual invocation boundary |
| Codex SDK is a coding-runtime subprocess integration | [Pinned SDK](https://github.com/openai/codex/blob/2fdcdeaf0e219eea34c710e01de2ee0571ddeeb5/sdk/typescript/src/exec.ts) | Valuable for specialized code work, not the default owner of user intelligence |
| Shared queues require explicit tenant protection and useful-work admission | [AWS fairness](https://d1.awsstatic.com/builderslibrary/pdfs/fairness-in-multi-tenant-systems-david-yanacek.pdf), [backlogs](https://d1.awsstatic.com/builderslibrary/pdfs/avoiding-insurmountable-queue-backlogs.pdf) | Fair classes, per-user quotas, coalescing, expiry and recovery ramp |
| Request counts do not capture several constrained resources | [Dominant Resource Fairness](https://www.usenix.org/legacy/event/nsdi11/tech/full_papers/Ghodsi.pdf) | Token/cost-aware fairness plus actual RPM/TPM/concurrency constraints; no formal DRF guarantee claimed |
| M3 exists, but compatibility wording exceeds detailed schema guarantees | [Models](https://platform.minimax.io/docs/guides/models-intro.md), [Messages schema](https://platform.minimax.io/docs/api-reference/text-chat-anthropic.md), [limits](https://platform.minimax.io/docs/guides/rate-limits.md) | M3-first adapter, explicit thinking/usage handling; no assumed forced-tool or native strict-schema guarantee |
| Actual Cutroom V1 is host-local HTTP, returns local paths and no sources card | [Contract at d57e092](https://github.com/KnowScroll/Cutroom/blob/d57e0921a662a0ce976faa1b7ba190820ff11529/docs/features/reel-contract.md) | ContentDemand, host adapter, import, provenance and scoped inventory bindings |
| Durable workflow frameworks do not replace domain authority | [Temporal](https://docs.temporal.io/task-queue), [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Keep table-backed explicit steps initially; adopt frameworks only for demonstrated orchestration needs |

### What we now keep, refine and test

**Keep:** the full spatial and social product, Ledger/reducer ownership, deterministic serving, ready inventory, evidence fences and persistent identities.

**Refine:** semantic interpretation must influence real encounter candidates; numerical attention rules are policy inputs, not causal proof; persistent investigations can use multiple focused agents; shared execution governs all costly attempts; shared content separates reusable assets from private reasons.

**Test:** useful conceptual bridges, quiet-user experience, fair scheduling, unknown external outcomes, source corrections, privacy reset, M3 adapter compatibility and the actual Cutroom paid path. Current architecture claims are proposals and source findings, not those tests' results.

The historical source list above remains a research trail. Use the pinned runtime review for the current harness/provider recommendation rather than treating old comparative numbers or broad marketing summaries as current deployment evidence.

### H.6 Final integration check for this refinement

The [AI SDK settings reference](https://ai-sdk.dev/docs/ai-sdk-core/settings) exposes retry settings, and its [agent loop-control documentation](https://ai-sdk.dev/docs/agents/loop-control) describes multi-step loops. Rechecked 2026-09-15: KnowScroll uses explicit single invocations, turns library retries off, and owns each subsequent step in its journal. An outer middleware hook alone is not the accounting proof; the chosen adapter and transport must be tested for every real request.

The [MiniMax Messages guide](https://platform.minimax.io/docs/api-reference/text-anthropic-api) requires preserving complete assistant response blocks through tool continuations and documents M3 image/video support at the native wire level. That does not establish image support in the community AI SDK provider. The implementation route remains gated by a concrete adapter test.
