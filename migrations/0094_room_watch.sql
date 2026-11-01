-- #496 (v3 R-10) Watch together (D-256 to D-258): a room watches one library Reel on a shared clock. The server keeps only which Reel,
-- when the first frame is due and, once it ends or is stopped, when. It never keeps anyone's playback position: each device works
-- its own position out from the server's clock.
--
-- Owner: rooms. Authoritative. Nothing is derived and stored: the position, whether the session is live and "N watching" are worked
-- out when read. A session is made from a library Reel under the room's topic (Content's public read); its title and length are
-- frozen onto the row (public facts of an immutable revision) so a read and the end never depend on a later read of Content.
-- `started_by` is the member who shared it ("Shared by ..."), and only that.
-- Query shapes: a room's unstopped session (at most one); a room's newest session; the viewers of one session; whether a person is a
-- viewer; the rooms among a map's stations that have a live session; how many sessions a room started in a day.
-- Locking: unchanged from 0062. A command takes the room root as it did, then the session row (FOR SHARE to join or leave, FOR UPDATE
-- to settle or stop). Settling an ended session deletes its viewers, so a join waits for it and then finds the session over.
-- Access: members only. A viewer row names the person and is read only to count the people who joined (and to know whether the
-- reader is one); a reader is told how many only from three, never who.
-- Growth: one unstopped session per room (partial unique index); a viewer row per person per session; at most 20 sessions a room a day.
-- Retention: a viewer row lives while its session does: it is deleted when the session ends or is stopped, by the first member command
-- of the room after that (a presence beat settles it). A session row is deleted seven days after it ended, by the same commands.
-- Erasure: a viewer row and `started_by` are the person's own (D-258), so a Clear, leaving, being removed and deleting the account
-- delete the row and empty the link, and the export lists what is still held.
-- Rollout: additive. An older process neither reads nor writes the new tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- One session. `starts_at` is when the Reel's first frame is due (a few seconds after the command, so devices can load it); a
-- device's position is the server's clock since then, never a stored value. `stopped_at` is when the session ended: the end of the
-- Reel, or an explicit stop, whichever came first; it is set once, by the first member command after it, and is the time the session
-- ended, not when it was noticed. No column anywhere holds a position, a pause or a time of a person's own.
create table rooms.watch_sessions (
  session_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  asset_id uuid not null,
  asset_revision integer not null check (asset_revision >= 1),
  title text not null check (length(title) between 1 and 160),
  duration_ms integer not null check (duration_ms between 1000 and 3600000),
  started_by uuid references identity.accounts(id) on delete restrict,
  starts_at timestamptz not null,
  stopped_at timestamptz
);
-- A new, empty table: the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index watch_sessions_one_live on rooms.watch_sessions(room_id) where stopped_at is null;
-- squawk-ignore require-concurrent-index-creation
create index watch_sessions_room_latest on rooms.watch_sessions(room_id, starts_at desc);
-- squawk-ignore require-concurrent-index-creation
create index watch_sessions_starter on rooms.watch_sessions(started_by) where started_by is not null;

-- A person who joined a session. Joining is explicit and is the only way to be counted; having the room open is not. The row says
-- that they joined and nothing more: no time of their own, no position.
create table rooms.watch_viewers (
  session_id uuid not null references rooms.watch_sessions(session_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  primary key (session_id, account_id)
);
-- squawk-ignore require-concurrent-index-creation
create index watch_viewers_account on rooms.watch_viewers(account_id);
