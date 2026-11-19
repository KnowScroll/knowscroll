import { intersectIntervals, intervalsLength, mergeIntervals, type Interval } from './intervals.js';
import type { ScrollQualificationPolicy } from './policy.js';

/**
 * How one block counts as seen (content's `SeenRule`, structurally): visible for at least its own
 * minimum while the article was active, or reported with one of a few value-free interactions (a
 * call locked in or revealed). The option a reader picked is not among them.
 */
export type SeenRule =
  | { readonly kind: 'visible'; readonly minVisibleMs: number }
  | { readonly kind: 'interaction'; readonly interactions: readonly string[] };

/**
 * The reading facts of one Scroll revision as qualification needs them (provided by content,
 * derived from the document's code-set measures): the weight of each top-level block, which
 * top-level block owns each nested block, and the reading estimate. A plain structural copy of
 * content's `ReadingFacts`, so the domain stays pure.
 */
export interface ReadingFacts {
  readonly totalWeight: number;
  readonly estimatedReadingMs: number;
  /** Top-level blocks in document order (for a v2 document, its stops and calls). */
  readonly blocks: readonly {
    readonly id: string;
    readonly weight: number;
    /** How the block comes to count as seen; absent means the policy's own visibility minimum. */
    readonly seen?: SeenRule;
  }[];
  /** Blocks nested in a disclosure, with their owning top-level block. */
  readonly nested: readonly { readonly id: string; readonly owner: string }[];
}

/** What one stored observation says, by kind. Payloads were bounded and validated at intake. */
export type ObservationBody =
  | {
      readonly kind: 'reel.playback';
      readonly samples: readonly { readonly activeMs: Interval; readonly mediaMs: Interval }[];
    }
  | {
      readonly kind: 'scroll.block_coverage';
      readonly blocks: readonly {
        readonly blockId: string;
        readonly intervalsMs: readonly Interval[];
        readonly peakFraction: number;
      }[];
    }
  | { readonly kind: 'scroll.active_dwell'; readonly activeIntervalsMs: readonly Interval[] }
  | {
      readonly kind: 'scroll.block_interaction';
      readonly blockId: string;
      readonly interaction: string;
      readonly atMs: number;
    };

/** One stored observation of an exposure, in intake order. */
export interface ObservationRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly deviceSequence: number;
  readonly instrumentationVersion: number;
  readonly body: ObservationBody;
}

/** The reading of one exposure derived from its observations. Deterministic given the same input. */
export interface ReadingSummary {
  /** The highest observation `seq` this was computed from. */
  readonly inputWatermark: number;
  /** Top-level blocks that counted as seen, in document order. */
  readonly seenBlocks: readonly string[];
  readonly seenWeight: number;
  readonly totalWeight: number;
  /** Seen weight over total weight, in [0, 1]. */
  readonly coverage: number;
  /** Unique time the article was active with something visible. */
  readonly activeDwellMs: number;
  readonly estimatedReadingMs: number;
  /** Distinct deliberate interactions: one per block and kind however often reported. */
  readonly interactions: readonly { readonly blockId: string; readonly interaction: string }[];
  readonly coverageEvents: number;
  readonly dwellEvents: number;
  /** The lowest recorder build among the observations (0 when there are none). */
  readonly instrumentationVersion: number;
  /** Missing device sequence numbers within recorder sessions: events were lost. */
  readonly sequenceGaps: number;
}

/** One distinct interaction: a block and a kind, however often it was reported. */
const interactionKey = (blockId: string, kind: string): string => `${blockId}\u0000${kind}`;

/** A unit's visible intervals and the largest share of it that was ever visible, as the observations report them. */
interface Visible {
  readonly intervals: Interval[];
  peak: number;
}

/**
 * The visible time each unit earned on the shared clock (#761): every moment the article was active is divided between
 * the units visible in it, in proportion to their weight (their words), so four paragraphs on screen together earn about
 * a quarter each and a skimmer cannot qualify a whole screen at once. One sweep over the start and end of every merged
 * interval: between two consecutive edges the set of visible units is fixed. Pure.
 */
