import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLANET_TYPES,
  SceneParseError,
  WORLD_GENERATOR_VERSION,
  buildGlobe,
  buildMap,
  chartWorld,
  type Chart,
  type GlobeWorld,
  type Loop,
  type MapWorld,
  type PlanetType,
  type WorldSpec,
} from '../index.js';
import { cosineSample, sineSample } from '../unit-circle.js';
import { areaOf, contours, makeGrid } from './contours.js';
import { MIN_CELL_AREA, stampIsland } from './island.js';
import { createNoise } from './noise.js';
import { worldStream } from './random.js';

/** Synthetic CI seeds only: 32 hex characters, as a descriptor's seed is. */
const seedFor = (n: number): string => (((n + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(4);
const specFor = (n: number, siteCount = 7, type: PlanetType = PLANET_TYPES[n % PLANET_TYPES.length]!): WorldSpec => ({
  seed: seedFor(n),
  type,
  variant: n % 3,
  siteCount,
});

/** Twenty-four planets: every type, a few variants, the site counts a real planet has (3 or 4 facets, plus 4 spare). */
const PLANETS = Array.from({ length: 24 }, (_, n) => specFor(n, n % 2 === 0 ? 7 : 8));

const area = (loops: readonly Loop[]): number =>
  loops.reduce((sum, loop) => {
    let twice = 0;
    for (let at = 0; at < loop.length; at += 2) {
      const next = (at + 2) % loop.length;
      twice += (loop[at] ?? 0) * (loop[next + 1] ?? 0) - (loop[next] ?? 0) * (loop[at + 1] ?? 0);
    }
    return sum + Math.abs(twice) / 2;
  }, 0);

function digest(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0;
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`;
}

const regionsAt = (sites: readonly number[]) => sites.map((site) => ({ objectId: `region-${site}`, site }));

describe('the world generator is pinned (worldmap.v1)', () => {
  it('names its version, and the same planets give the same numbers', () => {
    const pins: [WorldSpec, string, string][] = [
      [
        { seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 7 },
        '2bb273ea:104009',
        'ca8c43cb:173770',
      ],
      [
        { seed: 'fedcba0987654321fedcba0987654321', type: 'ocean', variant: 2, siteCount: 8 },
        '7f784109:88191',
        'c378b804:130701',
      ],
      [
        { seed: '1234567890abcdef1234567890abcdef', type: 'gas', variant: 1, siteCount: 5 },
        '7fbc2af5:100107',
        '1a8fef04:135852',
      ],
      // The planet whose site 1 had no land on the globe: its island is stamped, and pinned with the rest.
      [
        { seed: 'eb957a5642872ae16bfd0c5647ed8331', type: 'lush', variant: 2, siteCount: 7 },
        'f195e69a:106086',
        '1ff01ac4:103748',
      ],
    ];
    for (const [spec, map, globe] of pins) {
      expect(digest(buildMap(spec))).toBe(map);
      expect(digest(buildGlobe(spec))).toBe(globe);
    }
    expect(buildMap(PLANETS[0]!).generator).toBe(WORLD_GENERATOR_VERSION);
  });

  it('pins literal coordinates, so a changed digest says what moved', () => {
    const spec: WorldSpec = { seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 7 };
    const map = buildMap(spec);
    expect(map.cells[0]?.label).toEqual({ x: 50, y: 298 });
    expect(map.cells[0]?.loops[0]?.slice(0, 6)).toEqual([78.9, 174.5, 79.6, 173.4, 80.4, 173.4]);
    const globe = buildGlobe(spec);
    expect(globe.cells[0]?.label).toEqual({ x: 372, y: 159.1 });
    expect(globe.cells[0]?.loops[0]?.slice(0, 6)).toEqual([395.2, 127.6, 395.7, 126.8, 396.4, 126.8]);
    const stamped = buildGlobe({ seed: 'eb957a5642872ae16bfd0c5647ed8331', type: 'lush', variant: 2, siteCount: 7 });
    expect(stamped.cells[1]?.label).toEqual({ x: 266.3, y: 173.9 });
    expect(stamped.cells[1]?.loops[0]?.slice(0, 6)).toEqual([278.7, 175.6, 278.1, 176.7, 277.4, 177.8]);
  });

  it('uses no engine-dependent maths: no trigonometry, power, logarithm, hypotenuse or randomness', () => {
    const banned =
      /Math\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|hypot|pow|exp|expm1|log|log1p|log2|log10|cbrt|random)\b|\*\*|Date\.|performance\./;
    const files = readdirSync(new URL('.', import.meta.url)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toContain('build-world.ts');
    for (const name of files) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(source.match(banned), name).toBeNull();
    }
    const circle = readFileSync(new URL('../unit-circle.ts', import.meta.url), 'utf8');
    expect(circle.replaceAll(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/Math\.(sin|cos)/);
  });

  it('turns by the pinned unit circle: sixty-four samples, exact quarters, any integer wraps', () => {
    expect(sineSample(0)).toBe(0);
    expect(sineSample(16)).toBe(1);
    expect(sineSample(32)).toBe(0);
    expect(sineSample(48)).toBe(-1);
    expect(sineSample(64)).toBe(0);
    expect(sineSample(-16)).toBe(-1);
    expect(sineSample(80)).toBe(sineSample(16));
    expect(cosineSample(0)).toBe(1);
    expect(cosineSample(16)).toBe(0);
    for (let step = 0; step < 64; step++)
      expect(cosineSample(step) * cosineSample(step) + sineSample(step) * sineSample(step)).toBeCloseTo(1, 12);
  });
});

describe('the pieces', () => {
  it('draws the same pseudo-random numbers for a seed, tag and variant, and different ones otherwise', () => {
    const first = Array.from({ length: 4 }, worldStream('a'.repeat(32), 'map', 0));
    expect(Array.from({ length: 4 }, worldStream('a'.repeat(32), 'map', 0))).toEqual(first);
    expect(Array.from({ length: 4 }, worldStream('a'.repeat(32), 'globe', 0))).not.toEqual(first);
    expect(Array.from({ length: 4 }, worldStream('a'.repeat(32), 'map', 1))).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('makes noise that stays near [-1, 1] and wraps without a seam when asked to', () => {
    const plain = createNoise(worldStream('n'.repeat(32), 'noise', 0));
    const wrapped = createNoise(worldStream('n'.repeat(32), 'noise', 0), 480);
    let reach = 0;
    for (let x = -100; x < 600; x += 7)
      for (let y = 0; y < 360; y += 11) {
        reach = Math.max(reach, Math.abs(plain.at(x, y, 30, 2)));
        for (const size of [110, 60, 22, 8]) {
          expect(wrapped.at(x, y, size, 3.3)).toBeCloseTo(wrapped.at(x + 480, y, size, 3.3), 9);
          expect(wrapped.at(x, y, size, 3.3)).toBeCloseTo(wrapped.at(x - 480, y, size, 3.3), 9);
        }
      }
    expect(reach).toBeGreaterThan(0.4);
    expect(reach).toBeLessThanOrEqual(1.5);
  });

  it('joins marching squares into closed loops, rounds them and keeps the grid border dry', () => {
    const grid = makeGrid(0, 0, 40, 40, 2, (x, y) => 9 - Math.sqrt((x - 20) * (x - 20) + (y - 20) * (y - 20)));
    const loops = contours(grid, 0, 1);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    expect(loop.length).toBeGreaterThanOrEqual(24);
    const xs = loop.filter((_, at) => at % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThan(10);
    expect(Math.max(...xs)).toBeLessThan(30);
    expect(area(loops)).toBeGreaterThan(200);
    expect(area(loops)).toBeLessThan(300);
    // The border counts as below the level, so a field that is high everywhere still closes inside the grid.
    expect(contours(makeGrid(0, 0, 20, 20, 2, () => 5))[0]?.every((value) => value >= 0 && value <= 20)).toBe(true);
    // A chequerboard is all saddle squares: each one is joined one way or the other, and the shapes close.
    const chequer = makeGrid(0, 0, 48, 48, 2, (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 3 : -3));
    expect(contours(chequer, 0, 1).length).toBeGreaterThan(3);
  });
});

describe('a planet', () => {
  it.each([
    ['no seed', { ...specFor(1), seed: '' }],
    ['a seed that is not a string', { ...specFor(1), seed: 7 as unknown as string }],
    ['no sites', { ...specFor(1), siteCount: 0 }],
    ['more sites than a planet can hold', { ...specFor(1), siteCount: 33 }],
    ['a fractional site count', { ...specFor(1), siteCount: 7.5 }],
    ['a negative variant', { ...specFor(1), variant: -1 }],
  ])('refuses %s, for both drawings', (_name, spec) => {
    expect(() => buildMap(spec)).toThrow(SceneParseError);
    expect(() => buildGlobe(spec)).toThrow(SceneParseError);
  });

  it('is laid out from its seed, variant, type and sites alone, and a change to any of them is a different world', () => {
    const base = specFor(5);
    const same = JSON.stringify(buildMap(base));
    expect(JSON.stringify(buildMap({ ...base }))).toBe(same);
    expect(JSON.stringify(buildMap({ ...base, seed: seedFor(6) }))).not.toBe(same);
    expect(JSON.stringify(buildMap({ ...base, variant: base.variant + 1 }))).not.toBe(same);
    expect(JSON.stringify(buildMap({ ...base, type: base.type === 'ocean' ? 'lush' : 'ocean' }))).not.toBe(same);
    expect(JSON.stringify(buildMap({ ...base, siteCount: base.siteCount + 1 }))).not.toBe(same);
  });

  it.each(PLANETS.map((spec, n) => [n, spec] as const))(
    'gives every site a cell and every decorative continent a shape (planet %i)',
    (_n, spec) => {
      const map = buildMap(spec);
      expect(map.cells.map((cell) => cell.site)).toEqual(Array.from({ length: spec.siteCount }, (_, site) => site));
      expect(map.decor.length).toBeGreaterThanOrEqual(1);
      expect(map.decor.length).toBeLessThanOrEqual(3);
      for (const cell of map.cells) expect(area(cell.loops), `map site ${cell.site}`).toBeGreaterThan(300);
      for (const decor of map.decor) expect(area(decor.loops)).toBeGreaterThan(300);
      for (const cell of map.cells) {
        expect(Number.isFinite(cell.label.x) && Number.isFinite(cell.label.y)).toBe(true);
        expect(cell.label.x).toBeGreaterThan(-30);
        expect(cell.label.x).toBeLessThan(420);
        expect(cell.label.y).toBeGreaterThan(-30);
        expect(cell.label.y).toBeLessThan(880);
        expect(cell.veil).toBeDefined();
      }
      const globe = buildGlobe(spec);
      expect(globe.cells).toHaveLength(spec.siteCount);
      for (const cell of globe.cells)
        expect(area(cell.loops), `globe site ${cell.site}`).toBeGreaterThan(MIN_CELL_AREA);
      for (const cell of globe.cells) {
        expect(cell.label.x).toBeGreaterThanOrEqual(0);
        expect(cell.label.x).toBeLessThan(480);
      }
      for (const loop of [...globe.land, ...globe.clouds.body]) {
        expect(loop.length % 2).toBe(0);
        expect(loop.every((value) => Number.isFinite(value))).toBe(true);
      }
      expect(globe.cells.every((cell) => cell.veil === undefined)).toBe(true);
    },
  );

  it('keeps the names apart whatever they are, using only where the cells are', () => {
    for (const spec of PLANETS) {
      const { cells } = buildMap(spec);
      for (const first of cells)
        for (const second of cells) {
          if (first.site >= second.site) continue;
          const across = Math.abs(first.label.x - second.label.x);
          const down = Math.abs(first.label.y - second.label.y);
          expect(across >= 120 || down >= 20, `${spec.seed} sites ${first.site} and ${second.site}`).toBe(true);
        }
    }
  });

  it('still draws a world of 32 sites, with finite numbers, though its cells are small', () => {
    for (const type of ['lush', 'ocean'] as const) {
      const map = buildMap({ ...specFor(3), type, siteCount: 32 });
      expect(map.cells).toHaveLength(32);
      expect(map.land.length).toBeGreaterThan(0);
      expect(map.cells.every((cell) => Number.isFinite(cell.label.x))).toBe(true);
    }
  });
});

describe('land at every site', () => {
  it('gives a formed region land even where noise left it none: the planet that had an empty cell', () => {
    const spec: WorldSpec = { seed: 'eb957a5642872ae16bfd0c5647ed8331', type: 'lush', variant: 2, siteCount: 7 };
    const globe = buildGlobe(spec);
    for (const cell of globe.cells) expect(area(cell.loops), `site ${cell.site}`).toBeGreaterThan(MIN_CELL_AREA);
    // The island of a site that had no land is part of the coast, so it has a shore and is drawn with the rest.
    const stamped = globe.cells[1]!;
    expect(stamped.loops.length).toBeGreaterThan(0);
    expect(
      stamped.loops.every((loop) => globe.land.some((coast) => JSON.stringify(coast) === JSON.stringify(loop))),
    ).toBe(true);
    expect(areaOf(globe.shallowWide)).toBeGreaterThan(areaOf(globe.shallow));
    expect(areaOf(globe.shallow)).toBeGreaterThan(areaOf(globe.land) - 1);
  });

  it('is stamped from the planet alone: the same island every time, and none depends on another cell', () => {
    const spec: WorldSpec = { seed: 'eb957a5642872ae16bfd0c5647ed8331', type: 'lush', variant: 2, siteCount: 7 };
    expect(JSON.stringify(buildGlobe(spec).cells[1])).toBe(JSON.stringify(buildGlobe(spec).cells[1]));
    const chart = chartWorld(buildGlobe(spec), regionsAt([1]));
    expect(chart.charted[0]?.loops).toEqual(buildGlobe(spec).cells[1]?.loops);
  });

  it('makes an island of more than the floor from any stream, round a point on the band, and repeats it over the seam', () => {
    for (let n = 0; n < 200; n++) {
      const stream = worldStream(seedFor(n), 'island', 0);
      const centre = { x: (n * 37) % 480, y: 100 + ((n * 11) % 160) };
      const island = stampIsland(stream, centre, 480);
      expect(areaOf(island.land.slice(0, 1))).toBeGreaterThan(MIN_CELL_AREA);
      expect(areaOf(island.shallowWide.slice(0, 1))).toBeGreaterThan(areaOf(island.shallow.slice(0, 1)));
      expect(areaOf(island.shallow.slice(0, 1))).toBeGreaterThan(areaOf(island.land.slice(0, 1)));
      const reach = island.land.flatMap((loop) => loop.filter((_, at) => at % 2 === 0));
      // Past an edge of the band, another copy a turn away puts the rest of the island at the other edge.
      const flat = stampIsland(worldStream(seedFor(n), 'island', 0), centre, undefined).land[0]!.filter(
        (_, at) => at % 2 === 0,
      );
      const crosses = Math.min(...flat) < 0 || Math.max(...flat) > 480;
      expect(island.land).toHaveLength(crosses ? 2 : 1);
      expect(Math.max(...reach)).toBeGreaterThan(0);
      expect(Math.min(...reach)).toBeLessThan(480);
    }
    // Without a band it is one island, wherever it is.
    expect(stampIsland(worldStream('f'.repeat(32), 'island', 0), { x: 3, y: 4 }, undefined).land).toHaveLength(1);
  });

  it('is the same on every call and different for different streams', () => {
    const at = { x: 200, y: 200 };
    const one = stampIsland(worldStream('a'.repeat(32), 'island', 0), at, undefined);
    expect(JSON.stringify(stampIsland(worldStream('a'.repeat(32), 'island', 0), at, undefined))).toBe(
      JSON.stringify(one),
    );
    expect(JSON.stringify(stampIsland(worldStream('b'.repeat(32), 'island', 0), at, undefined))).not.toBe(
      JSON.stringify(one),
    );
  });
});

describe('charting a world: which land is a formed region (D-078)', () => {
  const spec = specFor(9, 7, 'lush');
  const map = buildMap(spec);
  const globe = buildGlobe(spec);

  it('names a formed region by its site and keeps every other cell grey, in site order', () => {
    const chart = chartWorld(map, [
      { objectId: 'b', site: 2 },
      { objectId: 'a', site: 0 },
    ]);
    expect(chart.charted.map((cell) => [cell.objectId, cell.site])).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
    expect(chart.charted[0]?.loops).toBe(map.cells[0]?.loops);
    expect(chart.unreached).toHaveLength(map.cells.length - 2 + map.decor.length);
  });

  it('leaves out a region whose site is out of range, fractional or already held, so it has no cell to draw', () => {
    const chart = chartWorld(map, [
      { objectId: 'a', site: 1 },
      { objectId: 'late', site: 1 },
      { objectId: 'far', site: 99 },
      { objectId: 'negative', site: -1 },
      { objectId: 'half', site: 1.5 },
    ]);
    expect(chart.charted.map((cell) => cell.objectId)).toEqual(['a']);
  });

  it('adding a region leaves every other border and label bit-identical, over many planets and orders', () => {
    for (const planet of PLANETS) {
      for (const world of [buildMap(planet), buildGlobe(planet)] as (MapWorld | GlobeWorld)[]) {
        const sites = Array.from({ length: planet.siteCount }, (_, site) => site);
        const order = [...sites].sort(
          (a, b) => ((a * 7 + planet.variant * 3) % 11) - ((b * 7 + planet.variant * 3) % 11) || a - b,
        );
        const formed: number[] = [];
        let previous: Chart = chartWorld(world, []);
        expect(previous.charted).toEqual([]);
        for (const site of order.slice(0, 4)) {
          formed.push(site);
          const next = chartWorld(world, regionsAt(formed));
          for (const cell of previous.charted) {
            const same = next.charted.find((candidate) => candidate.objectId === cell.objectId)!;
            // Compared as text, not by reference: nothing about it may differ, down to the last digit.
            expect(JSON.stringify(same)).toBe(JSON.stringify(cell));
          }
          expect(next.charted).toHaveLength(previous.charted.length + 1);
          previous = next;
        }
        // The same regions formed in the opposite order give the same cells.
        const reversed = chartWorld(world, regionsAt([...formed].reverse()));
        expect(JSON.stringify(reversed.charted)).toBe(JSON.stringify(previous.charted));
      }
    }
  });

  it('would notice a border that moved: the comparison above fails for a world built from another number of sites', () => {
    const other = buildMap({ ...spec, siteCount: 12 });
    const moved = other.cells
      .slice(0, 7)
      .filter((cell, site) => JSON.stringify(cell) !== JSON.stringify(map.cells[site]));
    expect(moved.length).toBeGreaterThan(0);
  });

  it('never gives unreached land an id, a site, a name or a count, and never as many shapes as there are unformed sites', () => {
    for (const planet of PLANETS) {
      const world = buildMap(planet);
      for (let formed = 0; formed <= planet.siteCount; formed++) {
        const chart = chartWorld(world, regionsAt(Array.from({ length: formed }, (_, site) => site)));
        const unformed = planet.siteCount - formed;
        for (const land of chart.unreached)
          expect(Object.keys(land).every((key) => key === 'loops' || key === 'veil')).toBe(true);
        expect(JSON.stringify(chart.unreached)).not.toMatch(/region-|objectId|site|label|name|count/);
        // Decorative grey continents are always there, so the grey on screen is never the unformed count.
        expect(chart.unreached.length).toBeGreaterThan(unformed);
        expect(chart.unreached.length - unformed).toBe(world.decor.length);
      }
    }
  });

  it('draws the globe from the same cells; the chart marks nothing as not reached for it to paint grey', () => {
    const chart = chartWorld(globe, regionsAt([0, 1]));
    expect(chart.charted.map((cell) => cell.site)).toEqual([0, 1]);
    expect(globe.cells).toHaveLength(7);
    expect(globe.decor.length).toBeGreaterThanOrEqual(1);
  });
});
