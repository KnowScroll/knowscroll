import {
  ReadSceneManifestSchema,
  ReadSceneChunkSchema,
  SceneManifestReadSchema,
  SceneChunkReadSchema,
  SceneManifestSchema,
  SCENE_LIMITS,
  supportsSceneLooks,
  supportsSceneV1,
  type SceneLook,
  type SceneManifestRead,
  type ReadSceneManifest,
  type GeographyRevisions,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ChunkHead, ScenePorts, SceneState, ReadOwnSceneManifest, ReadOwnSceneChunk } from './ports.js';
import { projectsGeography } from './stamps.js';

/**
 * The most a client that predates the sky can hold of a map (D-417): its whole-map session holds at most 1000
 * objects in 128 chunks, anchors within `legacyAnchor` and looks whose variant is within `LOOK_LIMITS` as it knew them.
 * A map past it is not served to such a client, and that is said, not hidden.
 */
const MANIFEST_LOOKS_MAX = 1000;
export const LEGACY_FIT = { objects: 1000, chunks: SCENE_LIMITS.chunksPerManifest, variant: 1000 } as const;

/**
 * The looks of the objects a manifest read names, for a client that declared the look capability and
 * only for it. A world projected before looks existed has fewer looks than objects until it is
 * backfilled, and the client draws such an object as it always did. Looks carry no activity, count,
 * support or time, so serving them needs nothing from Geography beyond what the read already has.
 */
async function looksOf(
  p: ScenePorts,
  scope: PersonalScopeTx,
  q: ReadSceneManifest,
  heads: readonly ChunkHead[],
): Promise<{ readonly looks: SceneLook[] } | Record<string, never>> {
  if (!supportsSceneLooks(q.capabilities)) return {};
  return {
    looks: [
      ...(await p.store.looksOf(
        scope,
        heads.flatMap((head) => head.objectIds),
      )),
    ],
  };
}
/** The scope, revisions and clock every scene read answers with. */
export function readBase(
  p: ScenePorts,
  scope: PersonalScopeTx,
  head: { readonly geography: GeographyRevisions; readonly personalRevision: number },
  state: SceneState | undefined,
) {
  return {
    scope: {
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      personalWatermark: head.personalRevision,
    },
    recordedAt: p.now().toISOString(),
    currentGeography: head.geography,
    sceneRevision: state?.projected?.sceneRevision ?? 0,
  };
}
/**
 * Whether what is stored describes current Geography: current, behind a real pending projection (lagging), or
 * unavailable. A stored projection is never relabelled current, and unrelated root activity is never pending.
 */
export async function projectionStatus(
  p: ScenePorts,
  scope: PersonalScopeTx,
  head: { readonly geography: GeographyRevisions; readonly personalRevision: number },
  state: SceneState | undefined,
) {
  if (state?.failure?.geographyRevision === head.geography.revision)
    return { kind: 'unavailable' as const, reason: state.failure.reason };
  // A world still in the older shape is adopted by the next projection; until then it is not served.
  if (state?.legacy) return { kind: 'unavailable' as const, reason: 'temporarily_unavailable' as const };
  const m = state?.projected;
  if (projectsGeography(m, head.geography)) return { kind: 'current' as const };
  const pending = await p.store.pending(scope);
  if (
    pending &&
    pending.geographyRevision === head.geography.revision &&
    pending.personalRevision <= head.personalRevision &&
    (!m || pending.geographyRevision > m.geographyRevision)
  )
    return { kind: 'pending' as const, pending };
  return { kind: 'unavailable' as const, reason: 'temporarily_unavailable' as const };
}
/** The unavailable reply a scene read gives when Geography itself cannot be read. */
export function geographyUnavailable(
  read: {
    readonly geography: GeographyRevisions;
    readonly personalRevision: number;
    readonly reason: 'limit' | 'temporarily_unavailable';
  },
  supported: boolean,
) {
  return {
    head: { geography: read.geography, personalRevision: read.personalRevision },
    fields: supported
      ? { status: 'unavailable' as const, reason: read.reason }
      : { status: 'unsupported_version' as const },
  };
}

