import { describe, expect, it } from 'vitest';
import type { BlockState } from '@knowscroll/scroll-model';
import { createAccountScope, memoryStore } from '../account-scope';
import { createScopedBlockStateStore } from './block-state-store';

/**
 * Block state kept per (asset, revision, block) in an account scope's own storage. Accounts,
 * assets and blocks are labelled fixtures; no network.
 */
const account = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@scroll-state.test',
};

function scopeOver(store = memoryStore()) {
  const scope = createAccountScope({
    account,
    baseUrl: 'https://app.scroll-state.test',
    fetch: () => Promise.reject(new Error('no network in this test')),
    authorization: () => undefined,
    store,
  });
  return { scope, store };
}

const key = (revision: number, blockId = 'sim-weight') => ({ assetId: 'fixture-asset', revision, blockId });
const sim = (weight: number): BlockState => ({ type: 'simulation', params: { weight } });

describe('the scoped block-state store', () => {
  it('returns what was set for a revision and block, and nothing for another', () => {
    const { scope } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(2), sim(60));

    expect(states.get(key(2))).toEqual(sim(60));
    expect(states.get(key(3))).toBeNull();
    expect(states.get(key(2, 'sim-other'))).toBeNull();
  });

  it('clears one revision of one block', () => {
    const { scope } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(2), sim(60));
    states.set(key(3), sim(70));

    states.clear(key(3));

    expect(states.get(key(3))).toBeNull();
    expect(states.get(key(2))).toEqual(sim(60));
  });

  it('knows the newest state of an earlier revision, so a new revision can say it started over', () => {
    const { scope } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(1), sim(50));
    states.set(key(2), sim(60));

    expect(states.earlier(key(3))).toEqual({ revision: 2, state: sim(60) });
    expect(states.earlier(key(2))).toEqual({ revision: 1, state: sim(50) });
    expect(states.earlier(key(1))).toBeNull();
  });

  it('keeps only the newest few revisions of a block', () => {
    const { scope, store } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    for (let revision = 1; revision <= 7; revision += 1) states.set(key(revision), sim(revision));

    expect(states.get(key(1))).toBeNull();
    expect(states.get(key(3))).toBeNull();
    expect(states.get(key(4))).toEqual(sim(4));
    expect(states.get(key(7))).toEqual(sim(7));
    expect(store.keys().filter((entry) => entry.includes('fixture-asset.7.'))).toHaveLength(1);
  });

  it('reads through the schema: a value that is not a block state is forgotten, never returned', () => {
    const { scope } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(2), sim(60));
    scope.storage.set('scroll.block.fixture-asset.2.sim-weight', JSON.stringify({ type: 'simulation', params: 'x' }));
    scope.storage.set('scroll.block.fixture-asset.3.sim-weight', '{not json');

    expect(states.get(key(2))).toBeNull();
    expect(states.get(key(3))).toBeNull();
    expect(scope.storage.get('scroll.block.fixture-asset.2.sim-weight')).toBeUndefined();
  });

  it('does not store a state larger than a snapshot may be', () => {
    const { scope } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index * 1000]));

    states.set(key(2), { type: 'simulation', params });

    expect(states.get(key(2))).toBeNull();
  });

  it('is purged when the account scope ends, and nothing is left for another account', () => {
    const { scope, store } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(2), sim(60));
    states.set(key(2, 'disclosure-why'), { type: 'disclosure', expanded: true });
    expect(store.keys().length).toBeGreaterThan(0);

    scope.end();

    expect(store.keys()).toEqual([]);
    const next = createAccountScope({
      account: { ...account, accountId: '0199b000-0000-7000-8000-00000000000b' },
      baseUrl: 'https://app.scroll-state.test',
      fetch: () => Promise.reject(new Error('no network in this test')),
      authorization: () => undefined,
      store,
    });
    expect(createScopedBlockStateStore(next.storage).get(key(2))).toBeNull();
  });

  it('fences late block-state writes after purge, including a queued callback', async () => {
    const { scope, store } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(1), sim(60));
    const late = Promise.resolve().then(() => {
      states.set(key(2), sim(99));
      states.clear(key(1));
    });
    scope.end();
    states.set(key(3), sim(100));
    await late;
    expect(store.keys()).toEqual([]);
    expect(states.get(key(1))).toBeNull();
    expect(states.earlier(key(4))).toBeNull();
  });

  it('keeps personal values on the device: it only ever reads and writes its own storage', () => {
    const { scope, store } = scopeOver();
    const states = createScopedBlockStateStore(scope.storage);
    states.set(key(2), sim(61.5));

    // Every key it wrote is under the scope's prefix; there is no other channel in the API.
    expect(store.keys().every((entry) => entry.startsWith('ks.scope.'))).toBe(true);
    expect(Object.keys(states).sort()).toEqual(['clear', 'earlier', 'get', 'set']);
  });
});
