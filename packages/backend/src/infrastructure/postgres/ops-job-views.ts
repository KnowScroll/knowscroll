import { sql, type Kysely } from 'kysely';

/**
 * The `ops` views that read pg-boss's tables (and the `ops.watchdog` view that reads them with other sources), and the
 * grants of the read-only operator role.
 *
 * pg-boss installs its schema after the SQL migrations and changes it when it upgrades. A view
 * that reads a table blocks PostgreSQL from dropping or retyping that table's columns, so these
 * views are not migrations: `migrate.js` drops them before it runs anything, creates them after
 * pg-boss has installed its schema and grants them again. The other `ops` views are in migration
 * 0057 (`migrations/0057_ops_views.sql`, which states the allowlist rule for all of them).
 *
 * The views list columns by name and show IDs, states, times, counts and codes. A job's payload
 * (`data`) is never read; its output is read only for the code-only failure record D-017 allows,
 * and only when it is code-shaped.
 */

/** The SELECT-only role Grafana or psql connects through. Created once per cluster by the owner. */
export const OPS_READER_ROLE = 'ks2_ops_reader';

/** Every `ops` view the reader role may select. `ops.journey_events` carries scoped IDs and is not here. */
export const OPS_READER_VIEWS: readonly string[] = [
  'business_runs',
  'model_attempts',
  'production_runs',
  'rejected_answers',
  'reel_attempts',
  'reel_orders',
  'geography_runs',
  'privacy_operations',
  'feedback_reports',
  'room_turns',
  'room_faces',
  'planned_demand_outcomes',
  'supply_gaps',
  'jobs',
  'queue_backlog',
  'recent_errors',
  'watchdog',
];

const JOB_VIEWS_IN_DROP_ORDER = ['watchdog', 'recent_errors', 'queue_backlog', 'jobs'] as const;

export interface DropOptions {
  /** How long one attempt waits for the exclusive lock a drop needs. Default 3 s. */
  readonly lockTimeoutMs?: number;
  /** How many attempts before the drop fails. Default 8. */
  readonly attempts?: number;
}

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Drops the pg-boss views (and `recent_errors` and `watchdog`, which read them). Nothing to do when they are absent.
 * A drop waits for every running query on the views, so each attempt waits only `lockTimeoutMs` and the
 * drop is tried again; a reader that never lets go fails the deploy within seconds instead of stalling it.
 * (The reader role carries its own statement timeout, which ends such a query: see the runbook.)
 */
export async function dropOpsJobViews<DB>(db: Kysely<DB>, options: DropOptions = {}): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
  const attempts = options.attempts ?? 8;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.transaction().execute(async (trx) => {
        await sql`select set_config('lock_timeout', ${`${String(lockTimeoutMs)}ms`}, true)`.execute(trx);
        for (const view of JOB_VIEWS_IN_DROP_ORDER)
          await sql`drop view if exists ${sql.table(`ops.${view}`)}`.execute(trx);
      });
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== LOCK_NOT_AVAILABLE || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * Creates `ops.jobs`, `ops.queue_backlog`, `ops.recent_errors` and `ops.watchdog`. Needs pg-boss's schema and
 * migration 0057's views. Run after {@link dropOpsJobViews} and pg-boss's own start.
 */
