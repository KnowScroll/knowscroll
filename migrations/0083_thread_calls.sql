-- #485 Social: what each member of a content thread locked on the call of a part of its series
-- (T3 "Call it together", D-155 to D-157), and the day each call revealed for the thread.
--
-- social.thread_calls (owner: social, authoritative). One row per member, thread and call: the option the member
-- locked and the UTC day they locked it. The call is one stop of one exact Scroll revision, named by asset, revision
-- and stop, and the server reads it from that immutable revision; the right answer is never stored here, it is
-- worked out from the revision when a reveal is read. A row is never updated: the first lock stands.
-- Coarse on purpose: `day` is a date, so nothing finer than a day is kept (as a place is, 0080). The reveal rule
-- compares that day with today to open a call whose party never finishes.
-- A pick is a play result (D-063): it is shown to the members of the thread after the reveal and to the person in their
-- export, and nothing derives interest, a plan, a ranking or a place from it. No module that ranks, plans or forms places
-- imports Social, and a test stops any file outside Social naming this table. Nothing counts picks across threads: a
-- count over every thread is something one account could difference to read another's hidden pick (D-157).
-- Query shapes: one thread's calls by thread (the calls read, under the thread's lock); one person's calls by
-- account (leave, Clear, erasure, export).
-- Locking: written under the actor's personal root and own account gate, then the thread's conversation row FOR UPDATE
-- (as a place is). Read under the same row FOR SHARE.
-- Receipts: none. A lock is idempotent by its key (the first lock of a call stands, a repeat answers it), so no command
-- receipt is written: a receipt would keep the exact time of the lock and outlive leave and Clear.
-- Constraints: the row follows the member's membership row (the composite foreign key), so a pick cannot outlive the
-- member's row. Leaving, an ended friendship that carried the member in, and Clear delete it explicitly, because a leaver's
-- membership row stays.
-- Growth: at most nine members times the parts of the series that have a call, per thread.
-- Retention: kept until the person leaves, the friendship that carried them in ends, they Clear their exploration
-- history, or they delete the account. The export lists the person's own picks.
--
-- social.thread_call_reveals (owner: social, authoritative). One row per thread and call, written the first time a read
-- or a lock finds the call revealed for the whole thread (every member who takes part and shares a place has finished
-- the part, or two days passed since the first lock): the UTC day. It is what makes a reveal stay revealed, so that
-- the earliest locker leaving or clearing cannot move it back to hidden (D-155). It names no person and holds no pick,
-- so no erasure applies to it; it is thread state, like the thread's own row.
-- Query shapes: one thread's reveals by thread (under the thread's lock).
-- Writes: one insert, once, on conflict do nothing (a read may write it, under the thread's lock taken FOR SHARE: the
-- row is its own, so two readers cannot deadlock).
-- Growth: one row per thread and call that has revealed. Retention: for the life of the thread.
-- Rollout: additive. Older writers never write either table.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table social.thread_calls (
  thread_id uuid not null,
  account_id uuid not null,
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  stop_id text not null check (stop_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  -- Zero-based index of the locked option; a call has two or three options.
  option integer not null check (option between 0 and 2),
  day date not null,
  primary key (thread_id, account_id, asset_id, revision, stop_id),
  foreign key (thread_id, account_id)
    references social.conversation_members(conversation_id, account_id) on delete restrict,
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
create index thread_calls_account on social.thread_calls(account_id);

create table social.thread_call_reveals (
  -- No foreign key to the thread: a table that reaches a personal root through one must be declared to the erasure
  -- registry, and this one names no person. Threads are never deleted, so nothing can be orphaned.
  thread_id uuid not null,
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  stop_id text not null check (stop_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  day date not null,
  primary key (thread_id, asset_id, revision, stop_id),
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
