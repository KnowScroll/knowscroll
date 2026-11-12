import { z } from 'zod';
import { generatedUnitIdOf, type GeneratedRecipeKey } from './generated.js';

/**
 * The model's proposal of a recipe (#674, D-412): what to write a Scroll about on a planet that already exists. The model
 * proposes; {@link checkRecipeDraft} decides. Nothing here is a topic or a facet of its own: the facet is one the planet
 * already has, and every page is one code already holds.
 */

/** A recipe title, for lists and for the model's list of what exists. The Scroll's own title is written later. */
export const DRAFT_TITLE_MIN = 8;
export const DRAFT_TITLE_MAX = 90;
/** The brief: two to four sentences (library rule), at most 800 characters (the Planner's brief bound). */
export const DRAFT_BRIEF_MIN_CHARS = 80;
export const DRAFT_BRIEF_MAX_CHARS = 800;
export const DRAFT_BRIEF_MIN_SENTENCES = 2;
export const DRAFT_BRIEF_MAX_SENTENCES = 4;
export const DRAFT_MAX_PAGES = 3;
/** Drafts one call may return. */
export const DRAFTS_PER_CALL = 3;
/**
 * The passages the writer is offered from a recipe's pages together: it needs at least four and is offered at most 64
 * (`evidencePassages`). The source checker keeps a margin on both sides (`scripts/check-library-sources.mjs`), and so does
 * a draft: a page that loses or gains a paragraph stays usable.
 */
export const MIN_PASSAGE_POOL = 6;
export const MAX_PASSAGE_POOL = 63;

/** A control character or a line break: a title or a brief is one plain line of text. */
const CONTROL = /\p{Cc}|\p{Cf}/u;

const DraftSchema = z.strictObject({
  title: z.string().trim().min(DRAFT_TITLE_MIN).max(DRAFT_TITLE_MAX),
  facetId: z.string().min(1).max(160),
  brief: z.string().trim().min(DRAFT_BRIEF_MIN_CHARS).max(DRAFT_BRIEF_MAX_CHARS),
  pages: z.array(z.string().min(1).max(300)).min(1).max(DRAFT_MAX_PAGES),
});
export type RecipeDraft = z.infer<typeof DraftSchema>;

/** What the brief role returns: up to three drafts, or none when the planet has nothing new to explain from these pages. */
export const RecipeBriefOutputSchema = z.strictObject({ drafts: z.array(DraftSchema).max(DRAFTS_PER_CALL) });
export type RecipeBriefOutput = z.infer<typeof RecipeBriefOutputSchema>;

/** Why a draft was not accepted. Codes only: an operator reads them, and nothing here is model text. */
export const DRAFT_REFUSALS = [
  'title_shape',
  'brief_shape',
  'brief_names_block',
  'text_has_address',
  'text_has_markup',
  'facet_unknown',
  'facet_not_requested',
  'pages_duplicate',
  'page_not_candidate',
  'page_refused',
  'pool_out_of_range',
  'near_duplicate',
  'identity_taken',
] as const;
export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];

/** What the checks need to know, all of it read or derived by code. */
export interface DraftCheckContext {
  /** The planet the draft is for and the facets it may name. */
  readonly topicId: string;
  readonly facetIds: readonly string[];
  /** When the operator named one facet to cover, the draft must be for it. */
  readonly requestedFacetId?: string;
  /** The pages code holds for this planet, with how many evidence passages each gives the writer. */
  readonly candidates: readonly { readonly url: string; readonly passages: number }[];
  /** The existing research URL rule: true when the URL is one the product may fetch. */
  readonly urlAllowed: (url: string) => boolean;
  /**
   * The recipes the planet already has (code and stored) and the drafts accepted earlier in this batch, with the facet each teaches and
   * the pages it rests on: the same angle on the same pages is told from a different one by those, not by the words alone.
   */
  readonly existing: readonly {
    readonly title: string;
    readonly brief: string;
    readonly facetId: string;
    readonly pages: readonly string[];
  }[];
  /** Keys, explanation identities and asset ids already taken anywhere in the library. */
  readonly taken: {
    readonly keys: ReadonlySet<string>;
    readonly unitIds: ReadonlySet<string>;
    readonly assetIds: ReadonlySet<string>;
  };
  /** The derived identity this draft would get. */
  readonly identity: { readonly key: GeneratedRecipeKey; readonly assetId: string };
}

