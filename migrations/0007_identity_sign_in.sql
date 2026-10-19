-- 0007_identity_sign_in: email addresses, single-use sign-in links and sessions (S1.3 #226, D-018).
--
-- Owner: identity module. Authoritative.
-- Reads: address → account (redeem, operator sign-in); link by token hash (redeem); links of one
--   address in the last 15 minutes (rate limit); session by token hash joined to its account and
--   universe (every authenticated request and socket handshake); session by id (socket rechecks).
-- Writes: one link per sign-in request or operator issue; redeem consumes the link once, creates
--   the account, its address and its universe root on first sign-in (one transaction, with a
--   command receipt) and inserts one session; sign-out revokes sessions.
-- Growth: one address per account; links are short-lived (≤ 15 minutes) and deleted a day after
--   they expire; sessions one per signed-in device, at most 30 days each, and an account's ended
--   sessions are deleted at its next sign-in.
-- Retention/erasure: personal (an address is personal data, and a link holds one even before an
--   account exists). Expired links are deleted by the request path a day after expiry. Account
--   deletion removes the address, its links and sessions (identity's erasure declaration).
--   Nothing cascades.
-- Rollout: new tables; no older process reads them.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table identity.email_addresses (
  account_id uuid not null,
  -- Normalised: trimmed and lower-cased (domain/addresses.ts).
  address text not null,
  -- Created by operator sign-in on dev/stage (D-007): a disposable test account. Operator sign-in
  -- never issues links for an address whose account is not disposable.
  disposable boolean not null default false,
  created_at timestamptz not null default now(),
  constraint email_addresses_pkey primary key (account_id),
  constraint email_addresses_account_fkey foreign key (account_id) references identity.accounts (id) on delete restrict,
  constraint email_addresses_address_key unique (address),
  constraint email_addresses_address_check check (
    char_length(address) between 3 and 254 and address = lower(address) and address ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  )
);

create table identity.sign_in_links (
  -- SHA-256 (hex) of the link's token. The token itself is never stored.
  token_hash text not null,
  address text not null,
  origin text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- The redeem command that consumed the link; a retry of that command replays its outcome.
  consumed_command_id uuid,
  consumed_account_id uuid,
  constraint sign_in_links_pkey primary key (token_hash),
  constraint sign_in_links_account_fkey foreign key (consumed_account_id) references identity.accounts (id) on delete restrict,
  constraint sign_in_links_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint sign_in_links_address_check check (char_length(address) between 3 and 254 and address = lower(address)),
  constraint sign_in_links_origin_check check (origin in ('email', 'operator')),
  constraint sign_in_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  constraint sign_in_links_consumed_check check (
    (consumed_at is null) = (consumed_command_id is null) and (consumed_at is null) = (consumed_account_id is null)
  )
);

create index sign_in_links_address_idx on identity.sign_in_links (address, created_at);
create index sign_in_links_expiry_idx on identity.sign_in_links (expires_at);

create table identity.sessions (
  id uuid not null,
  account_id uuid not null,
  -- SHA-256 (hex) of the session token (cookie value on the web, bearer token on native).
  token_hash text not null,
  client text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  constraint sessions_pkey primary key (id),
  constraint sessions_account_fkey foreign key (account_id) references identity.accounts (id) on delete restrict,
  constraint sessions_token_key unique (token_hash),
  constraint sessions_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint sessions_client_check check (client in ('web', 'native')),
  constraint sessions_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint sessions_revoked_check check (
    (revoked_at is null) = (revoked_reason is null)
    and (revoked_reason is null or revoked_reason in ('signed_out', 'signed_out_everywhere'))
  )
);

create index sessions_account_idx on identity.sessions (account_id);
