-- #674 (slices 4.2 and 5.2) Composer policy v3 (D-420): long-term interest selects candidates, and format is learned
-- per topic with pooling. Owner: modules/evidence (the pin of composer.decisions is Composer's).
--
-- 1. `topic_context.log_weight` = ln(activity) + ln(2) * evaluated_at_ms / half_life_ms. A topic's stored activity decays
--    by the same factor as every other topic's, so ordering by this number is ordering by decayed activity at any later time:
--    "the person's top K topics now" is one range scan of `topic_context_top_interest`, never a read of every
--    topic. It is NULL while activity is 0 (ln 0). The half life is the one `activity.v1` uses (14 days); a change of it is a
--    new migration, because the column holds the old one.
-- 2. `interest_rollups`: one row per system and one for the person, in the shape of `topic_context` (decayed activity,
--    channels, reel/scroll measured and qualified, log_weight), written in the same transaction as the topic rows. The system
--    row is the sum of its topics' rows and the person row the sum of every topic, so "the system without this topic" and
--    "the person without this system" are differences. They are the priors of v3's interest and format shrinkage. They hold
--    reading only (a qualified response is q >= 0.6), never a pick, a result, a spark or a tier (D-063).
-- 3. The pin of `composer.decisions` also allows `composer-policy.v3`.
--
-- Backfill. `log_weight` is computed for every row. The person row is the sum of the person's topic rows decayed to the newest
-- row's time. The system rows are the sums over the systems of the code catalogue at this migration (the `values` list: the
-- 17 topics and 6 systems of `content-concepts.v1`); a topic the catalogue gains later gets its rollup from the writes that
-- follow it. Without the backfill a person's rollups appear only at their next activity, and v3 meanwhile reads no system
-- prior (it reads exactly what v2 reads).
--
-- Query shapes: top K = `where universe_id, privacy_epoch and log_weight is not null order by log_weight desc, topic_id limit K`
-- (index above, no sort); rollups = primary key probe by (universe, level, subject) for the systems of the candidates and the
-- person. Growth: one row per system a person has touched plus one. Retention and erasure: those of `topic_context` (retained
-- personal evidence; Clear and account deletion delete the rows by universe, before the universe).
-- Lock order: unchanged, written under the personal root with the rest of the projection.
-- Rollout: additive. An older writer leaves log_weight NULL and writes no rollup, so its topics are invisible to the top-K
-- read and a person's rollups lag until the new binary writes them; v3 is off unless `KS_COMPOSER_POLICY=v3`.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table evidence.topic_context add column log_weight double precision;

-- Bounded at rollout (one row per topic a person has met); the lock timeout above bounds the wait.
update evidence.topic_context
set log_weight = ln(activity) + ln(2) * (extract(epoch from evaluated_at)::double precision * 1000) / 1209600000
where activity > 0;

-- squawk-ignore require-concurrent-index-creation
create index topic_context_top_interest
  on evidence.topic_context (universe_id, privacy_epoch, log_weight desc, topic_id)
  where log_weight is not null;

create table evidence.interest_rollups (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  level text not null check (level in ('system', 'person')),
  subject_id text not null check (char_length(subject_id) <= 160),
  channel_values jsonb not null check (jsonb_typeof(channel_values) = 'object' and octet_length(channel_values::text) <= 2048),
  activity double precision not null check (activity >= 0),
  evaluated_at timestamptz not null,
  reel_measured integer not null default 0 check (reel_measured >= 0),
  reel_qualified integer not null default 0 check (reel_qualified between 0 and reel_measured),
  scroll_measured integer not null default 0 check (scroll_measured >= 0),
  scroll_qualified integer not null default 0 check (scroll_qualified between 0 and scroll_measured),
  log_weight double precision,
  primary key (universe_id, level, subject_id),
  check ((level = 'person') = (subject_id = ''))
);

