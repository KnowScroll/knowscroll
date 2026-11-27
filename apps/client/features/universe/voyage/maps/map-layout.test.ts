import { breakpointFor } from '@knowscroll/design-tokens';
import { buildGlobe, chartWorld, type ChartedCell, type WorldSpec } from '@knowscroll/scene-core';
import { SAMPLE_SEED, SAMPLE_SITE_COUNT, seamSiteOf } from '../../../gallery/maps-gallery-fixtures';
import { centreOfCell } from '../region-centre';
import { BAND_HEIGHT, BAND_WIDTH } from '../world-texture';
import {
  BAND_ASPECT,
  clipsOf,
  columnsFor,
  copiesOf,
  cropOf,
  fitBox,
  DESKTOP_GUTTER,
  FRAME,
  GUTTER,
  layoutOf,
  LIST_WIDTH,
  nameSpots,
  PHONE_COLUMN,
  pointOnScreen,
  STACK_GAP,
  WHOLE_BAND,
} from './map-layout';

const spec: WorldSpec = { seed: SAMPLE_SEED, type: 'lush', variant: 0, siteCount: SAMPLE_SITE_COUNT };
const world = buildGlobe(spec);
const seamSite = seamSiteOf(spec)!;
const chartOf = (sites: readonly number[]) =>
  chartWorld(
    world,
    sites.map((site) => ({ objectId: `region-${site}`, site })),
  );
const cellOf = (sites: readonly number[], site: number): ChartedCell =>
  chartOf(sites).charted.find((cell) => cell.site === site)!;

describe('fitting the drawing', () => {
  it('takes the largest drawing of the band’s own aspect that fits', () => {
    expect(fitBox({ width: 400, height: 1000 }, BAND_ASPECT)).toEqual({ width: 400, height: 300 });
    expect(fitBox({ width: 1000, height: 300 }, BAND_ASPECT)).toEqual({ width: 400, height: 300 });
    expect(fitBox({ width: -5, height: 300 }, BAND_ASPECT)).toEqual({ width: 0, height: 0 });
  });

  it('is one column on a phone and a tablet, as wide as the screen less its gutters and the card’s frame', () => {
    const phone = layoutOf({ width: 390, height: 844 }, 1);
    expect(phone.columns).toBe(1);
    expect(phone.drawing.width).toBe(390 - 2 * GUTTER - FRAME);
    expect(phone.drawing.height).toBe(Math.floor(phone.drawing.width / BAND_ASPECT));
    expect(phone.listWidth).toBeNull();
    // The smallest phone still fits.
    expect(layoutOf({ width: 320, height: 568 }, 1).drawing.width).toBe(320 - 2 * GUTTER - FRAME);
  });

  it('leaves the drawing what the measured header leaves: the whole column always fits the window', () => {
    for (const window of [
      { width: 1440, height: 900 },
      { width: 1024, height: 700 },
      { width: 1280, height: 600 },
    ])
      for (const header of [110, 150, 190, 260]) {
        const { drawing } = layoutOf(window, 2, BAND_ASPECT, header);
        // The column's two paddings, the header, the gap, and the card with its frame.
        expect(2 * DESKTOP_GUTTER + header + STACK_GAP + drawing.height + FRAME).toBeLessThanOrEqual(window.height);
        expect(drawing.width + FRAME + DESKTOP_GUTTER * 3 + LIST_WIDTH).toBeLessThanOrEqual(window.width);
      }
    // A taller header leaves a smaller drawing.
    expect(layoutOf({ width: 1440, height: 900 }, 2, BAND_ASPECT, 220).drawing.height).toBeLessThan(
      layoutOf({ width: 1440, height: 900 }, 2, BAND_ASPECT, 120).drawing.height,
    );
  });

  it('keeps a tablet’s column at 640 points', () => {
    expect(layoutOf({ width: 820, height: 1180 }, 1).drawing.width).toBe(PHONE_COLUMN);
  });

  it('puts the list beside the drawing from 1024 px and fits the drawing to the height as well as the width', () => {
    expect(columnsFor(breakpointFor(1023))).toBe(1);
    expect(columnsFor(breakpointFor(1024))).toBe(2);
    const wide = layoutOf({ width: 1440, height: 900 }, 2);
    expect(wide.listWidth).toBe(LIST_WIDTH);
    expect(wide.drawing.height).toBeLessThan(900);
    expect(wide.drawing.width / wide.drawing.height).toBeCloseTo(BAND_ASPECT, 1);
    expect(wide.drawing.width + LIST_WIDTH).toBeLessThan(1440);
    // A short, wide window is limited by its height; a tall, narrow one by its width.
    const short = layoutOf({ width: 1440, height: 500 }, 2);
    expect(short.drawing.height).toBeLessThan(wide.drawing.height);
    const narrow = layoutOf({ width: 1024, height: 1400 }, 2);
    expect(narrow.drawing.width).toBeLessThan(1024 - LIST_WIDTH);
  });
});