export function makeReadSceneManifest(p: ScenePorts): ReadOwnSceneManifest {
  return async (authority, query) => {
    const q = ReadSceneManifestSchema.parse(query);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const read = await p.readInput(scope, { kind: 'head' });
      if (read.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' } as const;
      const reply = (data: object, state: SceneState | undefined, head: Parameters<typeof readBase>[2]) => ({
        kind: 'read' as const,
        scene: SceneManifestReadSchema.parse({
          version: 'scene-manifest-read.v1',
          selection: q.selection,
          capabilities: q.capabilities,
          ...readBase(p, scope, head, state),
          ...data,
        }),
      });
      if (read.kind === 'unavailable') {
        const { head, fields } = geographyUnavailable(read, supportsSceneV1(q.capabilities));
        return reply(fields, undefined, head);
      }
      const head = read.input,
        state = await p.store.state(scope);
      if (!supportsSceneV1(q.capabilities)) return reply({ status: 'unsupported_version' }, state, head);
      const systemId = q.selection.kind === 'system' ? q.selection.systemId : undefined;
      if (systemId !== undefined && !(await p.store.systems(scope, [systemId])).length)
        return { kind: 'refused', reason: 'selection_not_found' } as const;
      if (!head.objectCount && !state?.projected) {
        const manifest = SceneManifestSchema.parse({
          schemaVersion: 'scene-manifest.v1',
          revisions: {
            geographyRevision: head.geography.revision,
            structureRevision: head.geography.structureRevision,
            activityRevision: head.geography.activityRevision,
            sceneRevision: 0,
            personalRevision: head.personalRevision,
          },
          chunks: [],
        });
        return reply({ status: 'empty', manifest, ...(await looksOf(p, scope, q, [])) }, state, head);
      }
      const current = await projectionStatus(p, scope, head, state);
      if (current.kind === 'unavailable') return reply({ status: 'unavailable', reason: current.reason }, state, head);
      if (!state?.projected)
        return reply(
          { status: 'loading', pendingProjection: current.kind === 'pending' ? current.pending : undefined },
          state,
          head,
        );
      // The whole map goes only to a client that can hold it; the rest read the sky and one system at a time.
      if (systemId === undefined) {
        const fit = await p.store.legacyFit(scope);
        if (
          fit.objects > LEGACY_FIT.objects ||
          fit.anchor > SCENE_LIMITS.legacyAnchor ||
          fit.variant > LEGACY_FIT.variant
        )
          return reply({ status: 'unavailable', reason: 'limit' }, state, head);
      }
      const heads = await p.store.chunkHeads(scope, systemId);
      if (systemId === undefined && heads.length > LEGACY_FIT.chunks)
        return reply({ status: 'unavailable', reason: 'limit' }, state, head);
      const manifest = SceneManifestSchema.parse({
        schemaVersion: 'scene-manifest.v1',
        revisions: state.projected,
        chunks: heads.map(({ chunkId, sceneRevision, objectIds }) => ({ chunkId, sceneRevision, objectIds })),
      });
      const looks = await looksOf(p, scope, q, heads);
      // The manifest read holds at most 1000 looks; a system with more than that cannot be read whole.
      if ((looks.looks?.length ?? 0) > MANIFEST_LOOKS_MAX)
        return reply({ status: 'unavailable', reason: 'limit' }, state, head);
      const scene: SceneManifestRead = SceneManifestReadSchema.parse({
        version: 'scene-manifest-read.v1',
        selection: q.selection,
        capabilities: q.capabilities,
        ...readBase(p, scope, head, state),
        status: current.kind === 'pending' ? 'lagging' : manifest.chunks.length ? 'ready' : 'empty',
        manifest,
        ...(current.kind === 'pending' ? { pendingProjection: current.pending } : {}),
        ...looks,
      });
      return { kind: 'read', scene } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeReadSceneChunk(p: ScenePorts): ReadOwnSceneChunk {
  return async (authority, query) => {
    const q = ReadSceneChunkSchema.parse(query);
    // Foreign references have no valid own-scope wire echo: refuse without manufacturing a reference.
    if (q.reference.universeId !== authority.universeId || q.reference.privacyEpoch !== authority.privacyEpoch)
      return { kind: 'refused', reason: 'reference_not_found' };
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const read = await p.readInput(scope, { kind: 'head' });
      if (read.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' } as const;
      const reply = (data: object, state: SceneState | undefined, head: Parameters<typeof readBase>[2]) => ({
        kind: 'read' as const,
        scene: SceneChunkReadSchema.parse({
          version: 'scene-chunk-read.v1',
          selection: q.selection,
          capabilities: q.capabilities,
          reference: q.reference,
          ...readBase(p, scope, head, state),
          ...data,
        }),
      });
      if (read.kind === 'unavailable') {
        const { head, fields } = geographyUnavailable(read, supportsSceneV1(q.capabilities));
        return reply(fields, undefined, head);
      }
      const head = read.input,
        state = await p.store.state(scope);
      if (!supportsSceneV1(q.capabilities)) return reply({ status: 'unsupported_version' }, state, head);
      if (q.reference.manifestSceneRevision !== (state?.projected?.sceneRevision ?? 0))
        return reply({ status: 'unavailable', reason: 'stale_manifest' }, state, head);
      const systemId = q.selection.kind === 'system' ? q.selection.systemId : undefined;
      if (systemId !== undefined && !(await p.store.systems(scope, [systemId])).length)
        return { kind: 'refused', reason: 'selection_not_found' } as const;
      // Only the one chunk the reference names is loaded, however many chunks the map has (#674, D-409).
      const stored = await p.store.chunk(scope, q.reference.chunkId, q.reference.chunkSceneRevision);
      if (
        !stored ||
        !stored.current ||
        (systemId !== undefined && stored.systemId !== systemId) ||
        stored.chunk.objects.length + stored.chunk.routes.length === 0
      )
        return reply({ status: 'unavailable', reason: 'unknown_chunk' }, state, head);
      const current = await projectionStatus(p, scope, head, state);
      if (current.kind === 'unavailable') return reply({ status: 'unavailable', reason: current.reason }, state, head);
      return reply({ status: 'ready', chunk: stored.chunk }, state, head);
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
