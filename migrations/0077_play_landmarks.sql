-- #474 (D-187, D-188) The Final call and the landmark it awards. Owner: modules/play.
--
-- play.landmarks (owner: play). One row per person and Scroll revision whose Final call the person locked,
-- when that revision names a landmark: the landmark's key and the name the person saw, the finish
-- (gold for a right Final call, plain for any other) and when it was earned. It is awarded once, in the
-- transaction that stores the Final call, and never changes: the Final call is locked once and the first
-- lock stands. A revision without a landmark awards no row.
-- A landmark is a trophy of one Scroll, shown back to the person and exported to them. It is no evidence and
-- no mastery: nothing derives interest, a planet, a ranking or a claim about what the person knows from it,
-- and no other module reads it (the dependency rules that wall play off apply to this table too). It never
-- makes a place form (D-063, D-084).
--   Reads: all of one person's landmarks, by universe (the payoff, later the Universe overlay and the tray);
--          one row by primary key (the payoff of a Scroll opened again).
--   Writes: one insert per awarded landmark, in the personal root's transaction with the Final call's receipt
--           and its play.calls row.
--   Growth: at most one row per Scroll revision a person has finished.
--   Retention: kept until the person clears exploration or deletes the account.
--   Erasure: universe-keyed. Clear and full erasure delete the rows.
--
-- play.scroll_results widens its bounds. The Final call is the fourth call a Scroll may hold, and a right
-- one after a combo of two or more earns a second spark, so sparks reach five while a combo stays at most four.
-- The bounds only widen: every row written before still satisfies them.
-- Rollout: additive. An older writer never touches play.landmarks and still satisfies the wider bounds.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table play.landmarks (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  asset_id uuid not null,
  revision integer not null check (revision >= 1),
  landmark_key text not null check (landmark_key ~ '^[a-z][a-z0-9-]{1,39}$'),
  landmark_name text not null check (char_length(landmark_name) between 4 and 40),
  tier text not null check (tier in ('gold', 'plain')),
  earned_at timestamptz not null default now(),
  primary key (universe_id, asset_id, revision),
  foreign key (asset_id, revision) references content.asset_revisions(asset_id, revision) on delete restrict
);

-- Widens the bounds of the tally. Existing rows already satisfy the narrower ones.
-- squawk-ignore ban-drop-constraint
alter table play.scroll_results drop constraint scroll_results_check;
-- squawk-ignore ban-drop-constraint
alter table play.scroll_results drop constraint scroll_results_check1;
alter table play.scroll_results
  add constraint scroll_results_sparks_check check (sparks between 0 and 5 and sparks <= calls_locked + 1) not valid;
alter table play.scroll_results
  add constraint scroll_results_combo_check check (combo between 0 and 4 and combo <= sparks) not valid;
