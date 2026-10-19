import { z } from 'zod';
import { AUTHORED_DATA_SCHEMAS, disclosureData } from '../blocks/catalog.js';
import { BlockA11y, FallbackText } from '../blocks/envelope.js';
import { Correction, Framing, SeriesRef, TEMPLATES, THEME_FAMILIES } from '../document.js';
import { Claim, HEADER_FIELDS, ProductionRecord, Source } from '../internal/provenance.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { LanguageTag, LocalId, MediaRef, OpaqueId, ParamKey, plainText, Revision } from '../primitives.js';

/**
 * `scroll-draft.v1`: the JSON object the writer model returns. It holds only what the model
 * decides — title, dek, sections, blocks and claim bindings. Code sets everything else: ids that
 * are missing, block versions, gestures, the accessibility label and fallback text of text blocks,
 * reading time, coverage weights, framing, template, theme and the integrity hash.
 */
export const SCROLL_DRAFT_VERSION = 'scroll-draft.v1';

function draftBlock<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({
    /** Needed when a binding or a later revision refers to the block; assigned when missing. */
    id: LocalId.optional(),
    type: z.literal(type),
    /** Required (the label) for every non-text block. */
    a11y: BlockA11y.optional(),
    /** Required (≥ 40 characters) for every non-text block. */
    fallbackText: FallbackText.optional(),
    essential: z.boolean().optional(),
    data,
  });
}

/** Text blocks: code sets their accessibility label, and their fallback text is derived, never written. */
function draftTextBlock<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ id: LocalId.optional(), type: z.literal(type), essential: z.boolean().optional(), data });
}

const DraftParagraph = draftTextBlock('paragraph', AUTHORED_DATA_SCHEMAS.paragraph);
const DraftSubheading = draftTextBlock('subheading', AUTHORED_DATA_SCHEMAS.subheading);
const DraftList = draftTextBlock('list', AUTHORED_DATA_SCHEMAS.list);
const DraftQuote = draftTextBlock('quote', AUTHORED_DATA_SCHEMAS.quote);
const DraftCallout = draftTextBlock('callout', AUTHORED_DATA_SCHEMAS.callout);
const DraftCode = draftBlock('code', AUTHORED_DATA_SCHEMAS.code);
const DraftTable = draftBlock('table', AUTHORED_DATA_SCHEMAS.table);
const DraftFigure = draftBlock('figure', AUTHORED_DATA_SCHEMAS.figure);

const DraftNestedBlock = z.discriminatedUnion('type', [
  DraftParagraph,
  DraftList,
  DraftQuote,
  DraftCallout,
  DraftCode,
  DraftTable,
  DraftFigure,
]);

export const DraftBlock = z.discriminatedUnion('type', [
  DraftParagraph,
  DraftSubheading,
  DraftList,
  DraftQuote,
  DraftCallout,
  draftBlock('disclosure', disclosureData(DraftNestedBlock)),
  DraftCode,
  DraftTable,
  DraftFigure,
  draftBlock('media', AUTHORED_DATA_SCHEMAS.media),
  draftBlock('comparison', AUTHORED_DATA_SCHEMAS.comparison),
  draftBlock('timeline', AUTHORED_DATA_SCHEMAS.timeline),
  draftBlock('sequence', AUTHORED_DATA_SCHEMAS.sequence),
  draftBlock('diagram', AUTHORED_DATA_SCHEMAS.diagram),
  draftBlock('chart', AUTHORED_DATA_SCHEMAS.chart),
  draftBlock('simulation', AUTHORED_DATA_SCHEMAS.simulation),
]);
export type DraftBlock = z.infer<typeof DraftBlock>;
export type DraftNestedBlock = z.infer<typeof DraftNestedBlock>;

