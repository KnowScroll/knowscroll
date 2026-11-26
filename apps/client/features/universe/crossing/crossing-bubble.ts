import { seededRandom, TAU } from '../space/paint';

/**
 * A universe seen from outside, as the crossing draws it: a soft halo and a web of small light. The product has no web
 * data for another person's universe, so the web is made from a seed (the person's id) alone: the same id gives the same bubble,
 * a few seeded filaments on a sphere seen from one side.
 */

/** The bubble is drawn in a square of this many units; the marks scale it to the radius they need. */
export const BUBBLE_SIZE = 180;

/** The three light colours of a warm bubble (the prototype's), by group. */
export const BUBBLE_COLOURS = ['#FFF3D6', '#FFC98A', '#F3B4F0'] as const;

/** Dots are this wide in bubble units. */
export const BUBBLE_DOT = 1.2;

/** Dots per colour group, and how many filaments they are spread over: a web about as busy as the prototype's. */
const DOTS_PER_GROUP = 270;
const FILAMENTS_PER_GROUP = 9;
/** How far from the centre the web reaches, as a share of the size. */
const REACH = 0.36;

/** One dot of the web, in bubble units from the square's top left, and which colour it takes. */
export interface BubbleDot {
  readonly x: number;
  readonly y: number;
  readonly colour: 0 | 1 | 2;
}

/** The points of one filament, seen from one side: an arc of a great circle from a random start, with a little jitter. */
function filamentPoints(random: () => number, count: number): readonly (readonly [number, number])[] {
  const theta = random() * TAU;
  const phi = Math.acos(2 * random() - 1);
  const start = [Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)] as const;
  const bearing = random() * TAU;
  const side = [-Math.sin(theta), Math.cos(theta), 0] as const;
  const up = [Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), -Math.sin(phi)] as const;
  const across = [0, 1, 2].map((axis) => Math.cos(bearing) * side[axis]! + Math.sin(bearing) * up[axis]!);
  const length = 0.6 + random() * 1.4;
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * length;
    const jitter = 0.05;
    const x = Math.cos(angle) * start[0] + Math.sin(angle) * across[0]! + (random() - 0.5) * jitter;
    const y = Math.cos(angle) * start[1] + Math.sin(angle) * across[1]! + (random() - 0.5) * jitter;
    points.push([x, y]);
  }
  return points;
}

/** The dots of the bubble for a seed (a person's id): deterministic, about three hundred. */
export function bubbleDots(seed: string): readonly BubbleDot[] {
  const random = seededRandom(`bubble:${seed}`);
  const dots: BubbleDot[] = [];
  for (const colour of [0, 1, 2] as const) {
    const perFilament = Math.round(DOTS_PER_GROUP / FILAMENTS_PER_GROUP);
    for (let filament = 0; filament < FILAMENTS_PER_GROUP; filament += 1) {
      for (const [x, y] of filamentPoints(random, perFilament)) {
        dots.push({
          x: BUBBLE_SIZE / 2 + x * BUBBLE_SIZE * REACH,
          y: BUBBLE_SIZE / 2 + y * BUBBLE_SIZE * REACH,
          colour,
        });
      }
    }
  }
  return dots;
}
