-- 0007_identity_sign_in: email addresses, single-use sign-in links and sessions (S1.3 #226, D-022).
--
-- Owner: identity module. Authoritative.
-- Reads: address → account (redeem, operator sign-in); link by token hash (peek, redeem); email
--   links issued in the last 15 minutes per address, per recipient domain and world-wide (the
--   sign-in budgets); session by token hash joined to its account and universe (every
--   authenticated request and socket handshake); session by id (socket rechecks); live sessions
--   issued by one redemption command (its replay).
-- Writes: one link per issued sign-in or operator issue; redeem consumes the link once, creates
--   the account, its address and its universe root on first sign-in (one transaction, with a
--   command receipt) and inserts one session; sign-out and replaced sessions are revoked.
-- Growth: one address per account; links are short-lived (≤ 15 minutes); sessions one per
--   signed-in device, at most 30 days each.
-- Retention/erasure: personal (an address is personal data, and a link holds one even before an
--   account exists). The identity sweep job (pg-boss, every 15 minutes) deletes links a day after
--   they expired and sessions 30 days after they ended; an account's ended sessions also go at
--   its next sign-in. Account deletion removes the address, its links and sessions (identity's
--   erasure declaration). Nothing cascades.
-- Rollout: new tables; no older process reads them.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table identity.email_addresses (
  account_id uuid not null,
  -- Normalised: ASCII, lower-cased, RFC 5321 subset (domain/addresses.ts).
  address text not null,
  -- Created by operator sign-in on dev/stage (D-007); cleared once the address proves itself by a
  -- mailed link. Operator links are issued only for disposable accounts, and operator sign-in is
  -- allowed only for addresses matching the world's KS_OPERATOR_SIGN_IN_PATTERN, at issue and at
  -- redemption.
  disposable boolean not null default false,
  created_at timestamptz not null default now(),
  constraint email_addresses_pkey primary key (account_id),
  constraint email_addresses_account_fkey foreign key (account_id) references identity.accounts (id) on delete restrict,
  constraint email_addresses_address_key unique (address),
  constraint email_addresses_address_check check (
    char_length(address) between 3 and 254 and address = lower(address) and address ~ '^[!-?A-~]+@[a-z0-9.-]+$'
  )
);

create table identity.sign_in_links (
  -- SHA-256 (hex) of the link's token. The token itself is never stored.
  token_hash text not null,
  address text not null,
  -- The address's domain: the per-recipient-domain budget counts by it.
  domain text not null,
  origin text not null,
  -- Native sign-in only: base64url SHA-256 of the verifier the requesting app keeps in its secure
  -- store (PKCE-style binding, D-022). A link with one is redeemed only with that verifier.
  code_challenge text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- The redeem command that consumed the link; a retry of that command may replay its outcome.
  consumed_command_id uuid,
  consumed_account_id uuid,
  constraint sign_in_links_pkey primary key (token_hash),
  constraint sign_in_links_account_fkey foreign key (consumed_account_id) references identity.accounts (id) on delete restrict,
  constraint sign_in_links_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint sign_in_links_address_check check (char_length(address) between 3 and 254 and address = lower(address)),
  constraint sign_in_links_domain_check check (domain = split_part(address, '@', 2)),
  constraint sign_in_links_origin_check check (origin in ('email', 'operator')),
  constraint sign_in_links_challenge_check check (code_challenge is null or code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  constraint sign_in_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  constraint sign_in_links_consumed_check check (
    (consumed_at is null) = (consumed_command_id is null) and (consumed_at is null) = (consumed_account_id is null)
  )
);

create index sign_in_links_address_idx on identity.sign_in_links (address, created_at);
create index sign_in_links_domain_idx on identity.sign_in_links (domain, created_at);
create index sign_in_links_created_idx on identity.sign_in_links (created_at);
create index sign_in_links_expiry_idx on identity.sign_in_links (expires_at);

create table identity.sessions (
  id uuid not null,
  account_id uuid not null,
  -- SHA-256 (hex) of the session token (cookie value on the web, bearer token on native).
  token_hash text not null,
  client text not null,
  -- The redemption command that issued it: a replay of that command needs one of its sessions
  -- still live, and replaces it.
  issued_by_command uuid,
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
    and (revoked_reason is null or revoked_reason in ('signed_out', 'signed_out_everywhere', 'replaced'))
  )
);

create index sessions_account_idx on identity.sessions (account_id);
create index sessions_command_idx on identity.sessions (issued_by_command) where issued_by_command is not null;
create index sessions_expiry_idx on identity.sessions (expires_at);
