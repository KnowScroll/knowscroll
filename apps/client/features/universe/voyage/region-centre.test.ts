import { buildGlobe, chartWorld, type Loop } from '@knowscroll/scene-core';
import { regionCentre } from './region-centre';

/** A rectangle as a loop. */
const box = (x: number, y: number, width: number, height: number): Loop => [
  x,
  y,
  x + width,
  y,
  x + width,
  y + height,
  x,
  y + height,
];

/** Distance from a point to the nearest side of an axis-aligned rectangle it is inside. */
const depthInBox = (point: { x: number; y: number }, x: number, y: number, width: number, height: number) =>
  Math.min(point.x - x, x + width - point.x, point.y - y, y + height - point.y);

describe('the middle of a region', () => {
  it('is the middle of a plain shape, to within one cell of its grid', () => {
    const centre = regionCentre([box(10, 20, 40, 40)], { x: 0, y: 0 });
    const cell = 40 / 28;
    expect(Math.abs(centre.x - 30)).toBeLessThanOrEqual(cell);
    expect(Math.abs(centre.y - 40)).toBeLessThanOrEqual(cell);
  });

  it('stays on the land of a bent shape, away from its shore, where its centroid would fall in the sea', () => {
    // An L of land: its centroid (about 22, 22) lies in the notch, outside the land.
    const ell: Loop = [0, 0, 60, 0, 60, 15, 15, 15, 15, 60, 0, 60];
    const centre = regionCentre([ell], { x: 0, y: 0 });
    const onLand = (centre.y < 15 && centre.x < 60) || (centre.x < 15 && centre.y < 60);
    expect(onLand).toBe(true);
    const depth = Math.min(
      centre.y < 15 ? Math.min(centre.y, 15 - centre.y) : Infinity,
      centre.x < 15 ? Math.min(centre.x, 15 - centre.x) : Infinity,
    );
    expect(depth).toBeGreaterThan(7.5 * 0.35);
  });

  it('keeps out of a hole in the land', () => {
    const centre = regionCentre([box(0, 0, 60, 60), box(20, 20, 20, 20)], { x: 0, y: 0 });
    const inHole = centre.x > 20 && centre.x < 40 && centre.y > 20 && centre.y < 40;
    expect(inHole).toBe(false);
  });

  it('gives back the fallback when there is no land to stand on', () => {
    expect(regionCentre([], { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
    expect(regionCentre([[3, 3, 3, 3, 3, 3]], { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it('stands on its own land, well inside, for every formed region of real worlds', () => {
    for (const seed of ['1234567890abcdef1234567890abcdef', 'fedcba0987654321fedcba0987654321']) {
      for (const type of ['lush', 'ocean'] as const) {
        const world = buildGlobe({ seed, type, variant: 0, siteCount: 12 });
        const chart = chartWorld(
          world,
          world.cells.map((cell) => ({ objectId: `region-${String(cell.site)}`, site: cell.site })),
        );
        for (const cell of chart.charted) {
          if (cell.loops.length === 0) continue;
          const centre = regionCentre(cell.loops, cell.label);
          // On the region's land: the even-odd count of its loops' crossings to the left is odd.
          let crossings = 0;
          for (const loop of cell.loops)
            for (let a = 0, b = loop.length - 2; a < loop.length; b = a, a += 2)
              if (
                loop[a + 1]! > centre.y !== loop[b + 1]! > centre.y &&
                centre.x <
                  ((loop[b]! - loop[a]!) * (centre.y - loop[a + 1]!)) / (loop[b + 1]! - loop[a + 1]!) + loop[a]!
              )
                crossings += 1;
          expect(crossings % 2).toBe(1);
        }
      }
    }
  });

  it('is never deeper than the shape allows, and never on its edge', () => {
    const centre = regionCentre([box(0, 0, 100, 20)], { x: 0, y: 0 });
    expect(depthInBox(centre, 0, 0, 100, 20)).toBeGreaterThan(10 * 0.35);
  });
});
