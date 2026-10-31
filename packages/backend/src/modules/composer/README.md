# modules/composer

Composer ranks encounters for Explore (blueprint §9). It has three parts: the pure ranking policy,
a private store of every decision, and **worker-prepared buffers** with an optional model assessment
(Jev). Navigation reads the Personal Context owner's bounded snapshot through `READ_COMPOSER_CONTEXT`.

| Capability | State |
|---|---|
| Pure policy `composeEncounter`, private decisions, erasure | implemented |
| Buffer job `composer.prepare-buffer`, `composer.buffers`, serving from a buffer | implemented (integration-tested; not yet run on dev) |
| Jev (`composer.jev`, `KS_JEV_ENABLED`) | implemented; four real MiniMax calls succeeded locally (M3 x3, M3.1-Flash x1); not yet run on dev |
| Stored-assessment use on the HTTP path | implemented |
| A vertical move leaves the series the person is in (`same_series`, D-131) and its related move (`related_target`, D-136), and stays in the format they are in (`format_sticky`, D-132) | implemented, CI-tested against real PostgreSQL; not yet run on dev |
| Jev reuse: a person's pool of recent assessments, `composer.jev_assessments`; a call only for candidates without one (D-058) | implemented, CI-tested against real PostgreSQL; run locally with the real model (12 activations: 1 call instead of 12); not yet run on dev |
| Jev is a background role: it stops at its share of the daily model budgets and falls back to the deterministic ranking (D-058) | implemented, CI-tested; not yet run on dev |
| Policy v1 (`composer-policy.v1`, D-190): Intent 0.35 to 0.30, a recent-topic penalty of 0.05, Format per play level (D-192), exploration per play level; v0 decisions replay byte for byte | implemented, CI-tested (60 frozen v0 hashes); **off unless `KS_COMPOSER_POLICY=v1`** (default `v0`; dev sets `v1`); the numbers were chosen from the replay of dev's stored decisions (D-190) |
| `composer replay-policy`: stored vertical decisions re-run under v0 and v1, counts only | implemented, CI-tested; run on dev (2026-10-31) over 640 stored decisions, D-190 |
| Jev `jev.2` (D-193): kind, play level, minutes, series part n of m and the myth a Scroll corrects; never play | implemented, unit-tested; one real run on dev still to do |

`composeEncounter(snapshot)` takes an already authorized, immutable prepared snapshot. It performs
no writes, Nest calls, clock reads or network I/O. Experience prepares it
under its live scope, and independently rechecks epoch, current session intent, admission, exact
revision, render negotiation and expected link in the transaction that commits offers/receipts.
A decision/offer/buffer is not an activated encounter and contributes no personal evidence.

## Inputs and experimental policy

A policy is versioned data (`domain/policy.ts`): `composer-policy.v0` and `composer-policy.v1` share maximum
retrieval 100, chosen plus two buffers (maximum 3), MMR lambda 0.2, vertical exploration 0.10, and last 20 actual
activated encounters within 24 hours of explicit `evaluatedAt`. These are code-selected experimental defaults, not
calibrated learned parameters. A decision names its policy and replays under exactly that policy
(`policyOf(decision.policyVersion)`), which `persistComposerDecision` checks byte for byte, so an old decision never
changes with a newer policy. Which policy new decisions are made under is configuration, `KS_COMPOSER_POLICY` (`v0` or
`v1`, default `v0`, read by the API and the worker): v1's numbers were chosen from the dev replay (D-190), and a world uses v1 only when its configuration says so. A stored
decision replays under its own policy whatever the setting, and the replay command always runs both. A change to v1's
numbers after v1 decisions are stored needs `composer-policy.v2` and a migration (D-190).
Seed and all inputs/watermarks are saved; ties use immutable asset/revision lexical order.

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

Vertical first-slot choice is a seeded mixture: ranked winner with mass 0.9 plus uniform eligible
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

Navigation 18 adds an owned decision foreign key from retained offers. Bounded pruning skips decisions
referenced by retained offers in that exact scope/epoch. Their private operator read still refuses
logical expiry after 30 days; physical deletion waits for those references to be removed. No physical
30-day guarantee or maintenance scheduler is claimed. Full AccountScope erasure removes offers before
decisions and remains complete.


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
(`no_eligible_content`), never a repeat. Series, related, variant and return moves are unchanged.

## A subject move is a new topic in the same format

Status: implemented, CI-tested against real PostgreSQL; not yet run on dev. Related: #472, D-131, D-132, D-136.

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
- **Retrieval.** `readVerticalCandidates` reads the person's format first (up to 100) and the other format fills
  the rest of the cap.
- **Buffers.** The worker passes the source's own format, series and related assets, so a buffer is the next topic in the
  source's format. Experience serves it only to a move that names that format.

These fields are optional inputs, so they did not move the label (policy v1 moved it for its own reasons, D-190) and every
stored decision replays unchanged. A move inside a region (Experience) takes none of the rules.

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

**Jev.** `composer.jev` (role version `jev.2`, D-193) runs on the shared reasoning harness (`REASONING_HARNESS`)
inside the buffer job, outside any transaction. For up to 20 of the best eligible candidates by the
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
made under `jev.1` is not reused. `KS_JEV_ENABLED` defaults to 0 and is meant to be 1 on dev. Limit: the generic
personal harness only runs while recording is at its initial generation (a person who has used Pause has no
Jev until the recording-aware harness accepts a Composer purpose).

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
| Job | `composer.prepare-buffer` (concurrency 2, expiry 700 s, 2 retries, no dead letter, payload IDs only) |
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

## Policy replay (D-190)

Status: implemented, CI-tested; not yet run on dev.

`node dist/operator.js composer replay-policy --since <ISO date> [--limit <1-20000>] [--intent-weight <0-1>]
[--recent-topic-penalty <0-1>] [--sweep]` (worker release, server shell) re-runs the retained vertical decisions
recorded since a date, newest first (default 2000), under `composer-policy.v0` and v1 on the same inputs, to choose
the numbers of a policy from real decisions. Read-only: no model, no network, no write. It reads the decisions of
every account in memory and prints one JSON line of **counts and shares only** (no person, universe, session, asset,
title or text):

- `stored (as served)`, then one row per policy: the vertical decisions replayed, those with nothing to offer, and for
  the first offer (the one a pull-up lands on) how many stay on the source's topic, are another part of its series, and
  move to another Jev subject (language and primary topic; each is a possible Jev call under D-058). The same three
  counts for every offer, and how many decisions kept the person's format or fell back from it (`stickyFormat`).
- `skipped`: decisions that are not vertical, whose source is not among their candidates, or that the current schema
  cannot read. `storedPolicies` counts the labels found.
- `--intent-weight` and `--recent-topic-penalty` replay v1 with other numbers; `--sweep` replays v1 over a grid of
  Intent weights {0.35, 0.25, 0.15, 0.10, 0.05} and penalties {0, 0.1, 0.25, 0.4}.

A stored input is first named as today's assembly would name it (`normaliseForReplay`): the series and format the
person was in, and the topics of each recent encounter, taken from candidates the input already holds. Old inputs lack
them, and without them the report would mix the rules of D-131 and D-132 with the weights. The decision table is
unchanged; the command adds no table.
