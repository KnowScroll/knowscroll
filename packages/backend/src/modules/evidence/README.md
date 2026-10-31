# modules/evidence

Owns: `evidence.action_events` (`0005`, the explicit-action channel: a Save is not a consumption
encounter), `evidence.observations` and `evidence.encounter_evidence` (`0012_evidence_observations`).

## Recording-aware evidence

Status: implemented in source and CI; not exercised on a running system. Related: #381, schema 0042.

This source is a backend prerequisite, not installed Pause. HTTP/controller, client recorder,
worker composition and Roles/Reasoning generation propagation remain separately allocated. Full
positive Evidence→PC→Roles material-change acceptance and finite legacy attribution/channel
certification are pending. No runtime activation or provider authority follows from this source.

All intake and growth consumers enter the personal root, acquire the current own-account UPDATE
barrier, then obtain Identity's genuine `RecordingScopeTx` for the ORIGINAL generation. Work that
waited behind a toggle or Clear cannot apply afterward. Omitted-generation legacy wires/jobs are
permitted only in actual initial 1/on; v2 requires its submitted original generation. Queue schemas
remain Zod objects exposing `.shape.universeId` for erasure inventory, refuse reserved generation
fields on v1 (including explicit undefined), and never strip malformed v2 into a legacy branch.

The separate strict `observation-batch.v2` requires a session whose ID is the actual accepted
activation command ID. Experience owns the current descriptor and activation decision; Evidence
registers the session in that same transaction, sampling its own server clock before ACK. A restart
has a fresh activation command/session and may start later than the first eligible activation.
Registration alone earns no qualification, activity, material revision or job. The SQL origin and
deferred completed-receipt guards bind generation, exposure and activation. No client clock is
server authority. Session-relative visibility intersects only that session's active dwell. Within
the current generation, independently observed seen sets combine and session dwell is capped by
one eligible server elapsed span. Legacy and session raw interval clocks never union together;
recording qualification policies have distinct version strings.

The event key remains global `(universe,eventId)`. Newly accepted bounded payloads have a reserved
strict internal envelope with clock domain and a server-computed SHA-256 of the original event,
instrumentation and generation. Exact unchanged retries count duplicate before the lifetime-cap
check and change nothing. Reusing an ID with different wire content refuses `lineage_mismatch`.
A historical pre-envelope row cannot prove its original body after timestamp/interval clamping:
reuse of that ID also refuses `lineage_mismatch`, even for a plausible old retry. There is no
reconstruction, backfill or guessed hash. The future client owner must discard that old scoped
batch and require a deliberate fresh session, never automatically relabel or re-ID its intervals.
Fresh v1-shaped IDs remain accepted only at actual initial 1/on. Necessary encounter history is
unchanged. A 1001-row lifetime probe precedes generation filtering; oversized inconsistent history
returns a typed `observation_limit`, and the 1000-event lifetime budget never resets on toggles.

`recording_segment_heads` keeps exact current-generation qualification/activity identities.
Audit revisions allocate from an indexed global exposure/revision reverse seek; a new generation
never reuses an audit revision. Activity requires an existing genuine Experience descriptor and
never calls `ensureLineage` to manufacture eligibility. Old already-activated exposures without
one confer no new activity until actual eligible activation. New segment factual proofs exclude
pre-descriptor observations and pre-envelope legacy bodies. The server alone records
`descriptorEligible` plus the immutable descriptor attribution SHA in a strict internal event
envelope, after a genuine same-root/generation read proves the exact exposure/asset/revision and
actual eligible activation. Client metadata cannot grant this marker. Markerless/false envelopes
never upgrade, including on exact retry. The projector requires that marker and exact descriptor
SHA; millisecond timestamps are only a defense, never lineage proof. Only this eligible projection
writes `source_vector.legacyQualificationId`; current legacy qualification reads resolve that
exact universe/epoch/exposure/generation/audit pointer. Session qualification remains a separate
head. An old audit cannot seed a new descriptor even when its PostgreSQL timestamp sorts after the
later JavaScript initialization within the same millisecond. Committed legacy state remains retained independently.

