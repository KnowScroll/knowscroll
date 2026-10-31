import { uniformIndex } from './policy.js';
import type { PlayLevel } from './types.js';

/** Fixed order, so the draw is the same on every run. */
const LEVEL_ORDER: readonly PlayLevel[] = ['plain', 'stage', 'game'];

/** What the draw needs to know of a pool member. */
export interface ExplorationMember {
  readonly kind: 'reel' | 'scroll';
  readonly level: PlayLevel;
}

const levelsPresent = (scrolls: readonly ExplorationMember[]): readonly PlayLevel[] =>
  LEVEL_ORDER.filter((level) => scrolls.some((member) => member.level === level));

/**
 * The exploration pick: a uniform draw from the pool (policy v0). With `byPlayLevel` (v1) a member is drawn
 * uniformly as before and, only when it is a Scroll, replaced by a draw of a play level present among the pool's
 * Scrolls and then of a Scroll of that level. So a catalogue with few game Scrolls still explores them, while the
 * share of Reels and Scrolls stays what the pool holds: a Reel has no play, is not a play level, and is never
 * pooled with the plain Scrolls, so Reel and Scroll keep equal status (D-190). `pool` is not empty.
 */
export function explorationPick<T extends ExplorationMember>(
  pool: readonly T[],
  random: () => number,
  byPlayLevel: boolean,
): T {
  const drawn = pool[uniformIndex(random, pool.length)]!;
  if (!byPlayLevel || drawn.kind !== 'scroll') return drawn;
  const scrolls = pool.filter((member) => member.kind === 'scroll');
  const levels = levelsPresent(scrolls);
  const level = levels[uniformIndex(random, levels.length)]!;
  const sameLevel = scrolls.filter((member) => member.level === level);
  return sameLevel[uniformIndex(random, sameLevel.length)]!;
}

/** The probability that {@link explorationPick} returns `item`, given that the exploration branch ran. */
export function explorationShare<T extends ExplorationMember>(
  pool: readonly T[],
  item: T,
  byPlayLevel: boolean,
): number {
  if (!byPlayLevel || item.kind !== 'scroll') return 1 / pool.length;
  const scrolls = pool.filter((member) => member.kind === 'scroll');
  const sameLevel = scrolls.filter((member) => member.level === item.level).length;
  return scrolls.length / pool.length / levelsPresent(scrolls).length / sameLevel;
}

/**
 * The part of an offer's probability that comes from the exploration branch (epsilon times its share). Policy v0
 * records exactly `epsilon / pool size`, as it always did, so a stored v0 decision replays byte for byte.
 */
export function explorationMass<T extends ExplorationMember>(
  fraction: number,
  pool: readonly T[],
  item: T,
  byPlayLevel: boolean,
): number {
  return byPlayLevel ? fraction * explorationShare(pool, item, true) : fraction / pool.length;
}
