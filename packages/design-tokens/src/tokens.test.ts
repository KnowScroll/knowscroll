import { describe, expect, it } from 'vitest';
import {
  breakpointFor,
  content,
  defaultTalkTheme,
  family,
  focusRing,
  iconStroke,
  motion,
  motionDuration,
  overlay,
  radius,
  resolveType,
  space,
  spacing,
  status,
  talkThemes,
  target,
  toggle,
  typeScale,
  universe,
  type TypeRole,
} from './index';

/** WCAG 2.x relative luminance of an sRGB colour given as #RRGGBB or rgba(r,g,b,a) over a ground. */
function rgb(colour: string, ground?: readonly [number, number, number]): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex?.[1] !== undefined) {
    const value = hex[1];
    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
  }
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(colour);
  if (rgba === null || ground === undefined) throw new Error(`cannot read ${colour}`);
  const alpha = Number(rgba[4]);
  return [1, 2, 3].map((index, channel) => Number(rgba[index]) * alpha + ground[channel]! * (1 - alpha)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(foreground: string, background: string): number {
  const ground = rgb(background);
  const a = luminance(rgb(foreground, ground));
  const b = luminance(ground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('colour pairs', () => {
  // Text needs 4.5:1 (WCAG 1.4.3); component edges and focus rings need 3:1 (1.4.11).
  const text: [string, string, string][] = [
    ['ink on paper', content.ink, content.paper],
    ['ink-2 on paper', content.ink2, content.paper],
    ['ink-2 on paper-2', content.ink2, content.paper2],
    ['cream on accent', content.onAccent, content.accent],
    ['accent-deep on paper', content.accentDeep, content.paper],
    ['ink on continue', content.onContinue, content.continue],
    ['ink on fresh', content.ink, content.fresh],
    ['fresh-ink on paper', content.freshInk, content.paper],
    ['hypothetical text on its ground', status.hypothetical.foreground, status.hypothetical.background],
    ['corrected text on its ground', status.corrected.foreground, status.corrected.background],
    ['danger text on paper', status.danger.foreground, content.paper],
    ['cream on danger fill', content.paper, status.danger.fill],
    ['ink on highlight', content.ink, content.highlight],
    ['cream on space ground', space.label, space.s0],
    ['secondary space label on space ground', space.label2, space.s0],
    ['secondary space label on raised space', space.label2, space.s1],
    ['ink on a cream space control', space.onControl, space.control],
    ['inactive nav label on ink', overlay.onDarkMuted, content.nav],
    ['inactive nav label on the space pill', overlay.onDarkMuted, space.s1],
  ];
  it.each(text)('%s meets 4.5:1', (_name, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  const edges: [string, string, string][] = [
    ['muted edge on paper', content.muted, content.paper],
    ['hypothetical dashed edge on its ground', status.hypothetical.edge, status.hypothetical.background],
    ['focus ring on paper', focusRing.onLight.color, content.paper],
    ['focus ring on paper-2', focusRing.onLight.color, content.paper2],
    ['dark focus ring on ink', focusRing.onDark.color, content.ink],
    ['dark focus ring on space', focusRing.onDark.color, space.s0],
    ['dark focus ring on cobalt media', focusRing.onDark.color, content.accent],
  ];
  it.each(edges)('%s meets 3:1', (_name, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
  });

  it('draws pressed toggles without yellow, which means continuation only (D-006 b, amended)', () => {
    for (const treatment of Object.values(toggle)) {
      expect(treatment.background).not.toBe(content.continue);
      expect(contrast(treatment.foreground, treatment.background)).toBeGreaterThanOrEqual(4.5);
    }
    // The cream fill stands out from the dark ground and from cobalt media.
    expect(contrast(toggle.pressedOnDark.background, space.s0)).toBeGreaterThanOrEqual(3);
    expect(contrast(toggle.pressedOnDark.background, content.accent)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the cobalt focus ring off cobalt surfaces, where it would vanish', () => {
    expect(contrast(focusRing.onLight.color, content.accent)).toBeLessThan(3);
  });

  it('gives every topic family two cues: a hue and a distinct pattern motif', () => {
    const motifs = Object.values(family).map((entry) => entry.motif);
    expect(new Set(motifs).size).toBe(motifs.length);
    for (const entry of Object.values(family)) expect(entry.pattern).not.toBe(entry.base);
  });
});

describe('spacing and targets', () => {
  it('stays on the 4 px base, with half steps of 2 px only', () => {
    for (const value of Object.values(spacing)) expect(value % 2).toBe(0);
  });

  it('never lets a touch target fall below 44', () => {
    expect(target.minimum).toBe(44);
    expect(target.comfortable).toBeGreaterThanOrEqual(target.minimum);
  });
});

describe('breakpoints (V01)', () => {
  it.each([
    [320, 'compact'],
    [360, 'compact'],
    [361, 'phone'],
    [390, 'phone'],
    [599, 'phone'],
    [600, 'tablet'],
    [834, 'tablet'],
    [1023, 'tablet'],
    [1024, 'desktop'],
    [1440, 'desktop'],
  ] as const)('%i px is %s', (width, expected) => {
    expect(breakpointFor(width)).toBe(expected);
  });
});

describe('type scaling', () => {
  it('uses the phone sizes at 100 %', () => {
    expect(resolveType('body', { desktop: false, textScale: 1 })).toMatchObject({
      fontFamily: 'InstrumentSans',
      fontWeight: '400',
      fontSize: 18,
      lineHeight: 28,
    });
  });

  it('adds 15 % on desktop to the authored roles and to buttons, which grow with body text', () => {
    expect(resolveType('displayXl', { desktop: true, textScale: 1 }).fontSize).toBe(50.5);
    expect(resolveType('body', { desktop: true, textScale: 1 }).fontSize).toBe(20.5);
    expect(resolveType('ui', { desktop: true, textScale: 1 }).fontSize).toBe(17.5);
    expect(resolveType('uiS', { desktop: true, textScale: 1 }).fontSize).toBe(16);
  });

  it('keeps nav, rail and map labels at their drawn size on desktop', () => {
    expect(resolveType('uiLabel', { desktop: true, textScale: 1 }).fontSize).toBe(11);
    expect(resolveType('spaceLabel', { desktop: true, textScale: 1 }).fontSize).toBe(13);
  });

  it('scales body to 26/38 at 200 % and no further', () => {
    expect(resolveType('body', { desktop: false, textScale: 2 })).toMatchObject({ fontSize: 26, lineHeight: 38 });
    expect(resolveType('body', { desktop: false, textScale: 3.1 })).toMatchObject({ fontSize: 26, lineHeight: 38 });
  });

  it('grows monotonically between 100 % and 200 % for every role', () => {
    for (const role of Object.keys(typeScale) as TypeRole[]) {
      let previous = 0;
      for (const scale of [1, 1.15, 1.3, 1.5, 1.75, 2]) {
        const { fontSize, lineHeight } = resolveType(role, { desktop: false, textScale: scale });
        expect(fontSize).toBeGreaterThanOrEqual(previous);
        expect(lineHeight).toBeGreaterThanOrEqual(fontSize);
        previous = fontSize;
      }
    }
  });

  it('turns caps labels into Instrument 600 sentence case above 150 %', () => {
    expect(resolveType('label', { desktop: false, textScale: 1.5 })).toMatchObject({
      fontFamily: 'DMMono',
      textTransform: 'uppercase',
    });
    expect(resolveType('label', { desktop: false, textScale: 1.6 })).toMatchObject({
      fontFamily: 'InstrumentSans',
      fontWeight: '600',
      textTransform: 'none',
      letterSpacing: 0,
    });
  });

  it('converts em tracking to px', () => {
    expect(resolveType('displayXl', { desktop: false, textScale: 1 }).letterSpacing).toBe(-0.88);
  });
});

describe('motion', () => {
  it('has a reduced variant for every token that is never longer than the default', () => {
    for (const name of Object.keys(motion) as (keyof typeof motion)[]) {
      expect(motionDuration(name, true)).toBeLessThanOrEqual(motionDuration(name, false));
    }
  });

  it('fades sheets in 140 ms under reduced motion', () => {
    expect(motionDuration('sheet', true)).toBe(140);
    expect(motionDuration('sheet', false)).toBe(240);
  });
});

describe('shape', () => {
  it('names the radii by the roles Tokens.html authors: 6 tag · 14 card · 20 panel · 28 sheet · pill', () => {
    expect(radius).toMatchObject({ tag: 6, card: 14, panel: 20, sheet: 28, pill: 999 });
  });
});

describe('icons', () => {
  it('uses the export stroke widths by size', () => {
    expect(iconStroke(22)).toBe(2);
    expect(iconStroke(18)).toBe(2.4);
    expect(iconStroke(12)).toBe(2.6);
  });
});

describe('Talk themes (T3 kit, D-145)', () => {
  /** An rgba() colour composited over a #RRGGBB ground, as the #RRGGBB the eye sees. */
  function over(colour: string, ground: string): string {
    if (colour === 'transparent') return ground;
    if (colour.startsWith('#')) return colour;
    const [r, g, b] = rgb(colour, rgb(ground));
    const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  describe.each(Object.values(talkThemes))('the $name theme', (theme) => {
    const quoteGround = (strip: { fill: string }, bubble: string) => over(strip.fill, bubble);
    const pairs: [string, string, string][] = [
      ['text on the ground', theme.text, theme.ground],
      ['the time under a run on the ground', theme.textQuiet, theme.ground],
      ['text in another person’s bubble', theme.bubbleOther.text, theme.bubbleOther.fill],
      ['text in your own bubble', theme.bubbleOwn.text, theme.bubbleOwn.fill],
      [
        'a quote in another person’s bubble',
        theme.quoteOnOther.text,
        quoteGround(theme.quoteOnOther, theme.bubbleOther.fill),
      ],
      ['a quote in your own bubble', theme.quoteOnOwn.text, quoteGround(theme.quoteOnOwn, theme.bubbleOwn.fill)],
      ['a date capsule', theme.capsule.text, over(theme.capsule.fill, theme.ground)],
      ['the header and message bar', theme.bar.text, over(theme.bar.fill, theme.ground)],
      ['text in the field', theme.input.text, over(theme.input.fill, theme.ground)],
      ['the placeholder in the field', theme.input.placeholder, over(theme.input.fill, theme.ground)],
      ['the glyph on Send', theme.send.glyph, theme.send.fill],
      ['a reaction pill', theme.pill.text, theme.pill.fill],
      ['the menu', theme.menu.text, theme.menu.fill],
      ['Report in the menu', theme.menu.danger, theme.menu.fill],
    ];
    it.each(pairs)('%s meets 4.5:1', (_name, foreground, background) => {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps the focus ring and the flash visible against the ground and the bubbles', () => {
      expect(contrast(theme.focus, theme.ground)).toBeGreaterThanOrEqual(3);
      // The flash lands on the jumped-to bubble: it must stand out from the bubble, and its text stays readable.
      expect(contrast(theme.flash, theme.bubbleOther.fill)).toBeGreaterThanOrEqual(1.1);
      expect(contrast(theme.bubbleOther.text, theme.flash)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.bubbleOwn.fill, theme.ground)).toBeGreaterThanOrEqual(1.1);
    });

    it('draws your bubble cobalt and never yellow, which means focus (T3 Q2)', () => {
      expect(theme.bubbleOwn.fill).toBe(universe.cobalt);
      expect(theme.bubbleOwn.fill).not.toBe(universe.focus);
    });
  });

  it('defines the same roles in both themes, so a screen never asks which one it is in', () => {
    const roles = (value: Record<string, unknown>): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' && inner !== null
          ? roles(inner as Record<string, unknown>).map((role) => `${key}.${role}`)
          : [key],
      );
    expect(roles(talkThemes.paper)).toEqual(roles(talkThemes.sky));
  });

  it('starts dark on the Universe’s own sky (T3 Q1) and shares its Paper and Ink', () => {
    expect(defaultTalkTheme).toBe('sky');
    expect(talkThemes[defaultTalkTheme].ground).toBe(universe.sky);
    expect(talkThemes.sky.bubbleOther.fill).toBe(universe.paper);
    expect(talkThemes.sky.bubbleOther.text).toBe(universe.ink);
  });
});
