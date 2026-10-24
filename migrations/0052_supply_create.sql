-- Quartermaster Create and bounded production takes (#239, D-037). Owner: modules/supply, and
-- content/production for the take column at the end.
-- supply.work gains the library recipe whose production job the group commissioned, set when Create
-- starts the group and never changed. A group without one commissioned nothing: it was created before
-- Create existed, or it only waits on work that someone else started. Public metadata like the rest of
-- the row: a recipe key names code-owned data and carries no person. `commissioned_by` says whether a
-- person's ask or the Planner's demand started it, so each origin has its own daily cap.
-- Queries: the day's Create count (`production_recipe is not null`, newest `created_at`), served by a
-- partial index. Growth: at most KS_SUPPLY_CREATE_DAILY_CAP rows a day carry a recipe.
-- supply.requests gains `matching`: a person's free-text ask that waits for its catalogue match. It has
-- no brief and no group yet, and its decision is `pending`. The match, a worker step, fills both.
-- Retention, erasure and lock order are unchanged: private rows stay erased with the person, shared
-- work stays public and brief-only. Rollout: additive. Older writers never write `matching` or a recipe,
-- and older readers see a recipe-less group exactly as before. The new checks are NOT VALID: they bind
-- every new write without scanning history.
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table supply.work add column production_recipe text;
alter table supply.work add column commissioned_by text;
alter table supply.work add constraint supply_work_commissioned_by
 check(commissioned_by is null or commissioned_by in('person','planner')) not valid;
alter table supply.work add constraint supply_work_production_recipe
 check(production_recipe is null or (production_recipe ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(production_recipe)<=64)) not valid;
-- squawk-ignore require-concurrent-index-creation
create index supply_work_production_started on supply.work(created_at) where production_recipe is not null;

-- squawk-ignore ban-drop-constraint
alter table supply.requests drop constraint requests_state_check;
alter table supply.requests add constraint requests_state_check
 check(state in('requested','ready','unavailable','cancelled','deferred','matching')) not valid;
-- squawk-ignore ban-drop-constraint
alter table supply.requests drop constraint requests_decision_check;
alter table supply.requests add constraint requests_decision_check
 check(decision in('reuse','join','create','refuse','pending')) not valid;
alter table supply.requests add constraint supply_requests_matching_shape
 check(state<>'matching' or (origin='person' and decision='pending' and work_id is null and brief is null)) not valid;

-- content.scroll_production_runs (owner: content/production): a recipe's job at one recipe version may
-- be taken again after it was rejected. The job's identity is (topic, policy_version, take), the take
-- is 1 to 3, and each take is its own business run with its own writer run and attempts. The rule
-- that a take starts only after every earlier take was rejected is code, checked under the job row
-- lock; SQL bounds the number and keeps one row per take. Existing jobs are take 1.
-- Queries: unchanged (unique key now also names the take; UUID primary key). Growth: at most three
-- rows per recipe and version. Retention, erasure and lock order: unchanged (nonpersonal, retained).
-- Rollout: additive for older writers, which write only take 1 and use the default.
alter table content.scroll_production_runs add column take integer not null default 1;
alter table content.scroll_production_runs add constraint scroll_production_runs_take_check
 check(take between 1 and 3) not valid;
-- squawk-ignore ban-drop-constraint
alter table content.scroll_production_runs drop constraint scroll_production_runs_topic_policy_version_key;
-- The table holds at most three rows per recipe and version, so the unique key's build is instant.
-- squawk-ignore disallowed-unique-constraint, constraint-missing-not-valid
alter table content.scroll_production_runs add constraint scroll_production_runs_topic_version_take_key
 unique(topic,policy_version,take);
