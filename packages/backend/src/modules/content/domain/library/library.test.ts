import { describe, expect, it } from 'vitest';
import { researchUrl } from '../../../../infrastructure/research/public-pages.js';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { seedSnapshot } from '../catalogue/seed.js';
import {
  EARTH_SKY_KIT,
  GUIDE_CHARACTERS,
  INTERACTIVE_KINDS as SCROLL_MODEL_PLAY_KINDS,
  LIMITS_V2,
  PICTURE_KINDS,
  SCROLL_SHAPES,
  STAGE_FIGURE_SLOTS,
  STAGE_KIT_IDS as SCROLL_MODEL_KIT_IDS,
} from '@knowscroll/scroll-model';
import { LIBRARY_SERIES } from './continuity.js';
import {
  GUIDE_CHARACTER_IDS,
  INTERACTIVE_KINDS,
  PICTURE_KIND_IDS,
  PLAY_BLOCK_KINDS,
  SCROLL_SHAPE_IDS,
  STAGE_FIGURE_SLOT_IDS,
  STAGE_KIT_IDS,
} from './plan.js';
import { LIBRARY_SYSTEMS, RECIPES, RECIPE_KEYS, RECIPE_SETS } from './index.js';

/** The catalogue the plan seeds, which is what the plan's own checks read: concepts, meanings, silhouettes and hazes. */
const plan = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);
const CONCEPTS = plan.all();
const conceptMeaning = plan.meaning;
const sceneFamilyOf = plan.sceneFamilyOf;
const hazeFamilyOf = plan.hazeOf;

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

/**
 * The 22 recipes that had a drawing kit until #787. Each is now planned as a document v3 Scroll, which has no kit; the kit code
 * stays until the owner has read that kit's rewrites, and is then deleted one kit at a time.
 */
