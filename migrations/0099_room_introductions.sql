-- #598 (v3 R-8b, second part) A resident's introduction (D-275): a moderator sets up one post in the Feed that says who a resident is and
-- what it does. It is a discussion of kind `intro`, rooted at nothing, whose first message is the resident's own fixed words, so a
-- member replies and votes under it like under any post. A room has one introduction per resident.
--
-- Owner: rooms. Authoritative for the introduction (an ordinary discussion and message plus `intro_inhabitant`).
-- Query shapes: a room's introductions (at most one per resident) with the Feed's finds; whether a resident has one.
-- Locking: introducing takes the room root FOR UPDATE inside the caller's personal scope, like posting (0097), so the one-per-resident
-- rule is exact. No personal root beyond the caller's own.
-- Access: members read it; only a moderator makes it. The discussion names the moderator who set it up only as its starter, which is
-- cleared when their account goes; the introduction stays with the room.
-- Growth: at most one row per resident per room (two residents, so two per room).
-- Retention: kept with the room, like any post. A Clear keeps it. Account deletion clears the moderator link.
-- Rollout: the widened check only admits a new value and the column is new and null for every row, so an older process keeps working;
-- it neither writes nor reads an introduction and would list one among a room's discussions until it restarts.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table rooms.discussions add column intro_inhabitant text;

-- squawk-ignore ban-drop-constraint
alter table rooms.discussions drop constraint discussions_kind_check;
alter table rooms.discussions
  add constraint discussions_kind_check check (kind in ('general', 'topic', 'today', 'find', 'intro')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_kind_check;

-- An introduction is one resident's: no asset, no source, no tag, no person's post, and a title that is the product's own words.
alter table rooms.discussions
  add constraint discussions_intro_check check (
    (kind = 'intro') = (intro_inhabitant is not null)
    and (kind <> 'intro' or (
      intro_inhabitant in ('explainer', 'skeptic') and root_asset_id is null and source_url is null
      and not person_post and tag is null and not title_derived
    ))
  ) not valid;
-- The column is new and null for every existing row, and no existing discussion is of kind `intro`, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_intro_check;

-- A room has one introduction per resident.
-- Existing room inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index discussions_one_intro on rooms.discussions(room_id, intro_inhabitant) where kind = 'intro';
