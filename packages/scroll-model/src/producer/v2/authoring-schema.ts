import { z } from '../../zod.js';
import { CHART_SHAPES, GUIDE_POSES, MAGNITUDES, SCALE_AXES } from '../../v2/blocks.js';
import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { LIMITS_V2 } from '../../v2/limits.js';

/**
 * `scroll-authoring.v2`: what the writer model returns for a `scroll-document.v2`. One flat list of
 * items in reading order, plain strings for text, closed enums for the stage, no ids and no
 * indexes to count. Deterministic code (`assembleScrollV2`) turns it into the canonical document.
 *
 * Flat on purpose (D-032, D-120): a model that writes long, deeply nested JSON loses count of its
 * brackets. So an aside has no anchor id and belongs to the item just before it; the correct option
 * of a call is always the first one (code shuffles them); the stage is a small object of enum words
 * that names only what changes. Nothing here is trusted beyond its structure and bounds.
 */
export const SCROLL_AUTHORING_V2_VERSION = 'scroll-authoring.v2';

const prose = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Evidence handles (`e1`, `e2`, ...) the item rests on. */
const cites = z.array(prose(1, 12)).min(1).max(8);

/**
 * Only what changes at this item; every other value carries over from the item before. The writer
 * chooses words of the recipe's kit (D-194): for Earth & sky the view, the month, the Moon's phase and
 * the focus. The schema holds the shape (a few short words by key); which keys and words are allowed
 * depends on the recipe's kit, which only the authoring rules know (`stage_choice_invalid`). Only a read
 * stop may carry one: a call never changes the picture, and the document's own admission refuses a
 * state on a call.
 */
const stagePatch = z.record(prose(1, 24), prose(1, 24)).optional();

/** What every read stop has, a stop that carries a play block included. */
const readFields = {
  cites,
  /** A rare section label; most stops have none. Up to twice its limit is cut at a word boundary. */
  heading: prose(1, 120).optional(),
  text: prose(1, 600),
  /** A short line that stands alone after the text. */
  line: prose(1, 200).optional(),
  emphasis: z.enum(STOP_EMPHASES).optional(),
  stage: stagePatch,
  /** The same idea in simpler words. */
  simple: prose(1, 600),
};

/**
 * A line from the Scroll's guide character. The recipe names the character, so the writer gives only the
 * pose and the words (D-207). Allowed only where the recipe gives the Scroll a guide.
 */
const guideFields = z.strictObject({ pose: z.enum(GUIDE_POSES), line: prose(1, 300) });

const stopItem = z.strictObject({ type: z.literal('stop'), ...readFields, guide: guideFields.optional() });

/**
 * A figure of a scale or a chart, written as the cited passage writes it. A bare number is accepted too:
 * the authoring rules read both the same way, and a figure the passages do not state is refused.
 */
const point = z.strictObject({
  label: prose(1, 80),
  value: z.union([prose(1, 24), z.number()]),
  /** The word the passage puts after the figure ("8.3 million"): the value is the figure times it. */
  magnitude: z.enum(Object.keys(MAGNITUDES) as [keyof typeof MAGNITUDES, ...(keyof typeof MAGNITUDES)[]]).optional(),
});

/**
 * The play blocks (D-207). Each is a read stop (`readFields`: the lead-in the reader sees first) with one
 * block under its text, filled from words and cited figures only. Allowed only where the recipe names the
 * block, and each named block is used once.
 */
const sortItem = z.strictObject({
  type: z.literal('sort'),
  ...readFields,
  /** The items in the CORRECT order: code shuffles what the reader sees and keeps the order as the answer. */
  items: z.array(prose(1, 120)).min(LIMITS_V2.sortItems.min).max(LIMITS_V2.sortItems.max),
  explain: prose(1, 600),
});
const forkItem = z.strictObject({
  type: z.literal('fork'),
  ...readFields,
  prompt: prose(1, 200),
  branches: z
    .array(z.strictObject({ label: prose(1, 80), text: prose(1, 600) }))
    .min(2)
    .max(2),
});
const scaleItem = z.strictObject({
  type: z.literal('scale'),
  ...readFields,
  axis: z.enum(SCALE_AXES),
  unit: prose(1, 60),
  points: z.array(point).min(LIMITS_V2.scalePoints.min).max(LIMITS_V2.scalePoints.max),
  /** The label of the point that is "you are here". */
  here: prose(1, 80).optional(),
});
const chartItem = z.strictObject({
  type: z.literal('chart'),
  ...readFields,
  shape: z.enum(CHART_SHAPES),
  unit: prose(1, 60),
  points: z.array(point).min(LIMITS_V2.chartPoints.min).max(LIMITS_V2.chartPoints.max),
});

const callFields = {
  cites,
  prompt: prose(1, 200),
  /** The correct option first (and, in the myth's call, the common guess second); code shuffles the order. */
  options: z.array(prose(1, 120)).min(LIMITS_V2.optionsPerCall.min).max(LIMITS_V2.optionsPerCall.max),
  explain: prose(1, 600),
  twist: prose(1, 600),
  stage: stagePatch,
  simple: prose(1, 600),
};

/**
 * The writer gives the common guess no number: the SECOND option of the first call_it of a myth
 * Scroll is the wrong option that states the misconception, and code marks it (D-126).
 */
const callItem = z.strictObject({ type: z.literal('call_it'), ...callFields });

const finalCallItem = z.strictObject({ type: z.literal('final_call'), ...callFields });

/** Belongs to the stop or call just before it in the list. */
const asideItem = z.strictObject({
  type: z.literal('aside'),
  cites,
  kind: z.enum(ASIDE_KINDS),
  title: prose(1, 60),
  text: prose(1, 600),
  collapsed: z.boolean().optional(),
});

export const AuthoredItemV2 = z.discriminatedUnion('type', [
  stopItem,
  sortItem,
  forkItem,
  scaleItem,
  chartItem,
  callItem,
  finalCallItem,
  asideItem,
]);
export type AuthoredItemV2 = z.infer<typeof AuthoredItemV2>;

export const AuthoredScrollV2 = z.strictObject({
  /** Up to twice its limit is cut at a word boundary. */
  title: prose(4, 180),
  dek: prose(10, 400),
  items: z
    .array(AuthoredItemV2)
    .min(LIMITS_V2.minStops)
    .max(LIMITS_V2.maxStops + LIMITS_V2.asides),
  recap: z.strictObject({
    cites,
    captions: z.array(prose(1, 100)).min(LIMITS_V2.recapCaptions.min).max(LIMITS_V2.recapCaptions.max),
  }),
  askSuggestions: z.array(prose(8, 140)).min(1).max(LIMITS_V2.askSuggestions),
});
export type AuthoredScrollV2 = z.infer<typeof AuthoredScrollV2>;
