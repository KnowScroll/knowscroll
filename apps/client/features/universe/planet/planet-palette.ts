import type { PlanetType } from '@knowscroll/scene-core';
import { turnHue } from './hue';

/** The four flat colours the land cycles through, and the sea, as the planet views paint them. */
type Four = readonly [string, string, string, string];
type Three = readonly [string, string, string];

/** What a planet of one type looks like from orbit and on its map (the design's Planet views). */
export interface PlanetPalette {
  readonly type: PlanetType;
  /** The globe's body, light to dark: also the sea of the landed map. */
  readonly sea: Four;
  readonly land: Four;
  readonly lowland: string;
  readonly highland: string;
  /** Coast and border ink. */
  readonly ink: string;
  readonly foam: string;
  readonly shallow: string;
  /** Cumulus: its body and its cool underside. */
  readonly cloud: readonly [string, string];
  readonly atmosphere: string;
  readonly rim: string;
  /** The card's accent: the dot and the arrow. */
  readonly accent: string;
  readonly cardKind: string;
  /** Land that is not reached yet: its face, its edge and its line. Never turned with the hue. */
  readonly grey: Three;
  /** Where the dark side sinks to, under a coast. */
  readonly shadow: string;
  /** The gas giant's bands. */
  readonly bands: readonly string[] | undefined;
  /** The sea detail drawn on the landed map. */
  readonly detail: 'waves' | 'floes' | 'lava' | 'craters' | 'bands';
  readonly glowCoast: boolean;
  readonly poleCaps: boolean;
  /** A ring's three strokes: wide, middle and bright. */
  readonly ring: Three;
}

interface Source {
  readonly sea: Four;
  readonly land: Four;
  readonly lowland: string;
  readonly highland: string;
  readonly ink: string;
  readonly foam: string;
  readonly shallow: string;
  readonly cloud: readonly [string, string];
  readonly atmosphere: string;
  readonly rim: string;
  readonly accent: string;
  readonly cardKind: string;
  readonly grey: Three;
  readonly shadow: string;
  readonly ring: Three;
  readonly bands?: readonly string[];
  readonly detail: PlanetPalette['detail'];
  readonly glowCoast?: boolean;
  readonly poleCaps?: boolean;
}