export async function createOpsJobViews<DB>(db: Kysely<DB>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`
      create view ops.jobs as
      select
        job.id as job_id,
        job.name as queue,
        job.state::text as state,
        job.priority,
        job.retry_count,
        job.retry_limit,
        job.created_on as created_at,
        job.start_after,
        job.started_on as started_at,
        job.completed_on as completed_at,
        job.keep_until,
        job.dead_letter as dead_letter_queue,
        ops.safe_code(job.output ->> 'failure') as failure,
        ops.safe_code(job.output ->> 'errorClass') as failure_class,
        ops.safe_code(job.output ->> 'code') as failure_code,
        case
          when job.state in ('created', 'retry') and job.start_after <= now()
            then floor(extract(epoch from now() - job.start_after))::bigint
        end as waiting_seconds
      from pgboss.job as job`.execute(trx);
    await sql`
      comment on view ops.jobs is
        'pg-boss jobs: queue, state, retries, times, age and the code-only failure record. Never the payload.'`.execute(
      trx,
    );
    await sql`
      create view ops.queue_backlog as
      select
        job.name as queue,
        count(*) filter (where job.state = 'created' and job.start_after <= now()) as ready,
        count(*) filter (where job.state = 'created' and job.start_after > now()) as scheduled,
        count(*) filter (where job.state = 'retry') as retrying,
        count(*) filter (where job.state = 'active') as active,
        count(*) filter (where job.state = 'failed') as failed,
        floor(extract(epoch from now() - min(job.start_after)
          filter (where job.state in ('created', 'retry') and job.start_after <= now())))::bigint as oldest_waiting_seconds,
        max(job.completed_on) filter (where job.state = 'completed') as last_completed_at
      from pgboss.job as job
      group by job.name`.execute(trx);
    await sql`
      comment on view ops.queue_backlog is
        'Per queue: jobs ready, scheduled, retrying, active and failed (within pg-boss retention), the oldest wait and the last completion.'`.execute(
      trx,
    );
    await sql`
      create view ops.recent_errors as
      select occurred_at, source, ref_id, state, code, label
      from (
        select
          coalesce(job.completed_on, job.started_on, job.created_on) as occurred_at,
          'job'::text as source,
          job.id as ref_id,
          job.state::text as state,
          ops.safe_code(job.output ->> 'code') as code,
          job.name as label
        from pgboss.job as job
        where job.state = 'failed'
        union all
        select coalesce(attempt.settled_at, attempt.written_off_at, attempt.dispatched_at, attempt.reserved_at),
          'model_attempt', attempt.attempt_id, attempt.state, attempt.outcome_code, attempt.step
        from ops.model_attempts as attempt
        where attempt.state in ('failed', 'unknown', 'written_off')
        union all
        select coalesce(run.completed_at, run.created_at),
          'production_run', run.production_run_id, run.state, null, run.recipe_key
        from ops.production_runs as run
        where run.state in ('rejected', 'unknown')
        union all
        select refused.recorded_at, 'refused_answer', refused.attempt_id, 'refused', refused.reason, refused.step
        from ops.rejected_answers as refused
        union all
        select coalesce(attempt.finished_at, attempt.dispatched_at, attempt.reserved_at),
          'reel_attempt', attempt.attempt_id, attempt.state, attempt.outcome_code, attempt.pool_state
        from ops.reel_attempts as attempt
        where attempt.state in ('failed', 'unknown', 'written_off')
        union all
        select operation.requested_at, 'privacy_operation', operation.operation_id, operation.state,
          operation.failure_code, operation.kind
        from ops.privacy_operations as operation
        where operation.failure_code is not null
        union all
        select coalesce(run.closed_at, run.updated_at), 'business_run', run.run_id, run.state, null, run.purpose
        from ops.business_runs as run
        where run.state = 'failed'
      ) as errors`.execute(trx);
    await sql`
      comment on view ops.recent_errors is
        'Failures and unknown outcomes from jobs, model attempts, production, Reel orders and privacy operations: when, which record, its state and code. Unknown is listed because it needs reconciling, not because it failed.'`.execute(
      trx,
    );
    await createOpsWatchdogView(trx);
  });
}

