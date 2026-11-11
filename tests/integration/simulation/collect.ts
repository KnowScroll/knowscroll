import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { SimWorld } from './world.js';

/** What the database holds about one person after a run, read once so the invariants and metrics share it. */
export interface DbSnapshot {
  readonly decisions: number;
  readonly decisionBytes: number;
  readonly offers: number;
  /** Exposures the person activated (`activated_at` set). */
  readonly activatedExposures: number;
  readonly lineageRows: number;
  /** Exposures with a committed evidence revision. */
  readonly evidenceExposures: readonly string[];
  /** Exposures with at least one stored observation. */
  readonly observationExposures: readonly string[];
  /** Topics Personal Context counts at least one qualified unit for. */
  readonly contextTopics: readonly string[];
  readonly geographyRuns: readonly { readonly status: string; readonly outcome: string | null; readonly n: number }[];
  readonly plannerRuns: readonly { readonly status: string; readonly outcome: string | null; readonly n: number }[];
  /** The person's places, by semantic key. */
  readonly places: readonly string[];
  readonly supplyRows: readonly { readonly origin: string; readonly state: string; readonly n: number }[];
  readonly plannerOpportunities: { readonly existing: number; readonly missingSupply: number };
  /**
   * Jobs the lab does not run, because they would call a provider: Supply's resolver waits on Create's production. A
   * Planner demand that reaches them shows here, and is not an unfinished job of the worker the lab drains.
   */
  readonly productionJobs: readonly { readonly queue: string; readonly state: string; readonly n: number }[];
}

/** Queues whose jobs wait on model production, which the lab never runs (no provider, no spend). */
export const PRODUCTION_QUEUES = ['supply.resolve-request', 'content.produce-scroll', 'content.produce-answer'];

export async function collect(world: SimWorld, universeId: string): Promise<DbSnapshot> {
  const db = world.geo.database.db;
  const u = universeId;
  const one = async <T>(query: RawBuilder<T>) => (await query.execute(db)).rows[0]!;
  const counts = await one(sql<{
    decisions: number;
    bytes: number;
    offers: number;
    exposures: number;
    lineage: number;
  }>`select
      (select count(*)::int from composer.decisions where universe_id = ${u}::uuid) decisions,
      (select coalesce(sum(pg_column_size(payload)), 0)::int from composer.decisions where universe_id = ${u}::uuid) bytes,
      (select count(*)::int from experience.offers where universe_id = ${u}::uuid) offers,
      (select count(*)::int from experience.exposures where universe_id = ${u}::uuid and activated_at is not null) exposures,
      (select count(*)::int from experience.encounter_lineage where universe_id = ${u}::uuid) lineage`);
  const evidence = await sql<{ exposure_id: string }>`
    select distinct exposure_id from evidence.encounter_evidence where universe_id = ${u}::uuid`.execute(db);
  const observed = await sql<{ exposure_id: string }>`
    select distinct exposure_id from evidence.observations where universe_id = ${u}::uuid`.execute(db);
  const topics = await sql<{ topic_id: string }>`
    select topic_id from personal_context.topics where universe_id = ${u}::uuid and qualified_units > 0 order by topic_id`.execute(
    db,
  );
  const geographyRuns = await sql<{ status: string; outcome: string | null; n: number }>`
    select status, outcome, count(*)::int n from geography.runs where universe_id = ${u}::uuid group by 1, 2 order by 1, 2`.execute(
    db,
  );
  const plannerRuns = await sql<{ status: string; outcome: string | null; n: number }>`
    select status, outcome, count(*)::int n from planner.runs where universe_id = ${u}::uuid group by 1, 2 order by 1, 2`.execute(
    db,
  );
  const places = await sql<{ semantic_key: string }>`
    select semantic_key from geography.objects where universe_id = ${u}::uuid order by semantic_key`.execute(db);
  const supply = await sql<{ origin: string; state: string; n: number }>`
    select origin, state, count(*)::int n from supply.requests where universe_id = ${u}::uuid group by 1, 2 order by 1, 2`.execute(
    db,
  );
  const opportunities = await one(sql<{ existing: number; missing: number }>`
    select
      coalesce(sum((select count(*) from jsonb_array_elements(opportunities) o where o->'target'->>'kind' = 'existing')), 0)::int existing,
      coalesce(sum((select count(*) from jsonb_array_elements(opportunities) o where o->'target'->>'kind' = 'missing_supply')), 0)::int missing
    from planner.revisions where universe_id = ${u}::uuid`);
  const production = await sql<{ queue: string; state: string; n: number }>`
    select name queue, state::text state, count(*)::int n from pgboss.job
    where data->>'universeId' = ${u} and name = any(${PRODUCTION_QUEUES}) and state <> 'completed'
    group by 1, 2 order by 1, 2`.execute(db);
  return {
    decisions: counts.decisions,
    decisionBytes: counts.bytes,
    offers: counts.offers,
    activatedExposures: counts.exposures,
    lineageRows: counts.lineage,
    evidenceExposures: evidence.rows.map((row) => row.exposure_id),
    observationExposures: observed.rows.map((row) => row.exposure_id),
    contextTopics: topics.rows.map((row) => row.topic_id),
    geographyRuns: geographyRuns.rows,
    plannerRuns: plannerRuns.rows,
    places: places.rows.map((row) => row.semantic_key),
    supplyRows: supply.rows,
    plannerOpportunities: { existing: opportunities.existing, missingSupply: opportunities.missing },
    productionJobs: production.rows,
  };
}

