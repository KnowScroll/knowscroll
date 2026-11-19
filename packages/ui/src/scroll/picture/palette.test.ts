import { scrollPagePalettes } from '@knowscroll/design-tokens';
import { RECEDED_TEXT } from './layout/common';
import { COOL, WARM } from './palette';

/** WCAG relative luminance and contrast ratio of two #RRGGBB colours. */
function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** `foreground` drawn at `opacity` over `background`, as an opaque colour. */
function over(foreground: string, background: string, opacity: number): string {
  const channels = [1, 3, 5].map((start) => {
    const front = parseInt(foreground.slice(start, start + 2), 16);
    const back = parseInt(background.slice(start, start + 2), 16);
    return Math.round(front * opacity + back * (1 - opacity));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe.each(Object.entries(scrollPagePalettes))('the picture colours on the %s plate', (_name, page) => {
  it.each([
    ['ink', page.ink],
    ['ink2', page.ink2],
  ])('keep %s text at 4.5:1 when drawn receded', (_role, colour) => {
    expect(contrast(over(colour, page.plate, RECEDED_TEXT), page.plate)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['warm', WARM],
    ['cool', COOL],
  ])('reach 3:1 for the meaning colour %s', (_role, colour) => {
    expect(contrast(colour, page.plate)).toBeGreaterThanOrEqual(3);
  });

  it('reach 3:1 for the ink2 of a grid cell border', () => {
    expect(contrast(page.ink2, page.plate)).toBeGreaterThanOrEqual(3);
  });
});
