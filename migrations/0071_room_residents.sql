-- #488 (v3 R-2) Residents who speak unprompted: a room scope for their model calls, a budget class for it, the
-- cast of named residents in each room, and the ledger that records every AI turn (D-162 to D-165).
--
-- Owners: reasoning (the `rooms` nonpersonal scope, the `ambient` receipt mark) and rooms (the cast, the turn
-- ledger, the typing hold). Authoritative, except `typing_holds`, a few seconds of "someone is typing here".
-- Query shapes: a room's cast in order; a room's turns since an hour or a UTC day ago, by trigger and state; the
-- turn made for one message; the newest turn that counts for the 1-in-3 ratio; a discussion's hold; today's
-- ambient receipts under the budget advisory lock.
-- Locking: unchanged from 0062. A turn is decided under the room root FOR UPDATE (the caps are counts), a
-- member's typing hint takes no room lock and writes one row of its own.
-- Access: members only. A turn row names a message, never a person; an unprompted turn has no asker.
-- Growth: one `ai_turns` row per asked turn and per unprompted decision (a refusal is a row too); a few per
-- room per day by the caps. `typing_holds` is one row per discussion, rewritten in place.
-- Retention: kept with the room, as `ai_requests` was. A deleted account clears the asker link; the turn stays.
-- Exploration Clear keeps turns and the cast (explicit communication, D-042). `typing_holds` carries no
-- account, no text and no history, is unlogged, and lapses by itself in seconds.
-- Rollout: `ai_requests` becomes `ai_turns` and its `request_id` becomes `turn_id`, so a process from before this
-- migration cannot ask or answer until it restarts. Every other change is additive. `rooms.rooms.inhabitants` is
-- no longer read: the cast is the truth, and the column is dropped by a later migration once no process reads it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The room reasoning scope is a second nonpersonal root beside Scroll supply. Its row exists enabled: the
-- worker's own switch (KS_REASONING_ROOM_ENABLED, default off) is what turns residents on, and an operator can
-- still disable this row or raise its generation to fence queued work. The table holds one row.
-- squawk-ignore ban-drop-constraint
alter table reasoning.production_scopes drop constraint production_scopes_id_check;
alter table reasoning.production_scopes
  add constraint production_scopes_id_check check (id in ('scroll-supply', 'rooms')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table reasoning.production_scopes validate constraint production_scopes_id_check;
insert into reasoning.production_scopes (id, enabled) values ('rooms', true);

-- Ambient spend (residents speaking on their own) is counted apart, like background spend: derived accounting,
-- written with the receipt and never changed. An older writer inserts receipts without it and they count as
-- interactive, which is the old behaviour.
alter table reasoning.usage_receipts add column ambient boolean not null default false;

-- The cast: the residents a room has, in the order they are shown. Names come from a fixed catalogue, never from a
-- model. A room has two to four rows (an Explainer and a Skeptic always; the position and role keys make four the
-- most, and the room seeds and the backfill below make two the least).
create table rooms.room_cast (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  inhabitant text not null check (inhabitant in ('explainer', 'skeptic')),
  name text not null check (char_length(name) between 1 and 24),
  position integer not null check (position between 1 and 4),
  primary key (room_id, inhabitant),
  unique (room_id, position)
);

insert into rooms.room_cast (room_id, inhabitant, name, position)
select room.room_id, resident.inhabitant,
  case resident.inhabitant when 'explainer' then 'Nova' else 'Halley' end,
  case resident.inhabitant when 'explainer' then 1 else 2 end
from rooms.rooms room
cross join lateral unnest(room.inhabitants) as resident(inhabitant);

-- The ledger of AI turns. `ai_requests` held one row per ask; it now holds one row per turn, asked or not, so an AI
-- message never exists without a row that names what set it going. `trigger` is that: `asked`, or the reason a
-- resident spoke on its own. `cause_message_id` is the message it answers (none for an ask). An unprompted turn
-- is decided by the router under the room lock: `allowed` (state `queued` until the worker posts it) or `refused`
-- (state `refused`, nothing posted), and `decided_by` names the cap that refused it, or `caps_clear`. `caps` is the
-- count of each cap at that moment, for the Operator view and for debugging. `held_kind` and `held_text` keep an answer the
-- model already gave (and was paid for) while posting is put off for someone who is typing: the redelivered job posts them
-- as they are, and never builds the context or calls the model again. They are cleared when the turn settles, whether the words
-- were posted or dropped.
-- squawk-ignore renaming-table
alter table rooms.ai_requests rename to ai_turns;
-- squawk-ignore renaming-column
alter table rooms.ai_turns rename column request_id to turn_id;

-- The ledger holds one row per ask so far, a handful at rollout; every constraint below is checked against them.
alter table rooms.ai_turns
  add column trigger text not null default 'asked'
    check (trigger in ('asked', 'unanswered_question', 'overstated_claim', 'answer_overstated')),
  add column decided_by text not null default 'asked_bounds'
    check (decided_by in ('asked_bounds', 'caps_clear', 'ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour')),
  add column caps jsonb not null default '{}' check (jsonb_typeof(caps) = 'object' and octet_length(caps::text) <= 512),
  add column held_kind text check (held_kind in ('explanation', 'assumption', 'perspective', 'counterexample')),
  add column held_text text check (char_length(held_text) between 1 and 2000);
-- squawk-ignore adding-foreign-key-constraint
alter table rooms.ai_turns add column cause_message_id uuid references rooms.messages(message_id) on delete restrict;
-- An unprompted turn has no command.
-- squawk-ignore ban-drop-not-null
alter table rooms.ai_turns alter column command_id drop not null;

-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_requests_state_check;
alter table rooms.ai_turns
  add constraint ai_turns_state_check check (state in ('queued', 'completed', 'declined', 'failed', 'refused')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_state_check;
-- A refused turn never reached the provider, and settles when it is decided.
-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_requests_check1;
alter table rooms.ai_turns
  add constraint ai_turns_dispatched_check check (dispatched or state in ('queued', 'failed', 'refused')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_dispatched_check;
alter table rooms.ai_turns
  add constraint ai_turns_decision_check check (
    ((trigger = 'asked') = (command_id is not null))
    and ((trigger = 'asked') = (cause_message_id is null))
    and (trigger <> 'asked' or decided_by = 'asked_bounds')
    and (trigger = 'asked' or decided_by <> 'asked_bounds')
    and ((state = 'refused') = (decided_by in ('ratio', 'room_hour', 'room_day', 'resident_hour', 'person_hour')))
    and (state <> 'refused' or not dispatched)
    and ((held_kind is null) = (held_text is null))
    and (held_text is null or (dispatched and attempt_id is not null))
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_decision_check;
-- Each message sets off at most one turn of each kind, however many times the job is delivered.
-- Existing ask inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index ai_turns_cause on rooms.ai_turns(cause_message_id, trigger) where cause_message_id is not null;

-- A message the residents wrote on their own carries why, so a reader's AI level can fold or hide it without a join.
alter table rooms.messages
  add column trigger text check (trigger in ('unanswered_question', 'overstated_claim', 'answer_overstated')),
  add constraint messages_trigger_ai_check check (trigger is null or author_kind = 'ai') not valid;
-- The new column is null for every existing row, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_trigger_ai_check;

-- "Someone is typing here": a member's device says so every few seconds while they type. The only use is to hold
-- back an AI turn (D-067, D-165). The row names a discussion and a time, no account and no text; it is rewritten in
-- place, never read by an API route, never sent to anyone, and unlogged, so a restart loses it and a backup never has it.
-- There is no foreign key: the write selects the discussion, so a hold exists only for one, and a row that outlived it
-- would name nothing and lapse in seconds.
create unlogged table rooms.typing_holds (
  discussion_id uuid primary key,
  held_until timestamptz not null
);

-- The Operator's view of AI calls per room: which turns were asked or unprompted, how each ended, and which cap
-- refused it. Ids, states, codes and times; never a message, a person or a prompt.
create view ops.room_turns as
select
  turn.turn_id,
  turn.room_id,
  turn.discussion_id,
  turn.trigger,
  turn.inhabitant,
  turn.state,
  turn.decided_by,
  turn.dispatched,
  turn.created_at
from rooms.ai_turns as turn;

comment on view ops.room_turns is
  'AI turns of rooms, asked or unprompted: ids, trigger, state, the cap that decided it and when. No message text, no person, no prompt.';
