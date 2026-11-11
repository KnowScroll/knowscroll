import { createHash } from 'node:crypto';

/**
 * A small seeded random source (mulberry32). Every choice a persona makes and every identifier the
 * lab invents comes from one of these, so a run with the same seed and the same code makes the same
 * moves. The Composer's own randomness is seeded from the command ID, so seeded command IDs make its
 * decisions repeatable too.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** A float in [min, max). */
  between(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A copy of `items` in a seeded random order. */
  shuffle<T>(items: readonly T[]): T[];
  /** A version-4 shaped UUID drawn from this source. */
  uuid(): string;
  /** An independent source whose seed is derived from this one's seed and `label`. */
  fork(label: string): Rng;
}

export function seedFrom(...parts: readonly (string | number)[]): number {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  return digest.readUInt32LE(0);
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    between: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('SIM_RNG_PICK_FROM_EMPTY');
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
    uuid: () => {
      const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16));
      hex[12] = '4';
      hex[16] = (8 + Math.floor(next() * 4)).toString(16);
      const text = hex.join('');
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    },
    fork: (label) => createRng(seedFrom(String(state), label)),
  };
  return rng;
}
