-- 0006_reasoning_ledger: business runs and external (paid) attempts of the shared reasoning
-- engine, for personal work. Skeleton: the states are reserved now; providers arrive in Phase 2
-- (S2.2). Shared (non-personal) runs get their own tables when the first shared role needs them.
--
-- Owner: reasoning engine. Authoritative for attempt accounting; owning modules keep their own
--   business content (plans, proposals) elsewhere.
-- Identity (blueprint §5): personal records keyed (universe_id, id); an attempt is tied to its own
--   run in the same universe by a composite foreign key, so erasure of one universe can never be
--   blocked by, or reach, another universe's rows.
-- Reads: attempt by (universe_id, run_id, step) on every delivery; attempts in `unknown` for
--   reconciliation.
-- Writes: run admission; attempt reserve → dispatched under personal authority; ledger-owned
--   settlement (succeeded / failed / unknown / not_sent / reconciled) in short transactions that do
--   not depend on current authority, never across the provider call.
-- Growth: one run per admitted job, one attempt per external call (repairs are new steps).
-- Retention/erasure: personal; erased per universe, except attempts whose outcome is still
--   unsettled (dispatched/unknown), which are kept as open liability and reported as pending.
-- Rollout: new schema.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema reasoning;

create table reasoning.business_runs (
  universe_id uuid not null,
  id uuid not null,
  owner_module text not null,
  purpose text not null,
  privacy_epoch integer not null,
  state text not null default 'admitted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_runs_pkey primary key (universe_id, id),
  constraint business_runs_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint business_runs_state_check check (state in ('admitted', 'completed', 'failed', 'cancelled'))
);

create table reasoning.external_attempts (
  universe_id uuid not null,
  id uuid not null,
  run_id uuid not null,
  step text not null,
  provider text not null,
  model text not null,
  -- SHA-256 of the immutable request; a redelivery with another request is refused.
  request_hash text not null,
  state text not null default 'reserved',
  remote_id text,
  outcome_code text,
  reserved_at timestamptz not null default now(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  constraint external_attempts_pkey primary key (universe_id, id),
  constraint external_attempts_run_step_key unique (universe_id, run_id, step),
  constraint external_attempts_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint external_attempts_run_fkey foreign key (universe_id, run_id) references reasoning.business_runs (universe_id, id) on delete restrict,
  constraint external_attempts_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint external_attempts_state_check check (
    state in ('reserved', 'not_sent', 'dispatched', 'succeeded', 'failed', 'unknown', 'reconciled', 'written_off')
  )
);

create index external_attempts_unknown_idx on reasoning.external_attempts (state) where state = 'unknown';
