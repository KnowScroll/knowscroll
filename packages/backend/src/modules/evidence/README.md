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
