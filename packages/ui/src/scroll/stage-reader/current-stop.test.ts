import { currentSection, END_SLACK, READING_LINE, scrolledToEnd, settleTarget, SNAP_PROXIMITY } from './current-stop';

const tops = [0, 300, 600, 900];
const view = { viewportHeight: 400, contentHeight: 1100 };

describe('which section the reader is on', () => {
  it('is the last section whose top has passed the reading line', () => {
    expect(currentSection({ tops, scrollTop: 0, ...view })).toBe(0);
    const line = view.viewportHeight * READING_LINE;
    expect(currentSection({ tops, scrollTop: 300 - line, ...view })).toBe(1);
    expect(currentSection({ tops, scrollTop: 300 - line - 1, ...view })).toBe(0);
  });

  it('is the last section at the very end of the text, even when it is short', () => {
    expect(currentSection({ tops, scrollTop: 700, ...view })).toBe(3);
  });

  it('is the first section when nothing is measured, and does not jump to the end when the text fits the screen', () => {
    expect(currentSection({ tops: [], scrollTop: 50, ...view })).toBe(0);
    // Everything above the reading line (800) counts as passed, but the end rule needs a text longer than the screen.
    expect(currentSection({ tops, scrollTop: 0, viewportHeight: 2000, contentHeight: 1100 })).toBe(2);
  });
});

describe('settling softly on a stop', () => {
  it('moves the last few pixels onto the nearest stop top, and nowhere when none is near', () => {
    expect(settleTarget({ tops, scrollTop: 320, atEnd: false })).toBe(300);
    expect(settleTarget({ tops, scrollTop: 280, atEnd: false })).toBe(300);
    expect(settleTarget({ tops, scrollTop: 300 + SNAP_PROXIMITY + 1, atEnd: false })).toBeUndefined();
    expect(settleTarget({ tops, scrollTop: 300, atEnd: false })).toBeUndefined();
  });

  it('never pulls the reader back from the very end of the text', () => {
    expect(settleTarget({ tops, scrollTop: 920, atEnd: true })).toBeUndefined();
  });
});

describe('whether the text is scrolled to its end', () => {
  const text = { viewport: 400, content: 1100 };

  it('is true at the end and within the slack of it', () => {
    expect(scrolledToEnd({ ...text, scrollTop: 700 })).toBe(true);
    expect(scrolledToEnd({ ...text, scrollTop: 700 - END_SLACK })).toBe(true);
  });

  it('is false anywhere else, and for text that fits', () => {
    expect(scrolledToEnd({ ...text, scrollTop: 700 - END_SLACK - 1 })).toBe(false);
    expect(scrolledToEnd({ viewport: 400, content: 400, scrollTop: 0 })).toBe(false);
  });
});
