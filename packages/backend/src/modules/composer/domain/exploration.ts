import { uniformIndex } from './policy.js';
import type { PlayLevel } from './types.js';

/** Fixed order, so the draw is the same on every run. */
const LEVEL_ORDER: readonly PlayLevel[] = ['plain', 'stage', 'game'];

function levelsPresent<T>(pool: readonly T[], levelOf: (item: T) => PlayLevel): readonly PlayLevel[] {
  return LEVEL_ORDER.filter((level) => pool.some((item) => levelOf(item) === level));
}

/**
 * The exploration pick: a uniform draw from the pool, or, with `byPlayLevel`, a uniform draw of a play
 * level present in the pool and then of a candidate of that level, so a catalogue with few game Scrolls
 * still explores them (blueprint §9, exploration). `pool` is not empty.
 */
export function explorationPick<T>(
  pool: readonly T[],
  levelOf: (item: T) => PlayLevel,
  random: () => number,
  byPlayLevel: boolean,
): T {
  if (!byPlayLevel) return pool[uniformIndex(random, pool.length)]!;
  const levels = levelsPresent(pool, levelOf);
  const level = levels[uniformIndex(random, levels.length)]!;
  const members = pool.filter((item) => levelOf(item) === level);
  return members[uniformIndex(random, members.length)]!;
}

/**
 * How many equally likely outcomes {@link explorationPick} chooses between when it returns `item`: the
 * probability of `item`, given that the exploration branch ran, is one over this. An integer, so that the
 * recorded probability `fraction / outcomes` is the exact value policy v0 always recorded.
 */
export function explorationOutcomes<T>(
  pool: readonly T[],
  item: T,
  levelOf: (item: T) => PlayLevel,
  byPlayLevel: boolean,
): number {
  if (!byPlayLevel) return pool.length;
  const sameLevel = pool.filter((member) => levelOf(member) === levelOf(item)).length;
  return levelsPresent(pool, levelOf).length * sameLevel;
}
