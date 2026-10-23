import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { KeepEntryRefSchema } from './keep.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { problemCatalogue, problemTypeUri } from './problems.js';
import { RecordingGenerationSchema } from './recording.js';

const Version = z.literal('keep-remove.v1');
const Scope = z.strictObject({
  accountId: UuidSchema,
  privacyEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

/** Removal names the actual Saved membership. An asset ID or Save receipt alone is insufficient. */
export const RemoveKeepEntrySchema = z
  .strictObject({
    version: Version,
    commandId: CommandIdSchema,
    entry: KeepEntryRefSchema,
    recordingGeneration: RecordingGenerationSchema.optional(),
  })
  .refine((r) => !Object.hasOwn(r, 'recordingGeneration') || r.recordingGeneration !== undefined, {
    path: ['recordingGeneration'],
  });

/** Historical acknowledgement only. It never asserts that this asset is currently absent:
 * a later Save may have created another membership, which replay must leave untouched. */
export const KeepRemovalAcceptanceSchema = z.strictObject({
  version: Version,
  scope: Scope,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
  operation: z.literal('keep.entry.remove'),
  entry: KeepEntryRefSchema,
});

/** Static tokens only; no positions, counts, unknown key names or current membership identifiers. */
export const KeepRemovalProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'commandId',
        'entry',
        'assetId',
        'assetRevision',
        'savedEntryId',
        'recordingGeneration',
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
const Issues = z.array(KeepRemovalProblemIssueSchema).max(32).optional();
const RemovalProblemCodes = [
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
] as const;
type RemovalProblemCode = (typeof RemovalProblemCodes)[number];
function problemBranch<C extends RemovalProblemCode>(code: C) {
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
};
export const KeepRemovalProblemSchema = z.union(Object.values(problemSchemas));
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
};

/** oRPC defaults to a wrapped RPC error. Its supported spec hook exposes the actual converter
 * output as direct RFC9457 documents; it is metadata, not an installed HTTP error handler. */
function removalProblemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(RemovalProblemCodes.map((code) => String(problemCatalogue[code].status)))) {
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
    const expected = RemovalProblemCodes.filter((code) => String(problemCatalogue[code].status) === status).length;
    if (documents.length !== expected) throw new Error('Incomplete Keep error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}
/** Declaration only: a future adapter must authorize the current account/epoch before receipt
 * lookup, replay a matching immutable removal before testing the now-deleted membership, and
 * otherwise remove only the exact current Saved UUID/ref in one normal action transaction. */
export const removeKeepEntryContract = oc
  .route({
    method: 'POST',
    path: '/v1/experience/keep/remove',
    successStatus: 200,
    tags: ['keep'],
    spec: removalProblemResponses,
  })
  .errors(errors)
  .input(RemoveKeepEntrySchema)
  .output(KeepRemovalAcceptanceSchema);

export type RemoveKeepEntry = z.infer<typeof RemoveKeepEntrySchema>;
export type KeepRemovalAcceptance = z.infer<typeof KeepRemovalAcceptanceSchema>;
export type KeepRemovalProblem = z.infer<typeof KeepRemovalProblemSchema>;
