# modules/personal-context

Personal Context gives backend callers a bounded view of a person's exploration. Evidence owns
qualification and activity arithmetic; this module owns the revisioned structural projection and
reads Evidence's statistics without making a second aggregate. Composer reads that view to rank
eligible content. Planner reads it to propose opportunities. Geography uses the separate trusted
coverage read when deciding whether evidence supports a place.

Start with [public.ts](public.ts), [the snapshot read](application/read-snapshot.ts) and
[the Composer adapter](application/read-composer-context.ts). Callers supply an already locked
personal scope. A missing measurement remains unknown, rather than becoming evidence of dislike;
for example, `statisticsAvailability: not_observed` preserves Composer's neutral default.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/personal-context` from the root.
The [integration suite](../../../../../tests/integration/README.md) exercises correction, recording
and all-store erasure. Source and fixture results do not establish a live person's learning or a
completed historical rollout.

Personal context owns revisioned qualified structural support and its bounded snapshot. Evidence
continues to own qualification, original activity channels, the capped activity function, 14-day
replacement/decay, and topic-format Q/O. The snapshot reuses Evidence's authorized statistics read;
it does not rescan observations or maintain a competing copy of those aggregates. Interest is
`A/(1+A)` and format fit `(1+Q)/(2+O)`, with unknown measurements excluded by Evidence.

## Ports and projection

`ApplyProjectedEncounter(scope, contribution)` runs in the producer's existing personal transaction.
The input contains an actual activated exposure, immutable asset revision, explanation identity,
nonincidental topic attribution, qualification and the independent qualification/action/navigation/
attribution/activity-policy/context-policy input vector. It returns whether its current projection
changed. A consumer validates current authority/epoch with `withPersonalScope` before calling it.
No provider, network, nested transaction, extra queue or transport outbox is introduced.

Replacement reads only the affected exposure's previous bounded contribution. Qualified support
references are removed/added for the affected keys; distinct topic counts change only when a key's
reference count crosses zero. Reel/Scroll variants and repeated encounters of one explanation can
have separate Evidence activity but remain one structural unit. A→B→A corrections restore the old
support. Unqualified/unknown encounters, likes alone, incidental mentions, supply, suggestions and
social messages add no structural support. Activity corrections remain Evidence's same-time old/new
replacement, including all original channels. PC never re-evaluates its qualification thresholds.

**Two coverage surfaces have different purposes.** Legacy contributions keep
`coveredFacets: []`; the snapshot reports a per-topic `coveredFacets` count and
`coverageAvailability: unavailable`. Publication tags alone cannot prove
which angle someone actually read. Formation uses the separate `ReadTrustedCoverage` capability
(described below), which checks exact Content mappings against observed Evidence certificates.
Do not substitute legacy unit counters or asset tags when that proof is unavailable.

`encounteredUnitsOf(snapshot)` (public) derives the explanations a person has met from a snapshot:
qualified supporting evidence, retained routing history and established encountered units. It is a read,
never a fact. The Planner uses it for what to suggest, and Supply uses it to bind planned demand only to
content the person has not met.

`ReadExplorationSnapshot` requires an existing live `PersonalScopeTx`. It validates independent
bounds: ≤100 exact requested topics, ≤100 candidate explanation units and ≤16 facets/unit,
≤100 candidate asset IDs, recent actual routing history ≤20, provisional observation IDs ≤20,
and one current qualified supporting source per requested unit (≤100). All probes are caller-only,
epoch-bound; content attribution is never opening permission. Historical routing encounters retain
their original novelty purpose and are not automatically qualified structural evidence. Selected
Hide/access/revision checks still happen at navigation commit.

`ReadRecentContextTopics(scope,{limit:1..100})` offers an independently bounded discovery seed.
Evidence selects by `evaluated_at DESC, topic_id` through its owned matching index (`0020`,
coordinator-approved), returns `recent_projected_topics.v0` and an honest `hasMore` sentinel.
This is projection recency, **not global top activity**: stored A rows have different evaluation
times. Callers union these IDs with actual plan/inventory/candidate topics under the total 100-topic
bound; the statistics read evaluates every selected A/channel at one explicit time. Global top-K
interest ranking is not implemented. No lifetime scan is performed to discover topics.

