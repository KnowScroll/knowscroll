-- #245 Rooms own idea rooms: a room bound to a library topic, its members and their roles, the
-- discussions held in it (optionally about one exact Reel or Scroll), the messages of those
-- discussions, moderation (pin, hide, pause, remove) and the labelled AI inhabitants' requests and
-- contributions (D-051).
--
-- Owner: rooms. Everything here is authoritative; nothing is derived.
-- Query shapes: a person's open memberships; one room's discussions (pinned first, then newest
-- activity); a discussion's messages by (discussion, sequence) for history and by (discussion,
-- change sequence) for catch-up; the AI requests of a room in a UTC day (rate bound) and the open
-- request of a discussion; one snippet by its message.
-- Locking: a room is its own shared root (kind rooms_room, the rooms.rooms row), taken after the actor's
-- personal root and own account gate: FOR UPDATE for commands that change membership, status or
-- roles, FOR SHARE for everything else. A discussion's counters are atomic SQL increments on the
-- discussion row, so sends within one discussion stay gapless and account deletion can tombstone
-- messages without the room lock.
-- Access: a person acts in a room while their member row is open (ended_at is null) and their
-- account is active. Invitations and the join rule decide who may become a member; nothing else
-- grants access, and no row records what a member has read or watched.
-- Growth: rooms are created by the operator (a handful); members, discussions and messages grow
-- with use. A message is at most 2000 characters; an AI request is one row per ask.
-- Retention: kept until the author deletes their account. Exploration Clear keeps all of it (explicit
-- communication, D-042). Deleting an account removes its membership and invitations, tombstones its
-- messages in place (author, body, card and note removed, change sequence advanced), deletes their
-- snippet rows, clears the starter link of discussions it began and the asker of AI requests; the
-- room goes on for the others with "Deleted account" in its place (D-043).
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema rooms;

-- A room belongs to a topic (a library system or planet), not to anyone's map coordinates. The
-- join rule is who may become a member; the status is what the room allows right now.
-- inhabitants lists the labelled AI inhabitants this room has; they speak only when a member asks.
create table rooms.rooms (
  room_id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{2,60}$'),
  name text not null check (char_length(name) between 1 and 80),
  description text not null check (char_length(description) between 1 and 400),
  guidelines text check (char_length(guidelines) between 1 and 600),
  topic_kind text not null check (topic_kind in ('system', 'planet')),
  topic_id text not null check (char_length(topic_id) between 1 and 160),
  join_rule text not null check (join_rule in ('open', 'friends_of_members', 'invite_only')),
  status text not null default 'open' check (status in ('open', 'paused', 'closed')),
  inhabitants text[] not null default '{explainer,skeptic}' check (inhabitants <@ array['explainer', 'skeptic']),
  created_at timestamptz not null
);
create index rooms_topic on rooms.rooms(topic_kind, topic_id);

-- One row per person per room. Leaving or being removed sets ended_at; joining again (when the room
-- allows it) clears it. A removed person cannot join again until a moderator lets them.
create table rooms.members (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  role text not null default 'member' check (role in ('member', 'moderator')),
  joined_at timestamptz not null,
  ended_at timestamptz,
  ended_by text check (ended_by in ('left', 'removed')),
  primary key (room_id, account_id),
  check ((ended_at is null) = (ended_by is null))
);
create index members_open_by_account on rooms.members(account_id) where ended_at is null;
create index members_open_by_room on rooms.members(room_id) where ended_at is null;

-- A member invites a friend into a room that is invite-only. It lasts while the inviter is a member.
create table rooms.invitations (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  invitee_account_id uuid not null references identity.accounts(id) on delete restrict,
  inviter_account_id uuid not null references identity.accounts(id) on delete restrict,
  created_at timestamptz not null,
  primary key (room_id, invitee_account_id)
);
create index invitations_inviter on rooms.invitations(inviter_account_id);
create index invitations_invitee on rooms.invitations(invitee_account_id);

-- A discussion is a room thread. With a root (an exact asset revision) it is a content thread: the
-- Reel or Scroll and the talk about it. origin_message_id names the message it was started from.
-- The id is generated when the discussion is created; the receipt of the create command makes a retry find it.
create table rooms.discussions (
  discussion_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  title text not null check (char_length(title) between 1 and 80),
  root_asset_id uuid,
  root_asset_revision integer,
  origin_message_id uuid,
  -- Null once the starter's account is deleted.
  started_by_account_id uuid references identity.accounts(id) on delete restrict,
  pinned_at timestamptz,
  last_sequence bigint not null default 0 check (last_sequence between 0 and 9007199254740991),
  last_change_sequence bigint not null default 0 check (last_change_sequence between 0 and 9007199254740991),
  last_activity_at timestamptz not null,
  created_at timestamptz not null,
  foreign key (root_asset_id, root_asset_revision)
    references content.asset_revisions(asset_id, revision) on delete restrict,
  check ((root_asset_id is null) = (root_asset_revision is null)),
  check (last_change_sequence >= last_sequence)
);
create index discussions_room_order on rooms.discussions(room_id, pinned_at desc nulls last, last_activity_at desc, discussion_id);
create index discussions_starter on rooms.discussions(started_by_account_id) where started_by_account_id is not null;

