import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import { ASK_SUPPORT_MAX_BATCHES } from '../domain/ask-support.js';
import {
  GENERATED_SCROLL_V3_MARKER,
  isGeneratedRecipeKey,
  type GeneratedRecipeKey,
} from '../domain/library/generated.js';
import type { ScrollV3Plan } from '../domain/library/plan.js';

/** The current production recipe. A topic has one job per version; a new recipe is a new version. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v14';
/**
 * The production version of the v2 writer's jobs, paired with `WRITER_V2_PROMPT_VERSION` (`scroll-writer.v22`). The v2 writer is deleted
 * (#815) and no job is made at this version, but stage and main hold the jobs and the revisions it wrote: the publication lineage
 * (`lineagePairsOf`) names the pair for a stored v2 revision and `PRODUCTION_VERSIONS` lists it, so those job rows stay readable.
 */
export const SCROLL_PRODUCTION_V2_VERSION = 'scroll-production.v22';
/**
 * The production recipe of a recipe the plan marks `scrollV3`: the same job with the document v3 writer. Like the v2 version it
 * is a version of its own, so a recipe already served as a v2 Scroll is a new job here and its Scroll becomes a new revision of
 * the same asset. It must change whenever the v3 writer's instructions (`WRITER_V3_PROMPT_VERSION`) or the job's steps change,
 * which gives every recipe fresh takes; `versions.test.ts` pins the pair. v2 (D-438): the compile leaves out a link it cannot place
 * (`WRITER_V3_PROMPT_VERSION` `scroll-writer-v3.v2`), so a recipe whose Scroll is not yet a document v3 gets three new takes.
 * v3 (D-441): a copy finding names the part and quotes the words, and the instructions say a chart always has its marks
 * (`scroll-writer-v3.v3`): three new takes again for a recipe whose Scroll is not yet a document v3. v4 (D-444): a figure finding says where
 * the figure is, a copy note lists more runs, and a picture's short texts are the writer's own words (`scroll-writer-v3.v4`): three new takes again.
 * v5 (D-445): the writer's roles get a second repair when copies are the only findings left, and a repair is told to change only the
 * parts its notes name (`scroll-writer-v3.v5`): three new takes again.
 */
export const SCROLL_PRODUCTION_V3_VERSION = 'scroll-production-v3.v5';
/**
 * The document v3 production version before D-438. No new job is made at it; its revisions stay stored, released and served, and the
 * publication lineage keeps accepting the pair it wrote (`lineagePairsOf`, `publication-topic.ts`).
 */
export const SCROLL_PRODUCTION_V3_FIRST_VERSION = 'scroll-production-v3.v1';
/** The document v3 production version of D-438, before D-441: kept like {@link SCROLL_PRODUCTION_V3_FIRST_VERSION}. */
export const SCROLL_PRODUCTION_V3_SECOND_VERSION = 'scroll-production-v3.v2';
/** The document v3 production version of D-441, before D-444: kept like {@link SCROLL_PRODUCTION_V3_FIRST_VERSION}. */
export const SCROLL_PRODUCTION_V3_THIRD_VERSION = 'scroll-production-v3.v3';
/** The document v3 production version of D-444, before D-445: kept like {@link SCROLL_PRODUCTION_V3_FIRST_VERSION}. */
export const SCROLL_PRODUCTION_V3_FOURTH_VERSION = 'scroll-production-v3.v4';
/** One writer call and at most one repair, per take. */
export const REQUEST_BOUND_PER_TOPIC = 2;
/**
 * The bound a library take is claimed for: six paid requests. It was a v2 take's (the writer once and at most one repair, and the
 * answer check once for each of the two drafts, each with at most one repair of an unusable reply, D-198). The v2 writer and that check
 * are deleted (#815); a document v3 take is held to the same bound (`REQUEST_BOUND_V3_PER_TOPIC`), which the queue's claim and
 * the library operator still use.
 */
export const REQUEST_BOUND_V2_PER_TOPIC = 6;
/**
 * The most paid requests the document v3 writer sends for one take: the writer once, the harness's first repair and the second repair
 * its roles opt into when copies are all that is left (D-445). The writer's roles name `secondRepairOnlyFor`, and `writer-stage.ts`
 * refuses a take whose run was charged more.
 */
export const REQUEST_BOUND_V3_WRITER = 3;
/**
 * The most paid requests a document v3 library recipe's take may send. The v3 writer is one reply (arm (a)): the writer once and the
 * harness's repairs, so three at most ({@link REQUEST_BOUND_V3_WRITER}: one more than before D-445), and the answer check of a v3 has no
 * calls and sends none. The bound is kept at a v2 take's, an upper bound that the queue's claim (`PRODUCE_SCROLL_CLAIM_SECONDS`, which
 * is sized by it) already covers, so a writer that grows a step (the two-step arm (b), say) or a repair needs no new claim;
 * `versions.test.ts` holds both the bound and the claim for the writer's three requests.
 */
export const REQUEST_BOUND_V3_PER_TOPIC = 6;
/**
 * The answer to a person's question sends at most fourteen paid requests a take: the writer's first draft and the validator's
 * repair of it (2), the revision a support check earns (1) and its repair, for a length out of range, an opening paragraph taken out whole or a copied run the trim could not place (1), and the support check for
 * each of the two drafts. A draft is checked in at most `ASK_SUPPORT_MAX_BATCHES` batches of sentences, one request each, and
 * the harness repairs one unusable reply in the whole check, so a draft costs its batches plus one (D-250, D-267, D-297, D-353).
 */