describe('a region’s own crop', () => {
  it('is round the region, at the drawing’s aspect, inside the band, for a region away from the seam', () => {
    const cell = cellOf([0, 1, 2, 3], 0);
    const box = cropOf(cell);
    expect(box.width / box.height).toBeCloseTo(BAND_ASPECT, 5);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(BAND_WIDTH);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(BAND_HEIGHT);
    const centre = centreOfCell(cell, BAND_WIDTH);
    expect(centre.x).toBeGreaterThan(box.x);
    expect(centre.x).toBeLessThan(box.x + box.width);
    expect(centre.y).toBeGreaterThan(box.y);
    expect(centre.y).toBeLessThan(box.y + box.height);
    expect(copiesOf(box)).toEqual([0]);
  });

  it('follows the aspect it is asked for', () => {
    const cell = cellOf([0, 1, 2, 3], 1);
    for (const aspect of [1, 1.6, 2.2]) {
      const box = cropOf(cell, aspect);
      expect(box.width / box.height).toBeCloseTo(aspect, 5);
    }
  });

  it('keeps a region by the seam whole: its box runs past the band’s edge, and the band is drawn again beside it', () => {
    const cell = cellOf([0, 1, 2, seamSite], seamSite);
    const box = cropOf(cell);
    expect(box.x < 0 || box.x + box.width > BAND_WIDTH).toBe(true);
    expect(box.width).toBeLessThanOrEqual(BAND_WIDTH);
    // The region's own point, which may lie past the edge too, is inside the box: the region is not cut in two.
    const centre = centreOfCell(cell, BAND_WIDTH);
    expect(centre.x).toBeGreaterThan(box.x);
    expect(centre.x).toBeLessThan(box.x + box.width);
    const turns = copiesOf(box);
    expect(turns.length).toBeGreaterThan(1);
    expect([...turns].sort((a, b) => a - b)).toEqual(turns);
  });

  it('gives a region with no land the whole band', () => {
    const empty: ChartedCell = { objectId: 'none', site: 0, loops: [], label: { x: 10, y: 10 } };
    expect(cropOf(empty)).toEqual(WHOLE_BAND);
  });

  it('never asks for more than one turn or the band’s height', () => {
    // A very wide aspect would need more than a turn: the box stops at the band.
    const box = cropOf(cellOf([0, 1, 2, 3], 0), 6);
    expect(box.width).toBeLessThanOrEqual(BAND_WIDTH);
    expect(box.height).toBeLessThanOrEqual(BAND_HEIGHT);
  });
});

describe('the turns of the band to draw', () => {
  it('is the one band for the whole of it, and one more either side for a box over the seam', () => {
    expect(copiesOf(WHOLE_BAND)).toEqual([0]);
    expect(copiesOf({ x: -30, y: 0, width: 120, height: 90 })).toEqual([-1, 0]);
    expect(copiesOf({ x: 430, y: 0, width: 120, height: 90 })).toEqual([0, 1]);
    expect(copiesOf({ x: -60, y: 0, width: 600, height: 90 })).toEqual([-1, 0, 1]);
  });
});

