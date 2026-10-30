import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ReadSceneChunkSchema,
  ReadSceneManifestSchema,
  SceneChunkReadSchema,
  SceneChunkWireSchema,
  SceneClientCapabilitiesSchema,
  SceneDescriptorWireSchema,
  SceneManifestReadSchema,
  SceneManifestWireSchema,
  SceneReturnLocatorWireSchema,
  SCENE_LIMITS,
  supportsSceneLooks,
  supportsSceneV1,
  type SceneChunk,
  type SceneManifest,
} from './index.js';

// Synthetic protocol fixtures only: no real geography, projection, renderer or runtime claim.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const capabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const object = {
  schemaVersion: 'scene-descriptor.v1',
  generatorVersion: 'silhouette.v1',
  objectId: id(1),
  parentId: id(2),
  kind: 'planet',
  originTransitionId: id(3),
  label: 'Synthetic place',
  truthStatus: 'hypothetical',
  activity: { availability: 'unavailable' },
  family: 'terraced.v1',
  seed: '1234567890abcdef1234567890abcdef',
  palette: 'cobalt',
  material: 'banded',
  atmosphere: { density: 0.4 },
  detail: { roughness: 0.6 },
  anchor: { x: 250, y: -70, layer: 2 },
  target: { kind: 'planet', objectId: id(1) },
};
const revisions = {
  geographyRevision: 9,
  structureRevision: 7,
  activityRevision: 9,
  sceneRevision: 3,
  personalRevision: 12,
};
const chunk = { schemaVersion: 'scene-chunk.v1', chunkId: id(4), revisions, objects: [object], routes: [] };
const manifest = {
  schemaVersion: 'scene-manifest.v1',
  revisions,
  chunks: [{ chunkId: id(4), sceneRevision: 3, objectIds: [id(1)] }],
};
const scope = { universeId: id(5), privacyEpoch: 2, personalWatermark: 15 };
const currentGeography = { revision: 9, structureRevision: 7, activityRevision: 9 };
const selection = { kind: 'universe' };
const common = {
  scope,
  currentGeography,
  selection,
  capabilities,
  recordedAt: '2026-10-21T10:00:00.000Z',
  sceneRevision: 3,
};
const ready = { version: 'scene-manifest-read.v1', ...common, status: 'ready', manifest };
const reference = {
  universeId: scope.universeId,
  privacyEpoch: scope.privacyEpoch,
  manifestSceneRevision: 3,
  chunkId: id(4),
  chunkSceneRevision: 3,
};
const chunkReady = { version: 'scene-chunk-read.v1', ...common, status: 'ready', reference, chunk };
const locator = {
  schemaVersion: 'scene-return.v1',
  chunkId: id(4),
  objectId: id(1),
  frame: { x: 250.125, y: -70.5, scale: 1.5 },
};

function refusesManifest(patch: Record<string, unknown>): void {
  expect(SceneManifestReadSchema.safeParse({ ...ready, ...patch }).success).toBe(false);
}

