-- 0012_evidence_observations: durable observation intake and the evidence revisions projected
-- from it (S1.6, #229). Observations are not consumption evidence until a projection qualifies
-- them (blueprint §8, §19); intake acknowledgement means stored, not projected.
--
-- Owner: evidence module. Authoritative (observations) and derived (encounter_evidence).
-- Reads: one exposure's observations in intake order (the projection; bounded to the per-exposure
--   intake limit); the latest evidence revision of one exposure (the dev diagnostics read).
-- Writes: observations by the batch intake command (inside the personal scope, ON CONFLICT on
--   (universe_id, event_id) so a retried batch counts nothing twice); evidence revisions by the
--   `evidence.project-scroll-reading` job (a redelivery inserts nothing).
-- Growth: observations are bounded per exposure by the intake (1,000 events); evidence revisions
--   grow by one per distinct input watermark and policy version of an exposure.
-- Retention/erasure: personal; both tables are erased per universe through the erasure registry,
--   with the queue's payloads. Raw observations are not promised replayable forever (blueprint §5).
-- Rollout: new tables. Older processes neither write nor read them.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table evidence.observations (
  universe_id uuid not null,
  id uuid not null,
  -- The client's event ID: the idempotency key. A retried batch carries the same IDs.
  event_id uuid not null,
  -- The recorder session (not the authentication session) and the event's number within it; a gap
  -- in one session's numbers means events were lost, which keeps a qualification `unknown`.
  session_id uuid not null,
  device_sequence integer not null,
  exposure_id uuid not null,
  -- Intake order within the exposure: 1, 2, 3 ... assigned under the personal scope lock. The
  -- highest value is the exposure's input watermark.
  seq integer not null,
  asset_id uuid not null,
  asset_revision integer not null,
  schema_version text not null,
  kind text not null,
  instrumentation_version integer not null,
  -- Client time, never authority: clamped to the receive time when it claims the future.
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  -- True when the server bounded a claim (an interval beyond the elapsed wall time).
  bounded boolean not null default false,
  -- Bounded payload of the kind, after the intake's bounds were applied. Never free text.
  payload jsonb not null,
  privacy_epoch integer not null,
  constraint observations_pkey primary key (universe_id, id),
  constraint observations_event_key unique (universe_id, event_id),
  constraint observations_seq_key unique (universe_id, exposure_id, seq),
  constraint observations_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint observations_seq_check check (seq >= 1),
  constraint observations_sequence_check check (device_sequence >= 1),
  constraint observations_revision_check check (asset_revision >= 1),
  constraint observations_schema_check check (schema_version = 'interaction.v1'),
  constraint observations_kind_check check (kind in ('scroll.block_coverage', 'scroll.active_dwell', 'scroll.block_interaction')),
  constraint observations_instrumentation_check check (instrumentation_version >= 1),
  constraint observations_payload_check check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192)
);

create table evidence.encounter_evidence (
  universe_id uuid not null,
  id uuid not null,
  exposure_id uuid not null,
  -- 1, 2, 3 ... per exposure: a new revision exists only for new input or a new policy version.
  revision integer not null,
  -- The exposure's highest observation seq this revision was computed from (its input watermark).
  input_watermark integer not null,
  policy_version text not null,
  qualification text not null,
  q double precision not null,
  coverage double precision not null,
  active_dwell_ms integer not null,
  estimated_reading_ms integer not null,
  asset_id uuid not null,
  asset_revision integer not null,
  -- Bounded, versioned: seen blocks, interactions, reason codes. Codes and block IDs only.
  summary jsonb not null,
  privacy_epoch integer not null,
  created_at timestamptz not null default now(),
  constraint encounter_evidence_pkey primary key (universe_id, id),
  constraint encounter_evidence_revision_key unique (universe_id, exposure_id, revision),
  -- Redelivery of the projection job, or two jobs for one watermark, insert one revision only.
  constraint encounter_evidence_input_key unique (universe_id, exposure_id, input_watermark, policy_version),
  constraint encounter_evidence_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint encounter_evidence_revision_check check (revision >= 1),
  constraint encounter_evidence_watermark_check check (input_watermark >= 1),
  constraint encounter_evidence_policy_check check (policy_version ~ '^[a-z][a-z0-9.-]{1,39}$'),
  constraint encounter_evidence_qualification_check check (qualification in ('qualified', 'not_qualified', 'unknown')),
  constraint encounter_evidence_q_check check (q >= 0 and q <= 1),
  constraint encounter_evidence_coverage_check check (coverage >= 0 and coverage <= 1),
  constraint encounter_evidence_dwell_check check (active_dwell_ms >= 0 and estimated_reading_ms >= 0),
  constraint encounter_evidence_summary_check check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 16384)
);
