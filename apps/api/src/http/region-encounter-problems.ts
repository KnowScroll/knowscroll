import {
  RegionEncounterProblemIssueSchema,
  RegionEncounterProblemSchema,
  problemDetails,
  type RegionEncounterProblem,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** Closed schema-owned names only; rejected values/keys/indexes never become private errors. */
export function regionEncounterIssues(input: unknown): NonNullable<RegionEncounterProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const value = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = RegionEncounterProblemIssueSchema.shape.code.safeParse(value.code);
    const path = Array.isArray(value.path) ? value.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const parsed = RegionEncounterProblemIssueSchema.shape.path.element.safeParse(key);
        return parsed.success ? parsed.data : 'unknown';
      }),
    };
  });
}
export function regionEncounterDetails(details: ProblemDetails): RegionEncounterProblem {
  const { type, title, status, code } = details;
  const parsed = RegionEncounterProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: regionEncounterIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : RegionEncounterProblemSchema.parse(problemDetails('INTERNAL'));
}
