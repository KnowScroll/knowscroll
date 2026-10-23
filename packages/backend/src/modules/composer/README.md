# modules/composer

Bounded backend slice of #234 / blueprint §9. Pure policy, private persistence and Experience's
navigation consumer are implemented in source. Navigation reads the Personal Context owner's
bounded snapshot through `READ_COMPOSER_CONTEXT`; actual dev acceptance remains coordinator work.
No provider, Jev assessment or new buffer job is installed by this slice.

`composeEncounter(snapshot)` takes an already authorized, immutable prepared snapshot. It performs
no writes, Nest calls, clock reads or network I/O. Experience prepares it
under its live scope, and independently rechecks epoch, current session intent, admission, exact
revision, render negotiation and expected link in the transaction that commits offers/receipts.
A decision/offer/buffer is not an activated encounter and contributes no personal evidence.

## Inputs and experimental policy

`composer-policy.v0` fixes maximum retrieval 100, chosen plus two buffers (maximum 3), MMR lambda 0.2,
vertical exploration 0.10, and last 20 actual activated encounters within 24 hours of explicit
`evaluatedAt`. These are code-selected experimental defaults, not calibrated learned parameters.
Seed and all inputs/watermarks are saved; ties use immutable asset/revision lexical order.

Eligibility precedes scoring: admission/access/renderability, language, explicit format, exact
revision, hidden asset, required topics, mode and admitted source/link lineage. `intent.topicIds`
is soft relevance; `requiredTopicIds` is an optional hard intersection-of-requirements. Unknown or
incidental attribution never satisfies a required topic. Return requires an exact target; variant
requires exact explanation identity and explicit format. Horizontal requires a real admitted
link bound to the exact source and candidate target; an expected link ID is hard eligibility.

The equations are exactly blueprint §9:

- Vertical: `.35Intent+.20Interest+.15Format+.15Novelty+.15SemanticFit-.25RecentRepetition`.
- Horizontal: `.45Continuity+.25Intent+.15Format+.15SemanticFit-.25RecentRepetition`.

Every feature is bounded [0,1]. Interest uses prepared actual activity `A/(1+A)`. Format is per
admitted topic and kind `(1+Q)/(2+O)`; unknown measurements do not enter O/Q. Evidence owns the illustrative 14-day interest half-life and same-time replacement deltas;
Personal Context owns its revisioned snapshot and qualified structural support. Composer changes
neither. Its existing backend-only `ReadPreparedEvidenceInput` capability is implemented by the
PC compatibility adapter without a second aggregate or scoring equation. Missing topic history/format/continuity/semantic assessment
is neutral 0.5; unused attribution mass is also neutral 0.5. Absent recent encounters means zero
recent repetition. Missing established history is neutral novelty 0.5, never an assertion of newness.
An optional bounded/versioned candidate-relevant established-history input probes actual retained
encounters by explanation and admitted facet (maximum 100 units, 16 facets/unit); explicit unseen
results can establish novelty, while seen explanations/facets reduce it even after 24 hours.
This is a routing history fact, never proof of learning, belief or identity. The prepared input/query capability requests exact candidate explanation/facet refs through the
PC owner's routing projection. These routing facets never become qualified formation coverage. Novelty is one minus the maximum of established repetition and
known actual recent overlap; absent facet probes are neutral, not unseen. Actual recent explanation
matches repeat 1 across format siblings; other
recent repetition uses facet overlap (unknown facets neutral 0.5). Prepared offers are absent from
the recent-input type. Input lineage, count consistency, time order, unique IDs and bounds are
validated, including same universe/epoch/evaluation time/context watermark.

`lexical-admitted.v0` is the **only** SemanticFit implementation: Jaccard overlap of bounded
lowercased Unicode word tokens (maximum 128 unique tokens) from explicit intent text and admitted
title/summary/facets. Missing text is neutral 0.5. It is a documented deterministic fallback, never
an embedding/model/Jev score. Similarity is same-explanation 1, otherwise mean facet/text overlap;
missing overlap inputs are neutral 0.5. MMR repeatedly takes score minus 0.2 times maximum similarity
to the chosen buffer and deduplicates explanation identity, including format twins.

Vertical first-slot choice is a seeded mixture: ranked winner with mass 0.9 plus uniform eligible
exploration pool with mass 0.1. FNV-1a/xorshift32 seed policy and rejection-sampled bounded integer
choices are pinned in v0. Logged first-choice probability is `(rankedWinner ? 1-epsilon : 0) +
(inPool ? epsilon/poolSize : 0)`, with epsilon0 for an empty pool or nonvertical mode. Ties are
deterministic, so no tie mass is invented. Buffers are deterministic conditional on the first
choice; the logged probability is also that conditional-buffer sequence's policy probability.
These are randomized-policy propensities, not response/confidence probabilities.

