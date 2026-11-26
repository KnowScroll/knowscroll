import { buildGlobe, chartWorld, type Loop } from '@knowscroll/scene-core';
import { centreOfCell, oneCopy, regionCentre } from './region-centre';

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

/** Even-odd: whether a point is on the land of the loops. */
function insideLoops(loops: readonly Loop[], point: { x: number; y: number }): boolean {
  let crossings = 0;
  for (const loop of loops)
    for (let a = 0, b = loop.length - 2; a < loop.length; b = a, a += 2)
      if (
        loop[a + 1]! > point.y !== loop[b + 1]! > point.y &&
        point.x < ((loop[b]! - loop[a]!) * (point.y - loop[a + 1]!)) / (loop[b + 1]! - loop[a + 1]!) + loop[a]!
      )
        crossings += 1;
  return crossings % 2 === 1;
}

/** Distance from a point to the nearest edge of the loops. */
function depthIn(loops: readonly Loop[], point: { x: number; y: number }): number {
  let nearest = Infinity;
  for (const loop of loops)
    for (let a = 0, b = loop.length - 2; a < loop.length; b = a, a += 2) {
      const [ax, ay, dx, dy] = [loop[b]!, loop[b + 1]!, loop[a]! - loop[b]!, loop[a + 1]! - loop[b + 1]!];
      const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      nearest = Math.min(nearest, Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy)));
    }
  return nearest;
}

/** The deepest point of the land on a grid of 0.5 band units. */
function deepestOf(loops: readonly Loop[]): number {
  const xs = loops.flatMap((loop) => loop.filter((_, at) => at % 2 === 0));
  const ys = loops.flatMap((loop) => loop.filter((_, at) => at % 2 === 1));
  let deepest = 0;
  for (let y = Math.min(...ys); y < Math.max(...ys); y += 0.5)
    for (let x = Math.min(...xs); x < Math.max(...xs); x += 0.5)
      if (insideLoops(loops, { x, y })) deepest = Math.max(deepest, depthIn(loops, { x, y }));
  return deepest;
}

describe('the middle of a region', () => {
  it('is the middle of a plain shape, to within one cell of its grid', () => {
    const centre = regionCentre([box(10, 20, 40, 40)], { x: 0, y: 0 });
    const cell = 40 / 20;
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

  it('takes one copy of land the band draws twice by its seam, the one by the label', () => {
    // The same island a whole turn apart, as the generator draws land past both edges of the band.
    const island = box(414, 100, 26, 30);
    const copy = island.map((value, at) => (at % 2 === 0 ? value - 480 : value));
    expect(oneCopy([island, copy], 416, 480)).toEqual([island]);
    const centre = regionCentre(oneCopy([island, copy], 416, 480), { x: 416, y: 173 });
    expect(depthInBox(centre, 414, 100, 26, 30)).toBeGreaterThan(13 * 0.35);
  });

  it('stands on its own land, well inside, for every formed region of real worlds, by the seam too', () => {
    const seeds = Array.from({ length: 12 }, (_, n) => n.toString(16).padStart(2, '0').repeat(16));
    for (const seed of seeds) {
      for (const type of ['lush', 'ocean'] as const) {
        const world = buildGlobe({ seed, type, variant: 0, siteCount: 12 });
        const chart = chartWorld(
          world,
          world.cells.map((cell) => ({ objectId: `region-${String(cell.site)}`, site: cell.site })),
        );
        for (const cell of chart.charted) {
          const land = oneCopy(cell.loops, cell.label.x, 480);
          if (land.length === 0) continue;
          const centre = centreOfCell(cell, 480);
          expect(insideLoops(land, centre)).toBe(true);
          // Deep enough by the prototype's rule, against the deepest point a fine grid finds (with a grid's slack).
          expect(depthIn(land, centre)).toBeGreaterThan(0.3 * deepestOf(land));
        }
      }
    }
  });

  it('is never deeper than the shape allows, and never on its edge', () => {
    const centre = regionCentre([box(0, 0, 100, 20)], { x: 0, y: 0 });
    expect(depthInBox(centre, 0, 0, 100, 20)).toBeGreaterThan(10 * 0.35);
  });
});
