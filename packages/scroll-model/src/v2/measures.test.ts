import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filler } from '../test-support/v2-fixtures.js';
import { WORDS_PER_MINUTE } from '../measures.js';
import { LIMITS } from '../limits.js';
import type { Aside, Stop } from './document.js';
import { LIMITS_V2, SCROLL_LIMITS_V2_VERSION } from './limits.js';
import { computeMeasuresV2, READING_SECONDS_V2, SECONDS_PER_CALL, stopWeight, stopWords, WORDS_PER_MINUTE_V2 } from './measures.js';

const read = (id: string, words: number): Stop => ({
  kind: 'read',
  id,
  blocks: [{ type: 'paragraph', text: filler(words, 1) }],
  simple: filler(5, 2),
});
const call = (id: string, kind: 'call_it' | 'final_call' = 'call_it'): Stop => ({
  kind,
  id,
  prompt: 'One two three four five?',
  options: ['one two', 'three four'],
  answer: 0,
  explain: filler(10, 3),
  twist: filler(10, 4),
  simple: filler(5, 5),
});
const recap = { captions: ['one two three', 'four five six'] };

describe('scroll-limits.v2 and scroll-measures.v2', () => {
  it('holds the numbers of the design: one stage, four calls, two other interactives, 230 wpm and ten seconds a call', () => {
    expect(SCROLL_LIMITS_V2_VERSION).toBe('scroll-limits.v2');
    expect(LIMITS_V2).toMatchObject({ stages: 1, calls: 4, otherInteractives: 2, stopWords: 60, lineWords: 12, askSuggestions: 3 });
    expect(WORDS_PER_MINUTE_V2).toBe(230);
    expect(SECONDS_PER_CALL).toBe(10);
    expect(READING_SECONDS_V2).toEqual({ min: 180, max: 360 });
  });

  it('leaves v1 untouched: its reading speed and its interactive count are what they were', () => {
    expect(WORDS_PER_MINUTE).toBe(200);
    expect(LIMITS.interactiveBlocks).toBe(8);
  });
});

describe('computeMeasuresV2', () => {
  it('reads 230 words in a minute', () => {
    const measures = computeMeasuresV2({ stops: [read('s1', 230)], asides: [], recap: { captions: [] } });
    expect(measures.readingSeconds).toBe(60);
    expect(measures.readingMinutes).toBe(1);
    expect(measures.totalWeight).toBe(230);
  });

  it('adds ten seconds for every call, the Final call included', () => {
    const base = computeMeasuresV2({ stops: [read('s1', 230)], asides: [], recap: { captions: [] } });
    const withCalls = computeMeasuresV2({ stops: [read('s1', 230), call('s2'), call('s3', 'final_call')], asides: [], recap });
    const words = stopWords(call('s2')) * 2 + 6;
    const expected = Math.round(((230 + words) * 60) / 230) + 2 * SECONDS_PER_CALL;
    expect(withCalls.readingSeconds).toBe(expected);
    expect(withCalls.readingSeconds).toBeGreaterThan(base.readingSeconds + 2 * SECONDS_PER_CALL);
  });

  it('counts a call\u2019s twist but never a stop\u2019s simple text, and counts asides with the stop they open next to', () => {
    const stop = call('s1');
    expect(stopWords(stop)).toBe(5 + 4 + 10 + 10);
    expect(stopWeight(stop)).toBe(stopWords(stop) + Math.round((230 * 10) / 60));
    const aside: Pick<Aside, 'title' | 'text' | 'anchorStop'> = { title: 'Where this stops', text: 'one two three', anchorStop: 's1' };
    const measures = computeMeasuresV2({ stops: [read('s1', 30), read('s2', 30)], asides: [aside], recap: { captions: [] } });
    expect(measures.stops).toEqual([
      { stopId: 's1', weight: 30 + 3 + 3 },
      { stopId: 's2', weight: 30 },
    ]);
  });

  it('is monotonic: more words never read faster, and one more call is always ten seconds more', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 300 }), (small, extra) => {
        const fewer = computeMeasuresV2({ stops: [read('s1', small)], asides: [], recap });
        const more = computeMeasuresV2({ stops: [read('s1', small + extra)], asides: [], recap });
        expect(more.readingSeconds).toBeGreaterThanOrEqual(fewer.readingSeconds);
        const withCall = computeMeasuresV2({ stops: [read('s1', small), call('s2')], asides: [], recap });
        const callSeconds = withCall.readingSeconds - fewer.readingSeconds;
        expect(callSeconds).toBeGreaterThanOrEqual(SECONDS_PER_CALL);
      }),
    );
  });
});
