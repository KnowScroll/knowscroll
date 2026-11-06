-- Asked residents may post a code-authored social reply, distinct from a grounded explanation.
-- No new queue, ledger or data retention. Old clients must reload to recognise the additive kind.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- squawk-ignore ban-drop-constraint
alter table rooms.messages drop constraint messages_ai_kind_check;
alter table rooms.messages add constraint messages_ai_kind_check
  check (ai_kind in ('explanation', 'assumption', 'perspective', 'counterexample', 'find', 'conversation')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.messages validate constraint messages_ai_kind_check;
