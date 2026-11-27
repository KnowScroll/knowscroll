import { indexUniverse, viewFor } from '../universe-layout';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { returnOffered, returnTarget } from './return-chip';

/** The fixture's CI system 0 holds CI planet 2 and CI planet 3; CI region 4 is on planet 2. */
const index = indexUniverse(sceneFixture(5).descriptors, []);
const SYSTEM = fixtureId(10);
const PLANET_2 = fixtureId(12);
const PLANET_3 = fixtureId(13);
const REGION = fixtureId(14);
const at = (id: string | null, landed = false) => viewFor(index, id, landed);
const parked = (id: string) => returnTarget(index, { id, label: '', kind: 'planet' })!;

describe('the planet the ship is parked at', () => {
  it('is the planet of a region, with the star it hangs under', () => {
    expect(parked(REGION)).toEqual({ id: PLANET_2, label: 'CI planet 2', parentId: SYSTEM });
  });

  it('is nothing before any place was visited, or for a place the map no longer holds', () => {
    expect(returnTarget(index, undefined)).toBeUndefined();
    expect(returnTarget(index, { id: fixtureId(999), label: '', kind: 'planet' })).toBeUndefined();
  });
});

describe('when the new look offers "Return to"', () => {
  it('never offers the planet you are at, on its globe or on its ground', () => {
    expect(returnOffered(at(PLANET_2), parked(PLANET_2))).toBe(false);
    expect(returnOffered(at(PLANET_2, true), parked(PLANET_2))).toBe(false);
  });

  it('does not offer a planet at its own star: Back from the planet lands there', () => {
    expect(returnOffered(at(SYSTEM), parked(PLANET_2))).toBe(false);
    expect(returnOffered(at(SYSTEM), parked(REGION))).toBe(false);
  });

  it('offers it at the whole universe', () => {
    expect(returnOffered(at(null), parked(PLANET_2))).toBe(true);
  });

  it('offers it at a sibling planet, which is another place', () => {
    expect(returnOffered(at(PLANET_3), parked(PLANET_2))).toBe(true);
  });

  it('does not offer a star at itself, and offers it from one of its planets', () => {
    const star = returnTarget(index, { id: SYSTEM, label: '', kind: 'system' })!;
    expect(returnOffered(at(SYSTEM), star)).toBe(false);
    expect(returnOffered(at(PLANET_2), star)).toBe(true);
  });
});
