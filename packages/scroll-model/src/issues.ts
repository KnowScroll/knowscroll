/**
 * Stable reason codes. A code never changes meaning; a new meaning gets a new code. Validators
 * return codes and paths only, never the offending text, so reasons can be stored and shown to
 * operators without carrying content.
 */
export const REASON_CODES = [
  // Schema (shape) — mapped from the parser's own issue kinds, plus the text refinements.
  'schema_invalid_type',
  'schema_too_small',
  'schema_too_big',
  'schema_invalid_format',
  'schema_invalid_value',
  'schema_unrecognized_keys',
  'schema_invalid_union',
  'schema_invalid',
  'text_not_plain',
  'text_mentions_web_address',
  'text_too_long',
  'code_not_plain',
  'marks_duplicate',
  'number_out_of_range',
  'template_syntax',
  'id_format',
  'key_format',
  'key_reserved',
  'date_format',
  'language_format',
  'sha256_format',
  'block_type_format',
  // Document envelope
  'document_not_object',
  'document_too_deep',
  'document_too_large',
  'block_type_unknown',
  'block_version_unknown',
  // Structure
  'id_duplicate',
  'heading_missing',
  'too_many_blocks',
  'too_many_interactive',
  'too_many_params',
  'too_many_media',
  'visible_text_too_long',
  'gesture_mismatch',
  'a11y_label_mismatch',
  'a11y_description_unexpected',
  'fallback_text_too_short',
  'fallback_in_stored_document',
  'quote_attribution_unexpected',
  'code_too_many_lines',
  'code_line_too_long',
  'code_highlight_out_of_range',
  'table_shape',
  'media_poster_missing',
  'media_poster_unexpected',
  'media_captions_missing',
  'diagram_reference_unknown',
  'diagram_edge_self',
  'diagram_frames_missing',
  'diagram_frames_unexpected',
  'diagram_token_invalid',
  'diagram_target_invalid',
  'diagram_cells_invalid',
  'chart_shape',
  'chart_too_many_points',
  'chart_domain',
  'chart_log_scale',
  // Computation (simulations)
  'sim_key_duplicate',
  'sim_param_range',
  'sim_param_default',
  'sim_reference_unknown',
  'sim_lookup_table',
  'sim_view_invalid',
  'sim_view_out_of_range',
  'sim_template_key_unknown',
  'sim_band_invalid',
  'sim_output_not_finite',
  'sim_grid_too_large',
  'sim_display_invalid',
  'sim_display_mismatch',
  // Stored-revision checks
  'measures_mismatch',
  'integrity_mismatch',
  'rendition_in_stored_document',
  'rendition_integrity_mismatch',
  // Producer: envelope of the model reply
  'draft_not_object',
  'draft_too_deep',
  'draft_too_large',
  'draft_version_unknown',
  'fallback_reserved',
  'a11y_missing',
  'fallback_text_missing',
  // Producer and provenance: evidence and honesty
  'binding_claim_unknown',
  'binding_block_unknown',
  'binding_block_not_text',
  'binding_anchor_not_found',
  'binding_anchor_ambiguous',
  'binding_constant_unknown',
  'binding_range_invalid',
  'binding_field_unknown',
  'binding_section_unknown',
  'binding_value_unknown',
  'binding_anchor_crosses_sentence',
  'number_unbound',
  'numeric_block_unbound',
  'constant_unbound',
  'simulation_number_unbound',
  'simulation_unbound',
  'media_not_offered',
  'copied_passage',
  'provenance_mismatch',
  // Producer: authored documents (`scroll-authoring.v1`)
  'authoring_reference_unknown',
  'authoring_cite_unknown',
  'authoring_too_few_cites',
  'authoring_number_not_in_evidence',
  // Producer: fit to the brief
  'reading_length_out_of_brief',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(REASON_CODES);
export function isReasonCode(code: string): code is ReasonCode {
  return KNOWN_CODES.has(code);
}

/** One finding: a stable code and the dotted schema path it applies to (`$` for the whole). */
export interface Issue {
  readonly code: ReasonCode;
  readonly path: string;
}

/** Converts a parser issue (Zod) into a stable reason code without its message text. */
export function issueFromSchema(issue: { code: string; message: string; path: readonly PropertyKey[] }): Issue {
  const path = issue.path.length === 0 ? '$' : issue.path.map((part) => String(part)).join('.');
  if (issue.code === 'custom' && isReasonCode(issue.message)) return { code: issue.message, path };
  if (issue.code === 'invalid_format' && isReasonCode(issue.message)) return { code: issue.message, path };
  switch (issue.code) {
    case 'invalid_type':
      return { code: 'schema_invalid_type', path };
    case 'too_small':
      return { code: 'schema_too_small', path };
    case 'too_big':
      return { code: 'schema_too_big', path };
    case 'invalid_format':
      return { code: 'schema_invalid_format', path };
    case 'invalid_value':
      return { code: 'schema_invalid_value', path };
    case 'unrecognized_keys':
      return { code: 'schema_unrecognized_keys', path };
    case 'invalid_union':
      return { code: 'schema_invalid_union', path };
    default:
      return { code: 'schema_invalid', path };
  }
}

/** Removes repeated (code, path) pairs while keeping the first-seen order. */
export function uniqueIssues(issues: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}@${issue.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}