/**
 * `ops.watchdog` (D-411): one row per observation the hourly watchdog may alert on, with a rule, a code-only
 * subject and detail, the time it was observed and a magnitude. It holds no ID and no text, so the read-only role
 * may read it, and the thresholds stay in code (`modules/operator/domain/watchdog.ts`): the view states facts, never
 * whether they are bad. Each branch reads a small indexed set (dead letters and failed jobs within pg-boss's
 * retention, runs that are still active, unknown attempts, the newest settled runs, `composer-policy.v2` decisions).
 *
 * - `dead_letter`: a job in a `<queue>.dead` queue. Subject: that queue.
 * - `job_failed`: a failed job. Subject: its queue. Detail: its failure code (or class, or `none`).
 * - `run_held`: a Planner or Geography run still `queued` or `prepared`. Subject: `planner` or `geography`.
 *   Detail: its status. Observed: when its row last moved.
 * - `attempt_unknown`: a model attempt whose outcome is `unknown`. Subject: `personal` or `production`.
 * - `geography_insufficient_repeat`: a universe whose latest settled Cartographer runs ended `insufficient` on one
 *   outcome that is not healthy (`no_changes`, `disabled` and `no_support_yet` are), while it has coverage references.
 *   Subject: the outcome code. Magnitude: how many runs in a row (at most 20). No universe is named. It walks the
 *   universes of `geography.state` that settled a run in the last 7 days (the most the rule looks back) and reads each
 *   one's newest settled runs through the primary key `(universe_id, id)`, newest first: run ids are minted as UUIDv7,
 *   so id order is creation order and the read is a backward index scan of at most 20 rows however long the history.
 *   It then probes the two reference tables' indexes once for each universe that is stuck: no pass over a table of runs
 *   or references.
 * - `composer_repeat`: among the newest 5,000 decisions whose expiry is in the last 7 days (a backward range scan of
 *   `composer_decisions_expired_idx`), a `composer-policy.v2` vertical decision with no exact target whose FIRST selected
 *   slot (the offered item) is an explanation the person had met while an eligible candidate was not. Subject: the policy
 *   version. A sample at high volume, so a rate signal and not a census.
 */
async function createOpsWatchdogView<DB>(trx: Kysely<DB>): Promise<void> {
  await sql`
    create or replace function ops.json_array(value jsonb) returns jsonb
    language sql immutable parallel safe
    as $$ select case when jsonb_typeof(value) = 'array' then value else '[]'::jsonb end $$`.execute(trx);
  // Whether a stored Composer decision says the person had met an explanation: an activated exposure of its unit in either
  // format (`input.evidence.established.units`) or an encounter in the recent window (`input.evidence.recent`). The same
  // notion as `isMetIn` in the Composer module; history that was not read says nothing, so absence is not met.
  await sql`
    create or replace function ops.composer_met(payload jsonb, unit text) returns boolean
    language sql immutable parallel safe
    as $$
      select exists (
        select 1 from jsonb_array_elements(ops.json_array(payload #> '{input,evidence,established,units}')) as established(item)
        where established.item ->> 'explanationUnitId' = unit and established.item ->> 'encountered' = 'true')
      or exists (
        select 1 from jsonb_array_elements(ops.json_array(payload #> '{input,evidence,recent}')) as recent(item)
        where recent.item ->> 'explanationUnitId' = unit)
    $$`.execute(trx);
  await sql`
    create view ops.watchdog as
    select 'dead_letter'::text as rule, job.queue as subject, null::text as detail,
      job.created_at as observed_at, 1::bigint as magnitude
    from ops.jobs as job
    where job.queue like '%.dead'
    union all
    select 'job_failed', job.queue, coalesce(job.failure_code, job.failure_class, job.failure, 'none'),
      coalesce(job.completed_at, job.started_at, job.created_at), 1::bigint
    from ops.jobs as job
    where job.state = 'failed' and job.queue not like '%.dead'
    union all
    select 'run_held', 'geography', run.status, run.updated_at, 1::bigint
    from geography.runs as run
    where run.status in ('queued', 'prepared')
    union all
    select 'run_held', 'planner', run.status, run.updated_at, 1::bigint
    from planner.runs as run
    where run.status in ('queued', 'prepared')
    union all
    select 'attempt_unknown', attempt.scope_kind, null::text, coalesce(attempt.dispatched_at, attempt.reserved_at), 1::bigint
    from ops.model_attempts as attempt
    where attempt.state = 'unknown'
    union all
    select 'geography_insufficient_repeat', candidate.outcome, null::text, candidate.updated_at, candidate.runs::bigint
    from (
      select state.universe_id, state.privacy_epoch, streak.outcome, streak.updated_at, streak.runs
      from geography.state as state
      cross join lateral (
        select recent.outcomes[1] as outcome, recent.statuses[1] as status, recent.updated_ats[1] as updated_at,
          coalesce(
            (select min(position) - 1 from generate_subscripts(recent.outcomes, 1) as position
              where recent.outcomes[position] is distinct from recent.outcomes[1]),
            cardinality(recent.outcomes)
          ) as runs
        from (
          select array_agg(latest.outcome order by latest.id desc) as outcomes,
            array_agg(latest.status order by latest.id desc) as statuses,
            array_agg(latest.updated_at order by latest.id desc) as updated_ats
          from (
            select run.id, run.status, run.outcome, run.updated_at
            from geography.runs as run
            where run.universe_id = state.universe_id and run.privacy_epoch = state.privacy_epoch
              and run.status in ('accepted', 'stale', 'rejected', 'insufficient')
            order by run.id desc
            limit 20
          ) as latest
        ) as recent
      ) as streak
      where state.next_run_not_before > now() - interval '7 days'
        and streak.status = 'insufficient'
        and streak.outcome is not null
        and streak.outcome not in ('no_changes', 'disabled', 'no_support_yet')
      offset 0
    ) as candidate
    left join lateral (
      select 1 as present from personal_context.coverage_references as reference
      where reference.universe_id = candidate.universe_id and reference.privacy_epoch = candidate.privacy_epoch limit 1
    ) as legacy on true
    left join lateral (
      select 1 as present from personal_context.recording_coverage_references as reference
      where reference.universe_id = candidate.universe_id and reference.privacy_epoch = candidate.privacy_epoch limit 1
    ) as recording on true
    where legacy.present is not null or recording.present is not null
    union all
    select 'composer_repeat', sampled.policy_version, null::text, sampled.recorded_at, 1::bigint
    from (
      select decision.id, decision.policy_version, decision.recorded_at, decision.payload
      from composer.decisions as decision
      where decision.expires_at > now() + interval '23 days'
      order by decision.expires_at desc, decision.id desc
      limit 5000
    ) as sampled
    where sampled.policy_version = 'composer-policy.v2'
      and sampled.payload #>> '{input,mode}' = 'vertical'
      and sampled.payload #> '{input,intent,exactTarget}' is null
      and exists (
        select 1
        from jsonb_array_elements(ops.json_array(sampled.payload -> 'evaluations')) as offered(item)
        where offered.item ->> 'assetId' = sampled.payload #>> '{selection,0,assetId}'
          and offered.item ->> 'assetRevision' = sampled.payload #>> '{selection,0,assetRevision}'
          and ops.composer_met(sampled.payload, offered.item ->> 'explanationUnitId'))
      and exists (
        select 1
        from jsonb_array_elements(ops.json_array(sampled.payload -> 'evaluations')) as candidate(item)
        where candidate.item ->> 'eligible' = 'true'
          and not ops.composer_met(sampled.payload, candidate.item ->> 'explanationUnitId'))`.execute(trx);
  await sql`
    comment on view ops.watchdog is
      'One row per observation the watchdog may alert on: rule, code-only subject and detail, when, and a magnitude. No ID, no text. The thresholds are in code.'`.execute(
    trx,
  );
}

