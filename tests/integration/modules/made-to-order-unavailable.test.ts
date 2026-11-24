import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { produceScrollJob } from '@knowscroll/backend/modules/content';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { madeToOrderKey } from '../../../packages/backend/src/modules/content/domain/order-key.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureResearchFor } from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { orrinV3 } from '../support/scroll-v3.js';

/**
 * The Scrolls made to order ("You asked", "What if", "Another perspective") have no writer any more (#818, D-443): the v1 writer is deleted and
 * made to order is switched off everywhere (D-436) until it is rebuilt on the document v3 writer. An order that still reaches production (the
 * switch on, or an old delivery) ends at once as `made_to_order_unavailable`: before any research and before any request, with the code on the
 * job, and nothing is stored. Labelled CI fixtures, real PostgreSQL.
 */
describe('an order that reaches production is refused before any research or request (#818; CI fixture model, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('made_to_order_unavailable');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const order = async (mode: 'question' | 'what_if' | 'perspective') => {
    const recipe = madeToOrderKey(randomUUID());
    const assetId = randomUUID();
    await sql`insert into content.made_to_order_scrolls (recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing)
      values (${recipe}, ${assetId}::uuid, ${recipe}, ${mode}, ${'KIND: a CI order'}, ${[fixtureResearchFor('https://spaceplace.nasa.gov/seasons/en/').url]}::text[], ${'You asked'}, ${JSON.stringify({ kind: 'factual' })}::jsonb)`.execute(
      database.db,
    );
    return { recipe, assetId };
  };

  for (const mode of ['question', 'what_if', 'perspective'] as const) {
    it(`ends a ${mode} order as rejected with made_to_order_unavailable, sending no request, fetching no page and storing no Scroll`, async () => {
      const fetched: string[] = [];
      const worker = fixtureProductionWorker(database, () => answerWith(orrinV3()), {
        research: (url) => {
          fetched.push(url);
          return Promise.resolve(fixtureResearchFor(url));
        },
      });
      const { recipe, assetId } = await order(mode);
      const result = await worker.producer()(recipe, false, signal(), false, 1);
      expect(result).toMatchObject({ outcome: 'rejected', take: 1 });
      expect(worker.fixture.calls).toHaveLength(0);
      expect(fetched).toEqual([]);
      const jobs = await database.db
        .selectFrom('content.scroll_production_runs')
        .select(['state', 'outcomes'])
        .where('topic', '=', recipe)
        .execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.state).toBe('rejected');
      expect(JSON.stringify(jobs[0]!.outcomes)).toContain('made_to_order_unavailable');
      expect(
        await database.db
          .selectFrom('content.asset_revisions')
          .select('revision')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([]);
    });
  }

  it('refuses the same way on a worker delivery with the switch on, and a second delivery of the job does nothing more', async () => {
    const worker = fixtureProductionWorker(database, () => answerWith(orrinV3()));
    const { recipe } = await order('question');
    const delivery = { ...produceScrollJob(recipe), policyVersion: 'scroll-production.v14' };
    const first = await worker.run(delivery, { signal: signal() });
    expect(first).toMatchObject({ kind: 'finished', result: { outcome: 'rejected' } });
    expect(await worker.run(delivery, { signal: signal() })).toMatchObject({
      kind: 'finished',
      result: { outcome: 'rejected' },
    });
    expect(worker.fixture.calls).toHaveLength(0);
    expect(
      (
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select('id')
          .where('topic', '=', recipe)
          .execute()
      ).length,
    ).toBe(1);
  });
});
