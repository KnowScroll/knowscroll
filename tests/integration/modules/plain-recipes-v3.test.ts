import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import { chooseScrollRecipeIn } from '../../../packages/backend/src/modules/content/adapters/production-state.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { markFormerV2Recipe, markScrollV1, orrinResearchFor, plainOrrin } from '../support/scroll-v2.js';

/**
 * The 33 recipes planned as document v3 Scrolls in #790 (the 32 plain v2 recipes and the v1 recipe `exoplanet-kinds`) change nothing a
 * reader is served. A recipe whose current revision is a v1 or v2 Scroll keeps serving it while its plan is v3, reads `not_started` for a v3
 * take (so an operator's `produce-library` run offers one), and is never commissioned by supply: only code recipes with no `scrollV2` and
 * no `scrollV3` are Create's to make. The model is a labelled CI fixture and the Scrolls are the authored fixtures.
 */
describe('Recipes planned as document v3 keep what they serve and are never commissioned by supply (#790; CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('plain_recipes_v3');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const revisionOf = async (key: keyof typeof TOPICS) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', TOPICS[key].assetId)
      .executeTakeFirstOrThrow();
  const standingOf = async (key: 'exoplanet-kinds' | 'seasons-elsewhere') =>
    (await readLibraryStatus(database.db, [key]))[0];
  const chosenFor = (key: 'exoplanet-kinds' | 'seasons-elsewhere') =>
    chooseScrollRecipeIn(database.db, { topicId: RECIPES[key].topicId, facetId: RECIPES[key].facetId });

  it('keeps serving the v1 Scroll of "exoplanet-kinds", reads not_started for a v3 take, and never commissions it', async () => {
    const key = 'exoplanet-kinds';
    // The Scroll the library held before the plan marked the recipe: a v1 revision, published the way a v1 recipe is.
    const undoV1 = markScrollV1(key);
    try {
      const produced = await fixtureProduction(database.db, () =>
        answerWith(fixtureAuthored(writerFormatOf(TOPICS[key]))),
      ).produce(key, false, signal());
      expect(produced).toMatchObject({ outcome: 'published', revision: 1 });
      expect(await standingOf(key)).toMatchObject({ state: 'published', revision: 1 });
      // A v1 recipe is Create's to make; once published it has nothing left to make.
      expect(await chosenFor(key)).toEqual({ kind: 'none' });
    } finally {
      undoV1();
    }
    expect(RECIPES[key].scrollV3).toBeDefined();
    expect(await revisionOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
    expect(await standingOf(key)).toMatchObject({ state: 'not_started', takes: 0 });
    expect(await chosenFor(key)).toEqual({ kind: 'none' });
  });

  it('keeps serving the v2 Scroll of "seasons-elsewhere", reads not_started for a v3 take, and never commissions it', async () => {
    const key = 'seasons-elsewhere';
    // The Scroll the library held before the plan marked the recipe v3: a released v2 revision.
    const undoV2 = markFormerV2Recipe(key);
    try {
      const run = fixtureProduction(database.db, () => answerWith(plainOrrin()), orrinResearchFor);
      expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true, revision: 1 });
      const released = await makeReviewGate(database.db).release({
        assetId: TOPICS[key].assetId,
        revision: 1,
        decidedBy: 'cli:ci-reviewer',
      });
      expect(released).toMatchObject({ kind: 'released', revision: 1 });
      expect(await standingOf(key)).toMatchObject({ state: 'published', revision: 1 });
    } finally {
      undoV2();
    }
    expect(RECIPES[key]).not.toHaveProperty('scrollV2');
    expect(RECIPES[key].scrollV3).toBeDefined();
    expect(await revisionOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
    // Its served v2 Scroll is not a document v3, so the recipe is `not_started` at the v3 production version: a library run offers take 1.
    expect(await standingOf(key)).toMatchObject({ state: 'not_started', takes: 0 });
    expect(await chosenFor(key)).toEqual({ kind: 'none' });
  });
});
