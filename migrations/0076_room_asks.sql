-- #489 (v3 R-3) Asks, challenges, topics and "while you were away" (D-167 to D-169): what a member asked a resident
-- and about which message, topics that begin from a message and carry a tag, the one mark of Useful, where a member
-- left off, and the cached summary a resident writes for a window of returns.
--
-- Owner: rooms. Authoritative, except `summaries`, which is derived text with its own ledger columns.
-- Query shapes: the asked turn of a message (the AI message it produced, who asked and about what); a room's topics with
-- their reply, Useful and answered figures; the marks on one message and the marks of one person; one member's
-- last visit in a room; the summary of a room's window (one per room and window, unique).
-- Locking: unchanged from 0062. An ask or a mention is decided under the room root FOR UPDATE (the bounds are counts);
-- a Useful mark, a presence beat and a topic start take it FOR SHARE. A summary is claimed by the unique key
-- (room, window), so two members returning together queue one call.
-- Access: members only. A mark names the message and the member who made it, and is never sent to the message's author;
-- a position names the member, and is read only by that member; a summary is shown to current members of its room.
-- Growth: one `message_useful` row per mark; one `read_positions` row per member per room (rewritten at a presence
-- beat, never appended); at most two `summaries` rows per room per day (one per 12-hour UTC window).
-- Retention: kept with the room. Exploration Clear keeps all of it (explicit communication, D-042). A deleted account
-- deletes its marks, the marks on its tombstoned messages and its positions, rewrites a topic title made from its words,
-- and marks every summary that covered its words stale (the text is erased). A member's position is also deleted when they leave or are removed.
-- Rollout: additive, but the `ai_turns` check now requires `ask_kind` on every asked turn, so a process from before this
-- migration cannot ask until it restarts (as at 0071). Every other change is additive. Apply with the new binary.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A topic carries one tag from a closed list. A topic started from a message begins with that message (`origin_message_id`
-- already exists) and leaves a card in the discussion the message was in, so the card needs its own message shape.
-- `title_derived` says the title is the first words of that message, not what the starter typed: it is then shown only
-- while the message is shown to the reader, and is rewritten when the message's author deletes their account (D-168).
alter table rooms.discussions
  add column tag text check (tag in ('question', 'debate', 'explainer', 'share')),
  add column title_derived boolean not null default false,
  add constraint discussions_tag_topic_check check (tag is null or kind = 'topic') not valid,
  add constraint discussions_title_derived_check check (not title_derived or origin_message_id is not null) not valid;
-- The new columns are null or false for every existing row, so both checks hold.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_tag_topic_check;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_title_derived_check;

-- A topic card: a person's message that names the discussion they started from a message. It has no words of its own;
-- the title and tag are the discussion's, read when the card is served, so the card keeps updating.
alter table rooms.messages add column topic_discussion_id uuid;
alter table rooms.messages
  add constraint messages_topic_discussion_fkey foreign key (topic_discussion_id)
    references rooms.discussions(discussion_id) on delete restrict not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_topic_discussion_fkey;

-- A discussion's reply count is its message counter less the removed messages and the cards, so a room read takes it from
-- the counter and these two small partial indexes instead of counting every message of General each time.
-- The transactional migrator cannot run CONCURRENTLY; rooms are new and these indexes are tiny.
-- squawk-ignore require-concurrent-index-creation
create index messages_removed on rooms.messages(discussion_id) where hidden_at is not null;
-- squawk-ignore require-concurrent-index-creation
create index messages_topic_cards on rooms.messages(discussion_id) where topic_discussion_id is not null;

