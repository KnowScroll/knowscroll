import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { indexUniverse } from './universe-layout';
import { countOf, listUniverse } from './universe-lists';

const descriptor = (
  objectId: string,
  kind: SceneDescriptor['kind'],
  label: string,
  parentId: string,
  quiet = false,
): SceneDescriptor =>
  ({
    objectId,
    kind,
    label,
    parentId,
    palette: 'sage',
    activity: { availability: 'available', state: quiet ? 'quiet' : 'active' },
  }) as unknown as SceneDescriptor;

const index = indexUniverse(
  [
    descriptor('s-b', 'system', 'Backend', 'u'),
    descriptor('s-a', 'system', 'Astronomy', 'u', true),
    descriptor('p-1', 'planet', 'Queues', 's-b'),
    descriptor('p-2', 'planet', 'Attention', 's-a'),
    descriptor('r-1', 'region', 'Batching', 'p-2'),
    descriptor('r-2', 'region', 'Latency', 'p-2'),
  ],
  [],
);
const station = (roomId: string, systemId: string) =>
  ({ room: { roomId, name: `Room ${roomId}` }, placement: { systemId } }) as unknown as RoomStation;

describe('the lists the Simple view, the panel and the dial share', () => {
  it('lists systems and planets in the drawing’s order, counting only the regions that have formed', () => {
    const { systems } = listUniverse(index, [], null);
    expect(systems.map((system) => system.name)).toEqual(['Astronomy', 'Backend']);
    expect(systems[0]!.planets).toEqual([
      { id: 'p-2', name: 'Attention', regions: 2, hereRegion: undefined, quiet: false, hypothetical: false },
    ]);
    expect(systems[0]!.quiet).toBe(true);
  });

  it('marks the planet the person left from, by the name of that region', () => {
    const { systems } = listUniverse(index, [], 'r-2');
    expect(systems[0]!.planets[0]!.hereRegion).toBe('Latency');
    expect(systems[1]!.planets[0]!.hereRegion).toBeUndefined();
  });

  it('lists a room beside its system and leaves out a room whose system is not on the map', () => {
    const { systems, rooms } = listUniverse(index, [station('a', 's-b'), station('b', 'gone')], null);
    expect(rooms).toEqual([{ id: 'a', name: 'Room a', systemId: 's-b', systemName: 'Backend' }]);
    expect(systems.map((system) => system.rooms.length)).toEqual([0, 1]);
  });

  it('puts places with recent activity first only when Lately is on, and lists the same places either way', () => {
    const plain = listUniverse(index, [], null, false);
    const lately = listUniverse(index, [], null, true);
    expect(plain.systems.map((system) => system.name)).toEqual(['Astronomy', 'Backend']);
    // Astronomy is quiet: with Lately on it goes after Backend, and nothing is dropped.
    expect(lately.systems.map((system) => system.name)).toEqual(['Backend', 'Astronomy']);
    expect(lately.systems.map((system) => system.id).sort()).toEqual(plain.systems.map((system) => system.id).sort());
  });

  it('counts with the right plural', () => {
    expect([countOf(1, 'planet'), countOf(3, 'planet'), countOf(1, 'country'), countOf(4, 'country')]).toEqual([
      '1 planet',
      '3 planets',
      '1 country',
      '4 countries',
    ]);
  });
});
