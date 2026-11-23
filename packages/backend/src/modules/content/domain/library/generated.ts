import { z } from 'zod';
import { SCROLL_SHAPE_IDS, type LibraryRecipe, type ScrollV3Plan } from './plan.js';

/**
 * Recipes that live in the database (`content.recipes`) rather than in the code-owned library plan (#674, D-412).
 *
 * A generated recipe is written as a `scroll-document.v3` Scroll, like a document v3 library recipe, and is held for an
 * operator's read before anyone is served it (D-138). Its key always starts with `gen-`. That one reserved prefix is how every place
 * that only holds a key (a job payload, a production run row) tells a generated recipe from a code recipe without a lookup:
 * it decides the production version and the request bound: **a `gen-` recipe is a document v3 recipe** (#781, owner decision 4 on
 * #771). A library test keeps every code key off the prefix.
 */
export const GENERATED_RECIPE_PREFIX = 'gen-';
export type GeneratedRecipeKey = `gen-${string}`;

/** The key shape SQL checks (migration 0045) with the reserved prefix, at most 64 characters. */
const GENERATED_KEY = /^gen-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const MAX_RECIPE_KEY_LENGTH = 64;

export const isGeneratedRecipeKey = (key: string): key is GeneratedRecipeKey =>
  key.length <= MAX_RECIPE_KEY_LENGTH && GENERATED_KEY.test(key);

/** A section intent is one short line: 1 to 120 characters in the database (migration 0124), 4 to 120 in a draft. */
export const SECTION_INTENT_MAX = 120;
/** A document v3 has two or three sections (the same bound as the database check). */
export const SECTIONS_MIN = 2;
export const SECTIONS_MAX = 3;

/**
 * The plan a stored recipe holds in `content.recipes.scroll_v3`: the shape of the essay and one intent per section. Nothing else
 * is stored: the writer picks the pictures from what its passages hold (a statement picture is always available), and a
 * proposal never has a misconception. Strict, and the same rule the database check enforces; a row that does not parse is a
 * defect the reader refuses (`bookRecipeOf`), never one it repairs.
 */
export const StoredScrollV3Schema = z.strictObject({
  shape: z.enum(SCROLL_SHAPE_IDS),
  sections: z.array(z.string().min(1).max(SECTION_INTENT_MAX)).min(SECTIONS_MIN).max(SECTIONS_MAX),
});
export type StoredScrollV3 = z.infer<typeof StoredScrollV3Schema>;

/**
 * What a generated recipe asks of the document v3 writer (#781, decision 4): the proposal's own `shape` and section intents, with no
 * misconception and no `pictures`. Without pictures the writer picks kinds from the closed set by what its passages hold, and the
 * statement picture is always available. A kind or a purpose is a person's decision, one recipe at a time, and a proposal is never
 * a person: the proposal says what the essay is and what each section is for, and nothing more.
 */
export function generatedScrollV3PlanOf(stored: StoredScrollV3): ScrollV3Plan {
  return { shape: stored.shape, sections: [...stored.sections], misconception: { kind: 'none' } };
}

/**
 * What the code that holds only a key (a job payload, a production run row) knows of a generated recipe's plan: that it is a document v3
 * plan, and that it has no misconception. That is all the production version, the request bound, the standing and the plan refusal
 * ask, so the key alone decides them (`scrollV3PlanOf`), as it did when SQL pinned every stored recipe to one v2 plan. The shape and the
 * sections here are a placeholder and nothing may read them: the real ones are in the row, and reach the writer through
 * `bookRecipeOf`, the subject's `scrollV3`.
 */
export const GENERATED_SCROLL_V3_MARKER: ScrollV3Plan = Object.freeze({
  shape: 'argument',
  sections: Object.freeze(['placeholder: read the stored row', 'placeholder: read the stored row']),
  misconception: Object.freeze({ kind: 'none' }),
});

/** Where a stored recipe came from: the code plan (an import, a later slice) or a model's proposal that code accepted. */
export const RECIPE_ORIGINS = ['code', 'proposal'] as const;
export type RecipeOrigin = (typeof RECIPE_ORIGINS)[number];

/**
 * Where a stored recipe stands. `checked`: accepted by the draft checks, nothing sent yet. `queued`: a production job exists.
 * `produced`: a Scroll was stored for it (held, served or rejected: the review gate and the job's own state say which).
 * `retired`: never chosen again.
 */
export const RECIPE_STATUSES = ['checked', 'queued', 'produced', 'retired'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

/**
 * One recipe as the `RecipeBook` hands it out: the library's facts plus its key, where it came from and, for a stored
 * recipe, where it stands. A code recipe has no status: it is always usable.
 */
export type BookRecipe = LibraryRecipe & {
  readonly key: string;
  readonly origin: RecipeOrigin;
  /** A short human name. A code recipe's is made from its key. */
  readonly title: string;
  readonly status?: RecipeStatus;
};

/** The words of a key as a title: `industrial-causes` is "Industrial causes". */
export function titleOfKey(key: string): string {
  const words = key.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SLUG_MAX = 40;

/** Lower-case letters and digits joined by single hyphens, cut at a hyphen so that no word is split. */
function slugOf(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX);
  const boundary = cut.lastIndexOf('-');
  return (boundary > 8 ? cut.slice(0, boundary) : cut).replaceAll(/-+$/gu, '');
}

/**
 * The key of a proposed recipe, derived by code from the facts that make it the same recipe: the planet, the facet and the
 * title. The same draft always gets the same key, so a repeated proposal meets the unique key instead of making a second
 * recipe. `sha256Hex` is injected because domain code does no hashing of its own.
 */
export function generatedKeyOf(
  draft: { readonly topicId: string; readonly facetId: string; readonly title: string },
  sha256Hex: (text: string) => string,
): GeneratedRecipeKey {
  const identity = `${draft.topicId}\n${draft.facetId}\n${draft.title.trim().toLowerCase()}`;
  const slug = slugOf(draft.title);
  return `${GENERATED_RECIPE_PREFIX}${slug === '' ? 'recipe' : slug}-${sha256Hex(identity).slice(0, 8)}`;
}

/** The explanation identity of a generated recipe, derived from its key and never chosen by hand. */
export const generatedUnitIdOf = (key: GeneratedRecipeKey): string => `${key}-v1`;
