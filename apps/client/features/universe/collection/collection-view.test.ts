import type { Collection, CollectionLandmark } from '@knowscroll/client-core';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { indexUniverse } from '../universe-layout';
import { collectionViewOf } from './collection-view';

/** Authored protocol fixtures only. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const planet = { objectId: id(20), kind: 'planet', parentId: id(19), label: 'Earth & sky' } as SceneDescriptor;
const system = { objectId: id(19), kind: 'system', parentId: id(2), label: 'Earth & sky system' } as SceneDescriptor;
const landmark = (over: Partial<CollectionLandmark> = {}): CollectionLandmark => ({
  key: 'the-leaning-axis',
  name: 'The Leaning Axis',
  tier: 'gold',
  assetId: id(10),
  revision: 1,
  earnedAt: '2026-11-02T10:00:00.000Z',
  topicId: 'earth.seasons',
  ...over,
});
const collection = (over: Partial<Collection> = {}): Collection => ({
  landmarks: [landmark()],
  orbit: { days: 1, goal: 3, weekStart: '2026-11-02', closed: false },
  resume: null,
  planets: [{ id: id(20), topicId: 'earth.seasons' }],
  ...over,
});

describe('the collection as the Universe shows it', () => {
  it('stands a landmark on the planet of its topic, and says so in its row', () => {
    const view = collectionViewOf(collection(), indexUniverse([system, planet], []));
    expect(view.waiting).toEqual([]);
    expect(view.rows).toEqual([
      {
        id: `${id(10)}:1`,
        name: 'The Leaning Axis',
        tier: 'gold',
        finish: 'Gold finish',
        planet: { id: id(20), name: 'Earth & sky' },
      },
    ]);
    expect(view.byPlanet.get(id(20))).toHaveLength(1);
  });

  it('keeps it in the tray while the planet is not on the map, and the Orbit reads the same', () => {
    const view = collectionViewOf(collection(), indexUniverse([system], []));
    expect(view.waiting).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ planet: undefined, finish: 'Gold finish' });
    expect(view.byPlanet.size).toBe(0);
    expect(view.orbitText).toBe('Orbit · 1 of 3 days this week');
  });

  it('puts a plain finish and a gold one in the same place: the finish never decides where', () => {
    const plain = landmark({ tier: 'plain', assetId: id(11), name: 'The Turning Halves', key: 'the-turning-halves' });
    const view = collectionViewOf(collection({ landmarks: [landmark(), plain] }), indexUniverse([system, planet], []));
    expect(view.byPlanet.get(id(20))?.map((entry) => entry.tier)).toEqual(['gold', 'plain']);
    expect(view.rows.map((row) => row.finish)).toEqual(['Gold finish', 'Plain finish']);
  });

  it('says nothing of the Orbit before there is anything to say, and never of a loss', () => {
    const none = collectionViewOf(
      collection({ landmarks: [], orbit: { days: 0, goal: 3, weekStart: '2026-11-02', closed: false } }),
      indexUniverse([], []),
    );
    expect(none.orbitText).toBeUndefined();
    const earned = collectionViewOf(
      collection({ orbit: { days: 0, goal: 3, weekStart: '2026-11-02', closed: false } }),
      indexUniverse([], []),
    );
    expect(earned.orbitText).toBe('Orbit · 0 of 3 days this week');
  });

  it('carries the next Part to resume, and nothing when there is none', () => {
    const offer = { assetId: id(11), title: 'Why the hemispheres take turns', part: 2, total: 3 };
    expect(collectionViewOf(collection({ resume: offer }), indexUniverse([], [])).resume).toEqual(offer);
    expect(collectionViewOf(collection(), indexUniverse([], [])).resume).toBeNull();
  });
});
