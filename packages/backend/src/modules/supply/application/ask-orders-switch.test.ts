import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { advanceAskOrder } from './ask-resolve.js';
import { commissionAskOrder } from './ask-orders.js';
import { reopenedAskOrder } from './ask-retry.js';
import type { Demand, SupplyPorts } from './ports.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const REQUEST = '0199a000-0000-7000-8000-000000000001';
const ORDER = '0199a000-0000-7000-8000-0000000000b1';
const scope = {
  authority: { universeId: '0199a000-0000-7000-8000-0000000000f1', privacyEpoch: 1 },
  revisionAtEntry: 4,
} as unknown as PersonalScopeTx;

const waiter: Demand & { askOrder: NonNullable<Demand['askOrder']> } = {
  id: REQUEST,
  command: {
    version: 'content-request.v1',
    commandId: '0199a000-0000-7000-8000-0000000000c1',
    intent: { kind: 'ask' },
    language: 'en',
    capabilities: {},
  } as unknown as Demand['command'],
  askOrder: { orderId: ORDER, assetId: '0199a000-0000-7000-8000-0000000000b2' },
  status: 'requested',
  decision: 'create',
  requestRevision: 1,
  revision: 3,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

/** Ports that fail the test the moment anything beyond the switch is touched: the order must be refused before every other step. */
function world(madeToOrderEnabled: boolean) {
  const touched: string[] = [];
  const finished: Demand[] = [];
  const touch = (name: string) => () => {
    touched.push(name);
    return Promise.reject(new Error(`CI: ${name} must not run while the switch is off`));
  };
  const ports = {
    madeToOrderEnabled,
    now: () => NOW,
    askCaps: { perDay: 20, perPersonPerDay: 5 },
    store: {
      lockCommissioning: touch('lockCommissioning'),
      finish: (_scope: unknown, next: Demand) => {
        finished.push(next);
        return Promise.resolve();
      },
    },
    lockCurrent: () => Promise.resolve([]),
    readOrderProduction: touch('readOrderProduction'),
    readSourcePages: touch('readSourcePages'),
    recordOrder: touch('recordOrder'),
    enqueueAnswerProduction: touch('enqueueAnswerProduction'),
    askLedger: {
      insert: touch('askLedger.insert'),
      markReady: touch('askLedger.markReady'),
      // The status read behind a closed request asks the ledger for the "usually" time: a read, not an order.
      recentWaitsSeconds: () => Promise.resolve([]),
    },
    advance: () => Promise.resolve(5),
    notify: () => Promise.resolve(),
  } as unknown as SupplyPorts;
  return { ports, touched, finished };
}

describe('ask orders and the made-to-order switch (D-436)', () => {
  it('makes no order while the switch is off: the answer is the off limit, and no lock, page or job is touched', async () => {
    const w = world(false);
    const outcome = await commissionAskOrder(w.ports, scope, {
      source: { exposureId: 'x', assetId: 'y', assetRevision: 1 } as never,
      facts: { title: 'T', stopText: 'S', suggestions: [] },
      question: 'Why?',
    });
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'budget_unavailable', limit: 'off' });
    expect(w.touched).toEqual([]);
  });

  it('does not try an ask order again while the switch is off, and reads nothing of its production', async () => {
    const w = world(false);
    expect(await reopenedAskOrder(w.ports, scope, waiter, 2)).toBeUndefined();
    expect(w.touched).toEqual([]);
  });

  it('closes a waiting ask order as switched off instead of advancing it, without reading its production', async () => {
    const w = world(false);
    await advanceAskOrder(w.ports, scope, waiter);
    expect(w.touched).toEqual([]);
    expect(w.finished).toHaveLength(1);
    expect(w.finished[0]).toMatchObject({
      id: REQUEST,
      status: 'unavailable',
      reason: 'budget_unavailable',
      askLimit: 'off',
      revision: 5,
    });
  });
});
