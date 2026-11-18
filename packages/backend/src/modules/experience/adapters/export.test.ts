import { describe, expect, it } from 'vitest';
import { coverLine, readablePlace } from './export.js';

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

describe('coverLine', () => {
  const when = new Date('2026-11-18T23:50:00Z');
  const passed = { outcome: 'passed', cover_ms: null, recorded_at: when } as const;

  it('words a passed cover with how long it was on screen and how it was left', () => {
    expect(coverLine({ ...passed, on_screen: '1_5s_to_5s', way: 'next_cover' }, 'Tides')).toBe(
      'Passed a cover of Tides (on screen 1.5–5 s, then moved to the next cover), 18 Nov 2026',
    );
    expect(coverLine({ ...passed, on_screen: 'under_1_5s', way: 'more_covers' }, 'Tides')).toContain(
      'on screen under 1.5 s, then asked for more covers',
    );
    expect(coverLine({ ...passed, on_screen: 'over_5s', way: 'left' }, 'Tides')).toContain(
      'on screen over 5 s, then left the covers',
    );
  });

  it('words an opened cover with its time to a tenth of a second', () => {
    const opened = { outcome: 'opened', on_screen: null, way: null, recorded_at: when } as const;
    expect(coverLine({ ...opened, cover_ms: 4000 }, 'Tides')).toBe('Opened Tides from its cover after 4 s, 18 Nov 2026');
    expect(coverLine({ ...opened, cover_ms: 1540 }, 'Tides')).toContain('after 1.5 s');
  });

  it('names no identifier and no stored band or way key', () => {
    const line = coverLine({ ...passed, on_screen: 'over_5s', way: 'left' }, 'Withdrawn');
    expect(line).not.toMatch(/over_5s|next_cover|more_covers|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
