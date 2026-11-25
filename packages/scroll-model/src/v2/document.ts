import { z } from '../zod.js';
import { Framing, Integrity, SeriesRef, THEME_FAMILIES } from '../document.js';
import { LanguageTag, LocalId, OpaqueId, plainText, Revision } from '../primitives.js';
import { Guide, Interactive } from './blocks.js';
import { FIELD_LIMITS_V2 as F, LIMITS_V2 as L, SCROLL_LIMITS_V2_VERSION } from './limits.js';

/**
 * `scroll-document.v2`: a Scroll as a spine of stops under one pinned stage (D-120). This file holds
 * the blocks and the document the writer fills in the first slice: stop (with line, paragraph and
 * heading), aside, stage, call it, Final call, recap and the ask suggestions, and, on a read stop, the
 * guide's line and one play block: a sort, a fork, a scale or a growing chart (D-207). The other blocks
 * of the design (scene, quote, list, table, code, media, diagram, simulation, figure) are planned
 * or deferred and listed in the package README.
 *
 * v1 documents are untouched and keep their own schema. A v2 document is stored beside them under
 * its own `schemaVersion`; no reader of v1 can mistake one for the other.
 */
export const SCROLL_DOCUMENT_V2_SCHEMA_VERSION = 'scroll-document.v2';
export const SCROLL_MEASURES_V2_VERSION = 'scroll-measures.v2';

/** Where a common guess or a misconception comes from. Set by code from the recipe, never by the model. */
export const SourceLabel = z.strictObject({
  /** A human-reviewed label, for example the title of a documentary or a study. */
  label: plainText(3, F.sourceLabelChars),
  /** False until a person has checked the label against its source. Admission to the library requires true. */
  reviewed: z.boolean(),
});
export type SourceLabel = z.infer<typeof SourceLabel>;

/**
 * The common wrong idea this Scroll is built to meet, decided with the recipe. `none` is allowed for
 * narrative and editorial Scrolls. The first Call it tests a myth, and its Plot twist is about it.
 */
export const Misconception = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('myth'), claim: plainText(8, F.claimChars), source: SourceLabel }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type Misconception = z.infer<typeof Misconception>;

export const StopHeading = z.strictObject({
  type: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2)]),
  text: plainText(1, F.headingChars),
});
/** Prose inside a stop when one line is not enough. */
export const StopParagraph = z.strictObject({ type: z.literal('paragraph'), text: plainText(1, F.paragraphChars) });
/** A short, punchy line that stands alone for rhythm; often the reveal line after a call. */
export const StopLine = z.strictObject({ type: z.literal('line'), text: plainText(1, F.lineChars) });
export const StopBlock = z.discriminatedUnion('type', [StopHeading, StopParagraph, StopLine]);
export type StopBlock = z.infer<typeof StopBlock>;

export const STOP_EMPHASES = ['hook', 'turn', 'payoff'] as const;

/** The unit of a Scroll: one screen-sized idea that may also change the stage. */
export const ReadStop = z.strictObject({
  kind: z.literal('read'),
  id: LocalId,
  blocks: z.array(StopBlock).min(1).max(3),
  emphasis: z.enum(STOP_EMPHASES).optional(),
  /** The same idea in simpler words: shown on request, never required. */
  simple: plainText(1, F.simpleChars),
  /** One play block under the text: a sort, a fork, a scale or a growing chart. At most two a Scroll (D-207). */
  interactive: Interactive.optional(),
  /** A line from the Scroll's guide character, in its own bubble. At most two a Scroll. */
  guide: Guide.optional(),
});
export type ReadStop = z.infer<typeof ReadStop>;

/** What a call stop carries. Correctness is recomputed from the immutable revision on the server (`modules/play`, D-181). */
const callShape = {
  id: LocalId,
  prompt: plainText(1, F.promptChars),
  options: z.array(plainText(1, F.optionChars)).min(L.optionsPerCall.min).max(L.optionsPerCall.max),
  /** Index of the correct option. */
  answer: z
    .number()
    .int()
    .min(0)
    .max(L.optionsPerCall.max - 1),
  /** Shown after locking in, to everyone: why the answer is what it is. */
  explain: plainText(1, F.explainChars),
  /** Shown after a wrong pick, in addition: warm, no blame ("Plot twist!"). */
  twist: plainText(1, F.twistChars),
  simple: plainText(1, F.simpleChars),
};