export function sharedVisibleMs(
  visible: ReadonlyMap<string, Visible>,
  activeUnion: readonly Interval[],
  weightOf: (unitId: string) => number,
): Map<string, number> {
  const edges: { readonly at: number; readonly unit: string; readonly change: 1 | -1 }[] = [];
  for (const [unit, entry] of visible)
    for (const [from, to] of intersectIntervals(mergeIntervals(entry.intervals), activeUnion)) {
      edges.push({ at: from, unit, change: 1 }, { at: to, unit, change: -1 });
    }
  edges.sort((a, b) => a.at - b.at);
  const earned = new Map<string, number>();
  const onScreen = new Set<string>();
  // A unit of no weight still takes a little of the moment, so a screen of headings is not free reading.
  const share = (unit: string): number => Math.max(1, weightOf(unit));
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (edge === undefined) continue;
    if (edge.change === 1) onScreen.add(edge.unit);
    else onScreen.delete(edge.unit);
    const next = edges[index + 1];
    if (next === undefined || next.at === edge.at || onScreen.size === 0) continue;
    const length = next.at - edge.at;
    let total = 0;
    for (const unit of onScreen) total += share(unit);
    for (const unit of onScreen) earned.set(unit, (earned.get(unit) ?? 0) + (length * share(unit)) / total);
  }
  return earned;
}

/**
 * Whether a unit counts as seen: it reached the policy's peak visible fraction, and its visible time while the article
 * was active (its own, or its share of it under the shared clock) reached the policy's minimum. That minimum is a
 * floor: a unit's own minimum (a stop or a beat that takes longer to read) can only raise it.
 */
function isVisibleLongEnough(
  entry: Visible | undefined,
  visibleMs: number,
  policy: ScrollQualificationPolicy,
  ownMinimumMs: number | undefined,
): boolean {
  if (entry === undefined || entry.peak < policy.minPeakFraction) return false;
  return visibleMs >= Math.max(policy.minBlockVisibleMs, ownMinimumMs ?? 0);
}

/**
 * Projects an exposure's observations into its reading summary (blueprint §8: unique visible
 * coverage, active dwell, deliberate interactions; automatic, background and duplicate time never
 * add coverage).
 * - **Unique time:** intervals are merged, so a retried, duplicated or overlapping report adds
 *   nothing. A block's visible time only counts where the article was **active** (its visible
 *   intervals are intersected with the active intervals), so background time never adds coverage.
 * - **Seen:** a block counts when its unique active visible time reaches the policy's minimum and
 *   it reached the policy's peak fraction. Under the shared clock its visible time is its share of each
 *   moment it shared the screen with other blocks (`sharedVisibleMs`). A nested block counts for its owning top-level block;
 *   unknown blocks never count (they were refused at intake).
 * - **Coverage:** the weight of the seen top-level blocks over the total weight, so passing several
 *   tiny headings cannot dominate it.
 * - **Gaps:** within one recorder session the device sequence numbers are 1, 2, 3...; a missing
 *   number means an event was lost, and what it carried is unknown (never inferred as reading).
 * Pure: the same observations and facts always give the same summary, whatever the order the rows
 * are passed in.
 */
