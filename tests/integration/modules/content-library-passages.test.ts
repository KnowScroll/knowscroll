/**
 * The library's prose for a room's daily items (v3 R-5, D-176) over real PostgreSQL: which Scrolls a topic reaches, which are
 * never offered (held, withdrawn, made for a thread, superseded), and the text re-read that proves a cited passage still stands.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import {
  importEditorialScrollUseCase,
  makeReadLibraryPassageText,
  makeReadLibraryPassages,
} from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { starterSource } from '../support/scroll.js';

const PLANET = CONCEPTS.find((concept) => concept.parent === 'computing')!.id;
const OTHER_PLANET = CONCEPTS.find((concept) => concept.parent === 'history')!.id;

describe('the library’s prose for a room (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_library_passages');
  });
  afterAll(async () => {
    await database.drop();
  });

  /** An authored CI Scroll admitted through the real import, with a primary topic. */
  async function scroll(topic: string, title: string, role: 'primary' | 'supporting' = 'primary'): Promise<string> {
    const source = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    const assetId = randomUUID();
    source.assetId = assetId;
    source.publication.explanationUnitId = `ci-library-${assetId.slice(0, 8)}`;
    source.draft.title = title;
    expect((await importEditorialScrollUseCase(database.db)(source)).kind).toBe('imported');
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: assetId, asset_revision: 1, topic_id: topic, role, weight: 0.8 })
      .execute();
    return assetId;
  }

  const read = (kind: 'system' | 'planet', id: string, limit = 100) =>
    makeReadLibraryPassages(database.db)({ kind, id }, limit);
  const idsOf = async (kind: 'system' | 'planet', id: string) => (await read(kind, id)).map((entry) => entry.assetId);

  it('reaches a Scroll by its primary topic: a system covers its planets, a planet is its own, another system’s are not', async () => {
    const assetId = await scroll(PLANET, 'CI fixture Scroll in Computing');
    expect(await idsOf('system', 'computing')).toContain(assetId);
    expect(await idsOf('planet', PLANET)).toContain(assetId);
    expect(await idsOf('system', 'history')).not.toContain(assetId);
    expect(await idsOf('planet', OTHER_PLANET)).not.toContain(assetId);
    expect(await idsOf('planet', 'computing')).toEqual([]);
    expect(await idsOf('system', 'no-such-system')).toEqual([]);
    const found = (await read('planet', PLANET)).find((entry) => entry.assetId === assetId)!;
    expect(found).toMatchObject({ assetRevision: 1, title: 'CI fixture Scroll in Computing' });
    expect(found.summary.length).toBeGreaterThan(0);
    expect(found.blocks.length).toBeGreaterThan(0);
    expect(found.blocks[0]!.text.length).toBeGreaterThan(20);
  });

  it('does not reach a Scroll whose topic is only supporting', async () => {
    const assetId = await scroll(PLANET, 'CI fixture Scroll that only touches Computing', 'supporting');
    expect(await idsOf('system', 'computing')).not.toContain(assetId);
  });

  it('never offers a held revision, a withdrawn Scroll or one made for a thread', async () => {
    const held = await scroll(PLANET, 'CI fixture held Scroll');
    const withdrawn = await scroll(PLANET, 'CI fixture withdrawn Scroll');
    const ordered = await scroll(PLANET, 'CI fixture Scroll made for a thread');
    const open = await scroll(PLANET, 'CI fixture open Scroll');
    await database.db
      .insertInto('content.revision_reviews')
      .values({ asset_id: held, revision: 1, state: 'held' })
      .execute();
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', withdrawn).execute();
    await sql`insert into content.made_to_order_scrolls (recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing)
      values (${'order-' + randomUUID().replaceAll('-', '')}, ${ordered}::uuid, 'ci-order-unit', 'what_if', 'A CI brief.',
        array['https://example.test/ci'], 'What if', '{}'::jsonb)`.execute(database.db);
    const ids = await idsOf('planet', PLANET);
    expect(ids).toContain(open);
    expect(ids).not.toContain(held);
    expect(ids).not.toContain(withdrawn);
    expect(ids).not.toContain(ordered);
    // A released revision is offered again.
    await database.db
      .updateTable('content.revision_reviews')
      .set({ state: 'released', decided_at: new Date(), decided_by: 'ci' })
      .where('asset_id', '=', held)
      .execute();
    expect(await idsOf('planet', PLANET)).toContain(held);
  });

  it('bounds how many Scrolls one read looks at', async () => {
    await expect(read('system', 'computing', 0)).rejects.toThrow('LIBRARY_PASSAGES_LIMIT');
    await expect(read('system', 'computing', 101)).rejects.toThrow('LIBRARY_PASSAGES_LIMIT');
    expect((await read('system', 'computing', 1)).length).toBeLessThanOrEqual(1);
  });

  it('re-reads a block of the current revision, and nothing once the Scroll is corrected, held or the block is gone', async () => {
    const assetId = await scroll(PLANET, 'CI fixture Scroll to correct');
    const found = (await read('planet', PLANET)).find((entry) => entry.assetId === assetId)!;
    const block = found.blocks[0]!;
    const text = makeReadLibraryPassageText(database.db);
    expect(await text({ assetId, assetRevision: 1, blockId: block.blockId })).toBe(block.text);
    expect(await text({ assetId, assetRevision: 1, blockId: 'no-such-block' })).toBeUndefined();
    expect(await text({ assetId: randomUUID(), assetRevision: 1, blockId: block.blockId })).toBeUndefined();
    const corrected = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    corrected.assetId = assetId;
    corrected.publication.explanationUnitId = `ci-library-${assetId.slice(0, 8)}`;
    corrected.draft.title = 'CI fixture Scroll, corrected';
    expect(await importEditorialScrollUseCase(database.db)(corrected)).toMatchObject({ kind: 'imported', revision: 2 });
    expect(await text({ assetId, assetRevision: 1, blockId: block.blockId })).toBeUndefined();
  });
});
