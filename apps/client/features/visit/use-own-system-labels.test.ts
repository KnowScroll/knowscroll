import type { UniverseSceneState } from '@knowscroll/client-core';
import type { UniversePlace } from '../universe/universe-places';
import { labelsOfRead, ownSystemLabels } from './use-own-system-labels';

const place = (kind: UniversePlace['kind'], label: string, truthStatus: UniversePlace['truthStatus'] = 'factual') =>
  ({ id: label, parentId: 'universe', kind, label, truthStatus }) as UniversePlace;

describe('ownSystemLabels', () => {
  it('keeps the names of systems only', () => {
    expect(
      ownSystemLabels([
        place('system', 'Attention'),
        place('star', 'Attention'),
        place('planet', 'Heads'),
        place('system', 'Tides', 'hypothetical'),
        place('system', 'Baking'),
      ]),
    ).toEqual(['Attention', 'Tides', 'Baking']);
  });
});

describe('labelsOfRead', () => {
  it('has no answer until the read holds something', () => {
    expect(labelsOfRead({ status: 'idle', active: false })).toBeUndefined();
    expect(labelsOfRead({ status: 'loading', active: true })).toBeUndefined();
    expect(labelsOfRead({ status: 'unavailable', active: false, reason: 'scope_unavailable' })).toBeUndefined();
  });

  it('reads the names of every system of a sky, loaded or not', () => {
    const sky = {
      systems: ['Attention', 'Stars'].map((label) => ({
        descriptor: { objectId: label, parentId: 'universe', kind: 'system', label, truthStatus: 'factual' },
      })),
    };
    expect(labelsOfRead({ status: 'loading', active: true, sky } as unknown as UniverseSceneState)).toEqual([
      'Attention',
      'Stars',
    ]);
  });

  it('answers with no names for an empty universe', () => {
    expect(labelsOfRead({ status: 'empty', active: true })).toEqual([]);
  });
});
