import { climbsToGlobe, escapeOneStop, stopOf, targetKey } from './ladder';

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

describe('Escape', () => {
  /** A session on a planet's ground (or as `over` says), recording what Escape asked of it. */
  function sessionAt(
    over: {
      focusId?: string;
      landed?: boolean;
      overlay?: string | null;
      selectedId?: string | null;
      story?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const session = {
      getState: () => ({
        focusId: over.focusId ?? 'planet',
        landed: over.landed ?? true,
        overlay: over.overlay ?? null,
        selectedId: over.selectedId ?? null,
      }),
      formation: { getState: () => ({ fact: over.story === true ? { id: 'story' } : undefined }) },
      places: () => [
        { id: 'planet', kind: 'planet' },
        { id: 'region', kind: 'region' },
      ],
      focus: (id: string) => {
        calls.push(`focus ${id}`);
        return true;
      },
      escape: () => {
        calls.push('escape');
        return true;
      },
    } as unknown as Parameters<typeof escapeOneStop>[0];
    return { session, calls };
  }

  it('climbs from the ground to its planet’s globe when nothing is open', () => {
    const { session, calls } = sessionAt();
    expect(escapeOneStop(session)).toBe(true);
    expect(calls).toEqual(['focus planet']);
  });

  it('leaves everything else to the Universe’s own Escape', () => {
    for (const over of [
      { story: true },
      { overlay: 'search' },
      { selectedId: 'planet' },
      { focusId: 'region' },
      { landed: false },
    ]) {
      const { session, calls } = sessionAt(over);
      escapeOneStop(session);
      expect(calls).toEqual(['escape']);
    }
  });
});