`recording-credit.v1` is one fixed exposure reducer/cache, with bounded independent legacy/session
source slots, never a generation-history array. Advancing generation freezes the previous EFFECTIVE
value, not an old source head. q uses maximum, qualification/measurement and H/R retain factual
presence, and explicit current eligible false L/B overrides prevent resurrection. NULL channel
state is uncertified and does not borrow necessary Save/Like truth. The immutable attribution
fingerprint cannot change between generations. On first conversion, <=16 old committed topic rows
are checked for exact weighted scalar/channel/Q/O consistency. Old storage lacks the full
explanation/facet/attribution fingerprint, so this source still refuses uncertified conversion
with `RECORDING_LEGACY_ATTRIBUTION_UNCERTIFIED`; it preserves old downstream credit rather than
moving it to today's catalogue. No automatic legacy certification is installed.

The `activity_revisions` audit stores ONLY current-generation segment channels scored by the
unchanged `activity.v0` weights/cap. It contains no inherited effective channels. Its versioned
input vector binds the exact current factual source IDs. The recording-credit cache and weighted
topic replacements separately hold one-exposure EFFECTIVE channels/Q/O. Existing legacy
`activity_current` heads are not rewritten; a missing parent is inserted once only to satisfy the
unchanged topic-contribution FK. Modern current identity uses the generation-specific head.

`RecordingActivityDerivedInput` separates `currentSegment` exact activity/qualification references
and observed coverage from `evidenceEffective`. There is no recording top-level `qualified` alias.
PC must use its OWN committed baseline and only current-segment factual proof; Evidence's inherited
qualification is never new PC support. The composite `recording-coverage.v1` witness key includes
source kind (legacy/segment), exposure, generation, activity, qualification and certificate digest.
Retained exact audit checks never fall back to latest exposure identity; an existing committed
legacy-g1 PC witness remains distinct from a new g1 segment. Content still owns current mapping,
meaning and publication authority after any waits. Certificates remain factual static coverage,
not learning or understanding, and Reel facet coverage remains unsupported.
Segment certificates additionally bind the exact SAME-generation Evidence activity head and the
known-policy legacy/session Q source pointer. Moving that current pointer refuses the previous
certificate immediately, before the PC projector runs. A newer unrelated exposure-wide audit is
not authority and does not invalidate a selected source. Older sealed-generation heads continue
to validate their original complete identity; independent legacy-base witnesses do not borrow a
segment head. This is a read fence, not a new correction API or permission to rewrite old history.

The required Experience effects factory implements all four methods with genuine recording
transactions. It validates <=2 channel effects against owning action/command and exact persisted
segment decisions, not caller-only pointer revisions. Derived Evidence/PC changes allocate exactly
one root revision and one REQUIRED material-change carrying the same original generation; the
consumer sends no notice. Experience reuses that revision and emits its one notice. Standalone
activity projection owns its own one revision/notice. A required owner/job failure rolls the whole
transaction back. Missing PC's four-method effect or material-change port is an error, never a
successful empty fallback. Read/replay paths do not repair missing legacy state. Reconciliation
visits <=100 stable IDs and current-generation descriptors only, with explicit original generation;
old/absent/ineligible sources are not reconstructed.

The erasure inventory now includes recording credit, segment heads and sessions before their
referenced audits. PC must erase its dependent source/certificate rows first, then Evidence, then
Experience descriptors/origins/receipts. All three ordinary/retained/dead queue inventories retain
their existing names. Only source/static checks are allowed locally; authored behavior fixtures run
in GitHub Actions after complete dependency composition. The older sections below describe the
pre-recording slice and retained compatibility interfaces; this section governs recording writers.

## Operations

