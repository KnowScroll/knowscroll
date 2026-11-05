-- Rooms owns this bounded, human-triggered opportunity (D-396, #668). No new queue or ledger.
-- The existing cause/trigger unique index deduplicates delivery; the room lock serialises cooldown checks.
-- Additive trigger values only. No columns or stored messages are changed. Roll back by disabling residents.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- squawk-ignore ban-drop-constraint
alter table rooms.ai_turns drop constraint ai_turns_trigger_check;
alter table rooms.ai_turns add constraint ai_turns_trigger_check check (
  trigger in ('asked', 'unanswered_question', 'overstated_claim', 'answer_overstated',
    'feed_find', 'memory_refresh', 'scout_find', 'conversation_starter')
) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.ai_turns validate constraint ai_turns_trigger_check;

-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_trigger_check;
alter table rooms.messages add constraint messages_trigger_check check (
  trigger in ('unanswered_question', 'overstated_claim', 'answer_overstated',
    'feed_find', 'scout_find', 'conversation_starter')
) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_trigger_check;
