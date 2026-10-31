import { describe, expect, it } from 'vitest';
import { researchUrl } from '../../../../infrastructure/research/public-pages.js';
import { CONCEPTS, conceptMeaning } from '../concepts.js';
import { EARTH_SKY_KIT, STAGE_KIT_IDS as SCROLL_MODEL_KIT_IDS } from '@knowscroll/scroll-model';
import { LIBRARY_SERIES } from './continuity.js';
import { INTERACTIVE_KINDS, STAGE_KIT_IDS } from './plan.js';
import { LIBRARY_SYSTEMS, RECIPES, RECIPE_KEYS, RECIPE_SETS, hazeFamilyOf, sceneFamilyOf } from './index.js';

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

  it('gives each system a haze family of the six, and no two systems the same while six or fewer exist', () => {
    const hazes = LIBRARY_SYSTEMS.map((system) => system.haze);
    const six = ['amber', 'cobalt', 'coral', 'pink', 'teal', 'violet'];
    for (const haze of hazes) expect(six).toContain(haze);
    // A seventh system has to share a family (D-102); until then every system has its own colour.
    if (LIBRARY_SYSTEMS.length <= six.length) expect(new Set(hazes).size).toBe(LIBRARY_SYSTEMS.length);
    if (LIBRARY_SYSTEMS.length === six.length) expect([...hazes].sort()).toEqual(six);
    expect(LIBRARY_SYSTEMS.map((system) => hazeFamilyOf(system.id))).toEqual(hazes);
    expect(hazeFamilyOf('earth.seasons')).toBeUndefined();
    expect(hazeFamilyOf('astronomy')).toBeUndefined();
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

describe('the kit that draws a recipe (stageKit, D-125, D-194)', () => {
  const byKit = (kit: string): string[] =>
    recipes
      .filter((recipe) => recipe.stageKit === kit)
      .map((recipe) => recipe.key)
      .sort();

  it('names only kits that exist, and keeps the plan’s list in step with the kits of scroll-model', () => {
    expect([...STAGE_KIT_IDS]).toEqual([...SCROLL_MODEL_KIT_IDS]);
    expect(STAGE_KIT_IDS[0]).toBe(EARTH_SKY_KIT);
    for (const recipe of recipes)
      if (recipe.stageKit !== undefined) expect(STAGE_KIT_IDS, recipe.key).toContain(recipe.stageKit);
  });

  it('gives each kit exactly the recipes whose subject it draws, so adding one is a deliberate edit', () => {
    expect(byKit('earth-sky.v1')).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits']);
    expect(byKit('tides.v1')).toEqual(['tides', 'tides-spring-neap']);
    expect(byKit('greenhouse.v1')).toEqual(['greenhouse', 'greenhouse-balance', 'greenhouse-radiation']);
    expect(byKit('star.v1')).toEqual(['stars-fusion', 'stars-lifecycle']);
    expect(byKit('transit.v1')).toEqual(['exoplanet-transit']);
    expect(byKit('circulation.v1')).toEqual(['blood-pressure', 'cardiac-cycle', 'oxygen-transport']);
    expect(byKit('nerve.v1')).toEqual(['action-potential', 'reflex-arc', 'synapse-signalling']);
    expect(byKit('starlight.v1')).toEqual(['exoplanet-habitable-zone', 'stars-colour-brightness']);
    expect(byKit('black-hole.v1')).toEqual(['black-hole-evidence', 'black-hole-formation', 'black-hole-horizon']);
    expect(recipes.filter((recipe) => recipe.stageKit !== undefined)).toHaveLength(22);
  });

  it('gives a kit only to recipes of the system whose subject it draws: Earth & sky, Space and the heart and nerves of the Human body', () => {
    for (const recipe of recipes.filter((candidate) => candidate.stageKit !== undefined))
      expect(['earth', 'space', 'human-body'], recipe.key).toContain(recipe.systemId);
    for (const recipe of recipes.filter((candidate) =>
      ['circulation.v1', 'nerve.v1'].includes(candidate.stageKit ?? ''),
    ))
      expect(recipe.systemId, recipe.key).toBe('human-body');
  });

  it('leaves the recipes no kit draws plain: coasts, the blanket audit, kinds of planet and other worlds', () => {
    for (const key of [
      'tides-coasts',
      // The audit of the blanket analogy: the greenhouse kit draws the layer, not an argument about a comparison.
      'greenhouse-limits',
      // A mass ruler would be a chart of real data, and the name says nothing a picture could draw (D-204).
      'exoplanet-kinds',
      'seasons-elsewhere',
      // No kit draws the immune system.
      'innate-immunity',
      'adaptive-immunity',
      'immune-memory',
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

const SEASONS = ['seasons', 'seasons-elsewhere', 'seasons-hemispheres', 'seasons-limits'] as const;
/** The recipes of the first waves (D-199): every recipe of these systems has no drawing kit. */
const WAVE_SYSTEMS = ['human-body', 'computing', 'machine-learning', 'history'];
const WAVE_RECIPES = recipes.filter((recipe) => WAVE_SYSTEMS.includes(recipe.systemId)).map((recipe) => recipe.key);

describe('the recipes the plan produces as v2 Scrolls (scrollV2, D-137)', () => {
  const v2 = recipes.filter((recipe) => recipe.scrollV2 !== undefined);

  it('marks the four Seasons recipes and the first waves, and nothing else, so adding one is a deliberate edit', () => {
    expect(v2.map((recipe) => recipe.key).sort()).toEqual([...SEASONS, ...WAVE_RECIPES].sort());
  });

  it('gives a picture exactly where a kit draws the subject: the variant follows stageKit', () => {
    for (const recipe of v2)
      expect(recipe.scrollV2?.variant === 'stage', recipe.key).toBe(recipe.stageKit !== undefined);
  });

  it('ships only misconception sources a person has reviewed, because the library refuses the rest at dispatch', () => {
    for (const recipe of v2) {
      const { misconception } = recipe.scrollV2!;
      if (misconception.kind === 'myth') expect(misconception.source.reviewed, recipe.key).toBe(true);
    }
  });

  it('keeps the one myth the V3 design documents, with its reviewed source, and gives the other three none', () => {
    expect(RECIPES.seasons.scrollV2).toEqual({
      variant: 'stage',
      misconception: {
        kind: 'myth',
        claim: 'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
        source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
      },
      landmark: { key: 'the-leaning-axis', name: 'The Leaning Axis' },
      finalCall: { kind: 'tilt' },
    });
    for (const key of ['seasons-hemispheres', 'seasons-limits', 'seasons-elsewhere'] as const)
      expect(RECIPES[key].scrollV2?.misconception, key).toEqual({ kind: 'none' });
  });
});

describe('the waves marked for S-6 (D-199)', () => {
  const waves = WAVE_RECIPES.map((key) => ({ key, ...RECIPES[key] }));

  /** The six Human body recipes the heart and nerve kits draw (D-201). Every other wave recipe has no kit. */
  const DRAWN = [
    'cardiac-cycle',
    'blood-pressure',
    'oxygen-transport',
    'action-potential',
    'synapse-signalling',
    'reflex-arc',
  ];

  it('covers every recipe of the four systems, and only the six heart and nerve recipes have a kit', () => {
    expect(waves).toHaveLength(35);
    for (const recipe of waves)
      if (DRAWN.includes(recipe.key)) expect(recipe.stageKit, recipe.key).toMatch(/^(circulation|nerve)\.v1$/u);
      else expect(recipe.stageKit, recipe.key).toBeUndefined();
  });

  it('makes each a v2 Scroll with calls and no myth, a stage Scroll exactly where a kit draws it and a plain one otherwise: none of its pages states a common wrong belief', () => {
    for (const recipe of waves) {
      expect(recipe.scrollV2?.variant, recipe.key).toBe(DRAWN.includes(recipe.key) ? 'stage' : 'plain');
      expect(recipe.scrollV2?.misconception, recipe.key).toEqual({ kind: 'none' });
      expect(recipe.scrollV2?.finalCall, recipe.key).toBeUndefined();
    }
  });

  it('names a landmark for each, in plain words that never claim mastery', () => {
    const mastery = /master|expert\b|genius|champion|perfect|complete|\bwin\b|winner/iu;
    for (const recipe of waves) {
      const landmark = recipe.scrollV2?.landmark;
      expect(landmark, recipe.key).toBeDefined();
      expect(landmark?.name, recipe.key).not.toMatch(mastery);
      expect(landmark?.name.split(' ').length, recipe.key).toBeLessThanOrEqual(5);
    }
  });

  it('marks every part of a series or none of it, so a series is admitted whole', () => {
    for (const series of LIBRARY_SERIES) {
      const marked = series.parts.filter((part) => RECIPES[part].scrollV2 !== undefined);
      expect([0, series.parts.length], series.id).toContain(marked.length);
    }
  });
});

describe('landmarks and the Final call control (D-187, D-188)', () => {
  const v2 = recipes.filter((recipe) => recipe.scrollV2 !== undefined);

  it('names a landmark for every v2 recipe, and leaves every other recipe without one', () => {
    expect(
      recipes
        .filter((recipe) => recipe.scrollV2?.landmark !== undefined)
        .map((recipe) => recipe.key)
        .sort(),
    ).toEqual([...SEASONS, ...WAVE_RECIPES].sort());
  });

  it('gives every landmark a key and a name that fit the document, and no two the same key or name', () => {
    const landmarks = v2.flatMap((recipe) =>
      recipe.scrollV2?.landmark === undefined ? [] : [recipe.scrollV2.landmark],
    );
    for (const landmark of landmarks) {
      expect(landmark.key).toMatch(/^[a-z][a-z0-9-]{1,39}$/u);
      expect(landmark.name.length).toBeGreaterThanOrEqual(4);
      expect(landmark.name.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(landmarks.map((landmark) => landmark.key)).size).toBe(landmarks.length);
    expect(new Set(landmarks.map((landmark) => landmark.name)).size).toBe(landmarks.length);
  });

  it('hands the reader the tilt of Earth only in the Scroll about the tilt, and only where the picture draws the axis', () => {
    const bound = v2.filter((recipe) => recipe.scrollV2?.finalCall !== undefined).map((recipe) => recipe.key);
    expect(bound).toEqual(['seasons']);
    for (const recipe of v2.filter((candidate) => candidate.scrollV2?.finalCall !== undefined))
      expect(recipe.stageKit, recipe.key).toBe('earth-sky.v1');
  });
});