-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_check1;
alter table rooms.messages
  add constraint messages_shape_check check (
    (author_kind = 'person' and author_account_id is not null and command_id is not null
      and inhabitant is null and ai_kind is null
      and ((body_text is not null and asset_id is null and asset_revision is null and note is null
          and topic_discussion_id is null)
        or (body_text is null and asset_id is not null and asset_revision is not null and topic_discussion_id is null)
        or (body_text is null and asset_id is null and asset_revision is null and note is null
          and topic_discussion_id is not null)))
    or (author_kind = 'ai' and author_account_id is null and command_id is null
      and inhabitant is not null and ai_kind is not null
      and body_text is not null and asset_id is null and asset_revision is null and note is null
      and topic_discussion_id is null)
    or (author_kind = 'person' and author_account_id is null and command_id is null
      and inhabitant is null and ai_kind is null
      and body_text is null and asset_id is null and asset_revision is null and note is null
      and topic_discussion_id is null)
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_shape_check;

-- What a member asked. `ask` is the plain ask of a discussion; `challenge`, `other_side` and `about` point at one message
-- (`cause_message_id`); `mention` is an @Nova or @Halley in a message, which is the cause. A turn that a resident took on
-- its own has none. The ask is the turn's reason, the way `trigger` is for an unprompted turn, so each ledger row names
-- what set it going and about which message.
alter table rooms.ai_turns
  add column ask_kind text check (ask_kind in ('ask', 'challenge', 'other_side', 'about', 'mention'));
update rooms.ai_turns set ask_kind = 'ask' where trigger = 'asked';

-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_decision_check;
alter table rooms.ai_turns
  add constraint ai_turns_decision_check check (
    ((trigger = 'asked') = (command_id is not null))
    and ((trigger = 'asked') = (ask_kind is not null))
    and (trigger <> 'asked' or ((ask_kind = 'ask') = (cause_message_id is null)))
    and (trigger = 'asked' or cause_message_id is not null)
    and (trigger <> 'asked' or decided_by = 'asked_bounds')
    and (trigger = 'asked' or decided_by <> 'asked_bounds')
    and ((state = 'refused') = (decided_by in ('ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour')))
    and (state <> 'refused' or not dispatched)
    and ((held_kind is null) = (held_text is null))
    and (held_text is null or (dispatched and attempt_id is not null))
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decision_check;

-- Several members may challenge the same message, so the one-turn-per-message rule holds for unprompted turns only; a
-- message that mentions a resident asks once.
-- squawk-ignore require-concurrent-index-deletion
drop index rooms.ai_turns_cause;
-- Existing turn inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index ai_turns_cause on rooms.ai_turns(cause_message_id, trigger)
  where cause_message_id is not null and trigger <> 'asked';
-- squawk-ignore require-concurrent-index-creation
create unique index ai_turns_mention on rooms.ai_turns(cause_message_id) where ask_kind = 'mention';

create or replace view ops.room_turns as
select
  turn.turn_id,
  turn.room_id,
  turn.discussion_id,
  turn.trigger,
  turn.inhabitant,
  turn.state,
  turn.decided_by,
  turn.dispatched,
  turn.created_at,
  turn.ask_kind
from rooms.ai_turns as turn;

-- One mark of Useful per member per message: no count of a person's marks is kept, there is no negative mark, and a
-- member's own message cannot be marked by them (the use case refuses it).
create table rooms.message_useful (
  message_id uuid not null references rooms.messages(message_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  marked_at timestamptz not null,
  primary key (message_id, account_id)
);
create index message_useful_account on rooms.message_useful(account_id);

-- Where a member left off: the last time their own device said the room was open. Private to the member. `away_since` and
-- `away_window` are set when they come back after a long absence to a room with enough new messages, and name the summary
-- written for that window; the member's "Got it" clears them.
create table rooms.read_positions (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  here_until timestamptz not null,
  away_since timestamptz,
  away_window bigint,
  primary key (room_id, account_id),
  check ((away_since is null) = (away_window is null))
);
create index read_positions_account on rooms.read_positions(account_id);

-- The "while you were away" a resident writes once for a 12-hour UTC window of a room. The unique key is the cap: a window
-- has one row however many members come back. A summary is a model call, so it has the provenance columns of a turn. It is
-- `stale` (its words erased, or never stored if it was still being written) when a message it covered is removed, a member
-- who wrote in it keeps their messages out or deletes their account; it is not written again in that window.
create table rooms.summaries (
  summary_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  window_no bigint not null check (window_no >= 0),
  resident text not null check (resident = 'skeptic'),
  trigger text not null default 'member_returned' check (trigger = 'member_returned'),
  decided_by text not null default 'window_open' check (decided_by = 'window_open'),
  state text not null check (state in ('queued', 'ready', 'declined', 'failed', 'stale')),
  covers_from timestamptz not null,
  covers_through timestamptz not null,
  body text check (char_length(body) between 1 and 1200),
  created_at timestamptz not null,
  settled_at timestamptz,
  role_version text,
  prompt_version text,
  model text,
  attempt_id uuid,
  dispatched boolean not null default false,
  unique (room_id, window_no),
  check (covers_through >= covers_from),
  check ((state = 'ready') = (body is not null)),
  check ((state = 'queued') = (settled_at is null)),
  check (dispatched or state in ('queued', 'failed', 'stale')),
  check (state not in ('ready', 'declined') or (role_version is not null and model is not null))
);

comment on view ops.room_turns is
  'AI turns of rooms, asked or unprompted: ids, trigger, the kind of ask, state, the cap that decided it and when. No message text, no person, no prompt.';
