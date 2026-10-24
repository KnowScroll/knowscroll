import { describe, expect, it } from 'vitest';
import type { MadeToOrderScroll } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { makeCommissionScenarioOrder, type ScenarioOrderStore } from './scenario-orders.js';

const scope = {} as PersonalScopeTx;
const order = (id: string): MadeToOrderScroll => ({
  orderId: id,
  assetId: `asset-${id}`,
  mode: 'what_if',
  brief: 'KIND: What if',
  pages: ['https://example.org/a'],
  kicker: 'What if',
  framing: { kind: 'hypothetical', assumptions: ['Traffic is ten times higher'], kept: [] },
});

/** In-memory ledger and ports: the use case's rules, without a database. */
function world(caps: { perDay: number; perThread: number }, now = new Date('2026-10-24T10:00:00Z')) {
  const rows: { orderId: string; threadId: string; createdAt: Date }[] = [];
  const recorded: string[] = [];
  const sent: [string, number][] = [];
  const events: string[] = [];
  const store: ScenarioOrderStore = {
    lockCommissioning: () => {
      events.push('lock');
      return Promise.resolve();
    },
    countSince: (_, since) => Promise.resolve(rows.filter((row) => row.createdAt >= since).length),
    countForThread: (_, threadId) => Promise.resolve(rows.filter((row) => row.threadId === threadId).length),
    insert: (_, row) => {
      rows.push({ ...row, createdAt: now });
      return Promise.resolve();
    },
  };
  const commission = makeCommissionScenarioOrder({
    store,
    recordOrder: (_, input) => {
      recorded.push(input.orderId);
      return Promise.resolve({ recipe: `order-${input.orderId}` });
    },
    enqueueProduction: (_, recipe, take) => {
      sent.push([recipe, take]);
      return Promise.resolve();
    },
    caps,
    now: () => now,
  });
  return { commission, rows, recorded, sent, events };
}

describe('Quartermaster scenario Create', () => {
  it('records the order, the ledger row and the first production job together, after taking the lock', async () => {
    const w = world({ perDay: 5, perThread: 5 });
    const outcome = await w.commission(scope, { threadId: 't1', order: order('n1') });
    expect(outcome).toEqual({ kind: 'commissioned', recipe: 'order-n1' });
    expect(w.events).toEqual(['lock']);
    expect(w.recorded).toEqual(['n1']);
    expect(w.sent).toEqual([['order-n1', 1]]);
    expect(w.rows).toHaveLength(1);
  });

  it('stops at the day’s cap and writes nothing', async () => {
    const w = world({ perDay: 2, perThread: 9 });
    await w.commission(scope, { threadId: 't1', order: order('n1') });
    await w.commission(scope, { threadId: 't2', order: order('n2') });
    expect(await w.commission(scope, { threadId: 't3', order: order('n3') })).toEqual({
      kind: 'refused',
      reason: 'day_cap',
    });
    expect(w.rows).toHaveLength(2);
    expect(w.sent).toHaveLength(2);
  });

  it('is off when the day’s cap is zero', async () => {
    const w = world({ perDay: 0, perThread: 9 });
    expect(await w.commission(scope, { threadId: 't1', order: order('n1') })).toEqual({
      kind: 'refused',
      reason: 'day_cap',
    });
    expect(w.recorded).toEqual([]);
  });

  it('stops at the thread’s cap, and another thread is not affected', async () => {
    const w = world({ perDay: 9, perThread: 1 });
    await w.commission(scope, { threadId: 't1', order: order('n1') });
    expect(await w.commission(scope, { threadId: 't1', order: order('n2') })).toEqual({
      kind: 'refused',
      reason: 'thread_cap',
    });
    expect(await w.commission(scope, { threadId: 't2', order: order('n3') })).toMatchObject({ kind: 'commissioned' });
  });
});
