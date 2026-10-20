import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneReturnLocatorSchema,
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
  type SceneDescriptor,
  type SceneChunk,
  type SceneManifest,
  type SceneReturnLocator,
  type SceneRevisions,
} from '@knowscroll/scene-core';
import { GeographyRevisionsSchema } from './geography.js';
import { UniverseIdSchema, UuidSchema } from './ids.js';

export {
  SCENE_LIMITS,
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneReturnLocatorSchema,
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
} from '@knowscroll/scene-core';
export type {
  SceneDescriptor,
  SceneChunk,
  SceneManifest,
  SceneReturnLocator,
  SceneRevisions,
} from '@knowscroll/scene-core';

/** Validation delegates to the canonical parser. No transform, coercion or duplicate scene DSL.
 * Use the canonical JSON Schema metadata below at the OpenAPI generation boundary. */
export const SceneDescriptorWireSchema = z.custom<SceneDescriptor>((v) => SceneDescriptorSchema.safeParse(v).success);
export const SceneChunkWireSchema = z.custom<SceneChunk>((v) => SceneChunkSchema.safeParse(v).success);
export const SceneManifestWireSchema = z.custom<SceneManifest>((v) => SceneManifestSchema.safeParse(v).success);
export const SceneReturnLocatorWireSchema = z.custom<SceneReturnLocator>(
  (v) => SceneReturnLocatorSchema.safeParse(v).success,
);

/** Exact wrapper identity -> owning structural metadata, for a dev/server OpenAPI converter.
 * Shared runtime imports neither OpenAPI machinery nor its registries. */
export const sceneWireJsonSchemas = [
  { schema: SceneDescriptorWireSchema, jsonSchema: SceneDescriptorJsonSchema },
  { schema: SceneChunkWireSchema, jsonSchema: SceneChunkJsonSchema },
  { schema: SceneManifestWireSchema, jsonSchema: SceneManifestJsonSchema },
  { schema: SceneReturnLocatorWireSchema, jsonSchema: SceneReturnLocatorJsonSchema },
];

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Versions = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*\.v[1-9][0-9]*$/),
  )
  .max(8)
  .refine((versions) => new Set(versions).size === versions.length, 'Capability versions must be unique.');
/** Unsupported bounded versions are valid advertisements, so reads can return an honest fallback.
 * Detail and reduced motion affect rendering quality only, never identity or permission. */
export const SceneClientCapabilitiesSchema = z.strictObject({
  version: z.literal('scene-client.v1'),
  descriptors: Versions,
  chunks: Versions,
  manifests: Versions,
  generators: Versions,
  families: Versions,
  detail: z.enum(['full', 'low']),
  reducedMotion: z.boolean(),
});
export type SceneClientCapabilities = z.infer<typeof SceneClientCapabilitiesSchema>;

/** This bounded first protocol requires all current families; no family/generator substitution. */
export function supportsSceneV1(capabilities: SceneClientCapabilities): boolean {
  return (
    capabilities.descriptors.includes('scene-descriptor.v1') &&
    capabilities.chunks.includes('scene-chunk.v1') &&
    capabilities.manifests.includes('scene-manifest.v1') &&
    capabilities.generators.includes('silhouette.v1') &&
    ['terraced.v1', 'ridged.v1', 'archipelago.v1'].every((family) => capabilities.families.includes(family))
  );
}

const Selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('universe') }),
  z.strictObject({ kind: z.literal('system'), systemId: UuidSchema }),
]);
/** Account ID is derived from authenticated AccountScope. The universe/epoch only fence data. */
export const SceneReadScopeSchema = z.strictObject({
  universeId: UniverseIdSchema,
  privacyEpoch: Epoch,
  personalWatermark: Counter,
});
const PendingProjection = z.strictObject({ geographyRevision: Counter, personalRevision: Counter });
const ReadFields = { selection: Selection, capabilities: SceneClientCapabilitiesSchema };
export const ReadSceneManifestSchema = z.strictObject(ReadFields);

/** Private reference into an exact current own-scope manifest, never a grant or a fetch URL. */
export const SceneChunkReferenceSchema = z
  .strictObject({
    universeId: UniverseIdSchema,
    privacyEpoch: Epoch,
    manifestSceneRevision: Counter,
    chunkId: UuidSchema,
    chunkSceneRevision: Counter,
  })
  .refine((r) => r.chunkSceneRevision <= r.manifestSceneRevision, 'Invalid manifest/chunk scene revisions.');
export const ReadSceneChunkSchema = z.strictObject({ ...ReadFields, reference: SceneChunkReferenceSchema });

