import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { fixtureReplyV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/writer-v3.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { markScrollV1, orrinResearchFor } from '../support/scroll-v2.js';

/**
 * A recipe whose misconception source no person has reviewed is refused before any job or request (D-129). The library admits only
 * reviewed labels, so the plan decides it, not the writer. This is the document v3 form of the check the v2 production tests made.
 */
describe('A document v3 recipe whose misconception source is unreviewed (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const planned = TOPICS.greenhouse as { scrollV3?: ScrollV3Plan };
  const before = planned.scrollV3;

  beforeAll(async () => {
    if (before === undefined) throw new Error('CI expected the greenhouse recipe to be a document v3 recipe');
    planned.scrollV3 = {
      ...before,
      misconception: {
        kind: 'myth',
        claim: 'Orrin is warmest because it is closest to its star.',
        source: { label: 'A common idea; its source is still to be named', reviewed: false },
      },
    };
    database = await createTestDatabase<Database>('plan_refusal_v3');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    planned.scrollV3 = before;
    await database.drop();
  });

  it('is refused before any job is reserved or any request is sent, and nothing is stored', async () => {
    const run = fixtureProduction(database.db, () => answerWith(fixtureReplyV3()), orrinResearchFor);
    const result = await run.produce('greenhouse', false, signal());
    expect(result).toMatchObject({ outcome: 'plan_refused', codes: ['misconception_source_unreviewed'] });
    expect(run.calls).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('content.scroll_production_runs')
        .select('id')
        .where('topic', '=', 'greenhouse')
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('content.asset_revisions')
        .select('revision')
        .where('asset_id', '=', TOPICS.greenhouse.assetId)
        .execute(),
    ).toEqual([]);
    // The operator's status and the Quartermaster see a recipe no take can start.
    expect((await readLibraryStatus(database.db, ['greenhouse']))[0]).toMatchObject({ state: 'stopped' });
  });
});

/**
 * The document v3 writer is the only writer (#818), so a code recipe whose plan holds no document v3 plan has no writer: it is refused before
 * any job is reserved or any request is sent, and not left to fail inside the job.
 */
describe('A code recipe with no document v3 plan has no writer (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let undo: () => void = () => undefined;
  beforeAll(async () => {
    undo = markScrollV1('greenhouse');
    database = await createTestDatabase<Database>('plan_refusal_no_v3');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    undo();
    await database.drop();
  });

  it('is refused as recipe_plan_not_v3 before any job or request, and nothing is stored', async () => {
    expect(TOPICS.greenhouse).not.toHaveProperty('scrollV3');
    const run = fixtureProduction(database.db, () => answerWith(fixtureReplyV3()), orrinResearchFor);
    expect(await run.produce('greenhouse', false, signal())).toMatchObject({
      outcome: 'plan_refused',
      codes: ['recipe_plan_not_v3'],
    });
    expect(run.calls).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('content.scroll_production_runs')
        .select('id')
        .where('topic', '=', 'greenhouse')
        .execute(),
    ).toEqual([]);
  });
});
