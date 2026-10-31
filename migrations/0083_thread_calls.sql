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
-- the part, or two days passed since the first lock): the row's existence means "revealed", and nothing else is kept,
-- so no day: a day would only record when a group finished. It is what makes a reveal stay revealed for a reader who has
-- no block with anyone in the thread, so that the earliest locker leaving or clearing cannot move it back to hidden
-- (D-155); a reader with a block keeps the live rule, which hides the blocked member. It names no person and holds no
-- pick. It is thread state: the erasure registry lists it as kept with the thread (Clear and account deletion leave
-- it), and its foreign key to the thread is why it is declared there.
-- Query shapes: one thread's reveals by thread (under the thread's lock).
-- Writes: one insert, once, on conflict do nothing (a read may write it, under the thread's lock taken FOR SHARE: the
-- row is its own, so two readers cannot deadlock; a lock that ends as "stands" or "closed" may write it too, because
-- it records a fact about the thread that any read would record).
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
  thread_id uuid not null references social.content_threads(thread_id) on delete restrict,
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  stop_id text not null check (stop_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  primary key (thread_id, asset_id, revision, stop_id),
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
