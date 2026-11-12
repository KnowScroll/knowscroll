import { sql, type Kysely } from 'kysely';
import type { InteractionEvent } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { dwell, event, type OpenedFixture } from '../support/observations.js';
import { recordPlayback } from '../support/reel-playback.js';
import type { LibraryReel, LibraryScroll } from './library.js';
import type { Rng } from './rng.js';

/**
 * How a person meets one encounter. Each kind is a pattern of what the recorder would report, with
 * timings drawn from the document's own reading facts (a Scroll's estimated reading time and block
 * weights, a Reel's duration), never from a constant.
 *
 * - `read`: the whole document at a natural pace (0.85 to 1.3 of the estimate); a Reel from start to finish, as a player
 *   plays it (starting a few hundred milliseconds in, the last report short of the end). Qualifies, and proves its facet.
 * - `nearly`: a Reel watched for 85 to 95% of its length and then left. Qualifies (q is at least 0.6), but the closing
 *   segment, which the primary facet needs, is not met: no facet is proved and nothing forms from it. A Scroll read is `read`.
 * - `partial`: the first fifth to two fifths. Not qualified.
 * - `skim`: one to three blocks (a Reel: two to four seconds), a few seconds. Not qualified.
 * - `idle`: the tab is left on one stop for one to three hours with the first screen visible. The
 *   coverage stays below half, so it does not qualify however long it stays.
 * - `none`: opened, activated and left at once: no observation is reported.
 */
export type ReadingKind = 'read' | 'nearly' | 'partial' | 'skim' | 'idle' | 'none';

export interface ReadingResult {
  /** The events the recorder would report. Empty for `none`. */
  readonly events: readonly InteractionEvent[];
  /** How long the person was on the encounter, so intake bounds its claims against a real activation time. */
  readonly elapsedMs: number;
  /** What the evidence rules should conclude. The lab asserts the product's answer against this expectation. */
  readonly expectQualified: boolean;
  /**
   * Whether the reading met what the unit's facet needs, so a coverage reference must exist for it and the unit counts
   * toward a system and a planet. A Scroll proves its facet exactly when it qualifies (it was read through); a Reel only
   * when it was watched to its end.
   */
  readonly provesFacet: boolean;
}

const SECOND = 1000;

/** Blocks in reading order whose cumulative weight share stays within `fraction` (at least one block). */
function leadingBlocks(scroll: LibraryScroll, fraction: number) {
  const limit = scroll.totalWeight * fraction;
  const chosen: LibraryScroll['blocks'][number][] = [];
  let sum = 0;
  for (const block of scroll.blocks) {
    if (chosen.length > 0 && sum + block.weight > limit) break;
    chosen.push(block);
    sum += block.weight;
  }
  return chosen;
}

/** Each block visible for its weight's share of `totalMs`, back to back. */
function blockIntervals(scroll: LibraryScroll, blocks: LibraryScroll['blocks'], totalMs: number) {
  const weight = blocks.reduce((sum, block) => sum + block.weight, 0);
  let from = 0;
  return blocks.map((block) => {
    const length = Math.max(600, Math.round((block.weight / weight) * totalMs));
    const interval: [number, number] = [from, from + length];
    from += length;
    return { block, interval };
  });
}

function coverageEvents(
  exposure: OpenedFixture,
  sessionId: string,
  intervals: ReturnType<typeof blockIntervals>,
): InteractionEvent[] {
  // One coverage event carries at most 24 blocks; the recorder sends the rest in the next one.
  const events: InteractionEvent[] = [];
  for (let start = 0; start < intervals.length; start += 24) {
    const slice = intervals.slice(start, start + 24);
    events.push(
      event(
        exposure,
        {
          kind: 'scroll.block_coverage',
          payload: {
            blocks: slice.map(({ block, interval }) => ({
              blockId: block.id,
              intervalsMs: [interval],
              peakFraction: 1,
            })),
          },
        },
        { sessionId },
      ),
    );
  }
  return events;
}