/** Predict, lock in, then see the reveal. */
export const CallItStop = z.strictObject({
  kind: z.literal('call_it'),
  ...callShape,
  /** The option that is the common wrong guess, with the reviewed source that says so. Set by code from the recipe. */
  commonGuess: z
    .strictObject({
      option: z
        .number()
        .int()
        .min(0)
        .max(L.optionsPerCall.max - 1),
      source: SourceLabel,
    })
    .optional(),
  /**
   * The picture the stage turns to when the reader locks a wrong answer (D-383, V3 F3): the id of the read stop whose
   * state in `stage.states` it is. It names the state of the first read stop after this call, which is the true picture
   * the stop after the call was going to show anyway, so a right answer keeps the flow and shows it at that stop. Set by
   * code from what the writer asked for; the pick stays on the device and nothing about the turn is reported or stored.
   */
  revealStage: LocalId.optional(),
});
export type CallItStop = z.infer<typeof CallItStop>;

/**
 * A control the Final call handed the reader on the pinned stage (D-187). `tilt` was Earth's axis on the Earth & sky
 * picture. That kit is gone (#835) and nothing acts on the binding any more (D-432: v3 has `scrub`, `switch` and `pick`),
 * but stored revisions hold it and must still parse, so the field stays. The reader's tilt was never reported or stored.
 */
export const FinalCallBinding = z.strictObject({ kind: z.literal('tilt') });
export type FinalCallBinding = z.infer<typeof FinalCallBinding>;

/** The boss question at the end: the last stop of the spine. */
export const FinalCallStop = z.strictObject({
  kind: z.literal('final_call'),
  ...callShape,
  binding: FinalCallBinding.optional(),
});
export type FinalCallStop = z.infer<typeof FinalCallStop>;

export const Stop = z.discriminatedUnion('kind', [ReadStop, CallItStop, FinalCallStop]);
export type Stop = z.infer<typeof Stop>;

export const ASIDE_KINDS = ['tangent', 'limits', 'definition'] as const;

/** A side box tucked next to the stop it belongs to. Never required to read on. */
export const Aside = z.strictObject({
  id: LocalId,
  kind: z.enum(ASIDE_KINDS),
  title: plainText(1, F.asideTitleChars),
  text: plainText(1, F.asideChars),
  /** The stop this aside opens next to. */
  anchorStop: LocalId,
  collapsed: z.boolean(),
});
export type Aside = z.infer<typeof Aside>;

/**
 * A kit id of the form every kit had ("tides.v1"). No drawing kit exists any more (the last, `earth-sky.v1`, went with
 * #835; D-442), so a stored stage's `kit` is not looked up anywhere: the form only keeps it from being any string, and keeps
 * a cover's figure apart from a picture frame, which has no `kit`.
 */
const KIT_ID_FORM = /^[a-z][a-z0-9-]{1,39}\.v[0-9]{1,3}$/;

/** A state of a stored stage: a plain object, whatever its kit once put in it. */
const StoredState = z.record(z.string(), z.unknown());

/**
 * The pinned figure of a stored Scroll, as the revision was stored. It names the kit that once drew it, and `states`
 * lists the stops that changed it, in order. No kit is defined any more, so nothing checks the words of a state or the
 * description written for it: they were checked when the revision was admitted, and stored revisions are immutable and
 * still served to older apps (D-433, D-442). The structure still is checked (the stops it sits on, their order, the first
 * stop, enough states, no repeats, `stageIssues`). A client draws no figure for it.
 */
export const Stage = z.strictObject({
  kit: z.string().regex(KIT_ID_FORM, { message: 'id_format' }),
  states: z
    .array(z.strictObject({ stop: LocalId, state: StoredState, alt: plainText(10, F.stateDescriptionChars) }))
    .min(1)
    .max(L.maxStops),
});
export type Stage = z.infer<typeof Stage>;