const SOURCES: Readonly<Record<PlanetType, Source>> = {
  lush: {
    sea: ['#a4f5ee', '#43c9d6', '#178cba', '#0a4f7e'],
    land: ['#5fd36f', '#8ee25c', '#3fbf6a', '#b5ea6a'],
    lowland: '#2a9a55',
    highland: '#f2d57e',
    ink: '#14402e',
    foam: '#e9fffb',
    shallow: '#4fc3c9',
    cloud: ['#f6fcff', '#9dc0d4'],
    atmosphere: '#83f2ea',
    rim: '#b9fff2',
    accent: '#33c4b4',
    cardKind: '#8edbe0',
    grey: ['#7b8d97', '#55666f', '#2a3a42'],
    shadow: '#04283a',
    ring: ['#4fb878', '#a6e58a', '#e9d9a0'],
    detail: 'waves',
  },
  ocean: {
    sea: ['#b8f4ff', '#3fb4f0', '#1670cc', '#0a3a80'],
    land: ['#7ee06a', '#5fd07a', '#a6ec6a', '#4fc36e'],
    lowland: '#2f9e55',
    highland: '#ffe08a',
    ink: '#12403a',
    foam: '#f2fdff',
    shallow: '#7fd8f7',
    cloud: ['#ffffff', '#a7cbe6'],
    atmosphere: '#9fe0ff',
    rim: '#d4f4ff',
    accent: '#ffd058',
    cardKind: '#ffe39a',
    grey: ['#8496a6', '#5a6b7c', '#2c3c4c'],
    shadow: '#082a5e',
    ring: ['#a5e88a', '#5fcf7c', '#ffe7a8'],
    detail: 'waves',
  },
  frozen: {
    sea: ['#e6f8ff', '#8fcaf5', '#3c86d0', '#163f80'],
    land: ['#f6fcff', '#d8efff', '#c2e6ff', '#e9f8ff'],
    lowland: '#9fd2f5',
    highland: '#ffffff',
    ink: '#24497a',
    foam: '#ffffff',
    shallow: '#8fc4ef',
    cloud: ['#ffffff', '#b2c8de'],
    atmosphere: '#c8ecff',
    rim: '#f0fbff',
    accent: '#7fc8ff',
    cardKind: '#bfe4ff',
    grey: ['#9eacbb', '#76869a', '#3a4a5e'],
    shadow: '#08203f',
    ring: ['#c4e2ff', '#dcefff', '#ffffff'],
    detail: 'floes',
    poleCaps: true,
  },
  scorched: {
    sea: ['#ff9a6a', '#e0483e', '#8e1a36', '#3e0716'],
    land: ['#ff7a45', '#ff5a3c', '#ffa04a', '#f06a3a'],
    lowland: '#8a2030',
    highland: '#ffd25a',
    ink: '#3a0a14',
    foam: '#ffd2a0',
    shallow: '#9a2c2c',
    cloud: ['#efdde0', '#a08088'],
    atmosphere: '#ff9a7a',
    rim: '#ffc2aa',
    accent: '#ff6a4a',
    cardKind: '#ffb49a',
    grey: ['#6a565c', '#4a383e', '#251a1e'],
    shadow: '#0b0105',
    ring: ['#ffa766', '#ff6b4d', '#ffc48a'],
    detail: 'lava',
    glowCoast: true,
  },
  barren: {
    sea: ['#dcc6f2', '#9d82c4', '#60488a', '#2c1f48'],
    land: ['#f7cf86', '#eeb062', '#e39a52', '#f9dca0'],
    lowland: '#c06a3a',
    highland: '#fff2cc',
    ink: '#4a2a18',
    foam: '#f4eaff',
    shallow: '#a596b8',
    cloud: ['#f5edf8', '#bba9cb'],
    atmosphere: '#dcc6ff',
    rim: '#f2e8ff',
    accent: '#e8b86a',
    cardKind: '#f2d4a0',
    grey: ['#8e869a', '#686076', '#363044'],
    shadow: '#1c1428',
    ring: ['#d6aa6c', '#e4bf80', '#fff0cf'],
    detail: 'craters',
  },
  gas: {
    sea: ['#ffe2c0', '#ff9ab8', '#b07ae0', '#4e2a86'],
    land: ['#fff1e0', '#ffd6c0', '#ffc6da', '#ecd2ff'],
    lowland: '#ff8fb6',
    highland: '#ffffff',
    ink: '#7a3a68',
    foam: '#ffffff',
    shallow: '#ffd9e6',
    cloud: ['#ffffff', '#e0bcd0'],
    atmosphere: '#ffb8d6',
    rim: '#ffe4ef',
    accent: '#ff7aa8',
    cardKind: '#ffc2d8',
    grey: ['#cdbccc', '#a8949f', '#6e5a68'],
    shadow: '#7a3a6a',
    ring: ['#ffd3df', '#ffe3d0', '#ffffff'],
    bands: ['#ffb07a', '#ff7fa6', '#b88aff', '#ffd27a', '#ff6f9a'],
    detail: 'bands',
  },
};

const turn = (hue: number) => (colour: string) => turnHue(colour, hue);
const turnFour = (colours: Four, hue: number): Four => colours.map(turn(hue)) as unknown as Four;
const turnThree = (colours: Three, hue: number): Three => colours.map(turn(hue)) as unknown as Three;

/**
 * The palette of a planet type, its hue turned by the planet's look (`PlanetLook.hueShift`). The
 * greys of unreached land, clouds and the foam are not turned: they stay the same on every planet.
 */
export function paletteOf(type: PlanetType, hueShift: number): PlanetPalette {
  const source = SOURCES[type];
  const turned = turn(hueShift);
  return {
    type,
    sea: turnFour(source.sea, hueShift),
    land: turnFour(source.land, hueShift),
    lowland: turned(source.lowland),
    highland: turned(source.highland),
    ink: turned(source.ink),
    foam: source.foam,
    shallow: turned(source.shallow),
    cloud: source.cloud,
    atmosphere: turned(source.atmosphere),
    rim: turned(source.rim),
    accent: turned(source.accent),
    cardKind: turned(source.cardKind),
    grey: source.grey,
    shadow: turned(source.shadow),
    bands: source.bands?.map(turned),
    detail: source.detail,
    glowCoast: source.glowCoast === true,
    poleCaps: source.poleCaps === true,
    ring: turnThree(source.ring, hueShift),
  };
}
