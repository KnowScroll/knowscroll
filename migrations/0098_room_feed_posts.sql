-- #598 (v3 R-8b) People's posts and votes in the room's Feed (D-271 to D-274): a member posts a find, which is a discussion of kind `find`
-- started by that member, with their own words as its first message and a link to one admitted library asset or to one source (a
-- plain http(s) address kept as text and never fetched). Members vote up on any post; agents, residents and scouts have no
-- account, so none can. A vote is a row with no count of its own: the Feed counts rows.
--
-- Owner: rooms. Authoritative for a person's post (an ordinary discussion and message plus `source_url`, and `person_post`, which
-- says a person wrote it even after their account link was cleared) and for `post_votes`.
-- Query shapes: a room's finds newest first (0091); a room's finds in a window with their vote counts, for Top; a post's vote
-- count and whether this reader voted; a member's posts today in a room (the daily cap); a room's finds by address.
-- Locking: a post takes the room root FOR UPDATE, so the day's cap and the one-post-per-link rule are exact; a vote takes it FOR SHARE
-- like other member commands. No personal root beyond the caller's own is taken.
-- Access: members only. A vote names its voter in this table, but no answer ever lists voters: a post carries a count and whether the
-- reader voted, to the reader only.
-- Growth: at most three posts a day per member per room (a cap in code); one vote per member per post.
-- Retention: a post stays with the room like any message (explicit communication, D-042; a Clear keeps it). A vote is the voter's
-- own: leaving, removal and deleting the account delete it; a Clear keeps it, as it keeps a Useful mark (it holds no reading). When
-- an account is deleted its posts' words become a tombstone and their title becomes the neutral one, and the source is erased.
-- Rollout: the replaced check only admits a new shape, so an older process keeps working; it neither writes nor reads a person's
-- post and would list one among a room's discussions until it restarts (a find has a root or a source and no tag).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table rooms.discussions add column source_url text, add column person_post boolean not null default false;

-- A source is the address the person pasted, kept as text: at most 500 characters, http or https, no spaces. Code normalises and
-- checks it before it is stored; this is the belt.
alter table rooms.discussions
  add constraint discussions_source_check check (
    source_url is null or (kind = 'find' and person_post and source_url ~ '^https?://[^[:space:]]+$' and char_length(source_url) <= 500)
  ) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_source_check;
alter table rooms.discussions
  add constraint discussions_person_post_check check (not person_post or kind = 'find') not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_person_post_check;

-- A find is a resident's or a scout's (a library asset, no starter) or a person's (one library asset or one source, never both). A
-- person's post that had its account deleted has neither: its words and its source are erased and the room keeps the place.
-- squawk-ignore ban-drop-constraint
alter table rooms.discussions drop constraint discussions_find_check;
alter table rooms.discussions
  add constraint discussions_find_check check (
    kind <> 'find' or (
      tag is null and not title_derived and (
        (not person_post and root_asset_id is not null and source_url is null and started_by_account_id is null)
        or (person_post and not (root_asset_id is not null and source_url is not null))
      )
    )
  ) not valid;
-- No existing discussion is a find by a person, and the old check held for every find that exists.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_find_check;

-- A room is shown one post per source, as it is shown one find per asset (0091).
-- Existing room inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index discussions_one_find_per_source on rooms.discussions(room_id, source_url)
  where kind = 'find' and source_url is not null;
-- A member's posts in a room by day: the cap on how many a person may post.
-- squawk-ignore require-concurrent-index-creation
create index discussions_person_posts on rooms.discussions(room_id, started_by_account_id, created_at desc)
  where kind = 'find' and started_by_account_id is not null;

-- A vote: one row per member per post, up only. It is the voter's own act in the room and nothing else: no reading, no evidence.
create table rooms.post_votes (
  discussion_id uuid not null references rooms.discussions(discussion_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  voted_at timestamptz not null,
  primary key (discussion_id, account_id)
);
-- The voter's own rows, for leaving, removal, deletion and the export.
-- squawk-ignore require-concurrent-index-creation
create index post_votes_account on rooms.post_votes(account_id);
