-- #494 (v3 R-8) Residents' feed and the room's memory (D-247 to D-249): a find is a discussion a resident starts about one
-- library asset, its note is the resident's first message, and the room keeps a short text of what its members have discussed.
--
-- Owner: rooms. Authoritative for finds (a discussion and a message are ordinary rows); `room_memory` is derived text that
-- is erased when what it read is removed (a moderator may replace it); `memory_edits` is the audit of those replacements.
-- Query shapes: a room's finds newest first (kind `find`); the newest find turn of a resident in a room (its 6-hour rest);
-- whether the room has a find or a find turn for an asset (the room has seen it); a room's turns of the last hour and the
-- UTC day (the caps, which now also count finds and memory refreshes); a room's memory by room; a room's edits newest first.
-- Locking: a feed pass takes the room root FOR UPDATE inside the nonpersonal `rooms` scope's transaction, with no personal
-- root (nothing personal is read or written, and no person is its actor). Everything else is unchanged from 0062.
-- Access: members only. A find names a resident and a library asset, never a person. The memory is read by current members;
-- its text carries no name, and what a member keeps out of what AI reads is never in it.
-- Growth: a find per asset per room, at most three finds and a few memory refreshes per room per UTC day by the caps; one
-- `room_memory` row per room, rewritten in place and never appended; one `memory_edits` row per moderator replacement.
-- Retention: kept with the room. Exploration Clear keeps all of it (explicit communication, D-042; derived from messages
-- Clear does not touch). Account deletion clears the moderator link of the memory and of its edits; the words of a memory
-- that read the person's messages are erased (`stale`).
-- Rollout: the widened checks only admit new values, so an older process keeps working; it neither writes nor reads the new
-- turn kinds, and it would list a find among the room's discussions until it restarts (a find has no starter and a root).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A find is a discussion (`kind = 'find'`) rooted at the library asset it is about. It has no starter, because a resident
-- is not an account, and one room never has two finds about the same asset (no repeat dressed as new).
-- squawk-ignore ban-drop-constraint
alter table rooms.discussions drop constraint discussions_kind_check;
alter table rooms.discussions
  add constraint discussions_kind_check check (kind in ('general', 'topic', 'today', 'find')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_kind_check;
alter table rooms.discussions
  add constraint discussions_find_check check (
    kind <> 'find' or (root_asset_id is not null and started_by_account_id is null and tag is null and not title_derived)
  ) not valid;
-- No existing discussion is a find, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_find_check;
-- Existing room inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index discussions_one_find_per_asset on rooms.discussions(room_id, root_asset_id) where kind = 'find';
-- A room's finds newest first.
-- squawk-ignore require-concurrent-index-creation
create index discussions_finds on rooms.discussions(room_id, created_at desc, discussion_id) where kind = 'find';

-- A resident's find note is an AI message of its own kind, and carries why it spoke like every unprompted message, so a
-- reader's AI level folds or hides it without a join.
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_ai_kind_check;
alter table rooms.messages
  add constraint messages_ai_kind_check
    check (ai_kind in ('explanation', 'assumption', 'perspective', 'counterexample', 'find')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_ai_kind_check;
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_trigger_check;
alter table rooms.messages
  add constraint messages_trigger_check
    check (trigger in ('unanswered_question', 'overstated_claim', 'answer_overstated', 'feed_find')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_trigger_check;

-- The ledger: a find and a refresh of the room's memory are AI turns like any other, each with a row that names its trigger
-- and the cap that decided it. A find names the asset it was made from (`find_asset_id`, a real revision) and has no message
-- it answers; it has no discussion until it is posted (`discussion_id` is then the find's own). A memory refresh has no
-- discussion and no message: its words go to `room_memory`. A refusal is a quiet row, as for the router's turns.
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_trigger_check;
alter table rooms.ai_turns
  add constraint ai_turns_trigger_check check (
    trigger in ('asked', 'unanswered_question', 'overstated_claim', 'answer_overstated', 'feed_find', 'memory_refresh')
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_trigger_check;
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_decided_by_check;
alter table rooms.ai_turns
  add constraint ai_turns_decided_by_check check (
    decided_by in ('asked_bounds', 'caps_clear', 'ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour', 'feed_day')
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decided_by_check;

-- squawk-ignore ban-drop-not-null
alter table rooms.ai_turns alter column discussion_id drop not null;
alter table rooms.ai_turns add column find_asset_id uuid, add column find_asset_revision integer;
-- The columns are new and null for every existing row, so the constraint holds for all of them.
-- squawk-ignore adding-foreign-key-constraint
alter table rooms.ai_turns
  add constraint ai_turns_find_asset_fkey foreign key (find_asset_id, find_asset_revision)
    references content.asset_revisions(asset_id, revision) on delete restrict not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_find_asset_fkey;
alter table rooms.ai_turns
  add constraint ai_turns_find_check check ((find_asset_id is null) = (find_asset_revision is null)) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_find_check;

-- A completed turn has a message, except a memory refresh, whose words are the room's memory.
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_requests_check;
alter table rooms.ai_turns
  add constraint ai_turns_message_check check (
    (trigger = 'memory_refresh' and message_id is null) or ((state = 'completed') = (message_id is not null))
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_message_check;

-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_decision_check;
alter table rooms.ai_turns
  add constraint ai_turns_decision_check check (
    ((trigger = 'asked') = (command_id is not null))
    and ((trigger = 'asked') = (ask_kind is not null))
    and (trigger <> 'asked' or ((ask_kind = 'ask') = (cause_message_id is null)))
    -- A reply to a message names it; an ask, a find and a refresh do not need one.
    and (trigger in ('asked', 'feed_find', 'memory_refresh') or cause_message_id is not null)
    and (trigger not in ('feed_find', 'memory_refresh') or cause_message_id is null)
    and ((trigger = 'feed_find') = (find_asset_id is not null))
    -- A find has a discussion exactly when it was posted; a refresh never has one; every other turn always has one.
    and (trigger <> 'feed_find' or ((state = 'completed') = (discussion_id is not null)))
    and (trigger <> 'memory_refresh' or discussion_id is null)
    and (trigger in ('feed_find', 'memory_refresh') or discussion_id is not null)
    and (trigger <> 'asked' or decided_by = 'asked_bounds')
    and (trigger = 'asked' or decided_by <> 'asked_bounds')
    and (trigger not in ('feed_find', 'memory_refresh') or decided_by in ('caps_clear', 'room_hour', 'room_day', 'feed_day'))
    and ((state = 'refused') = (decided_by in ('ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour', 'feed_day')))
    and (state <> 'refused' or not dispatched)
    and ((held_kind is null) = (held_text is null))
    and (held_text is null or (dispatched and attempt_id is not null))
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decision_check;

-- A room is shown an asset once: a find whose call was made or is being made holds it, however it ended. A refusal and a turn
-- that never reached the provider hold nothing, so the asset is offered again at the next check.
-- Existing turn inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index ai_turns_find_asset on rooms.ai_turns(room_id, find_asset_id)
  where trigger = 'feed_find' and state <> 'refused' and (state <> 'failed' or dispatched);
-- The newest find turn of each resident in a room: its rest between posts.
-- squawk-ignore require-concurrent-index-creation
create index ai_turns_resident_finds on rooms.ai_turns(room_id, inhabitant, created_at desc) where trigger = 'feed_find';

-- What the room remembers: one bounded text per room, derived from the newest retained messages of its members, or written
-- by a moderator. `stale` means the words were erased because something they read was removed, kept out or deleted; the
-- next refresh writes them again from what is left. `covers_from` and `covers_through` bound the messages a derived text
-- read, so a removal inside them is what makes it stale. `turn_id` is the AI turn that wrote it. A moderator's text reads no
-- message, so no removal makes it stale; only a moderator ends it.
create table rooms.room_memory (
  room_id uuid primary key references rooms.rooms(room_id) on delete restrict,
  state text not null check (state in ('ready', 'stale')),
  source text not null check (source in ('derived', 'moderator')),
  body text check (char_length(body) between 1 and 600),
  covers_from timestamptz,
  covers_through timestamptz,
  messages_read integer not null default 0 check (messages_read between 0 and 200),
  turn_id uuid references rooms.ai_turns(turn_id) on delete restrict,
  -- Null once the moderator's account is deleted.
  edited_by_account_id uuid references identity.accounts(id) on delete restrict,
  edited_at timestamptz,
  updated_at timestamptz not null,
  check ((state = 'ready') = (body is not null)),
  check ((source = 'moderator') = (edited_at is not null)),
  check (source = 'derived' or state = 'ready'),
  check ((covers_from is null) = (covers_through is null) and (source = 'moderator' or state = 'stale' or covers_through is not null))
);
-- The account link of a deleted moderator is cleared by deletion; the memory itself stays with the room.
-- squawk-ignore require-concurrent-index-creation
create index room_memory_editor on rooms.room_memory(edited_by_account_id) where edited_by_account_id is not null;

-- The audit of a moderator's replacement or clearing of the memory: who, what and when, and the SHA-256 of the words they
-- wrote. The words themselves are in `room_memory` while they stand; an earlier text is not kept.
create table rooms.memory_edits (
  edit_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  -- Null once the moderator's account is deleted; the edit stays as a fact about the room.
  by_account_id uuid references identity.accounts(id) on delete restrict,
  action text not null check (action in ('replace', 'clear')),
  body_sha256 text check (body_sha256 ~ '^[0-9a-f]{64}$'),
  at timestamptz not null,
  check ((action = 'replace') = (body_sha256 is not null))
);
-- squawk-ignore require-concurrent-index-creation
create index memory_edits_room on rooms.memory_edits(room_id, at desc);
-- squawk-ignore require-concurrent-index-creation
create index memory_edits_editor on rooms.memory_edits(by_account_id) where by_account_id is not null;