export function summariseReading(
  observations: readonly ObservationRecord[],
  facts: ReadingFacts,
  policy: ScrollQualificationPolicy,
): ReadingSummary {
  const owner = new Map<string, string>();
  for (const block of facts.blocks) owner.set(block.id, block.id);
  for (const child of facts.nested) owner.set(child.id, child.owner);

  const active: Interval[] = [];
  const visibleByBlock = new Map<string, Visible>();
  const interactions = new Map<string, { blockId: string; interaction: string }>();
  let coverageEvents = 0;
  let dwellEvents = 0;
  let watermark = 0;
  let instrumentation = Number.POSITIVE_INFINITY;
  const sessions = new Map<string, Set<number>>();

  for (const observation of observations) {
    watermark = Math.max(watermark, observation.seq);
    instrumentation = Math.min(instrumentation, observation.instrumentationVersion);
    const sequences = sessions.get(observation.sessionId) ?? new Set<number>();
    sequences.add(observation.deviceSequence);
    sessions.set(observation.sessionId, sequences);
    const body = observation.body;
    switch (body.kind) {
      case 'reel.playback':
        break;
      case 'scroll.active_dwell':
        dwellEvents += 1;
        active.push(...body.activeIntervalsMs);
        break;
      case 'scroll.block_coverage':
        coverageEvents += 1;
        for (const block of body.blocks) {
          const top = owner.get(block.blockId);
          if (top === undefined) continue;
          const entry = visibleByBlock.get(top) ?? { intervals: [], peak: 0 };
          entry.intervals.push(...block.intervalsMs);
          entry.peak = Math.max(entry.peak, block.peakFraction);
          visibleByBlock.set(top, entry);
        }
        break;
      case 'scroll.block_interaction':
        if (owner.has(body.blockId))
          interactions.set(interactionKey(body.blockId, body.interaction), {
            blockId: body.blockId,
            interaction: body.interaction,
          });
        break;
    }
  }

  const activeUnion = mergeIntervals(active);
  const weights = new Map(facts.blocks.map((block) => [block.id, block.weight]));
  const shared =
    policy.clock === 'shared' ? sharedVisibleMs(visibleByBlock, activeUnion, (id) => weights.get(id) ?? 0) : undefined;
  const visibleMsOf = (id: string): number => {
    if (shared !== undefined) return shared.get(id) ?? 0;
    const entry = visibleByBlock.get(id);
    return entry === undefined ? 0 : intervalsLength(intersectIntervals(mergeIntervals(entry.intervals), activeUnion));
  };
  const seenBlocks: string[] = [];
  let seenWeight = 0;
  for (const block of facts.blocks) {
    const own = block.seen;
    const counts =
      own?.kind === 'interaction'
        ? own.interactions.some((kind) => interactions.has(interactionKey(block.id, kind)))
        : isVisibleLongEnough(
            visibleByBlock.get(block.id),
            visibleMsOf(block.id),
            policy,
            own?.kind === 'visible' ? own.minVisibleMs : undefined,
          );
    if (counts) {
      seenBlocks.push(block.id);
      seenWeight += block.weight;
    }
  }

  let gaps = 0;
  for (const sequences of sessions.values()) gaps += Math.max(...sequences) - sequences.size;

  return {
    inputWatermark: watermark,
    seenBlocks,
    seenWeight,
    totalWeight: facts.totalWeight,
    coverage: facts.totalWeight === 0 ? 0 : Math.min(1, seenWeight / facts.totalWeight),
    activeDwellMs: intervalsLength(activeUnion),
    estimatedReadingMs: facts.estimatedReadingMs,
    interactions: [...interactions.values()].sort(
      (a, b) => a.blockId.localeCompare(b.blockId) || a.interaction.localeCompare(b.interaction),
    ),
    coverageEvents,
    dwellEvents,
    instrumentationVersion: Number.isFinite(instrumentation) ? instrumentation : 0,
    sequenceGaps: gaps,
  };
}

/** Session-relative clocks never intersect another session's visibility/dwell. Only factual
 * seen sets combine within this generation; dwell has one server elapsed-time ceiling. */
export function summariseRecordingReading(
  observations: readonly ObservationRecord[],
  facts: ReadingFacts,
  policy: ScrollQualificationPolicy,
  elapsedMs: number,
): ReadingSummary {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('RECORDING_ELAPSED_INVALID');
  const groups = new Map<string, ObservationRecord[]>();
  for (const observation of observations) {
    const group = groups.get(observation.sessionId) ?? [];
    group.push(observation);
    groups.set(observation.sessionId, group);
  }
  const parts = [...groups.values()].map((group) => summariseReading(group, facts, policy));
  const seen = new Set(parts.flatMap((part) => part.seenBlocks));
  const seenBlocks = facts.blocks.filter((block) => seen.has(block.id)).map((block) => block.id);
  const seenWeight = facts.blocks.filter((block) => seen.has(block.id)).reduce((sum, block) => sum + block.weight, 0);
  const interactions = new Map(
    parts.flatMap((part) => part.interactions).map((x) => [`${x.blockId}\0${x.interaction}`, x]),
  );
  return {
    inputWatermark: Math.max(0, ...parts.map((p) => p.inputWatermark)),
    seenBlocks,
    seenWeight,
    totalWeight: facts.totalWeight,
    coverage: facts.totalWeight === 0 ? 0 : Math.min(1, seenWeight / facts.totalWeight),
    activeDwellMs: Math.floor(
      Math.min(
        elapsedMs,
        parts.reduce((sum, p) => sum + p.activeDwellMs, 0),
      ),
    ),
    estimatedReadingMs: facts.estimatedReadingMs,
    interactions: [...interactions.values()],
    coverageEvents: parts.reduce((sum, p) => sum + p.coverageEvents, 0),
    dwellEvents: parts.reduce((sum, p) => sum + p.dwellEvents, 0),
    instrumentationVersion: parts.length ? Math.min(...parts.map((p) => p.instrumentationVersion)) : 0,
    sequenceGaps: parts.reduce((sum, p) => sum + p.sequenceGaps, 0),
  };
}
