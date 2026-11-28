import { buildGlobe, chartWorld, type Chart, type GlobeWorld } from '@knowscroll/scene-core';
import { bandPointOf, regionAtBand } from './ground-hit';
import { localPointOf } from './globe';
import { BAND_HEIGHT, BAND_WIDTH, bandYOfLatitude, labelPoints } from './world-texture';

const SPEC = { seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 } as const;
const FORMED = [0, 2, 3, 5, 8];
const world: GlobeWorld = buildGlobe(SPEC);
const chart: Chart = chartWorld(
  world,
  FORMED.map((site) => ({ objectId: `region-${site}`, site })),
);
const named = new Set(chart.charted.map((cell) => cell.objectId));

describe('a point of the globe, on the band', () => {
  it('is the inverse of where the globe puts a band point', () => {
    for (const [x, latitude] of [
      [0, 0],
      [120, 0.4],
      [333.5, -0.7],
      [479, 1.1],
    ] as const) {
      const back = bandPointOf(localPointOf(x, latitude));
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(bandYOfLatitude(latitude), 6);
    }
  });

  it('keeps a point near a pole inside the band', () => {
    const top = bandPointOf({ x: 0, y: 1, z: 0 });
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(top.y).toBeLessThanOrEqual(BAND_HEIGHT);
    expect(top.x).toBeGreaterThanOrEqual(0);
    expect(top.x).toBeLessThan(BAND_WIDTH);
  });
});

describe('the opened region under a point of the ground', () => {
  it('names each opened region at the point its name stands on', () => {
    for (const label of labelPoints(chart)) {
      const at = bandPointOf(localPointOf(label.x, label.lat));
      expect(regionAtBand(chart, named, at)).toBe(label.objectId);
    }
  });

  it('names nothing at a point of land not reached, which the chart holds only as outlines', () => {
    let unreachedLand = 0;
    const formed = new Set(FORMED);
    for (const cell of world.cells) {
      if (formed.has(cell.site)) continue;
      // The same land with its region formed would be named there: it is land, here left unreached.
      const asRegion = chartWorld(world, [{ objectId: 'closed', site: cell.site }]);
      const at = { x: cell.label.x, y: cell.label.y };
      if (regionAtBand(asRegion, new Set(['closed']), at) !== 'closed') continue;
      unreachedLand += 1;
      const result = regionAtBand(chart, named, at);
      // Where an opened region's own land overlaps it the opened region is named; anywhere else, nothing.
      if (result !== null) expect(named.has(result)).toBe(true);
      else expect(result).toBeNull();
    }
    expect(unreachedLand).toBeGreaterThan(0);
    // With no region formed at all, no point of any land is named, whatever the screen is told it may name.
    const none = chartWorld(world, []);
    for (const cell of world.cells)
      expect(regionAtBand(none, new Set(chart.charted.map((c) => c.objectId)), cell.label)).toBeNull();
  });

  it('names nothing over the sea', () => {
    expect(regionAtBand(chart, named, { x: -50, y: -50 })).toBeNull();
    expect(regionAtBand(chart, named, { x: BAND_WIDTH / 2, y: -10 })).toBeNull();
  });

  it('names only the regions the screen names: a friend’s planet charts every site under made-up ids', () => {
    const label = labelPoints(chart)[0]!;
    const at = bandPointOf(localPointOf(label.x, label.lat));
    expect(regionAtBand(chart, new Set(), at)).toBeNull();
    expect(regionAtBand(chart, new Set(['another-region']), at)).toBeNull();
  });

  it('finds a region across the band’s seam, where its loops run past the edge', () => {
    const cell = chart.charted[0]!;
    const shifted: Chart = {
      charted: [
        {
          ...cell,
          loops: cell.loops.map((loop) => loop.map((value, at) => (at % 2 === 0 ? value - BAND_WIDTH : value))),
        },
      ],
      unreached: [],
    };
    const label = labelPoints(chart)[0]!;
    expect(regionAtBand(shifted, named, { x: label.x, y: bandPointOf(localPointOf(label.x, label.lat)).y })).toBe(
      cell.objectId,
    );
  });
});
