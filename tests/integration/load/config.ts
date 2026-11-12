/**
 * The size of one load run (#674, slice 4.4). `target` is the issue's design target (10,000+ topics, 100,000+ assets, one
 * person with thousands of topics of history and thousands of formed places); `small` is a minute-long smoke run that
 * proves the harness still works and is what a change to this directory is checked against.
 */
export interface LoadSize {
  readonly name: 'target' | 'small';
  /** Distinct topic ids in the library (synthetic: the catalogue is still code, see README). */
  readonly topics: number;
  /** Explanation units; each has a Scroll, and `reelTwinShare` of them a Reel twin sharing the unit. */
  readonly units: number;
  readonly reelTwinShare: number;
  /** Units the heavy reader has met (encounter lineage), over that many distinct topics. */
  readonly heavyMetUnits: number;
  /** Planets of the synthetic catalogue the heavy reader holds support for, and so forms (each with its star's system). */
  readonly heavyPlanets: number;
  readonly lightReaders: number;
  /** Met units of each light reader. */
  readonly lightMetUnits: number;
  /** Vertical decisions timed for the heavy reader and in all across the light readers. */
  readonly heavyDecisions: number;
  readonly lightDecisions: number;
  /** Buffer preparations and formation runs timed for the heavy reader. */
  readonly bufferRuns: number;
  readonly formationRuns: number;
  readonly skyReads: number;
  readonly gapScans: number;
}

const SIZES: Readonly<Record<LoadSize['name'], LoadSize>> = {
  target: {
    name: 'target',
    topics: 10_000,
    units: 60_000,
    reelTwinShare: 0.7,
    heavyMetUnits: 5_000,
    heavyPlanets: 2_400,
    lightReaders: 1_000,
    lightMetUnits: 8,
    heavyDecisions: 250,
    lightDecisions: 250,
    bufferRuns: 60,
    formationRuns: 30,
    skyReads: 30,
    gapScans: 5,
  },
  small: {
    name: 'small',
    topics: 400,
    units: 2_000,
    reelTwinShare: 0.7,
    heavyMetUnits: 300,
    heavyPlanets: 120,
    lightReaders: 30,
    lightMetUnits: 4,
    heavyDecisions: 20,
    lightDecisions: 20,
    bufferRuns: 6,
    formationRuns: 4,
    skyReads: 4,
    gapScans: 2,
  },
};

export function loadSize(): LoadSize {
  const wanted = process.env['KS_LOAD_SIZE'] ?? 'target';
  if (wanted !== 'target' && wanted !== 'small') throw new Error('KS_LOAD_SIZE must be target or small');
  return SIZES[wanted];
}

/** Systems of the synthetic catalogue and the topics of each, so topic `load.s03.t0042` is the 43rd topic of system 3. */
export const SYSTEM_SIZE = 100;
export const topicId = (index: number): string =>
  `load.s${String(Math.floor(index / SYSTEM_SIZE)).padStart(3, '0')}.t${String(index).padStart(5, '0')}`;
