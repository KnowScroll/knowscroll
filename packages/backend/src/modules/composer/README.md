# modules/composer

Bounded backend slice of #234 / blueprint §9. The pure policy and private persistence are implemented;
no Experience navigation consumer, HTTP route, prepared activity projector, buffer job, provider,
Jev assessment, browser journey or deployment is installed here. #234 and J1/J5 remain incomplete.

`composeEncounter(snapshot)` takes an already authorized, immutable prepared snapshot. It performs
no writes, Nest calls, clock reads or network I/O. The later Experience application must prepare it
under its live scope, then independently recheck epoch, current session intent, admission, exact
revision, render negotiation and expected link in the transaction that commits offers/receipts.
A decision/offer/buffer is not an activated encounter and contributes no personal evidence.

## Inputs and experimental policy

`composer-policy.v0` fixes maximum retrieval100, chosen plus two buffers (maximum3), MMR lambda0.2,
vertical exploration0.10, and last20 actual activated encounters within24hours of explicit
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

Every feature is bounded[0,1]. Interest uses prepared actual activity `A/(1+A)`. Format is per
admitted topic and kind `(1+Q)/(2+O)`; unknown measurements do not enter O/Q. The later evidence
projector owns the illustrative14day interest half-life, replacement deltas and formation inputs;
Composer does not form them. `ReadPreparedEvidenceInput` is a capability contract for that future
owner, with no fake implementation. Missing topic history/format/continuity/semantic assessment
is neutral0.5; unused attribution mass is also neutral0.5. Absent recent encounters means zero
repetition and novelty1. Actual recent explanation matches repeat1 across format siblings; other
recent repetition uses facet overlap (unknown facets neutral0.5). Prepared offers are absent from
the recent-input type. Input lineage, count consistency, time order, unique IDs and bounds are
validated, including same universe/epoch/evaluation time/context watermark.

`lexical-admitted.v0` is the **only** SemanticFit implementation: Jaccard overlap of bounded
lowercased Unicode word tokens (maximum128 unique tokens) from explicit intent text and admitted
title/summary/facets. Missing text is neutral0.5. It is a documented deterministic fallback, never
an embedding/model/Jev score. Similarity is same-explanation1, otherwise mean facet/text overlap;
missing overlap inputs are neutral0.5. MMR repeatedly takes score minus0.2 times maximum similarity
to the chosen buffer and deduplicates explanation identity, including format twins.

Vertical first-slot choice is a seeded mixture: ranked winner with mass0.9 plus uniform eligible
exploration pool with mass0.1. FNV-1a/xorshift32 seed policy and rejection-sampled bounded integer
choices are pinned in v0. Logged first-choice probability is `(rankedWinner ? 1-epsilon : 0) +
(inPool ? epsilon/poolSize : 0)`, with epsilon0 for an empty pool or nonvertical mode. Ties are
deterministic, so no tie mass is invented. Buffers are deterministic conditional on the first
choice; the logged probability is also that conditional-buffer sequence's policy probability.
These are randomized-policy propensities, not response/confidence probabilities.

## Private store and lifecycle

| Table | Purpose / query | Growth / bound | Retention / erasure |
|---|---|---|---|
| `composer.decisions` (`0017`) | Immutable command/session binding, seed, complete bounded input snapshot, scope/epoch, feature/exclusion/score evaluation, selected MMR order/penalties, exploration branch/pool/propensity, versions/fallback/outcome and canonical SHA256 replay hash. Lookup by ID or unique own epoch+command. Own scope/time index supports operator retrieval and expiry index supports pruning. | One per committed decision, JSON<=256KiB; <=100 candidates, <=3 selections. No raw observations, prompts, model output or credentials. | Operator reads refuse logical expiry after30days. `pruneComposerDecisions(scope,1..1000)` physically deletes expired rows under the caller's existing root lock; **maintenance wiring is pending**, so physical30day deletion is not claimed. Full erasure deletes every decision for the universe across epochs. Shared content survives. |

`persistComposerDecision` requires the existing `PersonalScopeTx`, validates scope/epoch and binding,
recomputes the pure output, and hashes canonical binding+decision bytes. Identical replay is a no-op;
changed IDs/inputs/output or foreign-scope collisions refuse. It opens no nested transaction. The
later Experience owner must commit this port with its receipt/session/offer changes atomically.
No session foreign key is invented before that owner's schema exists.

`readComposerDecision` is available only through an adapter requiring an authenticated operator
allowlist predicate at composition; it rechecks own live scope/epoch and logical expiry. There is
no consumer diagnostic wire/UI. General logs receive none of these private IDs/features. No queue,
non-row cache, exported decision file or new scheduler is introduced by this slice.

Verification: labelled pure/property and real-PostgreSQL CI tests; suites run in GitHub Actions
only. Source/type generation/static checks do not prove a connected runtime journey.
