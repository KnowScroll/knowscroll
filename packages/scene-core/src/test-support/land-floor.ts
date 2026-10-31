import { describe, expect, it } from 'vitest';
import { PLANET_TYPES, buildGlobe, buildMap, type WorldSpec } from '../index.js';
import { areaOf } from '../world/contours.js';
import { MIN_CELL_AREA } from '../world/island.js';

/** Planets in one shard. Four shards run side by side, one test file each. */
const SHARD_SIZE = 600;

/** Synthetic CI planets: 1 to 32 sites, every type, four variants. */
export function floorSpec(n: number): WorldSpec {
  return {
    seed: (((n + 1000) * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(4),
    type: PLANET_TYPES[(n * 5) % PLANET_TYPES.length]!,
    variant: n % 4,
    siteCount: 1 + (n % 32),
  };
}

/**
 * Every site of every planet in the shard has more than `MIN_CELL_AREA` of land, in the map and in
 * the globe, and so has every decorative continent. A formed region is never drawn with no land.
 */
export function everySiteHasLand(shard: number): void {
  describe(`every site has land (planets ${shard * SHARD_SIZE} to ${(shard + 1) * SHARD_SIZE - 1})`, () => {
    it('in the map and in the globe, whatever the noise did', () => {
      for (let n = shard * SHARD_SIZE; n < (shard + 1) * SHARD_SIZE; n++) {
        const spec = floorSpec(n);
        for (const world of [buildMap(spec), buildGlobe(spec)]) {
          for (const cell of world.cells)
            expect(
              areaOf(cell.loops),
              `${world.kind} planet ${n} site ${cell.site} of ${spec.siteCount}`,
            ).toBeGreaterThan(MIN_CELL_AREA);
          for (const [index, decor] of world.decor.entries())
            expect(areaOf(decor.loops), `${world.kind} planet ${n} decoration ${index}`).toBeGreaterThan(MIN_CELL_AREA);
        }
      }
    }, 300_000);
  });
}
