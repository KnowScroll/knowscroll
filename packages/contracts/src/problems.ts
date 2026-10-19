import { z } from 'zod';

/**
 * Stable public problem codes. A code never changes meaning; a new meaning gets a new code.
 * Each code has exactly one HTTP status and a fixed, non-personal title. The same codes are
 * used as `reasonCode` in diagnostics (blueprint §23 "typed outcomes", §26).
 */
export const problemCatalogue = {
  INVALID_REQUEST: { status: 400, title: 'The request is not valid.' },
  UNAUTHENTICATED: { status: 401, title: 'Sign-in is required.' },
  FORBIDDEN: { status: 403, title: 'This action is not allowed.' },
  NOT_FOUND: { status: 404, title: 'Not found.' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'This method is not allowed here.' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'The request body is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'The request body type is not supported.' },
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
