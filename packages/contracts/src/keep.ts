import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { LocalId } from './content.js';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const Version = z.literal('keep-place.v1');
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Scope = z.strictObject({ accountId: UuidSchema, privacyEpoch: Revision });

export const KeepAssetRefSchema = z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision });
/** Minted per Saved membership; Unsave/resave replaces this private identity. Never derive it from a Save receipt. */
export const KeepEntryRefSchema = KeepAssetRefSchema.extend({ savedEntryId: UuidSchema });

/** Representation bound only. Fractions are preserved. The consumer clamps against the actual
 * immutable media duration, or the actual measured top-level Scroll block after layout. */
const PositionValue = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
export const KeepPositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reel'), positionMs: PositionValue }),
  z.strictObject({ kind: z.literal('scroll'), blockId: LocalId, offsetWithinBlock: PositionValue }),
]);
export const ReadKeepEntrySchema = z.strictObject({ version: Version, target: KeepAssetRefSchema });
const Snapshot = { version: Version, scope: Scope, target: KeepAssetRefSchema };
const Place = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none'), placeRevision: z.literal(0) }),
  z.strictObject({ status: z.literal('set'), placeRevision: Revision, position: KeepPositionSchema }),
]);
export const KeepEntrySnapshotSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...Snapshot, status: z.literal('not_saved') }),
    z.strictObject({ ...Snapshot, status: z.literal('saved_unavailable'), entry: KeepEntryRefSchema }),
    z.strictObject({ ...Snapshot, status: z.literal('available'), entry: KeepEntryRefSchema, place: Place }),
  ])
  .refine(
    (s) =>
      s.status === 'not_saved' ||
      (s.entry.assetId === s.target.assetId && s.entry.assetRevision === s.target.assetRevision),
  );

export const SetKeepPlaceSchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  entry: KeepEntryRefSchema,
  expectedPlaceRevision: Counter,
  position: KeepPositionSchema,
});
/** Immutable acceptance, not current content access or current place. Recheck current scope,
 * exact membership/ref and eligibility before replay; replay precedes testing the old CAS value. */
export const KeepPlaceAcceptanceSchema = z
  .strictObject({
    version: Version,
    scope: Scope,
    commandId: CommandIdSchema,
    recordedAt: z.iso.datetime(),
    replayed: z.boolean(),
    outcome: z.literal('accepted'),
    operation: z.literal('keep.place.set'),
    entry: KeepEntryRefSchema,
    basePlaceRevision: Counter,
    acceptedPlaceRevision: Revision,
  })
  .refine((r) => r.basePlaceRevision < Number.MAX_SAFE_INTEGER && r.acceptedPlaceRevision === r.basePlaceRevision + 1);

/** Static schema-owned tokens only: never copy an unknown/rejected property name or value.
 * Inputs have no arrays, so numeric path segments have no authorised meaning. */
