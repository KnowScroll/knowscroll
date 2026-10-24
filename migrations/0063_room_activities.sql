-- #245 (R03) Optional room activity: a moderator's poll or quiz inside one room, and a member's vote
-- in a poll (D-051).
--
-- Owner: rooms. Authoritative; nothing derived. A poll or quiz exists only inside the room that holds
-- it: it is never in a feed, never required, never scored, and no row here feeds how a universe forms.
-- A poll's votes are visible to the room and can be changed until the moderator closes it. A quiz is
-- read one question at a time and answered on the device: no answer, score or position is ever stored,
-- so this migration has no table for them.
-- Query shapes: a room's activities (open first, newest first); one activity by ID; the votes of one
-- poll (a tally and the first voters); one person's vote in one poll.
-- Locking: the room's own root as in 0062 (FOR SHARE); a vote takes the activity row FOR SHARE and a
-- moderator's close or removal takes it FOR UPDATE, so a vote can never land on a poll that has closed.
-- Access: members read; a moderator creates, closes and removes; a member votes while the room is open
-- and the poll is open. Nothing else grants access.
-- Growth: bounded by the application (five open at once and twenty started per room and UTC day);
-- the definition is at most 12 KiB; one vote row per person per poll.
-- Retention: kept until the room ends or the moderator removes the activity (the definition stays,
-- never served). Exploration Clear keeps both tables (explicit conversation, D-042). Deleting an
-- account deletes its votes and clears the creator link of activities it started; the activity goes on.
-- Rollout: additive; no earlier writer exists.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- definition is the validated wire shape with server-assigned IDs (poll: prompt and options o1..o5;
-- quiz: questions q1..q5 with options o1..o4 and an explanation each). It never changes after creation.
create table rooms.activities (
  activity_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  kind text not null check (kind in ('poll', 'quiz')),
  title text not null check (char_length(title) between 1 and 160),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 12288),
  state text not null default 'open' check (state in ('open', 'closed', 'removed')),
  -- Null once the moderator's account is deleted; the activity stays with the room.
  created_by_account_id uuid references identity.accounts(id) on delete restrict,
  created_at timestamptz not null,
  closed_at timestamptz,
  check ((state = 'open') = (closed_at is null))
);
create index activities_room_order on rooms.activities(room_id, state, created_at desc, activity_id);
create index activities_creator on rooms.activities(created_by_account_id) where created_by_account_id is not null;

-- One vote per person per poll; changing a vote replaces the row. The option ID names an option of the
-- poll's definition (the application checks it; the shape is checked here).
create table rooms.poll_votes (
  activity_id uuid not null references rooms.activities(activity_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  option_id text not null check (option_id ~ '^o[1-5]$'),
  voted_at timestamptz not null,
  primary key (activity_id, account_id)
);
create index poll_votes_account on rooms.poll_votes(account_id);
