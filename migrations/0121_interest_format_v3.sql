-- #674 (slices 4.2 and 5.2) Composer policy v3 (D-420): long-term interest selects candidates, and format is learned
-- per topic with pooling. Owner: modules/evidence (`encounter_topics.serve_rand` is Content's; the pin of composer.decisions is
-- Composer's).
--
-- Nothing here scans, rewrites or backfills a large table, so no statement holds a long lock and none is near the 60 s timeout:
-- the columns are nullable with no default, the new tables are empty, the triggers fill derived values for every later write, and
-- what already exists is filled lazily by `evidence rebuild-interest-rollups` (run before a world turns v3 on).
--
-- 1. `topic_context.log_weight` = ln(activity) + ln(2) * evaluated_at_ms / half_life_ms, derived by a BEFORE INSERT OR UPDATE
--    trigger, so any writer (an older binary in the deploy window included) leaves it correct. A topic's stored activity decays
--    by the same factor as every other topic's, so ordering by this number is ordering by decayed activity at any later time:
--    "the person's top K topics now" is one range scan of `topic_context_top_interest`, never a read of every topic. It is NULL
--    while activity is 0 (ln 0) and for rows nothing has written since this migration (the rebuild command fills them). The
--    index is partial on `log_weight is not null`, so on the existing rows it starts empty and building it is one cheap scan.
--    The half life is the one `activity.v1` uses (14 days); a change of it is a new migration, because the column holds it.
-- 2. `topic_context.rollup_counted`: exactly what this topic row contributed to the roll-ups below (activity and time, channels,
--    counts), written with the row by the new binary. A roll-up is changed by the difference between what a topic was counted as
--    and what it is now, so it never subtracts what it did not add (an older binary leaves this stale, and the next write by the
--    new binary corrects it; NULL means "not counted yet"). A roll-up that would go negative is rebuilt from the topic rows.
-- 3. `interest_rollups`: one row per system and one for the person, in the shape of `topic_context`, written in the same
--    transaction as the topic rows. They are the priors of v3's interest and format shrinkage, and hold reading only (a qualified
--    response is q >= 0.6), never a pick, a result, a spark or a tier (D-063). Empty at creation; `evidence
--    rebuild-interest-rollups` (idempotent, one personal scope per person, bounded memory) builds them from the topic rows.
-- 4. `content.encounter_topics.serve_rand`: a stable random key per topic attribution, set by a trigger on insert, with the index
--    `(topic_id, serve_rand)`. The `continue` lane reads a capped window of each of the person's top topics in that order, so its
--    cost is the window and not every asset of the topics. The rows that exist are given a key here: the table has one row per
--    topic attribution of an admitted revision (at most 16 per revision), shared library metadata and small, and the statement
--    takes row locks only.
-- 5. The pin of `composer.decisions` also allows `composer-policy.v3`. The constraint is added NOT VALID and not validated: every
--    existing row names v0 to v2, which it allows, and a validation would scan the table. It is enforced for every new row.
--
-- Query shapes: top K = `where universe_id, privacy_epoch and log_weight is not null [and log_weight >= floor] order by
-- log_weight desc, topic_id limit K` (index above, no sort); rollups = primary key probe by (universe, level, subject) for the
-- systems of the candidates and the person; a topic's window = `where topic_id = $ and serve_rand >= $cursor order by serve_rand
-- limit W` and its wrap-round twin. Growth: one row per system a person has touched plus one; one key per topic attribution.
-- Retention and erasure: those of `topic_context` (retained personal evidence; Clear and account deletion delete the rows by
-- universe, before the universe); `serve_rand` is shared and not personal.
-- Lock order: unchanged, written under the personal root with the rest of the projection.
-- Rollout: additive. An older writer leaves `rollup_counted` and the roll-ups alone (the trigger still derives `log_weight`), so
-- roll-ups lag until the new binary writes the topic again or the rebuild runs. v3 is off unless `KS_COMPOSER_POLICY=v3`; run the
-- rebuild first (docs/v2/operations/environments.md, "Switching Composer policy v3 on").
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table evidence.topic_context add column log_weight double precision;
alter table evidence.topic_context add column rollup_counted jsonb;

create function evidence.derive_log_weight() returns trigger language plpgsql as $$
begin
  new.log_weight := case when new.activity > 0
    then ln(new.activity) + ln(2) * (extract(epoch from new.evaluated_at)::double precision * 1000) / 1209600000 end;
  return new;
end $$;
create trigger topic_context_log_weight before insert or update on evidence.topic_context
  for each row execute function evidence.derive_log_weight();

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
create trigger interest_rollups_log_weight before insert or update on evidence.interest_rollups
  for each row execute function evidence.derive_log_weight();

alter table content.encounter_topics add column serve_rand double precision;
create function content.derive_topic_serve_rand() returns trigger language plpgsql as $$
begin
  if new.serve_rand is null then new.serve_rand := random(); end if;
  return new;
end $$;
create trigger encounter_topics_serve_rand before insert on content.encounter_topics
  for each row execute function content.derive_topic_serve_rand();
update content.encounter_topics set serve_rand = random() where serve_rand is null;
-- squawk-ignore require-concurrent-index-creation
create index encounter_topics_rand_idx on content.encounter_topics (topic_id, serve_rand, asset_id, asset_revision)
  where serve_rand is not null;

-- The pin is widened by name; every existing row names v0, v1 or v2, which the new check also allows. Not validated: see above.
-- squawk-ignore ban-drop-constraint
alter table composer.decisions drop constraint decisions_policy_version_check;
alter table composer.decisions
  add constraint decisions_policy_version_check
  check (policy_version in ('composer-policy.v0', 'composer-policy.v1', 'composer-policy.v2', 'composer-policy.v3')) not valid;
