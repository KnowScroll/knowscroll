# modules/personal-context

Backend-only prepared exploration context (#235, blueprint §§5,8,19). Shipped navigation source
uses the PC-owned Composer adapter. Actual dev consumer inspection, planet formation, personal
learning and completed historical rollout are not established by source/CI evidence.

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

**Facet coverage is unavailable.** Publication facet tags are routing metadata. No trusted mapping
from facet to actually seen Scroll blocks/Reel ranges exists yet; the actual producer therefore
passes `coveredFacets: []`, and snapshots say `coverageAvailability: unavailable`. Partial qualified
consumption never promotes every asset tag into formation variety. #237 needs a separately reviewed
coverage port that validates immutable asset revision + actually covered block/media intervals and
returns only supported facet IDs, with mapping/policy revision added to this input vector. Until
that exists, no two-facet planet requirement can be met by this module's output. The reference-count
mechanism can store trusted covered facets but the current integration does not invent them.

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
times. Callers union these IDs with actual plan/inventory/candidate topics under the total100-topic
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

Rollout: apply immutable ordered migrations0001–0020, bind the required derived effect in shipped
API/worker composition, then page the existing explicit activity reconciliation capability over
actual activated exposures. Reconciliation must also test PC currency when Evidence is already
current; completion of enumeration is not proof queued jobs finished. No scheduler or per-swipe
lifetime reconstruction is allowed. Removing the PC consumer leaves its factual rows erasable;
never rewrite migrations0001–0019 or reconstruct erased interest from saved items.

Verification: pure source fixtures and real PostgreSQL integration fixtures run in GitHub Actions
only. The exact A→B→A fixture pins both exposure and routing-lineage activation times, so its
contributions have identical decay weights. Arbitrary distinct-time IEEE754 arithmetic may retain
approximately1e-16 residue; this is not a claim of exact cancellation for every timestamp, and the
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

The persisted input policy is personal-context.v0 and the versioned watermark binds PC revision,
locked scope revision, latest projection and not_asserted completeness. Navigation uses the same
watermark for its Composer snapshot. ProvisionalLimit0 avoids reading observation tails for this
consumer; neither provisional references nor qualified structural/facet support enter its arithmetic.
The adapter performs no writes, advances no revision and adds no stores/erasure entries. Both shipped
API and worker instantiate it. Navigation requires its explicit token; legacy Evidence readers are
available only through an opt-in compatibility-fixture provider, with no production fallback.

## Separate trusted observed-coverage proofs (#237,0023)

The legacy global `coveredFacets` array remains EMPTY and its snapshot's coverageAvailability stays
unavailable; Composer's inputs, provisional routing and all interest/format arithmetic are unchanged.
The new backend-only `ReadTrustedCoverage` capability serves exact topic/facet/explanation-unit
probes separately. It returns current observed factual witnesses, not a formation decision or a
knowledge claim. Any future trusted snapshot/Cartographer must use this capability under the SAME
personal scope through apply, never the legacy unit counters or raw retained support counts.

Evidence supplies a bounded versioned independent certificate. The combined required effect writes
PC-owned current coverage contribution, per-exposure topic-bound witness references and support
reference counts by topic/facet/meaning/canonical unit/factual framing digest. No facet is crossed
into another attributed topic. Repeated encounters/variants retain separate witnesses but one unit
key; one unit's different exposures can prove different facets. Only affected old/new<=16 keys are
replaced. Unqualification, map correction A→B→A, retraction or withdrawal removes unsupported keys;
last reference removes support. Existing PC state advances once if either projection changes.
Coverage-only correction references the actual current Evidence activity ID and appends no activity
audit; replay of unchanged combined input changes neither revision nor hint.

`ReadTrustedCoverage(scope,{probes})` accepts1–100 unique exact triples, <=64KiB query. One indexed
bounded probe query retains<=1000 reference rows and refuses on its overflow sentinel. It validates
stored hashes/epoch, batch-checks exact latest Evidence, rechecks current Content maps and locks
<=100 canonical asset/head authorities, then repeats Evidence checks AFTER lock waits. All locks
survive caller commit. Corrected/retracted/withdrawn authority excludes old certificates even before
another reading or reconciliation job. Output<=128KiB; overflow returns typed unavailable/limit and
`completeness:not_asserted`, never a truncated completeness claim. No current observed witness returns unavailable/not_observed; this is not proof that all
historical reading was projected. Returned exact certificate IDs/digests and witnesses
make unit/facet support inspectable without raw observations or provenance text.

Migration0023 adds `coverage_contributions` (current certificate<=16KiB plus real activity FK),
`coverage_references` (<=16 exact binding witnesses/exposure, indexed by requested topic/facet/unit),
and `coverage_supports` (unit-bound reference counts). Counts are incremental projection state,
not current authority until the live read revalidates. Retention is personal; erasure deletes
references/supports/certificates across all epochs BEFORE legacy PC, Evidence and exposure roots.
No extra queue, scheduler, cache, provider payload or outbox exists. Admission never acquires a
personal root; this consumer acquires personal first, then Content canonical SHARE authority.

Rollout requires ordered0001–0023, reviewed API/worker composition, separately admitted exact real
semantic maps and explicit bounded existing reconciliation. Empty Content approvals remain empty.
CI fixtures use synthetic semantic approvals only; no live map, observed dev coverage, provider,
geography, planet, native/browser journey or deployment acceptance is established by source/CI.
