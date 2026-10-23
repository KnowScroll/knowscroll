-- 0005_evidence_action_events: the evidence module's record of explicit actions (an action
-- channel, separate from consumption evidence: a Save is not an encounter).
--
-- Owner: evidence module. Authoritative.
-- Reads: events by universe (projections, later); existence by (universe_id, action_id) on
--   redelivery.
-- Writes: one row per applied action by the `evidence.apply-action` job. The unique key makes a
--   redelivered job harmless.
-- Growth: one row per action. Retention/erasure: personal; erased per universe.
-- Rollout: new schema.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema evidence;

create table evidence.action_events (
  universe_id uuid not null,
  id uuid not null,
  action_id uuid not null,
  kind text not null,
  asset_id uuid not null,
  asset_revision integer not null,
  privacy_epoch integer not null,
  recorded_at timestamptz not null default now(),
  constraint action_events_pkey primary key (universe_id, id),
  constraint action_events_action_key unique (universe_id, action_id),
  constraint action_events_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint action_events_kind_check check (kind in ('save', 'unsave'))
);
