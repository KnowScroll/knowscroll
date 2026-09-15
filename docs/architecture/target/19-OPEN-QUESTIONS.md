> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: discussion
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Refined design for founder review. Illustrative contracts and policies, not implemented behavior or approval to build.
---

# Review decisions: what is settled and what still needs judgment

The founder has accepted the AI SDK direction and asked for the complete architecture to be refined before the final implementation go-ahead. We should not ask again whether to keep worlds, rooms or the Ledger. The remaining review should focus on choices that change the experience or deployment.

## 1. Agreed direction

Keep the full product. Use AI SDK inside a small durable reasoning runtime. Preserve a logical Ledger per universe and share expensive execution globally. Permit long investigations and focused agents under common evidence, authorization and budget rules. Keep serving fast and deterministic. Reuse content before funding generation.

## 2. The few choices that matter before implementation

| Choice | Recommended starting position | Why it matters |
|---|---|---|
| Initial deployment | SQLite for the recorded single-host phase; PostgreSQL if the first launch is actually multi-host | Changes operations and storage adapter, not domain meaning |
| Initial compute allowances | Keep accepted hard caps; choose measured per-class reservations after M3 contract tests | Determines latency and optional background activity |
| Optional world changes | Conservative visible changes with reasons and easy correction; no inferred mastery | Determines trust and navigation continuity |
| Room investigation funding | Explicit/shared allocations plus bounded exploration; internal credits remain invisible | Keeps rooms alive without pressure to generate engagement |
| Shared content default | Public factual cores reusable; private reasons and personal narrative scoped | Determines privacy and generation economics |
| Review/evaluation effort | Small curated set of meaningful explanations and bad bridges, expanded from failures | Necessary to judge semantics beyond valid JSON |

These are proposed defaults for review, not a request to configure every threshold now. The final review route is [24](24-REVIEW-GUIDE.md).

## 3. Disposition of the original 32 questions

Original IDs are retained so prior discussion stays addressable. “Refined” means the earlier formulation changed; it does not mean the underlying product idea was discarded.

| ID | Original topic | Current disposition |
|---:|---|---|
| 1 | One Steward and proposal rights | **Agreed direction.** One coordinating identity can run several investigations and focused child jobs; code applies changes |
| 2 | Module names | **Keep.** Pair each name with a plain responsibility; names are not separate process requirements |
| 3 | Ledger and derived tables | **Keep/refine.** Logical scoped history plus projections and execution records; no global physical serialization requirement |
| 4 | Persistent vs continuous execution | **Agreed direction.** Persistent questions and identity, bounded resumable execution; continuation needs evidence/dependency/policy |
| 5 | Watching/action weights | **Experimental.** Retain versioned counters but reject a universal ratio as proof of meaning |
| 6 | Two viable children/system formation | **Refined.** Counts are readiness constraints; semantic relation and exposure lineage matter; “independently viable” is not causal independence |
| 7 | Star as hub vs foundation | **Refined.** A hub's graph role does not establish a foundational concept; preserve both meanings explicitly in world semantics |
| 8 | Black hole placement/resolution | **Keep for product review.** Evidence resolves the question; history and return paths survive visual transformation |
| 9 | Dormancy/archive timing | **Experimental.** Dimming preserves identity; exact day thresholds are policy, not inferred loss of interest |
| 10 | Galaxy rarity | **Experimental.** Require useful organizing meaning and navigation; no timetable for user progression |
| 11 | Marks/returns as objective | **Replaced.** They are signals; useful next experiences, agency, evidence, continuity and diversity form the objective |
| 12 | Exploration percentages | **Experimental.** Preserve exploration and supply safeguards; tune shares through evaluation |
| 13 | Cable channels | **Keep.** Explain origin without turning the feed into a diagnostic dashboard |
| 14 | Kinds-of-thinking calibration | **Keep as evaluation candidate.** No prescribed user performance scores or quizzes |
| 15 | Cold-start door grid | **Keep entry-point concept.** Seed inventory and quiet-user usefulness matter; exact layout/thresholds remain UX policy |
| 16 | Attention-funded room credits | **Refined.** Internal budget allocation, explicit needs and exploration; no visible credit score or compulsory engagement feeding |
| 17 | Resident names/retirement | **Keep identities.** Presentation of names and retirement remains a UX decision with continuity |
| 18 | Disagreement floor/visitor | **Refined.** Seek missing evidence or methods; do not manufacture disagreement for activity |
| 19 | Cross-room residents | **Keep with scope boundaries.** Identity can persist; private context cannot cross room permissions automatically |
| 20 | Reflex answer and later checking | **Keep with honest status.** Do not promise “tonight” if no due commitment/capacity supports it |
| 21 | Social conversion after four hours | **Refined.** Retain social origin; a time gap does not establish independence. Later explicit acts add evidence, not retroactive declassification |
| 22 | Equal Blend costs | **Proposed policy.** Sponsor and consent must be explicit; one shared supplier bill is charged once |
| 23 | Friend discovery opt-in | **Permissioned default.** Visibility and recommendation eligibility are separately explicit |
| 24 | Retrieve before generate | **Agreed direction.** A sourced Scroll or honest pending alternative can meet the need when appropriate |
| 25 | Night/session dollar pools | **Re-evaluate.** Historical guesses are not budgets approved by this pass; actual accounting and accepted caps control |
| 26 | Session-start speculative generation | **Refined.** Search inventory first; bounded funded demand may prepare likely branches, with expiry and shared waiters |
| 27 | Editorial reference set | **Keep.** Small meaningful set, blinded comparisons and failure-driven expansion; exact monthly effort remains to decide |
| 28 | Monitor response | **Refined.** Deterministic backpressure can act within approved policy; semantic/quality policy changes need review |
| 29 | Hypothesis permitted uses | **Refined.** Permit validated encounter/candidate use with lineage; do not confine useful interpretation to private diary wording |
| 30 | Leiden on routes | **Conditional.** Use only for a demonstrated structure need with identity matching; no fixed concept-count trigger proves suitability |
| 31 | Ask can initiate research | **Keep user agency.** Explicit “go find out” can create a scoped funded investigation; it still uses the shared worker queue |
| 32 | Where the sky comes from | **Keep curated seed plus researched growth.** External ontologies may aid retrieval; taxonomy is not evidence or personal geography |

## 4. Provider and engineering questions remain tests

M3's schema/forced-tool behavior, token accounting, continuation blocks and cancellation semantics require a bounded adapter spike. Cutroom needs verified paid-path capabilities and metered internal calls before exact global accounting is claimed. Unknowns must remain labeled until tested. These checks are listed in [21](21-REASONING-RUNTIME.md), [22](22-GLOBAL-EXECUTION.md) and [23](23-CONTENT-DEMAND-AND-INVENTORY.md).

Do not convert a documented endpoint, a fake-provider test, a queue lease or a successful diagram into a claim of production readiness.
