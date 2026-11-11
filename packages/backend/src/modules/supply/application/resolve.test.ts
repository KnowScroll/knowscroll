import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { WAIT_LIMIT_MS } from './commission.js';
import type { Demand, SupplyPorts } from './ports.js';
import { makeResolveRequest } from './resolve.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const LIMIT_MINUTES = WAIT_LIMIT_MS / 60_000;
const REQUEST = '0199a000-0000-7000-8000-000000000001';
const WORK = '0199a000-0000-7000-8000-0000000000a1';
const scope = {
  authority: { universeId: '0199a000-0000-7000-8000-0000000000f1', privacyEpoch: 1 },
  revisionAtEntry: 4,
} as unknown as PersonalScopeTx;

const brief = {
  version: 'supply-brief.v1',
  rights: 'shared_admitted',
  language: 'en',
  format: 'scroll',
  subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: 'earth.tides' },
} as const;

const waiter = (minutes: number, planned: boolean): Demand => ({
  id: REQUEST,
  command: {
    version: 'content-request.v1',
    commandId: '0199a000-0000-7000-8000-0000000000c1',
    intent: {
      kind: 'topic',
      subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: 'earth.tides' },
      format: 'scroll',
    },
    language: 'en',
    capabilities: {},
  } as unknown as Demand['command'],
  brief,
  workId: WORK,
  ...(planned ? { planned: { runId: 'run-1', slot: 0 } } : {}),
  status: planned ? 'deferred' : 'requested',
  decision: 'create',
  requestRevision: 1,
  revision: 3,
  createdAt: minutesAgo(minutes),
  updatedAt: minutesAgo(minutes),
});

/** In-memory ports: what the resolver does when it ends a waiter, without a database. Nothing is admitted. */
function world(demand: Demand, options: { recipe?: string } = {}) {
  const events: string[] = [];
  const ledger: unknown[] = [];
  const finished: Demand[] = [];
  const ports = {
    now: () => NOW,
    withScope: (_authority: unknown, work: (s: PersonalScopeTx) => Promise<unknown>) =>
      work(scope).then((value) => ({ kind: 'entered', value })),
    ownerActive: () => Promise.resolve(true),
    readCandidates: () => Promise.resolve([]),
    lockCurrent: () => Promise.resolve([]),
    readMetUnits: () => Promise.resolve(new Set<string>()),
    store: {
      read: () => Promise.resolve(demand),
      readWork: () =>
        Promise.resolve({ id: WORK, ...(options.recipe === undefined ? {} : { recipe: options.recipe }) }),
      finish: (_scope: unknown, next: Demand) => {
        finished.push(next);
        events.push(`finish ${next.status}`);
        return Promise.resolve();
      },
      closeWork: () => {
        events.push('closeWork');
        return Promise.resolve();
      },
      closeWorkWhenUnused: (_scope: unknown, workId: string, requestId: string) => {
        events.push(
          `closeWorkWhenUnused ${workId === WORK ? 'work' : workId} ${requestId === REQUEST ? 'request' : requestId}`,
        );
        return Promise.resolve();
      },
      lockCommissioning: () => {
        events.push('commission');
        return Promise.resolve();
      },
    },
    readProduction: () => Promise.resolve({ state: 'stopped' }),
    plannedLedger: {
      add: (_scope: unknown, _when: Date, counts: unknown) => {
        events.push('count');
        ledger.push(counts);
        return Promise.resolve();
      },
    },
    advance: () => Promise.resolve(5),
    notify: () => {
      events.push('notify');
      return Promise.resolve();
    },
    enqueue: () => Promise.resolve(),
  } as unknown as SupplyPorts;
  const resolve = () =>
    makeResolveRequest(ports)({ v: 1, universeId: scope.authority.universeId, privacyEpoch: 1, requestId: REQUEST });
  return { resolve, events, ledger, finished };
}

describe('a resolver that ends a waiter', () => {
  it('closes the shared group only when nobody else waits on it, asking about this request alone', async () => {
    const w = world(waiter(LIMIT_MINUTES + 1, false), { recipe: 'tides' });
    await w.resolve();
    expect(w.finished.map((next) => [next.status, next.reason])).toEqual([['unavailable', 'could_not_prepare']]);
    expect(w.events).toEqual(['finish unavailable', 'closeWorkWhenUnused work request', 'notify']);
  });

  it('closes planned demand that outlived its resolver, counts it as expired, and commissions nothing for it', async () => {
    // The group commissioned nothing (as one made before Create did): a waiter in that state used to commission afresh.
    const w = world(waiter(LIMIT_MINUTES + 11, true));
    await w.resolve();
    expect(w.finished.map((next) => [next.status, next.reason])).toEqual([['unavailable', 'could_not_prepare']]);
    expect(w.ledger).toEqual([[{ outcome: 'expired', reason: 'no_resolver', total: 1 }]]);
    expect(w.events).toEqual(['finish unavailable', 'closeWorkWhenUnused work request', 'count', 'notify']);
    expect(w.events).not.toContain('commission');
  });

  it('closes planned demand at its limit without calling it lost: a live resolver is not an expiry', async () => {
    const w = world(waiter(LIMIT_MINUTES + 1, true), { recipe: 'tides' });
    await w.resolve();
    expect(w.finished.map((next) => next.status)).toEqual(['unavailable']);
    expect(w.ledger).toEqual([]);
  });

  it("counts nothing for a person's own ask, however late", async () => {
    const w = world(waiter(LIMIT_MINUTES + 600, false), { recipe: 'tides' });
    await w.resolve();
    expect(w.finished.map((next) => next.status)).toEqual(['unavailable']);
    expect(w.ledger).toEqual([]);
  });
});
