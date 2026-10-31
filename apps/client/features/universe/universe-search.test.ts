import { searchUniverse, type SearchRoom } from './universe-search';
import type { UniversePlace } from './universe-session';

const place = (id: string, kind: UniversePlace['kind'], label: string, parentId = ''): UniversePlace => ({
  id,
  kind,
  label,
  parentId,
  truthStatus: 'factual',
});
const places = [
  place('s1', 'system', 'Machine learning'),
  place('s1-star', 'star', 'Machine learning', 's1'),
  place('p1', 'planet', 'Inference & serving', 's1'),
  place('r1', 'region', 'Cost', 'p1'),
  place('r2', 'region', 'Latency', 'p1'),
  place('s2', 'system', 'Economics'),
  place('p2', 'planet', 'Cost of living', 's2'),
];
const rooms: readonly SearchRoom[] = [
  { id: 'room-1', name: 'Cost model room', systemId: 's2' },
  { id: 'room-elsewhere', name: 'Cost of a room that is not here', systemId: 'not-on-this-map' },
];

describe('search over your own places and rooms', () => {
  it('finds by name, best match first, with the places that contain each result', () => {
    const results = searchUniverse(places, rooms, 'cost');
    // The whole name first, then names that start with it (a planet before a room).
    expect(results.map((result) => result.id)).toEqual(['r1', 'p2', 'room-1']);
    expect(results.find((result) => result.id === 'r1')!.trail).toEqual(['Inference & serving', 'Machine learning']);
  });

  it('finds a room by name and names the system it stands beside', () => {
    const [room] = searchUniverse(places, rooms, 'model room');
    expect(room).toMatchObject({ id: 'room-1', kind: 'room', name: 'Cost model room', trail: ['Economics'] });
  });

  it('never finds a room whose system is not on this map, or a star', () => {
    expect(searchUniverse(places, rooms, 'not here')).toEqual([]);
    expect(searchUniverse(places, [], 'machine').map((result) => result.kind)).toEqual(['system']);
  });

  it('matches word starts and accents, and ignores case and extra space', () => {
    expect(searchUniverse(places, [], '  SERVING ').map((result) => result.id)).toEqual(['p1']);
    expect(searchUniverse([place('x', 'system', 'Café')], [], 'cafe')).toHaveLength(1);
  });

  it('says which letters matched, in the place’s own spelling', () => {
    const [serving] = searchUniverse(places, [], 'serv');
    expect(serving!.name.slice(...serving!.match)).toBe('serv');
    const [accented] = searchUniverse([place('x', 'system', 'Crème brûlée')], [], 'brul');
    expect(accented!.name.slice(...accented!.match)).toBe('brûl');
  });

  it('returns nothing for an empty or unmatched query and bounds the result list', () => {
    expect(searchUniverse(places, rooms, '   ')).toEqual([]);
    expect(searchUniverse(places, rooms, 'zzz')).toEqual([]);
    const many = Array.from({ length: 40 }, (_, n) => place(`m${n}`, 'region', `Mode ${n}`, 'p1'));
    expect(searchUniverse(many, [], 'mode')).toHaveLength(12);
  });
});
