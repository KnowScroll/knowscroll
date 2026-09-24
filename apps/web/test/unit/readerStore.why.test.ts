/**
 * #133 — the reader store's half of "What led here" on the web, mirroring Android's
 * `AppViewModel.loadWhy`/`correctEncounter`: the explanation is read for the encounter on screen
 * (the feed decision and Scroll of the exposure being read), a 404 is honest absence, a saved
 * Trace has no Composer decision to explain, and a correction keeps one clientFeedbackId per intent
 * across retries. Privacy: nothing is read or sent while the reader is not ready (signed out,
 * failed closed, reconciling), and a stale epoch or ended session purges and fails closed exactly
 * like every other scoped action here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../src/api/client.ts';
import { ReaderStore, type WhyView } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { FakeApi, encounterFeedbackReceiptOf, feedItem, universeOf, whyOf } from './fakeApi.ts';

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await tick();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

const serverError = (statusCode: number) => new ApiException({ kind: 'server', statusCode, body: '{}' });
const networkError = () => new ApiException({ kind: 'network', message: 'connection reset' });

type OpenWhy = Extract<WhyView, { status: 'open' }>;

describe('ReaderStore: What led here (#133)', () => {
  let api: FakeApi;
  let storage: ReaderStorage;
  let store: ReaderStore;
  let onSignedOut: ReturnType<typeof vi.fn<(message: string | null, verify: boolean) => void>>;

  beforeEach(() => {
    api = new FakeApi();
    storage = new ReaderStorage(new MemoryStorageBackend());
    onSignedOut = vi.fn<(message: string | null, verify: boolean) => void>();
    store = new ReaderStore(api, storage, onSignedOut);
  });

  const why = (): WhyView => store.getState().why;
  const open = (): OpenWhy => {
    const view = why();
    if (view.status !== 'open') throw new Error(`expected an open why panel, got ${view.status}`);
    return view;
  };
  const availability = () => (why().status === 'open' ? open().availability.status : 'closed');

  async function readDiscovered(epoch = 0, decisionId = 'd1'): Promise<void> {
    api.universeQueue.push(universeOf({ privacyEpoch: epoch }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.feedQueue.push({ decisionId, universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: epoch, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
  }

  async function openLoaded(overrides: Parameters<typeof whyOf>[0] = {}): Promise<void> {
    api.whyQueue.push(whyOf({ decisionId: 'd1', ...overrides }));
    store.openWhy();
    await waitFor(() => availability() === 'loaded');
  }

  it('starts closed', () => {
    expect(why()).toEqual({ status: 'closed' });
  });

  it('reads the explanation of the encounter being read: its feed decision and its Scroll', async () => {
    await readDiscovered();
    api.whyQueue.push(whyOf({ decisionId: 'd1' }));
    store.openWhy();
    expect(availability()).toBe('loading');
    await waitFor(() => availability() === 'loaded');
    expect(api.whyCalls).toEqual([{ decisionId: 'd1', assetId: feedItem().assetId }]);
    const view = open();
    expect(view.decisionId).toBe('d1');
    expect(view.assetId).toBe(feedItem().assetId);
    expect(view.availability).toEqual({ status: 'loaded', why: whyOf({ decisionId: 'd1' }) });
    expect(view.corrected).toEqual([]);
    expect(view.sending).toBeNull();
  });

  it('opening it again while it is already shown reads nothing twice', async () => {
    await readDiscovered();
    await openLoaded();
    store.openWhy();
    await settle();
    expect(api.whyCalls).toHaveLength(1);
  });

  it('closing it closes it; opening it again re-reads what is recorded now', async () => {
    await readDiscovered();
    await openLoaded();
    store.closeWhy();
    expect(why()).toEqual({ status: 'closed' });
    await openLoaded({ corrected: ['less_like_this'] });
    expect(api.whyCalls).toHaveLength(2);
    expect(open().corrected).toEqual(['less_like_this']);
  });

  it('a 404 is honest absence ("unrecorded"), never an error and never a fail-closed reader', async () => {
    await readDiscovered();
    api.whyQueue.push(null);
    store.openWhy();
    await waitFor(() => availability() === 'unrecorded');
    expect(store.getState().universe.status).toBe('loaded');
    expect(store.getState().scroll.status).toBe('reading');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('a saved-Trace revisit has no Composer decision to explain: unrecorded, with no request', async () => {
    const trace = { eventId: 'trace-1', assetId: feedItem().assetId, title: feedItem().title, createdAt: '2026-09-24T10:00:00.000Z' };
    api.universeQueue.push(universeOf({ traces: [trace] }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    const { reason: _reason, ...scroll } = feedItem();
    api.traceRevisitQueue.push({
      mode: 'kept_revisit',
      traceEventId: 'trace-1',
      universeId: universeOf().universeId,
      privacyEpoch: 0,
      exposureId: 'exp-old',
      keptAt: '2026-09-24T10:00:00.000Z',
      scroll: { ...scroll, kind: 'Scroll', truthState: 'documented' },
    });
    store.openTrace(trace);
    await waitFor(() => store.getState().scroll.status === 'reading');
    store.openWhy();
    expect(availability()).toBe('unrecorded');
    expect(api.whyCalls).toHaveLength(0);
  });

  it('a failed read is a retryable failure, not a fail-closed reader; retry reads again', async () => {
    await readDiscovered();
    api.whyQueue.push(networkError());
    store.openWhy();
    await waitFor(() => availability() === 'failed');
    expect(store.getState().universe.status).toBe('loaded');
    api.whyQueue.push(whyOf({ decisionId: 'd1' }));
    store.retryWhy();
    await waitFor(() => availability() === 'loaded');
    expect(api.whyCalls).toHaveLength(2);
  });

  it('a 401 while reading it purges private state, fails closed and reports the ended session', async () => {
    await readDiscovered();
    storage.writeVisited(new Set(['x']));
    api.whyQueue.push(serverError(401));
    store.openWhy();
    await waitFor(() => store.getState().universe.status === 'unavailable');
    expect(why()).toEqual({ status: 'closed' });
    expect(store.getState().scroll).toEqual({ status: 'idle' });
    expect(storage.readSession()).toBeNull();
    expect(storage.readVisited().size).toBe(0);
    expect(onSignedOut).toHaveBeenCalledWith(null, true);
  });

  it('nothing is read while the reader is not ready (signed out / failed closed)', async () => {
    await readDiscovered();
    api.whyQueue.push(serverError(401));
    store.openWhy();
    await waitFor(() => store.getState().universe.status === 'unavailable');
    store.openWhy();
    store.correctEncounter('less_like_this');
    await settle();
    expect(api.whyCalls).toHaveLength(1);
    expect(api.feedbackCalls).toHaveLength(0);
    expect(why()).toEqual({ status: 'closed' });
  });

  it('an explanation that lands after the reader moved on never appears on the next Scroll', async () => {
    await readDiscovered();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = { getWhy: api.getWhy.bind(api) };
    api.getWhy = async (decisionId, assetId) => { await gate; return slow.getWhy(decisionId, assetId); };
    api.whyQueue.push(whyOf({ decisionId: 'd1' }));
    store.openWhy();
    const next = feedItem({ assetId: '10000000-0000-4000-8000-000000000002', title: 'A star is a balancing act' });
    api.feedQueue.push({ decisionId: 'd2', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [next] });
    store.nextScroll();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.item.assetId === next.assetId;
    });
    expect(why()).toEqual({ status: 'closed' });
    release();
    await settle();
    expect(why()).toEqual({ status: 'closed' });
  });

  describe('corrections (journey G)', () => {
    it('"less like this" sends one correction keyed to this encounter and the observed privacy epoch, then says what it did', async () => {
      await readDiscovered(3);
      await openLoaded();
      api.feedbackQueue.push(encounterFeedbackReceiptOf());
      store.correctEncounter('less_like_this');
      expect(open().sending).toBe('less_like_this');
      await waitFor(() => open().sending === null);
      expect(api.feedbackCalls).toHaveLength(1);
      const sent = api.feedbackCalls[0]!;
      expect(sent).toEqual({
        clientFeedbackId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        decisionId: 'd1',
        assetId: feedItem().assetId,
        kind: 'less_like_this',
        expectedPrivacyEpoch: 3,
      });
      expect(open().corrected).toEqual(['less_like_this']);
      expect(open().notice).toEqual({ kind: 'corrected', correction: 'less_like_this' });
    });

    it('a correction already made is never sent again, and nothing else is sent while one is in flight', async () => {
      await readDiscovered();
      await openLoaded();
      let release!: () => void;
      api.feedbackGate = new Promise<void>(resolve => { release = resolve; });
      api.feedbackQueue.push(encounterFeedbackReceiptOf());
      store.correctEncounter('less_like_this');
      store.correctEncounter('less_like_this');
      store.correctEncounter('wrong_connection');
      await settle();
      expect(api.feedbackCalls).toHaveLength(1);
      release();
      await waitFor(() => open().sending === null);
      store.correctEncounter('less_like_this');
      await settle();
      expect(api.feedbackCalls).toHaveLength(1);
    });

    it('a correction the encounter does not support is never sent', async () => {
      await readDiscovered();
      await openLoaded({ family: 'continue', evidence: [whyOf().evidence[0]!], corrections: ['less_like_this'] });
      store.correctEncounter('wrong_connection');
      await settle();
      expect(api.feedbackCalls).toHaveLength(0);
    });

    it('a correction the server already recorded (from any device) is not offered again', async () => {
      await readDiscovered();
      await openLoaded({ corrected: ['less_like_this'] });
      store.correctEncounter('less_like_this');
      await settle();
      expect(api.feedbackCalls).toHaveLength(0);
    });

    it('a failed correction says so honestly and a retry reuses the same clientFeedbackId', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(networkError());
      store.correctEncounter('wrong_connection');
      await waitFor(() => open().sending === null);
      expect(open().corrected).toEqual([]);
      expect(open().notice).toMatchObject({ kind: 'failed', correction: 'wrong_connection' });
      api.feedbackQueue.push(encounterFeedbackReceiptOf({ kind: 'wrong_connection' }));
      store.correctEncounter('wrong_connection');
      await waitFor(() => open().sending === null);
      expect(api.feedbackCalls).toHaveLength(2);
      expect(api.feedbackCalls[1]!.clientFeedbackId).toBe(api.feedbackCalls[0]!.clientFeedbackId);
      expect(open().corrected).toEqual(['wrong_connection']);
    });

    it('the retry keeps its identity across closing and reopening the panel', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(networkError());
      store.correctEncounter('less_like_this');
      await waitFor(() => open().sending === null);
      store.closeWhy();
      await openLoaded();
      api.feedbackQueue.push(encounterFeedbackReceiptOf());
      store.correctEncounter('less_like_this');
      await waitFor(() => open().corrected.includes('less_like_this'));
      expect(api.feedbackCalls[1]!.clientFeedbackId).toBe(api.feedbackCalls[0]!.clientFeedbackId);
    });

    it('a new intent after success mints a new identity (a different correction of the same encounter)', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(encounterFeedbackReceiptOf(), encounterFeedbackReceiptOf({ kind: 'wrong_connection' }));
      store.correctEncounter('less_like_this');
      await waitFor(() => open().sending === null);
      store.correctEncounter('wrong_connection');
      await waitFor(() => open().corrected.length === 2);
      expect(api.feedbackCalls[1]!.clientFeedbackId).not.toBe(api.feedbackCalls[0]!.clientFeedbackId);
    });

    it('an encounter with no route to correct (422) is said plainly, without failing the reader closed', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(serverError(422));
      store.correctEncounter('less_like_this');
      await waitFor(() => open().sending === null);
      expect(open().notice).toEqual({ kind: 'no-route' });
      expect(store.getState().universe.status).toBe('loaded');
    });

    it('a stale privacy epoch (409) purges private state and fails closed, like every other scoped action', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(serverError(409));
      store.correctEncounter('less_like_this');
      await waitFor(() => store.getState().universe.status === 'unavailable');
      expect(storage.readSession()).toBeNull();
      expect(why()).toEqual({ status: 'closed' });
      expect(onSignedOut).not.toHaveBeenCalled();
    });

    it('an ended session (401) fails closed and reports it', async () => {
      await readDiscovered();
      await openLoaded();
      api.feedbackQueue.push(serverError(401));
      store.correctEncounter('less_like_this');
      await waitFor(() => store.getState().universe.status === 'unavailable');
      expect(onSignedOut).toHaveBeenCalledWith(null, true);
    });
  });
});
