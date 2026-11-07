import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { readSeenLandmark, writeSeenLandmark } from './landmark-seen';

const account = { accountId: 'a', universeId: 'u', privacyEpoch: 1, email: 'seen@fixture.test' };
const scopeOver = (store = memoryStore(), over: Partial<typeof account> = {}) =>
  createAccountScope({
    account: { ...account, ...over },
    baseUrl: 'https://seen.fixture.test',
    authorization: () => undefined,
    store,
    fetch: () => Promise.reject(new Error('no network in this test')),
  });

describe('the landmark already seen on this device (#694)', () => {
  it('is kept for the account and read back; a newer landmark replaces it', () => {
    const scope = scopeOver();
    expect(readSeenLandmark(scope)).toBeUndefined();
    writeSeenLandmark(scope, 'asset-1:1');
    expect(readSeenLandmark(scope)).toBe('asset-1:1');
    writeSeenLandmark(scope, 'asset-2:1');
    expect(readSeenLandmark(scope)).toBe('asset-2:1');
    scope.end();
  });

  it('belongs to no other account or privacy epoch, and is gone when the scope ends', () => {
    const store = memoryStore();
    const scope = scopeOver(store);
    writeSeenLandmark(scope, 'asset-1:1');
    const other = scopeOver(store, { accountId: 'b', universeId: 'v' });
    expect(readSeenLandmark(other)).toBeUndefined();
    other.end();
    scope.end();
    expect(readSeenLandmark(scope)).toBeUndefined();
    expect([...store.keys()].some((key) => key.includes('universe.landmark-seen'))).toBe(false);
    const reset = scopeOver(store, { privacyEpoch: 2 });
    expect(readSeenLandmark(reset)).toBeUndefined();
    reset.end();
  });

  it('ignores and removes a damaged value', () => {
    const scope = scopeOver();
    scope.storage.set('universe.landmark-seen.v1', '{"landmarkId":42}');
    expect(readSeenLandmark(scope)).toBeUndefined();
    expect(scope.storage.get('universe.landmark-seen.v1')).toBeUndefined();
    scope.storage.set('universe.landmark-seen.v1', 'not json');
    expect(readSeenLandmark(scope)).toBeUndefined();
    writeSeenLandmark(scope, 'x'.repeat(500));
    expect(readSeenLandmark(scope)).toBeUndefined();
    scope.end();
  });
});