Every topic entry includes `statisticsAvailability: available | not_observed`, determined by actual
Evidence row presence. A retained corrected row with A=0/O=0 remains available; a requested topic
with no row is not_observed. Default I=0/F=.5 is mathematical initial state, not evidence of dislike.
Composer adapters must preserve their neutral missing-history policy using this marker rather than
conflating absence with a measured zero.

The IDs-only provisional tail is explicitly `routing_only`. It excludes observation sequences
already covered by an evidence watermark. It is never merged into A/Q/O, qualification, unit counts,
facet counts or supporting evidence. A missing item outside the bounded tail is not proof of absence.
Snapshot scope and latest-applied scope watermarks are separate from PC revision. Each supporting
contribution carries its complete input vector. `completeness: not_asserted` deliberately does not
turn a high watermark into a claim that every historical exposure was projected.

## Tables, lock order and lifecycle

| Owned table (`0020`) | Main reads/writes, bound | Retention/erasure |
|---|---|---|
| `contributions` | Current row per actual exposure; bounded versioned JSON≤16KiB with source vector/hash, exact unit/epoch index | Retained derived contribution for correction; erase before Experience exposure roots |
| `supports` | Reference count by caller/epoch/topic/kind/unit-or-facet; ≤272 keys per contribution, ≤544 old/new affected keys | Derived structural support; full erasure |
| `topics` | Exact requested topic distinct unit/facet counters, ≤100 per read | Lifetime structure does not decay with activity; correction can retract unsupported counts; full erasure |
| `state` | One caller/epoch row, monotonic PC revision + latest applied scope revision + policy | Never asserts historical completeness; full erasure |

Lock order: personal root → existing evidence/activity rows → this scope's contribution/support/
topic/state rows. No shared root or other person's root. Per-exposure input identity is idempotent;
different current input replaces it even if an older audit hash once matched. The authoritative
Evidence revision audit survives replacement until its own retention/erasure policy removes it.
Tables reference the personal root with RESTRICT; erasure explicitly deletes all PC rows across
epochs before Evidence/Experience. There are no PC caches, files, model artifacts or job payloads.

Rollout: apply immutable ordered migrations 0001–0020, bind the required derived effect in shipped
API/worker composition, then page the existing explicit activity reconciliation capability over
actual activated exposures. Reconciliation must also test PC currency when Evidence is already
current; completion of enumeration is not proof queued jobs finished. No scheduler or per-swipe
lifetime reconstruction is allowed. Removing the PC consumer leaves its factual rows erasable;
never rewrite migrations 0001–0019 or reconstruct erased interest from saved items.

Verification: pure source fixtures and real PostgreSQL integration fixtures run in GitHub Actions
only. The exact A→B→A fixture pins both exposure and routing-lineage activation times, so its
contributions have identical decay weights. Arbitrary distinct-time IEEE754 arithmetic may retain
approximately 1e-16 residue; this is not a claim of exact cancellation for every timestamp, and the
Evidence arithmetic/policy remains unchanged. Local schema generation/typecheck are not runtime acceptance. #235 remains open until the
coordinator deploys the reviewed consumer and inspects the context after actual reading on a
disposable dev account.


## Composer compatibility read

`READ_COMPOSER_CONTEXT` implements the existing backend-only Composer preparation capability by
calling `READ_EXPLORATION_SNAPSHOT` under the same personal scope. It validates scope, epoch, exact
evaluation time, policy, independent query bounds and source watermarks. It keeps available rows,
including observed zero; not_observed default rows remain absent so missing-history interest stays
neutral. It copies A/Q/O and actual routing recent/established/Hide without new score arithmetic.
The existing Composer type is a compatibility boundary, not another personal projection.

