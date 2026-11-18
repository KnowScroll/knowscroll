import {
  appearanceAttribute,
  appearancePalettes,
  appearanceVariable,
  type Appearance,
  type AppearancePalette,
  type AppearanceRole,
} from './appearance';

/**
 * A Scroll's page as a reading surface with a palette of its own in each appearance (D-424, amending D-400). Every role
 * of the appearance palette is redefined inside the page, so what is drawn there (play blocks, side notes, buttons)
 * follows the page, and the page adds three roles for its figures.
 */
export interface ScrollPagePalette extends AppearancePalette {
  /** The plate a figure is drawn on. */
  readonly plate: string;
  /** A body a figure draws dark in both appearances: a planet, a black hole, the night side. */
  readonly solid: string;
  /** What a figure draws light in both appearances: the lit side of the Moon or of Earth. */
  readonly lit: string;
}

/** The roles only a Scroll's page has. */
export type ScrollPageRole = Exclude<keyof ScrollPagePalette, keyof AppearancePalette>;

/**
 * Light is today's printed page exactly. Dark is designed for long reading, not inverted: a warm near-black ground (not
 * black) and cream ink (not white) at about 14:1, secondary text and rules a step down, cobalt lifted for links, the
 * yellow focus ring of the dark appearance, and figures on a raised plate.
 */
export const scrollPagePalettes = {
  light: { ...appearancePalettes.light, plate: '#F4EDD8', solid: '#111111', lit: '#FFFBF0' },
  dark: {
    paper: '#17150F',
    paper2: '#26221A',
    ink: '#EAE3D0',
    ink2: '#B3AB98',
    accentDeep: '#9FB0FF',
    freshInk: '#3DDBB0',
    freshTint: '#0E2A22',
    rule: '#3A352B',
    muted: '#8F8775',
    nav: '#26221A',
    highlight: '#3B3514',
    dangerText: '#FF9070',
    preparingA: '#1D1A14',
    preparingB: '#26221A',
    focus: '#FFE44D',
    hypotheticalGround: '#1A1E36',
    hypotheticalText: '#B4C0FF',
    hypotheticalEdge: '#7D8FFF',
    correctedGround: '#33170C',
    correctedText: '#FFB08F',
    plate: '#221F18',
    solid: '#0A0907',
    lit: '#EDE6D2',
  },
} as const satisfies Record<Appearance, ScrollPagePalette>;

/** The CSS custom property that carries a page role on the web, e.g. `--ks-page-plate`. */
export function scrollPageVariable(role: ScrollPageRole): string {
  return `--ks-page-${role}`;
}

/** The attribute a Scroll's page carries on the web, so its palette applies to it and to everything inside it. */
export const scrollPageAttribute = 'data-ks-page';

const appearanceRoles = Object.keys(appearancePalettes.light) as AppearanceRole[];
const pageRoles: readonly ScrollPageRole[] = ['plate', 'solid', 'lit'];

function declarations(appearance: Appearance): string {
  const palette: ScrollPagePalette = scrollPagePalettes[appearance];
  const shared = appearanceRoles.map((role) => `${appearanceVariable(role)}:${palette[role]};`).join('');
  const own = pageRoles.map((role) => `${scrollPageVariable(role)}:${palette[role]};`).join('');
  return `${shared}${own}color-scheme:${appearance};`;
}

/**
 * The style sheet a web page installs beside `appearanceStyleSheet()`. The page names itself; the person's appearance on
 * the root picks which palette it takes, so a switch of appearance repaints the page at once, with no component reading
 * the setting. The dark rule is the more specific, so it wins inside a dark root.
 */
export function scrollPageStyleSheet(): string {
  return [
    `[${scrollPageAttribute}]{${declarations('light')}}`,
    `[${appearanceAttribute}="dark"] [${scrollPageAttribute}]{${declarations('dark')}}`,
  ].join('\n');
}
