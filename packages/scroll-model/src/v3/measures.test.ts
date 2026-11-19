import { describe, expect, it } from 'vitest';
import { filler } from '../test-support/v2-fixtures.js';
import { validDocumentV3 } from '../test-support/v3-fixtures.js';
import { SCROLL_MEASURES_V3_VERSION, type AsideV3, type Beat } from './document.js';
import { LIMITS_V3, SCROLL_LIMITS_V3_VERSION } from './limits.js';
import {
  computeMeasuresV3,
  READING_SECONDS_V3,
  SECONDS_PER_CONTROL,
  SECONDS_PER_FIGURE,
  WORDS_PER_MINUTE_V3,
} from './measures.js';

const beat = (id: string, words: number, extra: Partial<Extract<Beat, { kind: 'plain' }>> = {}): Beat => ({
  kind: 'plain',
  id,
  text: filler(words, 1),
  simple: filler(8, 2),
  links: [],
  ...extra,
});
const aside = (anchorBeat: string, words: number): AsideV3 => ({
  id: `aside-${anchorBeat}`,
  kind: 'tangent',
  title: 'One two',
  text: filler(words, 3),
  anchorBeat,
  collapsed: true,
});
const measure = (beats: Beat[], asides: AsideV3[] = [], takeaway = '') =>
  computeMeasuresV3({ sections: [{ beats }], asides, takeaway });

describe('scroll-limits.v3 and scroll-measures.v3', () => {
  it('holds the numbers of the design', () => {
    expect(SCROLL_LIMITS_V3_VERSION).toBe('scroll-limits.v3');
    expect(SCROLL_MEASURES_V3_VERSION).toBe('scroll-measures.v3');
    expect(LIMITS_V3).toMatchObject({
      sections: { min: 2, max: 3 },
      beatsPerSection: { min: 2, max: 6 },
      beats: { min: 9, max: 14 },
      beatWords: 70,
      firstBeatWords: 45,
      mainWords: { min: 350, max: 700 },
      pictures: { min: 1, max: 3 },
      controls: 2,
      linksPerBeat: 3,
      asides: { min: 1, max: 4 },
      askSuggestions: 3,
      takeawaySentences: { min: 1, max: 3 },
    });
    expect([WORDS_PER_MINUTE_V3, SECONDS_PER_FIGURE, SECONDS_PER_CONTROL]).toEqual([230, 4, 10]);
    expect(READING_SECONDS_V3).toEqual({ min: 120, max: 240 });
  });

  it('keeps the beat minimum at or above the three units coverage needs', () => {
    // Coverage (`MIN_BODY_BLOCKS` in the backend's recipe-coverage.ts, rule `scroll-recipe-coverage.v3`) refuses a
    // Scroll with fewer than three eligible units, and every beat is one unit. scroll-model cannot import the
    // backend, so the number is written here; if coverage's minimum rises, this test and `LIMITS_V3.beats.min` move together.
    const COVERAGE_MIN_UNITS = 3;
    expect(LIMITS_V3.beats.min).toBeGreaterThanOrEqual(COVERAGE_MIN_UNITS);
  });
});

describe('computeMeasuresV3', () => {
  it('reads 230 words in a minute, and a minute is one point zero', () => {
    expect(measure([beat('beat-1', 230)])).toMatchObject({
      version: SCROLL_MEASURES_V3_VERSION,
      readingSeconds: 60,
      readingMinutes: 1,
      mainWords: 230,
    });
  });

  it('adds four seconds for each beat that shows a figure', () => {
    const show = { picture: 'figure-one', state: {} };
    const plain = measure([beat('beat-1', 230), beat('beat-2', 0)]);
    const shown = measure([beat('beat-1', 230, { show }), beat('beat-2', 0, { show })]);
    expect(shown.readingSeconds - plain.readingSeconds).toBe(2 * SECONDS_PER_FIGURE);
  });

  it('adds ten seconds for each control on a plain beat, and a quote beat has none', () => {
    const show = { picture: 'figure-one', state: {} };
    const control = { kind: 'pick', label: 'Pick one' } as const;
    const without = measure([beat('beat-1', 230, { show })]);
    const withControl = measure([beat('beat-1', 230, { show, control })]);
    expect(withControl.readingSeconds - without.readingSeconds).toBe(SECONDS_PER_CONTROL);
    const quote: Beat = {
      kind: 'quote',
      id: 'beat-2',
      text: filler(230, 1),
      simple: filler(8, 2),
      links: [],
      cite: { who: 'Someone' },
    };
    expect(measure([quote]).readingSeconds).toBe(60);
  });

  it('weighs an aside with the beat it sits beside, and reads it as part of the essay', () => {
    const measures = measure([beat('beat-1', 20), beat('beat-2', 30)], [aside('beat-2', 10)]);
    const asideWords = 2 + 10;
    expect(measures.beats).toEqual([
      { beatId: 'beat-1', weight: 20 },
      { beatId: 'beat-2', weight: 30 + asideWords },
    ]);
    expect(measures.totalWeight).toBe(50 + asideWords);
    // The aside is read, but it is not the essay: `mainWords` is the beats' words alone.
    expect(measures.mainWords).toBe(50);
  });

  it('reads the takeaway and leaves the plainer version out', () => {
    const base = measure([beat('beat-1', 230)]);
    const withTakeaway = measure([beat('beat-1', 230)], [], filler(23, 4));
    expect(withTakeaway.readingSeconds).toBe(base.readingSeconds + 6);
    expect(withTakeaway.mainWords).toBe(230);
    expect(measure([beat('beat-1', 230, { simple: filler(500, 5) })])).toEqual(base);
  });

  it('never reports less than a second or a tenth of a minute', () => {
    const measures = measure([], [], '');
    expect(measures.readingSeconds).toBe(1);
    expect(measures.readingMinutes).toBe(0.1);
  });

  it('puts the valid fixture inside the reading brief, with a weight for every beat', () => {
    const { measures } = validDocumentV3();
    expect(measures.readingSeconds).toBeGreaterThanOrEqual(READING_SECONDS_V3.min);
    expect(measures.readingSeconds).toBeLessThanOrEqual(READING_SECONDS_V3.max);
    expect(measures.beats).toHaveLength(10);
  });
});
