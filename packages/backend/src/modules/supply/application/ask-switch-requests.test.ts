import { describe, expect, it, vi } from 'vitest';
import type { CreateContentRequest } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { makeMatchRequest } from './matching.js';
import { makeCreateRequest } from './requests.js';
import type { Demand, SupplyPorts } from './ports.js';

/**
 * A typed question from a Scroll while the made-to-order switch is off (D-436): it closes as switched off at create, before any
 * matching job exists, and one already waiting closes the same way before any model call, so nothing is paid for it.
 */
const NOW = new Date('2026-11-23T12:00:00.000Z');
const REQUEST = '0199a000-0000-7000-8000-000000000001';
const scope = {
  authority: { universeId: '0199a000-0000-7000-8000-0000000000f1', privacyEpoch: 1 },
  revisionAtEntry: 4,
} as unknown as PersonalScopeTx;
const source = {
  exposureId: '0199a000-0000-7000-8000-0000000000e1',
  assetId: '0199a000-0000-7000-8000-0000000000a1',
  assetRevision: 1,
};
const typed = {
  version: 'content-request.v1',
  commandId: '0199a000-0000-7000-8000-0000000000c1',
  intent: {
    kind: 'ask',
    source,
    anchor: { kind: 'stop', stopId: 'stop-one' },
    question: 'Why is the far side of Orrin cold?',
    recordingGeneration: 1,
  },
  language: 'en',
  capabilities: { documentSchemas: ['scroll-document.v2'], blocks: { fallback: [1] } },
} as unknown as CreateContentRequest;

const forbidden = (name: string) =>
  vi.fn(() => Promise.reject(new Error(`CI: ${name} must not run while the switch is off`)));

describe('a typed question and the made-to-order switch (D-436)', () => {
  it('closes at create as switched off: no matching job, no model, no order', async () => {
    const inserted: Demand[] = [];
    const enqueue = forbidden('enqueue');
    const ports = {
      madeToOrderEnabled: false,
      now: () => NOW,
      newId: () => REQUEST,
      withScope: (_a: unknown, work: (s: PersonalScopeTx) => Promise<unknown>) =>
        work(scope).then((value) => ({ kind: 'entered', value })),
      receipts: {
        find: () => Promise.resolve({ kind: 'new' }),
        insert: () => Promise.resolve(),
        complete: () => Promise.resolve(),
      },
      store: {
        countOpenPersonDemands: () => Promise.resolve(0),
        insert: (_s: unknown, d: Demand) => {
          inserted.push(d);
          return Promise.resolve();
        },
        lockCommissioning: forbidden('lockCommissioning'),
      },
      fenceRecording: () => Promise.resolve({ kind: 'recording' }),
      checkSource: () => Promise.resolve(true),
      readAskFacts: () =>
        Promise.resolve({ title: 'Orrin', stopText: 'It is cold.', suggestions: ['Why is Orrin tilted?'] }),
      readExact: () => Promise.resolve(undefined),
      catalogue: { current: () => Promise.resolve({ releaseId: 1 }) },
      lockCurrent: () => Promise.resolve([{ ref: source, encounter: {}, availabilityRevision: 1 }]),
      readSourcePages: forbidden('readSourcePages'),
      recordOrder: forbidden('recordOrder'),
      enqueueAnswerProduction: forbidden('enqueueAnswerProduction'),
      advance: () => Promise.resolve(5),
      notify: () => Promise.resolve(),
      enqueue,
    } as unknown as SupplyPorts;
    await makeCreateRequest(ports)(
      { universeId: scope.authority.universeId, privacyEpoch: 1, actor: { kind: 'account', accountId: 'a' } } as never,
      typed,
    ).catch(() => undefined);
    expect(enqueue).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable', askLimit: 'off' });
  });

  it('closes a question already waiting before any harness call: no scope step, no library check', async () => {
    const finished: Demand[] = [];
    const waiting: Demand = {
      id: REQUEST,
      command: typed,
      status: 'matching',
      decision: 'pending',
      requestRevision: 1,
      revision: 3,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const harness = new Proxy({}, { get: () => forbidden('the harness') });
    const ports = {
      madeToOrderEnabled: false,
      now: () => NOW,
      withScope: (_a: unknown, work: (s: PersonalScopeTx) => Promise<unknown>) =>
        work(scope).then((value) => ({ kind: 'entered', value })),
      ownerActive: () => Promise.resolve(true),
      readAskFacts: () => Promise.resolve({ title: 'Orrin', stopText: 'It is cold.', suggestions: [] }),
      catalogue: { current: forbidden('catalogue'), release: forbidden('catalogue') },
      lockCurrent: () => Promise.resolve([]),
      store: {
        read: () => Promise.resolve(waiting),
        finish: (_s: unknown, d: Demand) => {
          finished.push(d);
          return Promise.resolve();
        },
      },
      askLedger: { recentWaitsSeconds: () => Promise.resolve([]) },
      advance: () => Promise.resolve(5),
      notify: () => Promise.resolve(),
    } as unknown as SupplyPorts;
    const recording = {
      harness,
      fenceOwn: () => Promise.resolve({ kind: 'active', owner: { accountId: 'a' } }),
    } as never;
    await makeMatchRequest(
      ports,
      recording,
      forbidden('readLibrary'),
    )(
      { v: 1, universeId: scope.authority.universeId, privacyEpoch: 1, requestId: REQUEST },
      new AbortController().signal,
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable', askLimit: 'off' });
  });
});
