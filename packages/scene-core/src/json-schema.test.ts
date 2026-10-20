import { describe, expect, it } from 'vitest';
import {
  SCENE_LIMITS,
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
} from './index.js';
import { descriptorFixture, chunkFixture, manifestFixture } from './test-support/fixtures.js';

describe('canonical scene structural documentation', () => {
  it('enumerates every field of valid canonical fixtures, strict nested objects and versions', () => {
    for (const [schema, data] of [
      [SceneDescriptorJsonSchema, SceneDescriptorSchema.parse(descriptorFixture())],
      [SceneChunkJsonSchema, SceneChunkSchema.parse(chunkFixture())],
      [SceneManifestJsonSchema, SceneManifestSchema.parse(manifestFixture())],
    ] as const) {
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required?.toSorted()).toEqual(Object.keys(data).toSorted());
      expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual(Object.keys(data).toSorted());
      expect(schema.properties?.['schemaVersion']?.const).toBe(data.schemaVersion);
    }
    for (const field of ['atmosphere', 'detail', 'anchor', 'target'])
      expect(SceneDescriptorJsonSchema.properties?.[field]?.additionalProperties).toBe(false);
    expect(SceneDescriptorJsonSchema.properties?.['family']?.enum).toEqual([
      'terraced.v1',
      'ridged.v1',
      'archipelago.v1',
    ]);
    expect(SceneDescriptorJsonSchema.properties?.['generatorVersion']?.const).toBe('silhouette.v1');
    expect(SceneReturnLocatorJsonSchema.required).toEqual(['schemaVersion', 'chunkId', 'objectId', 'frame']);
    expect(SceneReturnLocatorJsonSchema.properties?.['frame']?.additionalProperties).toBe(false);
  });

  it('keeps documented caps tied to the owning parser limits without claiming host-object validation', () => {
    expect(SceneChunkJsonSchema.properties?.['objects']?.maxItems).toBe(SCENE_LIMITS.objectsPerChunk);
    expect(SceneChunkJsonSchema.properties?.['routes']?.maxItems).toBe(SCENE_LIMITS.routesPerChunk);
    const references = SceneManifestJsonSchema.properties?.['chunks'];
    expect(references?.maxItems).toBe(SCENE_LIMITS.chunksPerManifest);
    expect(references?.items?.properties?.['objectIds']?.maxItems).toBe(SCENE_LIMITS.objectsPerChunk);
    expect(references?.items?.properties?.['objectIds']?.uniqueItems).toBe(true);
    expect(SceneDescriptorJsonSchema.properties?.['anchor']?.properties?.['x']).toEqual({
      type: 'number',
      minimum: -SCENE_LIMITS.coordinate,
      maximum: SCENE_LIMITS.coordinate,
    });
    expect(SceneReturnLocatorJsonSchema.properties?.['frame']?.properties?.['scale']).toEqual({
      type: 'number',
      minimum: 0.125,
      maximum: 16,
    });
  });
});