const ResponseFields = {
  ...ReadFields,
  scope: SceneReadScopeSchema,
  recordedAt: z.iso.datetime(),
  /** Current committed Geography, distinct from the scene's projection-input stamps. */
  currentGeography: GeographyRevisionsSchema,
  sceneRevision: Counter,
};
const ManifestFields = { version: z.literal('scene-manifest-read.v1'), ...ResponseFields };
const ManifestData = { manifest: SceneManifestWireSchema };
export const SceneManifestReadSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...ManifestFields, status: z.literal('empty'), ...ManifestData }),
    z.strictObject({ ...ManifestFields, status: z.literal('ready'), ...ManifestData }),
    z.strictObject({
      ...ManifestFields,
      status: z.literal('lagging'),
      ...ManifestData,
      pendingProjection: PendingProjection,
    }),
    z.strictObject({ ...ManifestFields, status: z.literal('loading'), pendingProjection: PendingProjection }),
    z.strictObject({
      ...ManifestFields,
      status: z.literal('unavailable'),
      reason: z.enum(['temporarily_unavailable', 'limit']),
    }),
    z.strictObject({ ...ManifestFields, status: z.literal('unsupported_version') }),
  ])
  .superRefine((s, ctx) => {
    checkCapabilities(s, ctx);
    if ('pendingProjection' in s) checkPending(s.pendingProjection, s, ctx);
    if (!('manifest' in s)) return;
    checkProjection(s.manifest.revisions, s, ctx);
    if (
      s.manifest.revisions.sceneRevision !== s.sceneRevision ||
      s.manifest.chunks.some((chunk) => chunk.sceneRevision > s.sceneRevision) ||
      (s.status === 'empty' && s.manifest.chunks.length !== 0) ||
      (s.status === 'ready' && s.manifest.chunks.length === 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Manifest status or scene revision is inconsistent.' });
    if (s.status === 'lagging') {
      if (
        s.pendingProjection.geographyRevision <= s.manifest.revisions.geographyRevision &&
        s.pendingProjection.personalRevision <= s.manifest.revisions.personalRevision
      )
        ctx.addIssue({ code: 'custom', message: 'Lag requires a newer pending projection input.' });
    } else if (
      s.manifest.revisions.geographyRevision !== s.currentGeography.revision ||
      s.manifest.revisions.structureRevision !== s.currentGeography.structureRevision ||
      s.manifest.revisions.activityRevision !== s.currentGeography.activityRevision
    ) {
      ctx.addIssue({ code: 'custom', message: 'A current scene must describe current Geography.' });
    }
  });

const ChunkFields = {
  version: z.literal('scene-chunk-read.v1'),
  ...ResponseFields,
  reference: SceneChunkReferenceSchema,
};
export const SceneChunkReadSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...ChunkFields, status: z.literal('ready'), chunk: SceneChunkWireSchema }),
    z.strictObject({
      ...ChunkFields,
      status: z.literal('unavailable'),
      reason: z.enum(['temporarily_unavailable', 'stale_manifest', 'unknown_chunk', 'limit']),
    }),
    z.strictObject({ ...ChunkFields, status: z.literal('unsupported_version') }),
  ])
  .superRefine((s, ctx) => {
    checkCapabilities(s, ctx);
    if (s.reference.universeId !== s.scope.universeId || s.reference.privacyEpoch !== s.scope.privacyEpoch)
      ctx.addIssue({ code: 'custom', message: 'Chunk reference must retain the current personal scope.' });
    if (s.status !== 'ready') return;
    checkProjection(s.chunk.revisions, s, ctx);
    if (
      s.reference.manifestSceneRevision !== s.sceneRevision ||
      s.chunk.chunkId !== s.reference.chunkId ||
      s.chunk.revisions.sceneRevision !== s.reference.chunkSceneRevision
    )
      ctx.addIssue({ code: 'custom', message: 'Chunk must bind the exact current manifest and chunk revision.' });
  });

function checkCapabilities(s: { capabilities: SceneClientCapabilities; status: string }, ctx: z.RefinementCtx): void {
  if (supportsSceneV1(s.capabilities) === (s.status === 'unsupported_version'))
    ctx.addIssue({ code: 'custom', message: 'Unsupported capabilities require an explicit fallback.' });
}
function checkPending(
  p: z.infer<typeof PendingProjection>,
  s: z.infer<typeof ReadSceneManifestSchema> & {
    currentGeography: z.infer<typeof GeographyRevisionsSchema>;
    scope: z.infer<typeof SceneReadScopeSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  if (p.geographyRevision > s.currentGeography.revision || p.personalRevision > s.scope.personalWatermark)
    ctx.addIssue({ code: 'custom', message: 'Pending projection cannot claim future committed input.' });
}
function checkProjection(
  r: SceneRevisions,
  s: {
    currentGeography: z.infer<typeof GeographyRevisionsSchema>;
    scope: z.infer<typeof SceneReadScopeSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    r.geographyRevision > s.currentGeography.revision ||
    r.structureRevision > r.geographyRevision ||
    r.activityRevision > r.geographyRevision ||
    r.structureRevision > s.currentGeography.structureRevision ||
    r.activityRevision > s.currentGeography.activityRevision ||
    r.personalRevision > s.scope.personalWatermark
  )
    ctx.addIssue({ code: 'custom', message: 'Projection inputs must belong to current committed scope.' });
}

export type SceneReadScope = z.infer<typeof SceneReadScopeSchema>;
export type ReadSceneManifest = z.infer<typeof ReadSceneManifestSchema>;
export type ReadSceneChunk = z.infer<typeof ReadSceneChunkSchema>;
export type SceneChunkReference = z.infer<typeof SceneChunkReferenceSchema>;
export type SceneManifestRead = z.infer<typeof SceneManifestReadSchema>;
export type SceneChunkRead = z.infer<typeof SceneChunkReadSchema>;

/** Declarations only. The future adapter checks origin/session/X-KS-Scope/current epoch,
 * exact current manifest membership, selector and capabilities. Reads enqueue nothing. */
export const readSceneManifestContract = oc
  .route({ method: 'POST', path: '/v1/universe/scenes/manifest/read', successStatus: 200 })
  .input(ReadSceneManifestSchema)
  .output(SceneManifestReadSchema);
export const readSceneChunkContract = oc
  .route({ method: 'POST', path: '/v1/universe/scenes/chunks/read', successStatus: 200 })
  .input(ReadSceneChunkSchema)
  .output(SceneChunkReadSchema);
