import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const Version = z.literal('clear-exploration.v1');
const Epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Scope = z.strictObject({ accountId: UuidSchema, privacyEpoch: Epoch });

/** Explicit intent only. The server derives the owner/universe from current authenticated scope.
 * Reuse this exact body after an unknown reply, using fresh current session/scope authority.
 * A stale epoch without an existing account-owned receipt can never start a clear. */
export const ClearExplorationSchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  expectedPrivacyEpoch: Epoch,
  confirmation: z.literal('clear-exploration-preserve-keep-and-social'),
});

const ReceiptFields = {
  commandId: CommandIdSchema,
  fromEpoch: Epoch,
  toEpoch: Epoch,
  recordedAt: z.iso.datetime(),
};
function incrementsOnce(r: { fromEpoch: number; toEpoch: number }): boolean {
  return r.fromEpoch < Number.MAX_SAFE_INTEGER && r.toEpoch === r.fromEpoch + 1;
}
/** Account-lifetime receipt metadata. Epochs describe that operation, never current authorization. */
export const ClearExplorationReceiptSchema = z.strictObject(ReceiptFields).refine(incrementsOnce);
/** 202 is durable acceptance only, not live cleanup, backup expiry or a new AccountScope.
 * replayed describes delivery; all other receipt fields are immutable across authorized replay. */
export const ClearExplorationAcceptanceSchema = z
  .strictObject({
    version: Version,
    ...ReceiptFields,
    outcome: z.literal('accepted'),
    operation: z.literal('privacy.clear-exploration'),
    replayed: z.boolean(),
  })
  .refine(incrementsOnce);

export const ClearExplorationStatusTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('latest') }),
  z.strictObject({ kind: z.literal('command'), commandId: CommandIdSchema }),
]);
export const ReadClearExplorationStatusSchema = z.strictObject({
  version: Version,
  target: ClearExplorationStatusTargetSchema,
});
/** Coarse states, not percentages, owner implementation names or a guarantee of progress. */
export const ClearExplorationPhaseSchema = z.enum([
  'removing_live_data',
  'waiting_for_accounting',
  'verifying_live_removal',
]);
export const ClearExplorationFailureCodeSchema = z.enum(['temporarily_unavailable', 'completion_unverified']);
const Snapshot = { version: Version, scope: Scope, target: ClearExplorationStatusTargetSchema };
/** Read-only current status. not_recorded is one serialized snapshot, not proof a delayed command
 * cannot arrive. Current scope must be checked before lookup; status reads create no work.
 * completed_live excludes backup/provider/offline expiry and does not grant reconstruction. */
export const ClearExplorationStatusSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...Snapshot, status: z.literal('not_recorded') }),
    z.strictObject({
      ...Snapshot,
      status: z.literal('pending'),
      receipt: ClearExplorationReceiptSchema,
      phase: ClearExplorationPhaseSchema,
    }),
    z.strictObject({
      ...Snapshot,
      status: z.literal('failed'),
      receipt: ClearExplorationReceiptSchema,
      phase: ClearExplorationPhaseSchema,
      code: ClearExplorationFailureCodeSchema,
    }),
    z.strictObject({ ...Snapshot, status: z.literal('completed_live'), receipt: ClearExplorationReceiptSchema }),
  ])
  .refine(
    (s) =>
      s.status === 'not_recorded' ||
      (s.receipt.toEpoch <= s.scope.privacyEpoch &&
        (s.target.kind === 'latest' || s.target.commandId === s.receipt.commandId)),
  );

/** Only schema-owned tokens. Unknown/rejected keys and values must be masked, never echoed.
 * No arrays occur in inputs, so numeric path segments are not authorized. */
export const PrivacyProblemIssueSchema = z.strictObject({
  path: z
    .array(z.enum(['version', 'commandId', 'expectedPrivacyEpoch', 'confirmation', 'target', 'kind', 'unknown']))
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
const Issues = z.array(PrivacyProblemIssueSchema).max(32).optional();
const Codes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'CONFLICT',
  'COMMAND_KEY_REUSED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
type PrivacyProblemCode = (typeof Codes)[number];
function problemBranch<C extends PrivacyProblemCode>(code: C) {
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
  CONFLICT: problemBranch('CONFLICT'),
  COMMAND_KEY_REUSED: problemBranch('COMMAND_KEY_REUSED'),
  PAYLOAD_TOO_LARGE: problemBranch('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: problemBranch('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: problemBranch('UNPROCESSABLE_REQUEST'),
  SERVICE_UNAVAILABLE: problemBranch('SERVICE_UNAVAILABLE'),
  INTERNAL: problemBranch('INTERNAL'),
};
export const PrivacyProblemSchema = z.union(Object.values(problemSchemas));
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
  CONFLICT: {
    status: problemCatalogue.CONFLICT.status,
    message: problemCatalogue.CONFLICT.title,
    data: problemSchemas.CONFLICT,
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
};

/** Exact converter-produced RFC9457 metadata, not an installed HTTP error serializer. */
function privacyProblemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing privacy error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported privacy error metadata');
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
    const expected = Codes.filter((code) => String(problemCatalogue[code].status) === status).length;
    if (documents.length !== expected) throw new Error('Incomplete privacy error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}
const route = { method: 'POST', tags: ['privacy'], spec: privacyProblemResponses } as const;
export const privacyContract = {
  clearExploration: oc
    .route({ ...route, path: '/v1/privacy/clear-exploration', successStatus: 202 })
    .errors(errors)
    .input(ClearExplorationSchema)
    .output(ClearExplorationAcceptanceSchema),
  readClearExplorationStatus: oc
    .route({ ...route, path: '/v1/privacy/clear-exploration/status', successStatus: 200 })
    .errors(errors)
    .input(ReadClearExplorationStatusSchema)
    .output(ClearExplorationStatusSchema),
};

export type ClearExploration = z.infer<typeof ClearExplorationSchema>;
export type ClearExplorationReceipt = z.infer<typeof ClearExplorationReceiptSchema>;
export type ClearExplorationAcceptance = z.infer<typeof ClearExplorationAcceptanceSchema>;
export type ClearExplorationStatusTarget = z.infer<typeof ClearExplorationStatusTargetSchema>;
export type ReadClearExplorationStatus = z.infer<typeof ReadClearExplorationStatusSchema>;
export type ClearExplorationPhase = z.infer<typeof ClearExplorationPhaseSchema>;
export type ClearExplorationFailureCode = z.infer<typeof ClearExplorationFailureCodeSchema>;
export type ClearExplorationStatus = z.infer<typeof ClearExplorationStatusSchema>;
export type PrivacyProblem = z.infer<typeof PrivacyProblemSchema>;
