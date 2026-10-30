-- #482 Social owns replies and reactions on the messages of direct conversations and content threads
-- (T3 Talk: swipe to reply with a quote that jumps, five reactions).
--
-- Owner: social. Everything here is authoritative; nothing is derived.
-- Query shapes: a page of messages reads each message's reply target by (conversation, sequence) and
-- its reactions by (conversation, sequence in a page); a person's own reactions are read by account
-- (export, erasure); the changes feed re-sends a message whose reactions moved because its
-- change_sequence is advanced from the conversation's counter, as a tombstone's is (0056).
-- Locking: a reaction or a reply is written under the same root as a send (the friendship's pair
-- row for a direct conversation, the thread's conversation row for a thread), after the actor's
-- personal root and account gates. Counters stay atomic SQL increments.
-- Constraints: a reply names an earlier message of the same conversation (a composite foreign key,
-- so a reply cannot point into another conversation). A reaction is one of five kinds and there is
-- at most one per person, kind and message (the primary key), which is what makes add and remove
-- idempotent.
-- Growth: at most five kinds for each member of a conversation (nine in a thread) per message.
-- Retention: kept until the reacting account is deleted, or the message it sits on is tombstoned.
-- Clear keeps all of it (conversations are explicit communication, D-042).
-- Erasure: deleting an account removes its reactions (and those on its messages), advances the
-- change number of every other message that lost one so catch-up replaces it, and clears the reply
-- pointer of its tombstoned messages.
-- Rollout: additive. The new column is nullable, so 0056 and 0058 writers keep working.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table social.messages add column reply_to_sequence bigint;
-- Messages are few and the new constraints only touch the new column, so validating them inside
-- this transaction blocks nothing real (the squawk-ignore comments say so, as in 0058).
alter table social.messages
  add constraint messages_reply_target foreign key (conversation_id, reply_to_sequence)
    references social.messages(conversation_id, sequence) on delete restrict not valid,
  add constraint messages_reply_before check (reply_to_sequence is null or reply_to_sequence < sequence) not valid,
  add constraint messages_reply_has_author check (reply_to_sequence is null or author_account_id is not null) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table social.messages validate constraint messages_reply_target;
-- squawk-ignore constraint-missing-not-valid
alter table social.messages validate constraint messages_reply_before;
-- squawk-ignore constraint-missing-not-valid
alter table social.messages validate constraint messages_reply_has_author;

create table social.message_reactions (
  conversation_id uuid not null,
  message_sequence bigint not null check (message_sequence between 1 and 9007199254740991),
  account_id uuid not null references identity.accounts(id) on delete restrict,
  kind text not null check (kind in ('spark', 'mind_blown', 'ha', 'heart', 'question')),
  reacted_at timestamptz not null,
  primary key (conversation_id, message_sequence, account_id, kind),
  foreign key (conversation_id, message_sequence)
    references social.messages(conversation_id, sequence) on delete restrict
);
create index message_reactions_account on social.message_reactions(account_id);
