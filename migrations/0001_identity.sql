-- 0001_identity: accounts and personal universes, the personal root of every personal record.
--
-- Owner: identity module. Authoritative.
-- Reads: universe by id (personal-scope lock, every personal mutation); universe by account (sign-in).
-- Writes: account/universe creation (S1.3 authentication); revision bump per committed personal
--   change; privacy_epoch increment on privacy reset (S1.x privacy work).
-- Growth: one account and one universe per person (account_id is unique).
-- Retention/erasure: account deletion follows the erasure registry; nothing cascades from here.
-- Rollout: new schema; no older process reads it.
-- S1.3 adds authentication tables to this schema; these names and columns stay stable.
-- Suspension protocol (S1.3): suspending an account locks its universe row (FOR NO KEY UPDATE)
-- before changing account status, so no personal command that already passed its check can
-- commit after the suspension.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema identity;

create table identity.accounts (
  id uuid primary key,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint accounts_status_check check (status in ('active', 'suspended'))
);

create table identity.universes (
  id uuid primary key,
  account_id uuid not null,
  -- Advanced by a privacy reset; work tagged with an older epoch must not apply.
  privacy_epoch integer not null default 1,
  status text not null default 'active',
  -- Advanced by each committed change that subscribers should refetch; sent in scope_changed hints.
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  constraint universes_account_fkey foreign key (account_id) references identity.accounts (id) on delete restrict,
  constraint universes_account_key unique (account_id),
  constraint universes_privacy_epoch_check check (privacy_epoch >= 1),
  constraint universes_status_check check (status in ('active', 'suspended')),
  constraint universes_revision_check check (revision >= 0)
);
