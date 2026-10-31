-- #484 Social: where each member of a content thread is in its series (T3 "who is on which part", D-065).
--
-- Owner: social. Authoritative. A place is a fact the member's own client reports about themselves:
-- a part of the thread's series, `on` or `finished`, and the day it was set. Nothing is derived from
-- Experience and the server never reads another member's exploration to build it.
-- Coarse on purpose: there is no column for a playhead, a branch, a selected episode, a seen marker
-- or a time finer than a day. `day` is a date, so a finer time cannot be stored.
-- Query shapes: one thread's places by thread (the places read, under the thread's lock); one person's
-- places by account (Clear, erasure, export); a person's own place by the primary key (the command).
-- Hiding: `conversation_members.place_hidden` is the member's own "hide where I am" for that thread.
-- Places are shown by default (D-065), so the column is false until the person hides. Hiding deletes the
-- person's place in the same transaction, and while it is true no place is written.
-- Locking: written under the actor's personal root and own account gate, then the thread's conversation
-- row FOR UPDATE (as a send is). Read under the same row FOR SHARE.
-- Receipts: none. Place set (a place only moves forward) and hide (a wanted state) are idempotent by their
-- state, so no command receipt is written for them. A receipt keeps the exact time of the command and
-- survives leave and Clear, which would keep a finer time than the day a place is allowed to hold.
-- Constraints: one row per member and thread (the primary key); the row follows the membership row
-- (the composite foreign key), so a place cannot outlive the member's row. Leaving, an ended friendship
-- and Clear delete it explicitly, because a leaver's membership row stays.
-- Growth: at most nine rows per thread (the thread's members). A change bumps each member's inbox revision (a
-- counter, 0056) and sends the usual disposable hint; neither keeps a time.
-- Retention: kept until the person leaves, hides, the friendship that carried them in ends, they Clear
-- their exploration history, or they delete the account. Clear keeps `place_hidden`: it is a choice, not
-- exploration history. The export lists the person's own places and where they hide.
-- Rollout: additive. Older writers never write the table or the column; the column defaults to false.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table social.conversation_members add column place_hidden boolean not null default false;

create table social.thread_places (
  thread_id uuid not null,
  account_id uuid not null,
  part integer not null check (part between 1 and 99),
  state text not null check (state in ('on', 'finished')),
  day date not null,
  primary key (thread_id, account_id),
  foreign key (thread_id, account_id)
    references social.conversation_members(conversation_id, account_id) on delete restrict
);
create index thread_places_account on social.thread_places(account_id);
