import { FORMATION } from './policy.js';

/**
 * How much one incremental evaluation reads (D-416). Formation costs what changed: a run takes the topics whose trusted
 * support changed, reads a bounded number of the newest support keys of each, and never the catalogue or the person's
 * whole history. Changing a number is a change of policy.
 */
export const EVALUATION = {
  /** Dirty topics one Cartographer run evaluates. More stay dirty and get their own paced run. */
  topicsPerRun: 16,
  /**
   * Newest support keys read per facet of a topic. The newest key of each facet decides a region and a place's last
   * support; a planet needs three distinct units over two facets, so three keys of a facet cannot hide one it needs.
   */
  keysPerFacet: FORMATION.planetUnits,
  /**
   * Other supported topics of a system read beside the touched ones, the most recently supported first and one key of each facet
   * (a neighbour is read, not evaluated, so it stays dirty if it was): a system that is not formed needs the units under it counted,
   * a planet that is due can be routed to the planets already formed beside it, and a system whose newest support was lowered finds
   * its newest support in the topics beside the one that changed. The newest of these holds the system's latest support.
   */
  neighbourTopics: 8,
  /** The frozen context holds at most this many bytes of JSON. */
  contextBytes: 500_000,
  /**
   * A facet is read until it holds as many trusted keys as it was asked for (or no key is left): when the newest keys are
   * withdrawn, the next page of keys is read, so what is evaluated is what the whole catalogue holds. At most this many pages
   * of a facet are read; a facet with more untrusted keys than `maxKeyPages` pages hold, all newer than its trusted ones,
   * keeps its older trusted keys unread until they are the newest.
   */
  maxKeyPages: 16,
  /** Other recent topics a reader is sampled on when nothing trusted was found in the evaluated ones (`no_trusted_support`). */
  sampleTopics: 8,
  /**
   * Times a topic whose keys were probed with nothing trusted is evaluated again (after a minute, doubling to an hour) before it
   * is let go: the content may be withdrawn for good. A coverage readmission or new reading marks it dirty again.
   */
  untrustedAttempts: 8,
} as const;

/** A support key with when its newest exposure was activated, as Personal Context orders a topic's keys. */
export interface RankedKey {
  readonly topicId: string;
  readonly facetId: string;
  readonly explanationUnitId: string;
  readonly lastActivatedAt?: string | null;
}

/**
 * The keys one evaluation reads: for each facet of each topic, its newest `perFacet` keys (newest first, a key with no time
 * last, the unit id breaking ties). This is the reference for what `ReadCoverageInputs` selects in SQL, and the
 * statement that bounding by facet loses nothing the rules read: each facet keeps its newest key (a region and a place's
 * last support are exact), and a facet with more than `FORMATION.planetUnits` keys already holds enough distinct units, so no
 * threshold of a planet or a system changes. The claim holds while the keys read are trusted; a key that is not
 * (withdrawn content) leaves its facet with the older ones.
 */
export function newestKeysPerFacet<K extends RankedKey>(keys: readonly K[], perFacet: number): K[] {
  const byFacet = new Map<string, K[]>();
  for (const key of keys) {
    const slot = JSON.stringify([key.topicId, key.facetId]);
    byFacet.set(slot, [...(byFacet.get(slot) ?? []), key]);
  }
  const time = (key: RankedKey) => (key.lastActivatedAt ? Date.parse(key.lastActivatedAt) : Number.NEGATIVE_INFINITY);
  return [...byFacet.values()].flatMap((facet) =>
    [...facet]
      .sort((a, b) => time(b) - time(a) || a.explanationUnitId.localeCompare(b.explanationUnitId))
      .slice(0, perFacet),
  );
}
