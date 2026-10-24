import { searchPlaces } from './universe-search';
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

describe('search over your own places', () => {
  it('finds by name, best match first, with the places that contain each result', () => {
    const results = searchPlaces(places, 'cost');
    // Equally good name matches: a planet comes before a region.
    expect(results.map((r) => r.place.id)).toEqual(['p2', 'r1']);
    expect(results.find((r) => r.place.id === 'r1')!.trail).toEqual(['Inference & serving', 'Machine learning']);
  });

  it('matches word starts and accents, ignores case and extra space, and never returns stars', () => {
    expect(searchPlaces(places, '  SERVING ').map((r) => r.place.id)).toEqual(['p1']);
    expect(searchPlaces([place('x', 'system', 'Café')], 'cafe')).toHaveLength(1);
    expect(searchPlaces(places, 'machine').map((r) => r.place.kind)).toEqual(['system']);
  });

  it('returns nothing for an empty or unmatched query and bounds the result list', () => {
    expect(searchPlaces(places, '   ')).toEqual([]);
    expect(searchPlaces(places, 'zzz')).toEqual([]);
    const many = Array.from({ length: 40 }, (_, n) => place(`m${n}`, 'region', `Mode ${n}`, 'p1'));
    expect(searchPlaces(many, 'mode')).toHaveLength(12);
  });
});
