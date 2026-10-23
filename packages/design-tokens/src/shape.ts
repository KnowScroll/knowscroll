/**
 * Radii, borders, offset shadows, opacity and icon geometry. Shadows are CSS `box-shadow`
 * strings, which React Native (`boxShadow`, new architecture) and React Native Web both accept.
 */

/**
 * Radii. Tokens.html authors `6 tag · 14 card · 20 panel · 28 sheet (top only) · pill control`;
 * the frames also draw 4, 8, 12, 16, 18, 24 and 26, named here. 9 (dots), 10 (outline rows) and
 * 22 map to the nearest named step (README.md). Components.html draws `.tag` as a pill, so the
 * Tag component uses `pill`; `tag` (6) is kept for the small badges and key hints that use it.
 */
export const radius = {
  xs: 4,
  /** Authored "tag": badges, key hints. */
  tag: 6,
  thumb: 8,
  md: 12,
  /** Authored "card": banners, cards, list rows that sit on paper. */
  card: 14,
  lg: 16,
  edgeTab: 18,
  /** Authored "panel". */
  panel: 20,
  navItem: 20,
  navPillCompact: 24,
  navPill: 26,
  /** Authored "sheet": top corners only. */
  sheet: 28,
  /** Authored "control" (buttons, chips, tags): fully rounded. */
  pill: 999,
} as const;

export const borderWidth = {
  /** Dividers (`content.rule`) and space panel edges. */
  hairline: 1,
  /** Tags, notes, light cards, `kbd`. */
  light: 1.5,
  /** Default outline for buttons, cards, inputs, sheets and the segment control. */
  regular: 2,
  /** The current episode card. */
  current: 3,
} as const;

/**
 * Edge style encodes relationship and status: solid yellow = Part; dashed cream = Related;
 * dashed cobalt = What-if / Hypothetical; dotted ink = AI; dashed muted = Preparing.
 */
export const borderStyle = {
  part: 'solid',
  related: 'dashed',
  whatIf: 'dashed',
  ai: 'dotted',
  preparing: 'dashed',
} as const;

/** Offset shadows ("press 3px ink · hero 6px cobalt · space panel hairline + soft drop"). */
export const elevation = {
  /** Default, primary and small buttons; removed when pressed or disabled. */
  press: '3px 3px 0px 0px #111111',
  /** Hero card, Scroll diagram block, topic card. */
  hero: '6px 6px 0px 0px #2C46E8',
  /** Large media surfaces in ink (D01 player). */
  heroInk: '6px 6px 0px 0px #111111',
  /** "Another perspective" card. */
  raised: '4px 4px 0px 0px #111111',
  /** First-arrival hint card (A03). */
  hint: '4px 4px 0px 0px #FFE44D',
  /** Now-playing episode card. */
  current: '3px 3px 0px 0px #2C46E8',
  /** Space panels: hairline plus soft drop. */
  spacePanel: '0px 0px 0px 1px rgba(255,251,240,0.22), 0px 16px 32px -12px #000000',
  /** Floating nav pill on paper. */
  navPaper: '0px 10px 24px -12px rgba(17,17,17,0.55)',
  /** Floating nav pill on space. */
  navSpace: '0px 0px 0px 1px rgba(255,251,240,0.22), 0px 12px 28px -10px #000000',
} as const;

/** The pressed offset: buttons travel by the shadow they lose. */
export const pressOffset = 3;

export const opacity = {
  disabled: 0.45,
  sending: 0.6,
  unavailable: 0.8,
  grabHandle: 0.25,
} as const;

/** Icons: custom 24 × 24 line icons, round caps and joins, `currentColor`. */
export const icon = {
  viewBox: 24,
  size: {
    /** Nav items, 48 icon buttons, action rail. */
    regular: 22,
    /** Banners, thread strip, share options. */
    strip: 20,
    /** Chips and buttons. */
    chip: 18,
    small: 16,
    /** Segment control and compact chips. */
    segment: 14,
    /** Inside tags. */
    tag: 12,
  },
  /** Stroke widths by rendered size. */
  stroke: { regular: 2, small: 2.4, tiny: 2.6, check: 3 },
} as const;

/** Stroke width the export uses for an icon drawn at `size` px. */
export function iconStroke(size: number): number {
  if (size >= 20) return icon.stroke.regular;
  if (size >= 14) return icon.stroke.small;
  return icon.stroke.tiny;
}
