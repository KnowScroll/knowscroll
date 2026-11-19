import { z } from '../zod.js';
import { Framing, Integrity, SeriesRef, THEME_FAMILIES } from '../document.js';
import { LanguageTag, LocalId, OpaqueId, plainText, Revision } from '../primitives.js';
import { ASIDE_KINDS, Misconception, STOP_EMPHASES } from '../v2/document.js';
import { FIELD_LIMITS_V3 as F, LIMITS_V3 as L, SCROLL_LIMITS_V3_VERSION } from './limits.js';
import { Picture, PictureState } from './pictures.js';

/**
 * `scroll-document.v3` ("document v3"; the repo also says v3 for the revamp, reading facts and a Composer policy): a
 * Scroll as an essay in two or three sections of beats, with pictures declared once and shown by beats (#759, Folio
 * README section 3). It is the format Folio was designed for. What changes from v2:
 *
 * - The unit is the **beat**, one paragraph, as the stop was in v2: reading, place, Ask, Share and Report name it.
 * - **Pictures** come from one closed set of kinds that one renderer draws (`pictures.ts`, #756). No kit is part of v3.
 *   Every Scroll has at least one picture (decision D1).
 * - A beat may carry **linked phrases**, one **control** (scrub, switch or pick) and be a **quotation**.
 * - The end is **`takeaway`**: one to three plain sentences in a person's voice (decision F1). It is not named
 *   `summary`, because discovery's trigger would then put it in place of the dek in every offer and search row
 *   (`migrations/0016_content_discovery.sql:40`). The promise stays stored as `dek` for the same reason.
 * - There are **no calls**, no landmark, no stage, no guide and no play blocks (Folio README 3.9, decision I1).
 *
 * v1 and v2 documents are untouched and keep their own schemas. A client is sent a document v3 only when it declares
 * `scroll-document.v3` (D-129). Every object is strict, so a reader that meets a field it does not know refuses the
 * document instead of drawing half of it.
 */
export const SCROLL_DOCUMENT_V3_SCHEMA_VERSION = 'scroll-document.v3';
export const SCROLL_MEASURES_V3_VERSION = 'scroll-measures.v3';

/** The kind of essay, from the recipe: it decides nothing in the format today, and tells the writer what it is making. */
export const SCROLL_SHAPES = ['argument', 'mechanism', 'story'] as const;

/** The figure after a beat: one of the document's pictures, in one state. */
export const Show = z.strictObject({ picture: LocalId, state: PictureState });
export type Show = z.infer<typeof Show>;

/**
 * A phrase of the beat's text that names a part of the picture on screen. The phrase occurs exactly once in the text;
 * the reader underlines it in the part's colour and pulses the part when it is tapped. The colour is the picture's,
 * never the writer's.
 */
export const Link = z.strictObject({ phrase: plainText(1, F.phraseChars), part: LocalId });
export type Link = z.infer<typeof Link>;

/**
 * A control under the beat's own figure. Each has buttons and keys beside any drag, and a sentence for its state that
 * code derives from the picture. Nothing a reader does with one is reported or stored (D-063, D-209).
 * - `scrub`: steps through the picture's `steps` (a plan's days) or its `items` one at a time.
 * - `switch`: flips between the beat's state and `to`.
 * - `pick`: chooses one item that has a note, and reads the note.
 * `set` (a number the picture's own physics understands) is planned for the writer step.
 */
export const Control = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('scrub'),
    label: plainText(1, F.controlLabelChars),
    along: z.enum(['steps', 'items']),
  }),
  z.strictObject({ kind: z.literal('switch'), label: plainText(1, F.controlLabelChars), to: PictureState }),
  z.strictObject({ kind: z.literal('pick'), label: plainText(1, F.controlLabelChars) }),
]);
export type Control = z.infer<typeof Control>;

const beatShape = {
  id: LocalId,
  /** One paragraph. */
  text: plainText(1, F.beatChars),
  /** The same idea in plainer words, shown on request (the ••• row Simpler and Shift+S, #753). */
  simple: plainText(1, F.simpleChars),
  show: Show.optional(),
  links: z.array(Link).max(L.linksPerBeat),
};

/** A paragraph of the essay. */
export const PlainBeat = z.strictObject({
  kind: z.literal('plain'),
  ...beatShape,
  emphasis: z.enum(STOP_EMPHASES).optional(),
  control: Control.optional(),
});
export type PlainBeat = z.infer<typeof PlainBeat>;

/** Who said a quotation, where and when. Shown with it, and cited like any other text. */
export const QuoteCite = z.strictObject({
  who: plainText(1, F.citeChars),
  work: plainText(1, F.citeChars).optional(),
  year: plainText(1, 12).optional(),
});
export type QuoteCite = z.infer<typeof QuoteCite>;

