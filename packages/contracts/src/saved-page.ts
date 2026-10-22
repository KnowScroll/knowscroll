import type { OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { KeepEntryRefSchema } from './keep.js';
import { UuidSchema } from './ids.js';
import { EncounterMetadataSchema } from './navigation.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const Pagination = z.literal('saved-page.v1');
export const SavedPageFilterSchema = z.enum(['all', 'reel', 'scroll']);
/** Syntax only. Future adapters must authenticate AND keep the private envelope confidential.
 * No caller can derive an anchor, authority, expiry or snapshot from this opaque string. */
export const SavedPageCursorSchema = z.string().regex(/^ksp1_[A-Za-z0-9_-]{43,1024}$/);
export const SavedPageRequestSchema = z.strictObject({
  pagination: Pagination,
  filter: SavedPageFilterSchema,
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/),
  cursor: SavedPageCursorSchema.optional(),
});

/** Exact legacy shape, including unknown-field stripping and the interim ID-only adapter. */
export const LegacySavedItemSchema = z
  .object({
    assetId: KeepEntryRefSchema.shape.assetId,
    assetRevision: z.number().int().min(1),
    savedAt: z.iso.datetime(),
    metadata: EncounterMetadataSchema.optional(),
    availability: z.enum(['available', 'corrected', 'withdrawn']).optional(),
    currentAssetRevision: z.number().int().min(1).optional(),
  })
  .refine(
    (item) =>
      item.currentAssetRevision === undefined ||
      (item.availability === 'corrected' && item.currentAssetRevision !== item.assetRevision),
    'A current revision is only supplied for a correction to a different saved revision.',
  );

const Entry = {
  ...KeepEntryRefSchema.shape,
  savedAt: z.iso.datetime(),
  /** Actual saved asset kind, including unavailable rows; never infer it from a title. */
  kind: z.enum(['reel', 'scroll']),
};
export const SavedPageItemSchema = z
  .discriminatedUnion('availability', [
    z.strictObject({
      ...Entry,
      availability: z.literal('available'),
      metadata: EncounterMetadataSchema,
      currentAssetRevision: z.never().optional(),
    }),
    z.strictObject({
      ...Entry,
      availability: z.literal('corrected'),
      metadata: EncounterMetadataSchema,
      currentAssetRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      ...Entry,
      availability: z.literal('withdrawn'),
      metadata: z.never().optional(),
      currentAssetRevision: z.never().optional(),
    }),
  ])
  .refine((item) => !item.metadata || item.metadata.kind === item.kind, 'Saved metadata must retain the actual kind.')
  .refine(
    (item) => item.availability !== 'corrected' || item.currentAssetRevision !== item.assetRevision,
    'A correction must identify a different current revision.',
  );

/** Live keyset read, NOT a retained membership/content/place snapshot. The personal revision is
 * only a catch-up watermark. Availability is current per page; Keep place remains a separate read. */
export const SavedPageResponseSchema = z
  .strictObject({
    pagination: Pagination,
    consistency: z.literal('live'),
    /** Exact initiating cursor echo; absent on the first page. Consumers compare before admission. */
    requestCursor: SavedPageCursorSchema.optional(),
    scope: z.strictObject({
      accountId: UuidSchema,
      privacyEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    filter: SavedPageFilterSchema,
    limit: z.number().int().min(1).max(50),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    items: z.array(SavedPageItemSchema).max(50),
    continuation: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('more'), cursor: SavedPageCursorSchema }),
      z.strictObject({ status: z.literal('end') }),
    ]),
  })
  .refine(
    (page) => page.continuation.status !== 'more' || page.continuation.cursor !== page.requestCursor,
    'A continuation cannot repeat the initiating cursor.',
  )
  .refine((page) => page.items.length <= page.limit, 'A page cannot exceed its requested limit.')
  .refine(
    (page) => page.items.every((item) => page.filter === 'all' || item.kind === page.filter),
    'A page must retain its selected filter.',
  )
  .refine(
    (page) =>
      new Set(page.items.map((item) => item.savedEntryId.toLowerCase())).size === page.items.length &&
      new Set(page.items.map((item) => item.assetId.toLowerCase())).size === page.items.length,
    'A page contains each current membership and asset at most once.',
  );

