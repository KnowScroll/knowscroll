-- #495 (v3 R-9) Scouts (D-259 to D-261): a member sends one scout into a room. It posts at most one find a day about a library
-- asset the room has not seen, written in a short labelled note and signed "sent by" its owner. A scout is its own kind of
-- author (`agent`) with an owner; it is not a resident, it has no account, and it makes no evidence of any kind.
--
-- Owner: rooms. `scouts` is authoritative: the owner's explicit setting for one room (which of the room's topics to look in,
-- how often, whether it is paused) and a moderator's stop. A scout's post is an ordinary find (a discussion rooted at an asset,
-- migration 0091) whose first message has `author_kind = 'agent'` and names its owner; its model call is an `ai_turns` row of
-- trigger `scout_find`, so the room's existing ambient caps count it with every other unprompted turn.
-- Query shapes: a member's scout in one room; the active scouts to look at (open room, not paused, not stopped); an owner's
-- newest counted scout turn in a room (its rest) and the room's scout turns of the UTC day (the scouts' own cap); a room's
-- finds newest first (0091) with each note's owner.
-- Locking: a scout look takes the room root FOR UPDATE inside the nonpersonal `rooms` scope's transaction, as a resident's look
-- does (0091). A member's setting and a moderator's stop take the room root FOR SHARE like other member commands. No personal
-- root is taken by the heartbeat: nothing personal is read, and whether the owner's recording is paused is one unlocked read.
-- Access: members only. The setting is private to its owner and the room's moderators see only that a scout stands (never its
-- interests); a find names its owner's public profile, which is the point of "sent by".
-- Growth: one `scouts` row per member per room; at most one scout turn a day for each, and five a day for a room.
-- Retention: the setting stays while the owner is a member of the room and goes with their membership, their account and the
-- scout's removal. Exploration Clear keeps it (explicit communication, D-042; it holds no reading). A scout turn stays with the
-- room as the ledger of a call that was made; its owner link is cleared with the account. An owner's account deletion turns
-- the notes of their scout into tombstones, as it does their messages.
-- Rollout: the widened checks only admit new values, so an older process keeps working; it neither writes nor reads a scout, and
-- until it restarts it would list a find whose note is an `agent` message as having no note (it is left out of its feed).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table rooms.scouts (
  scout_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  owner_account_id uuid not null references identity.accounts(id) on delete restrict,
  -- The member's own choice among the room's topics (planet IDs of the catalogue), never read from anything they did. Code checks
  -- every element against the room's topics when it is set and again when a look is made.
  interests text[] not null check (cardinality(interests) between 1 and 5 and array_position(interests, null) is null),
  cadence text not null check (cadence in ('daily', 'weekly')),
  paused boolean not null default false,
  -- A moderator's stop: the scout stays on the list and posts nothing until a moderator lifts it. The moderator's link is
  -- cleared when their account goes; the stop stands.
  stopped_at timestamptz,
  stopped_by_account_id uuid references identity.accounts(id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (room_id, owner_account_id),
  check (stopped_at is not null or stopped_by_account_id is null)
);
-- squawk-ignore require-concurrent-index-creation
create index scouts_owner on rooms.scouts(owner_account_id);
-- squawk-ignore require-concurrent-index-creation
create index scouts_stopper on rooms.scouts(stopped_by_account_id) where stopped_by_account_id is not null;
-- The heartbeat's list: scouts that may post.
-- squawk-ignore require-concurrent-index-creation
create index scouts_active on rooms.scouts(room_id) where not paused and stopped_at is null;

-- A scout's note is a message of its own author kind. It names its owner and nothing else about a person: no account of its own,
-- no command (a person did not send it), no resident.
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_author_kind_check;
alter table rooms.messages
  add constraint messages_author_kind_check check (author_kind in ('person', 'ai', 'agent')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_author_kind_check;
alter table rooms.messages add column agent_owner_account_id uuid;
-- The column is new and null for every existing row, so the constraint holds for all of them.
-- squawk-ignore adding-foreign-key-constraint
alter table rooms.messages
  add constraint messages_agent_owner_fkey foreign key (agent_owner_account_id)
    references identity.accounts(id) on delete restrict not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_agent_owner_fkey;
-- squawk-ignore require-concurrent-index-creation
create index messages_agent_owner on rooms.messages(agent_owner_account_id) where agent_owner_account_id is not null;

-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_shape_check;
alter table rooms.messages
  add constraint messages_shape_check check (
    (author_kind = 'person' and author_account_id is not null and command_id is not null
      and inhabitant is null and ai_kind is null and agent_owner_account_id is null
      and ((body_text is not null and asset_id is null and asset_revision is null and note is null and topic_discussion_id is null)
        or (body_text is null and asset_id is not null and asset_revision is not null and topic_discussion_id is null)
        or (body_text is null and asset_id is null and asset_revision is null and note is null and topic_discussion_id is not null)))
    or (author_kind = 'ai' and author_account_id is null and command_id is null and agent_owner_account_id is null
      and inhabitant is not null and ai_kind is not null
      and body_text is not null and asset_id is null and asset_revision is null and note is null and topic_discussion_id is null)
    or (author_kind = 'agent' and author_account_id is null and agent_owner_account_id is not null and command_id is null
      and inhabitant is null and ai_kind = 'find'
      and body_text is not null and asset_id is null and asset_revision is null and note is null and topic_discussion_id is null)
    or (author_kind = 'person' and author_account_id is null and command_id is null and agent_owner_account_id is null
      and inhabitant is null and ai_kind is null
      and body_text is null and asset_id is null and asset_revision is null and note is null and topic_discussion_id is null)
  ) not valid;
-- The column is new and null for every existing row, so the rewritten check holds for all of them.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_shape_check;

-- Why a message was posted on its own: a scout's find is one, and only a scout's note has this reason.
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_trigger_ai_check;
alter table rooms.messages
  add constraint messages_trigger_ai_check check (trigger is null or author_kind in ('ai', 'agent')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_trigger_ai_check;
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_trigger_check;
alter table rooms.messages
  add constraint messages_trigger_check
    check (trigger in ('unanswered_question', 'overstated_claim', 'answer_overstated', 'feed_find', 'scout_find')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_trigger_check;
alter table rooms.messages
  add constraint messages_agent_trigger_check check ((author_kind = 'agent') = coalesce(trigger = 'scout_find', false)) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_agent_trigger_check;

-- The ledger. A scout turn is an AI turn of the room: it has no resident (`inhabitant` is null), names its owner in the asker
-- link, names the asset it was made from and has no message it answers. It has no discussion until the find is posted. Its
-- refusals are quiet rows, as a resident's find turns are (0091); `scout_day` is the cap of what a room's scouts post in a day.
-- squawk-ignore ban-drop-not-null
alter table rooms.ai_turns alter column inhabitant drop not null;
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_trigger_check;
alter table rooms.ai_turns
  add constraint ai_turns_trigger_check check (
    trigger in ('asked', 'unanswered_question', 'overstated_claim', 'answer_overstated', 'feed_find', 'memory_refresh', 'scout_find')
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_trigger_check;
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_decided_by_check;
alter table rooms.ai_turns
  add constraint ai_turns_decided_by_check check (
    decided_by in ('asked_bounds', 'caps_clear', 'ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour', 'feed_day', 'scout_day')
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decided_by_check;
alter table rooms.ai_turns
  add constraint ai_turns_scout_check check ((trigger = 'scout_find') = (inhabitant is null)) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_scout_check;

-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_decision_check;
alter table rooms.ai_turns
  add constraint ai_turns_decision_check check (
    ((trigger = 'asked') = (command_id is not null))
    and ((trigger = 'asked') = (ask_kind is not null))
    and (trigger <> 'asked' or ((ask_kind = 'ask') = (cause_message_id is null)))
    -- A reply to a message names it; an ask, a find and a refresh do not need one.
    and (trigger in ('asked', 'feed_find', 'scout_find', 'memory_refresh') or cause_message_id is not null)
    and (trigger not in ('feed_find', 'scout_find', 'memory_refresh') or cause_message_id is null)
    and ((trigger in ('feed_find', 'scout_find')) = (find_asset_id is not null))
    -- A find has a discussion exactly when it was posted; a refresh never has one; every other turn always has one.
    and (trigger not in ('feed_find', 'scout_find') or ((state = 'completed') = (discussion_id is not null)))
    and (trigger <> 'memory_refresh' or discussion_id is null)
    and (trigger in ('feed_find', 'scout_find', 'memory_refresh') or discussion_id is not null)
    and (trigger <> 'asked' or decided_by = 'asked_bounds')
    and (trigger = 'asked' or decided_by <> 'asked_bounds')
    and (trigger not in ('feed_find', 'scout_find', 'memory_refresh')
      or decided_by in ('caps_clear', 'room_hour', 'room_day', 'feed_day', 'scout_day'))
    and ((state = 'refused') = (decided_by in ('ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour', 'feed_day', 'scout_day')))
    and (state <> 'refused' or not dispatched)
    and ((held_kind is null) = (held_text is null))
    and (held_text is null or (dispatched and attempt_id is not null))
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decision_check;

-- A room is shown an asset once, whoever found it: a scout's find holds the asset like a resident's does.
-- Replaced in the same transaction by an index that also holds a scout's finds; the table is a handful of rows at rollout.
-- squawk-ignore require-concurrent-index-deletion
drop index rooms.ai_turns_find_asset;
-- Existing turn inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index ai_turns_find_asset on rooms.ai_turns(room_id, find_asset_id)
  where trigger in ('feed_find', 'scout_find') and state <> 'refused' and (state <> 'failed' or dispatched);
-- An owner's newest scout turns in a room: its rest between posts.
-- squawk-ignore require-concurrent-index-creation
create index ai_turns_scout_finds on rooms.ai_turns(room_id, requested_by_account_id, created_at desc) where trigger = 'scout_find';
