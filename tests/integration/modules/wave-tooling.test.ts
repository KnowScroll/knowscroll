import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { planLibraryProduction, planRegeneration } from '@knowscroll/backend/modules/content';
import { makeReviewGate, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { markRecipesV1, orrinResearchFor } from '../support/scroll-v2.js';
import { orrinV3 } from '../support/scroll-v3.js';
import { storeV1 } from '../support/stored-v1.js';

/**
 * The tooling for the library waves (S-6a, D-197 to D-199): regenerating a Scroll that is already served. The Scrolls are the labelled
 * Orrin fixture (an invented planet) in the document v3 shape, produced through the real production job; the "model" is a labelled CI
 * fixture and nothing here is provider output. (The answer check of a v2 Scroll's calls, which this file also tested, ran in the v2
 * production job only and is gone with it, #815: a document v3 has no calls and its check is recorded with no request.)
 */
describe('regenerating a served library Scroll (labelled CI fixtures, real PostgreSQL)', () => {
  // The plan marks these recipes document v3 (D-217); this file uses tides as a v1 example.
  const restoreRecipes = markRecipesV1('tides');
  afterAll(restoreRecipes);
  // The recorded Orrin reply is written to the Seasons plan, so the recipe this file produces takes that plan for the file's own process.
  const planned = RECIPES['seasons-hemispheres'] as { scrollV3?: ScrollV3Plan };
  const ownPlan = planned.scrollV3;
  beforeAll(() => {
    planned.scrollV3 = spikePlanV3('seasons');
  });
  afterAll(() => {
    planned.scrollV3 = ownPlan;
  });
  let database: TestDatabase<Database>;
  const operator = 'cli:ci-reviewer';
  const gate = () => makeReviewGate(database.db);

  beforeEach(async () => {
    database = await createTestDatabase<Database>('wave_tooling');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const statusOf = async (key: ScrollTopic) => (await readLibraryStatus(database.db, [key]))[0]!;
  const assetOf = (key: ScrollTopic) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', TOPICS[key].assetId)
      .executeTakeFirst();
  const jobsOf = (key: ScrollTopic) =>
    database.db
      .selectFrom('content.scroll_production_runs')
      .selectAll()
      .where('topic', '=', key)
      .orderBy('take')
      .execute();
  const writing = (script: (sequence: number) => FixtureScenario = () => answerWith(orrinV3())) => script;

  /** Produces the first take of a recipe and releases it, the way a wave does, and returns what was released. */
  async function producedAndReleased(key: ScrollTopic) {
    const run = fixtureProduction(database.db, writing(), orrinResearchFor);
    expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true, revision: 1 });
    expect(await gate().release({ assetId: TOPICS[key].assetId, revision: 1, decidedBy: operator })).toMatchObject({
      kind: 'released',
    });
    return run;
  }

  describe('regenerating a recipe whose Scroll is served (seasons-hemispheres)', () => {
    const key = 'seasons-hemispheres';
    const assetId = TOPICS[key].assetId;

    it('is available once the Scroll is served, with two takes left; a recipe that is not a served document v3 Scroll is not', async () => {
      expect(await statusOf(key)).toMatchObject({ regeneration: 'not_published', takes: 0 });
      await producedAndReleased(key);
      expect(await statusOf(key)).toMatchObject({
        state: 'published',
        takes: 1,
        takesLeft: 2,
        regeneration: 'available',
      });
      const standing = await readLibraryStatus(database.db, [key, 'tides', 'seasons']);
      expect(standing.map((row) => [row.recipe, row.regeneration])).toEqual([
        [key, 'available'],
        ['tides', 'not_v2'],
        ['seasons', 'not_published'],
      ]);
      expect(planRegeneration(standing)).toEqual({
        queue: [{ recipe: key, take: 2 }],
        skipped: [
          { recipe: 'tides', reason: 'not_v2' },
          { recipe: 'seasons', reason: 'not_published' },
        ],
      });
      // A first production is not a regeneration: produce-library sends nothing for a served recipe.
      expect(planLibraryProduction(standing, { interactiveFirst: false }).queue).not.toContainEqual(
        expect.objectContaining({ recipe: key }),
      );
    });

    it('stores the new take held as the next revision, and leaves the served revision served until it is released', async () => {
      await producedAndReleased(key);
      const again = fixtureProduction(database.db, writing(), orrinResearchFor);
      const result = await again.produce(key, false, signal(), true, 2);
      expect(result).toMatchObject({ outcome: 'published', held: true, take: 2, revision: 2, assetId });
      expect(result.requestBound).toBe(6);

      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 1 });
      expect(await gate().list({ all: false })).toMatchObject([
        { recipe: key, revision: 2, state: 'held', servedRevision: 1, coverage: 'mapped' },
      ]);
      expect(await statusOf(key)).toMatchObject({
        state: 'published',
        revision: 1,
        heldRevision: 2,
        takes: 2,
        regeneration: 'held',
      });
      // Nothing more is started while a revision waits for a decision: the next take is refused, and sends nothing.
      const third = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await third.produce(key, false, signal(), true, 3)).toMatchObject({ outcome: 'take_refused' });
      expect(third.calls).toHaveLength(0);
      expect(planRegeneration([await statusOf(key)])).toEqual({
        queue: [],
        skipped: [{ recipe: key, reason: 'held' }],
      });

      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toMatchObject({
        kind: 'released',
        replacedRevision: 1,
      });
      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 2 });
    });

    it('can be taken again after a release or a rejection, up to three takes in all, and then never again in this version', async () => {
      await producedAndReleased(key);
      const writers: number[] = [];
      for (const take of [2, 3]) {
        const run = fixtureProduction(database.db, writing(), orrinResearchFor);
        expect(await run.produce(key, false, signal(), true, take)).toMatchObject({
          outcome: 'published',
          held: true,
          take,
        });
        writers.push(run.calls.length);
        if (take === 2) {
          await gate().release({ assetId, revision: 2, decidedBy: operator });
          expect(await statusOf(key)).toMatchObject({ takes: 2, takesLeft: 1, regeneration: 'available' });
        }
      }
      expect(writers).toEqual([1, 1]);
      // The third take is rejected at the gate: the served Scroll is still revision 2, and the takes are spent.
      await gate().reject({ assetId, revision: 3, reason: 'a CI rejection', decidedBy: operator });
      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 2 });
      expect(await statusOf(key)).toMatchObject({ takes: 3, takesLeft: 0, regeneration: 'spent' });
      expect(planRegeneration([await statusOf(key)]).skipped).toEqual([{ recipe: key, reason: 'spent' }]);

      // A fourth take cannot start, however it is asked for, and sends nothing: paid production cannot loop.
      const fourth = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await fourth.produce(key, false, signal(), true, 4)).toMatchObject({ outcome: 'take_refused' });
      // Asking for the third again reports the job it already is; nothing is sent.
      expect(await fourth.produce(key, false, signal(), true, 3)).toMatchObject({ take: 3, revision: 3 });
      expect(fourth.calls).toHaveLength(0);
      expect(fourth.checks).toHaveLength(0);
      expect((await jobsOf(key)).map((job) => job.take)).toEqual([1, 2, 3]);
    });

    it('does not count the takes of an earlier production version, so a new writer gets fresh ones', async () => {
      await producedAndReleased(key);
      // Pretend an earlier production version made the served Scroll and was then spent on rejections:
      // its three takes are history, not a budget.
      await sql`update content.scroll_production_runs set policy_version = 'scroll-production.v15' where topic = ${key}`.execute(
        database.db,
      );
      await sql`insert into content.scroll_production_runs (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, completed_at)
        select gen_random_uuid(), ${key}, 'scroll-production.v15', take, 2, 1, 'rejected', gen_random_uuid(), now()
        from generate_series(2, 3) as take`.execute(database.db);
      expect(await jobsOf(key)).toHaveLength(3);
      const status = await statusOf(key);
      expect(status).toMatchObject({ state: 'published', takes: 0, takesLeft: 3, regeneration: 'available' });
      expect(planRegeneration([status]).queue).toEqual([{ recipe: key, take: 1 }]);
    });

    it('keeps a revision that an earlier production version left held from being piled on by a new first take', async () => {
      const run = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true });
      await sql`update content.scroll_production_runs set policy_version = 'scroll-production.v15' where topic = ${key}`.execute(
        database.db,
      );
      const status = await statusOf(key);
      expect(status).toMatchObject({ state: 'held', heldRevision: 1, takes: 0 });
      expect(planLibraryProduction([status], { interactiveFirst: false })).toEqual({
        queue: [],
        skipped: [{ recipe: key, reason: 'held' }],
      });
    });

    it('never regenerates a v1 recipe or an order: only a v2 or document v3 library Scroll goes through the read', async () => {
      // The v1 Scroll the library holds for the recipe: stored as the v1 job stored it (`storeV1`, #818); nothing writes a v1 Scroll any more.
      expect(await storeV1(database.db, 'tides')).toMatchObject({ assetId: TOPICS.tides.assetId, revision: 1 });
      expect(await statusOf('tides')).toMatchObject({ state: 'published', regeneration: 'not_v2' });
      expect((await statusOf('tides')).check).toBeUndefined();
      // No take of a recipe with no document v3 plan can start, a regeneration included: refused before any job and any request.
      const v1 = fixtureProduction(database.db, () => answerWith(orrinV3()), orrinResearchFor);
      expect(await v1.produce('tides', false, signal(), true, 2)).toMatchObject({
        outcome: 'plan_refused',
        codes: ['recipe_plan_not_v3'],
      });
      expect(v1.calls).toHaveLength(0);
      expect(await jobsOf('tides')).toHaveLength(1);
    });
  });
});