/** A draft that passed every check, as the store keeps it. */
export interface AcceptedRecipe {
  readonly key: GeneratedRecipeKey;
  readonly assetId: string;
  readonly explanationUnitId: string;
  readonly title: string;
  readonly topicId: string;
  readonly facetId: string;
  readonly brief: string;
  readonly pages: readonly string[];
  /** What the checks found, for the operator: the pool and the closest existing recipe. Numbers and codes only. */
  readonly checks: { readonly pool: number; readonly closest: number };
}

export type DraftVerdict =
  | { readonly kind: 'accepted'; readonly recipe: AcceptedRecipe }
  | { readonly kind: 'refused'; readonly code: DraftRefusal };

/**
 * The briefs' words that name a block of a Scroll. A brief names no block type (library rule): the writer is told the shape
 * separately and ignores a brief's talk of diagrams and the like.
 */
const BLOCK_WORDS = /\b(?:diagram|slider|simulation|stepper|chart|quiz|interactive|picture|stage)s?\b/iu;

/** Sentences of a brief, split where a sentence ends and a space follows (the library test's rule). */
export const sentencesOf = (text: string): readonly string[] => text.split(/(?<=[.?!])\s+/u).filter((s) => s !== '');

const STOP_WORDS = new Set(
  'the and for with that this from into onto over under about than then them they their there these those which what when where while who whom whose will would could should have has had are was were been being not but nor yet any all each few more most other some such only own same too very can just also how why does did its it is as at by in of on or to an a be if so we you your our'.split(
    ' ',
  ),
);

/** A word reduced to a stem loose enough that "valves", "valve" and "valved", or "pumping" and "pump", meet. */
function stemOf(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith('ies')) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && /(?:ss|x|z|ch|sh)es$/u.test(stem)) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
  if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  if (stem.length > 4 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem;
}

/** The stems of the words of a text that carry meaning: no short words, no stop words. */
export function tokensOf(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)).map(stemOf));
}

/**
 * How much two texts share, from 0 to 1: the stems they have in common over the stems of either (Jaccard). Pure.
 * Two empty texts share nothing.
 */
export function overlapOf(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/** A title this close to an existing one, or a brief this close to an existing one, is the same recipe said again. */
export const TITLE_OVERLAP_LIMIT = 0.8;
export const BRIEF_OVERLAP_LIMIT = 0.55;
/**
 * A reworded brief keeps its facet, its pages and some of its words, but changes enough of them to pass the limits above. So a draft is
 * also the same angle again when it teaches the same facet as a recipe, the two rest on the same pages (at least this share of the
 * smaller set) and their briefs share at least this much. Measured on the library: a brief reworded from `cardiac-cycle` shares 0.35 of
 * its words with it, and a different angle on the same facet and page shares under 0.1; the briefs of the plan's own recipes of one
 * planet never share more than 0.28.
 */
export const SAME_ANGLE_PAGE_SHARE = 0.5;
export const SAME_ANGLE_BRIEF_OVERLAP = 0.3;

/** How much of the smaller of two page sets the other holds, from 0 to 1. No pages share nothing. */
export function pageShareOf(a: readonly string[], b: readonly string[]): number {
  const smaller = Math.min(new Set(a).size, new Set(b).size);
  if (smaller === 0) return 0;
  const other = new Set(b);
  return new Set(a.filter((page) => other.has(page))).size / smaller;
}

/**
 * A web address in prose: a scheme (`://`), `www.`, or a dotted host such as `wikipedia.org` or `en.wikipedia.org/wiki/Heart`. The
 * writer is told to write none; a recipe's own text is what it reads, so none may get in. A decimal ("3.5") is not a host: the label
 * after a dot must be letters. A missing space after a full stop ("pump.Then") reads as a host and is refused too.
 */
const ADDRESS =
  /:\/\/|(?:^|[^a-z0-9])www\.|(?:^|[^a-z0-9])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9])/iu;
