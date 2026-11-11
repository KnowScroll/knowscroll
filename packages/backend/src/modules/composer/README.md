# modules/composer

## Follow the next subject

A person activates a Reel or Scroll. Experience asks Composer to rank eligible content and queues
preparation of the next subject. The worker can ask Jev about a bounded shortlist; navigation
itself uses stored assessments or deterministic ranking and never waits for a model.

Start at [public.ts](public.ts), [compose](application/compose.ts) and
[buffer preparation](application/prepare-buffer.ts). Both navigation and the buffer worker receive
Personal Context through `READ_COMPOSER_CONTEXT`. A stored decision pins its policy and input;
replay must not reinterpret it with today's weights. A stale buffer falls back to fresh ranking,
not to an old account or intent.

For example, `current_explanation` excludes the explanation already on screen in either format.
It is eligibility, not a small score penalty. Ranking an offer creates no reading evidence.

From the repository root, run
`pnpm --filter @knowscroll/backend exec vitest run src/modules/composer`
for local rules and fixtures. Real-database and installed-process checks use the
[integration suite](../../../../../tests/integration/README.md). Runtime notes below describe
their recorded checks; see [Status](../../../../../docs/STATUS.md) for deployment evidence.

Composer ranks encounters for Explore (blueprint §9). It has three parts: the pure ranking policy,
a private store of every decision, and **worker-prepared buffers** with an optional model assessment
(Jev). Navigation reads the Personal Context owner's bounded snapshot through `READ_COMPOSER_CONTEXT`.

| Capability | State |
|---|---|
| Pure policy `composeEncounter`, private decisions, erasure | implemented |
| Buffer job `composer.prepare-buffer`, `composer.buffers`, serving from a buffer | implemented (integration-tested; no live acceptance is asserted by this entry) |
| Jev (`composer.jev`, `KS_JEV_ENABLED`) | implemented; four real MiniMax calls succeeded locally (M3 x3, M3.1-Flash x1); no live acceptance is asserted by this entry |
| Stored-assessment use on the HTTP path | implemented |
| A vertical move leaves the series the person is in (`same_series`, D-131) and its related move (`related_target`, D-136), and stays in the format they are in (`format_sticky`, D-132) | implemented, CI-tested against real PostgreSQL; no live acceptance is asserted by this entry |
| Jev reuse: a person's pool of recent assessments, `composer.jev_assessments`; a call only for candidates without one (D-058) | implemented, CI-tested against real PostgreSQL; run locally with the real model (12 activations: 1 call instead of 12); no live acceptance is asserted by this entry |
| Jev is a background role: it stops at its share of the daily model budgets and falls back to the deterministic ranking (D-058) | implemented, CI-tested; no live acceptance is asserted by this entry |
| Policy v1 (`composer-policy.v1`, D-190): Intent 0.35 to 0.30, a recent-topic penalty of 0.05, Format per play level (D-192), exploration per play level; v0 decisions replay byte for byte | implemented, CI-tested (60 frozen v0 hashes); **off unless `KS_COMPOSER_POLICY=v1`** (default `v0`; dev sets `v1`); the numbers were chosen from the replay of dev's stored decisions (D-190) |
| `composer replay-policy`: stored vertical decisions re-run under v0, v1 and v2, counts only: topic, series, format, repeats, already-met, tiers and places | implemented, CI-tested; run on dev (2026-10-31) over 640 stored decisions, D-190; the new-content counts are not yet run on dev |
| Policy v2 (`composer-policy.v2`, D-408, #674): a person always gets new content. An explanation already met is left out of every system-chosen offer while anything unseen is eligible (the unseen are ranked as v1 ranks them, so a subject move still usually leaves the topic); only when nothing unseen exists is the least recently met offered, recorded as a fall back. Exploration draws only the unseen at the policy's fraction, ties fall by a seeded hash | implemented, CI-tested (unit, replay, real PostgreSQL); **off unless `KS_COMPOSER_POLICY=v2`**; not yet run on dev |
| Retrieval is a rotating sample (D-408): primary before supporting topic roles, never incidental, ordered by a stable random key from a cursor the decision seed picks, text only when the person supplied text | implemented, CI-tested against real PostgreSQL; applies to every policy (retrieval is outside a frozen snapshot) |
| `composer.prune-decisions`: expired decisions nothing holds are deleted on a schedule, in bounded batches | implemented, CI-tested against real PostgreSQL; offers are not deleted yet, so a decision an offer holds is not reclaimed (see "Private store and lifecycle") |
| Signals for the gap loop (D-414): a v2 decision that fell to the last resort, or offered the last unseen explanation of its topic, records a count in the same transaction, derived from the decision alone; the decision and its replay are unchanged | implemented, CI-tested (unit, real PostgreSQL); **off unless `KS_SUPPLY_GROWTH_ENABLED=1`**; not yet run on dev |
| Jev `jev.2` (D-193): kind, play level, minutes, series part n of m and the myth a Scroll corrects; never play | implemented, unit-tested; one real run on dev still to do |

`composeEncounter(snapshot)` takes an already authorized, immutable prepared snapshot. It performs
no writes, Nest calls, clock reads or network I/O. Experience prepares it
under its live scope, and independently rechecks epoch, current session intent, admission, exact
revision, render negotiation and expected link in the transaction that commits offers/receipts.
A decision/offer/buffer is not an activated encounter and contributes no personal evidence.

## Inputs and experimental policy

A policy is versioned data (`domain/policy.ts`): `composer-policy.v0`, `v1` and `v2` share maximum
retrieval 100, chosen plus two buffers (maximum 3), MMR lambda 0.2, vertical exploration 0.10, and last 20 actual
activated encounters within 24 hours of explicit `evaluatedAt`. v2 keeps every number of v1; it changes rules (below),
and three fields of the policy object name which rule a policy uses: `explorationDraw`, `tieBreak` and `encountered`. These are code-selected experimental defaults, not
calibrated learned parameters. A decision names its policy and replays under exactly that policy
(`policyOf(decision.policyVersion)`), which `persistComposerDecision` checks byte for byte, so an old decision never
changes with a newer policy. Which policy new decisions are made under is configuration, `KS_COMPOSER_POLICY` (`v0`, `v1`
or `v2`, default `v0`, read by the API and the worker): v1's numbers were chosen from the dev replay (D-190), and a world
uses v1 or v2 only when its configuration says so. A stored decision replays under its own policy whatever the setting, and
the replay command always runs every policy. A change to a stored policy's numbers or rules needs a new label and a
migration that widens the pin (v1 needed 0081, v2 needs 0108).
Seed and all inputs/watermarks are saved; ties use immutable asset/revision lexical order under v0 and v1, and under v2 a
hash of the seed and the asset id (see "Policy v2").

Eligibility precedes scoring: admission/access/renderability, language, explicit format, exact
revision, hidden asset, required topics, mode and admitted source/link lineage. `intent.topicIds`
is soft relevance; `requiredTopicIds` is an optional hard intersection-of-requirements. Unknown or
incidental attribution never satisfies a required topic. Return requires an exact target; variant
requires exact explanation identity and explicit format. Horizontal requires a real admitted
link bound to the exact source and candidate target; an expected link ID is hard eligibility.

The equations are blueprint §9 under v0, and v1 for a vertical move (D-190):

- Vertical v0: `.35Intent+.20Interest+.15Format+.15Novelty+.15SemanticFit-.25RecentRepetition`.
- Vertical v1: `.30Intent+.20Interest+.15Format+.15Novelty+.15SemanticFit-.25RecentRepetition-.05RecentTopic`.
- Horizontal (both): `.45Continuity+.25Intent+.15Format+.15SemanticFit-.25RecentRepetition`.

`RecentTopic` (v1, vertical only) is the share of the person's newest three encounters in the recent window that share
a non-incidental topic with the candidate, weighted 3, 2 and 1 out of 6; a missing history is 0. The topics of a recent
encounter come from its frozen attribution (`recent[].topicIds`); the legacy lineage keeps none and counts as neutral.

Every feature is bounded [0,1]. Interest uses prepared actual activity `A/(1+A)`. Format is per
admitted topic and kind `(1+Q)/(2+O)` under v0; unknown measurements do not enter O/Q. Under v1 it is read per play
level of the candidate (`plain`, `stage`, `game`, derived by Content, D-192): `(Q + m*prior)/(O + m)` with the cell's
counts, prior strength `m = 4` and `prior` the rate `(1+Q)/(2+O)` of the person's other levels (the (topic, kind) parent
above less the cell, which the parent counts too, so the cell is not counted twice). A cell with no encounters equals its
parent, and a person with history in one level only is shrunk toward even odds. The
counts are about reading (a qualified response is q >= 0.6) and never about correctness, a pick, a spark or a tier
(D-063): the snapshot schema takes four fields per cell and nothing else. Evidence owns the illustrative 14-day interest half-life and same-time replacement deltas;
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

