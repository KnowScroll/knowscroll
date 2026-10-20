import type { BlockState } from '@knowscroll/scroll-model';
import { createMemoryBlockStateStore } from './state';

const key = (revision: number, blockId = 'sim-weight') => ({ assetId: 'fixture-asset', revision, blockId });
const sim = (weight: number): BlockState => ({ type: 'simulation', params: { weight } });

describe('the in-memory block-state store', () => {
  it('keeps state by (asset, revision, block): another revision or block sees nothing', () => {
    const store = createMemoryBlockStateStore();
    store.set(key(2), sim(60));

    expect(store.get(key(2))).toEqual(sim(60));
    expect(store.get(key(3))).toBeNull();
    expect(store.get(key(2, 'sim-other'))).toBeNull();
  });

  it('clears one revision of one block and leaves the others', () => {
    const store = createMemoryBlockStateStore();
    store.set(key(2), sim(60));
    store.set(key(3), sim(70));

    store.clear(key(3));

    expect(store.get(key(3))).toBeNull();
    expect(store.get(key(2))).toEqual(sim(60));
  });

  it('finds the newest state of an earlier revision', () => {
    const store = createMemoryBlockStateStore();
    store.set(key(1), sim(50));
    store.set(key(2), sim(60));

    expect(store.earlier(key(3))).toEqual({ revision: 2, state: sim(60) });
    expect(store.earlier(key(2))).toEqual({ revision: 1, state: sim(50) });
    expect(store.earlier(key(1))).toBeNull();
  });

  it('is empty for a block that never had state, and stores are independent', () => {
    const first = createMemoryBlockStateStore();
    const second = createMemoryBlockStateStore();
    first.set(key(1), sim(50));

    expect(first.earlier(key(2))).not.toBeNull();
    expect(second.earlier(key(2))).toBeNull();
    expect(second.get(key(1))).toBeNull();
  });
});
