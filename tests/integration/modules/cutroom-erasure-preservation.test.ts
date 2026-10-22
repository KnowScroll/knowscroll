import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentCutroomStores } from '@knowscroll/backend/modules/content/nest-providers';
import { reasoningCutroomStores, clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { eraseUniverse, eraseExploration } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores, explorationStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { applyQueueDeclarations } from '@knowscroll/backend/infrastructure/jobs';
import { seedPerson } from '../support/fixtures.js';
import {
  commissionFixture,
  fixturePublishedCommission,
  type CommissionFixture,
} from '../support/commission-fixture.js';
// Authored synthetic public media/script and actual disposable PG. No owner data/provider.
describe('full and selective erasure preserve concrete world-owned commissioning stores', () => {
  let f: CommissionFixture;
  let x: Awaited<ReturnType<typeof fixturePublishedCommission>>;
  beforeAll(async () => {
    f = await commissionFixture('worldpreserve');
    x = await fixturePublishedCommission(f, 'worldpreserve');
    expect(await x.financial.process(x.c.target, x.published.operationId)).toBe('confirmed');
    await applyQueueDeclarations(f.boss, [clearExplorationQueue, recoverClearOperationsQueue]);
  });
  afterAll(async () => {
    await x?.close();
    await f?.close();
  });
  async function shared() {
    const rows: Record<string, unknown> = {};
    for (const { table } of [...contentCutroomStores, ...reasoningCutroomStores])
      rows[table] = (
        await sql<{
          rows: unknown;
        }>`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${sql.table(table)} t`.execute(
          f.world.db,
        )
      ).rows[0]!.rows;
    return rows;
  }
  it('asserts all five new stores populated and identical across both actual owner erasers; selective keeps Saved', async () => {
    const before = await shared();
    for (const table of [
      'content.cutroom_publications',
      'reasoning.cutroom_financial_reports',
      'reasoning.cutroom_settlements',
      'reasoning.cutroom_settlement_receipts',
      'reasoning.cutroom_maintenance',
    ])
      expect(before[table], table).toHaveLength(1);
    const full = await seedPerson(f.world.db);
    const scope = makeWithPersonalScope(f.world.db, { lockTimeoutMs: 5000 });
    await scope(full.authority, (tx) => eraseUniverse(tx, personalStores));
    expect(await shared()).toEqual(before);
    const p = await seedPerson(f.world.db),
      savedId = randomUUID();
    await f.world.db
      .insertInto('experience.saved_items')
      .values({
        saved_entry_id: savedId,
        universe_id: p.universeId,
        asset_id: x.published.assetId,
        asset_revision: 1,
        saved_at: new Date(),
      })
      .execute();
    const savedBefore = await f.world.db
      .selectFrom('experience.saved_items')
      .selectAll()
      .where('saved_entry_id', '=', savedId)
      .execute();
    const clear = clearExplorationFor(f.world.db, f.boss, {
        reasoning: clearReasoning,
        eraseCore: async (tx) => {
          await eraseExploration(tx, explorationStores);
        },
      }),
      commandId = randomUUID();
    expect(
      await clear.start(
        { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 },
        {
          version: 'clear-exploration.v1',
          commandId,
          expectedPrivacyEpoch: 1,
          confirmation: 'clear-exploration-preserve-keep-and-social',
        },
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
    await clear.process({ v: 1, accountId: p.accountId, commandId });
    expect(await shared()).toEqual(before);
    expect(
      await f.world.db.selectFrom('experience.saved_items').selectAll().where('saved_entry_id', '=', savedId).execute(),
    ).toEqual(savedBefore);
    expect((await f.owner.query('select state,spent_cents from public.pool_order')).rows).toEqual([
      { state: 'settled', spent_cents: 34 },
    ]);
  });
});
