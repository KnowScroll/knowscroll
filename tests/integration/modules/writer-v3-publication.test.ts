import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import {
  productionVersionOf,
  SCROLL_PRODUCTION_V3_VERSION,
  TOPICS,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import type { writerPlanFor } from '../../../packages/backend/src/modules/content/production/writer-plan.js';
import { WRITER_V3_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v3-version.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { markScrollV1 } from '../support/scroll-v2.js';
import { V3_FIXTURE_ANSWER } from '../support/writer-v3-plan.js';

// No document v3 writer exists yet. The only seam in the job is the writer plan, so a recipe planned as document v3 gets a
// test plan that stores the hand-written fixture with a `model` production record. Every other recipe keeps its real plan.
// The plan is loaded in `beforeAll`, not inside the mock factory: importing the support code while the factory runs would
// wait on the module the factory is replacing.
const seam = vi.hoisted(() => ({ plan: undefined as undefined | ((input: unknown) => unknown) }));
vi.mock('../../../packages/backend/src/modules/content/production/writer-plan.js', async (importOriginal) => {
  const actual = await importOriginal<{ writerPlanFor: typeof writerPlanFor }>();
  return {
    ...actual,
    writerPlanFor: (input: Parameters<typeof writerPlanFor>[0]) =>
      input.subject.scrollV3 === undefined ? actual.writerPlanFor(input) : seam.plan?.(input),
  };
});

const V3_PLAN: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};

/**
 * Publishing a model-written document v3 library Scroll (#772): it is held for review, gets the topic attribution and the
 * coverage head its lineage earns, is listed and shown to the reviewer, and counts as published only as a v3. The recipe is
 * marked `scrollV3` for this file; the Scroll is scroll-model's hand-written fixture (labelled CI data, never provider output).
 */
describe('A document v3 library recipe is produced, held, attributed and covered (real PostgreSQL; fixture model)', () => {
  const recipe = TOPICS.seasons;
  const key = 'seasons';
  // The plan marks Seasons v2: for this file it is a document v3 recipe instead.
  const restoreV2 = markScrollV1(key);
  let restoreV3: () => void;
  beforeAll(async () => {
    seam.plan = (await import('../support/writer-v3-plan.js')).writerV3TestPlan as (input: unknown) => unknown;
    (RECIPES[key] as { scrollV3?: ScrollV3Plan }).scrollV3 = V3_PLAN;
    restoreV3 = () => delete (RECIPES[key] as { scrollV3?: ScrollV3Plan }).scrollV3;
  });
  afterAll(() => {
    restoreV3();
    restoreV2();
  });

  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('writer_v3_publication');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const produce = async () => {
    const run = fixtureProduction(database.db, () => answerWith(V3_FIXTURE_ANSWER));
    return { run, result: await run.produce(key, false, signal()) };
  };

  it('runs the job at the v3 production version and holds the revision it stores', async () => {
    expect(productionVersionOf(key)).toBe(SCROLL_PRODUCTION_V3_VERSION);
    const { run, result } = await produce();
    expect(result).toMatchObject({ outcome: 'published', assetId: recipe.assetId, revision: 1, held: true });
    // One writer request; the answer check of a document v3 has no calls and sends nothing.
    expect(run.calls).toHaveLength(1);
    expect(run.checks).toHaveLength(0);
    const job = await database.db
      .selectFrom('content.scroll_production_runs')
      .select(['policy_version', 'state'])
      .where('topic', '=', key)
      .executeTakeFirstOrThrow();
    expect(job).toEqual({ policy_version: SCROLL_PRODUCTION_V3_VERSION, state: 'published' });
    const stored = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_version', 'provenance_kind'])
      .where('asset_id', '=', recipe.assetId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ document_version: SCROLL_DOCUMENT_V3_SCHEMA_VERSION, provenance_kind: 'generated' });
    expect(
      await database.db
        .selectFrom('content.revision_reviews')
        .select('state')
        .where('asset_id', '=', recipe.assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'held' });
  });

  it('verifies the lineage: the receipt is not attribution_unverified, the topic is attributed and a coverage head exists', async () => {
    const { result } = await produce();
    expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_unverified' }));
    expect(result.attempts).not.toContainEqual(expect.objectContaining({ code: 'attribution_conflict' }));
    expect(
      await database.db
        .selectFrom('content.encounter_topics')
        .select(['topic_id', 'role', 'weight'])
        .where('asset_id', '=', recipe.assetId)
        .execute(),
    ).toEqual([{ topic_id: recipe.topicId, role: 'primary', weight: 1 }]);
    const heads = await database.db
      .selectFrom('content.coverage_heads')
      .select(['asset_id', 'asset_revision'])
      .where('asset_id', '=', recipe.assetId)
      .execute();
    expect(heads).toEqual([{ asset_id: recipe.assetId, asset_revision: 1 }]);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', recipe.assetId)
      .executeTakeFirstOrThrow();
    expect((provenance.provenance as { production: { promptVersion: string } }).production.promptVersion).toBe(
      WRITER_V3_PROMPT_VERSION,
    );
  });

  it('lists the held revision for the reviewer and shows it with the passages each part cites', async () => {
    await produce();
    const gate = makeReviewGate(database.db);
    const listed = await gate.list({ all: false });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      assetId: recipe.assetId,
      recipe: key,
      revision: 1,
      state: 'held',
      coverage: 'mapped',
      calls: 0,
      hasPicture: true,
    });
    expect(listed[0]?.v3?.beats).toBeGreaterThan(0);
    expect(Object.keys(listed[0]?.v3?.pictures ?? {}).length).toBeGreaterThan(0);

    const shown = await gate.show({ assetId: recipe.assetId, withSources: true });
    if (shown.kind !== 'shown') throw new Error('CI expected the text');
    expect(shown.text).toContain('TO SUM UP');
    expect(shown.text).toContain('PICTURE [');
    expect(shown.text).toContain('> source passage:');
    expect(shown.text).toContain('SOURCES');
  });

  it('reads the recipe as held, then as published and open to a new take only once the v3 revision is released', async () => {
    await produce();
    expect((await readLibraryStatus(database.db, [key]))[0]).toMatchObject({ state: 'held', job: 'held' });
    const gate = makeReviewGate(database.db);
    // The coverage head exists, so the release guard for a document v3 lets it go.
    expect(await gate.release({ assetId: recipe.assetId, revision: 1, decidedBy: 'cli:ci-reviewer' })).toMatchObject({
      kind: 'released',
    });
    expect((await readLibraryStatus(database.db, [key]))[0]).toMatchObject({
      state: 'published',
      assetId: recipe.assetId,
      revision: 1,
      regeneration: 'available',
      takesLeft: 2,
    });
  });
});
