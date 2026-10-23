import {
  RecordingProblemIssueSchema,
  RecordingProblemSchema,
  problemDetails,
  type RecordingProblem,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** Only fixed protocol tokens survive; never event indices, unknown keys or received values. */
export function recordingIssues(input: unknown): NonNullable<RecordingProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = RecordingProblemIssueSchema.shape.code.safeParse(candidate.code);
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const token = RecordingProblemIssueSchema.shape.path.element.safeParse(key);
        return token.success ? token.data : 'unknown';
      }),
    };
  });
}

/** Applied to preparse/auth failures as well as handler outcomes. No arbitrary catalogue extension. */
export function recordingDetails(details: ProblemDetails): RecordingProblem {
  const { type, title, status, code } = details;
  const parsed = RecordingProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: recordingIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : RecordingProblemSchema.parse(problemDetails('INTERNAL'));
}
