-- 0006_reasoning_ledger: business runs and external (paid) attempts of the shared reasoning
-- engine. Skeleton: the states are reserved now; providers arrive in Phase 2 (S2.2).
--
-- Owner: reasoning engine. Authoritative for attempt accounting; owning modules keep their own
--   business content (plans, proposals) elsewhere.
-- Reads: attempt by (run_id, step) on every delivery; runs/attempts in `unknown` for
--   reconciliation.
-- Writes: run admission; attempt reserve → dispatched → succeeded/failed/unknown, each in its own
--   short transaction, never across the provider call.
-- Growth: one run per admitted job, one attempt per external call (repairs are new steps).
-- Retention/erasure: personal runs carry universe_id and are erased per universe.
-- Rollout: new schema.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema reasoning;

create table reasoning.business_runs (
  id uuid primary key,
  owner_module text not null,
  purpose text not null,
  universe_id uuid,
  privacy_epoch integer,
  state text not null default 'admitted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_runs_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint business_runs_state_check check (state in ('admitted', 'completed', 'failed', 'cancelled')),
  constraint business_runs_scope_check check ((universe_id is null) = (privacy_epoch is null))
);

create index business_runs_universe_idx on reasoning.business_runs (universe_id) where universe_id is not null;

create table reasoning.external_attempts (
  id uuid primary key,
  run_id uuid not null,
  step text not null,
  universe_id uuid,
  provider text not null,
  model text not null,
  -- SHA-256 of the immutable request; the protected request bytes live elsewhere, never in logs.
  request_hash text not null,
  state text not null default 'reserved',
  remote_id text,
  outcome_code text,
  reserved_at timestamptz not null default now(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  constraint external_attempts_run_step_key unique (run_id, step),
  constraint external_attempts_run_fkey foreign key (run_id) references reasoning.business_runs (id) on delete restrict,
  constraint external_attempts_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint external_attempts_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint external_attempts_state_check check (
    state in ('reserved', 'not_sent', 'dispatched', 'succeeded', 'failed', 'unknown', 'reconciled', 'written_off')
  )
);

create index external_attempts_universe_idx on reasoning.external_attempts (universe_id) where universe_id is not null;
create index external_attempts_unknown_idx on reasoning.external_attempts (state) where state = 'unknown';
