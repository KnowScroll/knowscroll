/**
 * Typography: the three bundled families and the type scale. Sizes are phone sizes in logical
 * px; desktop (≥ 1024) multiplies the six authored roles by 1.15 (Tokens.html). Tracking is in
 * em and converted to px for React Native by `letterSpacing()`.
 */

/** Family names as registered with expo-font (and the CSS family on web). */
export const fontFamily = {
  /** Bricolage Grotesque: display and headings. Variable: wght 200–800, default 800. */
  display: 'BricolageGrotesque',
  /** Instrument Sans: body and UI. Variable: wght 400–700, default 400. */
  text: 'InstrumentSans',
  /** DM Mono 500: small caps labels. Static. */
  mono: 'DMMono',
} as const;

export type FontRole = keyof typeof fontFamily;

/** CSS fallbacks for the web, in the order the export declares them. */
export const fontFallback = {
  display: ['Instrument Sans', 'system-ui', 'sans-serif'],
  text: ['system-ui', 'sans-serif'],
  mono: ['ui-monospace', 'Menlo', 'monospace'],
} as const satisfies Record<FontRole, readonly string[]>;

/** Weight range each bundled file covers (web `@font-face` ranges; Android keeps the axis). */
export const fontWeightRange = {
  display: '200 800',
  text: '400 700',
  mono: '500',
} as const satisfies Record<FontRole, string>;

export type FontWeight = 400 | 500 | 600 | 700 | 800;

export interface TypeStyle {
  readonly font: FontRole;
  readonly weight: FontWeight;
  /** Size in logical px at 100 % text size on a phone. */
  readonly size: number;
  /** Line height in logical px. */
  readonly line: number;
  /** Letter spacing in em. */
  readonly tracking: number;
  /** Uppercase rendering (labels). The text itself stays in sentence case. */
  readonly caps: boolean;
  /**
   * Scaled by the desktop factor at ≥ 1024 px: the authored roles and the control and copy roles
   * that sit beside them (buttons grow with body text). Nav, rail and map labels keep their
   * drawn phone sizes (D01–D05 draw them at 11).
   */
  readonly desktopScaled: boolean;
  /** Size and line height at 200 % text size (Tokens.html, V01). */
  readonly at200: { readonly size: number; readonly line: number };
}

function role(
  font: FontRole,
  weight: FontWeight,
  size: number,
  line: number,
  options: { at200: { size: number; line: number }; tracking?: number; caps?: boolean; desktopScaled?: boolean },
): TypeStyle {
  return {
    font,
    weight,
    size,
    line,
    tracking: options.tracking ?? 0,
    caps: options.caps ?? false,
    desktopScaled: options.desktopScaled ?? false,
    at200: options.at200,
  };
}

/**
 * The type scale. Authored roles (Tokens.html): displayXl, displayL, title, body, bodyS, label.
 * The rest name sizes the frames draw without a token (D-006 p); README.md lists every source.
 */
