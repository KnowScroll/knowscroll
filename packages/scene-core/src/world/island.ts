import { cosineSample, sineSample } from '../unit-circle.js';
import type { Point } from '../types.js';
import { roundOff, type Loop } from './contours.js';
import type { Stream } from './random.js';

/**
 * Land a region is guaranteed. Noise can leave a site's cell with no land, or a speck, so a cell with
 * less than this many square units of land is given an island of its own on its site (D-108).
 */
export const MIN_CELL_AREA = 150;

/** An island on a site: its land, and the shallow water round it in the two widths the coasts use. */
export interface Island {
  readonly land: readonly Loop[];
  readonly shallow: readonly Loop[];
  readonly shallowWide: readonly Loop[];
}

const CORNERS = 16;
/** Half the circle is 32 of the unit circle's 64 samples, so a corner every four samples makes sixteen. */
const SAMPLES_PER_CORNER = 64 / CORNERS;

/**
 * A rounded island round `centre`, of seed-driven radius between 12 and 15 units (over 400 square units,
 * well above `MIN_CELL_AREA`) and a coastline a little uneven. It uses only the planet's own stream and
 * the pinned unit circle, so it is the same on every engine and never depends on which regions have formed.
 * On a wrapping band the island is repeated a turn either side where it crosses the seam.
 */
export function stampIsland(stream: Stream, centre: Point, period: number | undefined): Island {
  const radius = 12 + stream() * 3;
  const unevenness = Array.from({ length: CORNERS }, () => 0.85 + stream() * 0.3);
  const x = period === undefined ? centre.x : ((centre.x % period) + period) % period;
  const loopAt = (grow: number): Loop => {
    const corners: number[] = [];
    for (let corner = 0; corner < CORNERS; corner++) {
      const turn = corner * SAMPLES_PER_CORNER;
      const reach = (radius + grow) * (unevenness[corner] ?? 1);
      corners.push(x + cosineSample(turn) * reach, centre.y + sineSample(turn) * reach);
    }
    return roundOff(corners, 2);
  };
  const repeated = (loop: Loop): Loop[] => {
    if (period === undefined) return [loop];
    const copies: Loop[] = [];
    for (const shift of [-period, 0, period]) {
      const moved =
        shift === 0 ? loop : loop.map((value, at) => (at % 2 === 0 ? Math.round((value + shift) * 10) / 10 : value));
      const across = moved.filter((_, at) => at % 2 === 0);
      if (Math.max(...across) > 0 && Math.min(...across) < period) copies.push(moved);
    }
    return copies;
  };
  return { land: repeated(loopAt(0)), shallow: repeated(loopAt(3)), shallowWide: repeated(loopAt(7)) };
}
