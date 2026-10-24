import { describe, expect, it } from 'vitest';
import { buildBlockStateSnapshot, defaultBlockState, findBlock, type ScrollDocument } from '@knowscroll/scroll-model';
import { readFileSync } from 'node:fs';
import { overlayBlockState } from './snippet-overlay';
import { createScopedBlockStateStore } from './block-state-store';

/** scroll-model's labelled CI fixture (not product content): a Scroll with a diagram and a slider. */
const document = JSON.parse(
  readFileSync(new URL('../../../scroll-model/fixtures/documents/attention-slowly.json', import.meta.url), 'utf8'),
) as ScrollDocument;
const sim = findBlock(document, 'length-sim')!.block;
const diagram = findBlock(document, 'it-diagram')!.block;
const key = (blockId: string) => ({ assetId: document.assetId, revision: document.revision, blockId });

function scopedStorage() {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value),
    remove: (name: string) => void values.delete(name),
  };
}

describe('opening a snippet’s block as set', () => {
  it('shows the sender’s settings and keeps the reader’s own saved settings untouched', () => {
    const own = createScopedBlockStateStore(scopedStorage());
    own.set(key('length-sim'), { type: 'simulation', params: { len: 1024 } });
    const snapshot = buildBlockStateSnapshot(sim, { type: 'simulation', params: { len: 4096 } });
    if (snapshot.kind !== 'snapshot') throw new Error('CI snapshot');
    const overlay = overlayBlockState(own, document, 'length-sim', snapshot.snapshot);
    expect(overlay.get(key('length-sim'))).toEqual({ type: 'simulation', params: { len: 4096 } });
    // The reader moves the slider while reading: it stays in memory.
    overlay.set(key('length-sim'), { type: 'simulation', params: { len: 2048 } });
    expect(overlay.get(key('length-sim'))).toEqual({ type: 'simulation', params: { len: 2048 } });
    expect(own.get(key('length-sim'))).toEqual({ type: 'simulation', params: { len: 1024 } });
    overlay.clear(key('length-sim'));
    expect(overlay.get(key('length-sim'))).toEqual({ type: 'simulation', params: { len: 4096 } });
  });

  it('leaves every other block to the reader’s own store', () => {
    const own = createScopedBlockStateStore(scopedStorage());
    const overlay = overlayBlockState(own, document, 'length-sim', undefined);
    const state = defaultBlockState(diagram);
    if (state === null) throw new Error('CI diagram has no state');
    overlay.set(key('it-diagram'), state);
    expect(own.get(key('it-diagram'))).toEqual(state);
  });

  it('takes the default for a value the sender left out, and the default state when nothing was included', () => {
    const own = createScopedBlockStateStore(scopedStorage());
    const left = buildBlockStateSnapshot(sim, { type: 'simulation', params: { len: 4096 } });
    if (left.kind !== 'snapshot') throw new Error('CI snapshot');
    const empty = { ...left.snapshot, state: { type: 'simulation' as const, params: {} } };
    expect(overlayBlockState(own, document, 'length-sim', empty).get(key('length-sim'))).toEqual({
      type: 'simulation',
      params: { len: 512 },
    });
    expect(overlayBlockState(own, document, 'length-sim', undefined).get(key('length-sim'))).toEqual({
      type: 'simulation',
      params: { len: 512 },
    });
  });
});
