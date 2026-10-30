import { describe, expect, it } from 'vitest';
import { researchUrl } from '../../../../infrastructure/research/public-pages.js';
import { CONCEPTS, conceptMeaning } from '../concepts.js';
import { EARTH_SKY_KIT } from '@knowscroll/scroll-model';
import { INTERACTIVE_KINDS, STAGE_KIT_IDS } from './plan.js';
import { LIBRARY_SYSTEMS, RECIPES, RECIPE_KEYS, RECIPE_SETS, sceneFamilyOf } from './index.js';

const recipes = RECIPE_KEYS.map((key) => ({ key, ...RECIPES[key] }));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

describe('library plan (code-owned data; fetching is checked by scripts/check-library-sources.mjs)', () => {
  it('holds 50 to 60 recipes, at least 22 of them interactive, with a spread of interactive kinds', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(50);
    expect(recipes.length).toBeLessThanOrEqual(60);
    const interactive = recipes.filter((recipe) => recipe.interactive);
    expect(interactive.length).toBeGreaterThanOrEqual(22);
    const kinds = new Set(interactive.map((recipe) => recipe.interactiveKind));
    expect([...kinds].sort()).toEqual([...INTERACTIVE_KINDS].sort());
    for (const recipe of recipes) expect(recipe.interactiveKind === null, recipe.key).toBe(!recipe.interactive);
  });

  it('keeps every recipe key, asset and explanation identity unique', () => {
    const declaredKeys = RECIPE_SETS.reduce((sum, set) => sum + Object.keys(set).length, 0);
    expect(recipes).toHaveLength(declaredKeys);
    expect(new Set(recipes.map((recipe) => recipe.assetId)).size).toBe(recipes.length);
    expect(new Set(recipes.map((recipe) => recipe.explanationUnitId)).size).toBe(recipes.length);
    for (const recipe of recipes) {
      expect(recipe.key, recipe.key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u);
      expect(recipe.key.length, recipe.key).toBeLessThanOrEqual(64);
      expect(recipe.assetId, recipe.key).toMatch(uuid);
    }
  });

  it('places every recipe on a real system, planet and facet of the catalogue', () => {
    for (const recipe of recipes) {
      const topic = CONCEPTS.find((concept) => concept.id === recipe.topicId);
      expect(topic?.parent, recipe.key).toBe(recipe.systemId);
      expect(conceptMeaning(recipe.topicId, recipe.facetId), recipe.key).toBeDefined();
      if (recipe.supportingFacetId !== undefined) {
        expect(recipe.supportingFacetId, recipe.key).not.toBe(recipe.facetId);
        expect(conceptMeaning(recipe.topicId, recipe.supportingFacetId), recipe.key).toBeDefined();
      }
    }
  });

  it('gives every planet at least three recipes covering at least two facets', () => {
    const byTopic = groupBy(recipes, (recipe) => recipe.topicId);
    for (const system of LIBRARY_SYSTEMS)
      for (const topic of system.topics) {
        const own = byTopic.get(topic.id) ?? [];
        expect(own.length, topic.id).toBeGreaterThanOrEqual(3);
        expect(new Set(own.map((recipe) => recipe.facetId)).size, topic.id).toBeGreaterThanOrEqual(2);
      }
    expect(byTopic.size).toBe(LIBRARY_SYSTEMS.flatMap((system) => system.topics).length);
    expect(byTopic.size).toBe(17);
    expect(LIBRARY_SYSTEMS).toHaveLength(6);
  });

  it('gives every facet a recipe that teaches it, so a request for any catalogue meaning can be produced', () => {
    for (const system of LIBRARY_SYSTEMS)
      for (const topic of system.topics)
        for (const facet of topic.facets)
          expect(
            recipes.some((recipe) => recipe.topicId === topic.id && recipe.facetId === facet.id),
            facet.id,
          ).toBe(true);
  });

  it('gives every system and planet a Scene family, with Earth as it always was', () => {
    const families = ['terraced.v1', 'ridged.v1', 'archipelago.v1'];
    for (const system of LIBRARY_SYSTEMS) {
      expect(families, system.id).toContain(sceneFamilyOf(system.id));
      for (const topic of system.topics) expect(families, topic.id).toContain(sceneFamilyOf(topic.id));
    }
    expect(['earth', 'earth.seasons', 'earth.tides', 'earth.greenhouse-effect'].map(sceneFamilyOf)).toEqual([
      'terraced.v1',
      'terraced.v1',
      'archipelago.v1',
      'ridged.v1',
    ]);
    expect(sceneFamilyOf('earth.seasons.axial-tilt')).toBeUndefined();
    expect(sceneFamilyOf('astronomy')).toBeUndefined();
  });

  it('declares each facet once, with a meaning, under its planet', () => {
    const facetIds = new Set<string>();
    for (const system of LIBRARY_SYSTEMS) {
      expect(system.meaning.length).toBeGreaterThan(10);
      for (const topic of system.topics) {
        expect(topic.id.startsWith(`${system.id}.`), topic.id).toBe(true);
        expect(topic.meaning.length).toBeGreaterThan(10);
        expect(topic.facets.length, topic.id).toBeGreaterThanOrEqual(2);
        for (const facet of topic.facets) {
          expect(facet.id.startsWith(`${topic.id}.`), facet.id).toBe(true);
          expect(facet.meaning.length, facet.id).toBeGreaterThan(10);
          expect(facetIds.has(facet.id), facet.id).toBe(false);
          facetIds.add(facet.id);
        }
      }
    }
  });

  it('writes short briefs and names one to three allowlisted research pages', () => {
    for (const recipe of recipes) {
      const sentences = recipe.brief.split(/(?<=[.?!])\s+/u);
      expect(sentences.length, recipe.key).toBeGreaterThanOrEqual(2);
      expect(recipe.pages.length, recipe.key).toBeGreaterThanOrEqual(1);
      expect(recipe.pages.length, recipe.key).toBeLessThanOrEqual(3);
      expect(new Set(recipe.pages).size, recipe.key).toBe(recipe.pages.length);
      for (const page of recipe.pages) expect(() => researchUrl(page), `${recipe.key} ${page}`).not.toThrow();
    }
  });

  it('asks each recipe for a different explanation from its siblings', () => {
    for (const [topicId, siblings] of groupBy(recipes, (recipe) => recipe.topicId))
      expect(new Set(siblings.map((recipe) => recipe.brief)).size, topicId).toBe(siblings.length);
  });

  it('keeps the original six recipes and their Reel identities unchanged', () => {
    expect(RECIPES.seasons).toMatchObject({
      script: 'seasons-v5',
      topicId: 'earth.seasons',
      assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1',
      explanationUnitId: 'legacy-cutroom-seasons-v5',
      interactive: true,
    });
    expect(RECIPES.tides).toMatchObject({
      script: 'tides-v4',
      topicId: 'earth.tides',
      assetId: '8349204a-0c98-45d3-a354-6c73be4a86de',
      explanationUnitId: 'legacy-cutroom-tides-v4',
      interactive: true,
    });
    expect(RECIPES.greenhouse).toMatchObject({
      script: 'greenhouse',
      topicId: 'earth.greenhouse-effect',
      assetId: 'a73a7732-a154-4c10-aa6f-169fa10cd8aa',
      explanationUnitId: 'legacy-cutroom-greenhouse',
      interactive: false,
    });
    expect(RECIPES['greenhouse-radiation'].assetId).toBe('76b65d2e-991a-4be8-9d70-aab9f275396c');
    expect(RECIPES['greenhouse-balance'].assetId).toBe('02a7bdec-4628-4360-8f59-de7b459b183d');
    expect(RECIPES['greenhouse-limits'].assetId).toBe('ff51d698-4d91-4ce9-b54a-4c88f0e9ef9d');
    expect(recipes.filter((recipe) => recipe.explanationUnitId.startsWith('legacy-cutroom-'))).toHaveLength(3);
  });

  it('adds "Seasons elsewhere" as a new recipe and facet, and keeps seasons-limits and its facet as they were', () => {
    expect(RECIPES['seasons-elsewhere']).toMatchObject({
      explanationUnitId: 'earth-seasons-elsewhere-v1',
      topicId: 'earth.seasons',
      facetId: 'earth.seasons.elsewhere',
    });
    expect(RECIPES['seasons-limits']).toMatchObject({
      assetId: 'cde79338-06f9-4405-aa1c-1ccff9c51d4b',
      explanationUnitId: 'earth-seasons-limits-v1',
      facetId: 'earth.seasons.limits',
    });
    expect(conceptMeaning('earth.seasons', 'earth.seasons.limits')?.facetMeaning).toBe(
      'Limits of simplified seasonal geometry, including the distance misconception.',
    );
    expect(conceptMeaning('earth.seasons', 'earth.seasons.elsewhere')).toBeDefined();
  });
});

