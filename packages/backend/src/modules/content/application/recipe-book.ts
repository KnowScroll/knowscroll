import { CONCEPTS } from '../domain/concepts.js';
import { isGeneratedRecipeKey, titleOfKey, type BookRecipe } from '../domain/library/generated.js';
import { RECIPE_KEYS, RECIPES, type RecipeKey } from '../domain/library/index.js';
import { servingOrder, type CatalogueBrief } from '../domain/library/serving.js';

/**
 * The recipes stored in the database (`content.recipes`), read through a port so the book can be built over a database
 * handle, a transaction or a fixture. Every method reads the shared, nonpersonal table; none locks or writes.
 */
export interface StoredRecipes {
  get(key: string): Promise<BookRecipe | undefined>;
  /** The planet's stored recipes that may still be chosen: every status but `retired`. */
  ofPlanet(topicId: string): Promise<readonly BookRecipe[]>;
  /** Every stored recipe with its status, retired ones included, oldest first. */
  all(): Promise<readonly BookRecipe[]>;
}

/**
 * Where the library's recipes are read from (#674, D-412): the code-owned plan first, then the recipes stored in the
 * database. One question each for the recipe a key names, the recipes that would satisfy a catalogue brief, and every
 * recipe. Callers that choose or produce a recipe ask the book and never read `RECIPES` themselves.
 */
export interface RecipeBook {
  /** The recipe a key names, from code or from the database, or `undefined`. A retired stored recipe is still returned, with its status. */
  get(key: string): Promise<BookRecipe | undefined>;
  /**
   * The recipes whose Scroll would satisfy the brief, best first (`servingOrder`): code recipes before stored ones, and a
   * retired stored recipe never.
   */
  servingBrief(brief: CatalogueBrief): Promise<readonly BookRecipe[]>;
  /** Every recipe, code recipes first in plan order, then stored ones with their status. */
  all(): Promise<readonly BookRecipe[]>;
}

/**
 * One code-owned recipe as a book recipe. Built from the plan each time it is asked for, never kept: a test that marks a recipe
 * v1 or v2 for its own run changes the plan's object in place, and the book must see the change. A code recipe's title is made
 * from its key and its status is absent.
 */
const bookRecipeOfCode = (key: RecipeKey): BookRecipe => ({
  ...RECIPES[key],
  key,
  origin: 'code',
  title: titleOfKey(key),
});

/** The code-owned recipes as book recipes, in plan order. */
export const codeRecipes = (): readonly BookRecipe[] => RECIPE_KEYS.map(bookRecipeOfCode);

/** The code-owned recipe a key names, or `undefined`. Synchronous: the plan is in memory. */
export const codeRecipeOf = (key: string): BookRecipe | undefined =>
  Object.hasOwn(RECIPES, key) ? bookRecipeOfCode(key as RecipeKey) : undefined;

/** The system a planet belongs to in the catalogue; empty for a planet the catalogue no longer holds. */
export const systemOfTopic = (topicId: string): string =>
  CONCEPTS.find((concept) => concept.id === topicId)?.parent ?? '';

export function makeRecipeBook(stored: StoredRecipes): RecipeBook {
  return {
    async get(key) {
      const code = codeRecipeOf(key);
      if (code !== undefined) return code;
      return isGeneratedRecipeKey(key) ? stored.get(key) : undefined;
    },
    async servingBrief(brief) {
      const code = codeRecipes().filter((recipe) => recipe.topicId === brief.topicId);
      return servingOrder([...code, ...(await stored.ofPlanet(brief.topicId))], brief);
    },
    async all() {
      return [...codeRecipes(), ...(await stored.all())];
    },
  };
}
