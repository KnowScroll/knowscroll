/**
 * The New Universe palette and the Talk themes built from it (v3, D-060, D-145).
 *
 * `universe` holds the Universe file's foundations (`docs/v2/design/v3/universe/new-universe.html`):
 * one Paper and Ink pair, cobalt for you, a black sky, glass over it, and the chunky offset shadow
 * of everything that can be pressed. `talkThemes` assigns those values to the roles of T3's kit
 * (`docs/v2/design/v3/talk-t3/`). Talk is dark by default; the Paper option is a second set of the
 * same roles, so switching is a change of name and never of component code.
 */

/** Foundations shared by the Universe and Talk. Values are the design file's, not new ones. */
export const universe = {
  /** Behind every 3D scene and behind Talk: the sky is black with plain stars. */
  sky: '#020308',
  /** Every light surface: cards, chips, buttons, pills, and other people's bubbles. */
  paper: '#FFFDF2',
  /** Quiet fill on paper: picked rows, a docked card. */
  paper2: '#F4EDD8',
  /** Text, 2 px borders and primary buttons on Paper. */
  ink: '#15302A',
  /** Secondary text on Paper (Ink at about 70 %). */
  ink2: '#566962',
  /** You: own bubbles, Send, the primary action. */
  cobalt: '#2C46E8',
  /** Focus rings and "picked"; never "mine" (T3 Q2). */
  focus: '#FFE44D',
  /** The flash on a quoted original after a jump, and matched letters. */
  highlight: '#FFEC7A',
  /** "You were here" dot and level chips. */
  orange: '#FF684C',
  fresh: '#14C79B',
  /** The rippling dot of "since you were here". */
  red: '#FF3B30',
  /** Text on the sky. */
  label: '#FFFDF2',
  /** Secondary text on the sky (Paper at 72 %). */
  label2: 'rgba(255,253,242,0.72)',
  /** Glass over the sky: tab bars, headers, date capsules. A client without blur draws the fill alone. */
  glass: {
    fill: 'rgba(10,20,28,0.42)',
    edge: 'rgba(255,255,255,0.15)',
    blur: 22,
    saturate: 1.35,
  },
  /** The offset shadow of pressable things, as `box-shadow` strings (T3: 0 4px 0 on bubbles, 0 5px 0 on chips). */
  shadow: {
    chip: '0px 5px 0px 0px rgba(0,0,0,0.25)',
    bubbleOther: '0px 4px 0px 0px rgba(0,0,0,0.28)',
    bubbleOwn: '0px 4px 0px 0px rgba(0,0,0,0.35)',
    card: '0px 5px 0px 0px rgba(0,0,0,0.28)',
  },
} as const;

export type TalkThemeName = 'sky' | 'paper';

/** The roles of one Talk theme. Both themes define every role, so a screen never asks which theme it is in. */
export interface TalkTheme {
  readonly name: TalkThemeName;
  /** Behind the conversation. */
  readonly ground: string;
  /** Text on the ground: titles, names above bubbles. */
  readonly text: string;
  /** Secondary text on the ground: the time under a run, SENT. */
  readonly textQuiet: string;
  /** Another person's bubble, and the text on it. */
  readonly bubbleOther: {
    readonly fill: string;
    readonly text: string;
    readonly shadow: string;
    readonly edge: string;
  };
  /** Your own bubble, and the text on it. */
  readonly bubbleOwn: { readonly fill: string; readonly text: string; readonly shadow: string; readonly edge: string };
  /** The quote strip inside a bubble: its bar, its ground and its text, by whose bubble it is in. */
  readonly quoteOnOther: { readonly bar: string; readonly fill: string; readonly text: string };
  readonly quoteOnOwn: { readonly bar: string; readonly fill: string; readonly text: string };
  /** Date capsules and other quiet chips on the ground. */
  readonly capsule: { readonly fill: string; readonly edge: string; readonly text: string };
  /** The header and the message bar: glass on the sky, paper on Paper. */
  readonly bar: { readonly fill: string; readonly edge: string; readonly text: string };
  /** The text field, and Send. */
  readonly input: { readonly fill: string; readonly text: string; readonly placeholder: string; readonly edge: string };
  readonly send: { readonly fill: string; readonly glyph: string; readonly shadow: string };
  /** Reaction pills and the long-press menu sit on paper in both themes (T3 kit). */
  readonly pill: { readonly fill: string; readonly text: string; readonly mine: string; readonly edge: string };
  readonly menu: { readonly fill: string; readonly text: string; readonly rule: string; readonly danger: string };
  /** Dims the chat while the long-press menu is open (T3: Space at 62 %). */
  readonly dim: string;
  /** The flash on a jumped-to original; and the outline that replaces it under reduced motion. */
  readonly flash: string;
  readonly focus: string;
}

