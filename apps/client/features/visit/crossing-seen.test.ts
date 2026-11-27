import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { crossingSeen, markCrossingSeen } from './crossing-seen';

const account = { accountId: 'a', universeId: 'u', privacyEpoch: 1, email: 'seen@fixture.test' };
const scopeOver = (store = memoryStore(), over: Partial<typeof account> = {}) =>
  createAccountScope({
    account: { ...account, ...over },
    baseUrl: 'https://seen.fixture.test',
    authorization: () => undefined,
    store,
    fetch: () => Promise.reject(new Error('no network in this test')),
  });

describe('the friends whose crossing this device has shown', () => {
  it('knows nobody at first, then the friend it was told of, by handle without case', () => {
    const scope = scopeOver();
    expect(crossingSeen(scope, 'fixture.ravi')).toBe(false);
    markCrossingSeen(scope, 'Fixture.Ravi');
    expect(crossingSeen(scope, 'fixture.ravi')).toBe(true);
    expect(crossingSeen(scope, 'fixture.mei')).toBe(false);
    scope.end();
  });

  it('keeps the newest 200 and notes a friend once', () => {
    const scope = scopeOver();
    for (let n = 0; n < 205; n += 1) markCrossingSeen(scope, `friend${String(n)}`);
    markCrossingSeen(scope, 'friend204');
    expect(crossingSeen(scope, 'friend0')).toBe(false);
    expect(crossingSeen(scope, 'friend4')).toBe(false);
    expect(crossingSeen(scope, 'friend5')).toBe(true);
    expect(crossingSeen(scope, 'friend204')).toBe(true);
    const stored = JSON.parse(scope.storage.get('universe.crossing-seen.v1') ?? '{}') as { handles: string[] };
    expect(stored.handles).toHaveLength(200);
    scope.end();
  });

  it('belongs to no other account or privacy epoch, and is gone when the scope ends', () => {
    const store = memoryStore();
    const scope = scopeOver(store);
    markCrossingSeen(scope, 'fixture.ravi');
    const other = scopeOver(store, { accountId: 'b', universeId: 'v' });
    expect(crossingSeen(other, 'fixture.ravi')).toBe(false);
    other.end();
    scope.end();
    expect(crossingSeen(scope, 'fixture.ravi')).toBe(false);
    expect([...store.keys()].some((key) => key.includes('universe.crossing-seen'))).toBe(false);
    const reset = scopeOver(store, { privacyEpoch: 2 });
    expect(crossingSeen(reset, 'fixture.ravi')).toBe(false);
    reset.end();
  });

  it('ignores and removes a damaged value, and refuses a handle that is not one', () => {
    const scope = scopeOver();
    scope.storage.set('universe.crossing-seen.v1', '{"handles":[42]}');
    expect(crossingSeen(scope, 'fixture.ravi')).toBe(false);
    expect(scope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    scope.storage.set('universe.crossing-seen.v1', 'not json');
    expect(crossingSeen(scope, 'fixture.ravi')).toBe(false);
    expect(scope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    markCrossingSeen(scope, '   ');
    markCrossingSeen(scope, 'x'.repeat(65));
    expect(scope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    scope.end();
  });
});