SemanticFit is `lexical-admitted.v0` unless Jev assessed part of the shortlist (see Jev below):
Jaccard overlap of bounded lowercased Unicode word tokens (maximum 128 unique tokens) from explicit
intent text and admitted title/summary/facets. Missing text is neutral 0.5. The lexical score is the
deterministic fallback; it is never an embedding or model score. When assessments are in play, an
assessed candidate scores its combined criteria and every unassessed candidate scores a neutral 0.5,
because the lexical overlap sits on a much lower scale and would otherwise rank unassessed candidates
below assessed ones by itself. Similarity is same-explanation 1, otherwise mean facet/text overlap;
missing overlap inputs are neutral 0.5. MMR repeatedly takes score minus 0.2 times maximum similarity
to the chosen buffer and deduplicates explanation identity, including format twins.

Vertical first-slot choice is a seeded mixture (policy v2 draws it at `policy.explorationFraction` and from the unseen
candidates only, see "Policy v2"): ranked winner with mass 0.9 plus uniform eligible
exploration pool with mass 0.1 (v1: a member is drawn uniformly and, only when it is a Scroll, replaced by a draw of a
play level present among the pool's Scrolls and then of a Scroll of it, so no level is crowded out while the Reel/Scroll
share of the pool is unchanged; the logged probability is epsilon times that share). FNV-1a/xorshift32 seed policy and rejection-sampled bounded integer
choices are pinned in v0. Logged first-choice probability is `(rankedWinner ? 1-epsilon : 0) +
(inPool ? epsilon/poolSize : 0)`, with epsilon 0 for an empty pool or nonvertical mode. Ties are
deterministic, so no tie mass is invented. Buffers are deterministic conditional on the first
choice; the logged probability is also that conditional-buffer sequence's policy probability.
These are randomized-policy propensities, not response/confidence probabilities.

