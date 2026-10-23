import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { UuidSchema } from '@knowscroll/contracts';
import { dustCueId, gatheringSystems } from './emerging.js';

const catalogue = [
  { id: 'earth', parent: null, facets: [] },
  { id: 'earth.seasons', parent: 'earth', facets: ['earth.seasons.axial-tilt'] },
  { id: 'earth.tides', parent: 'earth', facets: [] },
  { id: 'space', parent: null, facets: [] },
  { id: 'space.black-holes', parent: 'space', facets: [] },
];

describe('dust cues', () => {
  it('gathers toward each system once, however many planets or units reached it', () => {
    expect(gatheringSystems(catalogue, ['earth.seasons', 'earth.tides'], new Set())).toEqual(['earth']);
    expect(gatheringSystems(catalogue, ['space.black-holes', 'earth.seasons'], new Set())).toEqual(['earth', 'space']);
  });

  it('stops once the system is established and ignores topics the catalogue does not hold', () => {
    expect(gatheringSystems(catalogue, ['earth.seasons', 'space.black-holes'], new Set(['earth']))).toEqual(['space']);
    expect(gatheringSystems(catalogue, ['not.in.the.catalogue'], new Set())).toEqual([]);
    expect(gatheringSystems(catalogue, [], new Set())).toEqual([]);
  });

  it('lets a system topic reach itself', () => {
    expect(gatheringSystems(catalogue, ['space'], new Set())).toEqual(['space']);
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