export const REQUEST_BOUND_ASK_ORDER = 2 + 1 + 1 + 2 * (ASK_SUPPORT_MAX_BATCHES + 1);
export { MAX_TAKES_PER_RECIPE, MAX_TAKE_NUMBER } from '../domain/library/serving.js';
/**
 * The explanation recipes the generator runs, by operator key. The plan itself (systems, planets,
 * facets, briefs and research pages) is code-owned data in `domain/library/`, one file per system.
 */
export const TOPICS = RECIPES;
export type ScrollTopic = RecipeKey;
/** Explicit explanation identity; only the original three share their approved Reel identity. */
export function explanationUnitFor(topic: ScrollTopic): string {
  return TOPICS[topic].explanationUnitId;
}
/** Parse a bounded, code-defined topic identifier. */
export function parseScrollTopic(raw: string | undefined): ScrollTopic | undefined {
  return raw !== undefined && Object.hasOwn(TOPICS, raw) ? (raw as ScrollTopic) : undefined;
}

/**
 * The key of a recipe a job may run: a code recipe, or a stored one by its `gen-` shape (D-412). The shape says only that
 * the key may be a stored recipe: whether the row exists is `subjectOf`'s question, asked of the database.
 */
export function parseProductionRecipe(raw: string | undefined): ScrollTopic | GeneratedRecipeKey | undefined {
  if (raw === undefined) return undefined;
  return parseScrollTopic(raw) ?? (isGeneratedRecipeKey(raw) ? raw : undefined);
}

/**
 * What the plan decides for a document v3 recipe, or `undefined` for a recipe that is not one. A stored (`gen-`) recipe is a document v3
 * recipe, always (#781, owner decision 4 on #771: dev holds no stored recipe, and stage and main do not run this code, so nothing older
 * is left). Everything that holds only a key (`productionVersionOf`, `requestBoundOf`, the job queue, the standing) decides from this
 * function, so it stays key-only and returns {@link GENERATED_SCROLL_V3_MARKER} for a stored key: a plan that says "document v3, no
 * misconception" and nothing else. The recipe's real shape and sections are in its row and reach the writer through `bookRecipeOf`, the
 * subject's `scrollV3`; a row whose plan is not a v3 one is refused as a plan problem ({@link storedPlanRefusalOf}).
 */
export function scrollV3PlanOf(key: string): ScrollV3Plan | undefined {
  if (isGeneratedRecipeKey(key)) return GENERATED_SCROLL_V3_MARKER;
  const topic = parseScrollTopic(key);
  return topic === undefined ? undefined : TOPICS[topic].scrollV3;
}

/**
 * Why a stored recipe cannot be produced as the document v3 its key says it is, or `undefined`. The production version, the request bound
 * and the takes of a `gen-` key are the document v3 ones, so a row that holds anything else (a v2 plan, which the database no longer
 * writes but an older row could hold) must not be written by the v3 version silently: it is refused before any job is reserved and
 * any request is sent. A code recipe and an order are never refused here.
 */
export function storedPlanRefusalOf(
  key: string,
  subject: { readonly scrollV3?: unknown },
): 'stored_recipe_plan_not_v3' | undefined {
  return isGeneratedRecipeKey(key) && subject.scrollV3 === undefined ? 'stored_recipe_plan_not_v3' : undefined;
}

/**
 * Why a code recipe cannot be produced because its plan holds no document v3 plan, or `undefined`. The document v3 writer is the only writer
 * (the v1 writer is deleted, #818), so a recipe without a v3 plan has no writer: it is refused before any job is reserved and any request is
 * sent, instead of failing inside the job. Every recipe the plan holds is a document v3 recipe, so this never refuses one today.
 */
export function codeRecipeWriterRefusalOf(
  key: string,
  subject: { readonly scrollV3?: unknown },
): 'recipe_plan_not_v3' | undefined {
  return parseScrollTopic(key) !== undefined && subject.scrollV3 === undefined ? 'recipe_plan_not_v3' : undefined;
}

/**
 * Why the plan does not let a recipe be produced at all, or `undefined`. A recipe whose
 * misconception source label no person has reviewed is a plan problem: the library admits only
 * reviewed labels, so no request is spent on it until the plan says `reviewed` (D-129).
 */
export function planRefusalOf(key: string): 'misconception_source_unreviewed' | undefined {
  const misconception = scrollV3PlanOf(key)?.misconception;
  return misconception?.kind === 'myth' && !misconception.source.reviewed
    ? 'misconception_source_unreviewed'
    : undefined;
}

/**
 * The production recipe version of a job key: the document v3 version for a recipe the plan marks `scrollV3`, v14 for every other
 * recipe and for a Scroll ordered from code. Every place that names a job by recipe and version asks here, so a v1 recipe's jobs are
 * untouched.
 */
export function productionVersionOf(key: string): string {
  return scrollV3PlanOf(key) !== undefined ? SCROLL_PRODUCTION_V3_VERSION : SCROLL_PRODUCTION_VERSION;
}

/**
 * The most paid model requests one take of this recipe, or order, may send. An order's key does not say what it
 * answers, so a caller that has read the order passes its mode: the answer to a question is checked (D-250).
 */
export function requestBoundOf(key: string, mode?: string): number {
  if (scrollV3PlanOf(key) !== undefined) return REQUEST_BOUND_V3_PER_TOPIC;
  return mode === 'question' ? REQUEST_BOUND_ASK_ORDER : REQUEST_BOUND_PER_TOPIC;
}

/** Every production version a job row may carry. */
export const PRODUCTION_VERSIONS: readonly string[] = [
  SCROLL_PRODUCTION_VERSION,
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_V3_VERSION,
];
