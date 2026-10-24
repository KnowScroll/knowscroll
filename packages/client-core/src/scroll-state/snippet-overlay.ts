import { defaultBlockState, findBlock, type BlockState, type BlockStateSnapshot, type ScrollDocument } from '@knowscroll/scroll-model';
import type { ScrollBlockKey, ScrollBlockStateStore } from './block-state-store';

/**
 * The settings of an opened snippet's block for the reader's article: the sender's snapshot (gaps
 * filled from the block's defaults, so a value the sender left out takes the default), held in memory
 * only. Every other block keeps using the reader's own store, and the reader's own saved settings of
 * this block are neither read nor overwritten: leaving the article leaves them as they were.
 */
export function overlayBlockState(
  base: ScrollBlockStateStore,
  document: ScrollDocument,
  blockId: string,
  snapshot: BlockStateSnapshot | undefined,
): ScrollBlockStateStore {
  const block = findBlock(document, blockId)?.block;
  const defaults = block === undefined ? null : defaultBlockState(block);
  const shared = (): BlockState | null => {
    if (snapshot === undefined) return defaults;
    if (snapshot.state.type === 'simulation' && defaults?.type === 'simulation')
      return { type: 'simulation', params: { ...defaults.params, ...snapshot.state.params } };
    return snapshot.state;
  };
  let current = shared();
  const isShared = (key: ScrollBlockKey) =>
    key.blockId === blockId && key.assetId === document.assetId && key.revision === document.revision;
  return {
    get: (key) => (isShared(key) ? current : base.get(key)),
    set(key, state) {
      if (isShared(key)) current = state;
      else base.set(key, state);
    },
    clear(key) {
      if (isShared(key)) current = shared();
      else base.clear(key);
    },
    earlier: (key) => (isShared(key) ? null : base.earlier(key)),
  };
}
