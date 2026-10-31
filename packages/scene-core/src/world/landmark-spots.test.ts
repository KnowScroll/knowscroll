import { describe, expect, it } from 'vitest';
import {
  MAX_LANDMARK_SPOTS,
  PLANET_TYPES,
  buildGlobe,
  buildMap,
  chartWorld,
  landmarkSpots,
  type PlanetType,
  type World,
  type WorldSpec,
} from '../index.js';

/** Synthetic CI seeds only: 32 hex characters, as a descriptor's seed is. */
const seedFor = (n: number): string => (((n + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(4);
const specFor = (n: number, type: PlanetType = PLANET_TYPES[n % PLANET_TYPES.length]!): WorldSpec => ({
  seed: seedFor(n),
  type,
  variant: n % 3,
  siteCount: 7,
});
const PLANETS = Array.from({ length: 16 }, (_, n) => specFor(n));

/** Three regions have formed, as on a planet that just formed. */
function chartOf(world: World) {
  return chartWorld(world, [
    { objectId: 'a', site: 0 },
    { objectId: 'b', site: 1 },
    { objectId: 'c', site: 2 },
  ]);
}
const spotsFor = (spec: WorldSpec, world: World, count: number) =>
  landmarkSpots(spec.seed, spec.variant, world, chartOf(world), count);

describe('where landmarks stand on a planet (D-089)', () => {
  it('puts the first landmark on land that has formed', () => {
    const inLoop = (loop: readonly number[], x: number, y: number) => {
      let within = false;
      for (let at = 0, last = loop.length - 2; at < loop.length; last = at, at += 2) {
        const [ax, ay, bx, by] = [loop[at]!, loop[at + 1]!, loop[last]!, loop[last + 1]!];
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
      }
      return within;
    };
    for (const spec of PLANETS) {
      for (const world of [buildGlobe(spec), buildMap(spec)]) {
        const chart = chartOf(world);
        const [first] = landmarkSpots(spec.seed, spec.variant, world, chart, 1);
        const onFormed = chart.charted.some(
          (cell) => cell.loops.filter((loop) => inLoop(loop, first!.x, first!.y)).length % 2 === 1,
        );
        expect(onFormed).toBe(true);
      }
    }
  });

  it('is the same for the same planet, and never moves a landmark when another is earned', () => {
    for (const spec of PLANETS) {
      for (const world of [buildGlobe(spec), buildMap(spec)]) {
        const six = spotsFor(spec, world, 6);
        expect(spotsFor(spec, world, 6)).toEqual(six);
        for (let count = 1; count <= 6; count++) expect(spotsFor(spec, world, count)).toEqual(six.slice(0, count));
      }
    }
  });

  it('stands on land, clear of every name and of each other', () => {
    for (const spec of PLANETS) {
      for (const world of [buildGlobe(spec), buildMap(spec)]) {
        const chart = chartOf(world);
        const spots = landmarkSpots(spec.seed, spec.variant, world, chart, 8);
        expect(spots.length).toBeGreaterThan(0);
        for (const spot of spots) {
          expect(spot.x).toBeGreaterThan(0);
          expect(spot.x).toBeLessThan(world.width);
          expect(spot.y).toBeGreaterThan(0);
          expect(spot.y).toBeLessThan(world.height);
          for (const name of chart.charted.map((cell) => cell.label))
            expect(Math.abs(name.x - spot.x) >= 56 || Math.abs(name.y - spot.y) >= 16).toBe(true);
        }
        spots.forEach((spot, index) =>
          spots.slice(index + 1).forEach((other) => {
            expect(Math.hypot(spot.x - other.x, spot.y - other.y)).toBeGreaterThanOrEqual(30);
          }),
        );
      }
    }
  });

  it('depends on the planet only: the finish of a landmark, or which regions have formed beyond the three, changes nothing about the world', () => {
    const spec = PLANETS[0]!;
    const globe = buildGlobe(spec);
    const before = JSON.stringify(globe);
    spotsFor(spec, globe, 5);
    expect(JSON.stringify(globe)).toBe(before);
  });

  it('draws nothing for none, and no more than the most it can paint', () => {
    const spec = PLANETS[1]!;
    const map = buildMap(spec);
    expect(spotsFor(spec, map, 0)).toEqual([]);
    expect(spotsFor(spec, map, -3)).toEqual([]);
    expect(spotsFor(spec, map, 500).length).toBeLessThanOrEqual(MAX_LANDMARK_SPOTS);
  });

  it('still finds land on a planet where no region has formed yet', () => {
    const spec = PLANETS[2]!;
    const map = buildMap(spec);
    expect(landmarkSpots(spec.seed, spec.variant, map, chartWorld(map, []), 2).length).toBeGreaterThan(0);
  });

  it('differs between planets', () => {
    const a = spotsFor(PLANETS[0]!, buildMap(PLANETS[0]!), 3);
    const b = spotsFor(PLANETS[3]!, buildMap(PLANETS[3]!), 3);
    expect(a).not.toEqual(b);
  });
});
