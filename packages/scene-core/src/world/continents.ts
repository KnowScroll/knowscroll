import { cosineSample, sineSample } from '../unit-circle.js';
import type { Point } from '../types.js';
import type { Stream } from './random.js';

/** A landmass before noise: an ellipse of a given size, turned by a unit vector (never an angle). */
export interface Continent {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly cos: number;
  readonly sin: number;
  readonly stretch: number;
}

export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The shortest signed difference along x when the world wraps every `period` units. */
export function wrapDelta(delta: number, period: number | undefined): number {
  return period === undefined ? delta : (((delta % period) + period * 1.5) % period) - period / 2;
}

export const distanceOf = (dx: number, dy: number): number => Math.sqrt(dx * dx + dy * dy);

function newContinent(stream: Stream, bounds: Bounds, size: number): Continent {
  const x = bounds.x0 + stream() * (bounds.x1 - bounds.x0);
  const y = bounds.y0 + stream() * (bounds.y1 - bounds.y0);
  const a = stream() * 2 - 1;
  const b = stream() * 2 - 1;
  const length = distanceOf(a, b);
  const stretch = 0.7 + stream() * 0.6;
  return length < 1e-6
    ? { x, y, size, cos: 1, sin: 0, stretch }
    : { x, y, size, cos: a / length, sin: b / length, stretch };
}

/** An even spread, for the rare world where random placement cannot find room for every continent. */
function evenly(sizes: readonly number[], bounds: Bounds): Continent[] {
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  const columns = Math.max(1, Math.round(Math.sqrt((sizes.length * width) / height)));
  const rows = Math.ceil(sizes.length / columns);
  return sizes.map((size, index) => ({
    x: bounds.x0 + (((index % columns) + 0.5) / columns) * width,
    y: bounds.y0 + ((Math.floor(index / columns) + 0.5) / rows) * height,
    size,
    cos: 1,
    sin: 0,
    stretch: 1,
  }));
}

/**
 * Places one continent for each size, none touching another, by rejection from the stream. Room is
 * loosened a step at a time when the sizes do not fit, then given up on for an even spread.
 */
export function placeContinents(
  stream: Stream,
  sizes: readonly number[],
  bounds: Bounds,
  period: number | undefined,
): Continent[] {
  for (let step = 0; step <= 6; step++) {
    const room = 1 - step * 0.1;
    const placed: Continent[] = [];
    for (let attempts = 0; placed.length < sizes.length && attempts < 3000; attempts++) {
      const size = sizes[placed.length] ?? 40;
      const candidate = newContinent(stream, bounds, size);
      const crowded = placed.some(
        (other) =>
          distanceOf(wrapDelta(other.x - candidate.x, period), other.y - candidate.y) < (other.size + size) * room,
      );
      if (!crowded) placed.push(candidate);
    }
    if (placed.length === sizes.length) return placed;
  }
  return evenly(sizes, bounds);
}

/** How far inside a continent's ellipse a point is: 1 at the centre, 0 on the edge, negative outside. */
export function bump(continent: Continent, x: number, y: number, period: number | undefined): number {
  const dx = wrapDelta(x - continent.x, period);
  const dy = y - continent.y;
  const u = (dx * continent.cos + dy * continent.sin) / (continent.size * continent.stretch);
  const v = (dy * continent.cos - dx * continent.sin) / (continent.size / continent.stretch);
  return 1 - distanceOf(u, v);
}

/**
 * `count` seeds round a continent, evenly spaced from a start on the pinned unit circle. One seed
 * sits at the middle. A seed is where one region's cell grows from.
 */
export function seedsOf(continent: Continent, count: number, start: number): Point[] {
  const reach = count > 1 ? continent.size * 0.45 : 0;
  return Array.from({ length: count }, (_, index) => {
    const step = start + Math.floor((index * 64) / count);
    return {
      x: continent.x + cosineSample(step) * reach * continent.stretch,
      y: continent.y + (sineSample(step) * reach) / continent.stretch,
    };
  });
}