export function scrollReading(
  exposure: OpenedFixture,
  sessionId: string,
  scroll: LibraryScroll,
  kind: ReadingKind,
  rng: Rng,
): ReadingResult {
  if (kind === 'none')
    return { events: [], elapsedMs: rng.int(1, 3) * SECOND, expectQualified: false, provesFacet: false };
  if (kind === 'read' || kind === 'nearly') {
    const totalMs = Math.round(scroll.estimatedReadingMs * rng.between(0.85, 1.3));
    const intervals = blockIntervals(scroll, scroll.blocks, totalMs);
    const end = intervals[intervals.length - 1]!.interval[1];
    return {
      events: [...coverageEvents(exposure, sessionId, intervals), event(exposure, dwell([0, end]), { sessionId })],
      elapsedMs: end + 3 * SECOND,
      expectQualified: true,
      provesFacet: true,
    };
  }
  if (kind === 'partial') {
    const blocks = leadingBlocks(scroll, rng.between(0.2, 0.4));
    const totalMs = Math.round(scroll.estimatedReadingMs * rng.between(0.2, 0.4));
    const intervals = blockIntervals(scroll, blocks, totalMs);
    const end = intervals[intervals.length - 1]!.interval[1];
    return {
      events: [...coverageEvents(exposure, sessionId, intervals), event(exposure, dwell([0, end]), { sessionId })],
      elapsedMs: end + 3 * SECOND,
      expectQualified: false,
      provesFacet: false,
    };
  }
  if (kind === 'skim') {
    const blocks = scroll.blocks.slice(0, rng.int(1, 3));
    const intervals = blockIntervals(scroll, blocks, rng.int(2, 6) * SECOND);
    const end = intervals[intervals.length - 1]!.interval[1];
    return {
      events: [...coverageEvents(exposure, sessionId, intervals), event(exposure, dwell([0, end]), { sessionId })],
      elapsedMs: end + 2 * SECOND,
      expectQualified: false,
      provesFacet: false,
    };
  }
  // idle: the first screen stays visible while the person is away.
  const idleMs = rng.int(60, 180) * 60 * SECOND;
  const blocks = leadingBlocks(scroll, 0.25);
  const intervals = blocks.map((block) => ({ block, interval: [0, idleMs] as [number, number] }));
  return {
    events: [...coverageEvents(exposure, sessionId, intervals), event(exposure, dwell([0, idleMs]), { sessionId })],
    elapsedMs: idleMs + 3 * SECOND,
    expectQualified: false,
    provesFacet: false,
  };
}

/**
 * A viewer's Reel, as the app's own recorder reports it from a player's jittered ticks (`recordPlayback`): the same events,
 * gaps and offsets the intake receives from a client, never hand-written samples.
 */
export async function reelReading(
  exposure: OpenedFixture,
  sessionId: string,
  reel: LibraryReel,
  kind: ReadingKind,
  rng: Rng,
): Promise<ReadingResult> {
  if (kind === 'none')
    return { events: [], elapsedMs: rng.int(1, 3) * SECOND, expectQualified: false, provesFacet: false };
  const duration = reel.durationMs;
  // A Reel left on a stop plays on loop; the recorder reports no unique media beyond the first pass.
  const played =
    kind === 'read'
      ? duration
      : kind === 'nearly'
        ? Math.round(duration * rng.between(0.85, 0.95))
        : kind === 'partial'
          ? Math.round(duration * rng.between(0.2, 0.4))
          : kind === 'idle'
            ? Math.round(duration * 0.3)
            : rng.int(2, 4) * SECOND;
  const playback = await recordPlayback(exposure, {
    durationMs: duration,
    spans: [[0, played]],
    random: rng,
    sessionId,
  });
  const elapsedMs = (kind === 'idle' ? rng.int(60, 180) * 60 * SECOND : playback.elapsedMs) + 3 * SECOND;
  return {
    events: playback.events,
    elapsedMs,
    expectQualified: kind === 'read' || kind === 'nearly',
    provesFacet: kind === 'read',
  };
}

/**
 * Pretends the exposure was activated `elapsedMs` ago (and opened a second before), so the honest claims of that
 * much time are within the wall time the intake bounds them by. The clock is real; only the stored activation moves,
 * as in the other integration tests. It serves the first recording generation: a later generation's recorder session
 * is bounded by its own immutable start, so a person who has resumed can only claim the time that really passed.
 */
export async function activatedMsAgo(db: Kysely<Database>, exposureId: string, elapsedMs: number): Promise<void> {
  const seconds = Math.ceil(elapsedMs / SECOND);
  await sql`update experience.exposures
    set opened_at = now() - make_interval(secs => ${seconds + 1}), activated_at = now() - make_interval(secs => ${seconds})
    where id = ${exposureId}::uuid`.execute(db);
}