/** A quotation set apart. Its text matches a cited passage word for word; it carries no control. */
export const QuoteBeat = z.strictObject({ kind: z.literal('quote'), ...beatShape, cite: QuoteCite });
export type QuoteBeat = z.infer<typeof QuoteBeat>;

export const Beat = z.discriminatedUnion('kind', [PlainBeat, QuoteBeat]);
export type Beat = z.infer<typeof Beat>;

/** A division inside one Scroll, under a small heading. Not a Part (a Scroll of its own) and not a region. */
export const SectionV3 = z.strictObject({
  id: LocalId,
  title: plainText(1, F.sectionTitleChars),
  beats: z.array(Beat).min(L.beatsPerSection.min).max(L.beatsPerSection.max),
});
export type SectionV3 = z.infer<typeof SectionV3>;

/** A side note beside the beat it belongs to. The `limits` aside is the end plate's Small print. */
export const AsideV3 = z.strictObject({
  id: LocalId,
  kind: z.enum(ASIDE_KINDS),
  title: plainText(1, F.asideTitleChars),
  text: plainText(1, F.asideChars),
  anchorBeat: LocalId,
  collapsed: z.boolean(),
});
export type AsideV3 = z.infer<typeof AsideV3>;

/**
 * Reading measures (`scroll-measures.v3`), computed by code: the reading time, the words of the essay itself, a weight
 * per beat in word-equivalents (its words and the asides beside it) and their total.
 */
export const MeasuresV3 = z.strictObject({
  version: z.literal(SCROLL_MEASURES_V3_VERSION),
  readingSeconds: z.number().int().min(1).max(3_600),
  /** `readingSeconds` in minutes, to one decimal place. */
  readingMinutes: z.number().min(0.1).max(60),
  /** The words of the beats' text: the measure decision J bounds. */
  mainWords: z.number().int().min(0),
  totalWeight: z.number().int().min(0),
  beats: z.array(z.strictObject({ beatId: LocalId, weight: z.number().int().min(0) })).max(L.beats.max),
});
export type MeasuresV3 = z.infer<typeof MeasuresV3>;

/**
 * The consumer Scroll document v3, immutable per revision. Like v1 and v2 it carries no claim, source, model, prompt or
 * per-reader data; what it rests on is its internal provenance (`scroll-provenance.v3`), never served.
 */
export const ScrollDocumentV3 = z.strictObject({
  schemaVersion: z.literal(SCROLL_DOCUMENT_V3_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  language: LanguageTag,
  explanationUnitId: OpaqueId,
  series: SeriesRef.optional(),
  theme: z.strictObject({ family: z.enum(THEME_FAMILIES) }),
  kicker: plainText(1, 40),
  title: plainText(4, 90),
  /** The promise: one line under the title, on the cover and in lists. Stored as `dek` (see above). */
  dek: plainText(10, 200),
  shape: z.enum(SCROLL_SHAPES),
  framing: Framing,
  misconception: Misconception,
  pictures: z.array(Picture).min(L.pictures.min).max(L.pictures.max),
  sections: z.array(SectionV3).min(L.sections.min).max(L.sections.max),
  asides: z.array(AsideV3).min(L.asides.min).max(L.asides.max),
  /** "To sum up": one to three plain sentences a person would say at the end. */
  takeaway: plainText(F.takeawayChars.min, F.takeawayChars.max),
  /** Questions this Scroll invites, for the Ask sheet: up to three. */
  askSuggestions: z.array(plainText(8, F.suggestionChars)).min(1).max(L.askSuggestions),
  limitsVersion: z.literal(SCROLL_LIMITS_V3_VERSION),
  measures: MeasuresV3,
  integrity: Integrity,
});
export type ScrollDocumentV3 = z.infer<typeof ScrollDocumentV3>;

/** Every beat in reading order, with its section. */
export function beatsOfV3(document: Pick<ScrollDocumentV3, 'sections'>): readonly Beat[] {
  return document.sections.flatMap((section) => section.beats);
}

/** A picture in one state, outside its document: what a cover shows before the Scroll is opened. */
export const PictureFrame = z.strictObject({ picture: Picture, state: PictureState });
export type PictureFrame = z.infer<typeof PictureFrame>;

/**
 * The picture a document v3 Scroll's cover shows: its first declared picture, in the first state a beat shows it in.
 * Validation requires every declared picture to be shown, so a valid document always has one.
 */
export function coverFrameOfV3(document: Pick<ScrollDocumentV3, 'pictures' | 'sections'>): PictureFrame | undefined {
  const picture = document.pictures[0];
  if (picture === undefined) return undefined;
  const shown = beatsOfV3(document).find((beat) => beat.show?.picture === picture.id)?.show;
  return shown === undefined ? undefined : { picture, state: shown.state };
}
