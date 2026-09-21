# ADR-0029 — A real Composer contract: retrieval, recorded-signal ranking, diversity and true explanations

Date: 2026-09-21. Status: accepted, contract only, for #114/#5. No consumer is added or changed.
Builds on [ADR-0004](0004-ledger-events-derived.md) (ledger/exposure lineage), [ADR-0016](0016-explicit-ask-facts.md)
(no paid dispatch; reasoning stays SQL primitives) and [ADR-0025](0025-eligible-reels-in-inventory.md)
(Reel and Scroll are the two consumption objects the feed and the Composer both address). Reads
`packages/core/AGENTS.md`: "The current Composer is only editorial-unkept-v1... Changing ranking
requires policy versions and journey evidence."

## Context

`packages/core/src/composer.ts` is `editorial-unkept-v1`: exclude what is kept, take the first three
remaining candidates in feed order, and attach one of two hand-written reason strings depending on
whether anything has ever been kept. It is not a recommender in any sense the target design
([08-RECOMMENDATION.md](../architecture/target/08-RECOMMENDATION.md)) uses the word, and this repo's
own AGENTS.md says so explicitly. There is no retrieval beyond "everything eligible," no ranking
signal beyond kept-exclusion, no diversity control, and the explanation is canned prose selected by
one boolean — it does not come from the same computation that ordered the slate, because there is no
such computation yet.

`decision` already has the right shape to carry a real Composer's output — `policy_version`,
`candidates`, `account_revision` — but nothing records *why* a policy ordered candidates the way it
did, only what it returned. `exposure` already carries per-asset exposure history (count and
recency, derivable per `(universe_id, asset_id)`); `accounts.kept_asset_ids` already carries the Keep
signal; `asset.source_title`/`source_url` already carry source identity. Every signal the issue asks
for is already durable somewhere in this schema. What is missing is a place to freeze the *snapshot*
of those signals a ranking actually used, so a later reader — or a later version of the Composer
itself — can check the claim instead of trusting it.

This ADR is contract only: a versioned policy table, a signal-recording table, a registered
explanation vocabulary, and the database-level invariants tying them together. It does not touch
`packages/core/src/composer.ts`, `apps/api/src/app.ts`, or any other consumer. `decision.ranking_version`
stays `NULL` for every decision the running system makes until a separate slice writes the real
ranking function and starts setting it — this migration proves that a *future* implementation is
possible and inspectable; it does not build one.

## Decision

### 1. Retrieval is unchanged

Retrieval stays exactly `feedCandidates()` (ADR-0024/0025's eligible-inventory query, `kinds`-gated,
Scroll and Reel together) minus `accounts.kept_asset_ids`. This ADR adds nothing to eligibility and
nothing to what counts as a candidate; it only adds a way to record how the candidates that already
exist were ordered and explained.

### 2. Ranking is a versioned SQL-primitive policy, never a provider call

`composer_policy(version, weights, slate_size, max_per_source)` is the versioned ranking
configuration `packages/core/AGENTS.md` requires instead of code constants. Rows are immutable once
created (same trigger discipline as `publication_policy`): a policy version means the same weights
forever, which is the precondition for "the same universe state and the same candidate set produce
the same ordering" being a checkable claim rather than an assertion. A ranking implementation
computes `weights` against **only** columns this schema already populates without a network call —
exposure count and recency from `exposure`, unread from their absence, kept from
`accounts.kept_asset_ids`, source from `asset.source_title`/`source_url` — one bounded SQL query plus
a pure in-process scoring function. **ADR-0016 stands**: nothing in this slice, or in any future
implementation that uses this schema, may dispatch to a paid model; `packages/core` still takes no
database, HTTP, provider or UI imports (`packages/core/AGENTS.md`), so a real Composer's *scoring*
stays a pure function over a signal snapshot fetched by its caller — exactly the shape
`feedCandidates()`/`compose()` already have today.

### 3. Diversity is a policy parameter, enforced at commit

`composer_policy.max_per_source` bounds how many candidates from one `sourceKey` may appear in one
slate (`CHECK max_per_source <= slate_size`, so a policy cannot define a cap that is not actually a
constraint). A deferred constraint trigger on `decision_signal` checks, at transaction commit, that
no source exceeds that decision's own policy's cap — so a ranking implementation may insert its
per-candidate rows in any order within one transaction, but cannot commit a slate that violates its
own declared policy. A decision that names no `composer_policy` (`ranking_version IS NULL`, every
decision made before this migration and every bootstrap-policy decision made after it) is untouched:
this ADR adds no constraint to a policy it does not participate in.