describe('the kit that draws a recipe (stageKit, D-125)', () => {
  it('names only kits that exist, and keeps the plan’s list in step with the Earth & sky kit of scroll-model', () => {
    expect([...STAGE_KIT_IDS]).toEqual([EARTH_SKY_KIT]);
    for (const recipe of recipes)
      if (recipe.stageKit !== undefined) expect(STAGE_KIT_IDS, recipe.key).toContain(recipe.stageKit);
  });

  it('gives a stage only to the recipes the Earth & sky kit draws: three Seasons parts, and nothing else yet', () => {
    expect(
      recipes
        .filter((recipe) => recipe.stageKit !== undefined)
        .map((recipe) => recipe.key)
        .sort(),
    ).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits']);
  });

  it('leaves tides, stars, exoplanets, the greenhouse effect and other worlds plain: the kit draws no bulge, no star, no energy flow and no planet but Earth', () => {
    for (const key of [
      'tides',
      'tides-spring-neap',
      'tides-coasts',
      'greenhouse',
      'greenhouse-radiation',
      'greenhouse-balance',
      'greenhouse-limits',
      'stars-fusion',
      'exoplanet-habitable-zone',
      'seasons-elsewhere',
    ] as const)
      expect(RECIPES[key].stageKit, key).toBeUndefined();
  });

  it('draws "Seasons elsewhere" from pages about Mars and Uranus, and keeps its brief to what they state', () => {
    const { brief, pages } = RECIPES['seasons-elsewhere'];
    expect(pages).toEqual(['https://science.nasa.gov/mars/facts/', 'https://science.nasa.gov/uranus/facts/']);
    expect(brief).toContain('Mars');
    expect(brief).toContain('Uranus');
    // No passage of these pages is about a world without a tilt, so the brief does not ask for one.
    expect(brief).not.toMatch(/no tilt|without a tilt|upright/iu);
    expect(brief).not.toMatch(/picture|stage|pinned/iu);
  });
});
