import { describe, expect, it } from 'vitest';
import {
  HAZE_FAMILIES,
  LOOK_LIMITS,
  PLANET_TYPES,
  SceneLookJsonSchema,
  SceneLookSchema,
  buildSceneGeometry,
  seededUnit,
  type SceneLook,
} from './index.js';
import { descriptorFixture, fixtureId } from './test-support/fixtures.js';

const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1' } as const;
const system: SceneLook = { ...base, objectId: fixtureId(1), kind: 'system', haze: 'teal' };
const planet: SceneLook = {
  ...base,
  objectId: fixtureId(2),
  kind: 'planet',
  type: 'gas',
  rings: true,
  moon: false,
  hueShift: -42,
  variant: 1,
  siteCount: 4,
};
const region: SceneLook = { ...base, objectId: fixtureId(3), kind: 'region', site: 2 };

describe('look data (synthetic CI fixtures only)', () => {
  it('names six planet types and six haze families', () => {
    expect([...PLANET_TYPES]).toEqual(['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas']);
    expect([...HAZE_FAMILIES]).toEqual(['teal', 'cobalt', 'coral', 'amber', 'pink', 'violet']);
  });

  it.each([system, planet, region])('round trips a %j look through the canonical parser', (look) => {
    expect(SceneLookSchema.parse(look)).toEqual(look);
    expect(SceneLookSchema.parseJson(JSON.stringify(look))).toEqual(look);
  });

  it.each([
    ['an unknown version', { ...planet, schemaVersion: 'scene-look.v2' }],
    ['an unpinned generator', { ...planet, generatorVersion: 'worldmap.v2' }],
    ['a seventh type', { ...planet, type: 'toxic' }],
    ['a haze on a planet', { ...planet, haze: 'teal' }],
    ['a planet without a type', { ...planet, type: undefined }],
    ['a rings flag that is not a boolean', { ...planet, rings: 'yes' }],
    ['a hue beyond a half turn', { ...planet, hueShift: LOOK_LIMITS.hueShift + 1 }],
    ['a fractional hue', { ...planet, hueShift: 1.5 }],
    ['a planet with no site', { ...planet, siteCount: 0 }],
    ['more sites than a planet can hold', { ...planet, siteCount: LOOK_LIMITS.sites + 1 }],
    ['a negative variant', { ...planet, variant: -1 }],
    ['an unknown haze', { ...system, haze: 'green' }],
    ['a star look', { ...system, kind: 'star' }],
    ['a region site past the planet limit', { ...region, site: LOOK_LIMITS.sites }],
    ['a negative site', { ...region, site: -1 }],
    ['an extra field of a score', { ...region, score: 1 }],
    ['an activity field', { ...region, activity: 'quiet' }],
    ['a timestamp', { ...system, recordedAt: '2026-10-30T00:00:00Z' }],
    ['an upper-case object id', { ...region, objectId: 'ABCDEF00-0000-4000-8000-000000000003' }],
  ])('refuses %s', (_name, value) => {
    expect(SceneLookSchema.safeParse(value).success).toBe(false);
  });

  it('describes every look kind in the structural JSON Schema', () => {
    const kinds = (SceneLookJsonSchema.anyOf ?? []).map((branch) => branch.properties?.['kind']?.const);
    expect(kinds).toEqual(['system', 'planet', 'region']);
  });
});

describe('seeded numbers', () => {
  it('are pinned: the same seed and channel give the same number, other channels differ', () => {
    const seed = '1234567890abcdef1234567890abcdef';
    expect(seededUnit(seed, 16)).toBe(seededUnit(seed, 16));
    expect(seededUnit(seed, 16)).not.toBe(seededUnit(seed, 17));
    expect(seededUnit(seed, 16)).not.toBe(seededUnit('0'.repeat(32), 16));
    for (let channel = 0; channel < 64; channel++) {
      const value = seededUnit(seed, channel);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    // A change here changes every stored look's meaning on a client that regenerates from it.
    expect(seededUnit(seed, 16)).toBeCloseTo(0.097, 3);
  });

  it('leave the silhouette generator exactly as it was', () => {
    const geometry = buildSceneGeometry(descriptorFixture(), { detail: 'low', reducedMotion: true });
    expect(geometry.silhouette).toHaveLength(16);
    expect(geometry.silhouette[0]).toEqual({ x: 51.773578, y: 0 });
  });
});