Since v3 S-5 (D-192) it also copies the play-level format cells of Evidence (`cells`: kind, level, measured, qualified)
and the non-incidental topic IDs of each recent encounter (`recent[].topicIds`). Both are copied field by field, so
nothing else Evidence or Experience held can ride along: in particular no pick, result, spark or tier, which `play`
keeps behind the D-063 wall. Status: implemented, unit-tested; not yet run on dev.

`personalContextProviders({ readCurrentPlan })` optionally injects the Planner's stored plan reader
(`ReadCurrentPlan`). The read then carries `plan` beside the context, and the watermark gains
`:plan-<revision>` so a buffer prepared under an older plan is not served as current. Without a plan
the read and watermark are unchanged. The plan is not evidence and never feeds personal context.

The persisted input policy is personal-context.v0 and the versioned watermark binds PC revision,
locked scope revision, latest projection and not_asserted completeness. Navigation uses the same
watermark for its Composer snapshot. ProvisionalLimit 0 avoids reading observation tails for this
consumer; neither provisional references nor qualified structural/facet support enter its arithmetic.
The adapter performs no writes, advances no revision and adds no stores/erasure entries. Both shipped
API and worker instantiate it. Navigation requires its explicit token; legacy Evidence readers are
available only through an opt-in compatibility-fixture provider, with no production fallback.

## Observed-coverage proofs

Status: implemented, CI-tested against real PostgreSQL. Related: #237, migration 0023.

The legacy global `coveredFacets` array remains EMPTY and its snapshot's coverageAvailability stays
unavailable; Composer's inputs, provisional routing and all interest/format arithmetic are unchanged.
The new backend-only `ReadTrustedCoverage` capability serves exact topic/facet/explanation-unit
probes separately. It returns current observed factual witnesses, not a formation decision or a
knowledge claim. Any future trusted snapshot/Cartographer must use this capability under the SAME
personal scope through apply, never the legacy unit counters or raw retained support counts.

Evidence supplies a bounded versioned independent certificate. The combined required effect writes
PC-owned current coverage contribution, per-exposure topic-bound witness references and support
reference counts by topic/facet/meaning/canonical unit/factual framing digest. No facet is crossed
into another attributed topic. Repeated encounters/variants retain separate references but one unit
key; one unit's different exposures can prove different facets. Only affected old/new<=16 keys are
replaced. Unqualification, map correction A→B→A, retraction or withdrawal removes unsupported keys;
last reference removes support. Existing PC state advances once if either projection changes.
Coverage-only correction references the actual current Evidence activity ID and appends no activity
audit; replay of unchanged combined input changes neither revision nor hint.

