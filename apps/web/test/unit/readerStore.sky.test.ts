import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebAtlasResponse as AtlasResponse } from '@knowscroll/contracts/atlas';
import { ApiException } from '../../src/api/client.ts';
import { ReaderStore } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { RESET_CONFIRMATION } from '../../src/api/types.ts';
import { FakeApi, feedItem, privacyResetReceiptOf, universeOf } from './fakeApi.ts';
import { atlasOf, ids, planet, region, sighting, twoStarSky } from './skyFixture.ts';

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

const OTHER_UNIVERSE = 'bbbbbbbb-0000-4000-8000-000000000000';
const SECOND = '10000000-0000-4000-8000-000000000002';
const gravityOnly = () => atlasOf([planet(ids.gravity, 'Gravity')]);
const lightOnly = () => atlasOf([planet(ids.light, 'Light')]);
const feedOf = (items = [feedItem()], universeId = universeOf().universeId) => ({ decisionId: `d-${Math.random()}`, universeId, accountRevision: 1, privacyEpoch: 0, items });

/** Holds every Atlas read open until the test settles it, in any order. */
function gateAtlas(api: FakeApi) {
  const pending: Array<{ resolve: (value: AtlasResponse) => void; reject: (error: unknown) => void }> = [];
  api.getAtlas = () => {
    api.atlasCalls++;
    return new Promise<AtlasResponse>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return pending;
}

describe('ReaderStore: the Universe sky (ADR-0051)', () => {
  let api: FakeApi;
  let storage: ReaderStorage;
  let store: ReaderStore;

  beforeEach(() => {
    api = new FakeApi();
    storage = new ReaderStorage(new MemoryStorageBackend());
    store = new ReaderStore(api, storage);
  });

  async function boot(atlas: AtlasResponse | Error = twoStarSky(), epoch = 0): Promise<void> {
    api.universeQueue.push(universeOf({ privacyEpoch: epoch }));
    api.atlasQueue.push(atlas);
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    await waitFor(() => store.getState().sky.status !== 'loading');
  }

  describe('loadSky', () => {
    it('reads the Atlas once the universe has loaded, and starts idle', async () => {
      expect(store.getState().sky).toEqual({ status: 'idle' });
      await boot();
      expect(api.atlasCalls).toBe(1);
      expect(store.getState().sky).toEqual({ status: 'loaded', response: twoStarSky(), settingAside: null, error: null });
      expect(store.getState().screen).toBe('universe');
    });

    it('a failed read leaves the Universe usable and says the stars are unavailable; retry reads again', async () => {
      await boot(new ApiException({ kind: 'network', message: 'connection reset' }));
      expect(store.getState().sky).toMatchObject({ status: 'unavailable' });
      expect(store.getState().universe.status).toBe('loaded');

      api.feedQueue.push(feedOf());
      store.enterScroll();
      await waitFor(() => store.getState().scroll.status === 'reading');
      api.universeQueue.push(universeOf());
      api.atlasQueue.push(gravityOnly());
      store.returnToUniverse();
      await waitFor(() => store.getState().sky.status === 'loaded');
      expect(store.getState().universe.status).toBe('loaded');

      api.atlasQueue.push(new ApiException({ kind: 'server', statusCode: 500, body: 'boom' }));
      store.retrySky();
      await waitFor(() => store.getState().sky.status === 'unavailable');
      api.atlasQueue.push(lightOnly());
      store.retrySky();
      await waitFor(() => store.getState().sky.status === 'loaded');
      expect(store.getState().sky).toMatchObject({ response: lightOnly() });
    });

    it('a 401 on the sky read fails closed like every other scoped read', async () => {
      const onSignedOut = vi.fn<(message: string | null, verify: boolean) => void>();
      store = new ReaderStore(api, storage, onSignedOut);
      api.universeQueue.push(universeOf());
      api.atlasQueue.push(new ApiException({ kind: 'server', statusCode: 401, body: '{}' }));
      store.init();
      await waitFor(() => store.getState().universe.status === 'unavailable');
      expect(store.getState().sky).toEqual({ status: 'idle' });
      expect(onSignedOut).toHaveBeenCalledWith(null, true);
    });

    it('keeps the last sky on screen while it is read again after the Atlas screen', async () => {
      await boot(gravityOnly());
      api.atlasQueue.push(twoStarSky());
      store.enterAtlas();
      await waitFor(() => store.getState().atlas.status === 'loaded');
      const pending = gateAtlas(api);
      store.returnFromAtlas();
      expect(store.getState().screen).toBe('universe');
      expect(store.getState().sky).toMatchObject({ status: 'loaded', response: gravityOnly() });
      pending[0]!.resolve(twoStarSky());
      await waitFor(() => {
        const sky = store.getState().sky;
        return sky.status === 'loaded' && sky.response.places.length > 1;
      });
      expect(api.atlasCalls).toBe(3);
    });

    it('drops a sky read that lands after the privacy epoch moved, whichever arrives first', async () => {
      const pending = gateAtlas(api);
      api.universeQueue.push(universeOf({ privacyEpoch: 0 }));
      store.init();
      await waitFor(() => pending.length === 1);

      api.universeQueue.push(universeOf({ privacyEpoch: 1 }));
      store.returnToUniverse();
      await waitFor(() => pending.length === 2);
      expect(store.getState().sky.status).toBe('loading');

      pending[1]!.resolve(lightOnly());
      await settle();
      pending[0]!.resolve(gravityOnly());
      await settle();
      expect(store.getState().sky).toMatchObject({ status: 'loaded', response: lightOnly() });
    });

    it('drops an old read even when it lands last, and ignores its late failure', async () => {
      const pending = gateAtlas(api);
      api.universeQueue.push(universeOf({ privacyEpoch: 0 }));
      store.init();
      await waitFor(() => pending.length === 1);
      api.universeQueue.push(universeOf({ privacyEpoch: 1 }));
      store.returnToUniverse();
      await waitFor(() => pending.length === 2);

      pending[0]!.reject(new ApiException({ kind: 'server', statusCode: 401, body: '{}' }));
      await settle();
      expect(store.getState().universe.status).toBe('loaded');
      expect(store.getState().sky.status).toBe('loading');
      pending[1]!.resolve(lightOnly());
      await waitFor(() => store.getState().sky.status === 'loaded');
      expect(store.getState().sky).toMatchObject({ response: lightOnly() });
    });

    it('never shows another universe\'s stars', async () => {
      const pending = gateAtlas(api);
      api.universeQueue.push(universeOf());
      store.init();
      await waitFor(() => pending.length === 1);
      api.universeQueue.push(universeOf({ universeId: OTHER_UNIVERSE }));
      store.returnToUniverse();
      await waitFor(() => pending.length === 2);
      pending[0]!.resolve(gravityOnly());
      await settle();
      expect(store.getState().sky.status).not.toBe('loaded');
      pending[1]!.resolve(lightOnly());
      await waitFor(() => store.getState().sky.status === 'loaded');
      expect(store.getState().sky).toMatchObject({ response: lightOnly() });
    });
  });

  describe('setAsideStar', () => {
    it('sends the observed privacy epoch and applies the returned Atlas', async () => {
      await boot(twoStarSky(), 4);
      api.rejectAtlasQueue.push(lightOnly());
      store.setAsideStar(ids.gravity);
      expect(api.rejectAtlasCalls).toEqual([{ placeId: ids.gravity, expectedPrivacyEpoch: 4 }]);
      expect(store.getState().sky).toMatchObject({ status: 'loaded', settingAside: ids.gravity, error: null });
      await waitFor(() => {
        const sky = store.getState().sky;
        return sky.status === 'loaded' && sky.settingAside === null;
      });
      expect(store.getState().sky).toEqual({ status: 'loaded', response: lightOnly(), settingAside: null, error: null });
    });

    it('refuses a possibility, an unknown place, or a sky that has not loaded', async () => {
      store.setAsideStar(ids.gravity);
      expect(api.rejectAtlasCalls).toEqual([]);
      await boot();
      store.setAsideStar(ids.starFormation);
      store.setAsideStar(ids.missingParent);
      expect(api.rejectAtlasCalls).toEqual([]);
    });

    it('keeps the sky and reports a recoverable failure', async () => {
      await boot();
      api.rejectAtlasQueue.push(new ApiException({ kind: 'server', statusCode: 500, body: 'boom' }));
      store.setAsideStar(ids.gravity);
      await waitFor(() => {
        const sky = store.getState().sky;
        return sky.status === 'loaded' && sky.error !== null;
      });
      expect(store.getState().sky).toMatchObject({ status: 'loaded', response: twoStarSky(), settingAside: null });
      expect(store.getState().toast).toBeTruthy();
      expect(store.getState().universe.status).toBe('loaded');
    });

    it('a stale privacy epoch (409) fails closed', async () => {
      await boot();
      api.rejectAtlasQueue.push(new ApiException({ kind: 'server', statusCode: 409, body: '{}' }));
      store.setAsideStar(ids.gravity);
      await waitFor(() => store.getState().universe.status === 'unavailable');
      expect(store.getState().sky).toEqual({ status: 'idle' });
    });

    it('a late reply never releases a newer read that is still in flight', async () => {
      await boot();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const reject = api.rejectAtlasPlace.bind(api);
      api.rejectAtlasPlace = async (placeId, epoch) => { await gate; return reject(placeId, epoch); };
      api.rejectAtlasQueue.push(lightOnly());
      store.setAsideStar(ids.gravity);

      // The reader leaves for Keep and comes back, then starts reading from a star.
      api.universeQueue.push(universeOf());
      api.atlasQueue.push(twoStarSky());
      store.openKeep();
      await waitFor(() => store.getState().universe.status === 'loaded');
      let releaseFeed!: () => void;
      const feedGate = new Promise<void>(resolve => { releaseFeed = resolve; });
      const getFeed = api.getFeed.bind(api);
      const asked: Array<string | undefined> = [];
      api.getFeed = async (...args) => {
        asked.push(args[3]);
        await feedGate;
        return getFeed(...args);
      };
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.light, 'Light');
      expect(asked).toEqual([ids.light]);

      release();
      await settle();
      // The discovery is still in flight: nothing else may start meanwhile.
      store.enterScroll();
      store.enterPlace(ids.gravity, 'Gravity');
      expect(asked).toEqual([ids.light]);
      releaseFeed();
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.light]);
    });
  });

  describe('enterPlace', () => {
    it('asks the feed within the chosen place, and the encounter says where it was read from', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.orbits, 'Orbits');
      expect(store.getState().screen).toBe('scroll');
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.orbits]);
      const scroll = store.getState().scroll;
      if (scroll.status !== 'reading') throw new Error('expected reading');
      expect(scroll.origin).toEqual({ type: 'place', placeId: ids.orbits, name: 'Orbits' });
      expect(storage.readSession()?.placeFrom).toEqual({ placeId: ids.orbits, name: 'Orbits' });
    });

    it('a failed read from a place retries within the same place', async () => {
      await boot();
      api.feedQueue.push(new ApiException({ kind: 'network', message: 'connection reset' }));
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'unavailable');
      api.feedQueue.push(feedOf());
      store.retryScrollLoad();
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.gravity, ids.gravity]);
      const scroll = store.getState().scroll;
      if (scroll.status !== 'reading') throw new Error('expected reading');
      expect(scroll.origin).toEqual({ type: 'place', placeId: ids.gravity, name: 'Gravity' });
    });

    it('an encounter read from a place has a recorded decision, so "why" is asked, not declared unrecorded', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');
      api.whyQueue.push(null);
      store.openWhy();
      await waitFor(() => api.whyCalls.length === 1);
      expect(api.whyCalls[0]!.assetId).toBe(feedItem().assetId);
    });

    it('a place that is no longer live ends the trip on the Universe instead of retrying forever', async () => {
      await boot();
      api.feedQueue.push(new ApiException({ kind: 'server', statusCode: 404, body: '{"error":"Place not found"}' }));
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().screen === 'universe');
      expect(store.getState().toast).toBe('Gravity is no longer one of your stars, so there is nothing to read from it.');
      expect(store.getState().scroll).toEqual({ status: 'idle' });
      api.feedQueue.push(feedOf());
      store.enterScroll();
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.gravity, undefined]);
    });

    it('keeps the whole trip within the place: Next asks within it too', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');
      api.feedQueue.push(feedOf([feedItem({ assetId: SECOND, title: 'A second Scroll from Gravity' })]));
      store.nextScroll();
      await waitFor(() => {
        const scroll = store.getState().scroll;
        return scroll.status === 'reading' && scroll.item.assetId === SECOND;
      });
      expect(api.feedPlaces).toEqual([ids.gravity, ids.gravity]);
      expect(api.feedExcludes[1]).toContain(feedItem().assetId);
      const scroll = store.getState().scroll;
      if (scroll.status !== 'reading') throw new Error('expected reading');
      expect(scroll.origin).toEqual({ type: 'place', placeId: ids.gravity, name: 'Gravity' });
    });

    it('a place with nothing to read returns to the Universe with a toast, and the next trip is unscoped', async () => {
      await boot();
      api.feedQueue.push(feedOf([]));
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().screen === 'universe');
      expect(store.getState().toast).toBe('Nothing more to read from Gravity right now.');
      expect(store.getState().scroll).toEqual({ status: 'idle' });
      expect(storage.readScreen()).toBe('universe');

      api.feedQueue.push(feedOf());
      store.enterScroll();
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.gravity, undefined]);
      const scroll = store.getState().scroll;
      if (scroll.status !== 'reading') throw new Error('expected reading');
      expect(scroll.origin).toEqual({ type: 'discovery' });
    });

    it('running out while reading within a place stays on the Scroll and says the trip is done', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');
      api.feedQueue.push(feedOf([]));
      store.nextScroll();
      await waitFor(() => {
        const scroll = store.getState().scroll;
        return scroll.status === 'reading' && scroll.discovery === 'exhausted';
      });
      expect(store.getState().screen).toBe('scroll');
      expect(store.getState().toast).toBeNull();
    });

    it('choosing the general stream clears the scope', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');
      store.enterScroll();
      api.feedQueue.push(feedOf([feedItem({ assetId: SECOND })]));
      store.nextScroll();
      await waitFor(() => {
        const scroll = store.getState().scroll;
        return scroll.status === 'reading' && scroll.item.assetId === SECOND;
      });
      expect(api.feedPlaces).toEqual([ids.gravity, undefined]);
      expect(storage.readSession()?.placeFrom).toBeUndefined();
    });

    it('returning to the Universe ends the trip within the place', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');
      api.universeQueue.push(universeOf());
      api.atlasQueue.push(twoStarSky());
      store.returnToUniverse();
      await waitFor(() => store.getState().universe.status === 'loaded' && store.getState().screen === 'universe');
      api.feedQueue.push(feedOf([feedItem({ assetId: SECOND, kind: 'Scroll' })]));
      store.enterTestReels();
      await waitFor(() => api.feedCalls === 2);
      expect(api.feedPlaces).toEqual([ids.gravity, undefined]);
    });

    it('a restored encounter keeps its place after a reload, and the trip continues within it', async () => {
      await boot();
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.gravity, 'Gravity');
      await waitFor(() => store.getState().scroll.status === 'reading');

      const reloadedApi = new FakeApi();
      reloadedApi.universeQueue.push(universeOf());
      reloadedApi.atlasQueue.push(twoStarSky());
      const reloaded = new ReaderStore(reloadedApi, storage);
      reloaded.init();
      await waitFor(() => reloaded.getState().scroll.status === 'reading');
      const scroll = reloaded.getState().scroll;
      if (scroll.status !== 'reading') throw new Error('expected reading');
      expect(scroll.origin).toEqual({ type: 'place', placeId: ids.gravity, name: 'Gravity' });
      expect(reloadedApi.feedCalls).toBe(0);

      reloadedApi.feedQueue.push(feedOf([feedItem({ assetId: SECOND })]));
      reloaded.nextScroll();
      await waitFor(() => reloadedApi.feedCalls === 1);
      expect(reloadedApi.feedPlaces).toEqual([ids.gravity]);
    });

    it('does nothing before the universe is ready', () => {
      store.enterPlace(ids.gravity, 'Gravity');
      expect(api.feedCalls).toBe(0);
      expect(store.getState().screen).toBe('universe');
    });

    it('a region inside a star can be read from on its own', async () => {
      await boot(atlasOf([planet(ids.gravity, 'Gravity'), region(ids.orbits, ids.gravity, 'Orbits'), sighting(ids.tides, ids.orbits, 'Tides', 'explains')]));
      api.feedQueue.push(feedOf());
      store.enterPlace(ids.orbits, 'Orbits');
      await waitFor(() => store.getState().scroll.status === 'reading');
      expect(api.feedPlaces).toEqual([ids.orbits]);
    });
  });

  it('a completed Reset forgets the drawn sky and any trip within a place', async () => {
    await boot();
    expect(store.getState().sky.status).toBe('loaded');
    store.openPrivacy();
    api.resetQueue.push(privacyResetReceiptOf({ epochBefore: 0, epochAfter: 1 }));
    store.beginReset();
    store.confirmReset(RESET_CONFIRMATION);
    await waitFor(() => {
      const privacy = store.getState().privacy;
      return privacy.status === 'open' && privacy.action.status === 'reset-complete';
    });
    expect(store.getState().sky).toEqual({ status: 'idle' });
  });
});