describe('how the turns of the band share a box', () => {
  const scale = 0.75;
  const seamBox = { x: 322.4, y: 0, width: 300.7, height: 225 };

  it('gives the whole band to one turn', () => {
    expect(clipsOf(WHOLE_BAND, scale)).toEqual([{ turn: 0, left: 0, right: 480 }]);
  });

  it('tiles the box: each stretch starts where the one before ends, with no gap and no overlap', () => {
    const clips = clipsOf(seamBox, scale);
    expect(clips.map((clip) => clip.turn)).toEqual(copiesOf(seamBox));
    expect(clips[0]!.left).toBe(seamBox.x);
    expect(clips.at(-1)!.right).toBeCloseTo(seamBox.x + seamBox.width, 9);
    for (const [at, clip] of clips.entries()) if (at > 0) expect(clip.left).toBe(clips[at - 1]!.right);
  });

  it('meets on a whole point of the drawing, within a point of the band’s edge, so no pixel is half in two clips', () => {
    const clips = clipsOf(seamBox, scale);
    expect(clips.length).toBeGreaterThan(1);
    for (const clip of clips.slice(1)) {
      const onScreen = (clip.left - seamBox.x) * scale;
      expect(onScreen).toBeCloseTo(Math.round(onScreen), 9);
      expect(Math.abs(clip.left - clip.turn * BAND_WIDTH)).toBeLessThanOrEqual(1 / scale);
    }
  });

  it('keeps every stretch inside the land a turn has: 60 units past its band either side', () => {
    for (const box of [seamBox, { x: -40, y: 0, width: 250, height: 188 }, { x: 300, y: 0, width: 600, height: 450 }])
      for (const clip of clipsOf(box, 1.3)) {
        expect(clip.left).toBeGreaterThanOrEqual(clip.turn * BAND_WIDTH - 60);
        expect(clip.right).toBeLessThanOrEqual(clip.turn * BAND_WIDTH + BAND_WIDTH + 60);
      }
  });
});

describe('where a point is on the drawing', () => {
  it('scales the box to the size', () => {
    expect(pointOnScreen({ x: 240, y: 180 }, WHOLE_BAND, { width: 240, height: 180 })).toEqual({ x: 120, y: 90 });
    expect(pointOnScreen({ x: 5, y: 10 }, { x: 0, y: 0, width: 10, height: 20 }, { width: 100, height: 100 })).toEqual({
      x: 50,
      y: 50,
    });
    expect(pointOnScreen({ x: -10, y: 0 }, { x: -20, y: 0, width: 40, height: 40 }, { width: 80, height: 80 })).toEqual(
      {
        x: 20,
        y: 0,
      },
    );
  });
});