export const KeepProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'target',
        'assetId',
        'assetRevision',
        'commandId',
        'entry',
        'savedEntryId',
        'expectedPlaceRevision',
        'position',
        'kind',
        'positionMs',
        'blockId',
        'offsetWithinBlock',
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
const Issues = z.array(KeepProblemIssueSchema).max(32).optional();
const KeepProblemCodes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'COMMAND_KEY_REUSED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
  'KEEP_ENTRY_UNAVAILABLE',
  'KEEP_PLACE_REVISION_STALE',
  'KEEP_PLACE_COUNTER_EXHAUSTED',
] as const;
type KeepProblemCode = (typeof KeepProblemCodes)[number];
function problemBranch<C extends KeepProblemCode>(code: C) {
  const definition = problemCatalogue[code];
  return z.strictObject({
    type: z.literal(problemTypeUri(code)),
    title: z.literal<(typeof problemCatalogue)[C]['title']>(definition.title),
    status: z.literal<(typeof problemCatalogue)[C]['status']>(definition.status),
    code: z.literal(code),
    issues: Issues,
  });
}
const problemSchemas = {
  INVALID_REQUEST: problemBranch('INVALID_REQUEST'),
  UNAUTHENTICATED: problemBranch('UNAUTHENTICATED'),
  FORBIDDEN: problemBranch('FORBIDDEN'),
  ORIGIN_NOT_ALLOWED: problemBranch('ORIGIN_NOT_ALLOWED'),
  UNIVERSE_UNAVAILABLE: problemBranch('UNIVERSE_UNAVAILABLE'),
  PRIVACY_EPOCH_CHANGED: problemBranch('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: problemBranch('SCOPE_MISMATCH'),
  COMMAND_KEY_REUSED: problemBranch('COMMAND_KEY_REUSED'),
  PAYLOAD_TOO_LARGE: problemBranch('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: problemBranch('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: problemBranch('UNPROCESSABLE_REQUEST'),
  SERVICE_UNAVAILABLE: problemBranch('SERVICE_UNAVAILABLE'),
  INTERNAL: problemBranch('INTERNAL'),
  KEEP_ENTRY_UNAVAILABLE: problemBranch('KEEP_ENTRY_UNAVAILABLE'),
  KEEP_PLACE_REVISION_STALE: problemBranch('KEEP_PLACE_REVISION_STALE').extend({ currentPlaceRevision: Counter }),
  KEEP_PLACE_COUNTER_EXHAUSTED: problemBranch('KEEP_PLACE_COUNTER_EXHAUSTED'),
};
export const KeepPlaceProblemSchema = z.union(Object.values(problemSchemas));
const errors = {
  INVALID_REQUEST: {
    status: problemCatalogue.INVALID_REQUEST.status,
    message: problemCatalogue.INVALID_REQUEST.title,
    data: problemSchemas.INVALID_REQUEST,
  },
  UNAUTHENTICATED: {
    status: problemCatalogue.UNAUTHENTICATED.status,
    message: problemCatalogue.UNAUTHENTICATED.title,
    data: problemSchemas.UNAUTHENTICATED,
  },
  FORBIDDEN: {
    status: problemCatalogue.FORBIDDEN.status,
    message: problemCatalogue.FORBIDDEN.title,
    data: problemSchemas.FORBIDDEN,
  },
  ORIGIN_NOT_ALLOWED: {
    status: problemCatalogue.ORIGIN_NOT_ALLOWED.status,
    message: problemCatalogue.ORIGIN_NOT_ALLOWED.title,
    data: problemSchemas.ORIGIN_NOT_ALLOWED,
  },
  UNIVERSE_UNAVAILABLE: {
    status: problemCatalogue.UNIVERSE_UNAVAILABLE.status,
    message: problemCatalogue.UNIVERSE_UNAVAILABLE.title,
    data: problemSchemas.UNIVERSE_UNAVAILABLE,
  },
  PRIVACY_EPOCH_CHANGED: {
    status: problemCatalogue.PRIVACY_EPOCH_CHANGED.status,
    message: problemCatalogue.PRIVACY_EPOCH_CHANGED.title,
    data: problemSchemas.PRIVACY_EPOCH_CHANGED,
  },
  SCOPE_MISMATCH: {
    status: problemCatalogue.SCOPE_MISMATCH.status,
    message: problemCatalogue.SCOPE_MISMATCH.title,
    data: problemSchemas.SCOPE_MISMATCH,
  },
  COMMAND_KEY_REUSED: {
    status: problemCatalogue.COMMAND_KEY_REUSED.status,
    message: problemCatalogue.COMMAND_KEY_REUSED.title,
    data: problemSchemas.COMMAND_KEY_REUSED,
  },
  PAYLOAD_TOO_LARGE: {
    status: problemCatalogue.PAYLOAD_TOO_LARGE.status,
    message: problemCatalogue.PAYLOAD_TOO_LARGE.title,
    data: problemSchemas.PAYLOAD_TOO_LARGE,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: problemCatalogue.UNSUPPORTED_MEDIA_TYPE.status,
    message: problemCatalogue.UNSUPPORTED_MEDIA_TYPE.title,
    data: problemSchemas.UNSUPPORTED_MEDIA_TYPE,
  },
  UNPROCESSABLE_REQUEST: {
    status: problemCatalogue.UNPROCESSABLE_REQUEST.status,
    message: problemCatalogue.UNPROCESSABLE_REQUEST.title,
    data: problemSchemas.UNPROCESSABLE_REQUEST,
  },
  SERVICE_UNAVAILABLE: {
    status: problemCatalogue.SERVICE_UNAVAILABLE.status,
    message: problemCatalogue.SERVICE_UNAVAILABLE.title,
    data: problemSchemas.SERVICE_UNAVAILABLE,
  },
  INTERNAL: {
    status: problemCatalogue.INTERNAL.status,
    message: problemCatalogue.INTERNAL.title,
    data: problemSchemas.INTERNAL,
  },
  KEEP_ENTRY_UNAVAILABLE: {
    status: problemCatalogue.KEEP_ENTRY_UNAVAILABLE.status,
    message: problemCatalogue.KEEP_ENTRY_UNAVAILABLE.title,
    data: problemSchemas.KEEP_ENTRY_UNAVAILABLE,
  },
  KEEP_PLACE_REVISION_STALE: {
    status: problemCatalogue.KEEP_PLACE_REVISION_STALE.status,
    message: problemCatalogue.KEEP_PLACE_REVISION_STALE.title,
    data: problemSchemas.KEEP_PLACE_REVISION_STALE,
  },
  KEEP_PLACE_COUNTER_EXHAUSTED: {
    status: problemCatalogue.KEEP_PLACE_COUNTER_EXHAUSTED.status,
    message: problemCatalogue.KEEP_PLACE_COUNTER_EXHAUSTED.title,
    data: problemSchemas.KEEP_PLACE_COUNTER_EXHAUSTED,
  },
};

/** oRPC defaults to a wrapped RPC error. Its supported spec hook exposes the actual converter
 * output as direct RFC9457 documents; it is metadata, not an installed HTTP error handler. */
function keepProblemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(KeepProblemCodes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing Keep error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported Keep error metadata');
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
    const expected = KeepProblemCodes.filter((code) => String(problemCatalogue[code].status) === status).length;
    if (documents.length !== expected) throw new Error('Incomplete Keep error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}
const route = { method: 'POST', successStatus: 200, tags: ['keep'], spec: keepProblemResponses } as const;
export const keepContract = {
  read: oc
    .route({ ...route, path: '/v1/experience/keep/read' })
    .errors(errors)
    .input(ReadKeepEntrySchema)
    .output(KeepEntrySnapshotSchema),
  setPlace: oc
    .route({ ...route, path: '/v1/experience/keep/place' })
    .errors(errors)
    .input(SetKeepPlaceSchema)
    .output(KeepPlaceAcceptanceSchema),
};

export type KeepAssetRef = z.infer<typeof KeepAssetRefSchema>;
export type KeepEntryRef = z.infer<typeof KeepEntryRefSchema>;
export type KeepPosition = z.infer<typeof KeepPositionSchema>;
export type ReadKeepEntry = z.infer<typeof ReadKeepEntrySchema>;
export type KeepEntrySnapshot = z.infer<typeof KeepEntrySnapshotSchema>;
export type SetKeepPlace = z.infer<typeof SetKeepPlaceSchema>;
export type KeepPlaceAcceptance = z.infer<typeof KeepPlaceAcceptanceSchema>;
export type KeepPlaceProblem = z.infer<typeof KeepPlaceProblemSchema>;
