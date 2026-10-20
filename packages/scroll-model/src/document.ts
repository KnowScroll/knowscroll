import { z } from './zod.js';
import { Block, type AnyBlock } from './blocks/catalog.js';
import { FIELD_LIMITS, LIMITS, SCROLL_LIMITS_VERSION } from './limits.js';
import { IsoDate, LanguageTag, LocalId, OpaqueId, plainText, Revision, Sha256Hex } from './primitives.js';

export const SCROLL_DOCUMENT_SCHEMA_VERSION = 'scroll-document.v1';
export const SCROLL_MEASURES_VERSION = 'scroll-measures.v1';
export const INTEGRITY_METHOD = 'canonical-json-sha256.v1';

/** Reader templates: the poster article (E02) and the editorial essay (E09-2). */
export const TEMPLATES = ['poster', 'editorial'] as const;

/** Visual families from the design tokens (`family.*`): hue plus surface pattern. */
export const THEME_FAMILIES = ['learning-machines', 'systems', 'past', 'play', 'worlds'] as const;

/**
 * How the Scroll relates to what is established, copied by code from the brief or scenario node
 * (never written by the model) and shown persistently by the reader (D-006 a).
 * - `factual`: an explanation of what is established.
 * - `hypothetical`: a what-if; `assumptions` names what is changed (speculative premises are
 *   stated here), `kept` what stays the same. Rendered as "Hypothetical".
 * - `perspective`: the same subject through a named lens.
 */
export const Framing = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('factual') }),
  z.strictObject({
    kind: z.literal('hypothetical'),
    assumptions: z.array(plainText(3, 160)).min(1).max(4),
    kept: z.array(plainText(3, 160)).max(4),
  }),
  z.strictObject({ kind: z.literal('perspective'), lens: plainText(3, 80) }),
]);
export type Framing = z.infer<typeof Framing>;

export const Section = z.strictObject({
  id: LocalId,
  /** Only the first section may be untitled (the introduction). */
  heading: plainText(1, FIELD_LIMITS.headingChars).nullable(),
  blocks: z.array(Block).min(1).max(LIMITS.blocks),
});
export type Section = z.infer<typeof Section>;

/** A reader-facing correction note, written only by the correction workflow ("Corrected 14 Oct …"). */
export const Correction = z.strictObject({
  on: IsoDate,
  summary: plainText(10, 200),
});

/**
 * Reading measures computed by code from content size (`scroll-measures.v1`): a weight per
 * top-level block in word-equivalents, their total and the estimated reading time. The server
 * computes section coverage from these weights and the visible block ids a client reports.
 */
export const Measures = z.strictObject({
  version: z.literal(SCROLL_MEASURES_VERSION),
  readingMinutes: z.number().int().min(1).max(240),
  totalWeight: z.number().int().min(0),
  // One entry per top-level block. Bounded structurally (sections × blocks per section) so that a
  // document over the block limit is reported as `too_many_blocks`, not as a schema error here.
  blocks: z
    .array(z.strictObject({ blockId: LocalId, weight: z.number().int().min(0) }))
    .max(LIMITS.sections * LIMITS.blocks),
});
export type Measures = z.infer<typeof Measures>;

/** SHA-256 of the canonical JSON of the document without its `integrity` (and `rendition`) member. */
export const Integrity = z.strictObject({
  method: z.literal(INTEGRITY_METHOD),
  sha256: Sha256Hex,
});

/**
 * Present only on a client rendition that substituted blocks (`negotiate`). `of` names the stored
 * revision (its `integrity.sha256`); `sha256` covers exactly what the client received: the
 * canonical JSON of the rendition without `integrity` and `rendition`. A client verifies
 * `rendition.sha256` when the member is present and `integrity.sha256` otherwise.
 */
export const Rendition = z.strictObject({
  method: z.literal(INTEGRITY_METHOD),
  of: Sha256Hex,
  sha256: Sha256Hex,
});

/** The series this Scroll belongs to, when it is one part of one (set by code from the brief). */
export const SeriesRef = z.strictObject({
  seriesId: OpaqueId,
  part: z.number().int().min(1).max(99),
});

/**
 * The consumer Scroll document, immutable per revision. It carries no claim, source, model,
 * prompt, reviewer or per-reader data: internal provenance is a separate schema
 * (`@knowscroll/scroll-model/internal`).
 */
export const ScrollDocument = z.strictObject({
  schemaVersion: z.literal(SCROLL_DOCUMENT_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  language: LanguageTag,
  /** The explanation this Scroll gives; shared with its Reel variant so they are not double-counted. */
  explanationUnitId: OpaqueId,
  series: SeriesRef.optional(),
  template: z.enum(TEMPLATES),
  theme: z.strictObject({ family: z.enum(THEME_FAMILIES) }),
  kicker: plainText(1, FIELD_LIMITS.kickerChars),
  title: plainText(4, FIELD_LIMITS.titleChars),
  dek: plainText(10, FIELD_LIMITS.dekChars),
  framing: Framing,
  sections: z.array(Section).min(1).max(LIMITS.sections),
  corrections: z.array(Correction).max(FIELD_LIMITS.corrections),
  limitsVersion: z.literal(SCROLL_LIMITS_VERSION),
  measures: Measures,
  integrity: Integrity,
  rendition: Rendition.optional(),
});
export type ScrollDocument = z.infer<typeof ScrollDocument>;

export interface BlockVisit {
  readonly block: AnyBlock;
  readonly section: Section;
  readonly sectionIndex: number;
  /** The enclosing disclosure, or null for a top-level block. */
  readonly parent: Block | null;
  /** Schema path of the block, e.g. `sections.1.blocks.0.data.blocks.2`. */
  readonly path: string;
}

/** Every block in document order, disclosure children right after their disclosure. */
export function* walkBlocks(sections: readonly Section[]): Generator<BlockVisit> {
  for (const [sectionIndex, section] of sections.entries()) {
    for (const [blockIndex, block] of section.blocks.entries()) {
      const path = `sections.${sectionIndex}.blocks.${blockIndex}`;
      yield { block, section, sectionIndex, parent: null, path };
      if (block.type === 'disclosure') {
        for (const [childIndex, child] of block.data.blocks.entries()) {
          yield { block: child, section, sectionIndex, parent: block, path: `${path}.data.blocks.${childIndex}` };
        }
      }
    }
  }
}

/** Finds a block (top level or nested) by id. */
export function findBlock(document: Pick<ScrollDocument, 'sections'>, blockId: string): BlockVisit | null {
  for (const visit of walkBlocks(document.sections)) if (visit.block.id === blockId) return visit;
  return null;
}