### 4. The ranking inputs are recorded with the recommendation

`decision_signal` holds one row per candidate a ranked decision returned: `rank`, `retrieval_score`,
and `inputs` — a JSON object required to carry exactly the recorded facts a real ranking would use
(`exposureCount`, `lastExposedAt`, `unread`, `sourceKey`, `recencyDays`, `sourceRankInSlate`), typed
and structurally checked by the database itself, not merely promised by a caller. Two structural
`CHECK`s tie `unread` to `lastExposedAt`/`recencyDays` so a row cannot claim "never shown" while also
recording when it was last shown, or claim a prior exposure while recording no recency — the
database refuses the self-contradiction outright, at `INSERT` time, before any deferred check runs.

A deferred constraint trigger (`composer_signal_coverage`, checked at commit so a decision and its
signal rows may be inserted in either order within one transaction) requires that a decision naming a
`composer_policy` records **exactly** one signal row per candidate in its own `candidates` array — the
identical set of asset ids, no more, no fewer. No ranked item may be shown without a recorded reason,
and the row identifying that reason cannot outlive the candidate it explained or attach to one that
was never returned.

A second deferred trigger (`composer_rank_score_consistent`) refuses a `decision_signal` set where a
higher rank (shown earlier) records a strictly lower `retrieval_score` than a lower rank — the
database refuses an ordering that contradicts the very evidence recorded for it. Together these two
triggers are what "a ranking can be reproduced and argued with" means concretely: given an immutable
policy version and the recorded `inputs` for every candidate, a reader (or a test) can recompute the
score and confirm the recorded rank matches it, and can never find a rank whose supporting evidence
is missing or self-contradictory.

### 5. An explanation that is true, because it cannot be anything else

`composer_explanation_template(explanation_key, template)` is the fixed, versioned vocabulary of
why-this-appeared reasons. Every `decision_signal` row names an `explanation_key` by foreign key — an
explanation cannot reference a key that was never registered. Every template's placeholders are
checked, at `INSERT` time, against the exact set of fields `decision_signal.inputs` is allowed to
carry (plus one optional passthrough, `sourceTitle`, copied verbatim from `asset.source_title`): a
template can only ever say `{{recencyDays}}` or `{{sourceTitle}}`, never `{{beliefScore}}` or
`{{interestLevel}}`, because no such field exists anywhere in this schema for it to cite. Rendering a
reason is then arithmetic, not authorship: substitute the recorded `inputs` for that candidate into
its recorded template. The same signals that produced the ranking are, by construction, the only
inputs available to produce its explanation. This retires the present canned-boolean reason string
the moment a real implementation starts setting `ranking_version` — that retirement is not part of
this contract-only slice.

Nothing stored or rendered here may claim the reader "is interested in," "prefers," or "will like"
anything (AGENTS.md: behavior is evidence, not proof of belief). Every required `inputs` field and
every seed template describes only what was recorded (a count, a timestamp, a source, an absence)
and what followed (a rank, a slate position) — never a belief about the person.

### 6. Privacy erasure needs no new code

`decision_signal` carries a same-transaction `FOREIGN KEY (decision_id, universe_id) REFERENCES
decision(id, universe_id) ON DELETE CASCADE`. ADR-0010's Clear Scroll History already hard-deletes
`decision` rows (`packages/db/src/privacy.ts`: `DELETE FROM decision WHERE universe_id=$1`); the
cascade means every `decision_signal` row for that universe is removed in the same statement, without
`privacy.ts` needing to know this table exists. `composer_policy` and `composer_explanation_template`
are not private history — like `publication_policy`, they describe the system's own ranking logic,
not a person's — and are never touched by Clear.

### 7. Determinism

The property this ADR requires — same universe state and same candidate set produce the same
ordering — rests on three things this migration puts in place: (a) `composer_policy` rows are
immutable, so a policy version is a fixed function forever; (b) `decision_signal.rank` is
`UNIQUE(decision_id, rank)`, so a real implementation must resolve every tie to a strict total order
(a stable secondary key, e.g. `asset_id` — see section 8 for why `asset_id` alone is not a
sufficient secondary key) rather than leaving it to insertion order or wall-clock
timing; (c) the recorded `inputs` snapshot is exactly what a pure scoring function may read — no
signal a real implementation uses may come from anywhere outside what `decision_signal.inputs` is
structurally required to hold. A later implementation's own test suite proves determinism directly:
replay the same recorded `inputs` through the same (immutable) policy's scoring function and assert
byte-identical `rank`/`explanation_key` output. That replay is only possible because this schema
recorded the exact inputs rather than only the outcome.