describe('scene HTTP declaration-only contracts', () => {
  it('keeps typed canonical data and JSON-native wire shapes without transformation', () => {
    expectTypeOf(SceneChunkWireSchema.parse(chunk)).toEqualTypeOf<SceneChunk>();
    expectTypeOf(SceneManifestWireSchema.parse(manifest)).toEqualTypeOf<SceneManifest>();
    expect(SceneDescriptorWireSchema.parse(object)).toBe(object);
    expect(SceneChunkWireSchema.parse(chunk)).toBe(chunk);
    expect(SceneManifestWireSchema.parse(manifest)).toBe(manifest);
    expect(SceneManifestReadSchema.parse(ready)).toEqual(ready);
    expect(SceneChunkReadSchema.parse(chunkReady)).toEqual(chunkReady);
    expect(SceneReturnLocatorWireSchema.parse(locator)).toBe(locator);
  });

  it('bounds version advertisements, retains unknown versions and refuses duplicate or hostile capability data', () => {
    const parsed = SceneClientCapabilitiesSchema.parse(capabilities);
    expect(supportsSceneV1(parsed)).toBe(true);
    for (const field of ['descriptors', 'chunks', 'manifests', 'generators', 'families']) {
      const unknown = { ...capabilities, [field]: ['future.v2'] };
      expect(SceneClientCapabilitiesSchema.safeParse(unknown).success).toBe(true);
      refusesManifest({ capabilities: unknown });
      const unsupported = { version: ready.version, ...common, capabilities: unknown, status: 'unsupported_version' };
      expect(SceneManifestReadSchema.parse(unsupported)).toEqual(unsupported);
      expect(SceneManifestReadSchema.safeParse({ ...unsupported, manifest }).success).toBe(false);
      for (const versions of [
        ['future.v2', 'future.v2'],
        Array.from({ length: 9 }, (_, i) => `future.v${i + 1}`),
        ['<svg>'],
        ['https://private'],
        ['future.v0'],
        ['x'.repeat(65)],
      ])
        expect(SceneClientCapabilitiesSchema.safeParse({ ...capabilities, [field]: versions }).success).toBe(false);
    }
    expect(
      SceneManifestReadSchema.safeParse({ ...common, version: ready.version, status: 'unsupported_version' }).success,
    ).toBe(false);
    expect(SceneClientCapabilitiesSchema.safeParse({ ...capabilities, detail: 'ultra' }).success).toBe(false);
    expect(SceneClientCapabilitiesSchema.safeParse({ ...capabilities, reducedMotion: 'true' }).success).toBe(false);
    expect(SceneClientCapabilitiesSchema.safeParse({ ...capabilities, userAgent: 'private' }).success).toBe(false);
  });

  it('keeps empty, actual pending projection, lag and unavailability distinct', () => {
    const empty = { ...ready, status: 'empty', manifest: { ...manifest, chunks: [] } };
    expect(SceneManifestReadSchema.parse(empty)).toEqual(empty);
    refusesManifest({ manifest: { ...manifest, chunks: [] } });
    refusesManifest({ status: 'empty' });
    const loading = {
      version: ready.version,
      ...common,
      status: 'loading',
      pendingProjection: { geographyRevision: 9, personalRevision: 15 },
    };
    expect(SceneManifestReadSchema.parse(loading)).toEqual(loading);
    expect(SceneManifestReadSchema.safeParse({ ...loading, manifest }).success).toBe(false);
    const { pendingProjection: _pending, ...missingWork } = loading;
    expect(SceneManifestReadSchema.safeParse(missingWork).success).toBe(false);
    const lagging = {
      ...ready,
      status: 'lagging',
      currentGeography: { revision: 10, structureRevision: 10, activityRevision: 9 },
      pendingProjection: { geographyRevision: 10, personalRevision: 15 },
    };
    expect(SceneManifestReadSchema.parse(lagging)).toEqual(lagging);
    expect(
      SceneManifestReadSchema.safeParse({
        ...lagging,
        pendingProjection: { geographyRevision: 9, personalRevision: 12 },
      }).success,
    ).toBe(false);
    expect(
      SceneManifestReadSchema.safeParse({
        ...lagging,
        pendingProjection: { geographyRevision: 11, personalRevision: 15 },
      }).success,
    ).toBe(false);
    expect(
      SceneManifestReadSchema.safeParse({
        ...lagging,
        pendingProjection: { geographyRevision: 10, personalRevision: 16 },
      }).success,
    ).toBe(false);
    for (const pendingProjection of [
      { geographyRevision: 8, personalRevision: 15 },
      { geographyRevision: 10, personalRevision: 11 },
    ])
      expect(SceneManifestReadSchema.safeParse({ ...lagging, pendingProjection }).success).toBe(false);
    for (const reason of ['temporarily_unavailable', 'limit']) {
      const unavailable = { version: ready.version, ...common, status: 'unavailable', reason };
      expect(SceneManifestReadSchema.parse(unavailable)).toEqual(unavailable);
      expect(SceneManifestReadSchema.safeParse({ ...unavailable, manifest }).success).toBe(false);
    }
  });

  it('fences current scope and independent projection stamps without equating unrelated revisions', () => {
    // Geography 9, scene 3 and personal input 12/current root 15 are intentionally distinct.
    expect(SceneManifestReadSchema.safeParse(ready).success).toBe(true);
    refusesManifest({ scope: { ...scope, privacyEpoch: 0 } });
    refusesManifest({ scope: { ...scope, personalWatermark: 11 } });
    refusesManifest({ sceneRevision: 4 });
    refusesManifest({ currentGeography: { revision: 10, structureRevision: 10, activityRevision: 9 } });
    for (const revisionsPatch of [
      { geographyRevision: 10 },
      { structureRevision: 10 },
      { activityRevision: 10 },
      { personalRevision: 16 },
    ])
      refusesManifest({ manifest: { ...manifest, revisions: { ...revisions, ...revisionsPatch } } });
    refusesManifest({ manifest: { ...manifest, chunks: [{ ...manifest.chunks[0], sceneRevision: 4 }] } });
    refusesManifest({ scope: { ...scope, ownerId: id(100) } });
  });

  it('binds exact scoped manifest/chunk references and refuses stale or unknown payloads', () => {
    const query = { selection, capabilities, reference };
    expect(ReadSceneChunkSchema.parse(query)).toEqual(query);
    for (const patch of [
      { manifestSceneRevision: 2 },
      { chunkId: id(99) },
      { chunkSceneRevision: 2 },
      { universeId: id(99) },
      { privacyEpoch: 1 },
    ])
      expect(SceneChunkReadSchema.safeParse({ ...chunkReady, reference: { ...reference, ...patch } }).success).toBe(
        false,
      );
    for (const reason of ['stale_manifest', 'unknown_chunk', 'temporarily_unavailable', 'limit']) {
      const unavailable = { version: chunkReady.version, ...common, status: 'unavailable', reference, reason };
      expect(SceneChunkReadSchema.parse(unavailable)).toEqual(unavailable);
      expect(SceneChunkReadSchema.safeParse({ ...unavailable, chunk }).success).toBe(false);
    }
    const stale = {
      version: chunkReady.version,
      ...common,
      status: 'unavailable',
      reference: { ...reference, manifestSceneRevision: 2, chunkSceneRevision: 2 },
      reason: 'stale_manifest',
    };
    expect(SceneChunkReadSchema.parse(stale)).toEqual(stale);
    const unsupported = {
      version: chunkReady.version,
      ...common,
      capabilities: { ...capabilities, generators: [] },
      status: 'unsupported_version',
      reference,
    };
    expect(SceneChunkReadSchema.parse(unsupported)).toEqual(unsupported);
    expect(SceneChunkReadSchema.safeParse({ ...unsupported, chunk }).success).toBe(false);
    const emptyChunk = { ...chunkReady, chunk: { ...chunk, objects: [] } };
    expect(SceneChunkReadSchema.parse(emptyChunk)).toEqual(emptyChunk);
  });

  it('keeps detail, reduced motion and private exact-return metadata out of authority', () => {
    for (const detail of ['full', 'low'])
      for (const reducedMotion of [false, true]) {
        const result = SceneChunkReadSchema.parse({
          ...chunkReady,
          capabilities: { ...capabilities, detail, reducedMotion },
        });
        expect(result.status).toBe('ready');
        if (result.status === 'ready') expect(result.chunk).toEqual(chunk);
      }
    expect(SceneReturnLocatorWireSchema.parse(locator)).toEqual(locator);
    for (const extra of [
      { returnLocator: locator },
      { shown: true },
      { skipped: true },
      { commandId: id(20) },
      { ownerId: id(21) },
      { universeId: scope.universeId },
    ]) {
      expect(ReadSceneManifestSchema.safeParse({ selection, capabilities, ...extra }).success).toBe(false);
      expect(ReadSceneChunkSchema.safeParse({ selection, capabilities, reference, ...extra }).success).toBe(false);
    }
    expect(
      ReadSceneManifestSchema.safeParse({ selection: { kind: 'visit', accountId: id(99) }, capabilities }).success,
    ).toBe(false);
    expect(
      ReadSceneManifestSchema.safeParse({
        selection: { kind: 'system', systemId: id(2), ownerId: id(99) },
        capabilities,
      }).success,
    ).toBe(false);
    expect(
      ReadSceneChunkSchema.safeParse({
        selection,
        capabilities,
        reference: { ...reference, assetUrl: 'https://private' },
      }).success,
    ).toBe(false);
    expect(SceneReturnLocatorWireSchema.safeParse({ ...locator, frame: { ...locator.frame, scale: 17 } }).success).toBe(
      false,
    );
  });

  it('preserves canonical strict nested, version, identity and executable-data refusals', () => {
    for (const invalid of [
      { ...object, schemaVersion: 'scene-descriptor.v2' },
      { ...object, generatorVersion: 'silhouette.v2' },
      { ...object, family: 'other.v1' },
      { ...object, label: '<svg onload=run()>' },
      { ...object, seed: 'javascript:run()' },
      { ...object, target: { ...object.target, objectId: id(99) } },
      { ...object, anchor: { ...object.anchor, x: Number.POSITIVE_INFINITY } },
      { ...object, anchor: { ...object.anchor, x: SCENE_LIMITS.coordinate + 1 } },
      { ...object, detail: { ...object.detail, script: 'run()' } },
      { ...object, activity: { availability: 'unavailable', score: 1 } },
      { ...object, atmosphere: { density: 0.4, assetUrl: 'https://private' } },
    ]) {
      expect(SceneDescriptorWireSchema.safeParse(invalid).success).toBe(false);
      expect(SceneChunkReadSchema.safeParse({ ...chunkReady, chunk: { ...chunk, objects: [invalid] } }).success).toBe(
        false,
      );
    }
    for (const field of [
      'html',
      'svg',
      'assetUrl',
      'evidenceRefs',
      'score',
      'sources',
      'prompt',
      'provider',
      'eligible',
    ]) {
      const extra = { [field]: 'private' };
      expect(SceneDescriptorWireSchema.safeParse({ ...object, ...extra }).success).toBe(false);
      expect(SceneChunkWireSchema.safeParse({ ...chunk, ...extra }).success).toBe(false);
      expect(SceneManifestWireSchema.safeParse({ ...manifest, ...extra }).success).toBe(false);
      refusesManifest(extra);
    }
    expect(SceneChunkWireSchema.safeParse({ ...chunk, objects: [object, object] }).success).toBe(false);
    expect(
      SceneManifestWireSchema.safeParse({ ...manifest, chunks: [manifest.chunks[0], manifest.chunks[0]] }).success,
    ).toBe(false);
  });

  it('keeps canonical byte, count and host-object guards authoritative at the wire wrapper', () => {
    let invoked = false;
    const hostile = { ...object };
    Object.defineProperty(hostile, 'label', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('Must not execute');
      },
    });
    expect(SceneDescriptorWireSchema.safeParse(hostile).success).toBe(false);
    expect(invoked).toBe(false);
    expect(
      SceneChunkWireSchema.safeParse({
        ...chunk,
        toJSON() {
          invoked = true;
          return chunk;
        },
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
    const tooMany = Array.from({ length: SCENE_LIMITS.objectsPerChunk + 1 }, (_, i) => ({
      ...object,
      objectId: id(i + 10),
      target: { kind: 'planet', objectId: id(i + 10) },
    }));
    expect(SceneChunkWireSchema.safeParse({ ...chunk, objects: tooMany }).success).toBe(false);
    expect(
      SceneManifestWireSchema.safeParse({
        ...manifest,
        chunks: Array.from({ length: SCENE_LIMITS.chunksPerManifest + 1 }, (_, i) => ({
          chunkId: id(i + 100),
          sceneRevision: 3,
          objectIds: [],
        })),
      }).success,
    ).toBe(false);
    // A full bounded chunk remains valid; aggregate manifests still have a total UTF-8 ceiling.
    const objects = Array.from({ length: 100 }, (_, i) => ({
      ...object,
      label: '界'.repeat(160),
      objectId: id(i + 100),
      target: { kind: 'planet', objectId: id(i + 100) },
    }));
    const routes = Array.from({ length: 100 }, (_, i) => ({
      id: id(i + 1000),
      fromObjectId: id(1),
      toObjectId: id(2),
      originTransitionId: id(3),
      truthStatus: 'factual',
    }));
    // Repeated bounded chunks with distinct IDs/object IDs exceed the manifest byte ceiling.
    const oversizedManifest = {
      ...manifest,
      chunks: Array.from({ length: 128 }, (_, i) => ({
        chunkId: id(i + 2000),
        sceneRevision: 3,
        objectIds: Array.from({ length: 60 }, (_, j) => id(10000 + i * 100 + j)),
      })),
    };
    expect(SceneManifestWireSchema.safeParse(oversizedManifest).success).toBe(false);
    expect(SceneChunkWireSchema.safeParse({ ...chunk, objects, routes }).success).toBe(true);
  });
});

describe('look data on the manifest read (D-102)', () => {
  const lookCapabilities = {
    ...capabilities,
    generators: ['silhouette.v1', 'worldmap.v1'],
    looks: ['scene-look.v1'],
  };
  const lookBase = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1' };
  const planetLook = {
    ...lookBase,
    objectId: id(1),
    kind: 'planet',
    type: 'ocean',
    rings: false,
    moon: true,
    hueShift: 12,
    variant: 0,
    siteCount: 3,
  };
  const withLooks = { ...ready, capabilities: lookCapabilities, looks: [planetLook] };

  it('keeps an old client exactly as it was: no look capability, no looks', () => {
    expect(supportsSceneLooks(SceneClientCapabilitiesSchema.parse(capabilities))).toBe(false);
    expect(SceneManifestReadSchema.parse(ready)).toEqual(ready);
    expect(SceneManifestReadSchema.safeParse({ ...ready, looks: [planetLook] }).success).toBe(false);
    expect(SceneClientCapabilitiesSchema.parse(capabilities)).not.toHaveProperty('looks');
  });

  it('carries the looks of the objects in the manifest to a client that declared them', () => {
    expect(supportsSceneLooks(SceneClientCapabilitiesSchema.parse(lookCapabilities))).toBe(true);
    expect(SceneManifestReadSchema.parse(withLooks)).toEqual(withLooks);
    const empty = { ...withLooks, looks: [] };
    expect(SceneManifestReadSchema.parse(empty)).toEqual(empty);
    const lagging = {
      ...withLooks,
      status: 'lagging',
      currentGeography: { revision: 10, structureRevision: 10, activityRevision: 9 },
      pendingProjection: { geographyRevision: 10, personalRevision: 15 },
    };
    expect(SceneManifestReadSchema.parse(lagging)).toEqual(lagging);
  });

  it('requires looks when declared, and refuses a look for an object the manifest does not hold, or twice', () => {
    const { looks: _omitted, ...without } = withLooks;
    expect(SceneManifestReadSchema.safeParse(without).success).toBe(false);
    expect(
      SceneManifestReadSchema.safeParse({ ...withLooks, looks: [{ ...planetLook, objectId: id(77) }] }).success,
    ).toBe(false);
    expect(SceneManifestReadSchema.safeParse({ ...withLooks, looks: [planetLook, planetLook] }).success).toBe(false);
    expect(SceneManifestReadSchema.safeParse({ ...withLooks, looks: [{ ...planetLook, type: 'toxic' }] }).success).toBe(
      false,
    );
  });

  it('needs both the look version and the pinned generator to count as supporting looks', () => {
    for (const patch of [
      { looks: ['scene-look.v2'] },
      { looks: [] },
      { generators: ['silhouette.v1'] },
      { looks: undefined },
    ])
      expect(supportsSceneLooks(SceneClientCapabilitiesSchema.parse({ ...lookCapabilities, ...patch }))).toBe(false);
    // A client that declares looks but is otherwise unsupported still gets the explicit fallback.
    const unsupported = { ...lookCapabilities, descriptors: ['scene-descriptor.v2'] };
    expect(supportsSceneLooks(SceneClientCapabilitiesSchema.parse(unsupported))).toBe(false);
  });

  it('does not allow looks on a status that carries no manifest', () => {
    const loading = {
      version: ready.version,
      ...common,
      capabilities: lookCapabilities,
      status: 'loading',
      pendingProjection: { geographyRevision: 9, personalRevision: 12 },
    };
    expect(SceneManifestReadSchema.parse(loading)).toEqual(loading);
    expect(SceneManifestReadSchema.safeParse({ ...loading, looks: [planetLook] }).success).toBe(false);
  });
});
