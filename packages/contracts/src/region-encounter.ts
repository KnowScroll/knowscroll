import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { ClientCapabilities } from './content.js';
import { AssetIdSchema, CommandIdSchema, UniverseIdSchema, UuidSchema } from './ids.js';
import { ExperienceSessionRefSchema, NavigationOutcomeSchema, EncounterMetadataSchema } from './navigation.js';
import { SceneReadScopeSchema } from './scenes.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const Version = z.literal('region-encounter-open.v1');
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** An exact own-Geography selection, not Scene identity, a meaning assertion or an access grant. */
export const RegionEncounterTargetSchema = z
  .strictObject({
    kind: z.literal('region'),
    regionId: UuidSchema,
    expectedObjectRevision: Revision,
    expectedGeographyRevision: Revision,
  })
  .refine((target) => target.expectedObjectRevision <= target.expectedGeographyRevision);

/** Immutable displayed target is an expectation only; current admission/access is rechecked. */
export const RegionEncounterExpectedSchema = z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision });

const PreviewVersion = z.literal('region-encounter-preview.v1');
/** Read correlation is not a command/receipt key. Selection, Close and Back never prepare work.
 * The authenticated own scope is derived by the server; camera and return state stay local. */
export const RegionEncounterPreviewRequestSchema = z.strictObject({
  version: PreviewVersion,
  readId: UuidSchema,
  target: RegionEncounterTargetSchema,
  capabilities: ClientCapabilities,
});
const PreviewFields = {
  version: PreviewVersion,
  readId: UuidSchema,
  scope: SceneReadScopeSchema,
  target: RegionEncounterTargetSchema,
  capabilities: ClientCapabilities,
  recordedAt: z.iso.datetime(),
  geographyRevision: Counter,
};
/** Read-only exact consumer card: no offer/session/receipt/exposure/evidence/demand/job/model.
 * A bounded incomplete selection is selection_unavailable, never catalogue exhaustion.
 * Caller must match initiating readId/target/capabilities and actual AccountScope, and reject
 * regressive root/Geography watermarks. Syntax cannot attest canonical facet or access authority. */
export const RegionEncounterPreviewResponseSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...PreviewFields,
      status: z.literal('available'),
      encounter: RegionEncounterExpectedSchema.extend({ metadata: EncounterMetadataSchema }),
    }),
    z.strictObject({
      ...PreviewFields,
      status: z.literal('unavailable'),
      reason: z.enum([
        'stale_target',
        'unsupported_region',
        'selection_unavailable',
        'no_eligible_content',
        'temporarily_unavailable',
      ]),
    }),
  ])
  .refine((s) => s.status !== 'available' || s.target.expectedGeographyRevision === s.geographyRevision);

/** Explicit Composer preparation command. Local map selection, Close and Back send no command.
 * Server derives the current owner/epoch and resolves canonical topic+facet through Geography.
 * Same command ID/body retries one intent; no camera, content override or consumption travels here. */
export const RegionEncounterOpenRequestSchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  target: RegionEncounterTargetSchema,
  session: ExperienceSessionRefSchema.extend({ expectedIntentRevision: Counter }).optional(),
  capabilities: ClientCapabilities,
  expectedEncounter: RegionEncounterExpectedSchema.optional(),
});

/** Reuse the real Composer outcome without creating another offer/activation protocol.
 * Syntax cannot prove current region membership, canonical meaning or Content eligibility:
 * the backend must bind EVERY chosen/buffer offer to the same actual region constraint.
 * A ready card grants no rendering authority; foreground entry still activates its exact offer.
 * Pending requires actual durable authorised work, never this declaration or a guessed ETA. */
export const RegionEncounterOpenResponseSchema = z
  .strictObject({
    version: Version,
    universeId: UniverseIdSchema,
    privacyEpoch: Revision,
    target: RegionEncounterTargetSchema,
    outcome: NavigationOutcomeSchema,
    expectedEncounter: RegionEncounterExpectedSchema.optional(),
    capabilities: ClientCapabilities.optional(),
  })
  .superRefine(({ outcome, expectedEncounter, capabilities }, ctx) => {
    if (
      expectedEncounter &&
      (!capabilities ||
        (outcome.status === 'ready' &&
          (outcome.offer.assetId !== expectedEncounter.assetId ||
            outcome.offer.assetRevision !== expectedEncounter.assetRevision)))
    )
      ctx.addIssue({ code: 'custom', message: 'Displayed region target must remain exact.' });
    if (!Counter.safeParse(outcome.intentRevision).success || !Counter.safeParse(outcome.revision).success)
      ctx.addIssue({ code: 'custom', message: 'Invalid region encounter revisions.' });
    if (outcome.status === 'exhausted' && outcome.reason !== 'no_eligible_content')
      ctx.addIssue({ code: 'custom', message: 'Invalid region exhaustion reason.' });
    if (outcome.status !== 'ready') return;
    for (const offer of [outcome.offer, ...outcome.bufferedOffers]) {
      if (
        offer.relation.kind !== 'discovery' ||
        offer.decisionId !== outcome.decisionId ||
        !Revision.safeParse(offer.assetRevision).success ||
        offer.variants.some(
          (variant) => variant.status === 'ready' && !Revision.safeParse(variant.assetRevision).success,
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid region discovery offer binding.' });
    }
  });

/** Static schema-owned tokens only; unknown names/values and numeric segments are never echoed.
 * Capability maps can contain caller-selected keys: mask them with unknown, never copy them. */
export const RegionEncounterProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'commandId',
        'readId',
        'expectedEncounter',
        'assetId',
        'assetRevision',
        'target',
        'kind',
        'regionId',
        'expectedObjectRevision',
        'expectedGeographyRevision',
        'session',
        'sessionId',
        'expectedIntentRevision',
        'capabilities',
        'documentSchemas',
        'blocks',
        'unknown',
      ]),
    )
    .max(8),
  code: z.enum([
    'invalid_type',
    'invalid_value',
    'invalid_union',
    'too_small',
    'too_big',
    'invalid_format',
    'unrecognized_keys',
    'custom',
  ]),
});
const Issues = z.array(RegionEncounterProblemIssueSchema).max(32).optional();
const Codes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'NOT_FOUND',
  'CONFLICT',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'INTENT_REVISION_STALE',
  'OFFER_UNAVAILABLE',
  'COMMAND_KEY_REUSED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'EXPERIENCE_COMMAND_UNSUPPORTED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
