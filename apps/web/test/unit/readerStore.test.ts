import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../src/api/client.ts';
import { ReaderStore } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { FakeApi, feedItem, universeOf, worldSystemOf } from './fakeApi.ts';

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Waits until `predicate()` is true or the timeout elapses (real microtask/timer draining, no fake timers). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await tick();
  }
}

describe('ReaderStore', () => {
  let api: FakeApi;
  let backend: MemoryStorageBackend;
  let storage: ReaderStorage;
  let store: ReaderStore;

  beforeEach(() => {
    api = new FakeApi();
    backend = new MemoryStorageBackend();
    storage = new ReaderStorage(backend);
    store = new ReaderStore(api, storage);
  });

  it('shows an honest empty universe when there are no saved Traces', async () => {
    api.universeQueue.push(universeOf({ traces: [] }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    const state = store.getState();
    expect(state.universe).toEqual({ status: 'loaded', universe: universeOf({ traces: [] }) });
  });

  it('enterScroll loads the feed and reads with the returned reason, without an exposure yet', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    api.feedQueue.push({ decisionId: 'd1', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');

    const scroll = store.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected reading state');
    expect(scroll.item.assetId).toBe(feedItem().assetId);
    expect(scroll.exposureId).toBe('');
    expect(scroll.keep).toEqual({ status: 'idle' });
    expect(scroll.origin).toEqual({ type: 'discovery' });
    expect(api.exposureCalls).toHaveLength(0);
  });

  async function enterReadingScroll(): Promise<void> {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.feedQueue.push({ decisionId: 'd1', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
  }

  it('records exposure only once even if onVisible fires twice for the same asset', async () => {
    await enterReadingScroll();
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    store.onVisible(feedItem().assetId);
    await waitFor(() => api.exposureCalls.length === 1);
    store.onVisible(feedItem().assetId);
    await tick();
    await tick();
    expect(api.exposureCalls).toHaveLength(1);
    const scroll = store.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected reading state');
    expect(scroll.exposureId).toBe('exp-1');
  });

  it('ignores onVisible for an asset that does not match the current session', async () => {
    await enterReadingScroll();
    store.onVisible('some-other-asset-id');
    await tick();
    expect(api.exposureCalls).toHaveLength(0);
  });

  it('keep exposes first if needed, then only shows Kept after the interaction is accepted', async () => {
    await enterReadingScroll();
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    api.interactionQueue.push({ eventId: 'keep-evt-1', jobId: 'job-1', status: 'accepted' });
    store.keep();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.keep.status === 'kept';
    });
    expect(api.exposureCalls).toHaveLength(1);
    expect(api.interactionCalls).toHaveLength(1);
    expect(api.interactionCalls[0]?.exposureId).toBe('exp-1');
    const scroll = store.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected reading state');
    expect(scroll.keep).toEqual({ status: 'kept', jobId: 'job-1' });
  });

  it('keep persists the real why-this-appeared reason for the Universe screen, scoped to this universe/epoch', async () => {
    await enterReadingScroll();
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    api.interactionQueue.push({ eventId: 'keep-evt-1', jobId: 'job-1', status: 'accepted' });
    store.keep();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.keep.status === 'kept';
    });
    expect(storage.readLastKept()).toEqual({
      eventId: 'keep-evt-1',
      title: feedItem().title,
      reason: feedItem().reason,
      universeId: universeOf().universeId,
      privacyEpoch: 0,
    });
  });

  it('never persists a reason for a Trace revisit, which deliberately carries none', async () => {
    api.universeQueue.push(universeOf({ traces: [{ eventId: 'e1', assetId: feedItem().assetId, title: 'Kept title', createdAt: '2026-01-01T00:00:00Z' }] }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.traceRevisitQueue.push({
      mode: 'kept_revisit',
      traceEventId: 'e1',
      universeId: universeOf().universeId,
      privacyEpoch: 0,
      exposureId: 'exp-revisit',
      keptAt: '2026-01-01T00:00:00Z',
      scroll: {
        assetId: feedItem().assetId,
        revision: 1,
        kind: 'Scroll',
        title: feedItem().title,
        summary: feedItem().summary,
        body: feedItem().body,
        sourceTitle: feedItem().sourceTitle,
        sourceUrl: feedItem().sourceUrl,
        truthState: 'documented',
      },
    });
    store.openTrace({ eventId: 'e1', assetId: feedItem().assetId, title: 'Kept title', createdAt: '2026-01-01T00:00:00Z' });
    await waitFor(() => store.getState().scroll.status === 'reading');
    expect(storage.readLastKept()).toBeNull();
  });

  it('keep retried after a dropped response reuses the same clientEventId/clientExposureId and yields exactly one keep', async () => {
    await enterReadingScroll();
    // First attempt: exposure succeeds, then the interaction response is "dropped" (network failure).
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    api.interactionQueue.push(new ApiException({ kind: 'network', message: 'simulated dropped response' }));
    store.keep();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.keep.status === 'failed';
    });
    expect(api.interactionCalls).toHaveLength(1);
    const firstAttempt = api.interactionCalls[0]!;

    // Retry: the server actually processed the first attempt and returns the same accepted receipt.
    api.interactionQueue.push({ eventId: 'keep-evt-1', jobId: 'job-1', status: 'accepted' });
    store.keep();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.keep.status === 'kept';
    });
    expect(api.interactionCalls).toHaveLength(2);
    const secondAttempt = api.interactionCalls[1]!;
    expect(secondAttempt.clientEventId).toBe(firstAttempt.clientEventId);
    expect(secondAttempt.exposureId).toBe(firstAttempt.exposureId);
    // Exactly one exposure call total: retrying keep must not re-record exposure either.
    expect(api.exposureCalls).toHaveLength(1);
  });

  it('reaches a finite rest once every candidate in the bounded feed has been visited', async () => {
    await enterReadingScroll();
    api.feedQueue.push({ decisionId: 'd2', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.nextScroll();
    await waitFor(() => store.getState().scroll.status === 'reading' && (store.getState().scroll as { discovery: string }).discovery === 'exhausted');
    const scroll = store.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected reading state');
    expect(scroll.discovery).toBe('exhausted');
  });

  it('a saved-Trace revisit is read-only: no exposure call, and Keep already shows accepted', async () => {
    api.universeQueue.push(universeOf({ traces: [{ eventId: 'trace-1', assetId: feedItem().assetId, title: feedItem().title, createdAt: '2026-01-01T00:00:00.000Z' }] }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    api.traceRevisitQueue.push({
      mode: 'kept_revisit',
      traceEventId: 'trace-1',
      universeId: universeOf().universeId,
      privacyEpoch: 0,
      exposureId: 'exp-old',
      keptAt: '2026-01-01T00:00:00.000Z',
      scroll: {
        assetId: feedItem().assetId,
        revision: 1,
        kind: 'Scroll',
        title: feedItem().title,
        summary: feedItem().summary,
        body: feedItem().body,
        sourceTitle: feedItem().sourceTitle,
        sourceUrl: feedItem().sourceUrl,
        truthState: 'documented',
      },
    });
    store.openTrace({ eventId: 'trace-1', assetId: feedItem().assetId, title: feedItem().title, createdAt: '2026-01-01T00:00:00.000Z' });
    await waitFor(() => store.getState().scroll.status === 'reading');

    const scroll = store.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected reading state');
    expect(scroll.origin).toEqual({ type: 'saved-trace', eventId: 'trace-1' });
    expect(scroll.keep.status).toBe('kept');
    expect(api.exposureCalls).toHaveLength(0);
    expect(store.getState().screen).toBe('revisit');
  });

  it('a changed source (409) on revisit discards the private revisit identity and is not retryable', async () => {
    api.universeQueue.push(universeOf({ traces: [{ eventId: 'trace-1', assetId: feedItem().assetId, title: feedItem().title, createdAt: '2026-01-01T00:00:00.000Z' }] }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    api.traceRevisitQueue.push(new ApiException({ kind: 'server', statusCode: 409, body: 'source changed' }));
    store.openTrace({ eventId: 'trace-1', assetId: feedItem().assetId, title: feedItem().title, createdAt: '2026-01-01T00:00:00.000Z' });
    await waitFor(() => store.getState().scroll.status === 'unavailable');

    const scroll = store.getState().scroll;
    if (scroll.status !== 'unavailable') throw new Error('expected unavailable state');
    expect(scroll.retryable).toBe(false);
    expect(storage.readRevisit()).toBeNull();
  });

  it('a 401 purges all private state and fails closed to an honest Unavailable universe', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.feedQueue.push({ decisionId: 'd1', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
    expect(storage.readSession()).not.toBeNull();

    api.universeQueue.push(new ApiException({ kind: 'server', statusCode: 401, body: 'unauthorized' }));
    store.retryUniverse();
    await waitFor(() => store.getState().universe.status === 'unavailable');

    expect(store.getState().screen).toBe('universe');
    expect(storage.readSession()).toBeNull();
    expect(storage.readScreen()).toBe('universe');
  });

  it('an advanced privacy epoch purges private state even without an explicit 401', async () => {
    api.universeQueue.push(universeOf({ privacyEpoch: 0 }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.feedQueue.push({ decisionId: 'd1', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
    expect(storage.readSession()).not.toBeNull();

    // History changed elsewhere (e.g. another client) and advanced the privacy epoch.
    api.universeQueue.push(universeOf({ privacyEpoch: 1 }));
    store.returnToUniverse();
    await waitFor(() => store.getState().universe.status === 'loaded');

    expect(storage.readObservedPrivacyEpoch()).toBe(1);
    expect(storage.readSession()).toBeNull();
  });

  it('restores the current Scroll and its retry envelope from storage on reload (same epoch/universe)', async () => {
    await enterReadingScroll();
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    store.onVisible(feedItem().assetId);
    await waitFor(() => api.exposureCalls.length === 1);
    const persisted = storage.readSession();
    expect(persisted).not.toBeNull();

    // Simulate a page reload: a fresh store over the same underlying storage backend and API.
    const reloadedApi = new FakeApi();
    reloadedApi.universeQueue.push(universeOf());
    const reloaded = new ReaderStore(reloadedApi, storage);
    reloaded.init();
    await waitFor(() => reloaded.getState().scroll.status === 'reading');

    const scroll = reloaded.getState().scroll;
    if (scroll.status !== 'reading') throw new Error('expected restored reading state');
    expect(scroll.item.assetId).toBe(feedItem().assetId);
    expect(scroll.exposureId).toBe('exp-1');
    expect(reloadedApi.feedCalls).toBe(0); // restored from storage, not re-fetched as a new discovery
  });

  it('enterSystem reads GET /v1/worlds and returnFromSystem goes back without touching any Scroll session', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    const response = worldSystemOf();
    api.worldsQueue.push(response);
    store.enterSystem();
    expect(store.getState().screen).toBe('system');
    await waitFor(() => store.getState().system.status === 'loaded');
    const system = store.getState().system;
    if (system.status !== 'loaded') throw new Error('expected loaded system state');
    expect(system.response).toEqual(response);
    expect(api.worldsCalls).toBe(1);

    store.returnFromSystem();
    expect(store.getState().screen).toBe('universe');
    expect(store.getState().system).toEqual({ status: 'idle' });
    // Returning from the system view is not a privacy reconciliation: it never re-fetches the universe.
    expect(api.universeCalls).toBe(1);
  });

  it('enterSystem surfaces a real fetch failure as Unavailable with a working retry', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    api.worldsQueue.push(new ApiException({ kind: 'network', message: 'simulated dropped response' }));
    store.enterSystem();
    await waitFor(() => store.getState().system.status === 'unavailable');
    const failed = store.getState().system;
    if (failed.status !== 'unavailable') throw new Error('expected unavailable system state');
    expect(failed.message).toBeTruthy();

    const response = worldSystemOf();
    api.worldsQueue.push(response);
    store.retrySystem();
    await waitFor(() => store.getState().system.status === 'loaded');
    const recovered = store.getState().system;
    if (recovered.status !== 'loaded') throw new Error('expected loaded system state after retry');
    expect(recovered.response).toEqual(response);
  });

  it('a 401 while reading the system purges private state and fails closed to an honest Unavailable universe', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');

    api.worldsQueue.push(new ApiException({ kind: 'server', statusCode: 401, body: 'unauthorized' }));
    store.enterSystem();
    await waitFor(() => store.getState().universe.status === 'unavailable');

    expect(store.getState().screen).toBe('universe');
    expect(store.getState().system).toEqual({ status: 'idle' });
  });

  it('never restores a cached Scroll across a changed privacy epoch', async () => {
    await enterReadingScroll();
    expect(storage.readSession()).not.toBeNull();

    const reloadedApi = new FakeApi();
    reloadedApi.universeQueue.push(universeOf({ privacyEpoch: 9 }));
    const reloaded = new ReaderStore(reloadedApi, storage);
    reloaded.init();
    await waitFor(() => reloaded.getState().universe.status === 'loaded');

    expect(reloaded.getState().screen).toBe('universe');
    expect(storage.readSession()).toBeNull();
  });
});