### 8. Amendment (2026-09-21, #113): a coverage tie-break, and the guarantee it buys

The implementation slice this ADR anticipated (section "Consequences") landed on `claude/114-composer`
as `composer-signals-v1` (migration 0019) and now `packages/core/src/composer.ts`. Rebasing it onto
main after the semantic-worlds slice (#112) exposed a real defect, not a cosmetic one: `unreadBonus`
makes every never-exposed candidate score identically, and the only tie-break was a hash of
`assetId` — deterministic, but carrying no information about whether a *source*, as opposed to one
asset, had ever been offered. In a library with more unread assets than slate slots, a source whose
assets happen to hash unfavorably relative to an abundant, low-hashing source can lose every tie
indefinitely; #113 observed twelve consecutive decisions offering no candidate from one specific
source at all.

This is a product law, not a scale worry (root AGENTS.md: "an emergent personal universe" built
"from what its reader actually encounters"). A source that can never be offered is inventory a
reader can never encounter, so per ADR-0028 it can never become a world, never join a system, and
never appear in an explanation — the ranking would be quietly deciding that part of the library does
not exist, a decision nothing recorded and nobody could see. What made the original tie-break
indefensible specifically was that `assetId` is a random UUID: the ordering was perfectly
deterministic and completely arbitrary, and there was no sense in which the losing source deserved
to lose.

**The fix.** Among candidates whose score is otherwise equal, prefer the source with the fewest
recorded exposures in this universe (`SignalCandidate.sourceExposureCount`,
`packages/db/src/composer-signals.ts`'s own bounded query over `exposure` joined to `asset`, scoped
to the sourceKeys already present in the request's candidate set); fall back to the original
hash-of-`assetId` tie-break only among candidates coverage cannot separate either (e.g. two
candidates from the same, still-unread source, or two sources neither of which this universe has
ever recorded an exposure for). `unreadBonus` still dominates the score outright and `max_per_source`
still caps how much one source can take in a single slate — this tie-break only decides who wins
when the existing signals have said nothing.

**The guarantee.** Every source in the library is eventually offered: offering a source's candidates
and a reader then encountering them is the one thing that raises that source's own recorded exposure
count, which lowers its coverage-tie-break priority the next time ties must be broken. No source can
sit behind another indefinitely purely because of an accident of id allocation — only because this
universe's own recorded history says another source has been seen less. This does not claim every
source is offered *quickly*, or on any particular reader's very first request (a source with no
recorded history anywhere ties with every other untouched source and still falls back to the hash
tie-break among them) — only that nothing about the ranking itself can leave a source permanently
unreachable once other sources it was tied against start accumulating exposures.

**Why a new policy version, not an edit to `composer-signals-v1`.** `packages/core/AGENTS.md`:
"Changing ranking requires a new policy version ... never a code-constant edit to the scoring
function." A tie-break rule is part of what a ranking computes — section 7 above rests the whole
determinism property on `composer_policy` rows being "a fixed function forever." So this amendment
does not touch migration 0019's `composer-signals-v1` row, which stays registered, immutable and
exactly as seeded; migration 0021 instead registers `composer-signals-v2` (identical published
weights, slate_size and max_per_source — the score formula is unchanged) and
`packages/core/src/composer.ts` is updated so the shared ranking function always applies the coverage
tie-break. `apps/api/src/app.ts` now loads `composer-signals-v2`; `composer-signals-v1`'s row remains
present as an inert historical artifact, never loaded by any code path from here on. Migration 0021
also extends `decision_signal.inputs`'s structural requirements (additive to migration 0018's own
`?&` check, never relaxing it) to require the new `sourceExposureCount` fact, so the coverage signal
a ranking actually used is recorded honestly with the decision, not merely implied by the code that
produced it.