/**
 * Where the draft relies on an offered claim. Every number a reader sees or hears must lie inside
 * an anchor: `anchorText` is copied exactly from the named text (it must occur once there) and stays
 * inside one sentence.
 * - `passage`: a block's text — its passage text by default (`field` omitted, text blocks), or a
 *   named field (`data.caption`, `a11y.label`, `fallbackText`, `data.rows.1.2`, …).
 * - `header`: the title, dek or kicker. `heading`: a section heading.
 * - `constant`: a simulation constant. `value`: any other number of a simulation by its path in
 *   `data` (`params.0.max`, `outputs.1.formula.exponent`, `readout.bands.0.min`).
 * - `block`: a whole block (a chart's data, a diagram) rests on the claim.
 */
export const DraftBinding = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('passage'),
    claimId: OpaqueId,
    blockId: LocalId,
    field: z.string().min(1).max(80).optional(),
    anchorText: z.string().min(1).max(LIMITS.passageChars),
  }),
  z.strictObject({
    kind: z.literal('header'),
    claimId: OpaqueId,
    field: z.enum(HEADER_FIELDS),
    anchorText: z.string().min(1).max(LIMITS.passageChars),
  }),
  z.strictObject({
    kind: z.literal('heading'),
    claimId: OpaqueId,
    sectionId: LocalId,
    anchorText: z.string().min(1).max(LIMITS.passageChars),
  }),
  z.strictObject({ kind: z.literal('constant'), claimId: OpaqueId, blockId: LocalId, constantKey: ParamKey }),
  z.strictObject({ kind: z.literal('value'), claimId: OpaqueId, blockId: LocalId, path: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal('block'), claimId: OpaqueId, blockId: LocalId }),
]);
export type DraftBinding = z.infer<typeof DraftBinding>;

export const DraftSection = z.strictObject({
  id: LocalId.optional(),
  heading: plainText(1, FIELD_LIMITS.headingChars).nullable(),
  blocks: z.array(DraftBlock).min(1).max(LIMITS.blocks),
});

export const ScrollDraft = z.strictObject({
  draftVersion: z.literal(SCROLL_DRAFT_VERSION),
  title: plainText(4, FIELD_LIMITS.titleChars),
  dek: plainText(10, FIELD_LIMITS.dekChars),
  sections: z.array(DraftSection).min(1).max(LIMITS.sections),
  bindings: z.array(DraftBinding).max(LIMITS.blocks * 6),
});
export type ScrollDraft = z.infer<typeof ScrollDraft>;

/** JSON Schema of the draft, for providers that support constrained decoding (refinements are not expressible and stay in code). */
export function scrollDraftJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ScrollDraft, { target: 'draft-2020-12', unrepresentable: 'any' });
}

/**
 * The second argument of `compileDraft`: publication identity and framing chosen by code (from
 * the brief or scenario node), the evidence package the draft may bind to, research excerpts for
 * the copy check, the admitted media the draft may reference, and the production record.
 */
export const DraftProvenance = z.strictObject({
  schemaVersion: z.literal('scroll-draft-provenance.v1'),
  publication: z.strictObject({
    assetId: OpaqueId,
    revision: Revision,
    language: LanguageTag,
    explanationUnitId: OpaqueId,
    series: SeriesRef.optional(),
    template: z.enum(TEMPLATES),
    theme: z.strictObject({ family: z.enum(THEME_FAMILIES) }),
    kicker: plainText(1, FIELD_LIMITS.kickerChars),
    framing: Framing,
    corrections: z.array(Correction).max(FIELD_LIMITS.corrections),
    /** Allowed reading time in minutes, inclusive. */
    targetMinutes: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  }),
  claims: z.array(Claim).max(48),
  sources: z.array(Source).max(24),
  /** Research excerpts the copy check compares against (the material's own words stay out). */
  material: z.array(z.string().max(8_192)).max(8),
  offeredMedia: z.array(MediaRef).max(24),
  production: ProductionRecord,
});
export type DraftProvenance = z.infer<typeof DraftProvenance>;
