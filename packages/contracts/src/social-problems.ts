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
        'thread',
        'root',
        'friendPersonIds',
        'name',
        'anchor',
        'startMs',
        'endMs',
        'blockId',
        'response',
        'messageId',
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
function problemResponses(
  operation: OpenAPI.OperationObject,
  codes: readonly (typeof Codes)[number][] = Codes,
): OpenAPI.OperationObject {
  for (const status of new Set(codes.map((code) => String(problemCatalogue[code].status)))) {
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
    if (documents.length !== codes.filter((code) => String(problemCatalogue[code].status) === status).length)
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

/** Validation-only identity precheck for the new JSON surfaces. Inspect descriptors rather than
 * evaluating accessors; reject own undefined, symbols, sparse arrays, cycles and non-JSON values.
 * The supported converter uses the unchanged downstream schema for preprocess input/output.
 * This does not coerce/default/normalise a valid original body or sanitise a raw Zod error. */
export function socialJsonData<T extends z.ZodType>(schema: T) {
  return z.preprocess<z.input<T>, T, z.input<T>>((value, ctx) => {
    const ancestors = new Set<object>();
    let remaining = 512;
    function data(input: unknown, depth: number): boolean {
      if (--remaining < 0 || depth > 12) return false;
      if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
      if (typeof input === 'number') return Number.isFinite(input);
      if (typeof input !== 'object' || ancestors.has(input)) return false;
      const array = Array.isArray(input);
      const prototype: unknown = Object.getPrototypeOf(input);
      if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false;
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) return false;
      if (array) {
        const length = descriptors['length'];
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value > 512) return false;
        if (keys.length !== Number(length.value) + 1) return false;
        for (let i = 0; i < Number(length.value); i++) if (!Object.hasOwn(descriptors, String(i))) return false;
      }
      ancestors.add(input);
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key as string];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !data(descriptor.value, depth + 1))
          return false;
      }
      ancestors.delete(input);
      return true;
    }
    try {
      if (data(value, 0)) return value;
    } catch {
      // Proxies/invalid descriptors yield the same fixed refusal, never a received exception.
    }
    ctx.addIssue({ code: 'custom' });
    return z.NEVER;
  }, schema);
}

/** A public preview has no auth/peer/scope error channel. Dynamic validation keys/values must
 * be projected to these fixed tokens by the future HTTP boundary, never echoed or logged. */
export const PublicContentShareProblemIssueSchema = z.strictObject({
  path: z.array(z.enum(['version', 'readId', 'token', 'unknown'])).max(8),
  code: SocialProblemIssueSchema.shape.code,
});
const PublicIssues = z.array(PublicContentShareProblemIssueSchema).max(32).optional();
function publicError<C extends (typeof Codes)[number]>(code: C) {
  const definition = error(code);
  return { ...definition, data: socialJsonData(definition.data.extend({ issues: PublicIssues })) };
}
export const publicContentShareErrors = {
  INVALID_REQUEST: publicError('INVALID_REQUEST'),
  ORIGIN_NOT_ALLOWED: publicError('ORIGIN_NOT_ALLOWED'),
  PAYLOAD_TOO_LARGE: publicError('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: publicError('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: publicError('UNPROCESSABLE_REQUEST'),
  TOO_MANY_REQUESTS: publicError('TOO_MANY_REQUESTS'),
  SERVICE_UNAVAILABLE: publicError('SERVICE_UNAVAILABLE'),
  INTERNAL: publicError('INTERNAL'),
};
export const PublicContentShareProblemSchema = socialJsonData(
  z.union(Object.values(publicContentShareErrors).map((e) => e.data)),
);
/** Fixed public problem metadata only; the public module binds its closed input/output itself.
 * There is no generic public route builder accepting the private resolver's output union. */
export function publicContentShareProblemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  return problemResponses(
    operation,
    Object.keys(publicContentShareErrors) as (keyof typeof publicContentShareErrors)[],
  );
}
export type PublicContentShareProblem = z.infer<typeof PublicContentShareProblemSchema>;
