import { sql, type Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { produceScrollJob } from '@knowscroll/backend/modules/content';
import { makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import {
  SCROLL_PRODUCTION_V3_VERSION,
  SCROLL_PRODUCTION_VERSION,
  type ScrollTopic,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import type { fixtureProductionWorker } from './production-worker.js';

/**
 * A library on which Create still has recipes to make (#818). Create commissions a code recipe only while the plan marks it a v1 recipe
 * (D-138), and the v1 writer is deleted, so no code recipe is both Create's to make and producible. The files that test Create's own
 * mechanics (who starts a production, the caps, the waiting, the retries) keep marking recipes v1 (`markLibraryV1`) so Create chooses them, and
 * run the job they commissioned with this function. The job is the real production job: the real document v3 writer (`writerRoleV3One`), its
 * validator, the harness's one repair, the ledger, the quota and the publication, over the labelled fixture model. Only the plan is lent to
 * the recipe for the run (the Orrin reply the fixture records is written for `spikePlanV3('seasons')`), and the job's end is recorded as the
 * v1 production version's, which is the version a v1 recipe's standing is read at: the same row, the same take, the same state. A Scroll the job
 * published is held for review as every document v3 library Scroll is, so the operator's release (`makeReviewGate`) serves it, which is
 * what lets the waiters Create counted on be bound. Nothing here is a model or a provider; it is CI fixture data.
 */
export async function runCommissionedJob(
  db: Kysely<Database>,
  production: Pick<ReturnType<typeof fixtureProductionWorker>, 'run'>,
  recipe: ScrollTopic,
  take = 1,
): Promise<Awaited<ReturnType<ReturnType<typeof fixtureProductionWorker>['run']>>> {
  const planned = RECIPES[recipe] as { scrollV3?: ScrollV3Plan };
  const before = planned.scrollV3;
  planned.scrollV3 = spikePlanV3('seasons');
  let outcome: Awaited<ReturnType<ReturnType<typeof fixtureProductionWorker>['run']>>;
  try {
    outcome = await production.run(produceScrollJob(recipe, take), { signal: new AbortController().signal });
  } finally {
    if (before === undefined) delete planned.scrollV3;
    else planned.scrollV3 = before;
  }
  // Record the end of the job under the v1 production version, as the v1 job's row was.
  await sql`insert into content.scroll_production_runs
      (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, claims, writer_output,
       outcomes, asset_id, asset_revision, completed_at)
    select gen_random_uuid(), topic, ${SCROLL_PRODUCTION_VERSION}, take, target_revision, scope_generation, state, gen_random_uuid(),
      research, claims, writer_output, outcomes, asset_id, asset_revision, completed_at
    from content.scroll_production_runs
    where topic = ${recipe} and policy_version = ${SCROLL_PRODUCTION_V3_VERSION} and take = ${take}
    on conflict (topic, policy_version, take) do update set state = excluded.state, outcomes = excluded.outcomes,
      asset_id = excluded.asset_id, asset_revision = excluded.asset_revision, completed_at = excluded.completed_at`.execute(
    db,
  );
  const published = (
    await sql<{
      asset_id: string;
      asset_revision: number;
    }>`select asset_id, asset_revision from content.scroll_production_runs
      where topic = ${recipe} and policy_version = ${SCROLL_PRODUCTION_V3_VERSION} and take = ${take} and state = 'published'`.execute(
      db,
    )
  ).rows[0];
  if (published !== undefined) {
    const held = await sql`select 1 from content.revision_reviews
      where asset_id = ${published.asset_id}::uuid and revision = ${published.asset_revision}::integer and state = 'held'`.execute(
      db,
    );
    if (held.rows.length > 0) {
      const released = await makeReviewGate(db).release({
        assetId: published.asset_id,
        revision: published.asset_revision,
        decidedBy: 'cli:ci-reviewer',
      });
      if (released.kind !== 'released') throw new Error(`CI release refused: ${released.kind}`);
    }
  }
  return outcome;
}
