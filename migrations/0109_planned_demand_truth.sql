-- #674 (1.3) Supply tells the truth about the Planner's demand: every outcome is counted, the model's intent is kept on the
-- person's own demand row, and a refusal says what it is.
--
-- Owner: supply (`supply.planned_demand_outcomes`, the two columns and the check below on `supply.requests`); the operator
-- module reads the counters through `ops.planned_demand_outcomes`.
--
-- 1. `supply.planned_demand_outcomes`: counters of what became of each missing-supply opportunity of an accepted plan
--    (reused, already recorded, commissioned, joined, not commissioned with the reason, unsupported with the reason, and
--    expired when a lost waiter was closed). Authoritative. One row per UTC day, outcome and reason; the code adds to the row
--    in the transaction that accepts the plan, locking the rows in a fixed order (outcome, then reason), last.
--    Query shapes: the operator panel's last seven days; `ops.planned_demand_outcomes` for Grafana or psql.
--    Index: the primary key (day first).
--    Access: names no person, no topic and no words, so it survives Clear and account deletion like the other ledgers
--    (`supply.ask_orders`, `supply.scenario_orders`) and is not in the erasure registry.
--    Growth: at most twelve rows a day (one per code pair), about four thousand a year; nothing to purge.
--    Check: the pair (outcome, reason) is one of a closed set, so a typo cannot create a phantom code.
-- 2. `supply.requests.planned_intent`: what the model wanted of the opportunity (move, explanation unit, brief), on the
--    person's own planned demand only. Private model text about the person: erased with the request (Clear and account
--    deletion), never copied to `supply.work`, never in a canonical brief, never read by another person or module,
--    never evidence. Bounded to 4096 bytes. Null for every row that exists today and for every request of a person.
--    Growth: none beyond the rows that exist; at most three planned demands per accepted plan.
-- 3. `supply.requests.reason` gains `no_production_path` (a Reel or a variant was asked for; nothing can make it) and
--    `no_recipe_left` (every recipe that could serve the brief is made or cannot be taken again). Until now the first was
--    stored as `budget_unavailable` and the second as `could_not_prepare`, so neither said what it was.
--
-- Locking: unchanged. Rollout: additive. An older process neither reads nor writes the new column, table and view, and
-- never writes the two new reasons. A client older than this build cannot read a request closed with one of them, so the
-- contract and the client copy ship in the same release.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table supply.planned_demand_outcomes (
  day date not null,
  outcome text not null,
  reason text not null default '',
  total bigint not null check (total between 1 and 9007199254740991),
  primary key (day, outcome, reason),
  constraint planned_demand_outcomes_codes check (
    (outcome in ('reused', 'commissioned', 'joined') and reason = '')
    or (outcome = 'already_recorded' and reason in ('waiting', 'reusable'))
    or (outcome = 'not_commissioned' and reason in ('no_production_path', 'cap_reached', 'create_off', 'no_recipe_left'))
    or (outcome = 'unsupported' and reason in ('topic_not_in_catalogue', 'language_not_supported'))
    or (outcome = 'expired' and reason = 'no_resolver')
  )
);

create view ops.planned_demand_outcomes as
select
  day,
  outcome,
  ops.safe_code(nullif(reason, '')) as reason,
  total
from supply.planned_demand_outcomes;

comment on view ops.planned_demand_outcomes is
  'What became of the Planner''s missing-supply opportunities, counted per UTC day, outcome and reason. Counts only: no person, no topic, no words.';

alter table supply.requests add column planned_intent jsonb;
alter table supply.requests add constraint supply_requests_planned_intent
  check (
    planned_intent is null
    or (origin = 'planner' and jsonb_typeof(planned_intent) = 'object' and octet_length(planned_intent::text) <= 4096)
  ) not valid;
-- The column is null for every existing row, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table supply.requests validate constraint supply_requests_planned_intent;

-- squawk-ignore ban-drop-constraint
alter table supply.requests drop constraint requests_reason_check;
alter table supply.requests add constraint requests_reason_check
  check (reason in (
    'unsupported_request', 'no_compatible_supply', 'not_permitted', 'budget_unavailable', 'could_not_prepare',
    'source_unavailable', 'no_production_path', 'no_recipe_left'
  )) not valid;
-- Every existing row holds one of the earlier six reasons, so the wider check holds.
-- squawk-ignore constraint-missing-not-valid
alter table supply.requests validate constraint requests_reason_check;