/**
 * Lets {@link OPS_READER_ROLE} select the allowlisted views, and nothing else. Safe to repeat. The
 * role belongs to the cluster, not to one world's database, and the migration role cannot create
 * it: the owner creates it once (`docs/v2/operations/looking-at-the-system.md`) and the next
 * `migrate.js` run grants it. Returns `role_missing` when it does not exist yet. A world's database
 * revokes CONNECT from PUBLIC, so the role is also granted CONNECT on this database (the database
 * owner, which runs `migrate.js`, may grant it).
 */
export async function grantOpsReader<DB>(db: Kysely<DB>): Promise<'granted' | 'role_missing'> {
  const found = await sql<{ present: boolean }>`
    select exists (select 1 from pg_roles where rolname = ${OPS_READER_ROLE}) as present`.execute(db);
  if (found.rows[0]?.present !== true) return 'role_missing';
  const role = sql.id(OPS_READER_ROLE);
  const current = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const database = sql.id(current.rows[0]?.name ?? '');
  await db.transaction().execute(async (trx) => {
    await sql`grant connect on database ${database} to ${role}`.execute(trx);
    await sql`grant usage on schema ops to ${role}`.execute(trx);
    for (const view of OPS_READER_VIEWS) await sql`grant select on ${sql.table(`ops.${view}`)} to ${role}`.execute(trx);
    await sql`revoke all on ${sql.table('ops.journey_events')} from ${role}`.execute(trx);
  });
  return 'granted';
}
