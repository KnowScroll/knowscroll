-- #473 (D-180, D-181) The play layer: the calls a person locks on a Scroll and what they earned.
--
-- play.calls (owner: play). One row per person, Scroll revision and call stop: the option the person
-- locked, and whether it was right, recomputed by the server from the immutable revision at the
-- moment of locking (never taken from the client). A row is never updated: the first lock stands.
-- Only the person ever sees a row, in the reader and in their export. It is no evidence: nothing
-- derives interest, a planet, a ranking or a claim about what the person knows from it, and no other
-- module reads it (a dependency rule forbids the modules that rank, plan or form places from
-- importing play).
--   Reads: all of one person's calls on one revision, in lock_seq order (the reader's "my results", the export).
--   Writes: one insert per accepted lock, in the personal root's transaction with its receipt.
--   Growth: at most four calls a Scroll revision (scroll-limits.v2) per person who played it.
--   Retention: kept until the person clears exploration or deletes the account.
--   Erasure: universe-keyed. Clear and full erasure delete the rows.
--
-- play.scroll_results (owner: play). One row per person and Scroll revision: how many calls were
-- locked, the sparks they earned (one for each right call) and the current run of right calls (the
-- combo). Sparks belong to one Scroll; nothing sums them across Scrolls or people (D-064).
--   Reads: one row by primary key (the dock's sparks, the reveal's combo).
--   Writes: upserted in the same transaction as the call it counts.
--   Growth: one row per person and Scroll revision played.
--   Erasure: universe-keyed, with play.calls.
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema play;

create table play.calls (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  stop_id text not null check (stop_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  -- Zero-based index of the locked option; a call has two or three options.
  option integer not null check (option between 0 and 2),
  correct boolean not null,
  -- The command that locked it, to answer an identical retry with the same outcome.
  command_id uuid not null,
  -- The order the person locked their calls in. A sequence, not the clock: a clock that steps back must
  -- not reorder a combo.
  lock_seq bigint generated always as identity,
  locked_at timestamptz not null default now(),
  primary key (universe_id, asset_id, revision, stop_id),
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);

create table play.scroll_results (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  calls_locked integer not null check (calls_locked between 0 and 4),
  sparks integer not null check (sparks between 0 and 4 and sparks <= calls_locked),
  combo integer not null check (combo between 0 and 4 and combo <= sparks),
  updated_at timestamptz not null default now(),
  primary key (universe_id, asset_id, revision),
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