/**
 * A fingerprint of everything the product holds about a person in the evidence, Personal Context, Geography, Scenes,
 * Composer, Experience, Planner and Supply tables: per table, the row count and a hash of every row, read in one query.
 * The lab takes it of one person before and after another person's step; any difference means the other person's
 * activity reached rows that are not theirs.
 */
export async function fingerprint(world: SimWorld, universeId: string): Promise<Readonly<Record<string, string>>> {
  const tables = await world.personalTables();
  const parts = tables.map(
    ({ schema, table }) => sql`
      select ${`${schema}.${table}`}::text as name, count(*)::int as n,
        coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
      from ${sql.table(`${schema}.${table}`)} t where universe_id = ${universeId}::uuid`,
  );
  const rows = (
    await sql<{ name: string; n: number; h: string }>`${sql.join(parts, sql` union all `)}`.execute(
      world.geo.database.db,
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.name, `${String(row.n)}:${row.h}`]));
}

/**
 * Work for one person that is waiting for a worker (queued, retrying or running), whatever else the lab drains. A
 * person with work waiting is not at rest, so a step of someone else must not be judged by their rows yet.
 */
export async function pendingJobsOf(world: SimWorld, universeId: string): Promise<number> {
  const row = (
    await sql<{ n: number }>`
      select count(*)::int n from pgboss.job
      where data->>'universeId' = ${universeId} and state in ('created', 'retry', 'active')
        and not (name = any(${PRODUCTION_QUEUES}))`.execute(world.geo.database.db)
  ).rows[0]!;
  return row.n;
}

/** A pg-boss job that is not complete, in a queue the lab drains or one it should not have reached. */
export interface UnsettledJob {
  readonly queue: string;
  readonly state: string;
  readonly n: number;
  readonly errorClass?: string;
}

/**
 * Every job in the database that is not completed, whatever its payload looks like, except the production queues the
 * lab never runs and pg-boss's own bookkeeping queues. A job in a queue no consumer of the lab drains shows up here too,
 * which is how a new worker queue on the activity path is noticed.
 */
export async function unsettledJobs(db: Kysely<Database>): Promise<readonly UnsettledJob[]> {
  const rows = (
    await sql<{ queue: string; state: string; n: number; error_class: string | null }>`
      select name queue, state::text state, count(*)::int n, max(output->>'errorClass') error_class
      from pgboss.job
      where state <> 'completed' and not (name = any(${PRODUCTION_QUEUES})) and not starts_with(name, '__pgboss__')
      group by 1, 2 order by 1, 2`.execute(db)
  ).rows;
  return rows.map((row) => ({
    queue: row.queue,
    state: row.state,
    n: row.n,
    ...(row.error_class ? { errorClass: row.error_class } : {}),
  }));
}
