import { describe, expect, it } from 'vitest';
import type { ScrollDocumentV2 } from './document.js';
import { anchorIsMoment, momentAnchorOf, momentOf, whyNoMoment } from './moment.js';

/** Authored fixture stops: two read stops and a call, never product content. */
const stops = [
  {
    kind: 'read',
    id: 's1',
    blocks: [
      { type: 'heading', level: 1, text: 'It leans' },
      { type: 'paragraph', text: 'Earth’s axis is tilted, and that tilt makes the seasons.' },
    ],
    simple: 'The tilt makes seasons.',
  },
  {
    kind: 'read',
    id: 's2',
    blocks: [{ type: 'line', text: 'Distance has nothing to do with it.' }],
    simple: 'Not distance.',
  },
  {
    kind: 'call_it',
    id: 's3',
    prompt: 'Which is it?',
    options: ['Distance', 'Tilt'],
    answer: 1,
    explain: 'Tilt.',
    twist: 'Plot twist.',
    simple: 'Tilt.',
  },
] as unknown as ScrollDocumentV2['stops'];

describe('a moment of a v2 Scroll', () => {
  it('is the words of one read stop, one block to a line', () => {
    expect(momentOf({ stops }, 's1')).toEqual({
      stopId: 's1',
      quote: 'It leans\nEarth’s axis is tilted, and that tilt makes the seasons.',
    });
    expect(momentOf({ stops }, 's2')?.quote).toBe('Distance has nothing to do with it.');
  });

  it('is not a call, which would give its answer away, and not a stop that is not there', () => {
    expect(momentOf({ stops }, 's3')).toBeUndefined();
    expect(momentOf({ stops }, 'nope')).toBeUndefined();
  });

  it('is not a stop whose words run past one passage', () => {
    const long = [
      { kind: 'read', id: 's9', blocks: [{ type: 'paragraph', text: 'x'.repeat(601) }], simple: 'x' },
    ] as unknown as ScrollDocumentV2['stops'];
    expect(momentOf({ stops: long }, 's9')).toBeUndefined();
  });

  it('says why a stop is not a moment', () => {
    const long = [
      { kind: 'read', id: 's9', blocks: [{ type: 'paragraph', text: 'x'.repeat(601) }], simple: 'x' },
    ] as unknown as ScrollDocumentV2['stops'];
    expect(whyNoMoment({ stops }, 's1')).toBeUndefined();
    expect(whyNoMoment({ stops }, 's3')).toBe('call');
    expect(whyNoMoment({ stops: long }, 's9')).toBe('too_long');
    expect(whyNoMoment({ stops }, 'nope')).toBe('no_stop');
    expect(whyNoMoment({ stops }, undefined)).toBe('no_stop');
  });

  it('is anchored as a v1 passage that carries a hash and no words, and only that exact anchor is the moment', () => {
    const moment = momentOf({ stops }, 's2')!;
    const anchor = momentAnchorOf(moment);
    expect(anchor).toMatchObject({ kind: 'scroll_passage', blockId: 's2', start: 0, end: moment.quote.length });
    expect(anchor.quoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(anchor)).not.toContain('Distance');
    expect(anchorIsMoment(moment, anchor)).toBe(true);
    expect(anchorIsMoment(moment, { ...anchor, end: anchor.end - 1 })).toBe(false);
    expect(anchorIsMoment(moment, { ...anchor, start: 1 })).toBe(false);
    expect(anchorIsMoment(moment, { ...anchor, quoteHash: 'a'.repeat(64) })).toBe(false);
  });
});
