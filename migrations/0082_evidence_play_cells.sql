-- #476 (v3 S-5) activity.v1 and play-level format cells (D-191, D-192). Owner: modules/evidence.
--
-- activity.v1: a stored activity revision may name `activity.v1`. 0019 pinned the label to `activity.v0`; the revisions
-- written so far keep it and keep their meaning. New revisions name v1, whose only change is that a deliberate
-- continuation credits the exposure it left only when that exposure was read enough to count.
--
-- Play-level cells: how often a person read a Scroll of a play level through (plain, stage, game), per topic and kind.
-- `topic_format_cells` holds the measured and qualified counts of one (topic, kind, play level), beside the
-- (topic, kind) parent that `topic_context` already keeps over every level. Both count reading only: a qualified response
-- is `q >= 0.6`, never a pick, a result, a spark or a tier (D-063). `topic_contributions.play_level` remembers the level
-- an exposure's counts were added to, so a correction moves exactly those counts from one cell to another.
-- Every encounter stored so far was read as plain, so each existing parent count becomes its plain cell: history stays true.
--
-- Query shapes: the cells of up to 100 requested topics (one read by universe, epoch and topic list, at most six rows a
-- topic); an update touches the cells of the affected topics of one exposure, by primary key.
-- Growth: at most six rows per topic (two kinds, three levels); no lifetime scan per swipe.
-- Retention and erasure: those of `topic_context` (retained personal evidence; Clear and account deletion delete the
-- rows by universe, before the universe).
-- Lock order: unchanged. Written under the personal root with the rest of the projection.
-- Rollout: additive. A process from before this migration writes `topic_context` and `topic_contributions` as it did and
-- no cell, so its counts reach cells only at the next correction; a reader that ignores cells reads the parent, which is
-- the rate that was always used.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The pin is widened by name; every existing row names v0, which the new check also allows.
-- squawk-ignore ban-drop-constraint
alter table evidence.activity_revisions drop constraint activity_revisions_policy_version_check;
alter table evidence.activity_revisions
  add constraint activity_revisions_policy_version_check
  check (policy_version in ('activity.v0', 'activity.v1')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table evidence.activity_revisions validate constraint activity_revisions_policy_version_check;

alter table evidence.topic_contributions
  add column play_level text not null default 'plain' check (play_level in ('plain', 'stage', 'game'));

create table evidence.topic_format_cells (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  topic_id text not null,
  kind text not null check (kind in ('reel', 'scroll')),
  play_level text not null check (play_level in ('plain', 'stage', 'game')),
  measured integer not null,
  qualified integer not null check (qualified between 0 and measured),
  primary key (universe_id, topic_id, kind, play_level)
);

insert into evidence.topic_format_cells (universe_id, privacy_epoch, topic_id, kind, play_level, measured, qualified)
select universe_id, privacy_epoch, topic_id, 'reel', 'plain', reel_measured, reel_qualified
from evidence.topic_context
where reel_measured > 0;
insert into evidence.topic_format_cells (universe_id, privacy_epoch, topic_id, kind, play_level, measured, qualified)
select universe_id, privacy_epoch, topic_id, 'scroll', 'plain', scroll_measured, scroll_qualified
from evidence.topic_context
where scroll_measured > 0;
