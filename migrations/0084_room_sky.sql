-- #491 (v3 R-5) Today and the sky (D-174 to D-176): the daily channel, the day's two ritual items (a question and
-- Spot the flaw) and what a person picked, the room's stars and the constellations they make, the vote that names a
-- constellation, and a debate with its two sides, its votes and its close.
--
-- Owner: rooms. Authoritative, except nothing is derived: a star is a fact, a constellation is counted from stars.
-- Query shapes: a room's Today discussion (one per room); a room's approved rituals for a day and the few days before it;
-- a person's pick on a ritual and how many found the flaw; a room's stars newest first, how many were earned on a UTC day,
-- and whether one exists for (room, act, source); a room's constellations and the votes on the one being named; a
-- discussion's debate, its tally and one person's vote.
-- Locking: unchanged from 0062. An act that may earn a star takes the room root FOR SHARE or FOR UPDATE as it did, then the
-- transaction advisory lock `rooms.sky:<room>` (always last) around the day's count, the unique insert and the constellation
-- check, so two acts at once cannot pass the daily cap or make the same constellation twice.
-- Access: members only. A star names an act, a day and the constellation it belongs to, never a person, a message text or a
-- title. A vote and a pick name the person and are read only by that person (a tally is counts, never voters).
-- Growth: one Today discussion per room; at most two rituals per room per day (unique); one pick per person per ritual; stars
-- are bounded by the daily cap (three a day by default); one constellation per seven stars; one vote per member per
-- constellation and per debate (replaced, never appended); one debate per discussion.
-- Retention: rituals and stars are kept with the room. A star outlives everyone who earned it: no account is stored on it.
-- Account deletion deletes the person's picks and votes. Leaving or being removed deletes the person's votes and picks in that
-- room. Exploration Clear deletes the person's picks (a play result, D-082) and keeps their votes (explicit communication,
-- D-042), as it keeps poll votes.
-- Rollout: additive. Every existing room gets its Today discussion here. An older process neither reads nor writes these
-- tables; it would list Today among the room's discussions until it restarts (it is read-only for it: it has no ritual).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The daily channel: one per room, made with the room like General. It holds the day's conversation; the ritual items are
-- cards above it, read from `rituals`.
insert into rooms.discussions (discussion_id, room_id, title, last_activity_at, created_at, kind)
select gen_random_uuid(), room.room_id, 'Today', room.created_at, room.created_at, 'today'
from rooms.rooms room;
-- Existing room inventory is a handful of rows at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index discussions_one_today on rooms.discussions(room_id) where kind = 'today';

-- A day's ritual item for one room. `question` is a template filled from a library Scroll (no model call); `flaw` is a
-- passage of a library Scroll with one sentence altered, where the model wrote only the altered sentence and code chose
-- which sentence, kept the original as the key and checked the alteration. `payload` is the shape in `ritual.v1` (the
-- words, the cited passage, and for a flaw the key). Nothing is shown until an operator approves it.
create table rooms.rituals (
  ritual_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  day date not null,
  kind text not null check (kind in ('question', 'flaw')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  payload_version text not null check (payload_version ~ '^ritual\.v[0-9]+$'),
  state text not null check (state in ('draft', 'approved', 'rejected')),
  made_by text not null check (made_by in ('template', 'model')),
  role_version text,
  model text,
  attempt_id uuid,
  created_at timestamptz not null,
  decided_at timestamptz,
  decided_by text check (decided_by ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$'),
  unique (room_id, day, kind),
  check ((state = 'draft') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null)),
  check ((made_by = 'model') = (model is not null and role_version is not null))
);
create index rituals_shown on rooms.rituals(room_id, day desc) where state = 'approved';
create index rituals_waiting on rooms.rituals(created_at) where state = 'draft';

-- One person's tap on one Spot the flaw. Final: the key is shown after it. It is a play result of the person, so a Clear
-- and a deletion delete it; a star it earned has no account and stays with the room.
create table rooms.ritual_solves (
  ritual_id uuid not null references rooms.rituals(ritual_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  picked smallint not null check (picked between 0 and 4),
  correct boolean not null,
  solved_at timestamptz not null,
  primary key (ritual_id, account_id)
);
create index ritual_solves_account on rooms.ritual_solves(account_id);

-- The room's stars. `source_key` is the message, ritual or discussion the act came from, so the same act earns once even
-- when its command is retried or two people finish it together. `earned_on` is the UTC day, for the daily cap.
-- `constellation_no` is the constellation the star counts toward (seven stars each).
create table rooms.stars (
  star_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  act text not null check (act in ('answer_useful', 'debate_closed', 'daily_solved')),
  source_key uuid not null,
  earned_at timestamptz not null,
  earned_on date not null,
  constellation_no integer not null check (constellation_no >= 1),
  unique (room_id, act, source_key)
);
create index stars_room_day on rooms.stars(room_id, earned_on);
create index stars_room_latest on rooms.stars(room_id, earned_at desc);

-- A constellation the room finished (its seventh star) and its name. Three candidate names come from code word lists; the
-- members vote for one until `vote_closes_at`; the first member command after that settles it (highest count, ties to the
-- earlier candidate, no votes to the first). `name` is null while the vote is open.
create table rooms.constellations (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  no integer not null check (no >= 1),
  completed_at timestamptz not null,
  candidates text[] not null check (cardinality(candidates) = 3),
  vote_closes_at timestamptz not null,
  name text check (char_length(name) between 1 and 40),
  named_at timestamptz,
  primary key (room_id, no),
  check ((name is null) = (named_at is null)),
  check (vote_closes_at > completed_at)
);

create table rooms.constellation_votes (
  room_id uuid not null,
  no integer not null,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  candidate smallint not null check (candidate between 0 and 2),
  voted_at timestamptz not null,
  primary key (room_id, no, account_id),
  foreign key (room_id, no) references rooms.constellations(room_id, no) on delete restrict
);
create index constellation_votes_account on rooms.constellation_votes(account_id);

-- A debate: a topic tagged `debate` with two sides and a close time. Votes are visible as counts only, and only to a
-- person who voted or once it closed. It closes at the first member command after `closes_at`; with two or more different
-- voters it earns the room a star. `winner` is null on a tie.
create table rooms.debates (
  discussion_id uuid primary key references rooms.discussions(discussion_id) on delete restrict,
  side_a text not null check (char_length(side_a) between 1 and 60),
  side_b text not null check (char_length(side_b) between 1 and 60),
  closes_at timestamptz not null,
  state text not null check (state in ('open', 'closed')),
  closed_at timestamptz,
  winner text check (winner in ('a', 'b')),
  voters integer check (voters >= 0),
  check ((state = 'open') = (closed_at is null)),
  check ((state = 'open') = (voters is null)),
  check (winner is null or state = 'closed'),
  check (lower(side_a) <> lower(side_b))
);
create index debates_due on rooms.debates(closes_at) where state = 'open';

create table rooms.debate_votes (
  discussion_id uuid not null references rooms.debates(discussion_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  side text not null check (side in ('a', 'b')),
  voted_at timestamptz not null,
  primary key (discussion_id, account_id)
);
create index debate_votes_account on rooms.debate_votes(account_id);
