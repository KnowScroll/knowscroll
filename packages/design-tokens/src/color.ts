/**
 * Colour tokens, in two registers (Tokens.html: "Content screens use content.*; the universe uses
 * space.*. A component never mixes raw hexes from both"). Values are copied from the v2.1 export;
 * values the frames draw without a name are named here or recorded as dropped in README.md
 * (D-006 p).
 */

/** The content ("poster") register: Reel, Scroll, Talk, Keep, settings and every ordinary control. */
export const content = {
  /** Ground. */
  paper: '#FFFBF0',
  /** Sunken surfaces and inputs. */
  paper2: '#F4EDD8',
  /** Text and the 2 px outline. */
  ink: '#111111',
  /** Secondary text. */
  ink2: '#4A463D',
  /** Primary action; cream text on it. */
  accent: '#2C46E8',
  /** Accent as text and pressed/hover accent (was unnamed `#1B2FB8`). */
  accentDeep: '#1B2FB8',
  /** Text and icons on `accent`. */
  onAccent: '#FFFBF0',
  /** Horizontal continuation / Part cue only (D-006 b); ink on it. */
  continue: '#FFE44D',
  onContinue: '#111111',
  /** Ready / sent; ink on it. */
  fresh: '#14C79B',
  /** Teal as text (moderator, "Stays"). */
  freshInk: '#0B7A5F',
  /** Success receipt ground (was unnamed `#E3F6EF`). */
  freshTint: '#E3F6EF',
  /** Hairline divider; decoration only, never a component boundary. */
  rule: '#D9D1BC',
  /**
   * Quiet component edges: preparing dashed border, episode divider, upcoming episode and
   * suggested-branch borders (merges unnamed `#7D7563`, `#9A9382`, `#8F887A`).
   */
  muted: '#7D7563',
  /** Floating nav pill and nav rails. */
  nav: '#111111',
  /** Restored-anchor flash and row hover. */
  highlight: '#FFF4C2',
} as const;

/** Status colours. Status labels are only Hypothetical and Corrected (D-006 a). */
export const status = {
  hypothetical: { background: '#E6EAFF', foreground: '#1B2FB8', edge: '#2C46E8', edgeStyle: 'dashed' },
  corrected: { background: '#FFE9DE', foreground: '#8A2C07', edge: '#8A2C07', edgeStyle: 'solid' },
  /** Failed and destructive. `fill` carries cream text; `foreground` is danger as text on paper. */
  danger: { fill: '#B23A0B', foreground: '#8A2C07', edge: '#B23A0B' },
  /**
   * "Preparing" skeleton: 135° stripes alternating `a` and `b`, `stripe` px wide
   * (`compactStripe` inside chips).
   */
  preparing: { a: '#FFFBF0', b: '#F4EDD8', angle: 135, stripe: 6, compactStripe: 5 },
} as const;

/** Translucent layers over media and dark surfaces. */
export const overlay = {
  /** Modal scrim (the export draws .35/.4/.45/.5/.55; .45 is the most used, D-006 p). */
  scrim: 'rgba(17,17,17,0.45)',
  /** Caption backdrop over media and the "previous" left edge tab. */
  caption: 'rgba(17,17,17,0.82)',
  /** Icon-button fill over media. */
  onMediaControl: 'rgba(255,251,240,0.94)',
  /** Progress track over media; the fill is `content.paper`. */
  onMediaTrack: 'rgba(255,251,240,0.35)',
  /** Inactive nav items and secondary text on ink. */
  onDarkMuted: 'rgba(255,251,240,0.78)',
  /** Ghost borders and tag edges on dark (merges the tag's .55 into .6). */
  onDarkEdge: 'rgba(255,251,240,0.6)',
} as const;

/** The spatial ("cosmos") register: universe, rooms on the map, formation. */
export const space = {
  /** Ground (unifies web #050B19 and Cosmos #03101A; also the media mini-bar ground). */
  s0: '#040A17',
  /** Raised panel and the space-tone nav pill. */
  s1: '#0B1A2E',
  /** Pressed / selected. */
  s2: '#14273F',
  /** Cream floating controls; ink on them. */
  control: '#FFFBF0',
  onControl: '#111111',
  label: '#FFFBF0',
  /** Secondary label, cream 72 %. */
  label2: 'rgba(255,251,240,0.72)',
  /** Orbit hairline, decoration only. */
  orbit: 'rgba(255,251,240,0.18)',
  /** 1 px edge of space panels and the space nav pill. */
  edge: 'rgba(255,251,240,0.22)',
  /** Route line on the map. */
  route: 'rgba(255,251,240,0.4)',
  /** Organising-star core. */
  star: '#FFE9A8',
  /** Focus ring and ship trail. */
  focus: '#FFE44D',
  /** Label chip on close-ups. */
  labelChip: 'rgba(4,10,23,0.86)',
  regionPin: { fill: '#E7F7E9', selected: '#FFE44D', stroke: '#111111' },
} as const;

/** Decorative opacities of the spatial kit (never meaning). */
export const spaceOpacity = {
  starGlowInner: 0.16,
  starGlowOuter: 0.08,
  backgroundStarMin: 0.3,
  backgroundStarMax: 0.7,
  dormantOrbit: 0.1,
} as const;

export type TopicFamily = 'learningMachines' | 'systems' | 'past' | 'play' | 'worlds';

/**
 * Topic families: hue plus surface pattern, two cues and never hue alone. Planet size never
 * encodes consumption (D-006 m).
 */
export const family = {
  learningMachines: {
    base: '#2BC4B4',
    pattern: '#5BCB72',
    stroke: '#0E3B2E',
    motif: 'angular-land',
    label: 'Teal ocean · angular green land',
  },
  systems: {
    base: '#6E86FF',
    pattern: '#C9D3FF',
    stroke: '#C9D3FF',
    motif: 'banded-strata',
    label: 'Cobalt · banded strata',
  },
  past: {
    base: '#F2B84B',
    pattern: '#8A5A10',
    stroke: '#8A5A10',
    motif: 'ridged-dunes',
    label: 'Amber · ridged dunes',
  },
  play: {
    base: '#FF8A5B',
    pattern: '#FFD2BE',
    stroke: '#FFD2BE',
    motif: 'round-islands',
    label: 'Coral · round islands',
  },
  worlds: { base: '#E7E1CF', pattern: '#7D7563', stroke: '#7D7563', motif: 'fault-lines', label: 'Bone · fault lines' },
} as const satisfies Record<
  TopicFamily,
  { base: string; pattern: string; stroke: string; motif: string; label: string }
>;

/** Dormant ("calm") bodies: same place, intact terrain, quieter. */
export const dormant = { saturationDelta: -0.35, orbitOpacity: 0.1, glow: false, twinkle: false } as const;

/** The signed-in person's own avatar (yellow in D01, D02, D04, D05, S01, P01). */
export const avatar = { self: '#FFE44D', onSelf: '#111111', edge: '#111111' } as const;

export const color = { content, status, overlay, space, spaceOpacity, family, dormant, avatar } as const;
