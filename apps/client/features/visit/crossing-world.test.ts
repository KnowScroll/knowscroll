import type { VisitState } from '@knowscroll/client-core';
import { crossingWorldOf } from './crossing-world';

const system = (label: string, id: string) => ({ publicSystemId: id, label, planets: [] });
const ready = (labels: string[]): VisitState => ({
  status: 'ready',
  owner: { kind: 'person', personId: 'p1', handle: 'fixture.ravi', displayName: 'Ravi fixture' },
  systems: labels.map((label, index) => system(label, `s${String(index)}`)),
  stale: false,
});

describe('what the crossing knows of a visit', () => {
  it('is waiting until the read answers', () => {
    expect(crossingWorldOf(undefined, ['Attention'])).toEqual({ status: 'waiting' });
    expect(crossingWorldOf({ status: 'loading' }, ['Attention'])).toEqual({ status: 'waiting' });
    expect(crossingWorldOf({ status: 'ended' }, undefined)).toEqual({ status: 'waiting' });
  });

  it('is gone for a refusal and for no connection', () => {
    expect(crossingWorldOf({ status: 'unavailable', wasShown: false, ownerName: undefined }, undefined)).toEqual({
      status: 'gone',
    });
    expect(crossingWorldOf({ status: 'offline' }, [])).toEqual({ status: 'gone' });
  });

  it('carries the friend’s name and, in their order, the names you have too, as search folds names', () => {
    expect(crossingWorldOf(ready(['Baking', 'cafe', 'Stars']), ['Stars', 'Café', 'Other'])).toEqual({
      status: 'ready',
      name: 'Ravi fixture',
      shared: ['cafe', 'Stars'],
    });
  });

  it('has no shared names to give when your own are not in hand, and none when there are none in common', () => {
    expect(crossingWorldOf(ready(['Baking']), undefined)).toMatchObject({ status: 'ready', shared: undefined });
    expect(crossingWorldOf(ready(['Baking']), ['Stars'])).toMatchObject({ status: 'ready', shared: [] });
  });
});
