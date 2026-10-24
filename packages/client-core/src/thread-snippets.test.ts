import { describe, expect, it } from 'vitest';
import {
  MIN_RANGE_MS,
  formatClock,
  formatRange,
  initialRange,
  nudgeRange,
  passageOf,
  sentenceRanges,
  setRangeEnd,
} from './thread-snippets';

describe('writing a Reel range', () => {
  it('writes minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(18_400)).toBe('0:18');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatRange(18_000, 31_000)).toBe('0:18–0:31');
  });
});

describe('building a Reel range', () => {
  const duration = 30_000;
  it('starts where the person is, on a whole second, and stays in the Reel', () => {
    expect(initialRange(18_700, duration)).toEqual({ startMs: 18_000, endMs: 28_000 });
    expect(initialRange(27_000, duration)).toEqual({ startMs: 27_000, endMs: 30_000 });
    expect(initialRange(30_000, duration)).toEqual({ startMs: 29_000, endMs: 30_000 });
    expect(initialRange(0, 800)).toEqual({ startMs: 0, endMs: 800 });
  });
  it('moves an end by a step and never lets the range leave the Reel or shrink below the floor', () => {
    const range = { startMs: 10_000, endMs: 14_000 };
    expect(nudgeRange(range, 'start', -1_000, duration)).toEqual({ startMs: 9_000, endMs: 14_000 });
    expect(nudgeRange(range, 'start', 5_000, duration)).toEqual({ startMs: 13_000, endMs: 14_000 });
    expect(nudgeRange(range, 'start', -50_000, duration)).toEqual({ startMs: 0, endMs: 14_000 });
    expect(nudgeRange(range, 'end', -9_000, duration)).toEqual({ startMs: 10_000, endMs: 10_000 + MIN_RANGE_MS });
    expect(nudgeRange(range, 'end', 99_000, duration)).toEqual({ startMs: 10_000, endMs: duration });
  });
  it('sets an end from the player position under the same rules', () => {
    const range = { startMs: 10_000, endMs: 14_000 };
    expect(setRangeEnd(range, 'start', 12_900, duration)).toEqual({ startMs: 12_000, endMs: 14_000 });
    expect(setRangeEnd(range, 'end', 11_000, duration)).toEqual({ startMs: 10_000, endMs: 11_000 });
    expect(setRangeEnd(range, 'start', 20_000, duration)).toEqual({ startMs: 13_000, endMs: 14_000 });
  });
});

describe('cutting a paragraph into passages', () => {
  const text =
    'Read this: the animal didn’t cross the street because it was too tired. You knew at once that “it” meant the animal! Did you? Yes…';
  it('finds sentence ranges that read back as whole sentences', () => {
    expect(sentenceRanges(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      'Read this: the animal didn’t cross the street because it was too tired.',
      'You knew at once that “it” meant the animal!',
      'Did you?',
      'Yes…',
    ]);
  });
  it('keeps closing quotes with the sentence and a decimal point inside it', () => {
    const quoted = 'She said “stop.” It was 3.5 metres long.';
    expect(sentenceRanges(quoted).map(({ start, end }) => quoted.slice(start, end))).toEqual([
      'She said “stop.”',
      'It was 3.5 metres long.',
    ]);
  });
  it('returns nothing for blank text and one range for text with no full stop', () => {
    expect(sentenceRanges('   ')).toEqual([]);
    expect(sentenceRanges('no stop here')).toEqual([{ start: 0, end: 12 }]);
  });
  it('cuts a sentence longer than a passage at a space', () => {
    const long = `${'word '.repeat(40).trim()}.`;
    const parts = sentenceRanges(long, 50);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.end - part.start).toBeLessThanOrEqual(50);
      expect(long.slice(part.start, part.end)).not.toMatch(/^\s|\s$/);
    }
  });
  it('joins a run of sentences into one passage and shrinks one that is too long', () => {
    const sentences = sentenceRanges(text);
    expect(passageOf(sentences, 1, 2)).toEqual({ start: sentences[1]!.start, end: sentences[2]!.end });
    expect(passageOf(sentences, 2, 1)).toEqual({ start: sentences[1]!.start, end: sentences[2]!.end });
    expect(passageOf(sentences, 0, 3, 100)).toEqual({ start: sentences[0]!.start, end: sentences[0]!.end });
    expect(passageOf(sentences, 9, 9)).toBeUndefined();
  });
});