/** Static issue tokens only: no rejected cursor, private ID, anchor, key name or decoder error. */
export const SavedListProblemIssueSchema = z.strictObject({
  path: z.array(z.enum(['pagination', 'filter', 'limit', 'cursor', 'unknown'])).max(8),
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
const Codes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'SAVED_CURSOR_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'TOO_MANY_REQUESTS',
  'INTERNAL',
  'SERVICE_UNAVAILABLE',
] as const;
type Code = (typeof Codes)[number];
function branch<C extends Code>(code: C) {
  const definition = problemCatalogue[code];
  return z.strictObject({
    type: z.literal(problemTypeUri(code)),
    title: z.literal<(typeof problemCatalogue)[C]['title']>(definition.title),
    status: z.literal<(typeof problemCatalogue)[C]['status']>(definition.status),
    code: z.literal(code),
    issues: z.array(SavedListProblemIssueSchema).max(32).optional(),
  });
}
const schemas = {
  INVALID_REQUEST: branch('INVALID_REQUEST'),
  UNAUTHENTICATED: branch('UNAUTHENTICATED'),
  FORBIDDEN: branch('FORBIDDEN'),
  ORIGIN_NOT_ALLOWED: branch('ORIGIN_NOT_ALLOWED'),
  UNIVERSE_UNAVAILABLE: branch('UNIVERSE_UNAVAILABLE'),
  PRIVACY_EPOCH_CHANGED: branch('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: branch('SCOPE_MISMATCH'),
  SAVED_CURSOR_UNAVAILABLE: branch('SAVED_CURSOR_UNAVAILABLE'),
  PAYLOAD_TOO_LARGE: branch('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: branch('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: branch('UNPROCESSABLE_REQUEST'),
  TOO_MANY_REQUESTS: branch('TOO_MANY_REQUESTS'),
  INTERNAL: branch('INTERNAL'),
  SERVICE_UNAVAILABLE: branch('SERVICE_UNAVAILABLE'),
};
export const SavedListProblemSchema = z.union(Object.values(schemas));
export const savedListErrors = {
  INVALID_REQUEST: {
    status: problemCatalogue.INVALID_REQUEST.status,
    message: problemCatalogue.INVALID_REQUEST.title,
    data: schemas.INVALID_REQUEST,
  },
  UNAUTHENTICATED: {
    status: problemCatalogue.UNAUTHENTICATED.status,
    message: problemCatalogue.UNAUTHENTICATED.title,
    data: schemas.UNAUTHENTICATED,
  },
  FORBIDDEN: {
    status: problemCatalogue.FORBIDDEN.status,
    message: problemCatalogue.FORBIDDEN.title,
    data: schemas.FORBIDDEN,
  },
  ORIGIN_NOT_ALLOWED: {
    status: problemCatalogue.ORIGIN_NOT_ALLOWED.status,
    message: problemCatalogue.ORIGIN_NOT_ALLOWED.title,
    data: schemas.ORIGIN_NOT_ALLOWED,
  },
  UNIVERSE_UNAVAILABLE: {
    status: problemCatalogue.UNIVERSE_UNAVAILABLE.status,
    message: problemCatalogue.UNIVERSE_UNAVAILABLE.title,
    data: schemas.UNIVERSE_UNAVAILABLE,
  },
  PRIVACY_EPOCH_CHANGED: {
    status: problemCatalogue.PRIVACY_EPOCH_CHANGED.status,
    message: problemCatalogue.PRIVACY_EPOCH_CHANGED.title,
    data: schemas.PRIVACY_EPOCH_CHANGED,
  },
  SCOPE_MISMATCH: {
    status: problemCatalogue.SCOPE_MISMATCH.status,
    message: problemCatalogue.SCOPE_MISMATCH.title,
    data: schemas.SCOPE_MISMATCH,
  },
  SAVED_CURSOR_UNAVAILABLE: {
    status: problemCatalogue.SAVED_CURSOR_UNAVAILABLE.status,
    message: problemCatalogue.SAVED_CURSOR_UNAVAILABLE.title,
    data: schemas.SAVED_CURSOR_UNAVAILABLE,
  },
  PAYLOAD_TOO_LARGE: {
    status: problemCatalogue.PAYLOAD_TOO_LARGE.status,
    message: problemCatalogue.PAYLOAD_TOO_LARGE.title,
    data: schemas.PAYLOAD_TOO_LARGE,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: problemCatalogue.UNSUPPORTED_MEDIA_TYPE.status,
    message: problemCatalogue.UNSUPPORTED_MEDIA_TYPE.title,
    data: schemas.UNSUPPORTED_MEDIA_TYPE,
  },
  UNPROCESSABLE_REQUEST: {
    status: problemCatalogue.UNPROCESSABLE_REQUEST.status,
    message: problemCatalogue.UNPROCESSABLE_REQUEST.title,
    data: schemas.UNPROCESSABLE_REQUEST,
  },
  TOO_MANY_REQUESTS: {
    status: problemCatalogue.TOO_MANY_REQUESTS.status,
    message: problemCatalogue.TOO_MANY_REQUESTS.title,
    data: schemas.TOO_MANY_REQUESTS,
  },
  INTERNAL: {
    status: problemCatalogue.INTERNAL.status,
    message: problemCatalogue.INTERNAL.title,
    data: schemas.INTERNAL,
  },
  SERVICE_UNAVAILABLE: {
    status: problemCatalogue.SERVICE_UNAVAILABLE.status,
    message: problemCatalogue.SERVICE_UNAVAILABLE.title,
    data: schemas.SERVICE_UNAVAILABLE,
  },
};
/** Direct RFC9457 OpenAPI metadata only; this does not install an error/cache serializer. */
export function savedListProblemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing Saved list error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported Saved list error metadata');
    const documents = schema.oneOf.flatMap((candidate) => {
      if (
        '$ref' in candidate ||
        !candidate.properties ||
        !('data' in candidate.properties) ||
        !candidate.properties['defined'] ||
        '$ref' in candidate.properties['defined'] ||
        candidate.properties['defined'].const !== true
      )
        return [];
      return [candidate.properties['data']];
    });
    if (documents.length !== Codes.filter((code) => String(problemCatalogue[code].status) === status).length)
      throw new Error('Incomplete Saved list error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}

export type SavedPageRequest = z.infer<typeof SavedPageRequestSchema>;
export type SavedPageResponse = z.infer<typeof SavedPageResponseSchema>;
export type SavedListProblem = z.infer<typeof SavedListProblemSchema>;
