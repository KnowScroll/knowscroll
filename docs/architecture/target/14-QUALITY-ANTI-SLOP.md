> **Target design, not runtime status.** Adopted through [ADR-0008](../../decisions/ADR-0008-foundation-adoption.md). Source front matter below records its original proposal status. Current executable boundaries live in [Architecture](../README.md), ADRs and contracts. Exact schemas/thresholds here require implementation decisions.

---
status: proposed
authority: architecture-proposal
date: 2026-09-15
project: KnowScroll Core Engine v2
scope: Design only. The quality vector's weights are policy; the gates are structural.
---

# Quality and anti-slop: making mediocrity structurally hard, not merely discouraged

An infinite generative feed's default failure is to become a machine that makes plausible things because plausible things get watched. YouTube's 2026 "AI slop" crackdown names the symptoms: repetitive structure and pacing across uploads, thin or absent sourcing, audio-visual mismatch, and content optimized for the click rather than for the viewer's later satisfaction. KnowScroll must not be able to drift there even if every prompt is written badly. This chapter defines quality as a **vector computed by code**, the gates it feeds, the corpus-level monitors, and the three structural rules that make slop expensive: retrieve before generate, sources are external only, and the optimizer is blind to watch time.

The September 15 runtime review adds three concerns this chapter must address:

1. **Model safety / calibration proxies.** A judge model or a verifier is not a calibrated authority. Its output is one input among several, with explicit self-preference checks; it cannot become the gate by itself.
2. **Shared supply confounding.** A monitor that measures "what the engine generated" and "what the engine retrieved" can be fooled when the same inventory is shared across cohorts, when generation policy changes between observations, or when a cohort's exposure was dominated by a single asset. The monitors in §8 account for this.
3. **Linked exposures.** A bridge candidate that links two encounters is a *joint* exposure: marking one is correlated with being shown the other, and naive per-item outcome measurement can credit both as if they were independent. Outcome accounting retains individual exposures and links them by episode, slate and bridge. Analysis chooses an appropriate cluster or treatment unit; a conceptual link alone does not merge two exposures into one.

The reasoning runtime that proposes bridge candidates upstream of the gates is in [21-REASONING-RUNTIME.md](21-REASONING-RUNTIME.md). The Composer that consumes the rubric features is in [08-RECOMMENDATION.md](08-RECOMMENDATION.md). The supply plane that decides what enters inventory is in [23-CONTENT-DEMAND-AND-INVENTORY.md](23-CONTENT-DEMAND-AND-INVENTORY.md). This chapter stays inside the quality plane: what gets through, what does not, and what the engine refuses to learn.

## 1. What slop is, operationally

| Symptom | Measurable form in KnowScroll |
|---|---|
| repetition | three fingerprints (semantic, template, argument) close to something already served or already in the corpus |
| thin sourcing | few evidence families; low claim coverage; low-tier sources |
| engagement shape | high viability, low marks: watched, never acted on |
| visual dishonesty | witness observation disagrees with the brief or the claims |
| sameness of kind | the corpus or a person's recent window over-represents one intent act (all "expose", no "predict" or "manipulate") |
| closed loop | a person's 30-day exposure concentrated in ≤ 2 places with no frontier marks |
| shared-supply confound | shared asset exposure across cohorts, requiring explicit interference analysis |
| bridge-link confound | per-item outcome measurement that credits linked encounters as independent |

The last two symptoms are the September 15 additions. The first is the operational form of "shared supply confounds the experiment" in the runtime review §18.2. The second flags dependence between observations; an analysis must choose its unit explicitly rather than assume two linked encounters are independent.

## 2. The quality vector

Every encounter has a `quality` vector, computed when it enters inventory and updated as outcomes arrive:

```ts
type Quality = {
  families: number;               // distinct evidence families behind its claims
  source_tier: number;            // 0–1; from a curated source policy (primary sources and reference works high; content farms and unreviewed generators zero)
  claim_coverage: number;         // fraction of narration sentences (reel) or prose claims (scroll) with a claim ref
  witness_alignment: number;      // 0–1 from the video harness's witness and brief gates
  epistemic: 'accept'|'accept_with_label'|'regenerate'|'reject';   // KnowScroll's own post-import epistemic gate
  editorial: number;              // 0–1; calibrated judge against the founder's reference set (§5)
  repetition: { semantic: number; template: number; argument: number };   // min distance to corpus and to this person's 30-day history
  meaningful_opportunities: number; // integer count of valid, available opportunities
  opportunity: number;            // separate 0–1 editorial rating for soft ranking; not the count
  bridge_link: { partner_id: string; correlation: number }[];   // encounters this asset is jointly exposed with through typed bridges, and the empirical correlation of their marks
  outcome: { exposures: number; marks: number; returns: number; bridge_pair_exposures: number; bridge_pair_marks: number };
};
```

`14-…` does not define "good". It defines the measurable properties that bad content lacks, and it keeps them separate so that beautiful misinformation cannot average its way past a zero.

