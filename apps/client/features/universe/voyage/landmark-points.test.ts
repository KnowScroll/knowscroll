import type { CollectionLandmark } from '@knowscroll/client-core';
import { buildGlobe, chartWorld, landmarkSpots } from '@knowscroll/scene-core';
import { landmarkPoints } from './landmark-points';
import { latitudeOfBandY } from './world-texture';

const spec = { seed: '1234567890abcdef1234567890abcdef', variant: 0 };
const world = buildGlobe({ ...spec, type: 'lush', siteCount: 12 });
const chart = chartWorld(
  world,
  [0, 2, 3, 5, 8].map((site) => ({ objectId: `region-${String(site)}`, site })),
);

const landmark = (key: string, earnedAt: string, tier: CollectionLandmark['tier'] = 'plain'): CollectionLandmark => ({
  key,
  name: key,
  tier,
  assetId: `asset-${key}`,
  revision: 1,
  earnedAt,
});

describe('where landmarks stand on the globe', () => {
  it('stands on the spots the old globe uses, the first earned first, whatever order they come in', () => {
    const points = landmarkPoints(
      [landmark('later', '2026-11-10T00:00:00Z', 'gold'), landmark('first', '2026-11-01T00:00:00Z')],
      spec,
      world,
      chart,
    );
    const spots = landmarkSpots(spec.seed, spec.variant, world, chart, 2);
    expect(points.map((point) => point.key)).toEqual(['asset-first:1', 'asset-later:1']);
    expect(points.map((point) => point.tier)).toEqual(['plain', 'gold']);
    expect(points.map((point) => point.x)).toEqual(spots.map((spot) => spot.x));
    expect(points.map((point) => point.lat)).toEqual(spots.map((spot) => latitudeOfBandY(spot.y)));
  });

  it('keeps a landmark where it stood when another is earned', () => {
    const one = landmarkPoints([landmark('first', '2026-11-01T00:00:00Z')], spec, world, chart);
    const two = landmarkPoints(
      [landmark('first', '2026-11-01T00:00:00Z'), landmark('second', '2026-11-05T00:00:00Z')],
      spec,
      world,
      chart,
    );
    expect(two[0]).toEqual(one[0]);
  });

  it('has none for a planet with no landmarks', () => {
    expect(landmarkPoints([], spec, world, chart)).toEqual([]);
  });
});
