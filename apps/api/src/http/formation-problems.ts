import {
  FormationPresentationProblemIssueSchema,
  FormationPresentationProblemSchema,
  problemDetails,
  type FormationPresentationProblem,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** Closed schema-owned names only; rejected values/keys/indexes never become private errors. */
export function formationIssues(input: unknown): NonNullable<FormationPresentationProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const value = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = FormationPresentationProblemIssueSchema.shape.code.safeParse(value.code);
    const path = Array.isArray(value.path) ? value.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const parsed = FormationPresentationProblemIssueSchema.shape.path.element.safeParse(key);
        return parsed.success ? parsed.data : 'unknown';
      }),
    };
  });
}
export function formationDetails(details: ProblemDetails): FormationPresentationProblem {
  const { type, title, status, code } = details;
  const parsed = FormationPresentationProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: formationIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : FormationPresentationProblemSchema.parse(problemDetails('INTERNAL'));
}
