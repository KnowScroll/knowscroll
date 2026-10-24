-- 0057_ops_views: allowlisted operator views over the ledgers (#248, D-044, blueprint §26).
--
-- Owner: ops (the operator module). Views only: no table, no data, nothing to erase. Every view reads
--   live rows of the module that owns them, so a row that is cleared or erased is gone from the view.
-- Allowlist: a view lists the columns it shows by name and never uses `select *`. It shows IDs, states,
--   times, counts and codes. It never shows a prompt, a model answer, a request body, a script, a
--   brief, a message, an address or a provider payload. Free-text columns that are really codes pass
--   through `ops.safe_code`, which drops anything that is not code-shaped.
-- Who reads: the operator module through the application role (operator API and `operator.js journey`),
--   and `ks2_ops_reader` (a SELECT-only role for Grafana or psql) on every view except
--   `ops.journey_events`, which carries scoped IDs. The grants are made by `migrate.js`
--   (`grantOpsReader`), after the role exists, every time it runs.
-- Not here: `ops.jobs`, `ops.queue_backlog` and `ops.recent_errors` read pg-boss's tables, which pg-boss
--   installs after the SQL migrations and may alter when it upgrades. `migrate.js` drops and recreates
--   them around its own start (`infrastructure/postgres/ops-job-views.ts`).
-- Dependencies: PostgreSQL refuses to drop or retype a column a view reads. A later migration that
--   changes one of these columns drops and recreates the view in the same file.
-- Rollout: additive; no older process reads the views.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function ops.safe_code(value text) returns text
language sql immutable parallel safe
as $$ select case when value ~ '^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,79}$' then value end $$;

comment on function ops.safe_code(text) is
  'The value when it is code-shaped (letters, digits and . _ : @ + / -, at most 80), otherwise null.';

create view ops.business_runs as
select
  id as run_id,
  ops.safe_code(owner_module) as owner_module,
  ops.safe_code(purpose) as purpose,
  ops.safe_code(role_id) as role_id,
  ops.safe_code(role_version) as role_version,
  ops.safe_code(policy_version) as policy_version,
  ops.safe_code(provider) as provider,
  ops.safe_code(model) as model,
  state,
  created_at,
  updated_at,
  closed_at,
  (privacy_erased_at is not null) as redacted
from reasoning.business_runs;

comment on view ops.business_runs is 'Personal reasoning runs: what ran, its state and times. No person, no context, no text.';

create view ops.model_attempts as
select
  'personal'::text as scope_kind,
  id as attempt_id,
  run_id,
  ops.safe_code(step) as step,
  ops.safe_code(role_id) as role_id,
  ops.safe_code(role_version) as role_version,
  ops.safe_code(provider) as provider,
  ops.safe_code(model) as model,
  ops.safe_code(prompt_version) as prompt_version,
  state,
  ops.safe_code(outcome_code) as outcome_code,
  reserved_tokens,
  input_tokens,
  output_tokens,
  cached_tokens,
  reasoning_tokens,
  request_bytes,
  reserved_at,
  dispatched_at,
  settled_at,
  written_off_at,
  (privacy_erased_at is not null) as redacted
from reasoning.external_attempts
union all
select
  'production'::text,
  id,
  run_id,
  ops.safe_code(step),
  ops.safe_code(role_id),
  ops.safe_code(role_version),
  ops.safe_code(provider),
  ops.safe_code(model),
  ops.safe_code(prompt_version),
  state,
  ops.safe_code(outcome_code),
  reserved_tokens,
  input_tokens,
  output_tokens,
  cached_tokens,
  reasoning_tokens,
  request_bytes,
  reserved_at,
  dispatched_at,
  settled_at,
  written_off_at,
  false
from reasoning.production_attempts;

comment on view ops.model_attempts is
  'Every model call the ledger recorded, personal and production: state, outcome code and tokens. A null token count is unknown, not zero. No request, no answer, no provider payload.';

create view ops.production_runs as
select
  run.id as production_run_id,
  run.topic as recipe_key,
  ops.safe_code(run.policy_version) as policy_version,
  run.take,
  run.state,
  run.target_revision,
  run.asset_id,
  run.asset_revision,
  run.writer_run_id,
  writer.state as writer_run_state,
  (select count(*) from reasoning.production_attempts as attempt where attempt.run_id = run.writer_run_id) as model_attempts,
  (
    select count(*)
    from reasoning.production_rejected_answers as refused
    join reasoning.production_attempts as attempt on attempt.scope_id = refused.scope_id and attempt.id = refused.attempt_id
    where attempt.run_id = run.writer_run_id
  ) as refused_answers,
  run.created_at,
  run.completed_at
from content.scroll_production_runs as run
left join reasoning.production_runs as writer on writer.id = run.writer_run_id;

comment on view ops.production_runs is
  'Scroll production jobs: recipe, take, state, the writer run behind it and how many answers were refused. No research, claims or writer output.';

create view ops.rejected_answers as
select
  refused.attempt_id,
  attempt.run_id,
  ops.safe_code(attempt.step) as step,
  ops.safe_code(attempt.model) as model,
  ops.safe_code(refused.reason) as reason,
  refused.answer_kind,
  refused.answer_chars,
  refused.truncated,
  jsonb_array_length(refused.issues) as issue_count,
  coalesce(
    (
      select array_agg(distinct ops.safe_code(issue ->> 'code') order by ops.safe_code(issue ->> 'code'))
      from jsonb_array_elements(refused.issues) as issue
      where ops.safe_code(issue ->> 'code') is not null
    ),
    '{}'::text[]
  ) as issue_codes,
  refused.recorded_at,
  refused.expires_at
from reasoning.production_rejected_answers as refused
join reasoning.production_attempts as attempt on attempt.scope_id = refused.scope_id and attempt.id = refused.attempt_id;

comment on view ops.rejected_answers is
  'Writer answers the validator refused: the verdict, the codes of its findings and the size. Never the answer text.';

create view ops.reel_attempts as
select
  attempt.id as attempt_id,
  attempt.order_id,
  attempt.take,
  attempt.paid,
  attempt.state,
  ops.safe_code(attempt.outcome_code) as outcome_code,
  attempt.pool_state,
  attempt.ceiling_cents,
  attempt.estimate_cents,
  attempt.remote_cost_cents,
  attempt.remote_outcome,
  attempt.reserved_at,
  attempt.dispatched_at,
  attempt.finished_at,
  attempt.settled_at
from content.reel_attempts as attempt;

comment on view ops.reel_attempts is
  'Cutroom order attempts: state, outcome, the pool claim and the cents. No request body, run id, note or remote detail.';

create view ops.reel_orders as
select
  reel_order.id as reel_order_id,
  reel_order.script_name,
  ops.safe_code(reel_order.recipe_key) as recipe_key,
  reel_order.until,
  reel_order.asset_id,
  reel_order.created_at,
  reel_order.published_at,
  (select count(*) from content.reel_attempts as attempt where attempt.order_id = reel_order.id) as attempts,
  coalesce(
    (select sum(attempt.remote_cost_cents) from content.reel_attempts as attempt
      where attempt.order_id = reel_order.id and attempt.pool_state = 'settled'),
    0
  ) as settled_cents,
  coalesce(
    (select sum(attempt.ceiling_cents) from content.reel_attempts as attempt
      where attempt.order_id = reel_order.id and attempt.pool_state = 'claimed'),
    0
  ) as claimed_open_cents,
  (select attempt.state from content.reel_attempts as attempt
    where attempt.order_id = reel_order.id order by attempt.take desc limit 1) as latest_attempt_state
from content.reel_orders as reel_order;

comment on view ops.reel_orders is
  'Reel orders with the cents settled and the cents still claimed. No script, approval text or hash.';

create view ops.geography_runs as
select
  id as run_id,
  status,
  ops.safe_code(outcome) as outcome,
  desired_revision,
  created_at,
  updated_at
from geography.runs;

comment on view ops.geography_runs is 'Cartographer runs: state, outcome code and times. No person, context or proposal.';

create view ops.privacy_operations as
select
  'clear'::text as kind,
  id as operation_id,
  phase as state,
  ops.safe_code(failure_code) as failure_code,
  recovery_attempts + cleanup_recovery_attempts as attempts,
  recorded_at as requested_at,
  completed_at
from identity.clear_operations
union all
select
  'account_deletion'::text,
  id,
  state,
  ops.safe_code(failure_code),
  attempts,
  requested_at,
  completed_at
from identity.account_deletions
union all
select
  'data_export'::text,
  id,
  state,
  null::text,
  null::integer,
  requested_at,
  ready_at
from identity.data_exports;

comment on view ops.privacy_operations is
  'Clear, account deletion and export operations: state, failure code, attempts and times. No account, universe or file.';

-- One row per recorded step of a journey, across modules, with the keys that join them. This is the
-- one view that carries scoped IDs (`universe_id` and the personal records' IDs); it answers only
-- authenticated operator queries and is not granted to `ks2_ops_reader`. `label` and `code` pass
-- through `ops.safe_code`; `state` is a fixed vocabulary of its table.
create view ops.journey_events as
  select
    'supply.request' as stage,
    r.created_at as started_at,
    case when r.state in ('ready','unavailable','cancelled') then r.updated_at end as ended_at,
    r.state as state,
    ops.safe_code(coalesce(r.reason, r.decision)) as code,
    null::text as label,
    null::bigint as count,
    r.universe_id as universe_id,
    r.id as request_id,
    r.work_id as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    r.id as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    r.id as subject_id
  from supply.requests as r
  union all
  select
    'supply.group' as stage,
    w.created_at as started_at,
    w.closed_at as ended_at,
    case when w.active then 'active' else 'closed' end as state,
    null::text as code,
    ops.safe_code(w.commissioned_by) as label,
    null::bigint as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    w.id as work_id,
    ops.safe_code(w.production_recipe) as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    w.id as subject_id
  from supply.work as w
  union all
  select
    'content.production_run' as stage,
    p.created_at as started_at,
    p.completed_at as ended_at,
    p.state as state,
    null::text as code,
    ops.safe_code(p.policy_version) as label,
    p.take as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    ops.safe_code(p.topic) as recipe_key,
    p.id as production_run_id,
    p.writer_run_id as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    p.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    p.id as subject_id
  from content.scroll_production_runs as p
  union all
  select
    'reasoning.production_run' as stage,
    pr.created_at as started_at,
    pr.closed_at as ended_at,
    pr.state as state,
    null::text as code,
    ops.safe_code(pr.purpose) as label,
    null::bigint as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    pr.id as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    pr.id as subject_id
  from reasoning.production_runs as pr
  union all
  select
    'reasoning.production_attempt' as stage,
    pa.reserved_at as started_at,
    coalesce(pa.settled_at, pa.written_off_at) as ended_at,
    pa.state as state,
    ops.safe_code(pa.outcome_code) as code,
    ops.safe_code(pa.step) as label,
    null::bigint as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    pa.run_id as reasoning_run_id,
    pa.id as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    pa.id as subject_id
  from reasoning.production_attempts as pa
  union all
  select
    'reasoning.refused_answer' as stage,
    ra.recorded_at as started_at,
    null::timestamptz as ended_at,
    null::text as state,
    ops.safe_code(ra.reason) as code,
    ops.safe_code(ra.answer_kind) as label,
    jsonb_array_length(ra.issues) as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    pa.run_id as reasoning_run_id,
    ra.attempt_id as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    ra.attempt_id as subject_id
  from reasoning.production_rejected_answers as ra join reasoning.production_attempts as pa on pa.scope_id = ra.scope_id and pa.id = ra.attempt_id
  union all
  select
    'content.asset_admitted' as stage,
    ar.admitted_at as started_at,
    null::timestamptz as ended_at,
    a.kind as state,
    null::text as code,
    ops.safe_code(ar.provenance_kind) as label,
    ar.revision as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    ar.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    ar.asset_id as subject_id
  from content.asset_revisions as ar join content.assets as a on a.id = ar.asset_id
  union all
  select
    'content.reel_order' as stage,
    o.created_at as started_at,
    o.published_at as ended_at,
    case when o.published_at is null then 'ordered' else 'published' end as state,
    null::text as code,
    ops.safe_code(o.script_name) as label,
    null::bigint as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    ops.safe_code(o.recipe_key) as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    o.asset_id as asset_id,
    o.id as reel_order_id,
    null::uuid as command_id,
    o.id as subject_id
  from content.reel_orders as o
  union all
  select
    'content.reel_attempt' as stage,
    ta.reserved_at as started_at,
    ta.finished_at as ended_at,
    ta.state as state,
    ops.safe_code(ta.outcome_code) as code,
    ops.safe_code(ta.pool_state) as label,
    ta.take as count,
    null::uuid as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    ta.id as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    ta.order_id as reel_order_id,
    null::uuid as command_id,
    ta.id as subject_id
  from content.reel_attempts as ta
  union all
  select
    'reasoning.run' as stage,
    br.created_at as started_at,
    br.closed_at as ended_at,
    br.state as state,
    null::text as code,
    ops.safe_code(br.purpose) as label,
    null::bigint as count,
    br.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    br.id as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    br.id as subject_id
  from reasoning.business_runs as br
  union all
  select
    'reasoning.attempt' as stage,
    ea.reserved_at as started_at,
    coalesce(ea.settled_at, ea.written_off_at) as ended_at,
    ea.state as state,
    ops.safe_code(ea.outcome_code) as code,
    ops.safe_code(ea.step) as label,
    null::bigint as count,
    ea.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    ea.run_id as reasoning_run_id,
    ea.id as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    ea.id as subject_id
  from reasoning.external_attempts as ea
  union all
  select
    'experience.exposure_opened' as stage,
    e.opened_at as started_at,
    null::timestamptz as ended_at,
    e.kind as state,
    null::text as code,
    ops.safe_code(e.origin) as label,
    null::bigint as count,
    e.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    e.id as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    e.asset_id as asset_id,
    null::uuid as reel_order_id,
    e.command_id as command_id,
    e.id as subject_id
  from experience.exposures as e
  union all
  select
    'experience.exposure_activated' as stage,
    e.activated_at as started_at,
    null::timestamptz as ended_at,
    e.kind as state,
    null::text as code,
    null::text as label,
    null::bigint as count,
    e.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    e.id as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    e.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    e.id as subject_id
  from experience.exposures as e
  where e.activated_at is not null
  union all
  select
    'experience.offer' as stage,
    f.created_at as started_at,
    null::timestamptz as ended_at,
    f.mode as state,
    null::text as code,
    ops.safe_code(f.policy_version) as label,
    null::bigint as count,
    f.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    f.source_exposure_id as exposure_id,
    f.id as offer_id,
    f.decision_id as decision_id,
    f.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    f.id as subject_id
  from experience.offers as f
  union all
  select
    'experience.offer_activated' as stage,
    f.created_at as started_at,
    null::timestamptz as ended_at,
    null::text as state,
    null::text as code,
    null::text as label,
    null::bigint as count,
    oa.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    oa.exposure_id as exposure_id,
    oa.offer_id as offer_id,
    f.decision_id as decision_id,
    f.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    oa.offer_id as subject_id
  from experience.offer_activations as oa join experience.offers as f on f.universe_id = oa.universe_id and f.id = oa.offer_id
  union all
  select
    'composer.decision' as stage,
    d.recorded_at as started_at,
    null::timestamptz as ended_at,
    null::text as state,
    null::text as code,
    ops.safe_code(d.policy_version) as label,
    null::bigint as count,
    d.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    d.id as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    d.command_id as command_id,
    d.id as subject_id
  from composer.decisions as d
  union all
  select
    'experience.action' as stage,
    x.created_at as started_at,
    null::timestamptz as ended_at,
    x.kind as state,
    null::text as code,
    null::text as label,
    null::bigint as count,
    x.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    x.asset_id as asset_id,
    null::uuid as reel_order_id,
    x.command_id as command_id,
    x.id as subject_id
  from experience.actions as x
  union all
  select
    'evidence.observations' as stage,
    o.first_at as started_at,
    o.last_at as ended_at,
    null::text as state,
    null::text as code,
    null::text as label,
    o.total as count,
    o.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    o.exposure_id as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    null::uuid as subject_id
  from (select universe_id, exposure_id, min(received_at) as first_at, max(received_at) as last_at, count(*) as total from evidence.observations group by universe_id, exposure_id) as o
  union all
  select
    'evidence.encounter_evidence' as stage,
    ev.created_at as started_at,
    null::timestamptz as ended_at,
    ops.safe_code(ev.qualification) as state,
    null::text as code,
    ops.safe_code(ev.policy_version) as label,
    ev.revision as count,
    ev.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    ev.exposure_id as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    ev.asset_id as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    ev.id as subject_id
  from evidence.encounter_evidence as ev
  union all
  select
    'receipt.command' as stage,
    c.created_at as started_at,
    null::timestamptz as ended_at,
    null::text as state,
    null::text as code,
    ops.safe_code(c.operation) as label,
    null::bigint as count,
    c.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    c.command_id as command_id,
    null::uuid as subject_id
  from receipts.personal_commands as c
  union all
  select
    'geography.run' as stage,
    g.created_at as started_at,
    case when g.status in ('accepted','stale','rejected','insufficient') then g.updated_at end as ended_at,
    ops.safe_code(g.status) as state,
    ops.safe_code(g.outcome) as code,
    null::text as label,
    g.desired_revision as count,
    g.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    g.id as subject_id
  from geography.runs as g
  union all
  select
    'planner.run' as stage,
    q.created_at as started_at,
    case when q.status in ('accepted','stale','rejected','insufficient') then q.updated_at end as ended_at,
    ops.safe_code(q.status) as state,
    ops.safe_code(q.outcome) as code,
    null::text as label,
    q.revision as count,
    q.universe_id as universe_id,
    null::uuid as request_id,
    null::uuid as work_id,
    null::text as recipe_key,
    null::uuid as production_run_id,
    null::uuid as reasoning_run_id,
    null::uuid as attempt_id,
    null::uuid as exposure_id,
    null::uuid as offer_id,
    null::uuid as decision_id,
    null::uuid as asset_id,
    null::uuid as reel_order_id,
    null::uuid as command_id,
    q.id as subject_id
  from planner.runs as q;


comment on view ops.journey_events is
  'Journey steps across modules (supply, production, reasoning, experience, evidence, geography, planner) keyed by request, group, production run, attempt, exposure, offer, decision, asset, Reel order and command.';
