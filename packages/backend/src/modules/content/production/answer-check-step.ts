import type { ProposeOutcome } from '../../../reasoning/public.js';

/**
 * The codes the steps that ask a checker (the ask-order and library support checks, the recipe proposals) report, in the words
 * the answer check's step first used. The answer check's own model step is deleted with the v2 writer (#815).
 */

/** Why a checker gave nothing usable, as a code an operator can read. Never provider text. */
export function uncheckedCode(result: Exclude<ProposeOutcome<unknown>, { kind: 'proposed' }>): string {
  switch (result.kind) {
    case 'invalid_output':
      return 'invalid_output';
    case 'failed':
      return 'provider_failed';
    case 'unknown':
      return 'outcome_unknown';
    case 'refused':
      return `refused_${result.reason}`;
    case 'budget_exhausted':
    case 'quota_unavailable':
      return result.kind;
  }
}

export const pauseCode = (
  result: Extract<ProposeOutcome<unknown>, { kind: 'budget_exhausted' | 'quota_unavailable' }>,
) => (result.kind === 'budget_exhausted' ? `budget_${result.dimension}_${result.limit}` : result.kind);
