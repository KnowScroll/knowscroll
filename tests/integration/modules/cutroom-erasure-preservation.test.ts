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
import { receiveFixture, receiveHash } from '../support/commission-receive-fixture.js';
import { experienceUseCases } from '../support/experience.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommissionReceivePayload } from '@knowscroll/backend/modules/content';
import { lockKeepPositionTarget } from '@knowscroll/backend/modules/content/nest-providers';
import { keepPlaceUseCases } from '@knowscroll/backend/modules/experience/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
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

describe('received public output survives full/selective owner erasure (populated PG/media)', () => {
  let f: Awaited<ReturnType<typeof receiveFixture>>, legacy: Awaited<ReturnType<typeof experienceUseCases>>;
  beforeAll(async () => {
    f = await receiveFixture('erase');
    const e = f.envelope!;
    f.bind(e);
    await f.transfer(e);
    expect(await f.service.stage(e)).toEqual({ kind: 'pending' });
    const p = JSON.parse(e.payloadUtf8) as CommissionReceivePayload;
    expect(await f.service.receive({ v: 1, worldId: 'stage', handoffId: p.handoffId })).toMatchObject({
      kind: 'admitted',
    });
    legacy = await experienceUseCases(f.target);
    await applyQueueDeclarations(f.boss, [clearExplorationQueue, recoverClearOperationsQueue]);
  });
  afterAll(async () => {
    await legacy?.close();
    await f?.close();
  });
  it('preserves actual receiving root/receipt/media and exact Saved UUID/ref/fractional place', async () => {
    const p = JSON.parse(f.envelope!.payloadUtf8) as CommissionReceivePayload,
      db = f.target.db,
      scope = makeWithPersonalScope(db, { lockTimeoutMs: 5000 });
    const shared = async () => {
      const result: Record<string, unknown> = {};
      for (const { table } of [...contentCutroomStores, ...reasoningCutroomStores])
        result[table] = (
          await sql<{
            v: unknown;
          }>`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) v from ${sql.table(table)} x`.execute(
            db,
          )
        ).rows[0]!.v;
      result['mediaBytesSha256'] = receiveHash((await readFile(join(f.mediaRoot, p.media.key))).toString('base64'));
      return result;
    };
    const before = await shared();
    expect(before['content.cutroom_receiving_state']).toHaveLength(1);
    expect(before['content.cutroom_receive_receipts']).toHaveLength(1);
    const full = await seedPerson(db);
    await scope(full.authority, (s) => eraseUniverse(s, personalStores));
    expect(await shared()).toEqual(before);
    const person = await seedPerson(db),
      ref = { assetId: p.document.assetId, assetRevision: 1 };
    expect(
      await legacy.applyAction(person.authority, { commandId: randomUUID(), kind: 'save', target: ref }),
    ).toMatchObject({ kind: 'applied' });
    const cases = keepPlaceUseCases({
      withScope: scope,
      fenceOwn: accountAccessUseCases({ db, lockTimeoutMs: 5000 }).fenceOwnAccount,
      target: lockKeepPositionTarget,
    });
    const entry = await cases.readEntry(person.authority, { version: 'keep-place.v1', target: ref });
    if (entry.kind !== 'ok' || entry.value.status !== 'available') throw new Error('FIXTURE_RECEIVED_KEEP');
    expect(
      await cases.setPlace(person.authority, {
        version: 'keep-place.v1',
        commandId: randomUUID(),
        entry: entry.value.entry,
        expectedPlaceRevision: 0,
        position: { kind: 'reel', positionMs: 19167.769 },
      }),
    ).toMatchObject({ kind: 'ok', value: { outcome: 'accepted' } });
    const saved = await db
        .selectFrom('experience.saved_items')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute(),
      places = await db
        .selectFrom('experience.saved_places')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .execute();
    const clear = clearExplorationFor(db, f.boss, {
        reasoning: clearReasoning,
        eraseCore: async (s) => {
          await eraseExploration(s, explorationStores);
        },
      }),
      commandId = randomUUID();
    const started = await clear.start(
      { accountId: person.accountId, universeId: person.universeId, privacyEpoch: 1 },
      {
        version: 'clear-exploration.v1',
        commandId,
        expectedPrivacyEpoch: 1,
        confirmation: 'clear-exploration-preserve-keep-and-social',
      },
    );
    expect(started).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
    await clear.process({ v: 1, accountId: person.accountId, commandId });
    expect(await shared()).toEqual(before);
    expect(
      await db.selectFrom('experience.saved_items').selectAll().where('universe_id', '=', person.universeId).execute(),
    ).toEqual(saved);
    expect(
      await db.selectFrom('experience.saved_places').selectAll().where('universe_id', '=', person.universeId).execute(),
    ).toEqual(places);
  });
});
