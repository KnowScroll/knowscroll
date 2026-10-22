import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { problemCatalogue, problemTypeUri } from './problems.js';

/** Static schema tokens only. Never serialize a received name/value, token, message or peer cause. */
export const SocialProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'readId',
        'commandId',
        'conversation',
        'conversationId',
        'membershipId',
        'membershipRevision',
        'peerPersonId',
        'expectedPairRevision',
        'limit',
        'cursor',
        'body',
        'kind',
        'text',
        'target',
        'assetId',
        'assetRevision',
        'note',
        'throughSequence',
        'muted',
        'audience',
        'shareId',
        'selector',
        'token',
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
const Issues = z.array(SocialProblemIssueSchema).max(32).optional();
const Codes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'SHARING_UNAVAILABLE',
  'SHARING_REVISION_STALE',
  'CONFLICT',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'COMMAND_KEY_REUSED',
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
  SHARING_UNAVAILABLE: error('SHARING_UNAVAILABLE'),
  SHARING_REVISION_STALE: error('SHARING_REVISION_STALE'),
  CONFLICT: error('CONFLICT'),
  PRIVACY_EPOCH_CHANGED: error('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: error('SCOPE_MISMATCH'),
  COMMAND_KEY_REUSED: error('COMMAND_KEY_REUSED'),
  PAYLOAD_TOO_LARGE: error('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: error('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: error('UNPROCESSABLE_REQUEST'),
  TOO_MANY_REQUESTS: error('TOO_MANY_REQUESTS'),
  SERVICE_UNAVAILABLE: error('SERVICE_UNAVAILABLE'),
  INTERNAL: error('INTERNAL'),
};
export const SocialProblemSchema = z.union(Object.values(errors).map((entry) => entry.data));

/** Describe direct RFC9457 documents using only converter-produced error data schemas.
 * This hook is OpenAPI metadata, not an installed HTTP exception serializer. */
function problemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((code) => String(problemCatalogue[code].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing social error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf) throw new Error('Unsupported social error metadata');
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
      throw new Error('Incomplete social error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}

/** Private JSON POST declarations. No route, authentication/cache policy or serializer is installed. */
export function socialPost<I extends z.ZodType, O extends z.ZodType>(
  path: `/v1/social/${string}`,
  input: I,
  output: O,
) {
  return oc
    .route({ method: 'POST', path, successStatus: 200, tags: ['social'], spec: problemResponses })
    .errors(errors)
    .input(input)
    .output(output);
}
export type SocialProblem = z.infer<typeof SocialProblemSchema>;
