import { describe, expect, it } from 'vitest';
import { formatLeaning } from './features.js';

const topicId = 'earth.seasons';
const counts = (reel: [number, number] | undefined, scroll: [number, number] | undefined) => ({
  topics: [
    {
      topicId,
      activity: 1,
      formats: [
        ...(reel ? [{ kind: 'reel' as const, measured: reel[0], qualified: reel[1] }] : []),
        ...(scroll ? [{ kind: 'scroll' as const, measured: scroll[0], qualified: scroll[1] }] : []),
      ],
    },
  ],
});

describe('which format a person leans to in a topic (#709)', () => {
  it('leans to the format they finish more of, by the same rate as format fit', () => {
    expect(formatLeaning(counts([4, 4], [4, 1]), topicId)).toBe('reel');
    expect(formatLeaning(counts([4, 0], [2, 2]), topicId)).toBe('scroll');
  });

  it('says nothing when the rates are even, the topic is unknown or there is no evidence', () => {
    expect(formatLeaning(counts([2, 1], [2, 1]), topicId)).toBeUndefined();
    expect(formatLeaning(counts(undefined, undefined), topicId)).toBeUndefined();
    expect(formatLeaning(counts([4, 4], [4, 0]), 'other.topic')).toBeUndefined();
    expect(formatLeaning(undefined, topicId)).toBeUndefined();
  });
});