**What remains unproved by this amendment specifically:** that `composer-signals-v2`'s bound on *how
quickly* a source is reached is tight or well-characterized in general (only demonstrated for the
specific library shapes this slice's own tests construct); no new user-facing journey evidence was
authored for this amendment beyond what `composer-signals-v1`'s own implementation already deferred.

## Alternatives and why

- *Keep ranking as code constants in `packages/core`:* contradicts `packages/core/AGENTS.md` directly
  ("changing ranking requires policy versions") and makes a ranking non-reproducible from history —
  redeploying the code changes past explanations retroactively. Rejected.
- *Record only the final reason string, not the signals:* is exactly today's canned-string status
  quo carried forward under a new name; unauditable, and gives a later reader nothing to check the
  claim against. Rejected — the issue is explicit that "today's reason strings are canned; that ends
  here."
- *Enforce diversity with a plain (non-deferred) `CHECK`:* a per-source count is a property of the
  whole slate, not of one row, and a slate is necessarily built as several inserts within one
  transaction; a same-statement `CHECK` cannot see sibling rows. A deferred constraint trigger is the
  smallest mechanism that lets the whole slate be validated exactly once, at commit. `CHECK`
  constraints are used everywhere they suffice (the honesty checks on `inputs` are plain `CHECK`s,
  since they only ever look at one row).
- *A live model or embedding similarity as a ranking signal:* is paid provider dispatch, forbidden
  outright by ADR-0016 for this slice and not something a "SQL primitives" reasoning boundary can
  contain. Rejected; not part of this contract.
- *Delete `decision_signal` explicitly inside `privacy.ts`:* adds a fourth erasure statement that a
  future editor of that file could forget to keep in sync with a new signal table. `ON DELETE
  CASCADE` from the already-erased `decision` row makes the correct behavior the only possible one,
  and needs no consumer change at all — which matches this ADR's own contract-only scope.
- *Let the caller freely write any reason string per item:* is what `editorial-unkept-v1` already
  does, and is precisely the "canned reason" problem. The registered-template + placeholder-whitelist
  design makes a hand-authored, signal-free explanation a schema violation, not a code-review
  discipline that can lapse.

## Consequences

Nothing in the running system changes today. `packages/core/src/composer.ts` still implements
`editorial-unkept-v1`; `apps/api/src/app.ts` still inserts `decision` rows with `ranking_version`
left `NULL` (the column default); no `composer_policy`, `composer_explanation_template` or
`decision_signal` row is ever written by anything currently deployed. Existing tests, existing
`decision`/`exposure`/`trace` behavior and every currently passing journey are unaffected — proven by
`pnpm test` (660/660) and `pnpm typecheck` against this migration.

A future slice that implements the real Composer must, in one transaction per `GET /v1/feed` call:
insert the `decision` row with a real `ranking_version`, and insert one `decision_signal` row per
returned candidate whose `inputs` match this schema's required shape and whose `rank` is consistent
with its `retrieval_score` — the database will refuse a decision that gets any of this wrong, loudly,
at commit, rather than silently serving an unreasoned slate. That slice owns: the retrieval-time
signal query (exposure counts/recency, unread, source), the scoring function, the tie-break rule, the
diversity re-ranking step, the seed rows for `composer-signals-v1`'s actual weights, the wire contract
change for returning a reason to clients, and journey evidence (a new journey, since none of J001–J008
covers ranking). None of that is done here.

## What remains unproved

This is schema only, verified by direct SQL exercise of every invariant against a disposable
`knowscroll_test_*` database (not committed as a test, since this slice adds no consumer for a test
to exercise): a full valid slate commits; an incomplete slate, a rank/score contradiction, an
over-concentrated source, an unregistered explanation template, and an unread/recency
self-contradiction are each refused by name (the exact PL/pgSQL function or `CHECK` that fired was
confirmed for every case); `decision_signal` rows resist `UPDATE`; deleting a `decision` cascades to
its `decision_signal` rows. What is **not** proved by anything in this ADR: that any future scoring
function built on this schema produces a *useful* slate, that the chosen signal set (exposure count,
recency, unread, source) is the right one, or that the placeholder vocabulary in
`composer_explanation_template` reads well to a person — those require the implementation slice and
its own journey evidence, not a migration.

Sources: [issue #5](https://github.com/KnowScroll/knowscroll/issues/5),
[target recommendation design](../architecture/target/08-RECOMMENDATION.md) (design reference only,
not adopted here — this ADR is a deliberately smaller, SQL-primitive contract, not that chapter's
multi-term utility engine), `packages/core/AGENTS.md`, [ADR-0016](0016-explicit-ask-facts.md),
[ADR-0025](0025-eligible-reels-in-inventory.md), migration `0022_composer_ranking_signals.sql`.