The `bridge_link` field is the September 15 addition. When an encounter is the source or destination of a typed bridge candidate ([07-UNIVERSE-EVOLUTION.md](07-UNIVERSE-EVOLUTION.md) §4.4, [08-RECOMMENDATION.md](08-RECOMMENDATION.md) §3), its exposures can be related to the partner encounter's exposures. Preserve every actual exposure with slate, session, episode and bridge lineage. Pair statistics are derived analytics, not immutable asset metadata or proof of causal independence. The per-item outcome remains marginal; experiment analysis may need clustering or an interference-aware design.

## 3. Gates (hard) and the ranking scalar (soft)

**Publication gates**, checked before an item can be `eligible`. Numeric floors below are illustrative policy settings, not evidence guarantees. A cited sentence must actually be supported; core factual claims cannot pass merely because 60% of sentences carry references. Distinct source tiers do not establish independent origin:

| Rule | Applies to |
|---|---|
| `families ≥ 1` and `claim_coverage ≥ 0.6` | synthesis, documented |
| `families ≥ 2` from different tiers | disputed presentation |
| `witness_alignment ≥ 0.8` and `epistemic ∈ {accept, accept_with_label}` | every generated reel |
| `repetition.template ≥ line` and `repetition.argument ≥ line` against the corpus | every generated item |
| `meaningful_opportunities ≥ 1` | every item (README Law 17: at least one meaningful opportunity) |
| risk tier policy (the existing product evidence policy; configured by version) | every item |
| Mechanism and source support checked | any bridge explanation; actual exposure links are recorded only when selected/seen |

**The ranking scalar** used by the Composer's utility is:

```
quality = 0.5 + 0.5 · ( 0.25·source_tier + 0.2·min(families,3)/3 + 0.2·editorial + 0.15·witness_alignment + 0.2·opportunity )
```

clipped to [0.5, 1.0], so that quality can double an item's utility but never rescue an item below the gates. Repetition against the *person's* history is a separate penalty term in the utility ([08-RECOMMENDATION.md](08-RECOMMENDATION.md) §5), because it is about this person, not the item.

## 4. Fingerprints: catching "the same argument in a different coat"

Three fingerprints per encounter, computed by code at ingest:

- **semantic:** an embedding of the transcript or prose;
- **template:** a hash of the structure — beat count and durations, shot grammar sequence, narration cadence pattern, block types in order (for Scrolls);
- **argument:** a hash of the ordered claim set (claim ids by role).

Two items that share a template and an argument are the same item, whatever their pictures. The publication gate refuses a generated item whose template *and* argument are within the line of an existing corpus item; the Composer refuses to serve an item within the line of anything the person saw in 30 days on any one fingerprint. The lines are calibrated on the seed library.

## 5. Judges, and why they are not trusted alone

The `editorial` score comes from a model judge. The 2026 record on judges is clear: they favour their own generations, they converge on a house style, and the last iteration of a critic loop is not always the best. Guards:

- The reference set is **human**: ~30 examples chosen by the founder with one sentence each on why they work or fail, spanning a quiet precise explanation and an unusual exploratory piece, not only high-energy trailers (the Sept 8 decision E).
- Judging is **pairwise and blinded**: the judge compares the candidate to a reference of the same kind, without the prompt or the brief, and returns which is better on four named dimensions (specific, coherent, visually necessary, want-to-explore) plus a separate error flag. Scores are aggregated into `editorial`; the error flag feeds the gate.
- **Calibration is periodic:** the founder labels a sample of ~20 pairs a month; judge agreement below 0.7 pauses `editorial`'s weight to zero until re-tuned.
- **Self-preference is measured:** the judge model is rotated across the family and its preference for its own generations is tracked; a judge that prefers its own family's outputs ≥ 10 points more than humans do is not used on those outputs.
- **Sequence-level checks** are the harness's job (SeqBench-style: did each beat occur, in order, without contradiction), reported as `witness_alignment` components.

A judge is a **calibration proxy**, not a safety oracle. The runtime review §7.4 makes the broader point: a model's confidence is not calibrated correctness. The same is true of a judge's "this is good" verdict. The verifier is also a model gate ([11-IDEA-ROOMS.md](11-IDEA-ROOMS.md) §3, §6); it carries the same caveat.

## 6. Three structural rules

**Retrieve before generate.** The Quartermaster ([23-CONTENT-DEMAND-AND-INVENTORY.md](23-CONTENT-DEMAND-AND-INVENTORY.md) §3) may open a `ContentDemand` only for a *gap*: an unmet branch request, a forecast shortage in a place, a probe, a room's request, or a challenge with no sourced counterpart in inventory. A demand records its `gap_kind`. There is no demand kind "fill the feed". If inventory has an eligible item for the gap, the demand is not opened. Generation is therefore always *for* something the person did or the world found, and the receipt says which.

**Sources are external only.** The research runner never indexes KnowScroll's own media or Scrolls as sources (the media host and the app's own domains are on the fetch blocklist). A generated reel's narration cannot become a claim. A room's `settled_answer` becomes a substrate claim only with external evidence families. This is the model-collapse guard: the substrate cannot be fed by the engine's own outputs.

