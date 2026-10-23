import type { Issue, ReasonCode } from '../issues.js';

/** The stages of `validateDraft` in order, then `publish` (compile's own final check). */
export const DRAFT_STAGES = ['envelope', 'schema', 'structure', 'computation', 'evidence', 'brief'] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number] | 'publish';

const ENVELOPE_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'draft_not_object',
  'draft_too_deep',
  'draft_too_large',
  'draft_version_unknown',
  'fallback_reserved',
  'block_type_unknown',
  'block_version_unknown',
]);
const SCHEMA_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
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
]);
const EVIDENCE_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'number_unbound',
  'numeric_block_unbound',
  'constant_unbound',
  'simulation_number_unbound',
  'simulation_unbound',
  'media_not_offered',
  'copied_passage',
]);
const PUBLISH_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'document_not_object',
  'document_too_deep',
  'document_too_large',
  'rendition_in_stored_document',
  'rendition_integrity_mismatch',
  'fallback_in_stored_document',
  'measures_mismatch',
  'integrity_mismatch',
  'provenance_mismatch',
]);

/** The stage a reason code belongs to (structure unless listed otherwise). */
export function stageOf(code: ReasonCode): DraftStage {
  if (code === 'authoring_reference_unknown') return 'structure';
  if (code.startsWith('authoring_')) return 'evidence';
  if (code.startsWith('schema_') || SCHEMA_CODES.has(code)) return 'schema';
  if (code.startsWith('sim_')) return 'computation';
  if (code.startsWith('binding_') || EVIDENCE_CODES.has(code)) return 'evidence';
  if (ENVELOPE_CODES.has(code)) return 'envelope';
  if (PUBLISH_CODES.has(code)) return 'publish';
  if (code === 'reading_length_out_of_brief') return 'brief';
  return 'structure';
}

/**
 * Fixed repair hints, one per code, for the single repair attempt (the validator never writes free
 * text about the draft). A repair request carries at most 32 `{code, path, hint}` items.
 */