export const talkThemes = {
  sky: {
    name: 'sky',
    ground: universe.sky,
    text: universe.label,
    textQuiet: 'rgba(255,253,242,0.6)',
    bubbleOther: { fill: universe.paper, text: universe.ink, shadow: universe.shadow.bubbleOther, edge: 'transparent' },
    bubbleOwn: { fill: universe.cobalt, text: universe.paper, shadow: universe.shadow.bubbleOwn, edge: 'transparent' },
    quoteOnOther: { bar: universe.cobalt, fill: 'rgba(21,48,42,0.08)', text: universe.ink2 },
    quoteOnOwn: { bar: universe.paper, fill: 'rgba(2,3,8,0.28)', text: universe.paper },
    capsule: { fill: universe.glass.fill, edge: universe.glass.edge, text: 'rgba(255,253,242,0.88)' },
    bar: { fill: universe.glass.fill, edge: universe.glass.edge, text: universe.label },
    input: {
      fill: 'rgba(255,253,242,0.94)',
      text: universe.ink,
      placeholder: universe.ink2,
      edge: 'transparent',
    },
    send: { fill: universe.cobalt, glyph: universe.paper, shadow: universe.shadow.bubbleOwn },
    pill: { fill: universe.paper, text: universe.ink, mine: universe.cobalt, edge: 'transparent' },
    menu: { fill: universe.paper, text: universe.ink, rule: 'rgba(21,48,42,0.14)', danger: '#B23A0B' },
    dim: 'rgba(2,3,8,0.62)',
    flash: universe.highlight,
    focus: universe.focus,
  },
  paper: {
    name: 'paper',
    ground: universe.paper2,
    text: universe.ink,
    textQuiet: universe.ink2,
    bubbleOther: {
      fill: universe.paper,
      text: universe.ink,
      shadow: '0px 3px 0px 0px rgba(21,48,42,0.18)',
      edge: 'rgba(21,48,42,0.16)',
    },
    bubbleOwn: { fill: universe.cobalt, text: universe.paper, shadow: universe.shadow.bubbleOwn, edge: 'transparent' },
    quoteOnOther: { bar: universe.cobalt, fill: 'rgba(21,48,42,0.07)', text: universe.ink2 },
    quoteOnOwn: { bar: universe.paper, fill: 'rgba(2,3,8,0.28)', text: universe.paper },
    capsule: { fill: 'rgba(21,48,42,0.08)', edge: 'rgba(21,48,42,0.16)', text: universe.ink },
    bar: { fill: 'rgba(255,253,242,0.94)', edge: 'rgba(21,48,42,0.16)', text: universe.ink },
    input: { fill: universe.paper, text: universe.ink, placeholder: universe.ink2, edge: 'rgba(21,48,42,0.28)' },
    send: { fill: universe.cobalt, glyph: universe.paper, shadow: universe.shadow.bubbleOwn },
    pill: { fill: universe.paper, text: universe.ink, mine: universe.cobalt, edge: 'rgba(21,48,42,0.28)' },
    menu: { fill: universe.paper, text: universe.ink, rule: 'rgba(21,48,42,0.14)', danger: '#B23A0B' },
    dim: 'rgba(21,48,42,0.42)',
    flash: universe.highlight,
    focus: universe.cobalt,
  },
} as const satisfies Record<TalkThemeName, TalkTheme>;

/** Talk is dark by default (T3 Q1); a per-person Paper setting arrives with T-C. */
export const defaultTalkTheme: TalkThemeName = 'sky';
