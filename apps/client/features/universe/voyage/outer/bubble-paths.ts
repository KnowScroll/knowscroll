import { BUBBLE_DOT, BUBBLE_SIZE, bubbleDots } from '../../crossing/crossing-bubble';

/**
 * The crossing bubble (`bubbleDots`: a web of about 810 dots for a seed) as three SVG paths, one for each light colour,
 * so the outer stop's field draws a bubble in three elements, not 810. The coordinates are in px from the bubble's
 * centre for a bubble whose outer edge (its halo) is `radius`, so the caller only moves it (a `transform`) and never
 * scales it: a dot stays a dot's width however small the bubble.
 */

/** A dot is never narrower than this on screen, however small the bubble (a 30 px bubble would make 0.4 px specks). */
const LEAST_DOT = 0.9;
/** Coordinates are rounded to this many decimals: one decimal is a tenth of a px, enough, and the paths stay short. */
const ROUND = 10;
const HALF = BUBBLE_SIZE / 2;

export interface BubblePaths {
  /** One `d` string for each of the three light colours of a bubble (the caller picks them: warm for a friend, cool for an unnamed one). */
  readonly paths: readonly [string, string, string];
  /** How wide a dot is, in px. */
  readonly dot: number;
}

const made = new Map<string, BubblePaths>();
/** The most bubbles kept; a field draws about eighteen, so this holds a few screens' worth. */
const KEPT = 96;

const round = (value: number): number => Math.round(value * ROUND) / ROUND;

/**
 * The paths of the bubble for `seed` at `radius` px. `every` keeps one dot in that many, for a small or far bubble that
 * needs fewer. The same arguments give the same strings, and a bubble made once is kept.
 */
export function bubblePaths(seed: string, radius: number, every = 1): BubblePaths {
  const key = `${seed}|${radius}|${every}`;
  const kept = made.get(key);
  if (kept !== undefined) return kept;
  const scale = radius / HALF;
  const dot = Math.max(BUBBLE_DOT * scale, LEAST_DOT);
  const parts: [string[], string[], string[]] = [[], [], []];
  bubbleDots(seed).forEach((point, index) => {
    if (index % every !== 0) return;
    const x = round((point.x - HALF) * scale - dot / 2);
    const y = round((point.y - HALF) * scale - dot / 2);
    parts[point.colour].push(`M${x} ${y}h${round(dot)}v${round(dot)}h${-round(dot)}z`);
  });
  const result: BubblePaths = {
    paths: [parts[0].join(''), parts[1].join(''), parts[2].join('')],
    dot: round(dot),
  };
  if (made.size >= KEPT) made.delete(made.keys().next().value!);
  made.set(key, result);
  return result;
}
