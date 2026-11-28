import type { ChartedCell } from '@knowscroll/scene-core';
import { insideLoops } from '../ground-hit';
import { centreOfCell, distanceToEdge, type BandPoint } from '../region-centre';
import { BAND_WIDTH } from '../world-texture';

/**
 * Which formed region a tap on the flat map chooses. Pure, and over formed regions only: land not reached is not in
 * `cells`, so it is never a target and a tap on it, or on the sea, chooses nothing (D-109).
 *
 * A fingertip is wider than a small region and lands a little off, so a region is chosen by more than its own land: a
 * tap on land chooses that land's region; otherwise the nearest region wins when its reach, the land's edge or a
 * {@link MIN_TARGET}-wide target round the region's point (whichever is nearer), is within {@link NEAR_EDGE} of the tap.
 */

/** Every formed region can be chosen by a target at least this wide, in layout points (the screen's 44 pt target). */
export const MIN_TARGET = 44;
/** A tap this near a region's reach, in layout points, chooses it. */
export const NEAR_EDGE = 24;

/**
 * Whether a tap at `point` is on the land of `cell`, and if not how far it is from the cell's reach, in band units: the
 * nearer of the land's edge and the edge of the target (radius `targetRadius`) round the region's point. A region by
 * the seam has land a whole turn either side, so the tap is tried a band's width either side too.
 */
function reachOf(
  cell: ChartedCell,
  point: BandPoint,
  targetRadius: number,
): { readonly onLand: boolean; readonly distance: number } {
  const centre = centreOfCell(cell, BAND_WIDTH);
  let distance = Infinity;
  for (const shift of [0, BAND_WIDTH, -BAND_WIDTH]) {
    const x = point.x + shift;
    if (insideLoops(cell.loops, x, point.y)) return { onLand: true, distance: 0 };
    distance = Math.min(
      distance,
      distanceToEdge(cell.loops, x, point.y),
      Math.max(0, Math.hypot(x - centre.x, point.y - centre.y) - targetRadius),
    );
  }
  return { onLand: false, distance };
}

/**
 * The region a tap at `point` (band units) chooses on a drawing `scale` layout points to the band unit, or null. Land
 * under the tap wins over any target that merely reaches it; among targets the nearest wins, the first of two equally
 * near in the cells' order.
 */
export function regionAtMapPoint(cells: readonly ChartedCell[], point: BandPoint, scale: number): string | null {
  const targetRadius = MIN_TARGET / 2 / scale;
  const reach = NEAR_EDGE / scale;
  let best: { readonly id: string; readonly distance: number } | null = null;
  for (const cell of cells) {
    const found = reachOf(cell, point, targetRadius);
    if (found.onLand) return cell.objectId;
    if (found.distance <= reach && (best === null || found.distance < best.distance))
      best = { id: cell.objectId, distance: found.distance };
  }
  return best?.id ?? null;
}
