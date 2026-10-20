import { anchorKey, combineObservers, createAnchorKeeper } from './anchor-keeper';

const order = ['intro', 'sunlight', 'air', 'rule'];

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => void values.set(key, value),
  };
}

describe('the resume anchor', () => {
  it('remembers the topmost visible block by article revision, and gives it back on return', () => {
    const store = storage();
    const keeper = createAnchorKeeper({ assetId: 'asset-1', revision: 2, order, storage: store });
    expect(keeper.restore()).toBeUndefined();
    keeper.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 1, at: 1 });
    keeper.observer.onBlockVisibility({ blockId: 'sunlight', visibleFraction: 0.6, at: 2 });
    keeper.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 0, at: 3 });
    expect(store.values.get(anchorKey('asset-1', 2))).toBe('sunlight');
    keeper.observer.onBlockVisibility({ blockId: 'air', visibleFraction: 1, at: 4 });
    keeper.observer.onBlockVisibility({ blockId: 'sunlight', visibleFraction: 0.05, at: 5 });
    expect(store.values.get(anchorKey('asset-1', 2))).toBe('air');
    // Returning: a fresh keeper over the same storage restores the block, never a pixel offset.
    expect(createAnchorKeeper({ assetId: 'asset-1', revision: 2, order, storage: store }).restore()).toBe('air');
  });

  it('never points a new revision at an old position, or at a block the document no longer has', () => {
    const store = storage();
    store.set(anchorKey('asset-1', 1), 'air');
    expect(createAnchorKeeper({ assetId: 'asset-1', revision: 2, order, storage: store }).restore()).toBeUndefined();
    store.set(anchorKey('asset-1', 2), 'removed-block');
    expect(createAnchorKeeper({ assetId: 'asset-1', revision: 2, order, storage: store }).restore()).toBeUndefined();
  });

  it('writes only when the anchor changes, and ignores blocks it does not know', () => {
    const set = jest.fn();
    const keeper = createAnchorKeeper({ assetId: 'a', revision: 1, order, storage: { get: () => undefined, set } });
    keeper.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 0.5, at: 1 });
    keeper.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 0.9, at: 2 });
    keeper.observer.onBlockVisibility({ blockId: 'ghost', visibleFraction: 1, at: 3 });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('fans every observer event out to each observer, and one that throws does not starve the rest', () => {
    const seen: string[] = [];
    const broken = {
      onBlockVisibility: () => {
        throw new Error('broken');
      },
      onBlockInteraction: () => undefined,
      onActivity: () => undefined,
    };
    const recording = {
      onBlockVisibility: () => void seen.push('visibility'),
      onBlockInteraction: () => void seen.push('interaction'),
      onActivity: () => void seen.push('activity'),
    };
    const both = combineObservers(broken, recording);
    both.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: 1 });
    both.onBlockInteraction({ blockId: 'a', kind: 'control', at: 2 });
    both.onActivity({ active: false, at: 3 });
    expect(seen).toEqual(['visibility', 'interaction', 'activity']);
  });
});
