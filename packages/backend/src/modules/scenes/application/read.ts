import {
  ReadSceneManifestSchema,
  ReadSceneChunkSchema,
  SceneManifestReadSchema,
  SceneChunkReadSchema,
  SceneManifestSchema,
  SceneChunkSchema,
  supportsSceneV1,
  type SceneManifestRead,
  type SceneChunkRead,
  type ReadSceneManifest,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { GeographySceneInput } from '../../geography/public.js';
import type { ScenePorts, SceneState, ReadOwnSceneManifest, ReadOwnSceneChunk, StoredChunk } from './ports.js';
async function selected(
  p: ScenePorts,
  scope: PersonalScopeTx,
  state: SceneState | undefined,
  input: GeographySceneInput,
  q: ReadSceneManifest,
) {
  if (
    q.selection.kind === 'system' &&
    !input.objects.some(
      (o) => o.id === (q.selection.kind === 'system' ? q.selection.systemId : '') && o.kind === 'system',
    )
  )
    return undefined;
  const chunks: StoredChunk[] = [];
  for (const ref of state?.manifest?.chunks ?? []) {
    const c = await p.store.chunk(scope, ref.chunkId, ref.sceneRevision);
    if (!c) throw new Error('SCENE_CURRENT_CHUNK_MISSING');
    const parsed = SceneChunkSchema.parse(c.chunk);
    if (
      parsed.chunkId !== ref.chunkId ||
      parsed.revisions.sceneRevision !== ref.sceneRevision ||
      parsed.objects.length !== ref.objectIds.length ||
      parsed.objects.some((o) => !ref.objectIds.includes(o.objectId))
    )
      throw new Error('SCENE_CURRENT_REFERENCE_INVALID');
    if (q.selection.kind === 'universe' || c.systemId === q.selection.systemId) chunks.push(c);
  }
  return chunks;
}
function base(
  p: ScenePorts,
  scope: PersonalScopeTx,
  input: GeographySceneInput,
  q: ReadSceneManifest,
  state: SceneState | undefined,
) {
  return {
    selection: q.selection,
    capabilities: q.capabilities,
    scope: {
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      personalWatermark: input.personalRevision,
    },
    recordedAt: p.now().toISOString(),
    currentGeography: input.geography,
    sceneRevision: state?.manifest?.revisions.sceneRevision ?? 0,
  };
}
async function status(
  p: ScenePorts,
  scope: PersonalScopeTx,
  input: GeographySceneInput,
  state: SceneState | undefined,
) {
  if (state?.failure?.geographyRevision === input.geography.revision)
    return { kind: 'unavailable' as const, reason: state.failure.reason };
  const m = state?.manifest;
  if (
    m &&
    m.revisions.geographyRevision === input.geography.revision &&
    m.revisions.structureRevision === input.geography.structureRevision &&
    m.revisions.activityRevision === input.geography.activityRevision
  )
    return { kind: 'current' as const };
  const pending = await p.store.pending(scope);
  if (
    pending &&
    pending.geographyRevision === input.geography.revision &&
    pending.personalRevision <= input.personalRevision &&
    (!m || pending.geographyRevision > m.revisions.geographyRevision)
  )
    return { kind: 'pending' as const, pending };
  return { kind: 'unavailable' as const, reason: 'temporarily_unavailable' as const };
}
export function makeReadSceneManifest(p: ScenePorts): ReadOwnSceneManifest {
  return async (authority, query) => {
    const q = ReadSceneManifestSchema.parse(query);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const read = await p.readInput(scope);
      if (read.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' } as const;
      if (read.kind === 'unavailable') {
        const input = {
          universeId: scope.authority.universeId,
          privacyEpoch: scope.authority.privacyEpoch,
          personalRevision: read.personalRevision,
          geography: read.geography,
          objects: [],
          routes: [],
          aliases: [],
        };
        return {
          kind: 'read',
          scene: SceneManifestReadSchema.parse({
            version: 'scene-manifest-read.v1',
            ...base(p, scope, input, q, undefined),
            status: supportsSceneV1(q.capabilities) ? 'unavailable' : 'unsupported_version',
            ...(supportsSceneV1(q.capabilities) ? { reason: read.reason } : {}),
          }),
        } as const;
      }
      const input = read.input,
        state = await p.store.state(scope),
        fields = { version: 'scene-manifest-read.v1' as const, ...base(p, scope, input, q, state) };
      const reply = (data: unknown) => ({ kind: 'read' as const, scene: SceneManifestReadSchema.parse(data) });
      if (!supportsSceneV1(q.capabilities)) return reply({ ...fields, status: 'unsupported_version' });
      const chunks = await selected(p, scope, state, input, q);
      if (!chunks) return { kind: 'refused', reason: 'selection_not_found' } as const;
      if (!input.objects.length && !state?.manifest) {
        const manifest = SceneManifestSchema.parse({
          schemaVersion: 'scene-manifest.v1',
          revisions: {
            geographyRevision: input.geography.revision,
            structureRevision: input.geography.structureRevision,
            activityRevision: input.geography.activityRevision,
            sceneRevision: 0,
            personalRevision: input.personalRevision,
          },
          chunks: [],
        });
        return reply({ ...fields, status: 'empty', manifest });
      }
      const current = await status(p, scope, input, state);
      if (current.kind === 'unavailable') return reply({ ...fields, status: 'unavailable', reason: current.reason });
      if (!state?.manifest)
        return reply({
          ...fields,
          status: 'loading',
          pendingProjection: current.kind === 'pending' ? current.pending : undefined,
        });
      const manifest = SceneManifestSchema.parse({
        ...state.manifest,
        chunks: state.manifest.chunks.filter((ref) => chunks.some((c) => c.chunk.chunkId === ref.chunkId)),
      });
      const scene: SceneManifestRead = SceneManifestReadSchema.parse({
        ...fields,
        status: current.kind === 'pending' ? 'lagging' : manifest.chunks.length ? 'ready' : 'empty',
        manifest,
        ...(current.kind === 'pending' ? { pendingProjection: current.pending } : {}),
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
      const read = await p.readInput(scope);
      if (read.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' } as const;
      if (read.kind === 'unavailable') {
        const input = {
          universeId: scope.authority.universeId,
          privacyEpoch: scope.authority.privacyEpoch,
          personalRevision: read.personalRevision,
          geography: read.geography,
          objects: [],
          routes: [],
          aliases: [],
        };
        return {
          kind: 'read',
          scene: SceneChunkReadSchema.parse({
            version: 'scene-chunk-read.v1',
            ...base(p, scope, input, q, undefined),
            reference: q.reference,
            status: supportsSceneV1(q.capabilities) ? 'unavailable' : 'unsupported_version',
            ...(supportsSceneV1(q.capabilities) ? { reason: read.reason } : {}),
          }),
        } as const;
      }
      const input = read.input,
        state = await p.store.state(scope),
        fields = {
          version: 'scene-chunk-read.v1' as const,
          ...base(p, scope, input, q, state),
          reference: q.reference,
        };
      const reply = (data: unknown) => ({ kind: 'read' as const, scene: SceneChunkReadSchema.parse(data) });
      if (!supportsSceneV1(q.capabilities)) return reply({ ...fields, status: 'unsupported_version' });
      if (q.reference.manifestSceneRevision !== (state?.manifest?.revisions.sceneRevision ?? 0))
        return reply({ ...fields, status: 'unavailable', reason: 'stale_manifest' });
      const chunks = await selected(p, scope, state, input, q);
      if (!chunks) return { kind: 'refused', reason: 'selection_not_found' } as const;
      const ref = state?.manifest?.chunks.find(
          (r) => r.chunkId === q.reference.chunkId && r.sceneRevision === q.reference.chunkSceneRevision,
        ),
        chunk = chunks.find((c) => c.chunk.chunkId === ref?.chunkId);
      if (!ref || !chunk) return reply({ ...fields, status: 'unavailable', reason: 'unknown_chunk' });
      const current = await status(p, scope, input, state);
      if (current.kind === 'unavailable') return reply({ ...fields, status: 'unavailable', reason: current.reason });
      const scene: SceneChunkRead = SceneChunkReadSchema.parse({ ...fields, status: 'ready', chunk: chunk.chunk });
      return { kind: 'read', scene } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
