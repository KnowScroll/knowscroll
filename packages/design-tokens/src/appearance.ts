/**
 * Appearance: the one Light or Dark choice for the whole app (#666, amends D-145, D-151 and D-154).
 *
 * The v2.1 content register (`content`) was drawn on paper only. Appearance gives the roles of that
 * register that describe a *surface and what is drawn on it* a second value for Dark, taken from the
 * New Universe file (the sky, its cream label, cobalt), so the shell, Settings, Talk, rooms, sheets,
 * sidebars and the reader's controls change together. Roles that carry a meaning of their own
 * (cobalt for the primary action and cream on it, yellow for continuation, teal for ready) keep
 * one value in both appearances.
 *
 * How a value reaches a component is in `adaptive.ts`: on the web every adaptive role is a CSS
 * custom property, so a switch repaints every existing style at once; native builds draw Light
 * chrome until they can read the appearance (see README, "Appearance").
 */
import type { TalkThemeName } from './universe';

export type Appearance = 'light' | 'dark';

export const appearances: readonly Appearance[] = ['light', 'dark'];

/**
 * What a fresh install shows. Dark, because the Universe, Talk and rooms are drawn on the sky (T3 Q1,
 * D-145) and a person upgrading from the sky Talk default keeps what they saw.
 */
export const defaultAppearance: Appearance = 'dark';

/** Talk's own role set (D-145) follows Appearance: the sky in Dark, Paper in Light. */
export const talkThemeForAppearance: Readonly<Record<Appearance, TalkThemeName>> = {
  light: 'paper',
  dark: 'sky',
};

/** The roles that change with Appearance. Every other colour token has one value. */
export interface AppearancePalette {
  /** Ground of every content screen, sidebar and sheet. */
  readonly paper: string;
  /** Sunken surfaces, inputs, picked rows. */
  readonly paper2: string;
  /** Text, icons, the 2 px outline and the ink (inverted) button. */
  readonly ink: string;
  /** Secondary text. */
  readonly ink2: string;
  /** Cobalt as text and link. */
  readonly accentDeep: string;
  /** Teal as text. */
  readonly freshInk: string;
  /** Success receipt ground. */
  readonly freshTint: string;
  /** Hairline divider. */
  readonly rule: string;
  /** Quiet component edges. */
  readonly muted: string;
  /** Floating nav pill and nav rails. */
  readonly nav: string;
  /** Restored-anchor flash and row hover. */
  readonly highlight: string;
  /** Danger (failed, destructive) as text on the ground. */
  readonly dangerText: string;
  /** The two stripes of a "preparing" skeleton. */
  readonly preparingA: string;
  readonly preparingB: string;
  /** The focus ring drawn on the ground (WCAG 1.4.11: 3:1 against paper and paper-2). */
  readonly focus: string;
  /** The Hypothetical status (What-if cards, a picked choice): ground, text and dashed edge. */
  readonly hypotheticalGround: string;
  readonly hypotheticalText: string;
  readonly hypotheticalEdge: string;
  /** The Corrected status: ground, text and edge. */
  readonly correctedGround: string;
  readonly correctedText: string;
}

export const appearancePalettes = {
  /** The v2.1 export's values, unchanged. */
  light: {
    paper: '#FFFBF0',
    paper2: '#F4EDD8',
    ink: '#111111',
    ink2: '#4A463D',
    accentDeep: '#1B2FB8',
    freshInk: '#0B7A5F',
    freshTint: '#E3F6EF',
    rule: '#D9D1BC',
    muted: '#7D7563',
    nav: '#111111',
    highlight: '#FFF4C2',
    dangerText: '#8A2C07',
    preparingA: '#FFFBF0',
    preparingB: '#F4EDD8',
    focus: '#2C46E8',
    hypotheticalGround: '#E6EAFF',
    hypotheticalText: '#1B2FB8',
    hypotheticalEdge: '#2C46E8',
    correctedGround: '#FFE9DE',
    correctedText: '#8A2C07',
  },
  /** The Universe's sky with its cream label (`universe.sky`, `universe.label`), the same as Talk on the sky. */
  dark: {
    paper: '#020308',
    paper2: '#121722',
    ink: '#FFFDF2',
    ink2: '#B9B8B0',
    accentDeep: '#A9B6FF',
    freshInk: '#3DDBB0',
    freshTint: '#0B2A22',
    rule: '#2A303C',
    muted: '#808897',
    nav: '#1B2230',
    highlight: '#3B3514',
    dangerText: '#FF9070',
    preparingA: '#0B0F18',
    preparingB: '#161C28',
    focus: '#FFE44D',
    hypotheticalGround: '#141B45',
    hypotheticalText: '#B4C0FF',
    hypotheticalEdge: '#7D8FFF',
    correctedGround: '#33170C',
    correctedText: '#FFB08F',
  },
} as const satisfies Record<Appearance, AppearancePalette>;

export type AppearanceRole = keyof AppearancePalette;

const roles = Object.keys(appearancePalettes.light) as AppearanceRole[];

/** The CSS custom property that carries a role on the web, e.g. `--ks-paper2`. */
export function appearanceVariable(role: AppearanceRole): string {
  return `--ks-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** `var(--ks-role, <light value>)`: the value a web style holds. The fallback is Light, the export's own. */
export function appearanceReference(role: AppearanceRole): string {
  return `var(${appearanceVariable(role)}, ${appearancePalettes.light[role]})`;
}

/** The attribute that names the appearance of an element and everything inside it (web). */
export const appearanceAttribute = 'data-ks-appearance';

function declarations(appearance: Appearance): string {
  const palette: AppearancePalette = appearancePalettes[appearance];
  const values = roles.map((role) => `${appearanceVariable(role)}:${palette[role]};`).join('');
  return `${values}color-scheme:${appearance};`;
}

/**
 * The style sheet a web page installs once. The page's root names the person's appearance; an
 * element inside it may name another (a Scroll's printed page, a paper card), and the custom
 * properties it declares win for everything below it, because the nearest declaration is inherited.
 */
export function appearanceStyleSheet(): string {
  return [
    `:root{${declarations('light')}}`,
    ...appearances.map((appearance) => `[${appearanceAttribute}="${appearance}"]{${declarations(appearance)}}`),
    `html,body{background-color:var(${appearanceVariable('paper')});}`,
  ].join('\n');
}
