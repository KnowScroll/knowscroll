# modules/evidence

Owns: `evidence.action_events` (`0005`, the explicit-action channel: a Save is not a consumption
encounter), `evidence.observations` and `evidence.encounter_evidence` (`0012_evidence_observations`).

## Operations

| Operation | Trigger | Authority, effects, redelivery |
|---|---|---|
| `applyActionEvidence(payload)` | queue `evidence.apply-action` (worker) | `system` actor for the payload's universe at the payload's epoch, rechecked under the personal lock. One transaction: read the action (experience's `READ_ACTION_FOR_EVIDENCE` port) → insert the event keyed `(universe_id, action_id)`. Evidence changes nothing a client reads, so the job advances no revision and sends no hint. A redelivery finds the key and does nothing (`already_applied`); work from an older epoch is skipped (`epoch_changed`). |
| `ingestObservations(authority, {instrumentationVersion, events})` | `POST /v1/observations/batch` | Durable intake of the recorder's `interaction.v1` events. Caller's authority under the personal lock; **idempotent per `(universe, event ID)`** (`ON CONFLICT DO NOTHING`: a retried batch counts nothing twice; the first writer wins). Per event, in order: the exposure exists in this universe and epoch (`exposure_unknown`; foreign and unknown are indistinguishable), the event names the exposure's asset and revision (`lineage_mismatch`), the exposure is activated (`exposure_not_active`), every block ID exists in that immutable revision (`block_unknown`), interaction kinds must be declared by scroll-model `INTERACTION_KINDS` for the stored block type (`interaction_kind_invalid`), the event is not older than a week (`too_old`) and the exposure's intake limit (1,000) is not reached (`exposure_event_limit`). **Client claims are bounded, not trusted** (`observation-bounds.v1`): a future `occurredAt` is clamped to receipt time, and intervals and offsets are clipped to the wall time elapsed since activation plus 2 s; the stored payload is the bounded one (`bounded` is recorded). Each accepted event gets the exposure's next `seq`, so the highest `seq` is its input watermark. In the **same transaction** one `evidence.project-scroll-reading` job is enqueued per exposure that gained an observation (pg-boss is the only outbox). A batch over 48 KiB is refused (`PAYLOAD_TOO_LARGE`); an older epoch is refused (`PRIVACY_EPOCH_CHANGED`). Acknowledgement means **stored**, never projected. No receipt (observations are not commands), no revision bump, no hint. |
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

## Tables, jobs, lock order, erasure

| Table | Holds |
|---|---|
| `evidence.action_events` | One row per applied Save/Unsave, keyed `(universe_id, action_id)` |
| `evidence.observations` | Accepted observations: `event_id` (unique per universe), recorder session and device sequence, `exposure_id`, per-exposure `seq`, kind, bounded payload, `occurred_at`/`received_at`, `bounded`, epoch |
| `evidence.encounter_evidence` | Evidence revisions: `revision`, `input_watermark`, `policy_version`, `qualification`, `q`, `coverage`, dwell, reading estimate, a bounded summary (seen block IDs, interactions, reason codes), epoch |

Queues (`events.ts`): `evidence.apply-action` and `evidence.project-scroll-reading`, each expiry 60 s, 8
retries with backoff from 2 s, dead letter `<name>.dead`, retained 7 days queued / 2 days completed.
Lock order: personal root only (the exposure and facts are read inside the same scope). Erasure: the three
tables and both queues' payloads per universe (`adapters/erasure.ts`); raw observations are not promised
replayable forever.

## Reel observations (S2.4)

`reel.playback` carries bounded pairs of continuous active-time and media-time intervals, without text
or playback position shared to peers. Intake applies the same scope/epoch/activation/lineage/batch
idempotency and elapsed-time bounds; media endpoints must lie inside the admitted duration. Scroll
kinds cannot use Reel facts or vice versa. The existing durable projection queue dispatches by the
admitted revision's facts. `reel-qualification.v0` computes unique visible media / duration, capped by
unique active time, with experimental q≥0.6. Overlap, loops and duplicate delivery add no unique media;
missing/gapped instrumentation leaves short encounters unknown. Consumer navigation/open/grant renewal
is not evidence. Diagnostics retain q, unique media, active time, duration and policy version.

## Actual activity and prepared routing context (0019, #234 backend slice)

`activity.v0` keeps q, Like L, bookmark B, confirmed Share S (currently0), deliberate horizontal H
and separated return R independently. Routing activity is `min(3,q+.5L+1.5B+S+1.5H+2R)`;
unknown q remains null and never becomes qualification or usable format measurement. H belongs
once to the activated **source** of an actually activated series/related destination. Variants,
offers, failures and Back add no H. R belongs to a new explicitly activated return at least30min
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
| `topic_context` | Scope/topic decayed activity and independent channel aggregates; per-topic-format Q/O | One/topic; exact requested topics<=100; update affected union<=32topics, no lifetime scan |

Activity uses a14day half-life. Late qualification, original action toggles or metadata corrections
replace the prior exposure contribution at the **same evaluation time**, including per-channel
aggregates. Per-topic-format O counts usable qualification measurements and Q qualified encounters;
unknown measurements enter neither. Format twins retain one explanation identity for established
novelty and do not fabricate conceptual variety.

`ReadPreparedActivity` implements Composer's bounded prepared-input port: actual latest20 activated
encounters within24h, indexed candidate-relevant established explanation/facet probes independent
of the24h window, requested-topic aggregates, candidate-bounded current Hide and scope watermark.
Hide is read only for supplied actual candidate asset IDs (<=100 unique UUIDs), with a separate
selected-Hide recheck at navigation commit. Historical attribution is metadata, never opening permission.

Rollout requires an explicit root-controlled `ReconcileEncounterActivity(authority,{after?,limit})`
call. It visits <=100 actual activated IDs per invocation, rechecks epoch, and enqueues the **same**
normal job only for missing/stale vectors without pending work. Its page cursor/examined/queued/
pending/metadataGaps/watermark report page enumeration and outstanding work honestly; page completion
is not proof jobs finished. Metadata gaps remain unknown. No automatic scheduler or swipe-time history
scan exists. Parent rollout must reconcile after metadata publication. No runtime invocation was
performed by this source task. Rollback stops new consumers/jobs; retained factual metadata is not
fabricated qualification. Migrations18/19 are additive and require the complete ordered deployment
prefix, including separately owned15 before dev rollout.

The erasure inventory includes all four activity tables and ordinary/retained/dead activity jobs.
Full erasure removes them before Experience's exposure roots. No formation, Planet, provider,
assessment, selective history-clearing, or client UI is implemented here.

Activity idempotence compares only the currently applied vector under the personal root lock.
An actual reversible attribution correction A->B->A appends three immutable monotonic revisions,
even though the first and third hashes coincide. Hash equality with older audit history is not a
uniqueness rule. The new current pointer and weighted scalar/channel/Q/O replacements commit
atomically; final redelivery of already-current A does nothing and creates no qualification row.


## Personal-context integration (0020, #235)

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
rewrite of0019 is used.

`ReadObservationTail` accepts≤20 caller-provided actual recent exposure IDs and returns≤20 event/
exposure/sequence references, plus `hasMore`. Indexed observation sequences already covered by an
evidence input watermark are excluded. This is a private, routing-only pending tail, never formation,
qualification or another contribution. Source bodies and peer playback/navigation are absent.
