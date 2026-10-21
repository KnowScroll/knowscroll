import { createAccountScope, createScrollRecorder, memoryStore, type ScrollRecorder } from '@knowscroll/client-core';
import type { InteractionEvent } from '@knowscroll/contracts';
import { parseDocument } from '@knowscroll/scroll-model';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { createEncounterHistory, readResume, type EncounterEntry } from './encounter-history';

/** Labelled CI geometry/recorder fixtures, never product inventory. */
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  let n = 100;
  const store = memoryStore();
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'history@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store,
    fetch: () => Promise.reject(new Error('No HTTP')),
  });
  const parsed = parseDocument(document);
  if (parsed.kind !== 'valid') throw new Error('CI document must parse');
  const entry = (index: number): EncounterEntry => ({
    kind: 'scroll',
    exposureId: id(index + 10),
    sessionId: id(3),
    started: true,
    suspended: false,
    disposed: false,
    restored: false,
    offer: {
      offerId: id(index + 20),
      decisionId: id(4),
      assetId: parsed.document.assetId,
      assetRevision: 1,
      explanationUnitId: 'fixture',
      metadata: { kind: 'scroll', title: 'CI Scroll', summary: '', language: 'en' },
      relation: { kind: 'return' },
      variants: [],
    },
    scroll: {
      exposureId: id(index + 10),
      assetId: parsed.document.assetId,
      assetRevision: 1,
      document: parsed.document,
      degradedEssential: [],
    },
    context: {
      exposureId: id(index + 10),
      assetId: parsed.document.assetId,
      assetRevision: 1,
      revision: 0,
      actions: { saved: false, liked: false, hidden: false },
      variants: [],
      continuations: {
        seriesPrevious: { status: 'unavailable', reason: 'series_boundary' },
        seriesNext: { status: 'unavailable', reason: 'series_boundary' },
        related: { status: 'unavailable', reason: 'no_related_ready' },
      },
    },
    recorder: createScrollRecorder({
      exposure: { exposureId: id(index + 10), assetId: parsed.document.assetId, assetRevision: 1 },
      scope,
      newId: () => id(++n),
      outbox: {
        enqueue: jest.fn(),
        drain: () => Promise.resolve(),
        status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
        dispose: jest.fn(),
      },
    }),
  });
  return { scope, store, entry };
}
describe('AccountScope retained encounter history', () => {
  it('captures exact top-level block/offset synchronously before suspend and persists only the private position', () => {
    const f = fixture();
    try {
      const history = createEncounterHistory(f.scope);
      const entry = f.entry(0);
      const order: string[] = [];
      const value = { assetId: entry.offer.assetId, revision: 1, blockId: 'pulls-p1', offsetWithinBlock: 37.5 };
      entry.surface = {
        capture: () => {
          order.push('capture');
          return { kind: 'scroll', value };
        },
        pause: () => {
          order.push('pause');
        },
      };
      const suspend = entry.recorder.suspend.bind(entry.recorder);
      jest.spyOn(entry.recorder, 'suspend').mockImplementation(() => {
        order.push('suspend');
        suspend();
      });
      history.push(entry);
      history.push(f.entry(1));
      expect(order).toEqual(['capture', 'pause', 'suspend']);
      expect(readResume(f.scope, entry.offer.assetId, 1)).toEqual({ kind: 'scroll', value });
      expect(readResume(f.scope, entry.offer.assetId, 2)).toBeUndefined();
      expect(f.store.keys()).toHaveLength(1);
      const persisted = f.store.getItem(f.store.keys()[0]!)!;
      expect(persisted).not.toMatch(/exposureId|sessionId|offerId|grant|https|recorder/);
      expect(history.back()).toBe(true);
      expect(history.current()).toBe(entry);
      expect(history.current()?.recorder).toBe(entry.recorder);
      history.end();
    } finally {
      f.scope.end();
    }
  });

  it('retains at most 20 entries, ends evicted handles once, and ends retained handles only at scope disposal', () => {
    const f = fixture();
    try {
      const history = createEncounterHistory(f.scope);
      const entries = Array.from({ length: 21 }, (_, index) => f.entry(index));
      const ends = entries.map((entry) => jest.spyOn(entry.recorder, 'end'));
      entries.forEach((entry) => history.push(entry));
      expect(history.list()).toHaveLength(20);
      expect(ends[0]).toHaveBeenCalledTimes(1);
      expect(ends[1]).not.toHaveBeenCalled();
      const current = history.current();
      history.back();
      expect(current?.recorder).not.toBe(history.current()?.recorder);
      expect(ends[20]).not.toHaveBeenCalled();
      history.end();
      history.end();
      for (const end of ends) expect(end).toHaveBeenCalledTimes(1);
    } finally {
      f.scope.end();
    }
  });

  it('a suspended recorder ignores old callbacks; resume requires fresh visibility and activity on the same timebase', () => {
    let now = 1000;
    let sequence = 900;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture();
    try {
      const first = f.entry(0);
      const recorder = first.recorder as ScrollRecorder;
      const outbox = jest.fn<void, [readonly InteractionEvent[], number]>();
      // Separate real recorder with a deterministic clock and bounded test outbox.
      const actual = createScrollRecorder({
        exposure: { exposureId: first.exposureId, assetId: first.offer.assetId, assetRevision: 1 },
        scope: f.scope,
        newId: () => id(++sequence),
        outbox: {
          enqueue: outbox,
          drain: () => Promise.resolve(),
          status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
          dispose: jest.fn(),
        },
      });
      actual.observer.onActivity({ active: true, at: now });
      actual.observer.onBlockVisibility({ blockId: 'pulls-p1', visibleFraction: 1, at: now });
      now = 2000;
      actual.suspend();
      const count = outbox.mock.calls.length;
      now = 10000;
      actual.observer.onActivity({ active: true, at: now });
      actual.observer.onBlockVisibility({ blockId: 'pulls-p1', visibleFraction: 1, at: now });
      actual.flush();
      expect(outbox).toHaveBeenCalledTimes(count);
      actual.resume();
      actual.flush();
      expect(outbox).toHaveBeenCalledTimes(count);
      actual.observer.onActivity({ active: true, at: now });
      actual.observer.onBlockVisibility({ blockId: 'pulls-p1', visibleFraction: 1, at: now });
      now = 11000;
      actual.flush();
      const events = outbox.mock.calls.flatMap((call) => call[0]);
      expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set([actual.sessionId]));
      expect(events.filter((event) => event.kind === 'scroll.active_dwell').at(-1)?.payload).toEqual({
        activeIntervalsMs: [[9000, 10000]],
      });
      actual.end();
      recorder.end();
    } finally {
      f.scope.end();
      jest.restoreAllMocks();
    }
  });
});

describe('Keep-origin history stays in memory', () => {
  it('retains Back position but never migrates it to the legacy unfenced resume key', () => {
    const f = fixture();
    try {
      const history = createEncounterHistory(f.scope);
      const first = f.entry(0);
      first.keepOrigin = true;
      history.push(first);
      first.surface = {
        capture: () => ({
          kind: 'scroll',
          value: { assetId: first.offer.assetId, revision: 1, blockId: 'pulls-p1', offsetWithinBlock: 12.5 },
        }),
        pause: jest.fn(),
      };
      history.push(f.entry(1));
      expect(readResume(f.scope, first.offer.assetId, 1)).toBeUndefined();
      expect(f.store.keys()).toHaveLength(0);
      expect(history.back()).toBe(true);
      expect(history.current()).toBe(first);
      expect(first.position?.kind).toBe('scroll');
      history.end();
      expect(first.position).toBeUndefined();
    } finally {
      f.scope.end();
    }
  });
});
