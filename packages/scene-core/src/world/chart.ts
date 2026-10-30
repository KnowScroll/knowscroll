import type { Point } from '../types.js';
import type { Loop } from './contours.js';
import type { Veil, World } from './types.js';

/** A region that has formed, and the site its look gave it. */
export interface RegionSite {
  readonly objectId: string;
  readonly site: number;
}

/** A region's cell: the one kind of land that is named, counted and can be chosen. */
export interface ChartedCell {
  readonly objectId: string;
  readonly site: number;
  readonly loops: readonly Loop[];
  readonly label: Point;
}

/**
 * Land that is not reached yet. It is only outlines: no site, no name, no id and no count, so it
 * cannot be listed, searched, announced or chosen (D-078). Unformed sites and decorative
 * continents are mixed in one list and cannot be told apart.
 */
export interface UnreachedLand {
  readonly loops: readonly Loop[];
  readonly veil?: Veil;
}

export interface Chart {
  /** Formed regions, in site order. */
  readonly charted: readonly ChartedCell[];
  readonly unreached: readonly UnreachedLand[];
}

/**
 * Which land of a world is a formed region and which is not. A cell's shape and its name's place
 * come from the world alone, so forming a region changes nothing but which list that cell is in.
 * A region whose site is out of range, or one that another region already holds, is left out: it
 * stays in the person's lists but has no cell to draw.
 */
export function chartWorld(world: World, regions: readonly RegionSite[]): Chart {
  const claimed = new Map<number, string>();
  for (const { objectId, site } of regions)
    if (Number.isInteger(site) && site >= 0 && site < world.cells.length && !claimed.has(site))
      claimed.set(site, objectId);
  const charted: ChartedCell[] = [];
  const unreached: UnreachedLand[] = [];
  for (const cell of world.cells) {
    const objectId = claimed.get(cell.site);
    if (objectId !== undefined) charted.push({ objectId, site: cell.site, loops: cell.loops, label: cell.label });
    else unreached.push({ loops: cell.loops, ...(cell.veil ? { veil: cell.veil } : {}) });
  }
  for (const decor of world.decor) unreached.push({ loops: decor.loops, ...(decor.veil ? { veil: decor.veil } : {}) });
  return { charted, unreached };
}
