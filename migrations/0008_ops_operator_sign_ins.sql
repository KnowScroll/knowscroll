-- 0008_ops_operator_sign_ins: the durable audit of operator sign-in links (S1.3 #226, D-007, D-022).
--
-- Owner: ops (operator tooling); written only by `dist/operator.js issue-sign-in` (identity's
--   operator use case), in the same transaction that mints the link. Authoritative audit.
-- Reads: by operators over SQL (who issued links on this world, when, for which account).
-- Writes: one row per issued operator link; never updated except by account deletion.
-- Growth: one row per operator use on dev/stage (a handful a day at most).
-- Retention/erasure: kept as an audit, not exploration history: clearing or resetting a universe
--   leaves it. Account deletion turns a row into a tombstone (account_id set to null; world, time
--   and source stay) — declared as an account-linked column in identity's erasure declaration.
-- Rollout: new schema and table; no older process reads them.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema if not exists ops;

create table ops.operator_sign_ins (
  id uuid not null,
  world text not null,
  issued_at timestamptz not null default now(),
  -- Who ran the command: `cli:<sudo user or user>`, or `cli:unknown`.
  operator_source text not null,
  -- The account the link opens; null once the account was deleted (tombstone).
  account_id uuid,
  account_created boolean not null,
  constraint operator_sign_ins_pkey primary key (id),
  constraint operator_sign_ins_account_fkey foreign key (account_id) references identity.accounts (id) on delete restrict,
  constraint operator_sign_ins_world_check check (world in ('dev', 'stage', 'ci', 'local')),
  constraint operator_sign_ins_source_check check (operator_source ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$')
);

create index operator_sign_ins_account_idx on ops.operator_sign_ins (account_id);
create index operator_sign_ins_issued_idx on ops.operator_sign_ins (issued_at);
