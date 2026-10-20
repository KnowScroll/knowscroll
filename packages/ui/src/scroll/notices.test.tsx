import { correctionDate } from './templates/notices';
import { itemOffsets } from './blocks/text-blocks';
import { dropCapOf } from './drop-cap';
import { spanOffsets } from './rich-text';
import { passageAttributes } from './data-attributes';

describe('correction dates', () => {
  it('read as day and month in English, the same everywhere', () => {
    expect(correctionDate('2026-10-14')).toBe('14 Oct');
    expect(correctionDate('2026-01-05')).toBe('5 Jan');
    expect(correctionDate('2027-12-31')).toBe('31 Dec');
  });
});

describe('passage offsets (text-projection.v1)', () => {
  it('start each span where the previous one ended', () => {
    expect(spanOffsets([{ text: 'Every ' }, { text: 'word' }, { text: ' counts' }])).toEqual([0, 6, 10]);
  });

  it('start each list item after the previous one and its newline', () => {
    expect(itemOffsets([[{ text: 'one' }], [{ text: 'tw' }, { text: 'o' }], [{ text: 'three' }]])).toEqual([0, 4, 8]);
  });

  it('carry no data attributes on native (there is no DOM to select in)', () => {
    expect(passageAttributes('p-1', 12)).toEqual({});
  });
});

describe('the initial cap (native)', () => {
  it('splits the first letter into its own run and leaves the text unchanged', () => {
    const cap = dropCapOf([{ text: 'For a century', marks: ['em'] }, { text: ' on' }], true);

    expect(cap.spans.map((span) => span.text).join('')).toBe('For a century on');
    expect(cap.spans[0]).toEqual({ text: 'F', marks: ['em'], cap: true });
    expect(cap.spans[1]).toEqual({ text: 'or a century', marks: ['em'] });
    expect(cap.textProps).toEqual({});
  });

  it('keeps a whole letter together (a surrogate pair is one letter)', () => {
    const cap = dropCapOf([{ text: '𝔄 long time' }], true);
    expect(cap.spans[0]?.text).toBe('𝔄');
  });

  it('does nothing when it is not asked for', () => {
    const spans = [{ text: 'For a century' }];
    expect(dropCapOf(spans, false).spans).toBe(spans);
  });
});
