import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

const Version = z.literal('recording-policy.v1');
const Epoch = z.number().int().min(1).max(2_147_483_647);
const Revision = z.number().int().min(0).max(2_147_483_647);
/** A recording fence, distinct from privacy epoch. Never reset by Clear or wrapped at exhaustion. */
export const RecordingGenerationSchema = z.number().int().min(1).max(2_147_483_647);
export const RecordingScopeSchema = z.strictObject({ accountId: UuidSchema, privacyEpoch: Epoch });
export const RecordingPolicySchema = z
  .strictObject({ on: z.boolean(), generation: RecordingGenerationSchema })
  // Initial 1/on plus exactly one increment per boolean toggle fixes every later state.
  .refine((p) => p.on === (p.generation % 2 === 1));

/** Exact body across an unknown outcome. Necessary explicit-command records remain while off. */
export const SetRecordingPolicySchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  expectedPrivacyEpoch: Epoch,
  expectedRecordingGeneration: RecordingGenerationSchema,
  on: z.boolean(),
});

/** Historical acceptance, not the current policy or permission to start collecting. */
export const RecordingPolicyReceiptSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    requestedPrivacyEpoch: Epoch,
    on: z.boolean(),
    fromGeneration: RecordingGenerationSchema,
    toGeneration: RecordingGenerationSchema,
    changed: z.boolean(),
    recordedAt: z.iso.datetime(),
  })
  .refine((r) =>
    r.changed
      ? r.fromGeneration < 2_147_483_647 && r.toGeneration === r.fromGeneration + 1
      : r.toGeneration === r.fromGeneration,
  )
  .refine((r) => r.on === (r.toGeneration % 2 === 1));

/** Current owner/root/epoch authority precedes replay. Replaying this never retoggles a later policy. */
export const RecordingPolicyAcceptanceSchema = z.strictObject({
  version: Version,
  operation: z.literal('privacy.recording-set'),
  outcome: z.literal('accepted'),
  receipt: RecordingPolicyReceiptSchema,
  replayed: z.boolean(),
});

const CurrentTarget = z.strictObject({ kind: z.literal('current') });
const CommandTarget = z.strictObject({ kind: z.literal('command'), commandId: CommandIdSchema });
export const RecordingPolicyReadTargetSchema = z.discriminatedUnion('kind', [CurrentTarget, CommandTarget]);
export const ReadRecordingPolicySchema = z.strictObject({
  version: Version,
  readId: UuidSchema,
  target: RecordingPolicyReadTargetSchema,
});
const Snapshot = {
  version: Version,
  readId: UuidSchema,
  scope: RecordingScopeSchema,
  revision: Revision,
  policy: RecordingPolicySchema,
};
/** Pure correlated snapshot. not_recorded cannot prove an in-flight command will never arrive.
 * A historical on receipt cannot override a newer paused policy. Current authority is checked first. */
export const RecordingPolicyReadSchema = z
  .union([
    z.strictObject({ ...Snapshot, target: CurrentTarget }),
    z.strictObject({ ...Snapshot, target: CommandTarget, status: z.literal('not_recorded') }),
    z.strictObject({
      ...Snapshot,
      target: CommandTarget,
      status: z.literal('recorded'),
      receipt: RecordingPolicyReceiptSchema,
    }),
  ])
  .refine(
    (s) =>
      !('receipt' in s) ||
      (s.target.kind === 'command' &&
        s.target.commandId.toLowerCase() === s.receipt.commandId.toLowerCase() &&
        s.receipt.requestedPrivacyEpoch <= s.scope.privacyEpoch &&
        s.receipt.toGeneration <= s.policy.generation &&
        (s.receipt.toGeneration < s.policy.generation || s.receipt.on === s.policy.on)),
  );

/** Static input tokens only. Mask rejected keys/values and event indices before serializing issues. */
export const RecordingProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'readId',
        'target',
        'kind',
        'commandId',
        'expectedPrivacyEpoch',
        'expectedRecordingGeneration',
        'on',
        'recordingGeneration',
        'instrumentationVersion',
        'events',
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
const Issues = z.array(RecordingProblemIssueSchema).max(32).optional();
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
  'RECORDING_POLICY_STALE',
  'RECORDING_GENERATION_REQUIRED',
  'RECORDING_GENERATION_EXHAUSTED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'TOO_MANY_REQUESTS',
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
  PRIVACY_EPOCH_CHANGED: error('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: error('SCOPE_MISMATCH'),
  CONFLICT: error('CONFLICT'),
  COMMAND_KEY_REUSED: error('COMMAND_KEY_REUSED'),
  RECORDING_POLICY_STALE: error('RECORDING_POLICY_STALE'),
  RECORDING_GENERATION_REQUIRED: error('RECORDING_GENERATION_REQUIRED'),
  RECORDING_GENERATION_EXHAUSTED: error('RECORDING_GENERATION_EXHAUSTED'),
  PAYLOAD_TOO_LARGE: error('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: error('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: error('UNPROCESSABLE_REQUEST'),
  TOO_MANY_REQUESTS: error('TOO_MANY_REQUESTS'),
  SERVICE_UNAVAILABLE: error('SERVICE_UNAVAILABLE'),
  INTERNAL: error('INTERNAL'),
};
export const RecordingProblemSchema = z.union(Object.values(errors).map((entry) => entry.data));

/** Converter-produced direct RFC9457 documents; not an installed HTTP serializer or auth hook. */
function problemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing recording error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported recording error metadata');
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
      throw new Error('Incomplete recording error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}

/** Declaration-only fixed private JSON routes. No recording gate or consumer is mounted here. */
export function recordingPost<I extends z.ZodType, O extends z.ZodType>(
  path: '/v1/privacy/recording/read' | '/v1/privacy/recording/set' | '/v1/observations/recording-batch',
  input: I,
  output: O,
) {
  return oc
    .route({ method: 'POST', path, successStatus: 200, tags: ['privacy'], spec: problemResponses })
    .errors(errors)
    .input(input)
    .output(output);
}
export const recordingContract = {
  read: recordingPost('/v1/privacy/recording/read', ReadRecordingPolicySchema, RecordingPolicyReadSchema),
  set: recordingPost('/v1/privacy/recording/set', SetRecordingPolicySchema, RecordingPolicyAcceptanceSchema),
};

export type RecordingScope = z.infer<typeof RecordingScopeSchema>;
export type RecordingPolicy = z.infer<typeof RecordingPolicySchema>;
export type SetRecordingPolicy = z.infer<typeof SetRecordingPolicySchema>;
export type RecordingPolicyReceipt = z.infer<typeof RecordingPolicyReceiptSchema>;
export type RecordingPolicyAcceptance = z.infer<typeof RecordingPolicyAcceptanceSchema>;
export type RecordingPolicyReadTarget = z.infer<typeof RecordingPolicyReadTargetSchema>;
export type ReadRecordingPolicy = z.infer<typeof ReadRecordingPolicySchema>;
export type RecordingPolicyRead = z.infer<typeof RecordingPolicyReadSchema>;
export type RecordingProblem = z.infer<typeof RecordingProblemSchema>;
