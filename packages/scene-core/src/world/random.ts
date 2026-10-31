import { seedState } from '../seed.js';

/** A stream of numbers in [0, 1). */
export type Stream = () => number;

/**
 * One pinned stream for a planet's world: Mulberry32 over the FNV state of the seed, a purpose tag
 * and the planet's variant. Integer maths only, so the stream is identical on every engine. A tag
 * keeps one purpose (the continents, the grain of the sea, the clouds) from changing another.
 */
export function worldStream(seed: string, tag: string, variant: number): Stream {
  let state = seedState(`${seed}|${tag}|${variant}`);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
