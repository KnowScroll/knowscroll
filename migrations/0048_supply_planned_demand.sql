-- Planner-originated demand beside deliberate person requests (#236, blueprint §10 and §11).
-- Owner: modules/supply. Adds who asked (origin), the Planner run and opportunity slot that asked,
-- and the `deferred` state: demand with no admitted content that waits on a shared matching group
-- until a production path (Create) exists. A planned demand is a private waiter like any other, so
-- it is erased with the person's exploration; shared supply.work rows stay public and brief-only.
-- Queries: unchanged (owner/epoch index). Two unique indexes: a plan opportunity is one demand, and a
-- person has at most one open (deferred) planned waiter per shared matching group, however many plan
-- revisions ask for the same thing.
-- Growth: at most three planned demands per accepted Planner revision, and one per brief while open. Additive for older readers:
-- the new columns default to a person request, and old processes never write `deferred`.
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table supply.requests add column origin text not null default 'person';
alter table supply.requests add column planner_run_id uuid;
alter table supply.requests add column planner_slot integer;
alter table supply.requests add constraint supply_requests_origin check(origin in('person','planner')) not valid;
alter table supply.requests add constraint supply_requests_planner_shape
 check((origin='planner')=(planner_run_id is not null and planner_slot is not null)) not valid;
-- squawk-ignore ban-drop-constraint
alter table supply.requests drop constraint requests_state_check;
alter table supply.requests add constraint requests_state_check
 check(state in('requested','ready','unavailable','cancelled','deferred')) not valid;
alter table supply.requests add constraint supply_requests_deferred_shape
 check(state<>'deferred' or (origin='planner' and work_id is not null and brief is not null)) not valid;
-- squawk-ignore require-concurrent-index-creation
create unique index supply_requests_planner_slot
 on supply.requests(universe_id,privacy_epoch,planner_run_id,planner_slot) where planner_run_id is not null;
-- squawk-ignore require-concurrent-index-creation
create unique index supply_requests_planner_open_work
 on supply.requests(universe_id,privacy_epoch,work_id)
 where origin='planner' and state in('deferred','ready');