const KIT_RECIPES_V3 = {
  'earth-sky.v1': ['seasons', 'seasons-hemispheres', 'seasons-limits'],
  'tides.v1': ['tides', 'tides-spring-neap'],
  'greenhouse.v1': ['greenhouse', 'greenhouse-balance', 'greenhouse-radiation'],
  'star.v1': ['stars-fusion', 'stars-lifecycle'],
  'transit.v1': ['exoplanet-transit'],
  'circulation.v1': ['blood-pressure', 'cardiac-cycle', 'oxygen-transport'],
  'nerve.v1': ['action-potential', 'reflex-arc', 'synapse-signalling'],
  'starlight.v1': ['exoplanet-habitable-zone', 'stars-colour-brightness'],
  'black-hole.v1': ['black-hole-evidence', 'black-hole-formation', 'black-hole-horizon'],
} as const;
const V3_KIT_KEYS: readonly string[] = Object.values(KIT_RECIPES_V3).flat();
const isV3 = (key: string): boolean => V3_KIT_KEYS.includes(key);

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

  it('names no kit on any recipe: the 22 recipes that had one are planned as document v3 Scrolls, which have none (#787)', () => {
    for (const kit of STAGE_KIT_IDS) expect(byKit(kit), kit).toEqual([]);
    expect(recipes.filter((recipe) => recipe.stageKit !== undefined)).toEqual([]);
  });

  it('plans the 22 recipes that had a kit as document v3 Scrolls, each kit’s recipes together (#787)', () => {
    expect(V3_KIT_KEYS).toHaveLength(22);
    for (const [kit, keys] of Object.entries(KIT_RECIPES_V3)) {
      expect(STAGE_KIT_IDS, kit).toContain(kit);
      for (const key of keys) expect(RECIPES[key].scrollV3, key).toBeDefined();
    }
    // Earth & sky, Space and the heart and nerves of the Human body: the systems whose subjects the kits drew.
    for (const key of V3_KIT_KEYS)
      expect(['earth', 'space', 'human-body'], key).toContain(RECIPES[key as keyof typeof RECIPES].systemId);
  });

  it('plans every recipe of the library as a document v3 Scroll, so no recipe is planned as v1 or v2 (#790)', () => {
    expect(recipes).toHaveLength(55);
    for (const recipe of recipes) {
      expect(recipe.scrollV3, recipe.key).toBeDefined();
      expect(recipe.scrollV2, recipe.key).toBeUndefined();
      expect(recipe.stageKit, recipe.key).toBeUndefined();
    }
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

  it('plans the recipes no kit drew as document v3 Scrolls too, not v2: coasts, the blanket audit, other worlds and kinds of planet (#790)', () => {
    for (const key of ['tides-coasts', 'greenhouse-limits', 'seasons-elsewhere', 'exoplanet-kinds'] as const) {
      expect(RECIPES[key], key).not.toHaveProperty('scrollV2');
      expect(RECIPES[key].scrollV3, key).toBeDefined();
    }
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

/** Every recipe is planned as a document v3 Scroll since #790; the first waves and the kit waves were marked v2 before (D-137, D-199, D-217). */
const WAVE_SYSTEMS = ['human-body', 'computing', 'machine-learning', 'history'];
const WAVE_RECIPES = recipes.filter((recipe) => WAVE_SYSTEMS.includes(recipe.systemId)).map((recipe) => recipe.key);

describe('the recipes the plan once produced as v2 Scrolls (scrollV2, D-137)', () => {
  it('marks no recipe v2 now: every recipe is planned as a document v3 Scroll (#790), and a recipe never carries both plans', () => {
    expect(recipes.filter((recipe) => recipe.scrollV2 !== undefined)).toEqual([]);
    for (const recipe of recipes)
      expect(recipe.scrollV2 !== undefined && recipe.scrollV3 !== undefined, recipe.key).toBe(false);
  });

  it('ships only misconception sources a person has reviewed, because the library refuses the rest at dispatch', () => {
    for (const recipe of recipes) {
      const misconception = recipe.scrollV3?.misconception;
      if (misconception?.kind === 'myth') expect(misconception.source.reviewed, recipe.key).toBe(true);
    }
  });

  it('keeps the one myth the V3 design documents, with its reviewed source, in the document v3 plan of "seasons" (#787), and gives every other recipe none (#790)', () => {
    expect(RECIPES.seasons.scrollV3?.misconception).toEqual({
      kind: 'myth',
      claim: 'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
      source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
    });
    expect(
      recipes.filter((recipe) => recipe.scrollV3?.misconception.kind === 'myth').map((recipe) => recipe.key),
    ).toEqual(['seasons']);
  });
});

describe('the waves marked for S-6 (D-199)', () => {
  const waves = WAVE_RECIPES.map((key) => ({ key, ...RECIPES[key] }));

  it('covers every recipe of the four systems, and none has a kit', () => {
    expect(waves).toHaveLength(35);
    for (const recipe of waves) expect(recipe.stageKit, recipe.key).toBeUndefined();
  });

  it('plans each as a document v3 Scroll with no myth, since #787 for the six a kit drew and #790 for the rest: none of its pages states a common wrong belief', () => {
    for (const recipe of waves) {
      expect(recipe.scrollV2, recipe.key).toBeUndefined();
      expect(recipe.scrollV3?.misconception, recipe.key).toEqual({ kind: 'none' });
    }
  });

  it('marks every part of a series or none of it, as a document v3 Scroll, so a series is admitted whole', () => {
    for (const series of LIBRARY_SERIES) {
      const marked = series.parts.filter(
        (part) => RECIPES[part].scrollV2 !== undefined || RECIPES[part].scrollV3 !== undefined,
      );
      expect([0, series.parts.length], series.id).toContain(marked.length);
    }
  });
});

describe('the kit waves marked for S-6b (D-217)', () => {
  const PLAIN = ['tides-coasts', 'greenhouse-limits'];
  const earthAndSpace = recipes.filter((recipe) => ['earth', 'space'].includes(recipe.systemId));

  it('plans every Earth and Space recipe a document v3 Scroll with no myth, the plain parts of the series (since #790) and the recipes a kit drew (since #787), and no Final call control', () => {
    for (const key of PLAIN) expect(RECIPES[key as keyof typeof RECIPES].scrollV3, key).toBeDefined();
    for (const recipe of earthAndSpace) {
      expect(recipe.scrollV2, recipe.key).toBeUndefined();
      expect(recipe.scrollV3, recipe.key).toBeDefined();
      if (recipe.key !== 'seasons') expect(recipe.scrollV3?.misconception, recipe.key).toEqual({ kind: 'none' });
    }
  });
});

describe('landmarks and the Final call control (D-187, D-188)', () => {
  it('names a landmark for no recipe now: a landmark is a v2 plan field, and every recipe is a document v3 recipe (#790)', () => {
    for (const recipe of recipes) {
      expect(recipe.scrollV2, recipe.key).toBeUndefined();
      expect(recipe.scrollV3, recipe.key).not.toHaveProperty('landmark');
    }
  });

  it('hands no reader the tilt of Earth now: the one Scroll that had it, "seasons", is a document v3 recipe with no picture to turn (#787)', () => {
    expect(RECIPES.seasons.scrollV2).toBeUndefined();
    expect(RECIPES.seasons.scrollV3).not.toHaveProperty('finalCall');
  });
});

describe('the play blocks and the guide of a recipe (D-207)', () => {
  it('names only blocks and characters that exist, and keeps the plan’s lists in step with scroll-model', () => {
    expect([...PLAY_BLOCK_KINDS]).toEqual([...SCROLL_MODEL_PLAY_KINDS]);
    expect([...GUIDE_CHARACTER_IDS]).toEqual([...GUIDE_CHARACTERS]);
  });

  it('gives a Scroll each block at most once and no more than its interactive budget', () => {
    for (const recipe of recipes) {
      const blocks = recipe.scrollV2?.blocks ?? [];
      expect(new Set(blocks).size, recipe.key).toBe(blocks.length);
      expect(blocks.length, recipe.key).toBeLessThanOrEqual(LIMITS_V2.otherInteractives);
    }
  });

  it('puts blocks and a guide only on a recipe that is a v2 Scroll', () => {
    for (const recipe of recipes) {
      const plan = recipe as { readonly scrollV2?: unknown; readonly blocks?: unknown; readonly guide?: unknown };
      if (plan.scrollV2 === undefined) expect([plan.blocks, plan.guide], recipe.key).toEqual([undefined, undefined]);
    }
  });
});

describe('what a recipe asks of its picture (D-382, D-383)', () => {
  const planned = recipes.filter((recipe) => recipe.scrollV2?.stagePlan !== undefined);

  it('keeps the plan’s figure slots in step with scroll-model', () => {
    expect([...STAGE_FIGURE_SLOT_IDS]).toEqual([...STAGE_FIGURE_SLOTS]);
  });

  it('is asked by no recipe now: the one that asked, "seasons", is a document v3 recipe (#787); a recipe that asks must be a stage Scroll drawn with Earth & sky, the one kit that draws orbits, figures and a reveal', () => {
    expect(planned.map((recipe) => recipe.key)).toEqual([]);
    for (const recipe of planned) {
      expect(recipe.scrollV2?.variant, recipe.key).toBe('stage');
      expect(recipe.stageKit, recipe.key).toBe(EARTH_SKY_KIT);
    }
  });

  it('asks for at least two months, so the recap draws, and names each figure slot once', () => {
    for (const recipe of planned) {
      const plan = recipe.scrollV2?.stagePlan;
      expect(plan?.orbitMonths ?? 2, recipe.key).toBeGreaterThanOrEqual(2);
      expect(plan?.orbitMonths ?? 2, recipe.key).toBeLessThanOrEqual(12);
      expect(new Set(plan?.figures).size, recipe.key).toBe(plan?.figures?.length ?? 0);
    }
  });
});

describe('the document v3 plan (scrollV3, #771)', () => {
  const planned = recipes.filter((recipe) => recipe.scrollV3 !== undefined);

  it('keeps the plan’s picture kinds and shapes in step with scroll-model', () => {
    expect([...PICTURE_KIND_IDS]).toEqual([...PICTURE_KINDS]);
    expect([...SCROLL_SHAPE_IDS]).toEqual([...SCROLL_SHAPES]);
  });

  it('gives a recipe one plan at most: v2 or document v3, never both', () => {
    for (const recipe of recipes)
      expect(recipe.scrollV2 !== undefined && recipe.scrollV3 !== undefined, recipe.key).toBe(false);
  });

  it('names two or three sections, and at most three pictures, each with what it is there to show', () => {
    for (const recipe of planned) {
      const plan = recipe.scrollV3;
      expect(plan?.sections.length ?? 0, recipe.key).toBeGreaterThanOrEqual(2);
      expect(plan?.sections.length ?? 0, recipe.key).toBeLessThanOrEqual(3);
      expect(plan?.pictures?.length ?? 1, recipe.key).toBeGreaterThanOrEqual(1);
      expect(plan?.pictures?.length ?? 1, recipe.key).toBeLessThanOrEqual(3);
      for (const picture of plan?.pictures ?? []) expect(picture.purpose.trim(), recipe.key).not.toBe('');
    }
  });

  describe('the 22 recipes that had a kit (#787)', () => {
    const kit = planned.filter((recipe) => isV3(recipe.key));

    it('plan at least one picture each, of a kind from the closed set and never a quotation', () => {
      expect(kit).toHaveLength(22);
      for (const recipe of kit) {
        const pictures = recipe.scrollV3?.pictures ?? [];
        expect(pictures.length, recipe.key).toBeGreaterThanOrEqual(1);
        for (const picture of pictures) {
          expect(PICTURE_KIND_IDS, recipe.key).toContain(picture.kind);
          // No page of these recipes quotes a person, so a statement picture here is a number or a list, never a quotation.
          expect(picture.purpose, recipe.key).not.toMatch(/\bquot(?:e|ation)/iu);
        }
      }
    });

    it('name no source, publisher or page in a section or a picture: a Scroll never shows where it read', () => {
      const names = /\b(?:NASA|NOAA|Wikipedia|Space Place|Earth Observatory|the page|this page)\b/u;
      for (const recipe of kit) {
        for (const text of [
          ...(recipe.scrollV3?.sections ?? []),
          ...(recipe.scrollV3?.pictures ?? []).map((picture) => picture.purpose),
        ])
          expect(text, recipe.key).not.toMatch(names);
      }
    });

    it('keep the myth only where a page of the recipe documents it: "seasons" alone', () => {
      expect(
        kit.filter((recipe) => recipe.scrollV3?.misconception.kind === 'myth').map((recipe) => recipe.key),
      ).toEqual(['seasons']);
    });

    it('keep their briefs free of made-up numbers and of controls the reader moves, which no page of theirs states', () => {
      // The brief rule: a brief asks only for what its pages state (README). A brief that asks for illustrative or made-up
      // numbers, or for an interactive control, was rewritten for these recipes; none may ask again.
      for (const recipe of kit)
        expect(recipe.brief, recipe.key).not.toMatch(
          /illustrative|made-up|labelled as illustrative|let the reader (?:move|change)/iu,
        );
    });
  });
  describe('the 33 recipes planned as document v3 Scrolls in #790', () => {
    const plain = planned.filter((recipe) => !isV3(recipe.key));

    it('are the 32 recipes that were plain v2 Scrolls and the v1 recipe "exoplanet-kinds"', () => {
      expect(plain).toHaveLength(33);
      expect(plain.map((recipe) => recipe.key)).toContain('exoplanet-kinds');
      expect(plain.map((recipe) => recipe.key)).toContain('seasons-elsewhere');
    });

    it('name no source, publisher or page in a section or a picture, never ask for a quotation, and write a percentage unit as %', () => {
      const names = /\b(?:NASA|NOAA|Wikipedia|MDN|Space Place|the page|this page)\b/u;
      for (const recipe of plain) {
        for (const picture of recipe.scrollV3?.pictures ?? []) {
          expect(PICTURE_KIND_IDS, recipe.key).toContain(picture.kind);
          expect(picture.purpose, recipe.key).not.toMatch(/\bquot(?:e|ation)/iu);
          // A chart unit is words of its passages, and "cent" is no passage's word: a percentage is the unit "%".
          expect(picture.purpose, recipe.key).not.toMatch(/per cent|percent\b/iu);
        }
        for (const text of [
          ...(recipe.scrollV3?.sections ?? []),
          ...(recipe.scrollV3?.pictures ?? []).map((picture) => picture.purpose),
        ])
          expect(text, recipe.key).not.toMatch(names);
      }
    });

    it('keep their briefs free of made-up numbers and of controls the reader moves, which no page of theirs states', () => {
      for (const recipe of plain)
        expect(recipe.brief, recipe.key).not.toMatch(
          /illustrative|made-up numbers labelled|let the reader|step the reader|interactive|disclosure|canonical/iu,
        );
    });

    it('give every recipe one to three pages, and a second page to the three whose brief needed a statement its first page did not offer (#790)', () => {
      for (const recipe of plain) {
        expect(recipe.pages.length, recipe.key).toBeGreaterThanOrEqual(1);
        expect(recipe.pages.length, recipe.key).toBeLessThanOrEqual(3);
      }
      expect(RECIPES['dns-lookup'].pages).toContain('https://en.wikipedia.org/wiki/Root_name_server');
      expect(RECIPES['attention-limits'].pages).toContain('https://en.wikipedia.org/wiki/Transformer_(deep_learning)');
      expect(RECIPES['next-token-generation'].pages).toContain('https://en.wikipedia.org/wiki/Seq2seq');
    });
  });
});
