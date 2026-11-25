import { climbsToGlobe, stopOf, targetKey } from './ladder';

const descriptor = { objectId: 'p' } as never;

describe('the stop of a view', () => {
  it('reads the stop from the stored camera as it always was', () => {
    expect(stopOf({ kind: 'universe' })).toBe('universe');
    expect(stopOf({ kind: 'system', system: descriptor })).toBe('star');
    expect(stopOf({ kind: 'planet', planet: descriptor, landed: false })).toBe('planet');
    expect(stopOf({ kind: 'planet', planet: descriptor, landed: true })).toBe('ground');
  });
});

describe('the key of a target', () => {
  it('is the four parts joined by bars, with a missing part empty', () => {
    expect(targetKey({ stop: 'universe', systemId: null, planetId: null, regionId: null })).toBe('universe|||');
    expect(targetKey({ stop: 'ground', systemId: 's', planetId: 'p', regionId: 'r' })).toBe('ground|s|p|r');
  });

  it('differs for two places that differ in any one part', () => {
    const base = { stop: 'ground', systemId: 's', planetId: 'p', regionId: 'r' } as const;
    const keys = [
      targetKey(base),
      targetKey({ ...base, stop: 'planet' }),
      targetKey({ ...base, systemId: 't' }),
      targetKey({ ...base, planetId: 'q' }),
      targetKey({ ...base, regionId: null }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('climbing from the ground', () => {
  it('goes to the planet’s globe first only on the ground of a whole planet', () => {
    expect(climbsToGlobe({ kind: 'planet', planet: descriptor, landed: true })).toBe(true);
    expect(climbsToGlobe({ kind: 'planet', planet: descriptor, landed: false })).toBe(false);
    expect(climbsToGlobe({ kind: 'planet', planet: descriptor, landed: true, selectedRegion: descriptor })).toBe(false);
    expect(climbsToGlobe({ kind: 'system', system: descriptor })).toBe(false);
    expect(climbsToGlobe({ kind: 'universe' })).toBe(false);
  });
});