| Operation | Trigger | Authority, effects, redelivery |
|---|---|---|
| `applyActionEvidence(payload)` | queue `evidence.apply-action` (worker) | `system` actor for the payload's universe at the payload's epoch, rechecked under the personal lock. One transaction: read the action (experience's `READ_ACTION_FOR_EVIDENCE` port) → insert the event keyed `(universe_id, action_id)`. Evidence changes nothing a client reads, so the job advances no revision and sends no hint. A redelivery finds the key and does nothing (`already_applied`); work from an older epoch is skipped (`epoch_changed`). |
| `ingestObservations(authority, {instrumentationVersion, events})` | `POST /v1/observations/batch` | Durable intake of the recorder's `interaction.v1` events. Caller's authority under the personal lock; **idempotent per `(universe, event ID)`** (exact original-wire retry only: unchanged retries count nothing twice; changed-wire reuse refuses). Per event, in order: the exposure exists in this universe and epoch (`exposure_unknown`; foreign and unknown are indistinguishable), the event names the exposure's asset and revision (`lineage_mismatch`), the exposure is activated (`exposure_not_active`), every block ID exists in that immutable revision (`block_unknown`), interaction kinds must be declared by scroll-model `INTERACTION_KINDS` for the stored block type (`interaction_kind_invalid`), the event is not older than a week (`too_old`) and the exposure's intake limit (1,000) is not reached (`exposure_event_limit`). **Client claims are bounded, not trusted** (`observation-bounds.v1`): a future `occurredAt` is clamped to receipt time, and intervals and offsets are clipped to the wall time elapsed since activation plus 2 s; the stored payload is the bounded one (`bounded` is recorded). Each accepted event gets the exposure's next `seq`, so the highest `seq` is its input watermark. In the **same transaction** one `evidence.project-scroll-reading` job is enqueued per exposure that gained an observation (pg-boss is the only outbox). A batch over 48 KiB is refused (`PAYLOAD_TOO_LARGE`); an older epoch is refused (`PRIVACY_EPOCH_CHANGED`). Acknowledgement means **stored**, never projected. No receipt (observations are not commands), no revision bump, no hint. |
| `projectScrollReading(payload)` | queue `evidence.project-scroll-reading` (worker) | `system` actor at the payload's epoch, rechecked under the lock. One transaction: read the exposure (must be activated), its revision's reading facts and its observations in `seq` order → stop if the latest revision already covers this watermark under this policy → summarise and qualify (below) → insert the revision keyed `(exposure, input watermark, policy version)` (a conflict is a redelivery: no-op) → advance the universe revision and `pg_notify` it (the disposable hint, `eventId` = the evidence ID) → commit. Always projects the exposure's **current** watermark, so a late or duplicate job reflects everything committed before it. |
| `readEvidenceDiagnostics(authority, exposureId)` | `GET /v1/diagnostics/exposures/{id}/evidence` | **Dev-only operator surface.** Authority rechecked without a lock; reads the caller's own intake count, latest evidence revision and the universe revision. The route exists only in `OPERATOR_WORLDS` (`dev`, `stage`, `ci`, `local`) and answers `NOT_FOUND` anywhere else; the consumer UI never shows scores. |

## Qualification (blueprint §8, `domain/`, pure and property-tested)

`q = 0.5 · weighted coverage + 0.5 · min(1, active dwell / estimated reading time)`, with weights and
the estimate from the document's code-set measures (`content`'s reading facts).

- **Unique time**: intervals are merged, so duplicates, overlaps and retries add nothing.
- **Seen block**: unique visible time **while the article was active** (visible ∩ active) of at least
  500 ms and a peak visible fraction of at least 0.5; a nested block counts for its disclosure.
  Background, hidden-tab and overlay time never becomes coverage.
- **qualified**: valid lineage (checked at intake), at least one block seen, `q ≥ 0.6`, coverage `≥ 0.5`.
  A qualified result stands even with lost events (they could only have added).
- **unknown**: below the thresholds but the instrumentation is missing (no coverage report, no dwell
  report, a recorder build below the policy minimum) or events were lost (device sequence gaps): neither
  consumption nor a negative example.
- **not_qualified**: fully instrumented and short.

All parameters live in the versioned policy record `scroll-qualification.v0` (`domain/policy.ts`:
**bench values for testing, not empirical claims**); the revision stores the policy version, and a new
version is a new revision over the same input. Interactions are counted once per block and kind. The contract kind union comes from scroll-model `INTERACTION_KINDS`; intake validates the kind against the immutable revision’s block type (including nested blocks).

### Reading a v2 Scroll (D-128)

Status: **implemented**, runtime-verified with labelled fixtures on real PostgreSQL.