-- A message is a person's text, a card for an exact content revision (optionally a snippet: an
-- anchor into the discussion's own content), an AI inhabitant's contribution, or a tombstone (a
-- deleted account's message: no author, no body). hidden_at is a moderator's removal: the message
-- keeps its place and number but is never served. command_id lets the author find an unknown send.
create table rooms.messages (
  discussion_id uuid not null references rooms.discussions(discussion_id) on delete restrict,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  message_id uuid not null unique,
  change_sequence bigint not null check (change_sequence between 1 and 9007199254740991 and change_sequence >= sequence),
  command_id uuid,
  author_kind text not null check (author_kind in ('person', 'ai')),
  author_account_id uuid references identity.accounts(id) on delete restrict,
  inhabitant text check (inhabitant in ('explainer', 'skeptic')),
  ai_kind text check (ai_kind in ('explanation', 'assumption', 'perspective', 'counterexample')),
  recorded_at timestamptz not null,
  body_text text check (char_length(body_text) between 1 and 2000),
  asset_id uuid,
  asset_revision integer,
  note text check (char_length(note) between 1 and 2000),
  hidden_at timestamptz,
  primary key (discussion_id, sequence),
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict,
  check (
    (author_kind = 'person' and author_account_id is not null and command_id is not null
      and inhabitant is null and ai_kind is null
      and ((body_text is not null and asset_id is null and asset_revision is null and note is null)
        or (body_text is null and asset_id is not null and asset_revision is not null)))
    or (author_kind = 'ai' and author_account_id is null and command_id is null
      and inhabitant is not null and ai_kind is not null
      and body_text is not null and asset_id is null and asset_revision is null and note is null)
    or (author_kind = 'person' and author_account_id is null and command_id is null
      and inhabitant is null and ai_kind is null
      and body_text is null and asset_id is null and asset_revision is null and note is null)
  )
);
create unique index messages_command on rooms.messages(discussion_id, author_account_id, command_id) where command_id is not null;
create index messages_changes on rooms.messages(discussion_id, change_sequence);
create index messages_author on rooms.messages(author_account_id) where author_account_id is not null;
alter table rooms.discussions
  add constraint discussions_origin_fkey foreign key (origin_message_id) references rooms.messages(message_id) on delete restrict;

-- The anchor of a snippet message, as in social.message_snippets: the message row carries the exact
-- revision and note; a quote or block settings are copied from the immutable revision at send.
create table rooms.message_snippets (
  message_id uuid primary key references rooms.messages(message_id) on delete restrict,
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

-- One row per ask of an AI inhabitant: who asked, in which discussion, and what became of it. The
-- request is the rate-bound ledger (per room and day, per person and day) and, once an answer is
-- stored, the provenance of the contribution: the role and prompt versions, the model and the
-- reasoning attempt it came from. An AI inhabitant never speaks without a row here.
-- dispatched says the ask reached the provider (an attempt was made, whatever came back). The daily bounds
-- count every ask that is queued, answered, declined or dispatched, so an ask is refunded only when it
-- never reached the provider: leaving, a pause or a Clear after the call does not give it back. Every ask in
-- any state is also counted in a separate, larger bound, so asks that fail at once cannot pile up.
create table rooms.ai_requests (
  request_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  discussion_id uuid not null references rooms.discussions(discussion_id) on delete restrict,
  inhabitant text not null check (inhabitant in ('explainer', 'skeptic')),
  -- Null once the asker's account is deleted; the contribution stays with the room.
  requested_by_account_id uuid references identity.accounts(id) on delete restrict,
  command_id uuid not null,
  state text not null check (state in ('queued', 'completed', 'declined', 'failed')),
  created_at timestamptz not null,
  settled_at timestamptz,
  message_id uuid unique references rooms.messages(message_id) on delete restrict,
  role_version text,
  prompt_version text,
  model text,
  attempt_id uuid,
  dispatched boolean not null default false,
  check ((state = 'completed') = (message_id is not null)),
  check (dispatched or state in ('queued', 'failed')),
  check ((state = 'queued') = (settled_at is null)),
  check (state <> 'completed' or (role_version is not null and prompt_version is not null and model is not null))
);
-- A command ID is a person's per room (shared receipts are per room), so the same ID in another room is another ask.
create unique index ai_requests_command on rooms.ai_requests(room_id, requested_by_account_id, command_id)
  where requested_by_account_id is not null;
create index ai_requests_room_day on rooms.ai_requests(room_id, created_at);
create index ai_requests_asker_day on rooms.ai_requests(requested_by_account_id, created_at)
  where requested_by_account_id is not null;
create index ai_requests_open on rooms.ai_requests(discussion_id) where state = 'queued';
