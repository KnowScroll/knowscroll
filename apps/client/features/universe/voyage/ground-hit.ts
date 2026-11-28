/**
 * What is under a point of the ground, as far as the "you are here" pill needs to know: the opened region there, or
 * nothing. The sea and land not reached yet both answer nothing, so the pill never names closed land and nothing here
 * says it is there or counts it (D-109). Pure and three-free: the driver turns a point of the screen into a point of the
 * globe's band, and this says which region's land the band point is in.
 */
import type { Chart, Loop } from '@knowscroll/scene-core';
import { BAND_WIDTH, bandYOfLatitude } from './world-texture';

/** A point of the unit sphere in the globe's own frame (`globe.ts`: x east, y north, z toward longitude 0). */
interface SpherePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The column and row of the band at a point of the globe: the inverse of `localPointOf`. The band is Mercator, wrapping
 * across, so the column is in [0, `BAND_WIDTH`); a point near a pole is held at the band's edge row.
 */
export function bandPointOf(point: SpherePoint): { readonly x: number; readonly y: number } {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  const longitude = Math.atan2(point.x, point.z);
  const latitude = Math.asin(Math.min(1, Math.max(-1, point.y / length)));
  return { x: ((longitude + Math.PI) / (2 * Math.PI)) * BAND_WIDTH, y: bandYOfLatitude(latitude) };
}

/** True when (`x`, `y`) is inside the shape of `loops`, by the even-odd rule (a lake or a hole is outside), as the land is filled. */
export function insideLoops(loops: readonly Loop[], x: number, y: number): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let at = 0, before = loop.length - 2; at < loop.length; before = at, at += 2) {
      const x1 = loop[at]!;
      const y1 = loop[at + 1]!;
      const x0 = loop[before]!;
      const y0 = loop[before + 1]!;
      if (y1 > y !== y0 > y && x < ((x0 - x1) * (y - y1)) / (y0 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}

/**
 * The opened region whose land holds the band point, or null: the sea, land not reached (a cell the chart does not
 * name), and a region that is not one of `named` (the regions the screen names: a friend's planet charts every site
 * under made-up ids and names none of them). A region that crosses the band's seam has loops past its edges, so the
 * point is tried a band's width either side too.
 */
export function regionAtBand(
  chart: Chart,
  named: ReadonlySet<string>,
  point: { readonly x: number; readonly y: number },
): string | null {
  for (const cell of chart.charted) {
    if (!named.has(cell.objectId)) continue;
    for (const shift of [0, BAND_WIDTH, -BAND_WIDTH])
      if (insideLoops(cell.loops, point.x + shift, point.y)) return cell.objectId;
  }
  return null;
}
