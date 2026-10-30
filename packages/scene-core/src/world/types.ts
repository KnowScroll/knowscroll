import type { PlanetType, Point, WORLD_GENERATOR_VERSION } from '../types.js';
import type { Loop } from './contours.js';

/**
 * What one planet's world is drawn from, and nothing else: the planet's seed, its painted type, its
 * variant and how many sites it has. Which regions have formed is not an input, so a cell keeps its
 * shape when a region forms.
 */
export interface WorldSpec {
  readonly seed: string;
  readonly type: PlanetType;
  /** The planet's look variant (`PlanetLook.variant`): a repeated type lays out a different world. */
  readonly variant: number;
  /** `PlanetLook.siteCount`: one site for each facet, plus the spare sites. */
  readonly siteCount: number;
}

/** A cartoon cloud, already placed in world units: circles as x, y, radius triples and a base bar. */
export interface Puff {
  readonly circles: readonly number[];
  readonly bar: readonly [x: number, y: number, width: number, height: number];
}

/** The cloud laid over land that is not reached yet, centred on it. */
export interface Veil {
  readonly at: Point;
  readonly rx: number;
  readonly ry: number;
  readonly puffs: readonly Puff[];
}

/** Where one site's region is drawn. `loops` is empty only if noise swallowed the whole cell. */
export interface WorldCell {
  readonly site: number;
  readonly loops: readonly Loop[];
  /** Where the region's name is written: well inside the cell, kept apart from every other name's. */
  readonly label: Point;
  readonly veil?: Veil;
}

/** A continent that belongs to no site. It is decoration and draws grey on the map. */
export interface WorldDecor {
  readonly loops: readonly Loop[];
  readonly veil?: Veil;
}

interface WorldBase {
  readonly generator: typeof WORLD_GENERATOR_VERSION;
  readonly siteCount: number;
  /** One cell for each site, in site order. */
  readonly cells: readonly WorldCell[];
  readonly decor: readonly WorldDecor[];
  /** Every coast, as one set of outlines. */
  readonly land: readonly Loop[];
  /** Water just off the coast, and a wider rim of it. */
  readonly shallow: readonly Loop[];
  readonly shallowWide: readonly Loop[];
  /** Flat cartoon patches on the land: lowland and highland. */
  readonly lowland: readonly Loop[];
  readonly highland: readonly Loop[];
}

/** The band a globe shows: 480 wide, wrapping, drawn twice side by side so it can turn. */
export interface GlobeWorld extends WorldBase {
  readonly kind: 'globe';
  readonly width: number;
  readonly height: number;
  /** Cumulus: the body, a brighter middle and a sunlit core. */
  readonly clouds: { readonly body: readonly Loop[]; readonly middle: readonly Loop[]; readonly core: readonly Loop[] };
}

/** A sea mark: a place on open water for a wave, a floe, a bubble or a crater. */
export interface SeaMark {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly turn: number;
}

/** The flat map a person lands on, drawn in 390 by 844 units. */
export interface MapWorld extends WorldBase {
  readonly kind: 'map';
  readonly width: number;
  readonly height: number;
  readonly marks: readonly SeaMark[];
  /** Clouds framing the edge of what is drawn. */
  readonly frame: readonly Puff[];
}

export type World = GlobeWorld | MapWorld;