`ReadTrustedCoverage(scope,{probes})` accepts 1–100 unique exact triples, <=64KiB query. For each
support key (topic, facet, meaning, unit, framing) it reads up to eight exposures, however the key's
references are spread over asset revisions: the newest exposure of each asset revision first, then the
second newest of each, and so on, ranked by the certificate's activation time (a legacy exposure that
has a recording projection is read through the recording source only). Re-reading a Scroll adds references to
a key and never candidates, so the read neither refuses nor grows with how much a person has read
(#674, D-409). The candidate rows are bounded by the keys probed; a batch that is itself wider than
1000 candidate rows refuses with its overflow sentinel and the consumer reads it as two. It validates
stored hashes/epoch, batch-checks exact latest Evidence, rechecks current Content maps and locks
the <=100 current asset/head authorities it just read (never the head a certificate names), then
repeats Evidence checks AFTER lock waits and requires the same head it locked. All locks
survive caller commit. Retracted or withdrawn authority, or a correction that changes the bindings,
excludes old certificates even before another reading or reconciliation job. Output<=128KiB; overflow returns typed unavailable/limit and
`completeness:not_asserted`, never a truncated completeness claim. No current observed witness returns unavailable/not_observed; this is not proof that all
historical reading was projected. Each canonical topic/facet/meaning/unit/truth `supports` key appears once in deterministic order and
is proved by exactly one witness, its newest valid one: the latest certificate activation among the
candidates that passed every check (Evidence latest, Content mapping through `certificateValidOnHead`,
SHARE locks, and the re-check after the waits), the greater exposure ID breaking a tie. The others
are not returned, so one support read a hundred times is one witness and one certificate, never a
128 KiB overflow. The newest also gives the support's last activation, which decides when a place goes
quiet. Variety is the number of distinct canonical units, never of witnesses, and future formation
must still count distinct units across multiple facet keys. A newest exposure on withdrawn or retracted
authority does not hide an older valid one of another asset revision, and a key read under one revision
whose newest certificates are invalid (a head changed and then admitted again) still reaches its eight
newest exposures. Limit: if all eight candidates of a key are invalid, the key has no witness this read,
though an older exposure might be valid.
Last current reference removes the support.
Returned exact certificate IDs/digests and witnesses
make unit/facet support inspectable without raw observations or provenance text.

**When an old certificate still counts (D-406, #674).** `certificateValidOnHead` accepts a certificate
issued on an earlier head of the same asset revision when the current head is active, every mapping
identity field matches (document, provenance, explanation unit, framing, reading facts, catalogue
version), the facts digest is the head's, and every binding it claims is still in the head (a binding
pins its facet meaning and required blocks). The catalogue digest and the head number and mapping digest
are not compared: `content readmit-coverage` appends a head whose only change is the digest after any plan
edit, and comparing them discarded real reading (D-033). `fenceCoverage` and `fenceRecordingCoverage`
read the current mapping, lock that head, read it again and require the same head. A head retracted and then admitted again with the same mapping makes
old certificates count again: the retraction excluded them only while it was current.

Migration 0023 adds `coverage_contributions` (current certificate<=16KiB plus real activity FK),
`coverage_references` (<=16 exact binding witnesses/exposure, indexed by requested topic/facet/unit),
and `coverage_supports` (unit-bound reference counts). Counts are incremental projection state,
not current authority until the live read revalidates. Retention is personal; erasure deletes
references/supports/certificates across all epochs BEFORE legacy PC, Evidence and exposure roots.
No extra queue, scheduler, cache, provider payload or outbox exists. Admission never acquires a
personal root; this consumer acquires personal first, then Content canonical SHARE authority.

Rollout requires ordered 0001–0023, reviewed API/worker composition, separately admitted exact real
semantic maps and explicit bounded existing reconciliation. Empty Content approvals remain empty.
CI fixtures use synthetic semantic approvals only; no live map, observed dev coverage, provider,
geography, planet, native/browser journey or deployment acceptance is established by source/CI.

## Reels in trusted coverage (#674, slice 5.1, D-421)

Status: implemented, CI-tested against real PostgreSQL. Migration 0118 (a Content guard only).

`ReadTrustedCoverage` serves Reel certificates beside Scroll certificates (`supportedFormats: ['scroll', 'reel']`).
Nothing in this module knows a format: a certificate is a certificate, and the same checks run for a Reel's: current
exact Evidence, Content's current mapping under `certificateValidOnHead` (D-406, so a head that changed only in the
catalogue digest keeps a Reel's reading, and a re-cut, which is another asset revision with its own head, does not
inherit the earlier cut's windows), and the SHARE locks. The support key is the same, and its `truthSha256` is the
factual framing digest a Reel and its Scroll twin share, so a Reel and its twin that bind one facet are one key with two
references and one explanation unit: they count once, and Geography counts distinct units, never references. The
dirty set is marked by a Reel's references exactly as by a Scroll's. A Reel with no Scroll twin is not in any region
(D-404) but its facets count toward its system and planet like any other unit.

## The dirty set and the keys a run reads (#674, slice 4.1, D-416)

Status: implemented, CI-tested against real PostgreSQL. Migration 0110.

Formation costs what changed, so Personal Context tells Geography which topics changed and nothing more:

- **`personal_context.coverage_dirty_topics(universe, epoch, topic, dirty_revision)`.** The producer's own transaction (the places
  that already compute support changes: `applyCoverage` and `replaceCoverageSupports`) upserts one row per topic that gains or
  loses a reference of a trusted support key, at `dirty_revision = scope.revisionAtEntry + 1`, the personal scope revision the
  transaction commits at. That includes a reference added to a key that already exists (a newer encounter moves when its places
  last had support), and a removal. A replay of the same certificate, an activity-only change and an unqualified encounter reach no
  support key and mark nothing. A rolled-back transaction marks nothing. An existing row keeps its later revision. It is derived,
  never evidence, and is erased with the other personal-context tables (Clear and full erasure).
