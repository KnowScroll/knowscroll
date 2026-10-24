-- Account deletion, data export and session management (#246, D-043).
--
-- Owner: modules/identity. Authoritative.
--
-- identity.accounts and identity.universes gain the status `deleting`. A deleting account is
-- fenced like a suspended one by every existing check (they all test `status = 'active'`), and
-- only the deletion worker may enter its universe. The deletion operation itself is a row in
-- identity.account_deletions. Its id is chosen by the client and doubles as the receipt a signed-out
-- device can still ask about. When the work is done the row loses its account and universe link
-- and stays as an audit row with no personal data: the id, two timestamps and a state.
--
-- identity.data_exports holds one person's export: a bounded JSON file kept in the row until the
-- first download, expiry, or account deletion, whichever comes first. A download link is the
-- SHA-256 of a one-time random token with a 60 second life. Account table: account deletion
-- removes the rows.
--
-- identity.sessions gains the coarse device label shown in Account ("Chrome on macOS") and a last
-- use time that is written at most every ten minutes.
--
-- Queries: deletions by id (receipt), by account (fence), due ones by next_attempt_at (recovery);
-- exports by account newest first, by link hash; sessions by account (existing index).
-- Growth: one deletion row per deleted account, forever; at most five exports per account;
-- sessions as before.
-- Rollout: additive. An older process never writes `deleting` or reads the new columns; it keeps
-- refusing anything whose status is not `active`.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- squawk-ignore ban-drop-constraint
alter table identity.accounts drop constraint accounts_status_check;
alter table identity.accounts
  add constraint accounts_status_check check (status in ('active', 'suspended', 'deleting')) not valid;

-- squawk-ignore ban-drop-constraint
alter table identity.universes drop constraint universes_status_check;
alter table identity.universes
  add constraint universes_status_check check (status in ('active', 'suspended', 'deleting')) not valid;

alter table identity.sessions add column device_label text;
alter table identity.sessions add column last_used_at timestamptz;
alter table identity.sessions
  add constraint sessions_device_label_check
  check (device_label is null or char_length(device_label) between 1 and 80) not valid;

create table identity.account_deletions (
  id uuid primary key,
  account_id uuid references identity.accounts (id) on delete restrict,
  scope_id uuid references identity.universes (id) on delete restrict,
  requested_at timestamptz not null default now(),
  state text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  failure_code text,
  completed_at timestamptz,
  constraint account_deletions_state_check check (state in ('pending', 'completed')),
  constraint account_deletions_failure_check
    check (failure_code is null or failure_code in ('waiting_for_accounting', 'temporarily_unavailable')),
  constraint account_deletions_shape_check check (
    (state = 'pending' and account_id is not null and scope_id is not null and completed_at is null)
    or (state = 'completed' and account_id is null and scope_id is null
        and completed_at is not null and failure_code is null)
  )
);

-- squawk-ignore require-concurrent-index-creation
create unique index account_deletions_account_key on identity.account_deletions (account_id)
  where account_id is not null;
-- squawk-ignore require-concurrent-index-creation
create unique index account_deletions_scope_key on identity.account_deletions (scope_id)
  where scope_id is not null;
-- squawk-ignore require-concurrent-index-creation
create index account_deletions_due on identity.account_deletions (next_attempt_at) where state = 'pending';

create table identity.data_exports (
  id uuid primary key,
  account_id uuid not null references identity.accounts (id) on delete restrict,
  state text not null default 'preparing',
  requested_at timestamptz not null default now(),
  ready_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  payload bytea,
  link_hash text,
  link_expires_at timestamptz,
  constraint data_exports_state_check
    check (state in ('preparing', 'ready', 'downloaded', 'expired', 'failed')),
  constraint data_exports_payload_check check (
    (state = 'ready') = (payload is not null) and (payload is null or octet_length(payload) <= 8388608)
  ),
  constraint data_exports_ready_check check (
    (state in ('ready', 'downloaded', 'expired')) = (ready_at is not null and expires_at is not null)
  ),
  constraint data_exports_link_check check (
    (link_hash is null and link_expires_at is null)
    or (state = 'ready' and link_hash ~ '^[0-9a-f]{64}$' and link_expires_at is not null)
  )
);

-- squawk-ignore require-concurrent-index-creation
create index data_exports_account on identity.data_exports (account_id, requested_at desc);
-- squawk-ignore require-concurrent-index-creation
create unique index data_exports_link_key on identity.data_exports (link_hash) where link_hash is not null;