with catalogue(topic_id, system_id) as (
  values
    ('earth', 'earth'), ('earth.greenhouse-effect', 'earth'), ('earth.seasons', 'earth'), ('earth.tides', 'earth'),
    ('space', 'space'), ('space.stars', 'space'), ('space.exoplanets', 'space'), ('space.black-holes', 'space'),
    ('machine-learning', 'machine-learning'), ('machine-learning.attention', 'machine-learning'),
    ('machine-learning.efficiency', 'machine-learning'), ('machine-learning.training', 'machine-learning'),
    ('machine-learning.transformers', 'machine-learning'),
    ('human-body', 'human-body'), ('human-body.heart-and-blood', 'human-body'), ('human-body.immune-system', 'human-body'),
    ('human-body.nervous-system', 'human-body'),
    ('computing', 'computing'), ('computing.algorithms', 'computing'), ('computing.browsers', 'computing'),
    ('computing.web-requests', 'computing'),
    ('history', 'history'), ('history.industrial-revolution', 'history')
),
scaled as (
  select c.universe_id, c.privacy_epoch, m.system_id, c.activity, c.channel_values, c.evaluated_at,
    c.reel_measured, c.reel_qualified, c.scroll_measured, c.scroll_qualified,
    max(c.evaluated_at) over (partition by c.universe_id, c.privacy_epoch) as at,
    power(2::double precision, -(extract(epoch from (max(c.evaluated_at) over (partition by c.universe_id, c.privacy_epoch) - c.evaluated_at))::double precision * 1000) / 1209600000) as factor
  from evidence.topic_context c
  left join catalogue m on m.topic_id = c.topic_id
),
rolled as (
  select universe_id, privacy_epoch, 'person'::text as level, ''::text as subject_id, at,
    sum(activity * factor) as activity,
    jsonb_build_object(
      'q', sum((channel_values ->> 'q')::double precision * factor),
      'L', sum((channel_values ->> 'L')::double precision * factor),
      'B', sum((channel_values ->> 'B')::double precision * factor),
      'S', sum((channel_values ->> 'S')::double precision * factor),
      'H', sum((channel_values ->> 'H')::double precision * factor),
      'R', sum((channel_values ->> 'R')::double precision * factor)) as channel_values,
    sum(reel_measured) as reel_measured, sum(reel_qualified) as reel_qualified,
    sum(scroll_measured) as scroll_measured, sum(scroll_qualified) as scroll_qualified
  from scaled group by universe_id, privacy_epoch, at
  union all
  select universe_id, privacy_epoch, 'system', system_id, at,
    sum(activity * factor),
    jsonb_build_object(
      'q', sum((channel_values ->> 'q')::double precision * factor),
      'L', sum((channel_values ->> 'L')::double precision * factor),
      'B', sum((channel_values ->> 'B')::double precision * factor),
      'S', sum((channel_values ->> 'S')::double precision * factor),
      'H', sum((channel_values ->> 'H')::double precision * factor),
      'R', sum((channel_values ->> 'R')::double precision * factor)),
    sum(reel_measured), sum(reel_qualified), sum(scroll_measured), sum(scroll_qualified)
  from scaled where system_id is not null group by universe_id, privacy_epoch, system_id, at
)
insert into evidence.interest_rollups
  (universe_id, privacy_epoch, level, subject_id, channel_values, activity, evaluated_at,
   reel_measured, reel_qualified, scroll_measured, scroll_qualified, log_weight)
select universe_id, privacy_epoch, level, subject_id, channel_values, activity, at,
  reel_measured, reel_qualified, scroll_measured, scroll_qualified,
  case when activity > 0 then ln(activity) + ln(2) * (extract(epoch from at)::double precision * 1000) / 1209600000 end
from rolled;

-- The pin is widened by name; every existing row names v0, v1 or v2, which the new check also allows.
-- squawk-ignore ban-drop-constraint
alter table composer.decisions drop constraint decisions_policy_version_check;
alter table composer.decisions
  add constraint decisions_policy_version_check
  check (policy_version in ('composer-policy.v0', 'composer-policy.v1', 'composer-policy.v2', 'composer-policy.v3')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table composer.decisions validate constraint decisions_policy_version_check;
