import { describe, expect, it, vi } from 'vitest';
import {
  buildSceneGeometry,
  SCENE_LIMITS,
  SceneChunkSchema,
  SceneDescriptorSchema,
  SceneManifestSchema,
  SceneParseError,
  SceneReturnLocatorSchema,
  type SceneFamily,
} from './index.js';
import { chunkFixture, descriptorFixture, fixtureId, manifestFixture } from './test-support/fixtures.js';

const full = { detail: 'full', reducedMotion: false } as const;
const low = { detail: 'low', reducedMotion: true } as const;

describe('bounded versioned scene data (synthetic CI fixtures only)', () => {
  it('round trips descriptor, chunk, manifest and independent revision components', () => {
    for (const [schema, value] of [
      [SceneDescriptorSchema, descriptorFixture()],
      [SceneChunkSchema, chunkFixture()],
      [SceneManifestSchema, manifestFixture()],
    ] as const) {
      expect(schema.parse(value)).toEqual(value);
      expect(schema.parseJson(JSON.stringify(value))).toEqual(value);
    }
  });
  it('keeps an empty universe empty', () => {
    const chunk = { ...chunkFixture(), objects: [], routes: [] };
    const manifest = { ...manifestFixture(), chunks: [] };
    expect(SceneChunkSchema.parse(chunk).objects).toEqual([]);
    expect(SceneManifestSchema.parse(manifest).chunks).toEqual([]);
  });
  it('retains exact return focus and frame without authority or transition acknowledgements', () => {
    const locator = {
      schemaVersion: 'scene-return.v1',
      chunkId: fixtureId(3),
      objectId: fixtureId(1),
      frame: { x: 32.125, y: -129.5, scale: 2.25 },
    };
    expect(SceneReturnLocatorSchema.parseJson(JSON.stringify(locator))).toEqual(locator);
    expect(SceneReturnLocatorSchema.safeParse({ ...locator, frame: { ...locator.frame, scale: 0 } }).success).toBe(
      false,
    );
    expect(SceneReturnLocatorSchema.safeParse({ ...locator, acknowledged: true }).success).toBe(false);
    expect(SceneReturnLocatorSchema.safeParse({ ...locator, frame: { ...locator.frame, x: Infinity } }).success).toBe(
      false,
    );
    expect(SceneReturnLocatorSchema.parse({ ...locator, objectId: null }).objectId).toBeNull();
  });
  it.each([
    { schemaVersion: 'scene-descriptor.v2' },
    { generatorVersion: 'silhouette.v2' },
    { family: 'unselected' },
    { seed: 'random' },
    { seed: 'A'.repeat(32) },
    { seed: '0'.repeat(33) },
    { objectId: 'abcdef00-0000-4000-8000-000000000001'.toUpperCase() },
    { providerPrompt: 'anything' },
    { observations: [] },
    { score: 1 },
    { grant: {} },
    { svg: '<svg/>' },
    { label: 'https://example.invalid' },
    { label: '<script>' },
    { target: { kind: 'planet', objectId: 'javascript:run()' } },
    { anchor: { x: NaN, y: 0, layer: 1 } },
    { anchor: { x: 10001, y: 0, layer: 1 } },
    { atmosphere: { density: 1.1 } },
    { detail: { roughness: -1 } },
    { activity: { availability: 'unavailable', state: 'active' } },
    { activity: { availability: 'available', state: 'mastered' } },
    { truthStatus: 'speculative' },
    { target: { kind: 'planet', objectId: fixtureId(999) } },
  ])('refuses unsupported, unbounded or operational fields: %j', (patch) => {
    expect(SceneDescriptorSchema.safeParse({ ...descriptorFixture(), ...patch }).success).toBe(false);
  });
  it('rejects duplicate identity, self-parenting and invalid known local hierarchy', () => {
    const chunk = chunkFixture();
    expect(SceneChunkSchema.safeParse({ ...chunk, objects: [descriptorFixture(), descriptorFixture()] }).success).toBe(
      false,
    );
    expect(SceneDescriptorSchema.safeParse({ ...descriptorFixture(), parentId: fixtureId(1) }).success).toBe(false);
    expect(
      SceneChunkSchema.safeParse({
        ...chunk,
        objects: [descriptorFixture(), { ...descriptorFixture(2), parentId: fixtureId(1) }],
      }).success,
    ).toBe(false);
    const manifest = manifestFixture();
    expect(
      SceneManifestSchema.safeParse({ ...manifest, chunks: [...manifest.chunks, ...manifest.chunks] }).success,
    ).toBe(false);
  });
  it('enforces object, route, chunk, node, depth and byte caps', () => {
    const chunk = chunkFixture();
    expect(
      SceneChunkSchema.safeParse({
        ...chunk,
        objects: Array.from({ length: SCENE_LIMITS.objectsPerChunk + 1 }, (_, i) => descriptorFixture(i + 1)),
      }).success,
    ).toBe(false);
    expect(
      SceneChunkSchema.safeParse({
        ...chunk,
        routes: Array.from({ length: 101 }, (_, i) => ({
          id: fixtureId(i + 100),
          fromObjectId: fixtureId(1),
          toObjectId: fixtureId(2),
          originTransitionId: fixtureId(9),
          truthStatus: 'factual',
        })),
      }).success,
    ).toBe(false);
    expect(
      SceneManifestSchema.safeParse({
        ...manifestFixture(),
        chunks: Array.from({ length: 129 }, (_, i) => ({ chunkId: fixtureId(i + 1), sceneRevision: 0, objectIds: [] })),
      }).success,
    ).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(SceneDescriptorSchema.safeParse(deep).success).toBe(false);
    expect(SceneDescriptorSchema.safeParse(Array.from({ length: SCENE_LIMITS.nodes + 1 }, () => null)).success).toBe(
      false,
    );
    expect(() => SceneDescriptorSchema.parseJson(' '.repeat(SCENE_LIMITS.bytes + 1))).toThrow(SceneParseError);
    expect(() => SceneDescriptorSchema.parseJson('"' + '🌎'.repeat(70_000) + '"')).toThrow(SceneParseError);
    expect(
      SceneDescriptorSchema.safeParse({ ...descriptorFixture(), label: 'a'.repeat(SCENE_LIMITS.bytes) }).success,
    ).toBe(false);
  });
  it('admits a maximum object chunk without making arbitrary missing parents', () => {
    const chunk = { ...chunkFixture(), objects: Array.from({ length: 100 }, (_, i) => descriptorFixture(i + 1)) };
    expect(SceneChunkSchema.parse(chunk).objects).toHaveLength(100);
  });
  it('never executes functions/getters/toJSON during failed parsing', () => {
    const callback = vi.fn(() => 'bad');
    for (const input of [
      callback,
      { ...descriptorFixture(), toJSON: callback },
      Object.defineProperty(descriptorFixture(), 'label', { get: callback }),
      { ...descriptorFixture(), label: callback },
    ]) {
      expect(SceneDescriptorSchema.safeParse(input).success).toBe(false);
    }
    expect(callback).not.toHaveBeenCalled();
    expect(() => SceneDescriptorSchema.parseJson('{"seed": (()=>{throw 1})()}')).toThrow(SceneParseError);
    expect(() => SceneDescriptorSchema.parseJson('{"__proto__":{}}')).toThrow(SceneParseError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(SceneDescriptorSchema.safeParse(cyclic).success).toBe(false);
  });
});

describe('pure portable family geometry', () => {
  it('is deterministic and pinned for a fixed family/seed', () => {
    const a = buildSceneGeometry(descriptorFixture(), full);
    expect(buildSceneGeometry(descriptorFixture(), full)).toEqual(a);
    expect(a.radius).toBe(52);
    expect(a.silhouette).toHaveLength(64);
  });
  it('retains old geometry/anchors/targets when unrelated siblings arrive or reorder', () => {
    const original = chunkFixture();
    const before = buildSceneGeometry(original.objects[0], full);
    const after = SceneChunkSchema.parse({ ...original, objects: [descriptorFixture(2), ...original.objects] });
    expect(
      buildSceneGeometry(
        after.objects.find((o) => o.objectId === fixtureId(1)),
        full,
      ),
    ).toEqual(before);
  });
  it('low detail and reduced motion preserve semantic identity and exact silhouette anchors', () => {
    const descriptor = { ...descriptorFixture(), activity: { availability: 'available', state: 'active' } };
    const a = buildSceneGeometry(descriptor, full);
    const b = buildSceneGeometry(descriptor, low);
    const { silhouette: _a, motion: _m, ...identity } = a;
    expect(b).toMatchObject(identity);
    expect(b.silhouette).toEqual(a.silhouette.filter((_, i) => i % 4 === 0));
    expect(a.motion).toBe('gentle');
    expect(b.motion).toBe('still');
    expect(b.truthStatus).toBe('hypothetical');
  });
  it('family controls recognisable shape/size; seed variation does not select a family', () => {
    const families: SceneFamily[] = ['terraced.v1', 'ridged.v1', 'archipelago.v1'];
    const geometries = families.map((family) => buildSceneGeometry({ ...descriptorFixture(), family }, full));
    expect(geometries.map((g) => g.radius)).toEqual([52, 60, 56]);
    const changed = buildSceneGeometry({ ...descriptorFixture(), seed: '0'.repeat(32) }, full);
    expect(changed.radius).toBe(geometries[0]?.radius);
    expect(changed.silhouette).not.toEqual(geometries[0]?.silhouette);
  });
  it('activity never forms, deletes, scales or reshapes geometry; unavailable remains unavailable', () => {
    const unavailable = buildSceneGeometry(descriptorFixture(), full);
    for (const state of ['active', 'quiet']) {
      const active = buildSceneGeometry(
        { ...descriptorFixture(), activity: { availability: 'available', state } },
        full,
      );
      expect(active.silhouette).toEqual(unavailable.silhouette);
      expect(active.radius).toBe(unavailable.radius);
      expect(active.objectId).toBe(unavailable.objectId);
    }
    expect(unavailable.activity).toEqual({ availability: 'unavailable' });
  });
  it('bounds all outputs for many fixed seeds and boundary parameters', () => {
    for (const family of ['terraced.v1', 'ridged.v1', 'archipelago.v1'])
      for (let seed = 0; seed < 64; seed++) {
        const output = buildSceneGeometry(
          {
            ...descriptorFixture(),
            family,
            seed: seed.toString(16).padStart(32, '0'),
            detail: { roughness: seed % 2 },
            atmosphere: { density: seed % 2 },
          },
          full,
        );
        for (const point of output.silhouette) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(output.radius * 1.26);
          expect(Math.hypot(point.x, point.y)).toBeGreaterThan(output.radius * 0.74);
        }
        expect(output.atmosphereRadius).toBeLessThanOrEqual(output.radius * 1.45 + 0.000001);
      }
  });
  it('never mutates caller data and rejects hostile options without calling accessors', () => {
    const descriptor = descriptorFixture();
    const copy = structuredClone(descriptor);
    const output = buildSceneGeometry(descriptor, full);
    output.anchor.x = 900;
    output.target.objectId = fixtureId(9);
    expect(descriptor).toEqual(copy);
    const callback = vi.fn(() => 'full');
    const options = Object.defineProperty({ reducedMotion: false }, 'detail', { get: callback });
    expect(() => buildSceneGeometry(descriptor, options as typeof full)).toThrow(SceneParseError);
    expect(callback).not.toHaveBeenCalled();
    expect(() => buildSceneGeometry(descriptor, { ...full, detail: 'ultra' } as unknown as typeof full)).toThrow(
      SceneParseError,
    );
  });
});
