/**
 * How big a lab run is, and the bounds its invariants hold the code to.
 *
 * `small` runs in hosted CI on every pull request and must stay under about two minutes.
 * `large` is for a manual or nightly run on one machine (`KS_SIM_SIZE=large`): a bigger library and
 * longer sessions. It is not the 10,000-topic test, which waits for the catalogue in Postgres
 * (slice 2.1 of #674): the topics are still the 17 planets of the code catalogue.
 */
export type SimSize = 'small' | 'large';

export interface SimConfig {
  readonly size: SimSize;
  /** The seed every persona's choices and every invented identifier derive from. */
  readonly seed: number;
  /** The Composer policy new decisions are made under: the one dev runs, set by the same variable the API and the worker read. */
  readonly composerPolicy: 'v0' | 'v1' | 'v2';
  readonly library: {
    /** How many of the catalogue's planets the library covers (the catalogue has 17). */
    readonly planets: number;
    /** Explanation units per planet, drawn per planet from this inclusive range. */
    readonly unitsPerPlanet: readonly [number, number];
    /** The share of units that also have a Reel twin, besides each planet's first two units, which always have one. */
    readonly reelTwinShare: number;
  };
  /** The binge reader's own, smaller library: one it can read to the end. */
  readonly bingeLibrary: { readonly planets: number; readonly unitsPerPlanet: readonly [number, number] };
  readonly sessions: {
    /** Encounters of a persona that is not defined by the library size. */
    readonly typical: number;
    /** Encounters beyond the library the binge reader goes on for, to reach the end of everything unseen. */
    readonly bingeTail: number;
  };
  readonly bounds: {
    /** Composer decisions per move (the answer to the move, and the buffer the activation it leads to prepares). */
    readonly decisionsPerMove: number;
    /** Geography runs per activity change: an encounter, a Like or a Save. Changes that arrive together coalesce into one paced run. */
    readonly geographyRunsPerActivityChange: number;
    /** Planner runs per activity change. */
    readonly plannerRunsPerActivityChange: number;
    /** Drain rounds after the last encounter within which formation must show. */
    readonly formationDrains: number;
  };
}

const SMALL: SimConfig = {
  size: 'small',
  seed: 674,
  composerPolicy: 'v2',
  library: { planets: 17, unitsPerPlanet: [3, 4], reelTwinShare: 0.2 },
  bingeLibrary: { planets: 5, unitsPerPlanet: [3, 3] },
  sessions: { typical: 12, bingeTail: 6 },
  bounds: {
    decisionsPerMove: 2,
    geographyRunsPerActivityChange: 1,
    plannerRunsPerActivityChange: 1,
    formationDrains: 6,
  },
};

const LARGE: SimConfig = {
  ...SMALL,
  size: 'large',
  library: { planets: 17, unitsPerPlanet: [8, 12], reelTwinShare: 0.3 },
  bingeLibrary: { planets: 10, unitsPerPlanet: [5, 6] },
  sessions: { typical: 60, bingeTail: 25 },
};

/**
 * The configuration of the binge reader's world: a library small enough to read to the end, so that "nothing unseen is
 * left" is reachable and then overshot, which the full library is too big for in a CI minute.
 */
export function bingeLibraryConfig(config: SimConfig): SimConfig {
  return { ...config, library: { ...config.library, ...config.bingeLibrary } };
}

/**
 * The run's configuration: `KS_SIM_SIZE` picks the size and `KS_SIM_SEED` the seed. The Composer policy is the one dev
 * runs (`v2`), and `KS_COMPOSER_POLICY`, the variable the API and the worker read, changes it for a comparison run.
 */
export function simConfig(env: NodeJS.ProcessEnv = process.env): SimConfig {
  const base = env['KS_SIM_SIZE'] === 'large' ? LARGE : SMALL;
  const seed = Number(env['KS_SIM_SEED'] ?? base.seed);
  const policy = env['KS_COMPOSER_POLICY'];
  if (!Number.isInteger(seed) || seed < 0) throw new Error('KS_SIM_SEED must be a non-negative integer');
  if (policy !== undefined && policy !== 'v0' && policy !== 'v1' && policy !== 'v2')
    throw new Error('KS_COMPOSER_POLICY must be v0, v1 or v2');
  return { ...base, seed, composerPolicy: policy ?? base.composerPolicy };
}
