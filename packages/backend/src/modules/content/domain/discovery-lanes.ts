/**
 * Named retrieval lanes of Composer policy v3 (D-420). Retrieval fills a decision's candidates from lanes, in this priority
 * order, each with its own quota, and every candidate carries the lane that read it first, so a replay and an operator can say
 * where a candidate came from:
 *
 * - `source`: the topics of the encounter the person is on (primary before supporting, never incidental).
 * - `planned`: the explanation units a valid Planner opportunity names.
 * - `text`: a match on text the person typed (never a source's own summary).
 * - `continue`: the person's top long-term interest topics, at most {@link DISCOVERY_LANE_QUOTAS}.continuePerSystem per system.
 * - `adjacent`: the other topics of the systems the source's topics belong to.
 * - `explore`: a rotating sample of the whole library, stratified by system. It takes the rest of the cap: every lane before it is
 *   bounded by its quota, and the sample is read round-robin across systems, so a person with no history still gets a full read.
 */
export const DISCOVERY_LANES = ['source', 'planned', 'text', 'continue', 'adjacent', 'explore'] as const;
export type DiscoveryLane = (typeof DISCOVERY_LANES)[number];

/** What a lane-based read needs of the person, as data: Content reads no personal table. */
export interface DiscoveryLanes {
  /** The person's top interest topics, strongest first. Unknown ids are their own stratum. At most {@link DISCOVERY_LANE_LIMITS}. */
  readonly continueTopicIds: readonly string[];
  /** The explanation units a valid Planner opportunity names. */
  readonly plannedUnitIds: readonly string[];
}

/**
 * The quota of each lane for one read of 100 candidates. The lanes before `explore` are capped at 66 together, so `explore` always
 * has at least 34 and takes everything the others leave: it is last in priority, so the cap trims it, never the others.
 */
export const DISCOVERY_LANE_QUOTAS = {
  source: 20,
  planned: 6,
  text: 20,
  continue: 28,
  continuePerSystem: 5,
  adjacent: 12,
  explore: 100,
  /** Rows the explore lane reads from the rotation (each side of the cursor) before it stratifies them. */
  exploreWindow: 120,
} as const;

/** Bounds on a lane read's input. */
export const DISCOVERY_LANE_LIMITS = { continueTopics: 64, plannedUnits: 12 } as const;

const ID_MAX = 160;

/** The lanes of a read, checked: bounded arrays of non-empty ids. Anything else is refused (`DISCOVERY_LANES_INVALID`). */
export function validateDiscoveryLanes(lanes: DiscoveryLanes): DiscoveryLanes {
  const idsOf = (value: unknown, max: number): readonly string[] => {
    if (
      !Array.isArray(value) ||
      value.length > max ||
      value.some((id) => typeof id !== 'string' || id.length < 1 || id.length > ID_MAX)
    )
      throw new Error('DISCOVERY_LANES_INVALID');
    return value as readonly string[];
  };
  const raw = lanes as unknown as { readonly continueTopicIds?: unknown; readonly plannedUnitIds?: unknown } | null;
  return {
    continueTopicIds: [...new Set(idsOf(raw?.continueTopicIds, DISCOVERY_LANE_LIMITS.continueTopics))],
    plannedUnitIds: [...new Set(idsOf(raw?.plannedUnitIds, DISCOVERY_LANE_LIMITS.plannedUnits))],
  };
}
