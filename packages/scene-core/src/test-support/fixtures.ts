import type { SceneChunk, SceneDescriptor, SceneManifest } from '../index.js';

/** Synthetic CI data only. No authored design worlds or invented runtime geography. */
export const fixtureId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function descriptorFixture(n = 1): SceneDescriptor {
  return {
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId: fixtureId(n),
    parentId: fixtureId(1000),
    kind: 'planet',
    originTransitionId: fixtureId(2000),
    label: 'Synthetic fixture',
    truthStatus: 'hypothetical',
    activity: { availability: 'unavailable' },
    family: 'terraced.v1',
    seed: '1234567890abcdef1234567890abcdef',
    palette: 'cobalt',
    material: 'banded',
    atmosphere: { density: 0.4 },
    detail: { roughness: 0.6 },
    anchor: { x: 250, y: -70, layer: 2 },
    target: { kind: 'planet', objectId: fixtureId(n) },
  };
}
export function chunkFixture(): SceneChunk {
  return {
    schemaVersion: 'scene-chunk.v1',
    chunkId: fixtureId(3000),
    revisions: {
      geographyRevision: 9,
      structureRevision: 7,
      activityRevision: 9,
      sceneRevision: 3,
      personalRevision: 12,
    },
    objects: [descriptorFixture()],
    routes: [],
  };
}
export function manifestFixture(): SceneManifest {
  const chunk = chunkFixture();
  return {
    schemaVersion: 'scene-manifest.v1',
    revisions: chunk.revisions,
    chunks: [{ chunkId: chunk.chunkId, sceneRevision: 3, objectIds: chunk.objects.map((o) => o.objectId) }],
  };
}
