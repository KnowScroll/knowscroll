-- #243 Social owns content threads: a Reel or Scroll, the people it was shared with and their
-- conversation about it. A thread is a conversation of kind 'thread' with a root (an exact asset
-- revision), a starter, invited members, and messages that may be snippets (anchored references
-- into the original content).
--
-- Owner: social. Everything here is authoritative; nothing is derived.
-- Query shapes: a person's threads (open memberships, newest activity first); one thread's members
-- with their profiles; messages by (conversation, sequence) and (conversation, change sequence) as
-- for direct conversations; one snippet by its message.
-- Locking: a thread is its own shared root (kind social_thread, the conversation row). Every write
-- takes the actor's personal root and own account gate first, then the conversation row FOR UPDATE;
-- reads take it FOR SHARE. Counters stay atomic SQL increments, as in 0056, so account deletion can
-- tombstone messages without holding the thread lock.
-- Access: a member that was invited keeps access while the friendship that carried the invitation
-- stands (invited_lineage equals the pair's accepted lineage); Remove and Block end it for that
-- member. A member whose inviter left or deleted the account stands on their membership alone
-- (invited_by_account_id and invited_lineage are then null).
-- Growth: one conversation and one thread row per thread; at most nine members; one snippet row per
-- snippet message (a quote is at most 600 characters, block settings at most 1 KiB).
-- Retention: kept until a member deletes their account. Clear keeps all of it (explicit
-- communication, D-042). Deleting an account removes its membership, tombstones its messages and
-- deletes their snippet rows; the thread stays for the others with "Deleted account" in its place.
-- Rollout: additive. The new columns default so 0056 writers keep working; direct conversations
-- are unchanged.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Conversations and their members are few (one per friendship and one per thread), so validating the
-- new checks and building the index inside this transaction blocks nothing real; squawk's ignore
-- comments below say so where it would otherwise ask for two transactions.
alter table social.conversations add column kind text not null default 'direct';
-- Only direct conversations belong to a friendship; a thread's lineage is its own id.
alter table social.conversations
  add constraint conversations_kind_check check (kind in ('direct', 'thread')) not valid,
  add constraint conversations_thread_without_pair check (kind = 'direct' or pair_id is null) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table social.conversations validate constraint conversations_kind_check;
-- squawk-ignore constraint-missing-not-valid
alter table social.conversations validate constraint conversations_thread_without_pair;

-- pending: an invitation not accepted yet; the member reads nothing but the invitation until they join.
-- invited_lineage: the accepted lineage of the friendship between the inviter and this member.
alter table social.conversation_members
  add column pending boolean not null default false,
  add column invited_by_account_id uuid,
  add column invited_lineage uuid;
alter table social.conversation_members
  add constraint conversation_members_inviter_fkey foreign key (invited_by_account_id)
    references identity.accounts(id) on delete restrict not valid,
  add constraint conversation_members_invitation_check
    check ((invited_by_account_id is null) = (invited_lineage is null)) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table social.conversation_members validate constraint conversation_members_inviter_fkey;
-- squawk-ignore constraint-missing-not-valid
alter table social.conversation_members validate constraint conversation_members_invitation_check;
-- squawk-ignore require-concurrent-index-creation
create index conversation_members_invited_by on social.conversation_members(invited_by_account_id)
  where invited_by_account_id is not null;

-- A thread's episode markers ask which of a few assets this universe opened and activated.
-- squawk-ignore require-concurrent-index-creation
create index exposures_activated_assets_idx on experience.exposures(universe_id, asset_id)
  where activated_at is not null;

create table social.content_threads (
  thread_id uuid primary key references social.conversations(conversation_id) on delete restrict,
  -- Null once the starter's account is deleted.
  starter_account_id uuid references identity.accounts(id) on delete restrict,
  root_asset_id uuid not null,
  root_asset_revision integer not null,
  name text check (char_length(name) between 1 and 80),
  created_at timestamptz not null,
  foreign key (root_asset_id, root_asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
create index content_threads_starter on social.content_threads(starter_account_id)
  where starter_account_id is not null;

-- The anchor of a snippet message. The message row carries the exact asset revision and the note.
-- A quote and block settings are copied from the exact, immutable revision when the snippet is
-- sent, so the card needs no document read; they are served only while the content is available.
create table social.message_snippets (
  message_id uuid primary key references social.messages(message_id) on delete restrict,
  kind text not null check (kind in ('reel_range', 'scroll_passage', 'scroll_block')),
  start_ms integer check (start_ms >= 0),
  end_ms integer,
  block_id text check (char_length(block_id) between 1 and 160),
  block_type text,
  block_version integer,
  block_label text check (char_length(block_label) between 1 and 240),
  range_start integer check (range_start >= 0),
  range_end integer,
  quote text check (char_length(quote) between 1 and 600),
  quote_hash text check (quote_hash ~ '^[0-9a-f]{64}$'),
  settings jsonb check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 1024),
  settings_description text check (char_length(settings_description) <= 400),
  check (
    (kind = 'reel_range' and start_ms is not null and end_ms > start_ms and block_id is null
      and block_type is null and block_version is null and range_start is null and range_end is null
      and quote is null and quote_hash is null and settings is null)
    or (kind = 'scroll_passage' and block_id is not null and range_start is not null and range_end > range_start
      and quote is not null and quote_hash is not null and start_ms is null and end_ms is null
      and block_type is null and block_version is null and settings is null)
    or (kind = 'scroll_block' and block_id is not null and block_type is not null and block_version is not null
      and start_ms is null and end_ms is null and range_start is null and range_end is null
      and quote is null and quote_hash is null)
  )
);
