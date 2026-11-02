import type { AccountScope } from '@knowscroll/client-core';
import { notePartLeft, takePartLeft } from './part-left';

const scope = (active = true) => ({ active }) as unknown as AccountScope;
const series = { seriesId: 'ci-series' };

describe('which Part a step forward just left', () => {
  it('is given once to the later Part of the same series that opened', () => {
    const own = scope();
    notePartLeft(own, 'asset-2', { part: 1, ...series });
    expect(takePartLeft(own, 'asset-2', { part: 2, ...series })).toBe(1);
    expect(takePartLeft(own, 'asset-2', { part: 2, ...series })).toBeUndefined();
  });

  it('is nothing for a Scroll of another series or an earlier Part, so a related move says no place was kept', () => {
    const own = scope();
    notePartLeft(own, 'asset-6', { part: 1, ...series });
    expect(takePartLeft(own, 'asset-6', { part: 6, seriesId: 'another-series' })).toBeUndefined();
    notePartLeft(own, 'asset-6', { part: 3, ...series });
    expect(takePartLeft(own, 'asset-6', { part: 2, ...series })).toBeUndefined();
  });

  it('is nothing after the step is a minute old', () => {
    const own = scope();
    notePartLeft(own, 'asset-2', { part: 1, ...series }, 1_000);
    expect(takePartLeft(own, 'asset-2', { part: 2, ...series }, 1_000 + 61_000)).toBeUndefined();
  });

  it('is not carried into another scope, and not read once its own has ended', () => {
    const first = scope();
    notePartLeft(first, 'asset-2', { part: 1, ...series });
    expect(takePartLeft(scope(), 'asset-2', { part: 2, ...series })).toBeUndefined();
    const ending = scope();
    notePartLeft(ending, 'asset-2', { part: 1, ...series });
    (ending as { active: boolean }).active = false;
    expect(takePartLeft(ending, 'asset-2', { part: 2, ...series })).toBeUndefined();
    const ended = scope(false);
    notePartLeft(ended, 'asset-2', { part: 1, ...series });
    expect(takePartLeft(ended, 'asset-2', { part: 2, ...series })).toBeUndefined();
  });
});
