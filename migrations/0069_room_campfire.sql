-- #487 (v3 R-1) The room as a place: a General discussion in every room, each member's own AI level, keep-out
-- switch and notice mark, and who has the room open right now (D-062, D-069).
--
-- Owner: rooms. Authoritative; nothing derived except room_presence, which is a short lease.
-- Query shapes: a room's General discussion (one per room); a member's own settings (members row); the faces
-- of a room (presence rows newer than the lease, joined to profiles); the newest visible message of a room;
-- the members who keep their messages out, among the authors of a discussion's newest messages and the starter.
-- Locking: unchanged from 0062. A presence heartbeat and a member's own settings take the room root FOR SHARE,
-- like a send; joining, leaving and removing take it FOR UPDATE and delete the person's presence row.
-- Access: members only. A presence row exists only for a current member and only while their device says the
-- room is open; nothing records what they did there.
-- Growth: at most one General per room, one presence row per member per room (rewritten, never appended).
-- Retention: presence is a lease of one minute and is read only inside it; a row is also deleted when the member
-- leaves or is removed, and with the account. Exploration Clear keeps it, as it keeps the membership: the lease is
-- the account's, not exploration, and ends by itself. The other columns are settings and are kept with the membership.
-- Rollout: additive. Existing discussions become topics; every existing room gets a General discussion; existing
-- members get the default AI level of their room (Lively in an open room, Quieter otherwise, R3 question 5) and
-- will see the AI notice once.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- general: the room's default place to talk, one per room, created with the room. today: reserved for the
-- daily channel and topic is every other discussion; this migration creates only general and topic.
alter table rooms.discussions
  add column kind text not null default 'topic' check (kind in ('general', 'topic', 'today'));
-- Existing room inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index discussions_one_general on rooms.discussions(room_id) where kind = 'general';

insert into rooms.discussions (discussion_id, room_id, title, last_activity_at, created_at, kind)
select gen_random_uuid(), room.room_id, 'General', room.created_at, room.created_at, 'general'
from rooms.rooms room;

-- ai_level is how much the room's AI inhabitants may speak to this member; keep_out replaces this member's
-- messages with a placeholder before any model reads them; notice_seen_at is when they acknowledged the AI notice.
alter table rooms.members
  add column ai_level text not null default 'lively' check (ai_level in ('lively', 'quieter', 'off')),
  add column keep_out boolean not null default false,
  add column notice_seen_at timestamptz;

update rooms.members member set ai_level = 'quieter'
from rooms.rooms room
where room.room_id = member.room_id and room.join_rule <> 'open';

-- The newest visible message of a room is read with every room read: one probe of this index for each of the room's
-- discussions, newest first, skipping messages a moderator removed.
-- Existing message inventory is bounded at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index messages_latest_visible on rooms.messages(discussion_id, recorded_at desc) where hidden_at is null;

-- One row per member who has the room open. last_seen_at is renewed by the member's own device while the room
-- is open and visible; a reader counts a row only while it is newer than the lease.
create table rooms.room_presence (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  last_seen_at timestamptz not null,
  primary key (room_id, account_id)
);
create index room_presence_fresh on rooms.room_presence(room_id, last_seen_at desc);
create index room_presence_account on rooms.room_presence(account_id);
