import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { HERE_MARKER_MS, clearHereMarker, readHereMarker, writeHereMarker } from './universe-here-marker';

const account = { accountId: 'a', universeId: 'u', privacyEpoch: 1, email: 'here@fixture.test' };
const scopeOver = (store = memoryStore()) =>
  createAccountScope({
    account,
    baseUrl: 'https://here.fixture.test',
    authorization: () => undefined,
    store,
    fetch: () => Promise.reject(new Error('no network in this test')),
  });

describe('"You were here" marker (U04)', () => {
  it('is kept on the device for the account, read back, and cleared', () => {
    const scope = scopeOver();
    expect(readHereMarker(scope, 1_000)).toBeUndefined();
    writeHereMarker(scope, 'region-1', 1_000);
    expect(readHereMarker(scope, 2_000)).toBe('region-1');
    writeHereMarker(scope, 'region-2', 3_000);
    expect(readHereMarker(scope, 4_000)).toBe('region-2');
    clearHereMarker(scope);
    expect(readHereMarker(scope, 5_000)).toBeUndefined();
    scope.end();
  });

  it('is gone when the scope ends, and belongs to no other account', () => {
    const store = memoryStore();
    const scope = scopeOver(store);
    writeHereMarker(scope, 'region-1', 1_000);
    const other = createAccountScope({
      account: { ...account, accountId: 'b', universeId: 'v' },
      baseUrl: 'https://here.fixture.test',
      authorization: () => undefined,
      store,
      fetch: () => Promise.reject(new Error('no network in this test')),
    });
    expect(readHereMarker(other, 2_000)).toBeUndefined();
    scope.end();
    expect(readHereMarker(scope, 2_000)).toBeUndefined();
    expect([...store.keys()].some((key) => key.includes('universe.here'))).toBe(false);
    other.end();
  });

  it('ignores an old, future-dated or damaged value', () => {
    const scope = scopeOver();
    writeHereMarker(scope, 'region-1', 1_000);
    expect(readHereMarker(scope, 1_000 + HERE_MARKER_MS + 1)).toBeUndefined();
    expect(readHereMarker(scope, 1_000 - 10 * 60_000)).toBeUndefined();
    scope.storage.set('universe.here.v1', '{"placeId":42,"at":1}');
    expect(readHereMarker(scope, 2)).toBeUndefined();
    scope.storage.set('universe.here.v1', 'not json');
    expect(readHereMarker(scope, 2)).toBeUndefined();
    scope.end();
  });

  it('removes a stale or invalid marker from storage when it reads it', () => {
    const scope = scopeOver();
    writeHereMarker(scope, 'region-1', 1_000);
    expect(readHereMarker(scope, 1_000 + HERE_MARKER_MS + 1)).toBeUndefined();
    expect(scope.storage.get('universe.here.v1')).toBeUndefined();
    for (const damaged of ['not json', '{"placeId":42,"at":1}', '{"placeId":"r","at":"x"}', 'null']) {
      scope.storage.set('universe.here.v1', damaged);
      expect(readHereMarker(scope, 2)).toBeUndefined();
      expect(scope.storage.get('universe.here.v1')).toBeUndefined();
    }
    // A good marker is left alone by a read.
    writeHereMarker(scope, 'region-2', 5_000);
    expect(readHereMarker(scope, 6_000)).toBe('region-2');
    expect(readHereMarker(scope, 7_000)).toBe('region-2');
    scope.end();
  });
});
