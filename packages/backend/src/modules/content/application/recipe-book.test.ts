import { describe, expect, it } from 'vitest';
import type { BookRecipe } from '../domain/library/generated.js';
import { GENERATED_SCROLL_V2_PLAN } from '../domain/library/generated.js';
import { RECIPE_KEYS, RECIPES } from '../domain/library/index.js';
import { codeRecipeOf, codeRecipes, makeRecipeBook, systemOfTopic, type StoredRecipes } from './recipe-book.js';

const stored = (
  key: string,
  topicId: string,
  facetId: string,
  status: BookRecipe['status'] = 'checked',
): BookRecipe => ({
  key,
  origin: 'proposal',
  status,
  title: `Title of ${key}`,
  explanationUnitId: `${key}-v1`,
  assetId: `00000000-0000-4000-8000-${key.length.toString().padStart(12, '0')}`,
  systemId: systemOfTopic(topicId),
  topicId,
  facetId,
  interactive: false,
  interactiveKind: null,
  brief: 'A brief that explains one thing. It asks only for what the pages say.',
  pages: ['https://en.wikipedia.org/wiki/Heart'],
  scrollV2: GENERATED_SCROLL_V2_PLAN,
});

/** A fake database: the stored recipes it holds. */
const fake = (rows: readonly BookRecipe[]): StoredRecipes => ({
  get: (key) => Promise.resolve(rows.find((row) => row.key === key)),
  ofPlanet: (topicId) => Promise.resolve(rows.filter((row) => row.topicId === topicId && row.status !== 'retired')),
  all: () => Promise.resolve(rows),
});

const tides = RECIPES.tides;

describe('the recipe book', () => {
  it('lists code recipes first in plan order, then stored ones, for all()', async () => {
    const rows = [stored('gen-a-11111111', tides.topicId, tides.facetId), stored('gen-b-22222222', 'human.heart', 'x')];
    const all = await makeRecipeBook(fake(rows)).all();
    expect(all.slice(0, RECIPE_KEYS.length).map((recipe) => recipe.key)).toEqual([...RECIPE_KEYS]);
    expect(all.slice(RECIPE_KEYS.length).map((recipe) => recipe.key)).toEqual(['gen-a-11111111', 'gen-b-22222222']);
    expect(
      all.slice(0, RECIPE_KEYS.length).every((recipe) => recipe.origin === 'code' && recipe.status === undefined),
    ).toBe(true);
  });

  it('looks a key up in the code plan or the database, and nowhere else', async () => {
    const book = makeRecipeBook(fake([stored('gen-a-11111111', tides.topicId, tides.facetId, 'retired')]));
    expect((await book.get('tides'))?.assetId).toBe(tides.assetId);
    expect((await book.get('tides'))?.origin).toBe('code');
    // A retired recipe is still returned by key, with its status: its Scroll still belongs to its planet.
    expect(await book.get('gen-a-11111111')).toMatchObject({ origin: 'proposal', status: 'retired' });
    expect(await book.get('gen-missing-33333333')).toBeUndefined();
    expect(await book.get('not-a-recipe')).toBeUndefined();
    // A stored recipe can never answer for a key that is not shaped like one.
    expect(await book.get('order-0123456789abcdef0123456789abcdef')).toBeUndefined();
  });

  it('answers a brief with the code recipes of the planet before its stored ones, and never a retired one', async () => {
    const rows = [
      stored('gen-one-11111111', tides.topicId, tides.facetId),
      stored('gen-two-22222222', tides.topicId, 'a.facet.that.is.not.tides'),
      stored('gen-gone-33333333', tides.topicId, tides.facetId, 'retired'),
    ];
    const book = makeRecipeBook(fake(rows));
    const planet = await book.servingBrief({ topicId: tides.topicId });
    const codeOfPlanet = RECIPE_KEYS.filter((key) => RECIPES[key].topicId === tides.topicId);
    expect(planet.map((recipe) => recipe.key)).toEqual([...codeOfPlanet, 'gen-one-11111111', 'gen-two-22222222']);
    const teaching = await book.servingBrief({ topicId: tides.topicId, facetId: tides.facetId });
    const teachingCode = codeOfPlanet.filter((key) => RECIPES[key].facetId === tides.facetId);
    expect(teaching.slice(0, teachingCode.length).map((recipe) => recipe.key)).toEqual(teachingCode);
    expect(teaching.map((recipe) => recipe.key)).toContain('gen-one-11111111');
    expect(teaching.map((recipe) => recipe.key)).not.toContain('gen-two-22222222');
    expect(teaching.map((recipe) => recipe.key)).not.toContain('gen-gone-33333333');
  });

  it('with no stored recipes answers exactly what the plan does', async () => {
    const book = makeRecipeBook(fake([]));
    for (const key of RECIPE_KEYS) {
      const brief = { topicId: RECIPES[key].topicId, facetId: RECIPES[key].facetId };
      const keys = (await book.servingBrief(brief)).map((recipe) => recipe.key);
      expect(keys).toContain(key);
      expect(keys.every((other) => RECIPES[other as keyof typeof RECIPES].topicId === brief.topicId)).toBe(true);
    }
  });

  it('shows a code recipe as the plan holds it now, so a recipe marked for one test run is seen', () => {
    const recipe = RECIPES.seasons as { scrollV2?: unknown };
    const before = recipe.scrollV2;
    try {
      delete recipe.scrollV2;
      expect(codeRecipeOf('seasons')?.scrollV2).toBeUndefined();
    } finally {
      if (before !== undefined) recipe.scrollV2 = before;
    }
    expect(codeRecipeOf('seasons')?.scrollV2).toBeDefined();
    expect(codeRecipes()).toHaveLength(RECIPE_KEYS.length);
    expect(codeRecipeOf('gen-anything-11111111')).toBeUndefined();
  });
});
