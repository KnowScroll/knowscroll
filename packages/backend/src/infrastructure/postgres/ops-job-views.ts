import { sql, type Kysely } from 'kysely';

/**
 * The `ops` views that read pg-boss's tables, and the grants of the read-only operator role.
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
  'jobs',
  'queue_backlog',
  'recent_errors',
];

const JOB_VIEWS_IN_DROP_ORDER = ['recent_errors', 'queue_backlog', 'jobs'] as const;

export interface DropOptions {
  /** How long one attempt waits for the exclusive lock a drop needs. Default 3 s. */
  readonly lockTimeoutMs?: number;
  /** How many attempts before the drop fails. Default 8. */
  readonly attempts?: number;
}

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Drops the pg-boss views (and `recent_errors`, which reads them). Nothing to do when they are absent.
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
 * Creates `ops.jobs`, `ops.queue_backlog` and `ops.recent_errors`. Needs pg-boss's schema and
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
  });
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
