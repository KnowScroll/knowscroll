/**
 * Where a region is named, where the camera comes down over it and where the ship stands on it: a point well inside
 * the region's land, near its middle. The generator's own label point (`WorldCell.label`) is placed to keep names
 * apart on the flat map and often sits on the shore or just outside its cell, so on the ground the camera came down
 * over the sea. The prototype (`Universe.dc.html`, `rg.c`) takes, of the points where the region's field is at least
 * 35% of its highest, the one nearest the field's centroid; here the field is the distance to the region's outline.
 *
 * Pure, and computed on the device from the chart, so `worldmap.v1` and what the server stores do not change.
 */
import type { ChartedCell, Loop } from '@knowscroll/scene-core';

/** A point in band units. */
export interface BandPoint {
  readonly x: number;
  readonly y: number;
}

/** The region's land is sampled on a grid this many cells across its longer side: fine enough for a name or a ship. */
const GRID = 20;
/** A sliver of land the grid misses is sampled again this many times finer. */
const FINER = 4;
/** Deep enough: at least this share of the deepest point's distance from the outline (the prototype's 35%). */
const DEEP_SHARE = 0.35;

/** Whether a point is inside the loops, by the even-odd rule: a hole cut in a region is not its land. */
function inside(loops: readonly Loop[], x: number, y: number): boolean {
  let crossings = 0;
  for (const loop of loops) {
    for (let a = 0, b = loop.length - 2; a < loop.length; b = a, a += 2) {
      const ay = loop[a + 1]!;
      const by = loop[b + 1]!;
      if (ay > y !== by > y && x < ((loop[b]! - loop[a]!) * (y - ay)) / (by - ay) + loop[a]!) crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

/** The distance from a point to the nearest edge of the loops. */
export function distanceToEdge(loops: readonly Loop[], x: number, y: number): number {
  let nearest = Infinity;
  for (const loop of loops) {
    for (let a = 0, b = loop.length - 2; a < loop.length; b = a, a += 2) {
      const ax = loop[b]!;
      const ay = loop[b + 1]!;
      const dx = loop[a]! - ax;
      const dy = loop[a + 1]! - ay;
      const length = dx * dx + dy * dy;
      const along = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
      nearest = Math.min(nearest, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)));
    }
  }
  return nearest;
}

/** The middle of a loop's points along x. */
const middleX = (loop: Loop): number => {
  let sum = 0;
  for (let at = 0; at < loop.length; at += 2) sum += loop[at]!;
  return sum / (loop.length / 2);
};

/**
 * One copy of a region's land on a band that wraps every `period` units: the loops within half a turn of `near`. The
 * generator draws land a little past both edges of the band, so a region by the seam comes as two copies a whole turn
 * apart; taken together they would make one wide, hollow shape whose middle is in neither.
 */
export function oneCopy(loops: readonly Loop[], near: number, period: number): Loop[] {
  return loops.filter((loop) => Math.abs(middleX(loop) - near) <= period / 2);
}

/**
 * The point to name and stand on in a region whose land is `loops` (see the top of this file), or `fallback` when the
 * loops hold no land the grid can find (an empty cell). Give `loops` as one copy of the land ({@link oneCopy}).
 */
export function regionCentre(loops: readonly Loop[], fallback: BandPoint): BandPoint {
  return deepMiddle(loops, GRID) ?? deepMiddle(loops, GRID * FINER) ?? fallback;
}

/** {@link regionCentre} on a grid of `grid` cells across the land's longer side; null when no grid point is on land. */
function deepMiddle(loops: readonly Loop[], grid: number): BandPoint | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops)
    for (let at = 0; at < loop.length; at += 2) {
      minX = Math.min(minX, loop[at]!);
      maxX = Math.max(maxX, loop[at]!);
      minY = Math.min(minY, loop[at + 1]!);
      maxY = Math.max(maxY, loop[at + 1]!);
    }
  if (!Number.isFinite(minX)) return null;
  const step = Math.max(maxX - minX, maxY - minY) / grid;
  if (step <= 0) return null;

  const points: { x: number; y: number; depth: number }[] = [];
  for (let y = minY + step / 2; y < maxY; y += step)
    for (let x = minX + step / 2; x < maxX; x += step)
      if (inside(loops, x, y)) points.push({ x, y, depth: distanceToEdge(loops, x, y) });
  if (points.length === 0) return null;

  const middle = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const deepest = Math.max(...points.map((point) => point.depth));
  let best = points[0]!;
  let bestDistance = Infinity;
  for (const point of points) {
    if (point.depth < deepest * DEEP_SHARE) continue;
    const distance = Math.hypot(point.x - middle.x, point.y - middle.y);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return { x: best.x, y: best.y };
}

/** Each region's point, worked out once: the stage's names and every texture painted for the planet ask for it. */
const centres = new WeakMap<ChartedCell, BandPoint>();

/**
 * {@link regionCentre} of a charted region, on a band of `period` units round, kept for as long as the chart is. The
 * point is on the copy of the land nearest the generator's label, so it may lie a little outside `0..period`.
 */
export function centreOfCell(cell: ChartedCell, period: number): BandPoint {
  const known = centres.get(cell);
  if (known) return known;
  const centre = regionCentre(oneCopy(cell.loops, cell.label.x, period), cell.label);
  centres.set(cell, centre);
  return centre;
}
