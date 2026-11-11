import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { UuidSchema } from '@knowscroll/contracts';
import { dustCueId, gatheringSystems } from './emerging.js';

const CUES = 16;
const catalogue = [
  { id: 'earth', parent: null, facets: [] },
  { id: 'earth.seasons', parent: 'earth', facets: ['earth.seasons.axial-tilt'] },
  { id: 'earth.tides', parent: 'earth', facets: [] },
  { id: 'space', parent: null, facets: [] },
  { id: 'space.black-holes', parent: 'space', facets: [] },
];

describe('dust cues', () => {
  it('gathers toward each system once, however many planets or units reached it', () => {
    expect(gatheringSystems(catalogue, ['earth.seasons', 'earth.tides'], new Set(), CUES)).toEqual(['earth']);
    expect(gatheringSystems(catalogue, ['space.black-holes', 'earth.seasons'], new Set(), CUES)).toEqual([
      'earth',
      'space',
    ]);
  });

  it('stops once the system is established and ignores topics the catalogue does not hold', () => {
    expect(gatheringSystems(catalogue, ['earth.seasons', 'space.black-holes'], new Set(['earth']), CUES)).toEqual([
      'space',
    ]);
    expect(gatheringSystems(catalogue, ['not.in.the.catalogue'], new Set(), CUES)).toEqual([]);
    expect(gatheringSystems(catalogue, [], new Set(), CUES)).toEqual([]);
  });

  it('lets a system topic reach itself', () => {
    expect(gatheringSystems(catalogue, ['space'], new Set(), CUES)).toEqual(['space']);
  });

  it('offers at most the cue cap, the same systems each read, whatever order the reading arrived in', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({
      id: `system-${String(n).padStart(2, '0')}`,
      parent: null,
      facets: [],
    }));
    const ids = many.map((concept) => concept.id);
    const first = gatheringSystems(many, ids, new Set(), CUES);
    expect(first).toEqual(ids.slice(0, CUES));
    expect(gatheringSystems(many, [...ids].reverse(), new Set(), CUES)).toEqual(first);
    // An established system leaves the list, and the next one takes its place.
    expect(gatheringSystems(many, ids, new Set([ids[0]!]), CUES)).toEqual(ids.slice(1, CUES + 1));
  });

  it('derives a stable, valid, scope-bound ID that names no topic', () => {
    const universe = '0199f0a0-0000-7000-8000-000000000001';
    const id = dustCueId(canonicalSha256, universe, 1, 'earth');
    expect(UuidSchema.safeParse(id).success).toBe(true);
    expect(dustCueId(canonicalSha256, universe, 1, 'earth')).toBe(id);
    expect(dustCueId(canonicalSha256, universe, 2, 'earth')).not.toBe(id);
    expect(dustCueId(canonicalSha256, universe, 1, 'space')).not.toBe(id);
    expect(dustCueId(canonicalSha256, '0199f0a0-0000-7000-8000-000000000002', 1, 'earth')).not.toBe(id);
    expect(id).not.toContain('earth');
  });
});