/**
 * A single frame of a stored stage, outside its document: what an older app's cover shows of a Scroll before it is
 * opened (`offer-cover.v1`). Its kit is not drawn by anything in the code any more, so the server never makes one, and
 * a client draws no figure for one.
 */
export const StageFrame = z.strictObject({
  kit: z.string().regex(KIT_ID_FORM, { message: 'id_format' }),
  state: StoredState,
  alt: plainText(10, F.stateDescriptionChars),
});
export type StageFrame = z.infer<typeof StageFrame>;

/**
 * The landmark a Scroll awards when its Final call is locked (D-188): a stable key and the name the
 * reader sees ("The Leaning Axis"). Recipe data set by code, never model text. A Scroll without one
 * awards nothing.
 */
export const Landmark = z.strictObject({
  key: LocalId,
  name: plainText(4, F.landmarkNameChars),
});
export type Landmark = z.infer<typeof Landmark>;

/** The payoff: the stage in its last state plus up to three captions. */
export const Recap = z.strictObject({
  captions: z.array(plainText(1, F.captionChars)).min(L.recapCaptions.min).max(L.recapCaptions.max),
  /** The limits aside the "Small print" chip links back to. */
  smallPrintAside: LocalId.optional(),
});
export type Recap = z.infer<typeof Recap>;

/**
 * Reading measures (`scroll-measures.v2`), computed by code: a weight per stop in word-equivalents
 * (a call also counts for the ten seconds it takes), the recap's weight and the reading time.
 */
export const MeasuresV2 = z.strictObject({
  version: z.literal(SCROLL_MEASURES_V2_VERSION),
  readingSeconds: z.number().int().min(1).max(3_600),
  /** `readingSeconds` in minutes, to one decimal place. */
  readingMinutes: z.number().min(0.1).max(60),
  totalWeight: z.number().int().min(0),
  recapWeight: z.number().int().min(0),
  stops: z.array(z.strictObject({ stopId: LocalId, weight: z.number().int().min(0) })).max(L.maxStops),
});
export type MeasuresV2 = z.infer<typeof MeasuresV2>;

/**
 * The consumer Scroll document v2, immutable per revision. Like v1 it carries no claim, source,
 * model, prompt or per-reader data apart from the misconception's reviewed source label, which the
 * reader is shown with the Plot twist.
 */
export const ScrollDocumentV2 = z.strictObject({
  schemaVersion: z.literal(SCROLL_DOCUMENT_V2_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  language: LanguageTag,
  explanationUnitId: OpaqueId,
  series: SeriesRef.optional(),
  theme: z.strictObject({ family: z.enum(THEME_FAMILIES) }),
  kicker: plainText(1, 40),
  title: plainText(4, 90),
  dek: plainText(10, 200),
  framing: Framing,
  misconception: Misconception,
  /** What the Final call awards, when the recipe names one. */
  landmark: Landmark.optional(),
  /** Present when the Scroll has a stage; a plain Scroll has none. */
  stage: Stage.optional(),
  stops: z.array(Stop).min(1).max(L.maxStops),
  asides: z.array(Aside).max(L.asides),
  recap: Recap,
  /** Questions this Scroll invites, for the Ask sheet: up to three. */
  askSuggestions: z.array(plainText(8, F.suggestionChars)).min(1).max(L.askSuggestions),
  limitsVersion: z.literal(SCROLL_LIMITS_V2_VERSION),
  measures: MeasuresV2,
  integrity: Integrity,
});
export type ScrollDocumentV2 = z.infer<typeof ScrollDocumentV2>;

/** The stops that are calls, the Final call included, in order. */
export function callsOf(document: Pick<ScrollDocumentV2, 'stops'>): readonly (CallItStop | FinalCallStop)[] {
  return document.stops.filter((stop): stop is CallItStop | FinalCallStop => stop.kind !== 'read');
}
