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


## Subject moves never repeat the current explanation

A vertical move (Explore's "Next subject") excludes every candidate whose explanation unit is the one
the person is on, in either format (exclusion `current_explanation`). This is hard eligibility, not a
penalty: the just-activated encounter may not have reached Evidence yet, and the person must never be
offered what is already on screen. With nothing else to offer the move is exhausted
(`no_eligible_content`), never a repeat. Series, related, variant and return moves are unchanged.

## Buffers and Jev (#234)

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
| `READ_BUFFER_SOURCE`, `READ_HIDDEN_ASSETS` | ports Experience implements (sessions, activations and Hide are its tables) |

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
decisions. There is no separate sweep: an idle person keeps at most one expired row until their next
navigation, the next preparation or erasure.

**Coalescing and duplicates.** The job carries the intent revision it was made for. A job whose session
has moved on does nothing (`session_superseded`), so a newer activation supersedes older queued jobs.
The primary key (universe, mode) keeps one buffer per person: preparing replaces the previous one and
deletes its decision. A redelivery finds the buffer already prepared and does nothing.

**Jev.** `composer.jev` (role version `jev.1`) runs on the shared reasoning harness (`REASONING_HARNESS`)
inside the buffer job, outside any transaction. For up to 20 of the best eligible candidates by the
deterministic baseline it returns three criteria per candidate, each in [0,1]: relevance to the current
step, appropriateness as a next explanation and redundancy with the current step. Code combines them:
`SemanticFit = 0.4 relevance + 0.4 appropriateness + 0.2 (1 - redundancy)`. Entries naming an unknown or
repeated candidate are dropped. The assessments are stored with the role and prompt versions, the model
and a 30-minute expiry, inside the buffer row, and are reused by a later preparation or by the HTTP
ranking while valid, so the same pair is never paid for twice. Provider failure, refusal, a budget stop
or an unusable answer is the absence of an assessment: with none at all the lexical baseline applies as
before, and nothing is judged negatively. The harness run ID is the queue job ID, so a redelivery answers from the attempt
ledger and a possibly sent request is never resent. `KS_JEV_ENABLED` defaults to 0 and is meant to be 1
on dev. Limit: the generic personal harness only runs while recording is at its initial generation (a
person who has used Pause has no Jev until the recording-aware harness accepts a Composer purpose).

**Exploration.** Unchanged: a vertical decision gives the first slot to the exploration pool with
probability 0.10 and logs the branch and the realised probability in the decision; a buffer's decision
logs the same.

**Tables, jobs, lock order, erasure.**

| Item | Detail |
|---|---|
| Tables | `composer.decisions` (0017), `composer.buffers` (0045) |
| Job | `composer.prepare-buffer` (concurrency 2, expiry 700 s, 2 retries, no dead letter, payload IDs only) |
| Notices | none; the next navigation reads the durable row |
| Lock order | personal root first in both worker transactions; the model call is between them |
| Erasure | Clear and full erasure delete `composer.buffers` before `composer.decisions`, and the queue payloads (`pgboss/composer.prepare-buffer`) |
| Config | `KS_JEV_ENABLED` (worker); the model is the harness's configured model |

**Failure and recovery.** A job for a changed epoch, an unactivated offer or a superseded revision is
skipped. A thrown error rolls back both transactions and pg-boss retries. A crash after the model call
leaves the run in the attempt ledger under the job ID; the retry reads it and does not pay again.
