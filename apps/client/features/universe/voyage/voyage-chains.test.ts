import type { Vec3 } from '../space/camera-rig';
import {
  chainOf,
  focalOf,
  increasing,
  peakOf,
  planetDistances,
  UNIVERSE_ID,
  type ChainPlaces,
  type ViewSize,
} from './voyage-chains';
import type { VoyageTarget } from './ladder';

const size: ViewSize = { width: 390, height: 844 };

const planets = new Map<string, { position: Vec3; radius: number }>([
  ['p1', { position: [3, 0, 0], radius: 0.5 }],
  ['p2', { position: [-3, 0, 1], radius: 0.8 }],
]);
const places: ChainPlaces = {
  universeFocus: { kind: 'universe', center: { x: 7, z: -4.5 }, halfWidth: 16, halfDepth: 12 },
  systemFocus: (id) =>
    ['s1', 's2'].includes(id)
      ? { kind: 'system', systemId: id, center: { x: id === 's1' ? 0 : 14, z: 0 }, radius: 7.5 }
      : undefined,
  planetAt: (id) => planets.get(id),
};
const at = (stop: VoyageTarget['stop'], systemId: string | null, planetId: string | null = null): VoyageTarget => ({
  stop,
  systemId,
  planetId,
  regionId: null,
});

describe('the chain of a target', () => {
  it('lists places innermost first and ends in the universe', () => {
    expect(chainOf(at('universe', null), places, size).ids).toEqual([UNIVERSE_ID]);
    expect(chainOf(at('star', 's1'), places, size).ids).toEqual(['s1', UNIVERSE_ID]);
    expect(chainOf(at('planet', 's1', 'p1'), places, size).ids).toEqual(['p1', 's1', UNIVERSE_ID]);
  });

  it('grows strictly farther along the chain', () => {
    const { chain } = chainOf(at('planet', 's1', 'p1'), places, size);
    expect(chain).toHaveLength(3);
    expect(chain[1]!.distance).toBeGreaterThan(chain[0]!.distance);
    expect(chain[2]!.distance).toBeGreaterThan(chain[1]!.distance);
  });

  it('stands nearer on the ground than at the planet, and at the planet at its own link', () => {
    const planet = chainOf(at('planet', 's1', 'p1'), places, size);
    const ground = chainOf(at('ground', 's1', 'p1'), places, size);
    expect(ground.stopDistance).toBeLessThan(planet.stopDistance);
    expect(planet.stopDistance).toBe(planet.chain[0]!.distance);
    expect(planet.planetRadius).toBe(0.5);
  });

  it('ends the chain at the star when the scene does not hold the planet, and at the universe for an unknown star', () => {
    const lost = chainOf(at('planet', 's1', 'missing'), places, size);
    expect(lost.ids).toEqual(['s1', UNIVERSE_ID]);
    expect(lost.planetRadius).toBeNull();
    expect(chainOf(at('star', 'nowhere'), places, size).ids).toEqual([UNIVERSE_ID]);
  });
});

describe('making a chain increase', () => {
  it('lifts a link that is not at least 1.25 times the one before, and leaves the others', () => {
    const point: Vec3 = [0, 0, 0];
    const result = increasing([
      { distance: 10, point },
      { distance: 11, point },
      { distance: 100, point },
    ]);
    expect(result.map((link) => link.distance)).toEqual([10, 12.5, 100]);
  });
});

describe('the peak of a flight', () => {
  const from = (id: string, planetId: string | null = null) => chainOf(at(planetId ? 'planet' : 'star', id, planetId), places, size);

  it('is null when one end is inside the other', () => {
    expect(peakOf(from('s1', 'p1'), from('s1'))).toBeNull();
    expect(peakOf(from('s1'), from('s1', 'p1'))).toBeNull();
  });

  it('is the shared star distance for two planets of one star', () => {
    const one = from('s1', 'p1');
    const two = from('s1', 'p2');
    expect(peakOf(one, two)).toBe(two.chain[1]!.distance);
  });

  it('is the whole universe distance for two stars', () => {
    const second = from('s2');
    expect(peakOf(from('s1'), second)).toBe(second.chain[1]!.distance);
  });
});

describe('the distances of a planet', () => {
  it('put the planet at 0.36 of the short side across in radius from orbit', () => {
    const radiusPx = (focalOf(size) * 0.5) / planetDistances(0.5, size).planet;
    expect(radiusPx).toBeCloseTo(0.36 * Math.min(size.width, 0.62 * size.height));
  });

  it('scale with the planet radius, and the ground is nearer than orbit', () => {
    const small = planetDistances(0.5, size);
    const big = planetDistances(1, size);
    expect(big.planet).toBeCloseTo(2 * small.planet);
    expect(big.ground).toBeCloseTo(2 * small.ground);
    expect(small.ground).toBeLessThan(small.planet);
  });
});
