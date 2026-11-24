import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { ScrollProvenance } from '@knowscroll/scroll-model/internal';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v1-version.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { storeV1 } from '../support/stored-v1.js';

/**
 * The stored `scroll-document.v1` revision the tests of what still reads one use (#818): what `storeV1` writes is a library Scroll the way the
 * v1 job stored it (kind `generated`, a model production record, reading facts, the recipe's planet and its coverage head, a published job row),
 * written through admission and never through a writer. A labelled CI fixture, not product content.
 */
describe('storeV1 stores a v1 library revision as the v1 job stored it (labelled CI fixture, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('stored_v1');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('stores revision 1 served at once with generated provenance, reading facts, a job row and an active coverage head', async () => {
    const recipe = TOPICS.tides;
    const stored = await storeV1(database.db, 'tides');
    expect(stored).toMatchObject({ assetId: recipe.assetId, revision: 1 });
    const revision = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_version', 'provenance_kind', 'explanation_unit_id', 'reading_facts'])
      .where('asset_id', '=', recipe.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    expect(revision).toMatchObject({
      document_version: 'scroll-document.v1',
      provenance_kind: 'generated',
      explanation_unit_id: recipe.explanationUnitId,
    });
    expect((revision.reading_facts as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', recipe.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    expect(ScrollProvenance.parse(provenance.provenance).production).toMatchObject({
      kind: 'model',
      promptVersion: WRITER_PROMPT_VERSION,
    });
    expect(
      await database.db
        .selectFrom('content.assets')
        .select(['status', 'revision'])
        .where('id', '=', recipe.assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'admitted', revision: 1 });
    expect(
      await database.db
        .selectFrom('content.scroll_production_runs')
        .select(['state', 'target_revision'])
        .where('topic', '=', 'tides')
        .execute(),
    ).toEqual([{ state: 'published', target_revision: 1 }]);
    expect(
      await database.db
        .selectFrom('content.coverage_revisions')
        .select(['asset_revision', 'status'])
        .where('asset_id', '=', recipe.assetId)
        .execute(),
    ).toEqual([{ asset_revision: 1, status: 'active' }]);
  });

  it('stores a later revision as the next one, and a held one beside the served revision', async () => {
    const recipe = TOPICS.tides;
    expect(await storeV1(database.db, 'tides', { held: true })).toMatchObject({ revision: 2 });
    expect(
      await database.db
        .selectFrom('content.assets')
        .select(['status', 'revision'])
        .where('id', '=', recipe.assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'admitted', revision: 1 });
  });
});
