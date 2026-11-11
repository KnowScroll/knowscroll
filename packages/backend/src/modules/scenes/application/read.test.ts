import { describe, expect, it } from 'vitest';
import {
  SceneDescriptorSchema,
  type SceneChunk,
  type SceneClientCapabilities,
  type SceneDescriptor,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { makeReadSceneChunk, makeReadSceneManifest } from './read.js';
import { makeReadSceneSky } from './read-sky.js';
import type { ChunkHead, LegacyFit, ScenePorts, SceneState, SkyRow } from './ports.js';

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
const skyCapabilities: SceneClientCapabilities = {
  ...capabilities,
  generators: ['silhouette.v1', 'worldmap.v1'],
  looks: ['scene-look.v1'],
  sky: ['scene-sky.v1'],
};

function descriptor(n: number): SceneDescriptor {
  return SceneDescriptorSchema.parse({
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId: uuid(n),
    parentId: universeId,
    kind: 'system',
    originTransitionId: uuid(9000),
    label: `System ${n}`,
    truthStatus: 'factual',
    activity: { availability: 'available', state: 'active' },
    family: 'terraced.v1',
    seed: 'a'.repeat(32),
    palette: 'ochre',
    material: 'solid',
    atmosphere: { density: 0.15 },
    detail: { roughness: 0.4 },
    anchor: { x: n * 900, y: 0, layer: 0 },
    target: { kind: 'system', objectId: uuid(n) },
  });
}

/**
 * A map of `count` systems, each with one chunk. Authored: the reads only need identity, so the chunks are empty
 * but for what a manifest reference names. `calls` records what each read asked storage for.
 */
function world(
  count: number,
  options: { fit?: Partial<LegacyFit>; state?: Partial<SceneState>; objectCount?: number; pending?: boolean } = {},
) {
  const systems = Array.from({ length: count }, (_, n) => uuid(100 + n));
  const heads: ChunkHead[] = systems.map((systemId, n) => ({
    systemId,
    chunkId: uuid(300 + n),
    sceneRevision: 4,
    objectIds: [uuid(500 + n)],
  }));
  const calls: { method: string; args: unknown[] }[] = [];
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const state: SceneState = {
    policyVersion: 'canonical-lattice.v2',
    worldSeed: 'ci',
    projected: revisions,
    layout: { legacyReach: 0, nextCell: count },
    ...options.state,
  };
  const ports = {
    withScope: async (_authority: unknown, work: (scope: unknown) => Promise<unknown>) => ({
      kind: 'entered',
      value: await work({ authority: { universeId, privacyEpoch: 1 }, revisionAtEntry: 7 }),
    }),
    ownerActive: () => Promise.resolve(true),
    readInput: (_scope: unknown, selection: unknown) => {
      note('readInput', selection);
      return Promise.resolve({
        kind: 'read',
        input: {
          universeId,
          privacyEpoch: 1,
          personalRevision: 7,
          geography: { revision: 4, structureRevision: 4, activityRevision: 4 },
          objectCount: options.objectCount ?? count,
          objects: [],
          routes: [],
          aliases: [],
        },
      });
    },
    store: {
      state: () => Promise.resolve(state),
      systems: (_scope: unknown, ids: readonly string[]) => {
        note('systems', ids);
        return Promise.resolve(
          ids
            .filter((id) => systems.includes(id))
            .map((systemId) => ({ systemId, cell: 0, planetCount: 0, objectCount: 1, sceneRevision: 4 })),
        );
      },
      chunkHeads: (_scope: unknown, systemId?: string) => {
        note('chunkHeads', systemId);
        return Promise.resolve(systemId === undefined ? heads : heads.filter((head) => head.systemId === systemId));
      },
      chunk: (_scope: unknown, chunkId: string, revision: number) => {
        note('chunk', chunkId, revision);
        const head = heads.find((h) => h.chunkId === chunkId);
        if (!head || head.sceneRevision !== revision) return Promise.resolve(undefined);
        const chunk: SceneChunk = {
          schemaVersion: 'scene-chunk.v1',
          chunkId,
          revisions,
          objects: [],
          routes: [
            {
              id: uuid(900),
              fromObjectId: uuid(901),
              toObjectId: uuid(902),
              originTransitionId: uuid(9000),
              truthStatus: 'factual',
            },
          ],
        };
        return Promise.resolve({ systemId: head.systemId, chunk, current: chunkId !== uuid(399) });
      },
      legacyFit: () => {
        note('legacyFit');
        return Promise.resolve({ objects: count, anchor: 900, variant: 3, ...options.fit });
      },
      looksOf: (_scope: unknown, ids: readonly string[]) => {
        note('looksOf', ids);
        return Promise.resolve([]);
      },
      pending: () => Promise.resolve(options.pending ? { geographyRevision: 4, personalRevision: 7 } : undefined),
      sky: (_scope: unknown, query: { after?: string; limit: number; since?: number }) => {
        note('sky', query);
        const rows: SkyRow[] = systems
          .filter((id) => query.after === undefined || id > query.after)
          .slice(0, query.limit)
          .map((id, n) => ({
            descriptor: descriptor(Number(id.slice(-4))),
            haze: n % 2 ? 'teal' : 'amber',
            planetCount: 3,
            sceneRevision: 4,
          }));
        return Promise.resolve(rows);
      },
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
  const only = (method: string) => calls.filter((c) => c.method === method);
  return { systems, heads, ports, calls, only, reference };
}

describe('Scene reads load what they are asked for (#674, D-417)', () => {
  it('reads one chunk from storage for a chunk read, however many chunks the map has', async () => {
    const { heads, ports, only, reference } = world(12);
    const read = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'universe' },
      capabilities,
      reference: reference(heads[5]!.chunkId),
    });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'ready', chunk: { chunkId: heads[5]!.chunkId } } });
    expect(only('chunk')).toHaveLength(1);
    expect(only('chunkHeads')).toHaveLength(0);
  });
  it('answers an unknown chunk, and a chunk that is not the newest of its id, without serving it', async () => {
    const { ports, reference, only } = world(12);
    const unknown = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'universe' },
      capabilities,
      reference: reference(uuid(999)),
    });
    expect(unknown).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'unknown_chunk' } });
    const old = world(100);
    const superseded = await makeReadSceneChunk(old.ports)(authority, {
      selection: { kind: 'universe' },
      capabilities,
      reference: old.reference(uuid(399)),
    });
    expect(superseded).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'unknown_chunk' } });
    expect(only('chunkHeads')).toHaveLength(0);
  });
  it('refuses a chunk of another system when the read names a system', async () => {
    const { ports, systems, heads, reference } = world(5);
    const read = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'system', systemId: systems[1]! },
      capabilities,
      reference: reference(heads[3]!.chunkId),
    });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'unknown_chunk' } });
    const own = await makeReadSceneChunk(ports)(authority, {
      selection: { kind: 'system', systemId: systems[1]! },
      capabilities,
      reference: reference(heads[1]!.chunkId),
    });
    expect(own).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
  });
  it('lists the chunks of the map once for the whole-map manifest read and loads none of them', async () => {
    const { heads, ports, only } = world(12);
    const read = await makeReadSceneManifest(ports)(authority, { selection: { kind: 'universe' }, capabilities });
    expect(read).toMatchObject({ kind: 'read', scene: { status: 'ready' } });
    expect(only('chunkHeads')).toHaveLength(1);
    expect(only('chunk')).toHaveLength(0);
    if (read.kind === 'read' && 'manifest' in read.scene)
      expect(read.scene.manifest.chunks.map((c) => c.chunkId)).toEqual(heads.map((h) => h.chunkId));
  });
  it('lists one system for a system manifest read, and refuses a system that is not on the map', async () => {
    const { systems, ports, only } = world(12);
    const read = await makeReadSceneManifest(ports)(authority, {
      selection: { kind: 'system', systemId: systems[4]! },
      capabilities: skyCapabilities,
    });
    expect(read).toMatchObject({
      kind: 'read',
      scene: { status: 'ready', manifest: { chunks: [{ chunkId: uuid(304) }] } },
    });
    expect(only('chunkHeads')[0]!.args).toEqual([systems[4]]);
    // The whole-map fit check is for the whole-map read only.
    expect(only('legacyFit')).toHaveLength(0);
    const missing = await makeReadSceneManifest(ports)(authority, {
      selection: { kind: 'system', systemId: uuid(777) },
      capabilities: skyCapabilities,
    });
    expect(missing).toEqual({ kind: 'refused', reason: 'selection_not_found' });
  });
  it('gives the whole map only to a client that can hold it, and says when it cannot', async () => {
    const reads = async (options: Parameters<typeof world>[1], count = 3) => {
      const w = world(count, options);
      return makeReadSceneManifest(w.ports)(authority, { selection: { kind: 'universe' }, capabilities });
    };
    for (const fit of [{ objects: 1001 }, { anchor: 10_001 }, { variant: 1001 }])
      expect(await reads({ fit })).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'limit' } });
    // More chunks than a whole-map manifest may name.
    expect(await reads({}, 129)).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'limit' } });
    expect(await reads({ fit: { objects: 1000, anchor: 10_000, variant: 1000 } })).toMatchObject({
      kind: 'read',
      scene: { status: 'ready' },
    });
  });
});

