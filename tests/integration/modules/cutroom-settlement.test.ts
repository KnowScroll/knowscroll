import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeCommissionChainSnapshots,
  postgresCommissionChainStore,
  financialReportOfSnapshot,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  makeCutroomSettlement,
  postgresCutroomSettlement,
  makeEnqueueCutroom,
  makeEnqueueCutroomMaintenance,
  makeCutroomSettlementPool,
} from '@knowscroll/backend/reasoning/nest-providers';
import { cutroomSettleQueue, recoverCutroomQueue } from '@knowscroll/backend/reasoning';
import { applyQueueDeclarations } from '@knowscroll/backend/infrastructure/jobs';
import {
  commissionFixture,
  fixtureDispatchedCommission,
  fixtureClosedCommissionChain,
  installCutroomEvidenceFixture,
  type CommissionFixture,
} from '../support/commission-fixture.js';
// Disposable actual world/pool PG and pg-boss. No provider, real grant or owner corpus.
describe('stable exact evidence-only Cutroom accounting (actual isolated PG)', () => {
  let f: CommissionFixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });
  async function fixture(cost = 34, childCost?: number) {
    f = await commissionFixture('financial');
    const pin = await installCutroomEvidenceFixture(f);
    await applyQueueDeclarations(f.boss, [cutroomSettleQueue, recoverCutroomQueue]);
    const c = await fixtureDispatchedCommission(f, 'financial', 1);
    const snapshots = makeCommissionChainSnapshots({
      enabled: true,
      withAccountingScope: c.accounting,
      execution: c.execution,
      store: postgresCommissionChainStore(),
    });
    const stored = await snapshots.recordCollectedChain(c.target, fixtureClosedCommissionChain(c, { cost, childCost }));
    if (stored.kind === 'refused') throw new Error('FIXTURE_SNAPSHOT');
    const s = await snapshots.readSnapshot(c.target, {
      snapshotId: stored.snapshotId,
      snapshotSha256: stored.snapshotSha256,
    });
    if (s.kind !== 'snapshot') throw new Error('FIXTURE_READ');
    const pool = makeCutroomSettlementPool(() => f!.pool.connect(), { evidenceFunctionSha256: pin });
    const store = postgresCutroomSettlement(makeEnqueueCutroom(f.boss), makeEnqueueCutroomMaintenance(f.boss));
    const service = makeCutroomSettlement({ enabled: true, withAccountingScope: c.accounting, pool, store });
    const authority = await c.accounting(c.target, (scope) => Promise.resolve(scope.identity));
    if (authority.kind !== 'entered') throw new Error('FIXTURE_IDENTITY');
    return { c, s, pool, store, service, report: financialReportOfSnapshot(s), pin, identity: authority.value };
  }
  it('records exact original+child actual above ceiling, holds the WHOLE claim, never settles and replays one report', async () => {
    const x = await fixture(34, 20),
      { c, service, report } = x;
    const id = await service.recordHold(c.target, x.s.snapshotId, report);
    expect(id).toBeTruthy();
    expect(await service.process(c.target, id!)).toBe('confirmed');
    expect(await service.process(c.target, id!)).toBe('confirmed');
    const order = (
      await f!.owner.query<{ state: string; ceiling_cents: number; spent_cents: number | null }>(
        'select state,ceiling_cents,spent_cents from public.pool_order where request_id=$1',
        [report.requestId],
      )
    ).rows[0];
    expect(order).toEqual({ state: 'claimed', ceiling_cents: 1, spent_cents: null });
    const evidence = (
      await f!.owner.query<{ reported_outcome: string; reported_cents: string; satisfied: boolean }>(
        'select reported_outcome,reported_cents::text,satisfied from public.pool_v2_settlement_evidence where request_id=$1',
        [report.requestId],
      )
    ).rows;
    expect(evidence).toEqual([{ reported_outcome: 'failed', reported_cents: '54', satisfied: false }]);
    const total = (
      await f!.pool.query<{ accounting_hold: boolean; grant_effective_cents: string }>(
        'select * from public.pool_v2_grant_status($1)',
        ['knowscroll-v2-d018'],
      )
    ).rows[0]!;
    expect(total.accounting_hold).toBe(true);
    expect(String(total.grant_effective_cents)).toBe('54');
    expect(
      (await sql<{ n: number }>`select count(*)::int n from reasoning.cutroom_settlements`.execute(f!.world.db))
        .rows[0]!.n,
    ).toBe(0);
    const changedTime = {
      ...x.s,
      header: {
        ...x.s.header,
        collection: { ...x.s.header.collection, observedAtMs: x.s.header.collection.observedAtMs + 100 },
      },
    };
    expect(financialReportOfSnapshot(changedTime)).toEqual(report);
  });
  it('rejects forged costs/receipt and foreign op before pool send; missing or wrong function pin cannot activate', async () => {
    const x = await fixture();
    expect(await x.pool.available(x.identity)).toBe(true);
    expect(await x.pool.available({ ...x.identity, worldId: 'stage' })).toBe(false);
    const wrong = makeCutroomSettlementPool(() => {
      throw new Error('must not connect');
    });
    expect(await wrong.available(x.c.target as never)).toBe(false);
    expect(await x.service.recordHold(x.c.target, x.s.snapshotId, { ...x.report, actualCents: 0 })).toBeUndefined();
    await expect(
      x.service.recordHold(x.c.target, x.s.snapshotId, {
        ...x.report,
        runs: x.report.runs.map((r) => ({ ...r, ownCostCents: 0 })),
        actualCents: 0,
      }),
    ).rejects.toThrow('cutroom_financial_identity');
    const id = await x.service.recordHold(x.c.target, x.s.snapshotId, x.report);
    expect(id).toBeTruthy();
    expect(await x.service.process({ ...x.c.target, businessRunId: randomUUID() }, id!)).toBe('held');
    expect(await x.service.process(x.c.target, randomUUID())).toBe('held');
    expect(
      (await f!.owner.query<{ n: number }>('select count(*)::int n from public.pool_v2_settlement_evidence')).rows[0]!
        .n,
    ).toBe(0);
    expect(
      await makeCutroomSettlementPool(() => f!.pool.connect(), { evidenceFunctionSha256: '0'.repeat(64) }).available(
        x.identity,
      ),
    ).toBe(false);
  });
  it('allows truthful old liability after disable/retire without a new claim and survives a lost hold COMMIT ACK', async () => {
    const x = await fixture(0);
    await f!.owner.query('select public.pool_v2_admin_gate(false,true)');
    const id = await x.service.recordHold(x.c.target, x.s.snapshotId, x.report);
    let lose = true;
    const lost = makeCutroomSettlementPool(
      async () => {
        const client = await f!.pool.connect(),
          query = client.query.bind(client);
        client.query = (async (text: unknown, ...values: unknown[]) => {
          const result = await (query as (...a: unknown[]) => Promise<unknown>)(text, ...values);
          if (text === 'commit' && lose) {
            lose = false;
            throw new Error('fixture-lost-ack-private-canary');
          }
          return result;
        }) as typeof client.query;
        return client;
      },
      { evidenceFunctionSha256: x.pin },
    );
    const service = makeCutroomSettlement({
      enabled: true,
      withAccountingScope: x.c.accounting,
      pool: lost,
      store: x.store,
    });
    expect(await service.process(x.c.target, id!)).toBe('held');
    expect(await x.service.process(x.c.target, id!)).toBe('confirmed');
    expect(
      (
        await f!.owner.query(
          'select count(*)::int n,bool_and(not satisfied) pending from public.pool_v2_settlement_evidence',
        )
      ).rows[0],
    ).toEqual({ n: 1, pending: true });
    expect((await f!.owner.query<{ state: string }>('select state from public.pool_order')).rows[0]!.state).toBe(
      'claimed',
    );
  });
});