export const typeScale = {
  // Authored.
  displayXl: role('display', 800, 44, 46, { tracking: -0.02, desktopScaled: true, at200: { size: 44, line: 48 } }),
  displayL: role('display', 800, 32, 36, { tracking: -0.02, desktopScaled: true, at200: { size: 36, line: 40 } }),
  title: role('display', 700, 22, 28, { tracking: -0.02, desktopScaled: true, at200: { size: 28, line: 34 } }),
  body: role('text', 400, 18, 28, { desktopScaled: true, at200: { size: 26, line: 38 } }),
  bodyS: role('text', 500, 15, 22, { desktopScaled: true, at200: { size: 21, line: 30 } }),
  label: role('mono', 500, 11, 14, { tracking: 0.06, caps: true, desktopScaled: true, at200: { size: 18, line: 24 } }),
  // Named from the frames.
  /** Tab-root page title ("Keep", "Talk"): Bricolage 800 36. */
  page: role('display', 800, 36, 40, { tracking: -0.02, desktopScaled: true, at200: { size: 40, line: 44 } }),
  /** Panel and card heading ("Your universe" header, settings cards): Bricolage 800 26. */
  heading: role('display', 800, 26, 30, { tracking: -0.01, desktopScaled: true, at200: { size: 32, line: 36 } }),
  /** Medium controls (`.btn`). */
  ui: role('text', 600, 15, 20, { desktopScaled: true, at200: { size: 20, line: 26 } }),
  /** Small controls (`.btn.sm`, segment, chip). */
  uiS: role('text', 600, 14, 18, { desktopScaled: true, at200: { size: 18, line: 24 } }),
  /** Icon-plus-word controls (nav items, action rail). */
  uiLabel: role('text', 600, 11, 13, { tracking: 0.01, at200: { size: 15, line: 18 } }),
  /** Secondary lines in cards, rows, notes and banners' helpers. */
  meta: role('text', 400, 13, 18, { desktopScaled: true, at200: { size: 18, line: 25 } }),
  /** Sender names, presence, emphasised meta. */
  metaS: role('text', 600, 12, 16, { desktopScaled: true, at200: { size: 17, line: 22 } }),
  /** Banner copy (`.banner`): Instrument 14/1.4. */
  notice: role('text', 400, 14, 20, { desktopScaled: true, at200: { size: 19, line: 27 } }),
  /** The words in a Talk bubble (T3 kit: Instrument Sans 500 16/22). */
  bubble: role('text', 500, 16, 22, { desktopScaled: true, at200: { size: 22, line: 30 } }),
  /** Reel captions over media. */
  captionMedia: role('text', 500, 16, 22, { at200: { size: 22, line: 30 } }),
  /** Edge-tab and episode part labels. */
  monoXs: role('mono', 500, 10, 12, { tracking: 0.06, caps: true, at200: { size: 15, line: 18 } }),
  /** Labels on the map. */
  spaceLabel: role('text', 600, 13, 16, { at200: { size: 18, line: 22 } }),
} as const satisfies Record<string, TypeStyle>;

export type TypeRole = keyof typeof typeScale;

/** Desktop factor and the larger-text rules (Tokens.html, V01). */
export const typeScaling = {
  desktopFactor: 1.15,
  /** Text size beyond which caps labels become Instrument 600 in sentence case. */
  labelsSentenceCaseAbove: 1.5,
  /** The largest system text scale the scale interpolates to; larger scales clamp here. */
  maxTextScale: 2,
} as const;

export interface ResolvedTypeStyle {
  readonly fontFamily: string;
  readonly fontWeight: `${FontWeight}`;
  readonly fontSize: number;
  readonly lineHeight: number;
  /** Letter spacing in px. */
  readonly letterSpacing: number;
  readonly textTransform: 'none' | 'uppercase';
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

/** Letter spacing in px for a size and an em tracking. */
export function letterSpacing(size: number, trackingEm: number): number {
  return Math.round(size * trackingEm * 100) / 100;
}

/**
 * Resolves a type role for a layout and a system text scale (1 = 100 %). Sizes interpolate
 * linearly from the 100 % value to the drawn 200 % value and clamp at 200 %. Above 150 %, caps
 * labels switch to Instrument 600 in sentence case so caps never become a wall.
 */
export function resolveType(name: TypeRole, options: { desktop: boolean; textScale: number }): ResolvedTypeStyle {
  const style: TypeStyle = typeScale[name];
  const scale = Math.min(Math.max(options.textScale, 1), typeScaling.maxTextScale);
  const progress = scale - 1;
  const desktop = options.desktop && style.desktopScaled ? typeScaling.desktopFactor : 1;
  const size = roundHalf((style.size + (style.at200.size - style.size) * progress) * desktop);
  const line = Math.round((style.line + (style.at200.line - style.line) * progress) * desktop);
  const sentenceCase = style.caps && scale > typeScaling.labelsSentenceCaseAbove;
  const font: FontRole = sentenceCase ? 'text' : style.font;
  const weight: FontWeight = sentenceCase ? 600 : style.weight;
  return {
    fontFamily: fontFamily[font],
    fontWeight: `${weight}`,
    fontSize: size,
    lineHeight: Math.max(line, Math.ceil(size)),
    letterSpacing: sentenceCase ? 0 : letterSpacing(size, style.tracking),
    textTransform: style.caps && !sentenceCase ? 'uppercase' : 'none',
  };
}
