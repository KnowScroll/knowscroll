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
import { contours, makeGrid } from './contours.js';
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
      // The globe is a narrow band, so noise can swallow the odd small cell; a planet keeps nearly all of them.
      expect(globe.cells.filter((cell) => area(cell.loops) > 100).length).toBeGreaterThanOrEqual(spec.siteCount - 1);
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
