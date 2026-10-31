/**
 * The library's calls for a room's Launch (v3 R-6, D-179) over real PostgreSQL: a `scroll-document.v2` revision that anyone may be
 * served reaches a room through its topic with the question, options, key and reason of each call as its authors wrote them, and a
 * held revision, a withdrawn Scroll and a Scroll made for a thread reach no one. The Scroll is the authored CI fixture (Orrin),
 * published as production does and released by an operator; never provider output or product content.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReadLibraryCalls, makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { callsOfRevision } from '../support/play.js';

describe('the library’s calls for a room (real PostgreSQL, labelled CI fixture)', () => {
  let database: TestDatabase<Database>;
  const scroll = { assetId: TOPICS.seasons.assetId, revision: 1 };

  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_library_calls');
    await enableProductionScope(database.db);
    const production = fixtureProduction(
      database.db,
      () => answerWith(fixtureAuthoredV2()),
      () => fixtureResearchPageV2,
    );
    expect(await production.produce('seasons', false, signal())).toMatchObject({ outcome: 'published', held: true });
  });
  afterAll(async () => {
    await database.drop();
  });

  const read = (id: string, kind: 'system' | 'planet' = 'system', only?: { assetId: string; assetRevision: number }) =>
    makeReadLibraryCalls(database.db)({ kind, id }, 100, only);
  /** The system the Scroll's primary topic belongs to. */
  const systemOfScroll = async () =>
    (
      await sql<{ topic_id: string }>`select topic_id from content.encounter_topics
        where asset_id = ${scroll.assetId}::uuid and asset_revision = ${scroll.revision} and role = 'primary'`.execute(
        database.db,
      )
    ).rows[0]!.topic_id;

  it('offers nothing while a revision is held, and its calls once an operator releases it', async () => {
    const topic = await systemOfScroll();
    const system = topic.split('.')[0]!;
    expect((await read(system)).filter((source) => source.assetId === scroll.assetId)).toEqual([]);
    expect(await makeReviewGate(database.db).release({ ...scroll, decidedBy: 'cli:ci-reviewer' })).toMatchObject({
      kind: 'released',
    });
    const found = (await read(system)).find((source) => source.assetId === scroll.assetId);
    expect(found).toMatchObject({ assetRevision: 1 });
    const authored = (await callsOfRevision(database, scroll)).map((call) => ({
      stopId: call.id,
      prompt: call.prompt,
      options: call.options,
      answer: call.answer,
      explain: call.explain,
    }));
    expect(authored.length).toBeGreaterThanOrEqual(2);
    // The calls are read as the authors wrote them: nothing is changed, shortened or invented.
    expect(found?.calls).toEqual(authored);
  });

  it('reaches the Scroll by its topic only, and by its exact revision for a check', async () => {
    const system = (await systemOfScroll()).split('.')[0]!;
    expect((await read(system, 'planet', undefined)).length).toBe(0);
    expect(
      (await read(system, 'system', { assetId: scroll.assetId, assetRevision: 1 })).map((source) => source.assetId),
    ).toEqual([scroll.assetId]);
    expect(await read(system, 'system', { assetId: scroll.assetId, assetRevision: 2 })).toEqual([]);
    expect(await read('no-such-system')).toEqual([]);
    await expect(makeReadLibraryCalls(database.db)({ kind: 'system', id: system }, 0)).rejects.toThrow(
      'LIBRARY_CALLS_LIMIT',
    );
    await expect(makeReadLibraryCalls(database.db)({ kind: 'system', id: system }, 101)).rejects.toThrow(
      'LIBRARY_CALLS_LIMIT',
    );
  });

  it('stops offering a Scroll that was withdrawn or held again', async () => {
    const system = (await systemOfScroll()).split('.')[0]!;
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', scroll.assetId)
      .execute();
    expect((await read(system)).map((source) => source.assetId)).not.toContain(scroll.assetId);
    await database.db
      .updateTable('content.assets')
      .set({ status: 'admitted' })
      .where('id', '=', scroll.assetId)
      .execute();
    expect((await read(system)).map((source) => source.assetId)).toContain(scroll.assetId);
    await database.db.deleteFrom('content.revision_reviews').where('asset_id', '=', scroll.assetId).execute();
    await database.db
      .insertInto('content.revision_reviews')
      .values({ asset_id: scroll.assetId, revision: 1, state: 'held' })
      .execute();
    expect((await read(system)).map((source) => source.assetId)).not.toContain(scroll.assetId);
  });
});
