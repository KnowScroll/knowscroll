import { indexUniverse } from '../universe-layout';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { calmNames } from './calm-names';

const descriptors = sceneFixture(5).descriptors.map((place) =>
  // The star, the planet CI planet 3 and the region are quiet; the system and CI planet 2 are active.
  [11, 13, 14].some((n) => place.objectId === fixtureId(n))
    ? { ...place, activity: { availability: 'available' as const, state: 'quiet' as const } }
    : place,
);
const index = indexUniverse(descriptors, []);
// The map's anchors: a star is not one (its system is), so it is left out.
const anchors = descriptors.flatMap(({ objectId, kind }) => (kind === 'star' ? [] : [{ id: objectId, kind }]));

describe('the names Lately calms in the new look', () => {
  it('are none while Lately is off', () => {
    expect(calmNames(anchors, index, false).size).toBe(0);
  });

  it('are the quiet planets, and nothing else, while it is on', () => {
    expect([...calmNames(anchors, index, true)]).toEqual([fixtureId(13)]);
  });

  it('never include a region, so a calm name never blurs with the grey of land not reached', () => {
    expect(calmNames(anchors, index, true).has(fixtureId(14))).toBe(false);
  });

  it('never include a quiet system the map does not hold, or a room', () => {
    expect(
      calmNames(
        [
          { id: 'x', kind: 'system' },
          { id: 'y', kind: 'station' },
        ],
        index,
        true,
      ).size,
    ).toBe(0);
  });

  it('include a quiet system', () => {
    const quiet = indexUniverse(
      descriptors.map((place) =>
        place.kind === 'system'
          ? { ...place, activity: { availability: 'available' as const, state: 'quiet' as const } }
          : place,
      ),
      [],
    );
    expect(calmNames(anchors, quiet, true).has(fixtureId(10))).toBe(true);
  });
});