## Private store and lifecycle

| Table | Purpose / query | Growth / bound | Retention / erasure |
|---|---|---|---|
| `composer.decisions` (`0017`) | Immutable command/session binding, seed, complete bounded input snapshot, scope/epoch, feature/exclusion/score evaluation, selected MMR order/penalties, exploration branch/pool/propensity, versions/fallback/outcome and canonical SHA256 replay hash. Lookup by ID or unique own epoch+command. Own scope/time index supports operator retrieval; the per-universe expiry index and, since 0108, `(expires_at, id)` support pruning. | One per committed decision, JSON<=256KiB; <=100 candidates, <=3 selections. No raw observations, prompts, model output or credentials. | Operator reads refuse logical expiry after 30 days. `pruneComposerDecisions(scope,1..1000)` physically deletes expired unreferenced rows under the caller's existing root lock. The scheduled `composer.prune-decisions` job calls it (below); a decision an offer holds is skipped, and offers are not deleted yet, so physical 30-day deletion is not claimed for those. Full erasure deletes every decision for the universe across epochs. Shared content survives. |

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

Navigation 18 adds an owned decision foreign key from retained offers. Bounded pruning skips decisions
referenced by retained offers in that exact scope/epoch. Their private operator read still refuses
logical expiry after 30 days; physical deletion waits for those references to be removed. No physical
30-day guarantee is claimed. Full AccountScope erasure removes offers before decisions and remains complete.

### Scheduled pruning (`composer.prune-decisions`)

Status: implemented, CI-tested against real PostgreSQL; not yet runtime-verified on dev. Related: #674.

Every thirty minutes (cron `7,37 * * * *`, payload `{ v: 1 }`, names no person) the worker looks for the universes that have a
decision which expired within the last seven days and that no offer and no live buffer holds. It is one range scan of
`composer_decisions_expired_idx` (0108), oldest first, probing `offers_decision_idx` (0108) and the one buffer a universe may
have, so a held decision is passed without being read. For each of at most 25 universes it then enters the personal scope as the
system actor `composer.prune-decisions` (the account, epoch and root lock are rechecked under the lock) and calls
`pruneComposerDecisions` with a batch of 500, which also deletes the universe's expired buffer and Jev pool first. A universe
that is gone, suspended or at a new epoch is refused and skipped; a busy root or a transient failure counts as `failed`,
leaves that universe for the next pass and does not stop the others. No model, network or provider is involved, and a second
pass finds nothing left. Logs `composer.decisions_pruned` (rows deleted; outcome `partial` when a universe was left) only when
something was deleted or left.

Limits. The pass looks only at decisions that expired in the last seven days, so a decision still there after that is held by
an offer (or was missed for a week) and is left for erasure; this keeps a held decision from holding the head of the scan.
Offers are never deleted yet (`experience.offers` has no retention job), and each offer holds its decision, so decisions of
navigations that offered something are not reclaimed until Experience gives offers a retention. What this job reclaims are the
decisions nothing references: an exhausted navigation, and a buffer's decision once its buffer is gone. Experience owns that
follow-up.

**Backfill.** `node dist/operator.js composer prune-backfill [--max-universes <1-5000>]` is the one-off pass with no lookback, so the
old unheld decisions of universes that are never active again are reclaimed. It scans every expired decision once, oldest first,
in pages that continue past the last key read (so held decisions, which are never returned, are not read again), and prunes each
universe it finds in batches of 500 (at most 200 batches a universe) under that universe's own personal scope. Every guard of the
scheduled pass holds: a decision an offer or a live buffer holds is never read or deleted, and a refused or busy universe is
skipped. It stops after `--max-universes` (default 1000) and prints `complete: false`, so it can be run again. Prints counts only.
A decision at a privacy epoch the universe has left is refused each time (erasure removes it) and shows as a universe with nothing
deleted.


## Reading Personal Context

Status: implemented, CI-tested against real PostgreSQL. Related: #235.

The PC-owned adapter maps only `statisticsAvailability: available` rows, including actual A=0.
Requested-but-unobserved default rows stay absent, so the unchanged Composer policy retains neutral
interest 0.5 for missing history. A/Q/O are copied unchanged; Composer's existing A/(1+A) and
(1+Q)/(2+O) scoring equations stay in place. Recent 20, exact candidate established-history probes
and candidate-bounded Hide are retained. Structural support, covered facets, original channels and
provisional inputs are not added to this scoring contract or consumer UI.

Persisted private decisions identify `personal-context.v0`. Both context and established-history
watermarks use `personal-context-composer.v0:<PC revision>:<scope revision>:<latest projection>:not_asserted`.
This binds the read's live scope/epoch/evaluation time while retaining the honest historical
completeness limit. The adapter writes nothing and requests provisionalLimit 0. Production navigation
has no Evidence preparation fallback; an absent PC binding is a startup/DI failure. Legacy Evidence
preparation is opt-in for direct compatibility fixtures only. No shared wire or migration changes
are part of this adapter. Real dev reading/context inspection is still required before closing 235.


## Subject moves never repeat the current explanation

