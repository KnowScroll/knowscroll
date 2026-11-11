import { describe, expect, it } from 'vitest';
import type { SceneChunk, SceneClientCapabilities, SceneManifest } from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { makeReadSceneChunk, makeReadSceneManifest } from './read.js';
import type { ScenePorts, SceneState } from './ports.js';

const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const universeId = uuid(1);
const authority = { universeId, privacyEpoch: 1 } as unknown as PersonalAuthority;
const revisions = {
  geographyRevision: 4,
  structureRevision: 4,
  activityRevision: 4,
  sceneRevision: 4,
  personalRevision: 7,
};
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};

/** A map of `count` chunks, one system each. Authored and empty: the read only needs their identity. */
function world(count: number) {
  const ids = Array.from({ length: count }, (_, n) => uuid(100 + n));
  const chunks = new Map<string, SceneChunk>(
    ids.map((chunkId) => [chunkId, { schemaVersion: 'scene-chunk.v1', chunkId, revisions, objects: [], routes: [] }]),
  );
  const manifest: SceneManifest = {
    schemaVersion: 'scene-manifest.v1',
    revisions,
    chunks: ids.map((chunkId) => ({ chunkId, sceneRevision: 4, objectIds: [] })),
  };
  const loaded: string[] = [];
  const ports = {
    withScope: async (_authority: unknown, work: (scope: unknown) => Promise<unknown>) => ({
      kind: 'entered',
      value: await work({ authority: { universeId, privacyEpoch: 1 }, revisionAtEntry: 7 }),
    }),
    ownerActive: () => Promise.resolve(true),
    readInput: () =>
      Promise.resolve({
        kind: 'read',
        input: {
          universeId,
          privacyEpoch: 1,
          personalRevision: 7,
          geography: { revision: 4, structureRevision: 4, activityRevision: 4 },
          objects: [],
          routes: [],
          aliases: [],
        },
      }),
    store: {
      state: () =>
        Promise.resolve({
          policyVersion: 'canonical-lattice.v1',
          routeChunks: [],
          worldSeed: 'ci',
          manifest,
        } as SceneState),
      chunk: (_scope: unknown, id: string) => {
        loaded.push(id);
        const chunk = chunks.get(id);
        return Promise.resolve(chunk ? { systemId: uuid(9), chunk } : undefined);
      },
      pending: () => Promise.resolve(undefined),
      looks: () => Promise.resolve([]),
    },
    now: () => new Date('2026-11-11T00:00:00.000Z'),
  } as unknown as ScenePorts;
  const reference = (chunkId: string) => ({
    universeId,
    privacyEpoch: 1,
    manifestSceneRevision: 4,
    chunkId,
    chunkSceneRevision: 4,
  });
  return { ids, ports, loaded, reference };
}

describe('Scene reads load what they are asked for (#674)', () => {
  it('reads one chunk from storage for a chunk read, however many chunks the map has', async () => {
    const { ids, ports, loaded, reference } = world(12);
    const read = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'universe' },
      capabilities,
      reference: reference(ids[5]!),
    });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'ready', chunk: { chunkId: ids[5] } } });
    expect(loaded).toEqual([ids[5]]);
  });

  it('answers an unknown chunk without loading any', async () => {
    const { ports, loaded, reference } = world(12);
    const read = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'universe' },
      capabilities,
      reference: reference(uuid(999)),
    });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'unknown_chunk' } });
    expect(loaded).toEqual([]);
  });

  it('still lists every chunk of the map once for the manifest read', async () => {
    const { ids, ports, loaded } = world(12);
    const read = await makeReadSceneManifest(ports)(authority, { selection: { kind: 'universe' }, capabilities });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
    expect([...loaded].sort()).toEqual([...ids].sort());
  });
});