function error<C extends (typeof Codes)[number]>(code: C) {
  const definition = problemCatalogue[code];
  return {
    status: definition.status,
    message: definition.title,
    data: z.strictObject({
      type: z.literal(problemTypeUri(code)),
      title: z.literal<(typeof problemCatalogue)[C]['title']>(definition.title),
      status: z.literal<(typeof problemCatalogue)[C]['status']>(definition.status),
      code: z.literal(code),
      issues: Issues,
    }),
  };
}
const errors = {
  INVALID_REQUEST: error('INVALID_REQUEST'),
  UNAUTHENTICATED: error('UNAUTHENTICATED'),
  FORBIDDEN: error('FORBIDDEN'),
  ORIGIN_NOT_ALLOWED: error('ORIGIN_NOT_ALLOWED'),
  UNIVERSE_UNAVAILABLE: error('UNIVERSE_UNAVAILABLE'),
  NOT_FOUND: error('NOT_FOUND'),
  CONFLICT: error('CONFLICT'),
  PRIVACY_EPOCH_CHANGED: error('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: error('SCOPE_MISMATCH'),
  INTENT_REVISION_STALE: error('INTENT_REVISION_STALE'),
  OFFER_UNAVAILABLE: error('OFFER_UNAVAILABLE'),
  COMMAND_KEY_REUSED: error('COMMAND_KEY_REUSED'),
  PAYLOAD_TOO_LARGE: error('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: error('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: error('UNPROCESSABLE_REQUEST'),
  EXPERIENCE_COMMAND_UNSUPPORTED: error('EXPERIENCE_COMMAND_UNSUPPORTED'),
  SERVICE_UNAVAILABLE: error('SERVICE_UNAVAILABLE'),
  INTERNAL: error('INTERNAL'),
};
export const RegionEncounterProblemSchema = z.union(Object.values(errors).map((entry) => entry.data));

/** Describe direct RFC9457 documents using only converter-produced error data schemas.
 * This hook is OpenAPI metadata, not an installed HTTP exception serializer. */
function problemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing region encounter error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported region encounter error metadata');
    const documents = schema.oneOf.flatMap((branch) => {
      if (
        '$ref' in branch ||
        !branch.properties ||
        !('data' in branch.properties) ||
        !branch.properties['defined'] ||
        '$ref' in branch.properties['defined'] ||
        branch.properties['defined'].const !== true
      )
        return [];
      return [branch.properties['data']];
    });
    if (documents.length !== Codes.filter((code) => String(problemCatalogue[code].status) === status).length)
      throw new Error('Incomplete region encounter error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}
/** Declaration only. This read POST has no command effects or installed backend consumer. */
export const previewRegionEncounterContract = oc
  .route({
    method: 'POST',
    path: '/v1/experience/region/preview',
    successStatus: 200,
    tags: ['experience'],
    spec: problemResponses,
  })
  .errors(errors)
  .input(RegionEncounterPreviewRequestSchema)
  .output(RegionEncounterPreviewResponseSchema);

export const openRegionEncounterContract = oc
  .route({
    method: 'POST',
    path: '/v1/experience/region/open',
    successStatus: 200,
    tags: ['experience'],
    spec: problemResponses,
  })
  .errors(errors)
  .input(RegionEncounterOpenRequestSchema)
  .output(RegionEncounterOpenResponseSchema);

export type RegionEncounterTarget = z.infer<typeof RegionEncounterTargetSchema>;
export type RegionEncounterOpenRequest = z.infer<typeof RegionEncounterOpenRequestSchema>;
export type RegionEncounterOpenResponse = z.infer<typeof RegionEncounterOpenResponseSchema>;
export type RegionEncounterProblem = z.infer<typeof RegionEncounterProblemSchema>;

export type RegionEncounterExpected = z.infer<typeof RegionEncounterExpectedSchema>;
export type RegionEncounterPreviewRequest = z.infer<typeof RegionEncounterPreviewRequestSchema>;
export type RegionEncounterPreviewResponse = z.infer<typeof RegionEncounterPreviewResponseSchema>;