A vertical move (Explore's "Next subject") excludes every candidate whose explanation unit is the one
the person is on, in either format (exclusion `current_explanation`). This is hard eligibility, not a
penalty: the just-activated encounter may not have reached Evidence yet, and the person must never be
offered what is already on screen. With nothing else to offer the move is exhausted
(`no_eligible_content`), never a repeat. Series, related, variant and return moves are unchanged. Under policy v2 every
explanation the person has already met is left out too, not only the one on screen (below).

## A subject move is a new topic in the same format

Status: implemented, CI-tested against real PostgreSQL; no live acceptance is asserted by this entry. Related: #472, D-131, D-132, D-136.

The V3 grammar is swipe left for Part 2 and pull up for a new topic. Three rules in `domain/vertical-rules.ts`
make a vertical move say the second.

- **`same_series`.** The snapshot's `intent.currentSeriesId` names the source's series: its own, or for a Reel that of
  its Scroll twin among the candidates (`sourceSeriesId`). Any candidate of it, in any series revision, and any
  candidate with the explanation unit of one of its parts (the Reel of Part 2), is excluded. With only the series left the move is exhausted. Only vertical moves ask: the
  Part move still reaches the series through its admitted link. A snapshot that names a series on another move
  is refused, so the rule cannot be silently ignored.
- **`format_sticky`.** The snapshot's `intent.stickyFormat` is the format the person is in. While any candidate of
  it is still eligible (after every other exclusion), every candidate of the other format is excluded. When
  none is, nothing is excluded and the decision records `stickyFormat: { preferred, outcome: 'fell_back' }`;
  otherwise `'kept'`. It never reads a stored preference. `intent.format` stays the hard requirement of an
  explicit format switch, and a snapshot cannot carry both.
- **`related_target` (D-136).** The snapshot's `intent.relatedAssetIds` lists what the thread's Related tab reaches
  (`readRelatedAssetIds`: the source, its format twins and every other part of its series among the candidates).
  Those assets and their format twins are excluded unless that would leave nothing eligible, when the rule steps
  aside and the decision records `relatedTarget: { outcome: 'fell_back', matched }`. It runs before sticky format.
- **Retrieval.** `readVerticalCandidates` reads the person's format first (up to 100 less `OTHER_FORMAT_RESERVE`, 20) and the
  other format fills the rest of the cap, so some candidates of the other format are always read, even in a library with
  more than 100 in the person's format (policy v2 needs something to give stickiness way to). It passes the decision's seed to
  retrieval, which rotates each lane by it (see the Content README, "Discovery candidates and continuity").
- **Buffers.** The worker passes the source's own format, series and related assets, so a buffer is the next topic in the
  source's format. Experience serves it only to a move that names that format.

These fields are optional inputs, so they did not move the label (policy v1 moved it for its own reasons, D-190) and every
stored decision replays unchanged. A move inside a region (Experience) takes none of the rules.

## Policy v2: a person always gets new content (D-408)

Status: implemented, CI-tested (unit, replay, real PostgreSQL); **off unless `KS_COMPOSER_POLICY=v2`**; not yet run on dev.
Related: #674, owner decision 2026-11-11.

An explanation the person has already met comes back only as a last resort, when nothing unseen exists in either format. A
Reel and its Scroll twin are one explanation (the same `explanationUnitId`). "Met" is the notion `evidence.established.units[]
.encountered` already carries, verified in `readRoutingHistory`: an activated exposure of that unit in either format (an
encounter lineage row or a recording segment with a first eligible activation, at or before `evaluatedAt`), or an encounter
in the recent window. History that was not read says nothing, so a candidate without it counts as unseen.

**Which moves.** Only a system-chosen move is asked: a vertical move without an exact target (the next subject, and the next
one inside a region). The person's own moves are never repeats and are never asked: resuming, a series part and the related
move (horizontal), the other format of what they are on (variant), a return (an exact target), a saved item or shared link
(an exact target), and a region opened on one encounter (`exactTarget`). Each is a test
(`application/compose-v2.test.ts`, "what the person asks for is not a repeat"; `tests/integration/modules/composer-vertical-moves.test.ts`).

**Eligibility.** After the usual exclusions (admission, language, hidden, `current_explanation`, `same_series` and the
rest), `already_encountered` leaves out every met candidate while any unseen candidate is eligible. It runs before the related
and format rules, so those choose only among what is new: an unseen related item beats a met unrelated one, and a Reel watcher
who has met every Reel gets an unseen Scroll (format stickiness gives way only when no unseen candidate of the person's format
exists, recorded as `stickyFormat: fell_back`). When nothing at all is eligible the outcome is `exhausted`, as before.

**Two tiers.**

1. `unseen`: every eligible candidate the person has not met, in either format. They are ranked exactly as v1 ranks them (the
   same features, weights, MMR and diversity), so topic movement stays what D-190 measured: a subject move usually leaves the
   topic, and an unseen candidate in the source's topic gets no preference beyond its Intent term. Nothing about the source's
   topic or system affects which offers are chosen.
2. `last_resort`: only when no unseen candidate is eligible in either format. The least recently met first
   (`lastEncounteredAt`, the newest activated exposure of the unit in either format; a unit with no recorded time counts as
   the oldest), then by score. The decision says `outcome: fell_back`.

The decision records `unseenLadder`: `outcome` (`unseen`, `fell_back` or `none`), and, for analytics only, where each offer sits
relative to the source (`place` of the first offer, `offerPlaces`, and `eligible`, the eligible candidates by place):
`source_topic` (about a non-incidental topic of the source), `same_system` (about another topic of a catalogue system the
source's topics belong to) or `elsewhere`. The same-system topics are named once at assembly (`intent.systemTopicIds`, from
`systemOfTopic`) and frozen in the snapshot, so a later catalogue never changes a stored decision. The place labels are read by
nothing in selection (a test drops `systemTopicIds` and expects identical offers); they exist so replay and dev can count how
often a subject move stays in the topic under each policy.

**Exploration.** The pool is the unseen eligible candidates, so it is empty in the last resort and never holds a repeat. The
branch is drawn at `policy.explorationFraction` (`explorationDraw: 'by-fraction'`); v0 and v1 keep the literal one in ten they
were stored with (`'one-in-ten'`). The logged probability uses the same fraction. On the exploration branch the first offer is
a uniform pick among the unseen; the offers after it are chosen as usual by MMR.

**Ties.** Equal scores are ordered by a hash of the decision seed and the asset id (`tieBreak: 'seeded-hash'`,
`tieHash`), so cold-start ties fall differently for each person and decision and still replay from the stored seed. v0 and v1
keep the lexical asset/revision order.

**Replay.** v2 is a new label (`composer-policy.v2`) and the pin was widened by migration 0108, as 0081 did for v1. The inputs
v2 reads are optional and ignored by v0 and v1: `intent.systemTopicIds` and `established.units[].lastEncounteredAt`. The 60
frozen v0 hashes and the v1 fixtures are unchanged; a test composes every fixture under v0 and v1 with and without the new
inputs and expects the same decision apart from the stored input. Retrieval is outside a frozen snapshot, so rebuilding it
changes what future snapshots hold and never how a stored decision replays.

**Retrieval reads the unseen first.** Retrieval cannot tell which of a large library the person has met, so a random slice of
100 could hold only what they have met while unseen explanations exist outside it. Under v2 the caller (Experience's navigation,
and the buffer worker) reads the explanation units the person has met through a public port (`ReadMetUnitIds`, implemented by
Experience from its own lineage and recording segments: newest first, at most `UNSEEN_FIRST_MAX_UNITS` = 1000 ids, with a
`truncated` flag when the bound cuts the read) and hands the ids to retrieval as data (`readUnseenFirst`, `unseenFirst: { metUnitIds }`;
Content orders its own rows by `r.explanation_unit_id <> all($n::text[])` and reads no personal table; see the Content README).
Every lane is then read twice, the unseen first and then without the list, so the unseen of the source's topic, then the other unseen, come before any met one, and the met ones
still fill what is left (they are the last resort's material). The source's own unit is always read, so its format twin and its
series are found. The reserve of other-format candidates is read the same way, so a Reel watcher near the end of the Reels has
unseen Scrolls to be given. The list is read only when the configured policy wants it (`ComposeEncounter.policy`), so v0
and v1 retrieve exactly as before. A region's own read (`readRegionCandidates`) takes the same list and only orders the
place's bindings unseen first; nothing is left out, and an `expected` encounter (a region opened on one encounter) is explicit and
unchanged.

**The bound.** The met list holds at most 1000 units, newest first. For a person who has met more, the oldest met units are not
named, so retrieval may order them as unseen (they can take a place in the first band that an unseen explanation would have had).
That only changes which candidates retrieval reads first: the Composer's own `encountered` exclusion reads the real history for the
candidates in the snapshot (exact per-unit probes) and filters the final pick, so a met explanation is still not offered while an
unseen one is eligible (D-408).

**Serve time recheck.** A ranking that promised unseen explanations (`unseenLadder.outcome: 'unseen'`, read from the decision for a
stored buffer) is rechecked in the committing navigation transaction, under the personal lock where the history is authoritative:
Experience reads the prepared history for the at most three selected units and, if any has been met since the ranking (another
device or tab inside a buffer's ten minutes, a slow Jev call, an activation between the two navigation transactions), the offers
are refused as drift. A buffer is then discarded with its decision and the move is ranked again once. A last-resort ranking is not
rechecked, and v0 and v1 are not asked.

**A plan lifts what it lifts under v1.** The best Intent a plan opportunity must tie with is taken over the candidates v1 would
have called eligible (the met ones included), so the ranking among the unseen equals v1's with an active plan.

**Truncation keeps the reserve.** When a snapshot exceeds its byte budget, the first `OTHER_FORMAT_RESERVE` candidates of the
format the person is not in are dropped last, so format stickiness still has unseen candidates to give way to.

Not here. Choosing a topic explicitly and long-term interest selecting candidates belong to the later slices of #674. The content
demand when the unseen run out is the gap loop (below, D-414). Retrieval with a condition probes the person's history once per row it reads; near the end of
a very large library that is more rows than a plain slice, each an index lookup, and slice 4.2's lanes replace it.

## Where content is running out: signals for the gap loop (#674, D-414)

Status: implemented, CI-tested (unit and real PostgreSQL); **off unless `KS_SUPPLY_GROWTH_ENABLED=1`**; not yet run on dev.

A decision under policy v2 already knows whether the person is near the end of what the library has, so it says so, and Supply's gap loop uses it to
start production before they run out. Composer's side is small and pure (`domain/gap-signals.ts`, `gapSignalsOf(decision, maxCandidates)`):

- **`last_resort`**: the decision fell back (`unseenLadder.outcome: 'fell_back'`: nothing unseen was eligible in either format), so the least recently met was
  offered. The signal names the primary topic of the first offer.
- **`low_headroom`**: an unseen explanation was offered (`outcome: 'unseen'`) and it is the last unseen one about its topic: at most one distinct unseen
  explanation (a Reel and its Scroll twin are one) among the eligible candidates about that topic. It is judged only when the snapshot held fewer candidates than the
  policy's maximum: a full snapshot is a sample of the library, and a sample that hides unseen explanations must not read as the end of a topic. The last
  resort needs no such care, because retrieval reads the unseen explanations first (D-408).
- Only a system-chosen vertical move under v2 has a ladder; series, related, variant and return moves, policy v0 and v1, and a decision that offered nothing carry no signal.

It is read from the decision alone and changes nothing in it: the decision, its input, its replay and its stored bytes are exactly what they were, and
the persist port records the signals only after a decision was **newly stored** (`adapters/gap-signal-persist.ts`, `withGapSignals`), in the same
transaction, never for a replay. Composer imports nothing of Supply: the composition roots pass Supply's recorder token to
`composerRecordingProviders` (API and worker, both persist points: the navigation that ranks, and the buffer the worker prepares), and the recorder, not
Composer, decides what is kept (the catalogue's planets only, one mark a person, planet and day, nothing where the loop is off). Composer names no table
of it and reads none of it: demand is never evidence, and `modules/supply/gap-wall.test.ts` holds that for Composer, Evidence, Personal Context and
Geography. See the [Supply README](../supply/README.md#the-gap-loop-content-that-is-running-out-674-d-414).

## Prepared buffers and Jev

Status: implemented, CI-tested against real PostgreSQL. Related: #234.

**Journey.** The person activates an offer in Explore. In the same transaction Experience enqueues
`composer.prepare-buffer` (IDs only: universe, epoch, session, intent revision, source offer and
exposure). The worker ranks the next vertical move for that exact source and stores it. The person's
next "Next subject" from that offer finds the stored ranking and serves it; any other case ranks as
before. No model call or provider wait is ever on the HTTP path.

**Entry points.**

| Surface | Role |
|---|---|
| `prepareBufferQueue`, `PrepareBuffer` (`makePrepareBuffer`) | the worker job and use case |
| `composerBufferProviders` | API side: read, release and request a buffer |
| `composerBufferWorkerProviders` | worker side: the use case, with Jev when `KS_JEV_ENABLED=1` |
| `assembleSnapshot`, `evidenceQueryFor`, `readVerticalCandidates` | shared by the worker and Experience's navigation, so both rank the same inputs |
| `READ_BUFFER_SOURCE`, `READ_HIDDEN_ASSETS` | ports Experience implements (sessions, activations, Hide and Not interested are its tables; a buffer is a subject move, so it leaves out both) |

**What a buffer is.** One row of `composer.buffers` per person and mode (`vertical`). It points at an
ordinary Composer decision (so the offers it produces reference a real decision) and lists up to three
selected offers with the catalogue watermark each had when ranked. It is bound to the session, the
session's intent revision and the source offer and exposure. A buffer is not an encounter and creates
no evidence. The decision is bound to revision + 1, which is the revision the serving navigation commits.

**When a buffer is served.** Transaction 1 of a navigation reads the row for exactly (session, intent
revision, source offer, source exposure) and serves it while it is within its life (10 minutes).
Transaction 2 rechecks every selected offer exactly as for a fresh ranking: still admitted at the exact
revision, same catalogue watermark, not hidden. If anything drifted the buffer and its decision are
deleted and the move is ranked again once. A served buffer's row is deleted in the committing
transaction, so a buffer serves at most once. Transaction 2 also checks that the buffer transaction 1
chose is still there, unreplaced and within its life; if the worker replaced or removed it in between,
the move falls back to the rerank instead of failing. A stale buffer (other intent revision, other
source, past its life, other epoch) is never served.

**Cleanup.** A buffer is one bounded row per person. A navigation that finds the person's buffer past
its life, with no still-valid assessment, deletes it and its decision before reading. The worker's
replacement deletes the previous one. `pruneComposerDecisions` deletes an expired buffer before its
decision and skips decisions a live buffer references. Clear and full erasure remove buffers before
decisions. The same purge deletes the person's stored Jev assessments once every one of them has expired.
There is no separate sweep: an idle person keeps at most one expired buffer row until their next
navigation or erasure, and no expired assessments after `pruneComposerDecisions` runs for them.

**Coalescing and duplicates.** The job carries the intent revision it was made for. A job whose session
has moved on does nothing (`session_superseded`), so a newer activation supersedes older queued jobs.
The primary key (universe, mode) keeps one buffer per person: preparing replaces the previous one and
deletes its decision. A redelivery finds the buffer already prepared and does nothing.

**Jev.** `composer.jev` (role version `jev.2`, D-193) runs on the recording-aware personal harness
(`RECORDING_REASONING_HARNESS`, D-270) inside the buffer job, outside any transaction. For up to 20 of the best eligible candidates by the
deterministic baseline it returns three criteria per candidate, each in [0,1]: relevance to the current
step, appropriateness as a next explanation and redundancy with the current step. Code combines them:
`SemanticFit = 0.4 relevance + 0.4 appropriateness + 0.2 (1 - redundancy)`. Entries naming an unknown or
repeated candidate are dropped. Provider failure, refusal, a budget stop or an unusable answer is the absence
of an assessment: with none at all the lexical baseline applies as before, and nothing is judged negatively.
The harness run ID is the queue job ID, so a redelivery answers from the attempt ledger and a possibly sent
request is never resent. `jev.2` describes each item by public facts of its content only: its kind, how much play it
has, its reading minutes, `Series: part n of m` and the common myth it corrects (so two Scrolls that bust the same myth
are seen as redundant), with the summary cut to fit 900 characters before any of that is. Which option anyone picked,
whether it was right, sparks and tiers are not in the context and have no field in it (D-063). A stored assessment
made under `jev.1` is not reused. `KS_JEV_ENABLED` defaults to 0 and is meant to be 1 on dev.

**Jev follows the recording generation (D-270).** The buffer job names no generation, so the first transaction reads the
generation recording is at (`startRunOwner`) and Jev's run is stamped with it (`purpose` `jev-assessment`, claim the exposure
the job is for). While recording is paused Jev is absent (`refused_scope_refused`): no run, no call, and the buffer is ranked
from the baseline as before. When a run was made, the second transaction (the paid assessments, the decision, the buffer and
the run's close) is one transaction under the recording fence (`commitUnderFence` in `application/prepare-buffer.ts`). A reply
that comes back after a pause or a resume is refused by the engine (`refused_output_ineligible`): there is no run to close, Jev
is absent, and the plain commit stores the baseline decision and buffer at the new generation (a ranking derived from earlier
data, not evidence; nothing of the late reply is in it). After a Clear the root refuses the plain commit too, so nothing is
stored. A change only in the gap between accepting the reply and
storing it refuses that whole transaction: nothing is stored (`recording_changed`; the run is left for the ledger's idle sweep)
and the next navigation ranks for itself. Jev's owner check (`application/check-recording-run.ts`) asks Experience
whether the exposure was activated while recording was on (`CHECK_RECORDED_ACTIVATION`), so an exposure activated while recording
was paused is never assessed, even when its job runs after a resume (the buffer is still ranked from the baseline). It does not
ask whether the session has moved on, because a superseded job still keeps what it paid for. Status: implemented, CI-verified on real PostgreSQL.

**Jev reuses what it paid for (D-058).** A buffer is prepared on every activation, so a person who swipes
all day would otherwise pay for a call per swipe. Each judgement is therefore kept for 30 minutes in the
person's pool, one row of `composer.jev_assessments`, which survives the buffer being served.

- *What a stored judgement is about.* The subject: the language and the primary topic (the heaviest topic
  that is not incidental) of the step the person was on. A step without a topic is its own subject, so its
  judgements are never lent to another step. Candidates of a vertical move are retrieved by the step's
  topics, and "how well does this continue the learner's interest" holds for a later step on the same
  subject. Redundancy with the step the person is on right now is not carried by a stored judgement:
  the current explanation is excluded outright, and recent repetition and novelty are recomputed for every
  ranking.
- *What is reused.* The entries of the current subject that are under 30 minutes old and were made by the same
  role version, harness framing version and model. Anything else is not used and is dropped when the pool is
  next written.
- *When Jev is asked.* Only about shortlisted candidates with no usable entry, and not at all when there are
  none. A call also waits 10 minutes after the subject's newest judgement, because the shortlist drifts by a
  candidate or two with every swipe; the candidates that miss out are ranked as unassessed (neutral 0.5), never
  as bad. A steady swiper therefore costs at most one call per subject per ten minutes, and one per half hour
  when nothing new turns up. In CI, a person who activates 100 encounters on one subject causes 1 call instead of 100.
- *What is kept.* What a call returned is added to the pool in the preparation's second transaction, before the
  checks that may skip the buffer, so a call whose session moved on while the model thought still serves the
  next preparation. The merge happens under the personal lock, so concurrent preparations of one person lose
  nothing. The pool keeps the newest 60 entries.
- *What ranks.* The stored entries of the subject, plus the new ones, for the candidates retrieved this time.
  They are stored in the buffer row as before, valid until the oldest of them expires, so the HTTP path can
  use them after the buffer's own 10 minutes.
- *Background budget.* Jev is a `background` role: it stops at its share of the global and the person's daily
  caps (`KS_REASONING_BACKGROUND_SHARE_PERCENT`), so what a person asks for keeps working. A refused call is
  `budget_exhausted`, the Jev run ends `cancelled`, and the buffer is prepared from the stored judgements, or
  from the deterministic ranking when there are none. Nothing the person sees changes.

**Exploration.** Unchanged: a vertical decision gives the first slot to the exploration pool with
probability 0.10 and logs the branch and the realised probability in the decision; a buffer's decision
logs the same.

**Tables, jobs, lock order, erasure.**

| Item | Detail |
|---|---|
| Tables | `composer.decisions` (0017), `composer.buffers` (0047), `composer.jev_assessments` (0066: one row per person, at most 60 entries, newest first) |
| Job | `composer.prepare-buffer` (concurrency 2, expiry 700 s, 2 retries, no dead letter, payload IDs only); `composer.prune-decisions` (cron `7,37 * * * *`, concurrency 1, expiry 600 s, 1 retry, no dead letter, payload `{ v: 1 }`) |
| Notices | none; the next navigation reads the durable row |
| Lock order | personal root first in both worker transactions; the model call is between them |
| Erasure | Clear and full erasure delete `composer.buffers` before `composer.decisions`, `composer.jev_assessments` (it references nothing), and the queue payloads (`pgboss/composer.prepare-buffer`) |
| Config | `KS_COMPOSER_POLICY` (API and worker, D-190); `KS_JEV_ENABLED` (worker); `KS_REASONING_BACKGROUND_SHARE_PERCENT` (worker, shared with the other background roles); the model is the harness's configured model |

**Failure and recovery.** A job for a changed epoch, an unactivated offer or a superseded revision is
skipped. A thrown error rolls back both transactions and pg-boss retries. A crash after the model call
leaves the run in the attempt ledger under the job ID; the retry reads it and does not pay again, unless the
person's pool changed in between and the request now differs: the harness then refuses the same run ID with a
different request, the preparation goes ahead without new assessments, and nothing is paid twice. The
expired-row purge deletes a pool with no entry left.

## Using the Planner plan (D-035)

Status: implemented, CI-tested against real PostgreSQL. Related: #236.

Personal Context may add the person's current Planner plan to the prepared context as
`evidence.plan`: at most three opportunities, each with its move, topics, explanation unit, suited
threads, formats, expiry and whether its target is admitted content. A plan is not evidence and
creates none. Titles, purposes and briefs never enter the snapshot or the decision.

The base features come first, from the intent and links alone. When the plan has an unexpired
opportunity suited to the move, `domain/plan.ts` then lifts one feature (Intent for a vertical move,
Continuity for a horizontal move) for the eligible candidates that tie for its best base value
(within 0.01) and match an opportunity: `+0.15 × agreement`, capped at 1. Agreement is 1 for the same
explanation in a format the opportunity lists when its target is admitted content, and 0.5 for a shared
non-incidental topic in a listed format. Nothing is scaled down and a candidate below the best is never
lifted, so a plan can only decide between candidates the current intent or link does not separate
and cannot outrank a better match. Return and variant moves ignore plans. Each lifted candidate's
evaluation in the decision carries `plan` with the revision, opportunity position, match, feature and
the value before and after. When every same-topic candidate already has Intent 1 (a source with topics),
the plan changes nothing among them. Capability state: implemented, CI-verified, run locally against the
real model; not yet runtime-verified on dev.

## Policy replay (D-190, D-408)

Status: implemented, CI-tested; no live acceptance is asserted by this entry.

`node dist/operator.js composer replay-policy --since <ISO date> [--limit <1-20000>] [--intent-weight <0-1>]
[--recent-topic-penalty <0-1>] [--sweep]` (worker release, server shell) re-runs the retained vertical decisions
recorded since a date, newest first (default 2000), under `composer-policy.v0`, v1 and v2 on the same inputs, to choose
the numbers of a policy from real decisions and to shadow-compare a new one before a world switches to it. Read-only: no
model, no network, no write. It reads the decisions of every account in memory and prints one JSON line of **counts and
shares only** (no person, universe, session, asset, title or text):

- `stored (as served)`, then one row per policy: the vertical decisions replayed, those with nothing to offer, and for
  the first offer (the one a pull-up lands on) how many stay on the source's topic, are another part of its series, and
  move to another Jev subject (language and primary topic; each is a possible Jev call under D-058). The same three
  counts for every offer, and how many decisions kept the person's format or fell back from it (`stickyFormat`).
- `newContent` per row (D-408): the first offers (`firstOffers`), how many the person had already met (`alreadyMetFirstOffer`,
  and `alreadyMetAllOffers` over every offer), how many repeat another first offer to the same person in the window
  (`repeatedFirstOffer`, every one after the first; each decision is replayed on its own, so a variant's repeats are what its
  choices would repeat if every decision were served), `tiers` (the first offers that were `unseen` and those that were a
  `last_resort`, a met explanation) and `places` (the first offers by where they sit relative to the source: `source_topic`,
  `same_system`, `elsewhere`; analytics, and `source_topic` equals `firstOffer.sameTopic`). Tiers and places are counted for every
  policy by the same definitions, so v0 and v1 show how often they would have given a repeat as `last_resort`. `shares` holds
  `unseenFirstOffer`, `alreadyMetFirstOffer`, `alreadyMetAllOffers` and `repeatFirstOffer`. Beside them, `sameTopicFirstOffer`
  shows what v2 does to topic movement: with nothing met it is the v1 figure.
- `replayedWithHistory`: how many replayed inputs read the person's retained history. An input without it counts everything as
  unseen, so read the met counts only against this number. Inputs stored before v2 carry no `lastEncounteredAt`, so a
  replayed last resort orders those by score.
- `skipped`: decisions that are not vertical, whose source is not among their candidates, or that the current schema
  cannot read. `storedPolicies` counts the labels found.
- `--intent-weight` and `--recent-topic-penalty` replay v1 with other numbers; `--sweep` replays v1 over a grid of
  Intent weights {0.35, 0.25, 0.15, 0.10, 0.05} and penalties {0, 0.1, 0.25, 0.4}. With either, the report compares v0 with
  the weighted v1 variants and leaves v2 out.

A stored input is first named as today's assembly would name it (`normaliseForReplay`): the series and format the
person was in, the topics of each recent encounter and the topics of the source's system, taken from candidates the input
already holds. Old inputs lack them, and without them the report would mix the rules of D-131 and D-132 with the weights. The
decision table is unchanged; the command adds no table.