- **`READ_COVERAGE_DIRTY(scope, {limit 1..64})`.** The newest dirty topics (`dirty_revision desc, topic`) that are not waiting out a
  backoff, an honest `hasMore` sentinel, the personal-context revision, `nextRetryAt` (when the earliest topic in backoff may be tried
  again, or null), and `anySupport` (the person has at least one support key or dirty row), so an empty set means "nothing changed"
  and not "nothing read". A reader at scope revision R has seen every row at or below R.
- **`CLEAR_COVERAGE_DIRTY(scope, {topicIds, throughRevision, deferTopicIds?, maxAttempts?})`.** Geography deletes, in the transaction that
  applies or settles a run, the rows of the topics it evaluated at or below the revision it read, so evidence that arrived during the
  run keeps its higher revision and stays dirty. The rows of `deferTopicIds` (topics the run could not settle: nothing trusted in
  them, a refused apply or claim) are kept, `attempts` one higher and `retry_after` a minute away, doubling to an hour; with
  `maxAttempts` a row already tried that many times is deleted instead. A new reference for the topic resets both (`markTopicsDirty`).
- **`MARK_COVERAGE_DIRTY(scope)`.** Marks every topic the caller has a support key under, for an explicit cartography request.
  The operator's `geography reconcile-coverage` does the same for readers who read before this migration, at each universe's
  current revision, in SQL (`adapters/coverage-reconcile.ts`). With `--unit` it marks only the topics that hold a key of those
  explanation units and makes a row waiting out a backoff eligible at once: what Content trusts changed for them. `content
  readmit-coverage` calls it for the units whose head it appended, so readers whose places were last judged while their content was
  not trusted are evaluated again (PR #723).
- **`READ_COVERAGE_INPUTS(scope, {topicIds | recent, perFacet, maxTopics?, page?, onlyFacets?})`.** Replaces the whole-person discovery of #674 slice 1.1 (the
  1000-key and 256 KiB bound is gone with it). `coverage_supports` holds one row per support key, however many exposures reference
  it, kept in step with both projections, so re-reading adds references and never keys. For each named topic that has a key, the
  newest `perFacet` distinct units of each facet are returned (`last_activated_at`, then unit id); `maxTopics` keeps the topics whose
  newest key is most recent. `page` returns the next run of `perFacet` keys of each facet (0 is the newest) and `onlyFacets` restricts
  it to the facets whose newest keys were not trusted, so Geography can read past withdrawn content; `recent: {limit, exclude}` names
  the reader's most recently supported topics instead, for a sample. `coverage_supports.last_activated_at` is set from the certificate of the exposure that adds a
  reference and only orders keys (a removed reference leaves it where it was), so it can be later than the true newest and never
  decides a place. These keys are NOT trusted supports, unit counts or formation authority: Geography must call current
  `ReadTrustedCoverage` under the SAME live root through apply, preserving the Evidence and Content SHARE checks.

Completeness is always not_asserted. No legacy coveredFacets, support arithmetic or semantic approval changes are made.

## Recording-aware projections

Status: implemented in source and CI; not exercised on a running system. Related: #381, schema 42.

The required Evidence effect implements four explicit methods. Legacy `apply/isCurrent` are an
initial 1 compatibility fixture boundary; new producers call `applyRecording/isRecordingCurrent`
with a genuine `RecordingScopeTx`. No fallback upgrades a personal transaction or omitted original
generation. A converted exposure refuses legacy mutation; legacy writes also refuse after the
initial on/generation 1 policy. Current Content reads and historical source reads remain available
without authorizing new recording effects.

