import { z } from '../../zod.js';
import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { STAGE_ENUMS } from '../../v2/kit.js';
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

/** Only what changes at this item; every other value carries over from the item before. */
const stagePatch = z
  .strictObject({
    view: z.enum(STAGE_ENUMS.view).optional(),
    earthAt: z.enum(STAGE_ENUMS.earthAt).optional(),
    axis: z.enum(STAGE_ENUMS.axis).optional(),
    ray: z.enum(STAGE_ENUMS.ray).optional(),
    orbit: z.enum(STAGE_ENUMS.orbit).optional(),
    northPin: z.enum(STAGE_ENUMS.northPin).optional(),
    southPin: z.enum(STAGE_ENUMS.southPin).optional(),
    moonAt: z.enum(STAGE_ENUMS.moonAt).optional(),
    focus: z.enum(STAGE_ENUMS.focus).optional(),
  })
  .optional();

const stopItem = z.strictObject({
  type: z.literal('stop'),
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
});

const callFields = {
  cites,
  prompt: prose(1, 200),
  /** The correct option first; code shuffles the order. */
  options: z.array(prose(1, 120)).min(LIMITS_V2.optionsPerCall.min).max(LIMITS_V2.optionsPerCall.max),
  explain: prose(1, 600),
  twist: prose(1, 600),
  stage: stagePatch,
  simple: prose(1, 600),
};

const callItem = z.strictObject({
  type: z.literal('call_it'),
  ...callFields,
  /** Which option (counting from 0, never 0 itself) is the common wrong guess. Only the first call of a myth Scroll has one. */
  commonGuess: z.number().int().min(1).max(LIMITS_V2.optionsPerCall.max - 1).optional(),
});

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

export const AuthoredItemV2 = z.discriminatedUnion('type', [stopItem, callItem, finalCallItem, asideItem]);
export type AuthoredItemV2 = z.infer<typeof AuthoredItemV2>;

export const AuthoredScrollV2 = z.strictObject({
  /** Up to twice its limit is cut at a word boundary. */
  title: prose(4, 180),
  dek: prose(10, 400),
  items: z.array(AuthoredItemV2).min(LIMITS_V2.minStops).max(LIMITS_V2.maxStops + LIMITS_V2.asides),
  recap: z.strictObject({ cites, captions: z.array(prose(1, 100)).min(LIMITS_V2.recapCaptions.min).max(LIMITS_V2.recapCaptions.max) }),
  askSuggestions: z.array(prose(8, 140)).min(1).max(LIMITS_V2.askSuggestions),
});
export type AuthoredScrollV2 = z.infer<typeof AuthoredScrollV2>;
