import { describe, expect, it } from 'vitest';
import { readablePlace } from './export.js';

const none = { place_kind: null, position_ms: null, part: null, parts: null };

describe('readablePlace', () => {
  it('words a Reel position as a clock to the second', () => {
    expect(readablePlace({ ...none, place_kind: 'reel', position_ms: 31_400 })).toEqual({
      kind: 'reel',
      position: 'at 0:31',
    });
    expect(readablePlace({ ...none, place_kind: 'reel', position_ms: 0 })).toEqual({
      kind: 'reel',
      position: 'at 0:00',
    });
    expect(readablePlace({ ...none, place_kind: 'reel', position_ms: 754_999 })).toEqual({
      kind: 'reel',
      position: 'at 12:34',
    });
  });

  it('words a Scroll position as a part of the whole, and gives the kind alone when the block is gone', () => {
    expect(readablePlace({ ...none, place_kind: 'scroll', part: '2', parts: 5 })).toEqual({
      kind: 'scroll',
      position: 'part 2 of 5',
    });
    expect(readablePlace({ ...none, place_kind: 'scroll' })).toEqual({ kind: 'scroll' });
  });

  it('has nothing to say where no place was kept', () => {
    expect(readablePlace(none)).toBeNull();
  });

  it('never carries a stored position, block id or offset', () => {
    const words = JSON.stringify(readablePlace({ ...none, place_kind: 'scroll', part: 1, parts: 3 }));
    expect(words).not.toMatch(/blockId|offset|positionMs/);
  });
});
