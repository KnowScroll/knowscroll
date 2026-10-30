import type { ReasonCode } from '../issues.js';

/**
 * Reason codes of `scroll-document.v2` and `scroll-authoring.v2`. Like the v1 codes they are stable
 * (a code never changes meaning), and a finding carries only the code and a path, never the text it
 * is about. They live apart from `REASON_CODES` because the writer's repair catalogue is limited to
 * 128 codes and v1's already fills most of it: the v2 writer sends its own catalogue
 * (`producer/v2/reasons.ts`).
 */
export const V2_REASON_CODES = [
  // Stops and their text.
  'stops_too_few',
  'stop_too_long',
  'line_too_long',
  'simple_too_long',
  'heading_misplaced',
  // Calls.
  'call_it_missing',
  'call_budget_exceeded',
  'final_call_missing',
  'final_call_misplaced',
  'call_answer_invalid',
  'call_options_duplicate',
  'common_guess_invalid',
  'common_guess_missing',
  'common_guess_unexpected',
  // Asides and the recap.
  'aside_anchor_unknown',
  'aside_before_stop',
  'aside_after_final_call',
  'limits_aside_missing',
  'limits_aside_last',
  'recap_small_print_unknown',
  // The stage.
  'stage_missing',
  'stage_unexpected',
  'stage_first_state_missing',
  'stage_state_stop_unknown',
  'stage_states_unordered',
  'stage_state_repeated',
  'stage_too_static',
  'stage_alt_mismatch',
  // The misconception, decided with the recipe.
  'misconception_source_unreviewed',
] as const;

export type V2ReasonCode = (typeof V2_REASON_CODES)[number];

/** One finding of the v2 path: a v1 code or a v2 code, and the dotted path it applies to. */
export interface IssueV2 {
  readonly code: ReasonCode | V2ReasonCode;
  readonly path: string;
}

/** Removes repeated (code, path) pairs and keeps the first-seen order. */
export function uniqueIssuesV2(issues: readonly IssueV2[]): IssueV2[] {
  const seen = new Set<string>();
  const kept: IssueV2[] = [];
  for (const issue of issues) {
    const key = `${issue.code}@${issue.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(issue);
  }
  return kept;
}
