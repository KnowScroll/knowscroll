import { ORPCError } from '@orpc/server';
import {
  SocialProblemIssueSchema,
  SocialProblemSchema,
  problemDetails,
  type ProblemDetails,
  type SocialProblem,
} from '@knowscroll/contracts';
import type { SocialRefusal } from '@knowscroll/backend/modules/social';

/** Fixed schema tokens only: never received handles, keys, bodies or private peer reasons. */
export function socialIssues(input: unknown): NonNullable<SocialProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const code = SocialProblemIssueSchema.shape.code.safeParse(candidate.code);
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    return {
      code: code.success ? code.data : 'custom',
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const token = SocialProblemIssueSchema.shape.path.element.safeParse(key);
        return token.success ? token.data : 'unknown';
      }),
    };
  });
}

/** Applied centrally before auth/body parsing as well as to admitted Social outcomes. */
export function socialDetails(details: ProblemDetails): SocialProblem {
  const { type, title, status, code } = details;
  const parsed = SocialProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: socialIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : SocialProblemSchema.parse(problemDetails('INTERNAL'));
}
export function socialProblem(code: SocialProblem['code']) {
  const details = SocialProblemSchema.parse(problemDetails(code));
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
}
export function socialRefusal(code: SocialRefusal) {
  switch (code) {
    case 'invalid_input':
      return socialProblem('INVALID_REQUEST');
    case 'stale_revision':
      return socialProblem('SHARING_REVISION_STALE');
    case 'command_key_reused':
      return socialProblem('COMMAND_KEY_REUSED');
    // No invite fallback, private peer reason or counter/identity oracle.
    case 'unavailable':
    case 'unsupported':
    case 'counter_exhausted':
      return socialProblem('SHARING_UNAVAILABLE');
  }
}
