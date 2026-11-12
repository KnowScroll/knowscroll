import { describe, expect, it } from 'vitest';
import { fixtureSnapshot, planSnapshot } from '../../content/public.js';
import { libraryRoomSeeds } from './library-rooms.js';
import { roomTopicChoices } from './scout-commands.js';

describe('one room for each servable system of the catalogue (D-419)', () => {
  it('seeds the six rooms of the library plan, named from the catalogue', () => {
    const seeds = libraryRoomSeeds(planSnapshot());
    expect(seeds.map((seed) => seed.slug)).toEqual(
      planSnapshot()
        .systems()
        .map((system) => system.id),
    );
    expect(seeds).toHaveLength(6);
    expect(seeds.find((seed) => seed.slug === 'machine-learning')).toMatchObject({
      name: 'Machine learning room',
      topic: { kind: 'system', id: 'machine-learning' },
    });
  });

  it('seeds no room for a system that has no servable topic yet, and one for a system that has', () => {
    const empty = fixtureSnapshot([{ id: 'geology', parent: null }]);
    expect(libraryRoomSeeds(empty)).toEqual([]);
    const served = fixtureSnapshot([
      { id: 'geology', parent: null },
      { id: 'geology.rocks', parent: 'geology', facets: ['geology.rocks.igneous', 'geology.rocks.sediment'] },
    ]);
    expect(libraryRoomSeeds(served).map((seed) => seed.slug)).toEqual(['geology']);
  });

  it('offers a scout the servable planets of a room, by their labels, and nothing for a planet that is not one', () => {
    const catalogue = planSnapshot();
    expect(roomTopicChoices(catalogue, { kind: 'system', id: 'earth' })).toEqual([
      { id: 'earth.seasons', label: 'Seasons' },
      { id: 'earth.tides', label: 'Tides' },
      { id: 'earth.greenhouse-effect', label: 'Greenhouse effect' },
    ]);
    expect(roomTopicChoices(catalogue, { kind: 'planet', id: 'earth.tides' })).toEqual([
      { id: 'earth.tides', label: 'Tides' },
    ]);
    expect(roomTopicChoices(catalogue, { kind: 'planet', id: 'earth' })).toEqual([]);
    expect(roomTopicChoices(catalogue, { kind: 'planet', id: 'earth.nothing' })).toEqual([]);
  });
});
