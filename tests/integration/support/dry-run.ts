import { sql } from 'kysely';
import {
  fencePersonalRecording,
  makeWithDryRunPersonalScope,
  readPersonalRecordingNow,
} from '@knowscroll/backend/infrastructure/postgres';
import { LOCK_CURRENT_COVERAGE_AUTHORITIES } from '@knowscroll/backend/modules/content';
import {
  contentProviders,
  readCurrentCoverageAuthorities,
  readDiscoveryCandidates,
} from '@knowscroll/backend/modules/content/nest-providers';
import { activityProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { READ_TRUSTED_COVERAGE } from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { makeGeographyDryRun } from '@knowscroll/backend/modules/geography/nest-providers';
import { plannerDryRunFor } from '@knowscroll/backend/modules/planner/nest-providers';
import type { GeographyWorld } from './geography-world.js';
import { buildRecursively } from './providers.js';

/**
 * The dry runs as the worker builds them (#674, D-411): the same ports as a real run, with the read-only scope, and the
 * trusted read over the lock-free authority recheck. `enabled` is the role switch the report names.
 */
export function dryRunsOf(
  world: GeographyWorld,
  options: { readonly enabled?: boolean; readonly now?: () => Date } = {},
) {
  const enabled = options.enabled ?? true;
  const dryScope = makeWithDryRunPersonalScope(world.database.db, { lockTimeoutMs: 5_000 });
  const SCOPE = Symbol('scope'),
    ENQUEUE = Symbol('enqueue');
  const values = new Map<symbol, unknown>(
    contentProviders().flatMap((provider) =>
      'useValue' in provider ? [[provider.provide, provider.useValue] as const] : [],
    ),
  );
  values.set(LOCK_CURRENT_COVERAGE_AUTHORITIES, readCurrentCoverageAuthorities);
  const readTrusted = buildRecursively(
    [...activityProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }), ...personalContextProviders()],
    READ_TRUSTED_COVERAGE,
    values,
  ) as typeof world.base.readTrusted;
  return {
    geography: makeGeographyDryRun({
      ...world.base,
      withScope: dryScope,
      readTrusted,
      readRecordingNow: readPersonalRecordingNow,
      enabled: () => enabled,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    planner: plannerDryRunFor({
      withPersonalScope: dryScope,
      fenceRecording: fencePersonalRecording,
      readRecordingNow: readPersonalRecordingNow,
      readSnapshot: world.c.readExploration,
      readRecentTopics: world.c.readRecentTopics,
      readInventory: readDiscoveryCandidates,
      enabled: () => enabled,
    }),
  };
}

/** Row counts of every table a Cartographer or Planner run could write, and the person's root revision: what a dry run must not move. */
export async function footprintOf(world: GeographyWorld, universeId: string) {
  const db = world.database.db;
  const count = async (table: string) =>
    (
      await sql<{
        n: string;
      }>`select count(*)::text as n from ${sql.table(table)} where universe_id = ${universeId}::uuid`.execute(db)
    ).rows[0]!.n;
  const tables = [
    'geography.state',
    'geography.runs',
    'geography.objects',
    'geography.relations',
    'geography.deltas',
    'planner.state',
    'planner.runs',
    'planner.revisions',
    'reasoning.business_runs',
    'reasoning.external_attempts',
    'supply.requests',
  ];
  const counts = Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await count(table)] as const)),
  );
  const root = await db
    .selectFrom('identity.universes')
    .select(['revision', 'privacy_epoch'])
    .where('id', '=', universeId)
    .executeTakeFirstOrThrow();
  const geography = (
    await sql<{
      revision: number;
      structure_revision: number;
      activity_revision: number;
      active_run_id: string | null;
    }>`
      select revision, structure_revision, activity_revision, active_run_id from geography.state
      where universe_id = ${universeId}::uuid`.execute(db)
  ).rows[0];
  const jobs = (
    await sql<{
      n: string;
    }>`select count(*)::text as n from pgboss.job where data->>'universeId' = ${universeId}`.execute(db)
  ).rows[0]!.n;
  return { counts, root, geography, jobs };
}