export const REPAIR_HINTS: Readonly<Record<ReasonCode, string>> = {
  schema_invalid_type: 'A value has the wrong JSON type for its field.',
  schema_too_small: 'A string, number or list is below its minimum.',
  schema_too_big: 'A string, number or list is above its maximum.',
  schema_invalid_format: 'A value does not match its required format.',
  schema_invalid_value: 'A value is not one of the allowed options.',
  schema_unrecognized_keys: 'Remove fields the format does not define (code sets version and gesture).',
  schema_invalid_union: 'The object matches none of the allowed shapes for this field.',
  schema_invalid: 'The value does not match the format.',
  text_not_plain: 'Text must be single-line, trimmed and free of control characters.',
  text_mentions_web_address: 'Remove web addresses, domains and source names from reader text.',
  text_too_long: 'Shorten this text to its limit.',
  code_not_plain: 'Code may contain tabs and newlines but no other control characters.',
  marks_duplicate: 'List each inline mark once.',
  number_out_of_range: 'Use a finite number no larger than 1e15 in magnitude.',
  template_syntax: 'Templates are text with {key} placeholders only.',
  id_format: 'Ids are lowercase letters, digits and hyphens, 2–40 characters, starting with a letter.',
  key_format: 'Keys are camelCase letters and digits, starting with a lowercase letter.',
  key_reserved: 'Choose a different key; this name is reserved.',
  date_format: 'Use a real date as YYYY-MM-DD.',
  language_format: 'Use a language tag such as en or en-GB.',
  sha256_format: 'Use a lowercase 64-character SHA-256 hex digest.',
  block_type_format: 'Block types are lowercase words joined by hyphens.',
  document_not_object: 'The document must be one JSON object.',
  document_too_deep: 'The document nests too deeply.',
  document_too_large: 'The compiled document exceeds 128 KiB; shorten the Scroll.',
  block_type_unknown: 'Use only the listed block types.',
  block_version_unknown: 'Do not write block versions; code sets them.',
  id_duplicate: 'Every section, block and in-block id must be unique.',
  heading_missing: 'Every section after the first needs a heading.',
  too_many_blocks: 'Use at most 80 blocks, nested ones included.',
  too_many_interactive: 'Use at most 8 interactive blocks (simulation, sequence, media, non-static diagram).',
  too_many_params: 'Use at most 16 simulation parameters in the whole Scroll.',
  too_many_media: 'Use at most 12 figure and media blocks together.',
  visible_text_too_long:
    'Keep reader-visible text, counting each non-text block at its longer of text and fallback text, within 24,000 characters.',
  gesture_mismatch: 'Do not write gestures; code derives them.',
  a11y_label_mismatch: 'A text block\u2019s accessibility label is derived by code from its text; do not write it.',
  a11y_description_unexpected: 'A text block has no accessibility description; code derives its label.',
  fallback_text_too_short: 'Give this block a standalone text version of at least 40 characters.',
  fallback_in_stored_document: 'Fallback blocks exist only in client renditions.',
  quote_attribution_unexpected: 'A pull quote repeats the article and has no attribution.',
  code_too_many_lines: 'Keep code to 120 lines.',
  code_line_too_long: 'Keep each code line to 160 characters.',
  code_highlight_out_of_range: 'Highlight only lines that exist.',
  table_shape: 'Every table row needs exactly one cell per column.',
  media_poster_missing: 'A video needs an offered poster image.',
  media_poster_unexpected: 'Audio has no poster.',
  media_captions_missing: 'A video needs an offered captions track.',
  diagram_reference_unknown: 'Edges, groups, frames and weights may only name nodes, edges and groups that exist.',
  diagram_edge_self: 'An edge must join two different nodes.',
  diagram_frames_missing: 'Steps, toggle and drag-to-target need at least two frames.',
  diagram_frames_unexpected: 'A static diagram has no frames.',
  diagram_token_invalid: 'The drag token must be a node of kind token.',
  diagram_target_invalid:
    'Targets must be distinct non-token nodes mapped to existing frames; the initial frame must exist.',
  diagram_cells_invalid: 'The grid layout needs a unique cell on every node; other layouts use no cells.',
  chart_shape: 'Series must match the categories, and heatmap values the rows and columns.',
  chart_too_many_points: 'Use at most 200 data points.',
  chart_domain: 'Axis domains must be increasing and contain every value.',
  chart_log_scale: 'A log axis needs positive values.',
  sim_key_duplicate: 'Parameter, constant and output keys must be unique.',
  sim_param_range: 'A parameter needs min < max, step > 0, (max − min)/step a whole number of at most 1,000.',
  sim_param_default: 'The default must lie on the parameter grid min + k·step.',
  sim_reference_unknown: 'Formulas may use parameters, constants and earlier outputs only.',
  sim_lookup_table: 'Lookup table positions must strictly increase.',
  sim_view_invalid: 'The view must name existing parameters and outputs, with valid display bounds.',
  sim_view_out_of_range: 'Values shown as bars or areas must not be negative.',
  sim_template_key_unknown: 'Template placeholders must name parameters, constants or outputs.',
  sim_band_invalid: 'Bands need an existing output and min < max.',
  sim_output_not_finite: 'Every output must stay finite at every value the parameters can take.',
  sim_grid_too_large:
    'Keep the parameter grid (product of every parameter\u2019s positions + 1) at 10,000 points or fewer.',
  sim_display_invalid: 'The display scale of a simulation is set by code; do not write a display member.',
  sim_display_mismatch: 'The display scale of a simulation is computed by code from the grid.',
  measures_mismatch: 'Reading measures are computed by code.',
  integrity_mismatch: 'The integrity hash is computed by code.',
  rendition_in_stored_document: 'Only client renditions carry a rendition member.',
  rendition_integrity_mismatch: 'The rendition hash is computed by code.',
  draft_not_object: 'Return exactly one JSON object.',
  draft_too_deep: 'The reply nests too deeply; use the documented shapes.',
  draft_too_large: 'The reply is too large; shorten the Scroll.',
  draft_version_unknown: 'Set draftVersion to scroll-draft.v1.',
  fallback_reserved: 'Do not write fallback blocks.',
  a11y_missing: 'Give this block an a11y label.',
  fallback_text_missing: 'Give this block a standalone fallbackText.',
  binding_claim_unknown: 'Bind only to offered claim ids.',
  binding_block_unknown: 'Bind only to blocks that exist, by id.',
  binding_block_not_text:
    'Name a field for this block (for example data.caption); only text blocks have a default passage text.',
  binding_anchor_not_found: 'anchorText must be copied exactly from the named text.',
  binding_anchor_ambiguous: 'anchorText must occur exactly once in the named text; quote a longer stretch.',
  binding_constant_unknown: 'Bind constants that exist in that simulation.',
  binding_range_invalid: 'A passage range must lie inside its text.',
  binding_field_unknown: 'Bind to a text field the block has (code bodies cannot be bound).',
  binding_section_unknown: 'Bind headings of sections that exist and have a heading.',
  binding_value_unknown: 'Bind a number path the simulation states (for example params.0.max).',
  binding_anchor_crosses_sentence: 'An anchor stays inside one sentence.',
  number_unbound: 'Cover this number with an anchor bound to an offered claim, or remove the number.',
  numeric_block_unbound: 'Bind this chart’s data to an offered claim.',
  constant_unbound: 'Bind every constant of a non-illustrative simulation to a claim, or mark it illustrative.',
  simulation_number_unbound:
    'Bind this number of a non-illustrative simulation to a claim (a value binding), or mark the simulation illustrative.',
  simulation_unbound: 'A non-illustrative simulation needs at least one claim binding.',
  media_not_offered: 'Use only offered media.',
  copied_passage: 'Rewrite this in your own words: 9 or more words match the material.',
  provenance_mismatch: 'Internal provenance does not match the compiled document.',
  authoring_reference_unknown: 'Name only nodes and edges that exist in this diagram, by their id or label.',
  authoring_cite_unknown: 'Cite only the offered passage handles, such as e1 or e7.',
  authoring_too_few_cites: 'Ground the explanation in more of the offered passages: cite at least four different ones.',
  authoring_number_not_in_evidence:
    'Use a number only if it appears in a passage this block cites; otherwise say it in words.',
  reading_length_out_of_brief: 'Adjust the length to the brief’s reading time.',
};

/** Repair items for a refused draft: the first 32 issues with their fixed hints. */
export function repairItems(issues: readonly Issue[]): Array<{ code: ReasonCode; path: string; hint: string }> {
  return issues.slice(0, 32).map((issue) => ({ code: issue.code, path: issue.path, hint: REPAIR_HINTS[issue.code] }));
}
