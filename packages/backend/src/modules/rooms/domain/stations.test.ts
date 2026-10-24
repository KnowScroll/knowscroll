import { describe, expect, it } from 'vitest';
import { placementsOf, type PlaceableObject } from './stations.js';

const object = (
  id: string,
  kind: PlaceableObject['kind'],
  meaningId: string,
  parent: string,
  truthStatus: PlaceableObject['truthStatus'] = 'factual',
): PlaceableObject => ({ id, kind, meaningId, parent: { id: parent }, truthStatus });

describe('placementsOf', () => {
  it('offers each factual system, and each factual planet with its system', () => {
    expect(
      placementsOf([
        object('s1', 'system', 'machine-learning', 'u'),
        object('t1', 'star', 'machine-learning', 's1'),
        object('p1', 'planet', 'machine-learning.attention', 's1'),
        object('r1', 'region', 'machine-learning.attention.heads', 'p1'),
      ]),
    ).toEqual([
      { topic: { kind: 'system', id: 'machine-learning' }, systemId: 's1' },
      { topic: { kind: 'planet', id: 'machine-learning.attention' }, systemId: 's1', planetId: 'p1' },
    ]);
  });

  it('never places a room beside a hypothetical place', () => {
    expect(
      placementsOf([
        object('s1', 'system', 'machine-learning', 'u', 'hypothetical'),
        object('p1', 'planet', 'machine-learning.attention', 's1'),
      ]),
    ).toEqual([]);
  });

  it('is empty for an empty map', () => {
    expect(placementsOf([])).toEqual([]);
  });
});
