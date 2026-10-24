-- #242 Social owns direct conversations, their messages, each account's inbox revision and the
-- managed share links of exact content revisions.
--
-- Owner: social. Everything here is authoritative; nothing is derived.
-- Query shapes: the inbox reads one account's open memberships joined to their conversations and to
-- the friendship's current lineage, newest activity first (keyset on activity time and id); the
-- thread reads messages by (conversation, sequence) for history and by (conversation, change
-- sequence) for catch-up; a share link is found by the SHA-256 of its token; a person lists their own
-- live links newest first.
-- Locking: a conversation is a subordinate of its friendship. Every write takes the pair root lock
-- first (social.pairs row, after the actor's personal root), so sequences are gapless and a send and
-- a block cannot interleave. Inbox heads are bumped in canonical account order inside that lock.
-- Growth: one conversation per friendship lineage; messages grow with use (text at most 2000
-- characters); one inbox head per account; a handful of share links per account.
-- Retention: kept until an account is deleted. Clear keeps all of it, because conversations and
-- links are explicit communication, not exploration history. Deleting an account turns its messages
-- into tombstones in place (author, body and note removed, change sequence advanced), removes its
-- membership, inbox head and links, and leaves the other person's conversation closed and
-- readable: the pair row goes with the account, so pair_id is set to null and the survivor sees
-- "Deleted account" in its place (D-043).
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A friendship lineage (the accepted request id) owns at most one open conversation. When anyone
-- leaves, closed_at is set and the conversation accepts no new messages; a later start makes a new one.
create table social.conversations (
  conversation_id uuid primary key,
  pair_id uuid references social.pairs(pair_id) on delete set null,
  lineage uuid not null,
  last_sequence bigint not null default 0 check (last_sequence between 0 and 9007199254740991),
  last_change_sequence bigint not null default 0 check (last_change_sequence between 0 and 9007199254740991),
  last_activity_at timestamptz not null,
  created_at timestamptz not null,
  closed_at timestamptz,
  check (last_change_sequence >= last_sequence)
);
create unique index conversations_open_per_friendship on social.conversations(pair_id, lineage) where closed_at is null;

-- One row per person in a conversation. membership_revision is part of the reference a client holds;
-- it moves only when the membership itself changes, never for a peer's reading or muting.
create table social.conversation_members (
  conversation_id uuid not null references social.conversations(conversation_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  membership_id uuid not null unique,
  membership_revision bigint not null default 1 check (membership_revision between 1 and 9007199254740991),
  read_through_sequence bigint not null default 0 check (read_through_sequence between 0 and 9007199254740991),
  muted boolean not null default false,
  left_at timestamptz,
  primary key (conversation_id, account_id)
);
create index conversation_members_open on social.conversation_members(account_id) where left_at is null;

-- A message is a plain text bubble, or a card for an exact content revision with an optional note,
-- or a tombstone (no author, no body). command_id lets the author find the message of an unknown send.
create table social.messages (
  conversation_id uuid not null references social.conversations(conversation_id) on delete restrict,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  message_id uuid not null unique,
  change_sequence bigint not null check (change_sequence between 1 and 9007199254740991 and change_sequence >= sequence),
  command_id uuid,
  author_account_id uuid references identity.accounts(id) on delete restrict,
  recorded_at timestamptz not null,
  body_text text check (char_length(body_text) between 1 and 2000),
  asset_id uuid,
  asset_revision integer,
  note text check (char_length(note) between 1 and 2000),
  primary key (conversation_id, sequence),
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict,
  check (
    (author_account_id is not null and command_id is not null and body_text is not null
      and asset_id is null and asset_revision is null and note is null)
    or (author_account_id is not null and command_id is not null and body_text is null
      and asset_id is not null and asset_revision is not null)
    or (author_account_id is null and command_id is null and body_text is null
      and asset_id is null and asset_revision is null and note is null)
  )
);
create unique index messages_command on social.messages(conversation_id, author_account_id, command_id) where command_id is not null;
create index messages_changes on social.messages(conversation_id, change_sequence);

-- The account's inbox revision: the number a live hint carries. Bumped for both members when a
-- message commits and for one person when their own settings change, never for a peer's.
create table social.inbox_heads (
  account_id uuid primary key references identity.accounts(id) on delete restrict,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991)
);

-- A managed link to one exact content revision. Only the token's SHA-256 is stored. A link with a
-- conversation is private to that conversation's members; without one it shows public metadata.
create table social.content_shares (
  share_id uuid primary key,
  owner_account_id uuid not null references identity.accounts(id) on delete restrict,
  command_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  asset_id uuid not null,
  asset_revision integer not null,
  conversation_id uuid references social.conversations(conversation_id) on delete restrict,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict,
  unique (owner_account_id, command_id),
  check (expires_at > created_at)
);
create index content_shares_owner_live on social.content_shares(owner_account_id, created_at desc) where revoked_at is null;