**The optimizer is blind to watch time.** No Thompson posterior, utility term, forecast, or reasoning-runtime digest field reads `exposure_s`, session length, or swipe counts as a positive signal. Watch time exists for exposure accounting and for the restricted admin-analytics surface in §10. Viability ([08-RECOMMENDATION.md](08-RECOMMENDATION.md) §1) is a floor computed from fast-skip rates, and it saturates. A change that adds watch time to any optimizer is a policy change that must cite README Law 3 and be recorded as a decision.

## 7. Diversity of kinds, not only topics

Calibration in the Composer ([08-RECOMMENDATION.md](08-RECOMMENDATION.md) §6) is over places; a second calibration is over **intent acts** (`expose, connect, compare, predict, manipulate, reflect, revise`): no act may exceed 50% of a person's last 5 windows, and `predict | manipulate | revise` together must reach ≥ 15% when inventory allows. This keeps a universe from becoming all explanation and no participation, which is the intellectual form of slop.

## 8. Corpus-level monitors

Computed nightly, shown on the operator console, alarmed by threshold. The shared-supply and bridge-link monitors are the September 15 additions:

| Monitor | Alarm when |
|---|---|
| generated share of served items (per person, 30 days) | > 60% |
| source concentration (Herfindahl over evidence families, corpus and per person) | > 0.25 |
| template diversity (distinct templates / items, 30 days) | < 0.4 |
| intent-act distribution | any act > 50% |
| frontier mark rate (marks on frontier items / frontier exposures) | < 0.05 for 14 days (the outside is being ignored — or badly chosen) |
| supply-driven exposure (exposures in places whose inventory is > 3× the median) | > 40% |
| outcome per exposure, generated vs retrieved | generated < 0.6 × retrieved for 30 days (generation is underperforming its cost) |
| judge–human agreement | < 0.7 |
| **shared-supply outcome trend** | a corpus-level outcome trend disappears once shared assets are deduplicated per cohort and generation-policy version |
| **bridge-pair joint outcome** | the per-item `marks` rate is materially higher than the `bridge_pair_marks / bridge_pair_exposures` rate, indicating the bridge is doing the work the items alone could not |
| **corpus outcome by generation-policy version** | outcomes differ across two consecutive policy versions after shared-asset deduplication |

A firing monitor does not change ranking automatically. It writes a `QUESTIONS.md` entry and freezes the relevant production lane until the owner responds. Quality problems are decisions, not knobs.

The shared-supply monitor is the operational form of the runtime review's §18.2 observation that "shared generated inventory creates interference between cohorts: record generation policy and consider asset/cohort or time-block isolation when an experiment changes supply". The bridge-pair joint outcome monitor catches the case where a bridge candidate is carrying the slate, and the items it links are individually under-performing — the inverse of the failure mode where both items get credit for a joint mark.

## 9. Exploration is anti-slop

A closed loop breeds sameness. The frontier share, the challenge family, the 5% random swap, and the revisit schedule are not only for the person's benefit; they are how the corpus keeps meeting material it did not make. Every frontier or challenge exposure is logged as such, so that the "outcome per exposure" monitor can show whether deliberate novelty is doing its job.

## 10. Authorized admin analytics, separately from the serving objective

The September 15 runtime review §18.2 records the founder's clarification: an admin analysis surface is valuable for understanding recommendation failures, inventory gaps, and user journeys, and it is allowed to join selection receipts, actual exposure intervals, user actions, content variants, world changes, and compute receipts in a restricted analysis surface.

What the admin surface **can** do:

- describe what the system served and how long people watched, with the precise watch-hours definition (eligible visible playback intervals, pause/background handling, replay treatment, device/session reconciliation, deduplication);
- correlate watch hours with reported usefulness, voluntary marks, and deferred returns in aggregate;
- monitor supply concentration, frontier performance, and bridge-link outcomes across cohorts;
- replay scripted histories through the engine in a scratch database to test dampers (the replay test in [16-FEEDBACK-LOOPS.md](16-FEEDBACK-LOOPS.md) §4).

What the admin surface **cannot** do:

- feed any watch-derived feature into the Composer's scoring path;
- change a utility weight, a quota, or a gate threshold without a new decision in [steering/DECISIONS.md](../../../steering/DECISIONS.md);
- treat aggregate watch hours as evidence of learning, durable interest, or a causal improvement in recommendations;
- act as a positive optimizer objective for a future policy without that policy being a separate decision.

A prepared or prefetched Reel is not an exposure. Autoplay, a kept item, an opened source, and an explicit question remain separate observations. Operational cost totals can survive content deletion without retaining the deleted text.

## 11. What the engine refuses to learn

- that watch time predicts value;
- that a topic the person watched most deserves the most production;
- that a judge's score is a fact;
- that a verifier's verdict is a fact;
- that bridge-linked exposures are independent observations;
- that two residents citing the same evidence family are independent voices;
- that its own outputs are evidence;
- that consensus among its agents is truth.

Each refusal is a proposed implementation boundary described in this folder: a blind optimizer, a coverage reserve, a calibration gate, a fetch blocklist, a verifier, a `bridge_link` accounting row, a `bridge_pair_*` monitor, a restricted admin analytics surface that is not the serving objective.