`recording-activity.v1` separates `currentSegment` qualification/activity/certificate identity from
`evidenceEffective`. PC never derives support from `evidenceEffective.qualified`. It freezes only
its own already committed contribution as the generation baseline and unions actual current-g
qualified structure. A negative-only/action-only segment with no current qualification cannot seed
missing PC structure, even when Evidence carries qualified credit. Same-g correction replaces that
segment; later generations retain the preceding committed effective PC value. Support refcounts
still represent one exposure/key and one canonical explanation, with no cross-generation raw union.

The strict PC contribution projects only exposure ID, asset ID/revision and activation time from
the actual Evidence exposure. Runtime exposure objects also carry routing/action facts; spreading
that object would fail the closed contribution schema. Those facts remain in their original
owners and input vector, without changing PC qualification, support or contribution hashing.

`recording_segment_heads` retain exact generation source contribution/certificate identity. They
are separate from the mutable one-exposure `recording_exposure_contributions` and
`recording_coverage_contributions` caches. Old heads are sealed by the root generation; no toggle
writes or historical backfill occur. Each of at most 16 coverage binding slots holds a frozen base
pointer and optional current pointer; at most 16 selected effective references occupy the indexed
`recording_coverage_references`. Slots are bounded to 32KiB; structural/certificate payloads to 16KiB.
A new current proof replaces the selected binding, while a same-g correction can fall back to its
committed baseline. Valid retained legacy 1 certificates remain a separate source kind, including
alongside a new generation 1 head. Current head replacement and all affected current-g references
commit atomically through the deferred complete-witness FK. Sealed source heads are never rewritten.

Trusted coverage keys contain source kind, exposure, generation, actual activity ID, qualification
ID and certificate hash. These exact keys survive deduplication, Evidence checks, Content SHARE
lock waits, repeated Evidence/Content checks and output. Exposure-only membership applies solely
to the explicit unconverted legacy checker. Frozen certificates resolve retained PC source heads
or exact original legacy certificate rows, never the mutable effective cache or latest exposure
audit. Current mapping changes can invalidate availability immediately, but cannot certify old raw
input. At most 16 bindings on each old/new side change the existing coverage support counts.

Legacy and recording coverage indexes each have a 1001-row sentinel: at most 2002 raw candidates,
and a combined count above 1000 refuses before hydration or shadow resolution. No anti-join scans
arbitrary legacy history to fill a page. Supporting-unit reads use the same fixed two-source
candidate budget for at most 100 requested units. Overflow returns explicit backend
`proofAvailability: unavailable` / `proofReason: limit`, empty qualified/supporting proofs and
`completeness: not_asserted`; prepared statistics and routing remain usable. Coverage reads of keys (the
inputs read) are by distinct support key, not raw reference, for named topics only (see the dirty set, above). Trusted
coverage output retains its 128KiB bound, now reached only by a batch of many distinct keys, and does
not claim historical completeness.

Clear/full erasure deletes recording coverage references first, then effective coverage and
structural caches, then generation source heads, then all legacy PC tables. This precedes Evidence
source/audit/session erasure and Experience segment/origin erasure. No PC row is an account-lifetime
recording receipt. Source fixtures cover the absent-PC-baseline boundary, complete witness
replacement, reading by distinct keys (a reader whose raw references exceed 1000 is read as one key, a topic with
1001 keys is read through its newest few of each facet), the dirty set (marked by a new or removed reference and by a re-read, not by a
replay, by activity alone or by a rolled-back transaction; cleared only through the revision a run read), one witness for a support read many times or 1500 times, a valid older
exposure when the newest is on retracted authority, combined rollback and all-store Clear. They run
only in CI; local formatting/type analysis is not a behavioral acceptance receipt.

The earlier rollout paragraph is historical: activation now requires the complete fenced pipeline,
client/API/role closure and the separately allocated finite legacy certification protocol. That
certification remains unimplemented; no missing legacy state is assumed false or trustworthy, and
no API/UI recording control or operational rollout is authorized by this module.
