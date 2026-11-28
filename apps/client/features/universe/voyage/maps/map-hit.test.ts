import { buildGlobe, chartWorld, type ChartedCell, type Loop } from '@knowscroll/scene-core';
import { BAND_WIDTH } from '../world-texture';
import { centreOfCell } from '../region-centre';
import { MIN_TARGET, NEAR_EDGE, regionAtMapPoint } from './map-hit';

/** A square cell `side` band units across, centred on (`x`, `y`), as a region of its own. */
function square(objectId: string, x: number, y: number, side: number): ChartedCell {
  const half = side / 2;
  const loop: Loop = [x - half, y - half, x + half, y - half, x + half, y + half, x - half, y + half];
  return { objectId, site: 0, loops: [loop], label: { x, y } };
}

describe('which region a tap on the flat map chooses', () => {
  it('chooses the region whose land is under the tap', () => {
    const cells = [square('a', 100, 100, 40), square('b', 300, 100, 40)];
    expect(regionAtMapPoint(cells, { x: 110, y: 95 }, 1)).toBe('a');
    expect(regionAtMapPoint(cells, { x: 295, y: 105 }, 1)).toBe('b');
  });

  it('gives a region smaller than a fingertip a target of at least 44 points, and no more than the 24 round it', () => {
    // A 6-unit speck of land at 1 point to the unit: its target is 22 points out from its point.
    const cells = [square('speck', 100, 100, 6)];
    expect(regionAtMapPoint(cells, { x: 100 + MIN_TARGET / 2 - 1, y: 100 }, 1)).toBe('speck');
    // ... and the nearest wins within 24 points of the target's edge.
    expect(regionAtMapPoint(cells, { x: 100 + MIN_TARGET / 2 + NEAR_EDGE - 1, y: 100 }, 1)).toBe('speck');
    expect(regionAtMapPoint(cells, { x: 100 + MIN_TARGET / 2 + NEAR_EDGE + 1, y: 100 }, 1)).toBeNull();
    expect(regionAtMapPoint(cells, { x: 100, y: 100 - MIN_TARGET / 2 - NEAR_EDGE - 1 }, 1)).toBeNull();
  });

  it('measures the targets in layout points, so a drawing drawn larger needs less reach in band units', () => {
    const cells = [square('speck', 100, 100, 6)];
    // At 2 points to the unit the 44 point target is 11 units from the point, and 24 points more is 12 units.
    expect(regionAtMapPoint(cells, { x: 100 + 11 + 11, y: 100 }, 2)).toBe('speck');
    expect(regionAtMapPoint(cells, { x: 100 + 11 + 13, y: 100 }, 2)).toBeNull();
  });

  it('chooses the nearest region within reach of the land edge, and the first of two equally near', () => {
    // Two large regions 40 units apart (a's edge at 150, b's at 190), with a target far inside each.
    const cells = [square('a', 100, 100, 100), square('b', 240, 100, 100)];
    expect(regionAtMapPoint(cells, { x: 165, y: 100 }, 1)).toBe('a');
    expect(regionAtMapPoint(cells, { x: 175, y: 100 }, 1)).toBe('b');
    expect(regionAtMapPoint(cells, { x: 170, y: 100 }, 1)).toBe('a');
  });

  it('lets land under the tap win over another region whose target reaches it', () => {
    // A speck beside a large region: the tap is on the large region's land, inside the speck's target.
    const cells = [square('speck', 100, 100, 4), square('big', 120, 100, 60)];
    expect(regionAtMapPoint(cells, { x: 105, y: 100 }, 1)).toBe('big');
    expect(regionAtMapPoint([...cells].reverse(), { x: 105, y: 100 }, 1)).toBe('big');
  });

  it('chooses nothing out at sea, and nothing at all when no region has formed', () => {
    const cells = [square('a', 100, 100, 40)];
    expect(regionAtMapPoint(cells, { x: 300, y: 250 }, 1)).toBeNull();
    expect(regionAtMapPoint([], { x: 100, y: 100 }, 1)).toBeNull();
  });

  it('reaches a region across the seam from either side of it', () => {
    const cells = [square('seam', BAND_WIDTH - 2, 100, 20)];
    // Its land runs past the band's right edge: a tap on the left edge, a turn away, is near it.
    expect(regionAtMapPoint(cells, { x: 5, y: 100 }, 1)).toBe('seam');
    expect(regionAtMapPoint(cells, { x: 60, y: 100 }, 1)).toBeNull();
  });
});

describe('on a real world', () => {
  const world = buildGlobe({ seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 });
  const chart = chartWorld(
    world,
    [0, 2, 3, 5, 8].map((site) => ({ objectId: `region-${site}`, site })),
  );

  it('chooses each formed region at the point its name stands on', () => {
    for (const cell of chart.charted) {
      const at = centreOfCell(cell, BAND_WIDTH);
      expect(regionAtMapPoint(chart.charted, { x: at.x, y: at.y }, 0.75)).toBe(cell.objectId);
    }
  });

  it('chooses only formed regions, wherever it is tapped', () => {
    const named = new Set(chart.charted.map((cell) => cell.objectId));
    for (let y = 0; y < 360; y += 20)
      for (let x = 0; x < 480; x += 20) {
        const id = regionAtMapPoint(chart.charted, { x, y }, 0.75);
        if (id !== null) expect(named.has(id)).toBe(true);
      }
  });
});
