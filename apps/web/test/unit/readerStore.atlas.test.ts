import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../src/api/client.ts';
import { ReaderStore } from '../../src/state/readerStore.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import type { WebAtlasResponse as AtlasResponse } from '@knowscroll/contracts/atlas';
import { FakeApi, universeOf } from './fakeApi.ts';

const placeId = '00000000-0000-4000-8000-000000000001';

function atlasOf(overrides: Partial<AtlasResponse> = {}): AtlasResponse {
  return {
    policyVersion: 'cartographer-v1',
    places: [{
      placeId,
      kind: 'planet',
      parentPlaceId: null,
      anchor: { code: 'gravity', name: 'Gravity', description: 'How mass changes motion.' },
      basis: null,
      attention: { state: 'anchored', episodes: 2, daysActive: 1 },
      scrolls: { total: 3, seen: 1 },
      formedAt: '2026-09-20T12:00:00.000Z',
      formedBy: 'cartographer-v1',
      foundation: null,
      rooms: [],
      demand: null,
    }],
    relations: [],
    chronicle: [],
    ...overrides,
  };
}

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

describe('ReaderStore: Atlas', () => {
  let api: FakeApi;
  let storage: ReaderStorage;
  let store: ReaderStore;

  beforeEach(() => {
    api = new FakeApi();
    storage = new ReaderStorage(new MemoryStorageBackend());
    store = new ReaderStore(api, storage);
  });

  async function enterAtlas(epoch = 0): Promise<void> {
    api.universeQueue.push(universeOf({ privacyEpoch: epoch }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.atlasQueue.push(atlasOf());
    store.enterAtlas();
    await waitFor(() => store.getState().atlas.status === 'loaded');
  }

  it('loads Atlas from the API on entry', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.atlasQueue.push(atlasOf());

    store.enterAtlas();

    expect(store.getState().atlas).toEqual({ status: 'loading' });
    await waitFor(() => store.getState().atlas.status === 'loaded');
    expect(store.getState().screen).toBe('atlas');
    expect(store.getState().atlas).toEqual({ status: 'loaded', response: atlasOf(), settingAside: null, error: null });
  });

  it('keeps a read error retryable and loads the next response on retry', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.atlasQueue.push(new ApiException({ kind: 'network', message: 'connection reset' }));

    store.enterAtlas();
    await waitFor(() => store.getState().atlas.status === 'unavailable');
    expect(store.getState().universe.status).toBe('loaded');

    api.atlasQueue.push(atlasOf());
    store.retryAtlas();
    await waitFor(() => store.getState().atlas.status === 'loaded');
    expect(api.atlasQueue).toHaveLength(0);
    expect(store.getState().atlas.status).toBe('loaded');
  });

  it('rejects a place with the observed privacy epoch and applies the returned Atlas', async () => {
    await enterAtlas(7);
    const updated = atlasOf({ places: [] });
    api.rejectAtlasQueue.push(updated);

    store.setAsideAtlasPlace(placeId);
    expect(api.rejectAtlasCalls).toEqual([{ placeId, expectedPrivacyEpoch: 7 }]);
    expect(store.getState().atlas).toMatchObject({ status: 'loaded', settingAside: placeId, error: null });
    await waitFor(() => {
      const atlas = store.getState().atlas;
      return atlas.status === 'loaded' && atlas.settingAside === null;
    });
    expect(store.getState().atlas).toEqual({ status: 'loaded', response: updated, settingAside: null, error: null });
  });

  it('restores the current Atlas and exposes a recoverable place rejection failure', async () => {
    await enterAtlas();
    api.rejectAtlasQueue.push(new ApiException({ kind: 'server', statusCode: 500, body: 'boom' }));

    store.setAsideAtlasPlace(placeId);
    await waitFor(() => {
      const atlas = store.getState().atlas;
      return atlas.status === 'loaded' && atlas.error !== null;
    });
    expect(store.getState().atlas).toEqual({
      status: 'loaded', response: atlasOf(), settingAside: null,
      error: 'Connection interrupted. Please retry; your action keeps the same identity.',
    });
    expect(store.getState().universe.status).toBe('loaded');
  });

  it('ignores a read response that arrives after navigation away from Atlas', async () => {
    api.universeQueue.push(universeOf());
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const getAtlas = api.getAtlas.bind(api);
    api.getAtlas = async () => { await gate; return getAtlas(); };
    api.atlasQueue.push(atlasOf());
    store.enterAtlas();
    store.returnFromAtlas();
    release();
    await settle();

    expect(store.getState().screen).toBe('universe');
    expect(store.getState().atlas).toEqual({ status: 'idle' });
  });

  it.each([
    [401, true],
    [409, false],
  ] as const)('fails closed when Atlas returns %i (unauthorized: %s)', async (statusCode, unauthorized) => {
    const onSignedOut = vi.fn<(message: string | null, verify: boolean) => void>();
    store = new ReaderStore(api, storage, onSignedOut);
    api.universeQueue.push(universeOf({ privacyEpoch: 3 }));
    store.init();
    await waitFor(() => store.getState().universe.status === 'loaded');
    api.atlasQueue.push(new ApiException({ kind: 'server', statusCode, body: '{}' }));

    store.enterAtlas();
    await waitFor(() => store.getState().universe.status === 'unavailable');

    expect(store.getState().screen).toBe('universe');
    expect(store.getState().atlas).toEqual({ status: 'idle' });
    expect(storage.readSession()).toBeNull();
    if (unauthorized) expect(onSignedOut).toHaveBeenCalledWith(null, true);
    else expect(onSignedOut).not.toHaveBeenCalled();
  });
});
