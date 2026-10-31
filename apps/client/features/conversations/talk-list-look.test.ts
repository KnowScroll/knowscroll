import { content, focusRing, space, universe } from '@knowscroll/design-tokens';
import { talkListLook } from './talk-list-look';

function luminance(hex: string): number {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('the Talk list look', () => {
  it('rings focus in yellow on the sky and cobalt on paper, and each ring is 3:1 on its own ground (1.4.11)', () => {
    const sky = talkListLook('sky');
    const paper = talkListLook('paper');
    expect(sky.focusTone).toBe('onDark');
    expect(paper.focusTone).toBe('onLight');
    for (const ground of [space.s0, universe.sky])
      expect(contrast(focusRing[sky.focusTone].color, ground)).toBeGreaterThanOrEqual(3);
    expect(contrast(focusRing[paper.focusTone].color, content.paper)).toBeGreaterThanOrEqual(3);
    // The paper ring on the sky is what this replaces: it falls under 3:1.
    expect(contrast(focusRing.onLight.color, space.s0)).toBeLessThan(3);
  });

  it('draws text in cream on the sky and ink on paper', () => {
    expect(talkListLook('sky').text).toBe(space.label);
    expect(talkListLook('paper').text).toBe(content.ink);
  });
});
