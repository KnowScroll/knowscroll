import { z } from 'zod';

/**
 * Stable public problem codes. A code never changes meaning; a new meaning gets a new code.
 * Each code has exactly one HTTP status and a fixed, non-personal title. The same codes are
 * used as `reasonCode` in diagnostics (blueprint §23 "typed outcomes", §26).
 */
export const problemCatalogue = {
  INVALID_REQUEST: { status: 400, title: 'The request is not valid.' },
  SIGN_IN_LINK_INVALID: { status: 400, title: 'This sign-in link has expired or was already used.' },
  UNAUTHENTICATED: { status: 401, title: 'Sign-in is required.' },
  FORBIDDEN: { status: 403, title: 'This action is not allowed.' },
  ORIGIN_NOT_ALLOWED: { status: 403, title: 'This request did not come from this site.' },
  UNIVERSE_UNAVAILABLE: { status: 403, title: 'This universe is not available.' },
  NOT_FOUND: { status: 404, title: 'Not found.' },
  ASSET_NOT_FOUND: { status: 404, title: 'This content is not available.' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'This method is not allowed here.' },
  CONFLICT: { status: 409, title: 'This conflicts with the current state; reload and try again.' },
  ASSET_REVISION_STALE: { status: 409, title: 'This content has changed; reload it and try again.' },
  PRIVACY_EPOCH_CHANGED: { status: 409, title: 'Your privacy settings changed; reload and try again.' },
  SCOPE_MISMATCH: { status: 409, title: 'This request was made for another account or privacy epoch; reload.' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'The request body is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'The request body type is not supported.' },
  UNPROCESSABLE_REQUEST: { status: 422, title: 'The request is well-formed but cannot be processed.' },
  COMMAND_KEY_REUSED: { status: 422, title: 'This command ID was already used for a different request.' },
  TOO_MANY_REQUESTS: { status: 429, title: 'Too many requests; try again shortly.' },
  INTERNAL: { status: 500, title: 'Something went wrong on our side.' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'The service is temporarily unavailable.' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemCode = keyof typeof problemCatalogue;

export const problemCodes = Object.keys(problemCatalogue) as [ProblemCode, ...ProblemCode[]];

export const ProblemCodeSchema = z.enum(problemCodes);

/** The `type` URI of a problem: a non-dereferenceable tag URI (RFC 9457 §3.1.1, RFC 4151). */
export function problemTypeUri(code: ProblemCode): string {
  return `tag:knowscroll.space,2026:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

/** One invalid input location; carries the path and a stable issue code, never the rejected value. */
export const ProblemIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
});

/**
 * RFC 9457 problem details as KnowScroll sends them, with media type `application/problem+json`.
 * `code` is the stable machine-readable member; `title` and `status` follow the catalogue.
 */
export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ProblemCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  issues: z.array(ProblemIssueSchema).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type ProblemIssue = z.infer<typeof ProblemIssueSchema>;

export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** Builds the problem document for a catalogue code. */
export function problemDetails(
  code: ProblemCode,
  extras: { detail?: string; instance?: string; issues?: ProblemIssue[] } = {},
): ProblemDetails {
  const entry = problemCatalogue[code];
  return {
    type: problemTypeUri(code),
    title: entry.title,
    status: entry.status,
    code,
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    ...(extras.instance === undefined ? {} : { instance: extras.instance }),
    ...(extras.issues === undefined ? {} : { issues: extras.issues }),
  };
}