## Private store and lifecycle

| Table | Purpose / query | Growth / bound | Retention / erasure |
|---|---|---|---|
| `composer.decisions` (`0017`) | Immutable command/session binding, seed, complete bounded input snapshot, scope/epoch, feature/exclusion/score evaluation, selected MMR order/penalties, exploration branch/pool/propensity, versions/fallback/outcome and canonical SHA256 replay hash. Lookup by ID or unique own epoch+command. Own scope/time index supports operator retrieval and expiry index supports pruning. | One per committed decision, JSON<=256KiB; <=100 candidates, <=3 selections. No raw observations, prompts, model output or credentials. | Operator reads refuse logical expiry after 30 days. `pruneComposerDecisions(scope,1..1000)` physically deletes expired unreferenced rows under the caller's existing root lock; **maintenance wiring is pending**, so physical 30-day deletion is not claimed. Full erasure deletes every decision for the universe across epochs. Shared content survives. |

`persistComposerDecision` requires the existing `PersonalScopeTx`, validates scope/epoch and binding,
recomputes the pure output, and hashes canonical binding+decision bytes. Identical replay is a no-op;
changed IDs/inputs/output or foreign-scope collisions refuse. It opens no nested transaction. Experience commits this port with its receipt/session/offer changes atomically.
No session foreign key is invented before that owner's schema exists.

`readComposerDecision` is available only through an adapter requiring an authenticated operator
allowlist predicate at composition; it rechecks own live scope/epoch and logical expiry. There is
no consumer diagnostic wire/UI. General logs receive none of these private IDs/features. No queue,
non-row cache, exported decision file or new scheduler is introduced by this slice.

Verification: labelled pure/property and real-PostgreSQL CI tests; suites run in GitHub Actions
only. Source/type generation/static checks do not prove a connected runtime journey.

Navigation18 adds an owned decision foreign key from retained offers. Bounded pruning skips decisions
referenced by retained offers in that exact scope/epoch. Their private operator read still refuses
logical expiry after30days; physical deletion waits for those references to be removed. No physical
30-day guarantee or maintenance scheduler is claimed. Full AccountScope erasure removes offers before
decisions and remains complete.


## Personal Context consumer (#235)

The PC-owned adapter maps only `statisticsAvailability: available` rows, including actual A=0.
Requested-but-unobserved default rows stay absent, so the unchanged Composer policy retains neutral
interest0.5 for missing history. A/Q/O are copied unchanged; Composer's existing A/(1+A) and
(1+Q)/(2+O) scoring equations stay in place. Recent20, exact candidate established-history probes
and candidate-bounded Hide are retained. Structural support, covered facets, original channels and
provisional inputs are not added to this scoring contract or consumer UI.

Persisted private decisions identify `personal-context.v0`. Both context and established-history
watermarks use `personal-context-composer.v0:<PC revision>:<scope revision>:<latest projection>:not_asserted`.
This binds the read's live scope/epoch/evaluation time while retaining the honest historical
completeness limit. The adapter writes nothing and requests provisionalLimit0. Production navigation
has no Evidence preparation fallback; an absent PC binding is a startup/DI failure. Legacy Evidence
preparation is opt-in for direct compatibility fixtures only. No shared wire or migration changes
are part of this adapter. Real dev reading/context inspection is still required before closing235.


## Planner plan (#236, D-035)

Personal Context may add the person's current Planner plan to the prepared context as
`evidence.plan`: at most three opportunities, each with its move, topics, explanation unit, suited
threads, formats, expiry and whether its target is admitted content. A plan is not evidence and
creates none. Titles, purposes and briefs never enter the snapshot or the decision.

When the plan has an unexpired opportunity suited to the move, `domain/plan.ts` blends it into one
feature: Intent for a vertical move, Continuity for a horizontal move.
`feature = 0.75 × base + 0.25 × agreement`. Agreement is 1 for the same explanation in a format the
opportunity lists when its target is admitted content, 0.5 for a shared non-incidental topic in a
listed format and 0 otherwise. Without a suited opportunity the features are unchanged, and return
and variant moves ignore plans. A candidate that matches the current intent keeps at least 0.75 and
one that does not keeps at most 0.25, so current intent decides first. Each matched candidate's
evaluation in the decision carries `plan` with the revision, opportunity position, match, feature
and the value before and after. Capability state: implemented, CI-verified, run locally against the
real model; not yet runtime-verified on dev.
