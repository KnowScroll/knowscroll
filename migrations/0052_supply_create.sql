-- Quartermaster Create (#239, D-037). Owner: modules/supply.
-- supply.work gains the library recipe whose production job the group commissioned, set when Create
-- starts the group and never changed. A group without one commissioned nothing: it was created before
-- Create existed, or it only waits on work that someone else started. Public metadata like the rest of
-- the row: a recipe key names code-owned data and carries no person.
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