describe('where names go on the whole band', () => {
  const sites = Array.from({ length: 12 }, (_, site) => site);
  const names = new Map(sites.map((site) => [`region-${site}`, `Sample region ${site + 1}`]));

  it('names only formed regions, each once, and never one on another', () => {
    const chart = chartOf(sites);
    const { names: spots } = nameSpots(chart.charted, names, 12 / 0.75);
    expect(spots.length).toBeGreaterThan(0);
    expect(new Set(spots.map((spot) => spot.objectId)).size).toBe(spots.length);
    for (const spot of spots) expect(names.has(spot.objectId)).toBe(true);
    for (const [at, spot] of spots.entries())
      for (const other of spots.slice(at + 1))
        expect(
          Math.abs(spot.x - other.x) < (spot.width + other.width) / 2 &&
            Math.abs(spot.y - other.y) < (spot.height + other.height) / 2,
        ).toBe(false);
  });

  it('keeps every name inside the band', () => {
    for (const spot of nameSpots(chartOf(sites).charted, names, 16).names) {
      expect(spot.x - spot.width / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(spot.x + spot.width / 2).toBeLessThanOrEqual(BAND_WIDTH + 1e-9);
      expect(spot.y - spot.height / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(spot.y + spot.height / 2).toBeLessThanOrEqual(BAND_HEIGHT + 1e-9);
    }
  });

  it('names every region when the type is small enough and leaves out what cannot fit, never moving an earlier name for a later one', () => {
    const chart = chartOf([0, 1, 2, 3]);
    expect(nameSpots(chart.charted, names, 6).names).toHaveLength(4);
    // A giant type fits fewer, and the ones kept are the earliest regions.
    const crowded = nameSpots(chartOf(sites).charted, names, 40).names;
    expect(crowded.length).toBeLessThan(sites.length);
    expect(crowded[0]!.objectId).toBe('region-0');
    // Same input, same answer.
    expect(nameSpots(chart.charted, names, 16)).toEqual(nameSpots(chart.charted, names, 16));
  });

  it('writes no name for a region without one', () => {
    expect(
      nameSpots(chartOf([0, 1]).charted, new Map([['region-1', 'Only one']]), 16).names.map((spot) => spot.objectId),
    ).toEqual(['region-1']);
  });
  describe('the dot of "you were here"', () => {
    const fontUnits = 12 / 0.75;
    const markerUnits = 26 / 0.75;
    const here = (objectId: string) => ({ objectId, markerUnits });

    it('is placed with the names: just above its own name, and covering no other name', () => {
      for (const target of [0, 1, 2, 3]) {
        const plan = nameSpots(chartOf([0, 1, 2, 3]).charted, names, fontUnits, here(`region-${target}`));
        expect(plan.marker).not.toBeNull();
        const own = plan.names.find((spot) => spot.objectId === `region-${target}`);
        if (own !== undefined) {
          expect(plan.marker!.x).toBeCloseTo(own.x, 9);
          expect(plan.marker!.y).toBeLessThan(own.y);
          // The dot's lower edge is the name's upper edge: stacked, not overlapping.
          expect(plan.marker!.y + markerUnits / 2).toBeLessThanOrEqual(own.y - own.height / 2 + 1e-9);
        }
        for (const spot of plan.names.filter((other) => other.objectId !== `region-${target}`))
          expect(
            Math.abs(plan.marker!.x - spot.x) < (markerUnits + spot.width) / 2 &&
              Math.abs(plan.marker!.y - spot.y) < (markerUnits + spot.height) / 2,
          ).toBe(false);
      }
    });

    it('keeps the dot and every name inside the band, and no name on another', () => {
      const plan = nameSpots(chartOf(sites).charted, names, fontUnits, here('region-4'));
      expect(plan.marker!.x - markerUnits / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(plan.marker!.x + markerUnits / 2).toBeLessThanOrEqual(BAND_WIDTH + 1e-9);
      expect(plan.marker!.y - markerUnits / 2).toBeGreaterThanOrEqual(-1e-9);
      for (const [at, spot] of plan.names.entries())
        for (const other of plan.names.slice(at + 1))
          expect(
            Math.abs(spot.x - other.x) < (spot.width + other.width) / 2 &&
              Math.abs(spot.y - other.y) < (spot.height + other.height) / 2,
          ).toBe(false);
    });

    it('puts the region you were here first, so the others make way for it and never it for them', () => {
      const without = nameSpots(chartOf(sites).charted, names, fontUnits).names;
      const wearing = nameSpots(chartOf(sites).charted, names, fontUnits, here('region-6'));
      // Its name is where it would be with nothing else around, whatever the others are.
      expect(wearing.names.find((spot) => spot.objectId === 'region-6')).toBeDefined();
      expect(wearing.marker).not.toBeNull();
      // Making room for it can only cost the others their names, never give them new ones.
      expect(wearing.names.length).toBeLessThanOrEqual(without.length + 1);
    });

    it('has no dot for a region that has not formed, or when none is asked for', () => {
      expect(nameSpots(chartOf([0, 1]).charted, names, fontUnits, here('region-9')).marker).toBeNull();
      expect(nameSpots(chartOf([0, 1]).charted, names, fontUnits).marker).toBeNull();
    });
  });
});
