import { canPinHolds, figureHeightFor, holdsBeside, readingBandOf } from './essay-layout';

describe('the essay layout (folio README 5.3)', () => {
  it('sizes a figure to a share of the screen, within readable bounds, and never most of a short screen', () => {
    expect(figureHeightFor(700, false)).toBe(238);
    expect(figureHeightFor(1200, false)).toBe(300);
    expect(figureHeightFor(500, false)).toBe(190);
    expect(figureHeightFor(220, false)).toBe(165);
    expect(figureHeightFor(800, true)).toBe(352);
  });

  it('pins a hold only where the figure leaves room to read', () => {
    expect(canPinHolds(680, figureHeightFor(680, false), false, 1)).toBe(true);
    expect(canPinHolds(230, figureHeightFor(230, false), false, 1)).toBe(false);
    expect(canPinHolds(680, figureHeightFor(680, false), false, 2)).toBe(false);
    expect(canPinHolds(760, figureHeightFor(760, true), true, 1)).toBe(true);
  });

  it('measures reading in a band that starts below where a figure pins', () => {
    const band = readingBandOf(700);
    expect(band.top).toBeGreaterThan(figureHeightFor(700, false));
    expect(700 - band.top - band.bottom).toBeGreaterThan(250);
  });

  it('sets a held figure beside its beats only where the reader is wide enough for both', () => {
    expect(holdsBeside(1440)).toBe(true);
    expect(holdsBeside(720)).toBe(false);
    expect(holdsBeside(0)).toBe(false);
  });
});
