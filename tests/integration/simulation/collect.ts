import { sql, type RawBuilder } from 'kysely';
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
  /** pg-boss jobs for this person that did not complete: failed, retrying, queued or active, and dead-letter copies. */
  readonly stuckJobs: readonly {
    readonly queue: string;
    readonly state: string;
    readonly n: number;
    readonly errorClass?: string;
    readonly code?: string;
  }[];
}

/** Queues whose jobs wait on model production, which the lab never runs (no provider, no spend). */
const PRODUCTION_QUEUES = ['supply.resolve-request', 'content.produce-scroll', 'content.produce-answer'];

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
  const stuck = await sql<{ queue: string; state: string; n: number; error_class: string | null; code: string | null }>`
    select name queue, state::text state, count(*)::int n,
      max(output->>'errorClass') error_class, max(output->>'code') code
    from pgboss.job
    where data->>'universeId' = ${u} and (state <> 'completed' or name like '%.dead')
    group by 1, 2 order by 1, 2`.execute(db);
  const production = stuck.rows.filter((row) => PRODUCTION_QUEUES.includes(row.queue));
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
    productionJobs: production.map((row) => ({ queue: row.queue, state: row.state, n: row.n })),
    stuckJobs: stuck.rows
      .filter((row) => !PRODUCTION_QUEUES.includes(row.queue))
      .map((row) => ({
        queue: row.queue,
        state: row.state,
        n: row.n,
        ...(row.error_class ? { errorClass: row.error_class } : {}),
        ...(row.code ? { code: row.code } : {}),
      })),
  };
}

/**
 * A fingerprint of everything the product holds about a person's evidence and places: per table, the row count and a
 * hash of every row. The lab takes it of one person before and after another person's step; any difference means the
 * other person's activity reached rows that are not theirs.
 */
export async function fingerprint(world: SimWorld, universeId: string): Promise<Readonly<Record<string, string>>> {
  const db = world.geo.database.db;
  const tables = await world.personalTables();
  const result: Record<string, string> = {};
  for (const { schema, table } of tables) {
    const row = (
      await sql<{ n: number; h: string }>`
        select count(*)::int n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h
        from ${sql.table(`${schema}.${table}`)} t where universe_id = ${universeId}::uuid`.execute(db)
    ).rows[0]!;
    result[`${schema}.${table}`] = `${String(row.n)}:${row.h}`;
  }
  return result;
}
