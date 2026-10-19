-- 0002_receipts: command receipts, so a retried command returns its first outcome.
--
-- Owner: infrastructure/receipts (used by every module's commands). Authoritative.
-- Reads: receipt by (universe_id, command_id) inside the locked personal scope; shared receipt by
--   (scope_kind, scope_id, actor_account_id, operation, command_id).
-- Writes: one insert before the command's effects and one outcome update, in the command's
--   transaction.
-- Growth: one row per accepted command. Retention: product retention policy (not yet set); erased
--   with the universe through the erasure registry.
-- Rollout: new schema.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema receipts;

create table receipts.personal_commands (
  universe_id uuid not null,
  command_id uuid not null,
  operation text not null,
  -- SHA-256 of the canonical validated request, including the revisions it relied on.
  request_hash text not null,
  -- Bounded JSON outcome; NULL while the command's transaction is still open.
  outcome jsonb,
  outcome_version integer not null default 1,
  privacy_epoch integer not null,
  created_at timestamptz not null default now(),
  constraint personal_commands_pkey primary key (universe_id, command_id),
  constraint personal_commands_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint personal_commands_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint personal_commands_operation_check check (operation ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  constraint personal_commands_outcome_check check (outcome is null or (jsonb_typeof(outcome) = 'object' and pg_column_size(outcome) <= 8192))
);

create table receipts.shared_commands (
  scope_kind text not null,
  scope_id uuid not null,
  actor_account_id uuid not null,
  operation text not null,
  command_id uuid not null,
  request_hash text not null,
  outcome jsonb,
  outcome_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint shared_commands_pkey primary key (scope_kind, scope_id, actor_account_id, operation, command_id),
  constraint shared_commands_actor_fkey foreign key (actor_account_id) references identity.accounts (id) on delete restrict,
  constraint shared_commands_scope_kind_check check (scope_kind ~ '^[a-z][a-z0-9_]*$'),
  constraint shared_commands_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint shared_commands_operation_check check (operation ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  constraint shared_commands_outcome_check check (outcome is null or (jsonb_typeof(outcome) = 'object' and pg_column_size(outcome) <= 8192))
);

create index shared_commands_actor_idx on receipts.shared_commands (actor_account_id);
