-- #492 (v3 R-6) The Launch (D-178 to D-179, D-219 to D-224): a live five-question quiz a room plays together, its answers, and
-- the star a finished Launch earns the room.
--
-- Owner: rooms. Authoritative. Nothing is derived and stored: the podium, the squares and the phase are worked out when read.
-- A Launch is made from a `launch` item of `rooms.rituals` (an approved deck of five library Scroll calls, chosen by code, never
-- written by a model while someone waits); the questions are frozen onto the Launch so a later change of the library never
-- moves a game in progress. The questions never leave the server except the one being asked, and its key not until it closes.
-- Query shapes: a room's unfinished Launch (at most one); a room's newest Launch; the players and answers of one Launch; a person's
-- answers in a room; whether a deck was already played; the rooms among a map's stations that have an unfinished Launch.
-- Locking: unchanged from 0062. A command takes the room root as it did, then the Launch row (FOR SHARE to answer or join, FOR UPDATE
-- to settle), then, last, the sky lock `rooms.sky:<room>` when the Launch earns its star. Settling waits for answers in flight, so
-- the finished Launch holds every answer that was accepted before its end.
-- Access: members only. A launch holds no account (who started it is not kept). A player row and an answer name the person and are
-- read by that person; others read only what the podium and the reveal show.
-- Growth: one unfinished Launch per room (partial unique index); one Launch per deck (unique); at most five answers a player.
-- Retention: a Launch row stays with the room. The players and answers of a Launch are deleted seven days after it finished, by the
-- next Launch command of the room; a podium is read for a day.
-- Erasure: players and answers are play results of the person (D-082), so a Clear, leaving or being removed, and deleting the account
-- delete them, and the export lists them first. A star a Launch earned names no account and stays.
-- Rollout: additive, except that two checks widen (a ritual's kind and a star's act). An older process neither reads nor writes the new
-- tables and never drafts a `launch` item; its inserts still satisfy the wider checks.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A deck is a ritual item of its own kind, drafted by the night's batch and approved by an operator like the day's question.
alter table rooms.rituals drop constraint rituals_kind_check;
alter table rooms.rituals
  add constraint rituals_kind_check check (kind in ('question', 'flaw', 'launch')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.rituals validate constraint rituals_kind_check;

-- A finished Launch is the fourth act that earns a star (D-174).
alter table rooms.stars drop constraint stars_act_check;
alter table rooms.stars
  add constraint stars_act_check
    check (act in ('answer_useful', 'debate_closed', 'daily_solved', 'launch_finished')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table rooms.stars validate constraint stars_act_check;

-- One Launch. `starts_at` is when the first question opens (the lobby is before it); every other time is `starts_at` plus a fixed
-- number of seconds, so the server's clock alone decides what is open. `state` is `live` until the first member command after the
-- end settles it. `played` and `star` are written once, then: how many people answered at least once, and whether the room earned a star.
create table rooms.launches (
  launch_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  deck_ritual_id uuid not null references rooms.rituals(ritual_id) on delete restrict,
  questions jsonb not null
    check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) = 5 and pg_column_size(questions) <= 16384),
  starts_at timestamptz not null,
  created_at timestamptz not null,
  state text not null check (state in ('live', 'finished')),
  finished_at timestamptz,
  played integer check (played >= 0),
  star boolean,
  unique (deck_ritual_id),
  check ((state = 'finished') = (finished_at is not null)),
  check ((state = 'finished') = (played is not null)),
  check ((state = 'finished') = (star is not null))
);
-- A new, empty table: the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index launches_one_unfinished on rooms.launches(room_id) where state = 'live';
-- squawk-ignore require-concurrent-index-creation
create index launches_room_latest on rooms.launches(room_id, starts_at desc);

-- A person who is in a Launch (they joined, or started it). Opting in is the only way to play.
create table rooms.launch_players (
  launch_id uuid not null references rooms.launches(launch_id) on delete restrict,
  account_id uuid not null references identity.accounts(id) on delete restrict,
  joined_at timestamptz not null,
  primary key (launch_id, account_id)
);
-- squawk-ignore require-concurrent-index-creation
create index launch_players_account on rooms.launch_players(account_id);

-- One answer to one question. `elapsed_ms` is the server's own measure from the question's opening to the moment it accepted the
-- answer, never a device's; `correct` is judged on the server from the frozen question. A round is answered once: the first stands.
create table rooms.launch_answers (
  launch_id uuid not null,
  round integer not null check (round between 1 and 5),
  account_id uuid not null,
  choice integer not null check (choice between 0 and 2),
  elapsed_ms integer not null check (elapsed_ms between 0 and 60000),
  correct boolean not null,
  answered_at timestamptz not null,
  primary key (launch_id, round, account_id),
  foreign key (launch_id, account_id) references rooms.launch_players(launch_id, account_id) on delete restrict
);
-- squawk-ignore require-concurrent-index-creation
create index launch_answers_account on rooms.launch_answers(account_id);
