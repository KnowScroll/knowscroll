import {
  SavedListProblemIssueSchema,
  SavedListProblemSchema,
  problemDetails,
  type SavedListProblem,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** Only schema-owned static tokens may leave the private GET read, even before authentication. */
export function savedListIssues(input: unknown): NonNullable<SavedListProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = SavedListProblemIssueSchema.shape.code.safeParse(candidate.code);
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const parsed = SavedListProblemIssueSchema.shape.path.element.safeParse(key);
        return parsed.success ? parsed.data : 'unknown';
      }),
    };
  });
}
export function savedListDetails(details: ProblemDetails): SavedListProblem {
  const { type, title, status, code } = details;
  const result = SavedListProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: savedListIssues(details.issues) }),
  });
  return result.success ? result.data : SavedListProblemSchema.parse(problemDetails('INTERNAL'));
}
