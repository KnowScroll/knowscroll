/**
 * Web: the drop cap is drawn by one `::first-letter` rule, and the paragraph's text is left
 * whole (jest-expo/web, jsdom). Native's initial cap is in `notices.test.tsx`.
 */
import { passageAttributes, blockAttributes } from './data-attributes';
import { dropCapOf } from './drop-cap';

describe('the drop cap (web)', () => {
  it('marks the paragraph for the stylesheet and leaves its spans alone', () => {
    const spans = [{ text: 'For a century', marks: ['em' as const] }, { text: ' on' }];

    const cap = dropCapOf(spans, true);

    expect(cap.spans).toBe(spans);
    expect(cap.textProps).toEqual({ dataSet: { ksDropCap: 'true' } });
  });

  it('installs one stylesheet, once, whatever the number of essays', () => {
    dropCapOf([{ text: 'One' }], true);
    dropCapOf([{ text: 'Two' }], true);

    const sheets = document.querySelectorAll('#ks-drop-cap');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.textContent).toContain('[data-ks-drop-cap]::first-letter');
    expect(sheets[0]?.textContent).toContain('float:left');
  });

  it('does nothing when it is not asked for', () => {
    const spans = [{ text: 'For a century' }];
    expect(dropCapOf(spans, false)).toEqual({ spans, textProps: {} });
  });
});

describe('passage data attributes (web)', () => {
  it('name the block and the offset a run of text starts at, so a selection maps back to a passage', () => {
    expect(passageAttributes('p-open-1', 12)).toEqual({ dataSet: { ksBlock: 'p-open-1', ksOffset: '12' } });
    expect(blockAttributes('p-open-1')).toEqual({ dataSet: { ksBlock: 'p-open-1' } });
  });
});