describe('The sky read (D-417)', () => {
  const sky = (ports: ScenePorts, extra: object = {}) =>
    makeReadSceneSky(ports)(authority, { capabilities: skyCapabilities, limit: 5, ...extra });
  it('serves systems only, a page at a time, without asking Geography for a place or storage for a chunk', async () => {
    const { ports, only, systems } = world(12);
    const first = await sky(ports);
    expect(first).toMatchObject({
      kind: 'read',
      scene: {
        status: 'ready',
        sceneRevision: 4,
        revisions,
        continuation: { status: 'more', cursor: { sceneRevision: 4, afterSystemId: systems[4] } },
      },
    });
    if (first.kind !== 'read' || !('systems' in first.scene)) throw new Error('expected a page');
    expect(first.scene.systems).toHaveLength(5);
    expect(first.scene.systems[0]).toMatchObject({
      descriptor: { kind: 'system', label: 'System 100' },
      planetCount: 3,
      haze: 'amber',
    });
    // The query asked storage for one row more than the page holds, to know there is a next page.
    expect(only('sky')[0]!.args[0]).toEqual({ limit: 6 });
    expect(only('readInput').map((c) => c.args[0])).toEqual([{ kind: 'head' }]);
    expect(only('chunk')).toHaveLength(0);
    expect(only('chunkHeads')).toHaveLength(0);
    const last = await sky(ports, { limit: 50, cursor: { sceneRevision: 4, afterSystemId: systems[4] } });
    expect(last).toMatchObject({ kind: 'read', scene: { status: 'ready', continuation: { status: 'complete' } } });
    if (last.kind === 'read' && 'systems' in last.scene) expect(last.scene.systems).toHaveLength(7);
  });
  it('starts again when the map changed between two pages, and passes a refresh revision to storage', async () => {
    const { ports, only, systems } = world(12);
    const stale = await sky(ports, { cursor: { sceneRevision: 3, afterSystemId: systems[4] } });
    expect(stale).toMatchObject({ kind: 'read', scene: { status: 'unavailable', reason: 'snapshot_expired' } });
    await sky(ports, { sinceSceneRevision: 2 });
    expect(only('sky').at(-1)!.args[0]).toEqual({ limit: 6, since: 2 });
  });
  it('says what it is when it cannot serve: unsupported, empty, loading, failed', async () => {
    expect(await sky(world(3).ports, { capabilities })).toMatchObject({
      kind: 'read',
      scene: { status: 'unsupported_version' },
    });
    // A client that declared looks but not the sky is not served the sky either.
    expect(await sky(world(3).ports, { capabilities: { ...skyCapabilities, sky: undefined } })).toMatchObject({
      kind: 'read',
      scene: { status: 'unsupported_version' },
    });
    expect(await sky(world(0, { state: { projected: undefined }, objectCount: 0 }).ports)).toMatchObject({
      kind: 'read',
      scene: { status: 'empty' },
    });
    expect(await sky(world(3, { state: { projected: undefined }, pending: true }).ports)).toMatchObject({
      kind: 'read',
      scene: { status: 'loading', pendingProjection: { geographyRevision: 4 } },
    });
    expect(await sky(world(3, { state: { failure: { geographyRevision: 4, reason: 'limit' } } }).ports)).toMatchObject({
      kind: 'read',
      scene: { status: 'unavailable', reason: 'limit' },
    });
    // A world still in the older shape is not served until the next projection adopts it.
    expect(await sky(world(3, { state: { legacy: true } }).ports)).toMatchObject({
      kind: 'read',
      scene: { status: 'unavailable', reason: 'temporarily_unavailable' },
    });
  });
  it('serves the last projection as lagging while a newer one is really pending', async () => {
    const lagging = world(3, {
      state: { projected: { ...revisions, geographyRevision: 3, structureRevision: 3, activityRevision: 3 } },
      pending: true,
    });
    expect(await sky(lagging.ports)).toMatchObject({
      kind: 'read',
      scene: { status: 'lagging', pendingProjection: { geographyRevision: 4, personalRevision: 7 } },
    });
  });
});
