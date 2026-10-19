import { z } from 'zod';
import { AUTHORED_DATA_SCHEMAS, disclosureData } from '../blocks/catalog.js';
import { BlockA11y, FallbackText } from '../blocks/envelope.js';
import { Correction, Framing, TEMPLATES, THEME_FAMILIES } from '../document.js';
import { Claim, ProductionRecord, Source } from '../internal/provenance.js';
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
    /** Required for every block except paragraph, subheading, list, quote and callout. */
    a11y: BlockA11y.optional(),
    /** Required (≥ 40 characters) for every block except the text blocks above. */
    fallbackText: FallbackText.optional(),
    essential: z.boolean().optional(),
    data,
  });
}

const DraftParagraph = draftBlock('paragraph', AUTHORED_DATA_SCHEMAS.paragraph);
const DraftSubheading = draftBlock('subheading', AUTHORED_DATA_SCHEMAS.subheading);
const DraftList = draftBlock('list', AUTHORED_DATA_SCHEMAS.list);
const DraftQuote = draftBlock('quote', AUTHORED_DATA_SCHEMAS.quote);
const DraftCallout = draftBlock('callout', AUTHORED_DATA_SCHEMAS.callout);
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
 * Where the draft relies on an offered claim: `passage` with `anchorText` copied exactly from the
 * block's own text (it must occur once), `constant` for a simulation constant, or `block` when a
 * diagram, chart, table or simulation as a whole rests on the claim.
 */
export const DraftBinding = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('passage'),
    claimId: OpaqueId,
    blockId: LocalId,
    anchorText: z.string().min(1).max(LIMITS.passageChars),
  }),
  z.strictObject({ kind: z.literal('constant'), claimId: OpaqueId, blockId: LocalId, constantKey: ParamKey }),
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
  bindings: z.array(DraftBinding).max(LIMITS.blocks * 3),
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
