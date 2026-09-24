import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../src/api/client.ts';
import { ReaderStore, type PrivacyActionState } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { FakeApi, feedItem, privacyExportResultOf, privacyRecordingReceiptOf, privacyResetReceiptOf, universeOf, worldSystemOf } from './fakeApi.ts';

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

/** A single read of `store.getState().privacy` narrowed once, so `waitFor` predicates below do
 * not re-call `getState()` a second time just to read `.action` -- TS cannot narrow across two
 * separate calls, and re-reading would also risk observing a different tick's state. */
function privacyActionStatus(store: ReaderStore): PrivacyActionState['status'] | null {
  const privacy = store.getState().privacy;
  return privacy.status === 'open' ? privacy.action.status : null;
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

  it('a Keep tapped while the exposure is still being recorded joins it instead of being dropped (#123)', async () => {
    await enterReadingScroll();
    let release!: () => void;
    api.exposureGate = new Promise<void>(resolve => { release = resolve; });
    api.exposureQueue.push({ exposureId: 'exp-1', eventId: 'evt-1' });
    api.interactionQueue.push({ eventId: 'keep-evt-1', jobId: 'job-1', status: 'accepted' });
    store.onVisible(feedItem().assetId);
    await waitFor(() => api.exposureCalls.length === 1);
    store.keep();
    const saving = store.getState().scroll;
    expect(saving.status === 'reading' && saving.keep.status).toBe('saving');
    release();
    await waitFor(() => {
      const scroll = store.getState().scroll;
      return scroll.status === 'reading' && scroll.keep.status === 'kept';
    });
    expect(api.exposureCalls).toHaveLength(1);
    expect(api.interactionCalls).toHaveLength(1);
    expect(api.interactionCalls[0]?.exposureId).toBe('exp-1');
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

  it('asks the feed not to return what this trip already opened, and skips exactly that (#133)', async () => {
    await enterReadingScroll();
    expect(api.feedExcludes[0]).toEqual([]); // the first feed of a trip has opened nothing yet
    const opened = feedItem().assetId;
    const next = feedItem({ assetId: '10000000-0000-4000-8000-000000000002', title: 'Another Scroll' });
    api.feedQueue.push({ decisionId: 'd2', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [next] });
    store.nextScroll();
    await waitFor(() => store.getState().scroll.status === 'reading' && (store.getState().scroll as { item: { assetId: string } }).item.assetId === next.assetId);
    expect(api.feedExcludes[1]).toEqual([opened]);
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

  // ---------- Privacy lifecycle (#119, ADR-0030): pause/resume/export/reset ----------

  async function openLoadedPrivacy(): Promise<void> {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    store.openPrivacy();
  }

  it('openPrivacy shows the panel over the real universe already loaded, and closePrivacy returns without re-fetching', async () => {
    await openLoadedPrivacy();
    expect(store.getState().screen).toBe('privacy');
    expect(store.getState().privacy).toEqual({ status: 'open', action: { status: 'idle' } });
    expect(api.universeCalls).toBe(1);

    store.closePrivacy();
    expect(store.getState().screen).toBe('universe');
    expect(store.getState().privacy).toEqual({ status: 'idle' });
    // Returning is not itself a privacy reconciliation -- nothing changed, so nothing is re-fetched.
    expect(api.universeCalls).toBe(1);
  });

  it('openPrivacy is a no-op before the universe has ever loaded', () => {
    store.openPrivacy();
    expect(store.getState().screen).toBe('universe');
    expect(store.getState().privacy).toEqual({ status: 'idle' });
  });

  it('pause posts one requestId keyed to the current epoch, then genuinely re-reads GET /v1/universe rather than trusting the receipt', async () => {
    await openLoadedPrivacy();

    // The pause receipt claims one pausedAt value; the *re-read* GET returns a different one.
    // The panel must end up showing the GET's value -- proof it actually re-read rather than
    // trusting the POST response it already had in hand.
    api.pauseQueue.push(privacyRecordingReceiptOf({ recordingPausedAt: '2020-01-01T00:00:00.000Z' }));
    api.universeQueue.push(universeOf({ recordingPausedAt: '2026-09-21T09:00:00.000Z' }));

    store.pauseRecording();
    expect(store.getState().privacy).toMatchObject({ status: 'open', action: { status: 'pending', kind: 'pause' } });
    await waitFor(() => privacyActionStatus(store) === 'idle');

    expect(api.pauseCalls).toEqual([{ requestId: expect.any(String), expectedPrivacyEpoch: 0 }]);
    expect(api.universeCalls).toBe(2); // the initial load, plus one genuine re-read after pause
    const universe = store.getState().universe;
    if (universe.status !== 'loaded') throw new Error('expected loaded universe');
    expect(universe.universe.recordingPausedAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('resume mirrors pause: one request, then a real re-read', async () => {
    await openLoadedPrivacy();
    api.resumeQueue.push(privacyRecordingReceiptOf({ action: 'resume', recordingPausedAt: null }));
    api.universeQueue.push(universeOf({ recordingPausedAt: null }));

    store.resumeRecording();
    await waitFor(() => privacyActionStatus(store) === 'idle');

    expect(api.resumeCalls).toHaveLength(1);
    expect(api.universeCalls).toBe(2);
    const universe = store.getState().universe;
    if (universe.status !== 'loaded') throw new Error('expected loaded universe');
    expect(universe.universe.recordingPausedAt).toBeNull();
  });

  it('a failed pause reuses the same requestId on retry, never minting a second one for the same intent', async () => {
    await openLoadedPrivacy();
    api.pauseQueue.push(new ApiException({ kind: 'network', message: 'dropped' }));
    store.pauseRecording();
    await waitFor(() => privacyActionStatus(store) === 'failed');

    const failed = store.getState().privacy;
    if (failed.status !== 'open' || failed.action.status !== 'failed') throw new Error('expected failed pause');
    const firstRequestId = failed.action.requestId;
    expect(api.pauseCalls).toHaveLength(1);

    api.pauseQueue.push(privacyRecordingReceiptOf());
    api.universeQueue.push(universeOf({ recordingPausedAt: '2026-09-21T09:00:00.000Z' }));
    store.pauseRecording();
    await waitFor(() => privacyActionStatus(store) === 'idle');

    expect(api.pauseCalls).toHaveLength(2);
    expect(api.pauseCalls[0]!.requestId).toBe(firstRequestId);
    expect(api.pauseCalls[1]!.requestId).toBe(firstRequestId);
  });

  it('a stale-epoch conflict (409) while pausing purges private state and fails closed, exactly like every other scoped route', async () => {
    await openLoadedPrivacy();
    api.pauseQueue.push(new ApiException({ kind: 'server', statusCode: 409, body: 'stale epoch' }));
    store.pauseRecording();
    await waitFor(() => store.getState().universe.status === 'unavailable');

    expect(store.getState().screen).toBe('universe');
    expect(store.getState().privacy).toEqual({ status: 'idle' });
  });

  it('export requests the full record, never re-reading the universe (nothing changed)', async () => {
    await openLoadedPrivacy();
    const result = privacyExportResultOf();
    api.privacyExportQueue.push(result);

    store.requestExport();
    await waitFor(() => privacyActionStatus(store) === 'export-ready');

    expect(api.privacyExportCalls).toEqual([{ requestId: expect.any(String), expectedPrivacyEpoch: 0 }]);
    expect(api.universeCalls).toBe(1); // no re-read; export is read-only and changes nothing
    const view = store.getState().privacy;
    if (view.status !== 'open' || view.action.status !== 'export-ready') throw new Error('expected export-ready');
    expect(view.action.result).toEqual(result);
  });

  it('reset refuses to send anything until the typed confirmation exactly matches the wire literal', async () => {
    await openLoadedPrivacy();
    store.beginReset();
    expect(store.getState().privacy).toEqual({ status: 'open', action: { status: 'confirming-reset' } });

    store.confirmReset('reset my universe please');
    expect(api.resetCalls).toHaveLength(0);
    expect(store.getState().privacy).toEqual({ status: 'open', action: { status: 'confirming-reset' } });

    store.cancelReset();
    expect(store.getState().privacy).toEqual({ status: 'open', action: { status: 'idle' } });
  });

  it('a confirmed reset purges every cached private artifact and shows the real receipt, never merely firing the request', async () => {
    await openLoadedPrivacy();
    // Seed private state that a reset must purge (session, visited, lastKept).
    storage.writeSession({
      decisionId: 'd1',
      item: feedItem(),
      privacyEpoch: 0,
      universeId: universeOf().universeId,
      clientExposureId: 'c1',
      clientEventId: 'c2',
      exposureId: 'exp-1',
      exposureEventId: 'evt-1',
      keepJobId: 'job-1',
      keepEventId: 'evt-2',
      readingPosition: 10,
    });
    storage.writeLastKept({ eventId: 'evt-2', title: 'Kept', reason: 'because', universeId: universeOf().universeId, privacyEpoch: 0 });

    const receipt = privacyResetReceiptOf({ epochBefore: 0, epochAfter: 1, sessionsRevoked: 1 });
    api.resetQueue.push(receipt);

    store.beginReset();
    store.confirmReset('reset-personal-universe');
    await waitFor(() => privacyActionStatus(store) === 'reset-complete');

    expect(api.resetCalls).toEqual([{ requestId: expect.any(String), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' }]);
    const view = store.getState().privacy;
    if (view.status !== 'open' || view.action.status !== 'reset-complete') throw new Error('expected reset-complete');
    expect(view.action.receipt).toEqual(receipt);
    expect(store.getState().screen).toBe('privacy'); // stays put so the receipt is actually seen

    // The cached reader state a Reset invalidates (ADR-0030) is gone immediately, not merely on next load.
    expect(storage.readSession()).toBeNull();
    expect(storage.readLastKept()).toBeNull();
  });

  it('acknowledging a completed reset re-reads the universe, which genuinely fails now the session is revoked', async () => {
    await openLoadedPrivacy();
    api.resetQueue.push(privacyResetReceiptOf());
    store.beginReset();
    store.confirmReset('reset-personal-universe');
    await waitFor(() => privacyActionStatus(store) === 'reset-complete');

    // Reset revokes the calling session (ADR-0030); the very next request from the same token fails 401.
    api.universeQueue.push(new ApiException({ kind: 'server', statusCode: 401, body: 'unauthorized' }));
    store.acknowledgeReset();
    await waitFor(() => store.getState().universe.status === 'unavailable');

    expect(store.getState().screen).toBe('universe');
    expect(store.getState().privacy).toEqual({ status: 'idle' });
  });
});

describe('Keep navigation', () => {
  it('loads a fresh authorized collection, then can enter discovery', async () => {
    const api = new FakeApi();
    const store = new ReaderStore(api, new ReaderStorage(new MemoryStorageBackend()));
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.universeQueue.push(universeOf());
    store.openKeep();
    await waitFor(() => store.getState().universe.status === 'loaded');
    expect(store.getState().screen).toBe('keep');
    api.feedQueue.push({ decisionId: 'd1', universeId: universeOf().universeId, accountRevision: 1, privacyEpoch: 0, items: [feedItem()] });
    store.enterScroll();
    await waitFor(() => store.getState().scroll.status === 'reading');
    expect(store.getState().screen).toBe('scroll');
  });
});
