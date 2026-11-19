import type { ReasonCode } from '../issues.js';
import type { V2ReasonCode } from '../v2/issues.js';

/**
 * Reason codes of `scroll-document.v3`. Stable (a code never changes meaning); a finding carries only the code and a
 * path, never the text it is about. They live apart from v1's and v2's because each writer's repair catalogue is
 * limited to 128 codes; the document v3 writer will send its own.
 */
export const V3_REASON_CODES = [
  // Sections, beats and their words.
  'beats_too_few',
  'beats_too_many',
  'beat_too_long',
  'first_beat_too_long',
  'simple_too_long',
  'main_text_too_short',
  'main_text_too_long',
  // Pictures: the data of a picture.
  'picture_unshown',
  'picture_ids_duplicate',
  'picture_ref_unknown',
  'picture_cell_taken',
  'picture_cell_outside',
  'picture_way_bent',
  'picture_steps_missing',
  'picture_tally_step_invalid',
  'picture_region_invalid',
  'picture_value_invalid',
  // Pictures: a beat's `show`.
  'show_picture_unknown',
  'show_state_invalid',
  // Linked phrases.
  'link_phrase_not_once',
  'link_part_unknown',
  'link_without_picture',
  'link_phrases_overlap',
  // Controls.
  'control_budget_exceeded',
  'control_without_show',
  'control_unfit',
  // Asides, the takeaway, the ask suggestions.
  'aside_anchor_unknown',
  'limits_aside_missing',
  'takeaway_sentences',
  // The editorial compile: a quotation must match a passage it cites word for word.
  'quote_not_in_evidence',
] as const;

export type V3ReasonCode = (typeof V3_REASON_CODES)[number];

/**
 * The one v2 code a v3 finding may carry: the notice that a myth's source label is not yet reviewed. It means the same
 * in both formats and is a notice, never a refusal, so v3 reuses it instead of keeping a second copy of the code.
 */
export type SharedNoticeCode = Extract<V2ReasonCode, 'misconception_source_unreviewed'>;

/** One finding of the document v3 path: a v1 code (size, schema, ids, measures, hash), a document v3 code or a shared notice. */
export interface IssueV3 {
  readonly code: ReasonCode | V3ReasonCode | SharedNoticeCode;
  readonly path: string;
}

/** Removes repeated (code, path) pairs and keeps the first-seen order. */
export function uniqueIssuesV3(issues: readonly IssueV3[]): IssueV3[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}@${issue.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
