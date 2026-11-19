import { describe, expect, it } from 'vitest';
import { anchorIsMoment, momentAnchorOf } from '../v2/moment.js';
import { beatsOfV3 } from './document.js';
import { momentOfBeat } from './moment.js';
import { validDocumentV3 } from '../test-support/v3-fixtures.js';

describe('a moment of a document v3 Scroll', () => {
  const document = validDocumentV3();
  const [first, second] = beatsOfV3(document);

  it('is the text of one beat, under the beat’s id', () => {
    expect(first).toBeDefined();
    expect(momentOfBeat(document, first!.id)).toEqual({ stopId: first!.id, quote: first!.text });
    expect(momentOfBeat(document, second!.id)?.quote).toBe(second!.text);
  });

  it('is nothing for a beat the document does not have', () => {
    expect(momentOfBeat(document, 'no-such-beat')).toBeUndefined();
    expect(momentOfBeat(document, '')).toBeUndefined();
  });

  it('is shared with the same anchor a v2 moment has: the whole text, and the hash of what the sender saw', () => {
    const moment = momentOfBeat(document, first!.id)!;
    const anchor = momentAnchorOf(moment);
    expect(anchor).toMatchObject({ kind: 'scroll_passage', blockId: first!.id, start: 0, end: first!.text.length });
    expect(anchorIsMoment(moment, anchor)).toBe(true);
    expect(anchorIsMoment(moment, { ...anchor, end: anchor.end - 1 })).toBe(false);
    expect(anchorIsMoment(moment, { ...anchor, quoteHash: 'a'.repeat(64) })).toBe(false);
  });
});
