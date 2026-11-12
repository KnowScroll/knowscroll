import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../../infrastructure/postgres/index.js';
import { projectScrollReadingQueue } from '../../../evidence/public.js';
import type { CanaryReads, EvidenceRow } from '../../application/canary/ports.js';
import type { JobRow, OperatorReads, RunRow } from '../../domain/canary/evaluate.js';

interface RunQueryRow {
  readonly stage: string;
  readonly state: string | null;
  readonly ended_at: Date | null;
  readonly started_at: Date;
}

/** Attempts whose request never left (`reserved`, `not_sent`) cost nothing; every other state is a paid or possibly paid call. */
const UNSENT_ATTEMPT_STATES = ['reserved', 'not_sent'];

/**
 * The canary's read-only operator reads about its own universes: Planner and Cartographer runs, Composer decisions,
 * supply requests and model attempts from `ops.journey_events`, and failed or dead-lettered pg-boss jobs whose payload
 * names one of the universes, plus the evidence projection backlog. Plain SELECTs: no lock, no write. It returns
 * states, codes, ages and counts, never a payload.
 */
export function makeCanaryReads(db: Kysely<Database>, now: () => Date = () => new Date()): CanaryReads {
  return {
    async evidence(universeId) {
      const [rows, backlog] = await Promise.all([
        sql<{ exposure_id: string; state: string | null; revision: string }>`
          select distinct on (exposure_id) exposure_id, state, count::text as revision
          from ops.journey_events
          where universe_id = ${universeId}::uuid and stage = 'evidence.encounter_evidence' and exposure_id is not null
          order by exposure_id, count desc`.execute(db),
        sql<{ total: string }>`
          select count(*)::text as total
          from pgboss.job
          where name = ${projectScrollReadingQueue.name}
            and data ->> 'universeId' = ${universeId}
            and state in ('created', 'retry', 'active')`.execute(db),
      ]);
      return {
        rows: rows.rows.map((row): EvidenceRow => ({
          exposureId: row.exposure_id,
          revision: Number(row.revision),
          qualification: row.state === 'qualified' || row.state === 'not_qualified' ? row.state : ('unknown' as const),
        })),
        projectionsPending: Number(backlog.rows[0]?.total ?? 0),
      };
    },
    async read(universeIds): Promise<OperatorReads> {
      if (universeIds.length === 0)
        return {
          planner: [],
          geography: [],
          jobs: [],
          policies: [],
          supply: { requests: 0, commissionedWork: 0 },
          attempts: [],
        };
      const ids = [...universeIds];
      const [runs, decisions, jobs, supply, attempts] = await Promise.all([
        sql<RunQueryRow>`
          select stage, state, ended_at, started_at
          from ops.journey_events
          where universe_id = any(${ids}::uuid[]) and stage in ('planner.run', 'geography.run')`.execute(db),
        sql<{ label: string | null; total: string }>`
          select label, count(*)::text as total
          from ops.journey_events
          where universe_id = any(${ids}::uuid[]) and stage = 'composer.decision'
          group by label`.execute(db),
        sql<{ queue: string; state: string; total: string }>`
          select name as queue, state::text as state, count(*)::text as total
          from pgboss.job
          where data ->> 'universeId' = any(${ids}::text[]) and (state = 'failed' or name like '%.dead')
          group by name, state`.execute(db),
        sql<{ requests: string; work: string }>`
          select count(*)::text as requests, count(distinct work_id)::text as work
          from ops.journey_events
          where universe_id = any(${ids}::uuid[]) and stage = 'supply.request'`.execute(db),
        sql<{ role: string | null; total: string }>`
          select coalesce(run.label, 'unknown') as role, count(*)::text as total
          from ops.journey_events as attempt
          left join lateral (
            select label from ops.journey_events as owner
            where owner.stage = 'reasoning.run'
              and owner.reasoning_run_id = attempt.reasoning_run_id
              and owner.universe_id = attempt.universe_id
            limit 1
          ) as run on true
          where attempt.stage = 'reasoning.attempt'
            and attempt.universe_id = any(${ids}::uuid[])
            and attempt.state <> all(${UNSENT_ATTEMPT_STATES}::text[])
          group by 1`.execute(db),
      ]);
      const at = now().getTime();
      const runRows = (stage: string): RunRow[] =>
        runs.rows
          .filter((row) => row.stage === stage)
          .map((row) => ({
            state: row.state ?? 'unknown',
            ended: row.ended_at !== null,
            ageSeconds: Math.max(0, Math.floor((at - row.started_at.getTime()) / 1000)),
          }));
      return {
        planner: runRows('planner.run'),
        geography: runRows('geography.run'),
        jobs: jobs.rows.map((row): JobRow => ({ queue: row.queue, state: row.state, count: Number(row.total) })),
        policies: decisions.rows.map((row) => ({ label: row.label ?? 'unlabelled', count: Number(row.total) })),
        supply: {
          requests: Number(supply.rows[0]?.requests ?? 0),
          commissionedWork: Number(supply.rows[0]?.work ?? 0),
        },
        attempts: attempts.rows.map((row) => ({ role: row.role ?? 'unknown', count: Number(row.total) })),
      };
    },
  };
}