/** Markup in prose: angle brackets (tags, autolinks), backticks, a Markdown link or image, a reference link or its definition. */
const MARKUP = /[<>`]|\]\(|\]\[|^\s*\[[^\]]+\]:/mu;

/** Whether a text carries a web address (see above): the topic growth step holds a topic's own words to the same rule as a recipe's. */
export const textHasAddress = (text: string): boolean => ADDRESS.test(text);
/** Whether a text carries markup (see above). */
export const textHasMarkup = (text: string): boolean => MARKUP.test(text);

/**
 * Decides one draft. The draft is the model's; every other input is code's. The first check a draft fails names its refusal.
 * A model's page is accepted only if it is one of the candidates, code's URL rule allows it, and the writer would be offered
 * a pool of passages from the chosen pages that the source checker accepts. Pure: no clock, no storage, no network.
 */
export function checkRecipeDraft(draft: RecipeDraft, context: DraftCheckContext): DraftVerdict {
  const refuse = (code: DraftRefusal): DraftVerdict => ({ kind: 'refused', code });
  if (CONTROL.test(draft.title) || draft.title !== draft.title.trim()) return refuse('title_shape');
  const sentences = sentencesOf(draft.brief);
  if (
    CONTROL.test(draft.brief) ||
    sentences.length < DRAFT_BRIEF_MIN_SENTENCES ||
    sentences.length > DRAFT_BRIEF_MAX_SENTENCES
  )
    return refuse('brief_shape');
  // Both fields are prose the writer reads: neither may carry an address or markup.
  for (const text of [draft.title, draft.brief]) if (ADDRESS.test(text)) return refuse('text_has_address');
  for (const text of [draft.title, draft.brief]) if (MARKUP.test(text)) return refuse('text_has_markup');
  if (BLOCK_WORDS.test(draft.brief)) return refuse('brief_names_block');
  if (!context.facetIds.includes(draft.facetId)) return refuse('facet_unknown');
  if (context.requestedFacetId !== undefined && draft.facetId !== context.requestedFacetId)
    return refuse('facet_not_requested');
  if (new Set(draft.pages).size !== draft.pages.length) return refuse('pages_duplicate');
  let pool = 0;
  for (const url of draft.pages) {
    const candidate = context.candidates.find((entry) => entry.url === url);
    if (candidate === undefined) return refuse('page_not_candidate');
    if (!context.urlAllowed(url)) return refuse('page_refused');
    pool += candidate.passages;
  }
  if (pool < MIN_PASSAGE_POOL || pool > MAX_PASSAGE_POOL) return refuse('pool_out_of_range');
  let closest = 0;
  for (const other of context.existing) {
    const titles = overlapOf(draft.title, other.title);
    const briefs = overlapOf(draft.brief, other.brief);
    closest = Math.max(closest, titles, briefs);
    if (titles >= TITLE_OVERLAP_LIMIT || briefs >= BRIEF_OVERLAP_LIMIT) return refuse('near_duplicate');
    // The same facet on the same pages, said again in other words.
    if (
      other.facetId === draft.facetId &&
      pageShareOf(draft.pages, other.pages) >= SAME_ANGLE_PAGE_SHARE &&
      briefs >= SAME_ANGLE_BRIEF_OVERLAP
    )
      return refuse('near_duplicate');
  }
  const { key, assetId } = context.identity;
  const unitId = generatedUnitIdOf(key);
  if (context.taken.keys.has(key) || context.taken.unitIds.has(unitId) || context.taken.assetIds.has(assetId))
    return refuse('identity_taken');
  return {
    kind: 'accepted',
    recipe: {
      key,
      assetId,
      explanationUnitId: unitId,
      title: draft.title,
      topicId: context.topicId,
      facetId: draft.facetId,
      brief: draft.brief,
      pages: draft.pages,
      checks: { pool, closest: Math.round(closest * 100) / 100 },
    },
  };
}
