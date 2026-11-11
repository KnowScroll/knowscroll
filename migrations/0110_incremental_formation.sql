-- #674 (slice 4.1) Formation costs what changed, not what the catalogue or a person's history holds (D-416).
-- Owners: modules/personal-context (the dirty set, support recency) and modules/geography (the place secret, per-place quiet).
--
-- 1. personal_context.coverage_dirty_topics: one row per universe, epoch and topic whose trusted support changed (a support
--    key's reference was added or removed) since Geography last evaluated it. `dirty_revision` is the personal scope revision
--    the changing transaction commits at (`revisionAtEntry + 1`), so a run that read the set at scope revision R has seen every
--    row at or below R, and evidence that arrives during the run stays dirty. Derived, never evidence: the facts are in
--    `coverage_supports`. Activity-only changes touch no row.
-- 2. personal_context.coverage_supports.last_activated_at: when the newest exposure of the key was activated. It only orders a
--    topic's keys newest first so a run can read a bounded number per facet; a removed reference leaves it where it was, so
--    it can be later than the true newest and never decides what a place is.
-- 3. geography.state.place_secret: a per-universe, per-epoch 256-bit secret (hex), created at the first run. A new place's id
--    and a new route's id are an HMAC of it and the semantic key, so no per-run slot or pair table exists and an id reveals
--    nothing. The state row is erased by Clear and account deletion, which erases the secret with it.
-- 4. geography.objects.last_support_at: the newest support activation under the place when its topic was last evaluated (a
--    system's and star's value is the newest over everything evaluated under it). geography.objects.quiet_check_at: when the
--    place next needs a look: its last support plus 30 days while it is active, now while its stored activity differs from what
--    its support implies, null otherwise. The quiet sweep reads the places that are due with one indexed query across
--    universes. Both are derived scheduling state, never evidence, and never leave the server.
--
-- Query shapes: the dirty set is read by (universe, epoch, dirty_revision, topic) for the newest N, deleted by (universe, epoch,
-- topic, revision); a topic's keys are read by the primary key prefix of coverage_supports; the sweep takes the oldest 100
-- due places (partial index below), skipping rows another transaction holds. Growth: at most one dirty row per topic a person
-- has supported, deleted as each is evaluated; two timestamps on rows that already exist. Retention and erasure: the dirty set
-- is a personal store erased with the other personal-context tables; the rest live on rows Clear and account deletion delete.
-- Lock order: unchanged. The dirty rows are written under the personal root by the producer that already writes
-- coverage_supports; Geography deletes them under the same root.
-- Rollout: additive. An older writer never touches the new tables or columns and an older reader ignores them. Reading that
-- happened before the new code ran marked nothing dirty, so the operator's `geography reconcile-coverage` marks every topic
-- that has support for the readers who need it. geography.state.next_quiet_at and its index are no longer written or read;
-- they stay so a release that still reads them keeps working, and a later migration removes them.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table personal_context.coverage_dirty_topics (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  topic_id text not null check (length(topic_id) between 1 and 160),
  dirty_revision integer not null check (dirty_revision >= 1),
  primary key (universe_id, privacy_epoch, topic_id)
);
create index coverage_dirty_oldest on personal_context.coverage_dirty_topics (universe_id, privacy_epoch, dirty_revision, topic_id);

alter table personal_context.coverage_supports add column last_activated_at timestamptz;

-- Order only: the newest activation of each key from the references that hold it, legacy and recording. A key whose
-- references cannot be dated stays null and sorts last.
update personal_context.coverage_supports support
set last_activated_at = dated.activated_at
from (
  select reference.universe_id, reference.privacy_epoch, reference.topic_id, reference.facet_id, reference.meaning_sha256,
    reference.explanation_unit_id, reference.truth_sha256,
    max((contribution.payload ->> 'activatedAt')::timestamptz) as activated_at
  from personal_context.coverage_references reference
  join personal_context.coverage_contributions contribution
    on contribution.universe_id = reference.universe_id and contribution.privacy_epoch = reference.privacy_epoch
    and contribution.exposure_id = reference.exposure_id
  group by reference.universe_id, reference.privacy_epoch, reference.topic_id, reference.facet_id, reference.meaning_sha256,
    reference.explanation_unit_id, reference.truth_sha256
) dated
where support.universe_id = dated.universe_id and support.privacy_epoch = dated.privacy_epoch
  and support.topic_id = dated.topic_id and support.facet_id = dated.facet_id and support.meaning_sha256 = dated.meaning_sha256
  and support.explanation_unit_id = dated.explanation_unit_id and support.truth_sha256 = dated.truth_sha256;

update personal_context.coverage_supports support
set last_activated_at = greatest(support.last_activated_at, dated.activated_at)
from (
  select reference.universe_id, reference.privacy_epoch, reference.topic_id, reference.facet_id, reference.meaning_sha256,
    reference.explanation_unit_id, reference.truth_sha256,
    max((coalesce(head.coverage, legacy.payload) ->> 'activatedAt')::timestamptz) as activated_at
  from personal_context.recording_coverage_references reference
  left join personal_context.recording_segment_heads head
    on reference.source_kind = 'segment' and head.universe_id = reference.universe_id
    and head.exposure_id = reference.exposure_id and head.recording_generation = reference.source_segment_generation
  left join personal_context.coverage_contributions legacy
    on reference.source_kind = 'legacy' and legacy.universe_id = reference.universe_id
    and legacy.privacy_epoch = reference.privacy_epoch and legacy.exposure_id = reference.exposure_id
  group by reference.universe_id, reference.privacy_epoch, reference.topic_id, reference.facet_id, reference.meaning_sha256,
    reference.explanation_unit_id, reference.truth_sha256
) dated
where support.universe_id = dated.universe_id and support.privacy_epoch = dated.privacy_epoch
  and support.topic_id = dated.topic_id and support.facet_id = dated.facet_id and support.meaning_sha256 = dated.meaning_sha256
  and support.explanation_unit_id = dated.explanation_unit_id and support.truth_sha256 = dated.truth_sha256;

alter table geography.state add column place_secret text
  check (place_secret is null or place_secret ~ '^[0-9a-f]{64}$');

alter table geography.objects add column last_support_at timestamptz;
alter table geography.objects add column quiet_check_at timestamptz;

-- The objects of a world are at most 1000 per universe and the migrator's transaction cannot build an index CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index geography_object_quiet_due on geography.objects (quiet_check_at) where quiet_check_at is not null;

-- Every place that is not quiet is due once: the first sweep reads the support of its topic, stores the true last support and
-- the next time it needs a look. A place that is already quiet needs nothing until its topic is read again.
update geography.objects
set quiet_check_at = now()
where payload #>> '{activity,state}' is distinct from 'quiet';
