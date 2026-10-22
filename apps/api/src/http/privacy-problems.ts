import {
  PrivacyProblemIssueSchema,
  PrivacyProblemSchema,
  problemDetails,
  type PrivacyProblem,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** Input paths contain no arrays. Neither unknown keys nor numeric segments may escape. */
export function privacyIssues(input: unknown): NonNullable<PrivacyProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = PrivacyProblemIssueSchema.shape.code.safeParse(candidate.code);
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const token = PrivacyProblemIssueSchema.shape.path.element.safeParse(key);
        return token.success ? token.data : 'unknown';
      }),
    };
  });
}

/** Closed RFC9457 projection, also applied before authentication and JSON parsing. */
export function privacyDetails(details: ProblemDetails): PrivacyProblem {
  const { type, title, status, code } = details;
  const result = PrivacyProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: privacyIssues(details.issues) }),
  });
  return result.success ? result.data : PrivacyProblemSchema.parse(problemDetails('INTERNAL'));
}
