import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneReturnLocatorSchema,
  SceneLookSchema,
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
  SceneLookJsonSchema,
  SCENE_LOOK_VERSION,
  WORLD_GENERATOR_VERSION,
  HAZE_FAMILIES,
  type SceneDescriptor,
  type SceneChunk,
  type SceneManifest,
  type SceneReturnLocator,
  type SceneLook,
  type SceneRevisions,
} from '@knowscroll/scene-core';
import { GeographyRevisionsSchema } from './geography.js';
import { UniverseIdSchema, UuidSchema } from './ids.js';

export {
  SCENE_LIMITS,
  LOOK_LIMITS,
  PLANET_TYPES,
  HAZE_FAMILIES,
  SCENE_LOOK_VERSION,
  WORLD_GENERATOR_VERSION,
  seededUnit,
  SceneDescriptorSchema,
  SceneChunkSchema,
  SceneManifestSchema,
  SceneReturnLocatorSchema,
  SceneLookSchema,
  SceneDescriptorJsonSchema,
  SceneChunkJsonSchema,
  SceneManifestJsonSchema,
  SceneReturnLocatorJsonSchema,
  SceneLookJsonSchema,
} from '@knowscroll/scene-core';
export type {
  SceneDescriptor,
  SceneChunk,
  SceneManifest,
  SceneReturnLocator,
  SceneLook,
  SystemLook,
  PlanetLook,
  RegionLook,
  PlanetType,
  HazeFamily,
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
export const SceneLookWireSchema = z.custom<SceneLook>((v) => SceneLookSchema.safeParse(v).success);

/** Exact wrapper identity -> owning structural metadata, for a dev/server OpenAPI converter.
 * Shared runtime imports neither OpenAPI machinery nor its registries. */
export const sceneWireJsonSchemas = [
  { schema: SceneDescriptorWireSchema, jsonSchema: SceneDescriptorJsonSchema },
  { schema: SceneChunkWireSchema, jsonSchema: SceneChunkJsonSchema },
  { schema: SceneManifestWireSchema, jsonSchema: SceneManifestJsonSchema },
  { schema: SceneReturnLocatorWireSchema, jsonSchema: SceneReturnLocatorJsonSchema },
  { schema: SceneLookWireSchema, jsonSchema: SceneLookJsonSchema },
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
  /** Look data a client can draw (D-102). Absent for a client that predates it. */
  looks: Versions.optional(),
  /** The sky and per-system reads of a map at scale (D-417). Absent for a client that predates them. */
  sky: Versions.optional(),
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

/**
 * A client that declares `scene-look.v1` and the generator the looks pin is given the look data of
 * the objects it reads. One that does not is given the same reads as before, byte for byte.
 */
export function supportsSceneLooks(capabilities: SceneClientCapabilities): boolean {
  return (
    supportsSceneV1(capabilities) &&
    capabilities.looks?.includes(SCENE_LOOK_VERSION) === true &&
    capabilities.generators.includes(WORLD_GENERATOR_VERSION)
  );
}

/** The version of the sky read: every system of the map in one compact entry each, and nothing below them (D-417). */
export const SCENE_SKY_VERSION = 'scene-sky.v1' as const;

/**
 * A client that declares `scene-sky.v1` (and what the sky's entries carry: looks) reads a map at scale as the
 * sky first and one system at a time. One that does not is served the whole map as before while it fits what
 * it can hold, and is told it does not fit beyond that (D-417).
 */
export function supportsSceneSky(capabilities: SceneClientCapabilities): boolean {
  return supportsSceneLooks(capabilities) && capabilities.sky?.includes(SCENE_SKY_VERSION) === true;
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
/** `looks` is present exactly when the client declared the look capability (D-102). */
const ManifestData = { manifest: SceneManifestWireSchema, looks: z.array(SceneLookWireSchema).max(1000).optional() };
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
    checkLooks(s, ctx);
    if (
      s.manifest.revisions.sceneRevision !== s.sceneRevision ||
      s.manifest.chunks.some((chunk) => chunk.sceneRevision > s.sceneRevision) ||
      (s.status === 'empty' && s.manifest.chunks.length !== 0) ||
      (s.status === 'ready' && s.manifest.chunks.length === 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Manifest status or scene revision is inconsistent.' });
    if (s.status === 'lagging') {
      if (
        s.pendingProjection.geographyRevision < s.manifest.revisions.geographyRevision ||
        s.pendingProjection.personalRevision < s.manifest.revisions.personalRevision ||
        (s.pendingProjection.geographyRevision === s.manifest.revisions.geographyRevision &&
          s.pendingProjection.personalRevision === s.manifest.revisions.personalRevision)
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
function checkLooks(
  s: { capabilities: SceneClientCapabilities; manifest: SceneManifest; looks?: SceneLook[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if ((s.looks !== undefined) !== supportsSceneLooks(s.capabilities)) {
    ctx.addIssue({ code: 'custom', message: 'Looks are present exactly when the client declared them.' });
    return;
  }
  if (s.looks === undefined) return;
  const inManifest = new Set(s.manifest.chunks.flatMap((chunk) => chunk.objectIds));
  const seen = new Set<string>();
  for (const look of s.looks) {
    if (!inManifest.has(look.objectId) || seen.has(look.objectId))
      ctx.addIssue({ code: 'custom', message: 'A look must belong to one object of the manifest, once.' });
    seen.add(look.objectId);
  }
}
function checkPending(
  p: z.infer<typeof PendingProjection>,
  s: {
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

/** Bounds of the sky read, never a formation or consumption threshold. */
export const SKY_LIMITS = {
  /** Systems in one page of the sky. */
  systemsPerPage: 200,
} as const;

/**
 * Where the next page of a sky read goes on. It binds the scene revision the first page read, so a map that
 * changed in between is read again from the start rather than mixed.
 */
const SkyCursor = z.strictObject({ sceneRevision: Counter, afterSystemId: UuidSchema });
/**
 * Systems only: no star, planet, region, route or chunk. `sinceSceneRevision` asks for the systems that changed
 * after a revision the client already holds (a refresh), `cursor` continues a page.
 */
export const ReadSceneSkySchema = z
  .strictObject({
    capabilities: SceneClientCapabilitiesSchema,
    limit: z.number().int().min(1).max(SKY_LIMITS.systemsPerPage),
    sinceSceneRevision: Counter.optional(),
    cursor: SkyCursor.optional(),
  })
  .refine(
    (q) =>
      q.cursor === undefined || q.sinceSceneRevision === undefined || q.cursor.sceneRevision > q.sinceSceneRevision,
    'A cursor cannot start before the revision a refresh asks after.',
  );

/**
 * One system of the sky: what the far view draws and the label index lists. The descriptor is the system's own
 * (its anchor, seed, label and activity, as its chunk holds them), `haze` its look once it has one, `planetCount` how many planets
 * it has, and `sceneRevision` the revision at which anything of the system last changed, so a client that holds an
 * older one knows to read the system again. No count of reading, no support, no time.
 */
export const SceneSkySystemSchema = z
  .strictObject({
    descriptor: SceneDescriptorWireSchema,
    haze: z.enum(HAZE_FAMILIES).optional(),
    planetCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sceneRevision: Counter,
  })
  .refine((system) => system.descriptor.kind === 'system', 'A sky entry is a system.');
export type SceneSkySystem = z.infer<typeof SceneSkySystemSchema>;

const SkyFields = {
  version: z.literal('scene-sky-read.v1'),
  capabilities: SceneClientCapabilitiesSchema,
  scope: SceneReadScopeSchema,
  recordedAt: z.iso.datetime(),
  currentGeography: GeographyRevisionsSchema,
  /** The latest projected scene revision; every system's own revision is at or below it. */
  sceneRevision: Counter,
  sinceSceneRevision: Counter.optional(),
};
const SkyData = {
  /** The projection inputs the sky was drawn from, as a manifest carries them. */
  revisions: z.strictObject({
    geographyRevision: Counter,
    structureRevision: Counter,
    activityRevision: Counter,
    sceneRevision: Counter,
    personalRevision: Counter,
  }),
  systems: z.array(SceneSkySystemSchema).max(SKY_LIMITS.systemsPerPage),
  continuation: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete') }),
    z.strictObject({ status: z.literal('more'), cursor: SkyCursor }),
  ]),
};
export const SceneSkyReadSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...SkyFields, status: z.literal('empty') }),
    z.strictObject({ ...SkyFields, status: z.literal('ready'), ...SkyData }),
    z.strictObject({ ...SkyFields, status: z.literal('lagging'), ...SkyData, pendingProjection: PendingProjection }),
    z.strictObject({ ...SkyFields, status: z.literal('loading'), pendingProjection: PendingProjection }),
    z.strictObject({
      ...SkyFields,
      status: z.literal('unavailable'),
      reason: z.enum(['temporarily_unavailable', 'limit', 'snapshot_expired']),
    }),
    z.strictObject({ ...SkyFields, status: z.literal('unsupported_version') }),
  ])
  .superRefine((s, ctx) => {
    if (supportsSceneSky(s.capabilities) === (s.status === 'unsupported_version'))
      ctx.addIssue({ code: 'custom', message: 'Unsupported capabilities require an explicit fallback.' });
    if ('pendingProjection' in s) checkPending(s.pendingProjection, s, ctx);
    if (!('systems' in s)) return;
    checkProjection(s.revisions, s, ctx);
    const ids = new Set(s.systems.map((system) => system.descriptor.objectId));
    if (
      s.revisions.sceneRevision !== s.sceneRevision ||
      ids.size !== s.systems.length ||
      s.systems.some((system) => system.sceneRevision > s.sceneRevision) ||
      // Haze is the system's look: given to a client that declared looks, and only to it. A system a world projected
      // before looks existed has none until it is backfilled.
      s.systems.some((system) => system.haze !== undefined && !supportsSceneLooks(s.capabilities)) ||
      (s.status === 'ready' && s.revisions.geographyRevision !== s.currentGeography.revision) ||
      (s.continuation.status === 'more' &&
        (s.continuation.cursor.sceneRevision !== s.sceneRevision ||
          s.continuation.cursor.afterSystemId !== s.systems.at(-1)?.descriptor.objectId))
    )
      ctx.addIssue({ code: 'custom', message: 'The sky is inconsistent with its scene revision or continuation.' });
    if (s.sinceSceneRevision !== undefined && s.systems.some((system) => system.sceneRevision <= s.sinceSceneRevision!))
      ctx.addIssue({ code: 'custom', message: 'A refresh holds only systems that changed after the revision asked.' });
  });
export type ReadSceneSky = z.infer<typeof ReadSceneSkySchema>;
export type SceneSkyRead = z.infer<typeof SceneSkyReadSchema>;

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

/**
 * Every system of the person's own map, a page at a time (D-417). A client that declared the sky capability reads
 * this first and then one system at a time through `readSceneManifestContract` and `readSceneChunkContract` with
 * `selection: system`. Own scope only, and it enqueues nothing.
 */
export const readSceneSkyContract = oc
  .route({ method: 'POST', path: '/v1/universe/scenes/sky/read', successStatus: 200 })
  .input(ReadSceneSkySchema)
  .output(SceneSkyReadSchema);