`summariseReading` takes each unit's rule from the reading facts: a block with `seen: {kind: 'visible',
minVisibleMs}` counts after that much active visible time (never under the policy's minimum), a block
with `seen: {kind: 'interaction', interactions}` (a call) counts when one of those value-free interactions
was reported. Calls weigh 0 in the facts, so a seen call is stored as engagement and adds nothing to coverage. A block without a rule counts as before. The policy, q and its thresholds are unchanged.
Tapping through the spine does not qualify (a property test); the option a call picked is not an
interaction kind and never reaches this module (D-063). `observedBindings` accepts facts v2 and v3 and
checks eligibility by version (`ELIGIBLE_BY_FACTS_VERSION`, kept equal to content's rule by a test).

## Tables, jobs, lock order, erasure

| Table | Holds |
|---|---|
| `evidence.action_events` | One row per applied Save/Unsave, keyed `(universe_id, action_id)` |
| `evidence.observations` | Accepted observations: `event_id` (unique per universe), recorder session and device sequence, `exposure_id`, per-exposure `seq`, kind, bounded payload, `occurred_at`/`received_at`, `bounded`, epoch |
| `evidence.encounter_evidence` | Evidence revisions: `revision`, `input_watermark`, `policy_version`, `qualification`, `q`, `coverage`, dwell, reading estimate, a bounded summary (seen block IDs, interactions, reason codes), epoch |

Queues (`events.ts`): `evidence.apply-action` and `evidence.project-scroll-reading`, each expiry 60 s, 8
retries with backoff from 2 s, dead letter `<name>.dead`, retained 7 days queued / 2 days completed.
Lock order for recording writers: personal root → own account UPDATE → fresh recording capability; exposure/facts are read inside that scope. Erasure: the three
tables and both queues' payloads per universe (`adapters/erasure.ts`); raw observations are not promised
replayable forever.

## Reel observations

Status: implemented, CI-tested against real PostgreSQL. Related: S2.4.

`reel.playback` carries bounded pairs of continuous active-time and media-time intervals, without text
or playback position shared to peers. Intake applies the same scope/epoch/activation/lineage/batch
idempotency and elapsed-time bounds; media endpoints must lie inside the admitted duration. Scroll
kinds cannot use Reel facts or vice versa. The existing durable projection queue dispatches by the
admitted revision's facts. `reel-qualification.v0` computes unique visible media / duration, capped by
unique active time, with experimental q≥0.6. Overlap, loops and duplicate delivery add no unique media;
missing/gapped instrumentation leaves short encounters unknown. Consumer navigation/open/grant renewal
is not evidence. Diagnostics retain q, unique media, active time, duration and policy version.

## Activity and prepared routing context

Status: implemented, CI-tested against real PostgreSQL. Related: migration 0019, #234.

`activity.v1` (D-191, implemented; CI-tested against real PostgreSQL, not yet run on dev) keeps q, Like L, bookmark B,
confirmed Share S (currently 0), deliberate horizontal H and separated return R independently. Routing activity is
`min(3,q+.5L+1.5B+S+1.5H+2R)`; H now counts only when the exposure the move left has coverage of at least 0.5 in a
measured reading (`continuationCredit`), so swiping Parts 1 to 3 without reading adds nothing. `activity.v0` is the
same without that bar; its revisions are kept and not rewritten, and a credit committed in an exposure's base stays.
A new revision names `activity.v1` (migration 0082 widens the pin of 0019) and its input vector names the rule;
`experience.navigation_transitions` keeps `activity.v0` because it records the fact of the move, not the credit.
unknown q remains null and never becomes qualification or usable format measurement. H belongs
once to the activated **source** of an actually activated series/related destination. Variants,
offers, failures and Back add no H. R belongs to a new explicitly activated return at least 30 min
after the most recent actual same-explanation encounter; legacy/direct open and parked restore add
none. These defaults are experimental routing policy, not formation or learning measurements.

Ordinary IDs-only `evidence.project-encounter-activity` jobs are enqueued in the same root transaction
as activation, linked action correction or new qualification revision. They recheck live authority,
epoch and actual activation, then project latest state. The independent input vector contains
qualification revision, original action revision, navigation linkage revision, actual attribution
watermark and policy. No fake observation is inserted to advance qualification. Duplicate/out-of-order
jobs with an already-current vector do nothing. Required job failure rolls its originating commit back.

| Personal table | Purpose / bounded indexed query | Growth / retention / erasure |
|---|---|---|
| `activity_revisions` | Immutable separate input vector, original channels, capped routing value; exact exposure/revision/hash keys | One per changed vector; bounded JSON; retained personal audit, full erasure |
| `activity_current` | Current owned epoch/exposure -> matching revision FK | One/exposure; erase after topic contributions, before revisions |
| `topic_contributions` | Current weighted capped value + independent original channel contributions and measured/qualified flags | <=16 actual attributed topics/exposure; sum topic weights<=1 enforced by content; replacement rather than additive replay |
| `topic_context` | Scope/topic decayed activity and independent channel aggregates; per-topic-format Q/O | One/topic; exact requested topics<=100; update affected union<=32 topics, no lifetime scan |
| `topic_format_cells` (`0082`, D-192) | Measured/qualified encounters per (topic, kind, play level), beside the `topic_context` counts, which are their parent over every level. `topic_contributions.play_level` records the level an exposure was counted at, so a correction moves its counts between cells. Reading only: no pick, result, spark or tier (D-063) | <=6 rows/topic; requested topics<=100; erased with `topic_context` |

**Play-level cells** (implemented; CI-tested against real PostgreSQL, not yet run on dev). The play level (`plain`,
`stage`, `game`) of the Scroll read comes from Content (`READ_PLAY_LEVEL`, derived from the immutable revision), so a
Reel and every v1 Scroll count as plain. Personal Context hands the cells to Composer as four fields each. A process
from before migration 0082 counts the parent and not the cell, so a correction never takes a count below zero.

Activity uses a 14-day half-life. Late qualification, original action toggles or metadata corrections
replace the prior exposure contribution at the **same evaluation time**, including per-channel
aggregates. Per-topic-format O counts usable qualification measurements and Q qualified encounters;
unknown measurements enter neither. Format twins retain one explanation identity for established
novelty and do not fabricate conceptual variety.

`ReadPreparedActivity` is retained for direct legacy compatibility fixtures only (explicit
`legacyPreparedRead: true`; absent from shipped providers). Its bounded read contains: actual latest 20 activated
encounters within 24h, indexed candidate-relevant established explanation/facet probes independent
of the 24h window, requested-topic aggregates, candidate-bounded current Hide and scope watermark.
Hide is read only for supplied actual candidate asset IDs (<=100 unique UUIDs), with a separate
selected-Hide recheck at navigation commit. Historical attribution is metadata, never opening permission.

Rollout requires an explicit root-controlled `ReconcileEncounterActivity(authority,{after?,limit})`
call. It visits <=100 actual activated IDs per invocation, rechecks epoch, and enqueues the **same**
normal job only for missing/stale vectors without pending work. Its page cursor/examined/queued/
pending/metadataGaps/watermark report page enumeration and outstanding work honestly; page completion
is not proof jobs finished. Metadata gaps remain unknown. No automatic scheduler or swipe-time history
scan exists. Parent rollout must reconcile after metadata publication. No runtime invocation was
performed by this source task. Rollback stops new consumers/jobs; retained factual metadata is not
fabricated qualification. Migrations 18/19 are additive and require the complete ordered deployment
prefix, including separately owned 15 before dev rollout.

The erasure inventory includes all four activity tables and ordinary/retained/dead activity jobs.
Full erasure removes them before Experience's exposure roots. No formation, Planet, provider,
assessment, selective history-clearing, or client UI is implemented here.

Activity idempotence compares only the currently applied vector under the personal root lock.
An actual reversible attribution correction A->B->A appends three immutable monotonic revisions,
even though the first and third hashes coincide. Hash equality with older audit history is not a
uniqueness rule. The new current pointer and weighted scalar/channel/Q/O replacements commit
atomically; final redelivery of already-current A does nothing and creates no qualification row.


## Feeding Personal Context

Status: implemented, CI-tested against real PostgreSQL. Related: migration 0020, #235.

Evidence publishes a minimal backend-only `ActivityDerivedInput` under its existing personal root
transaction. The required shipped API/worker effect is the personal-context owner; no Evidence
adapter writes its tables. Activity replacement, derived structural replacement and one scope
revision/hint commit together. Failed derived work rolls the whole transaction back. Isolated
pre-context fixture assemblies may omit the effect; both shipped compositions explicitly bind it.
Current Evidence redelivery still reconciles a missing/stale personal-context contribution, without
appending duplicate activity. Unchanged source and derived state cause no revision or hint.
The explicit bounded reconciliation page now checks both owners' input currency; pending work and
metadata gaps remain explicit. It does not assert that queued jobs completed.

`ReadActivityStatistics` returns exact requested topics≤100, A plus independently decayed original
channels and source-owned Q/O evaluated at the same explicit time. PC derives I/F for its snapshot;
qualification and activity arithmetic remain unchanged. `ReadRecentTopicIds` uses the Evidence-owned
0020 `(universe,epoch,evaluated_at DESC,topic_id)` index, returns≤100 IDs, the selection policy
`recent_projected_topics.v0` and `hasMore`. It selects projection recency, never global highest A
from rows measured at different times. The transactional index creation needs a reviewed rollout
window with the migration's bounded lock/statement timeouts; no concurrent-creation workaround or
rewrite of 0019 is used.

`ReadObservationTail` accepts≤20 caller-provided actual recent exposure IDs and returns≤20 event/
exposure/sequence references, plus `hasMore`. Indexed observation sequences already covered by an
evidence input watermark are excluded. This is a private, routing-only pending tail, never formation,
qualification or another contribution. Source bodies and peer playback/navigation are absent.


Production navigation now requires Personal Context's READ_COMPOSER_CONTEXT capability. Evidence
continues to supply its owned statistics and routing-input ports to PC, but the former prepared
activity reader cannot be selected as a runtime fallback. This wiring change alters no evidence
qualification, activity arithmetic, projection policy, queue, table or erasure behavior.

Planner material-change callback (#236): after an actual activity/PC change and scope revision
advance, shipped API and worker composition invoke the Planner request facility in that same
transaction. Deduplicated unchanged projection invokes nothing. A callback/job failure rolls
Evidence, PC and revision back; the callback supplies no harness and writes no evidence.

## Observed static coverage

Status: implemented, CI-tested against real PostgreSQL. Related: #237, migration 0023.

The shipped activity composition prepares a separate `observed-static-coverage.v1` certificate,
without changing qualification policy, q, scalar/channel/Q/O arithmetic or activity input hashes.
Only the exact latest owned qualified Scroll revision under the personal root is considered:
accepted summary-v1 seen block IDs (the existing 500ms active-visible intersection/peak 0.5 policy),
qualification-policy lineage, immutable Content facts v2 and the reviewed current exact mapping.
Each binding requires ALL mapped static top-level paragraph/quote/callout IDs in the persisted seen
set. Partial qualified reading cannot credit unseen facets. Heading, disclosure descendants,
interactive states, arbitrary topic tags/prefixes, social/supply and unviewed assets confer none.
Reel certificates explicitly remain unsupported; aggregate media time cannot locate a facet.
These are observed coverage facts, never learning, understanding, belief or identity claims.

Certificates bind universe/epoch/activation, exact asset/document/provenance/explanation/framing,
Evidence ID/revision/watermark/policy/summary digest, facts v2 digest, current mapping head/digest and
catalogue/meaning identities. Max 16 bindings/80 seen IDs and 16KiB serialized certificate; unsupported,
missing, malformed or unapproved content remains unavailable. Content's shipped semantic approval
list remains empty. No source/map is admitted by this consumer.

The required PC effect applies both projections in the existing activity transaction. Even if the
activity hash is unchanged, independent coverage currency is compared: map-only correction is
reconciled by the existing explicit<=100 exposure page and same ordinary queue. Current real
activity ID is reused, no extra activity revision is fabricated, and unchanged combined state
advances no revision/hint. Failed coverage work rolls back the combined transaction. Positive apply
holds Content current-head SHARE authority and rechecks latest Evidence after lock waits. No new
queue, Content-personal fanout, network/provider wait or swipe-time history reconstruction exists.
Evidence's `CheckCoverageEvidence` capability batch-checks<=1000 exact current certificates using
indexed latest-row probes; other owners never read Evidence tables directly. PC's live trusted
proof read additionally revalidates/locks Content authority until caller commit. Stored reference
counts alone never authorize geography after a correction/retraction/withdrawal.

A current descriptor or accepted activation/session alone is not an activity source. Explicit projection returns `no_current_source`, and reconciliation examines without queuing or changing metadata-gap counts, until an exact current qualification pointer (including an actual unknown qualification), non-NULL channel decision, or actual same-generation H/R exists. This refusal precedes credit/cache reads and preserves committed heads and effective credit. An explicit false channel decision remains a correction source; NULL does not become zero credit.

## Selecting the recording channel

Status: implemented in source and CI; not exercised on a running system. Related: migration 0044.

The real Activity provider now requires Experience READ_RECORDING_CHANNEL_SELECTION. For each
positive effective L/B it uses at most two exact current asset/channel probes, requiring the
selected exposure and matching explicit origin action. A legacy_unknown result can only retain
its already committed baseline channel, never add a positive override. Current necessary flags
and refreshed Content metadata cannot create certification or repair historical attribution.
The existing own committed baseline/current segment qualification and PC four-method effect
protocol remain distinct. Grouped synchronous corrections use at most two exposure deltas, one
revision/material effect and no independent notice. The deferred SQL positive-credit guard also
checks final current pointer/certificate rows; sealed source heads are untouched. No queue,
provider authority, history scan, backfill or recording control is added. Hosted real-graph
fixtures, complete DI/process replacement and runtime acceptance remain separately required.

The Activity provider also requires the actual Identity lifecycle read before any segment projection.
A genuine current mode 1 root missing its witness is not_ready: jobs/read preparation create no
new projection, while producer necessary commands remain available with ineligible origins.
Session/queue/grouped effect entry points fail if called as collection on not_ready authority.
This is separate from missing providers, corrupt protocol or forged/closed scope refusal.
