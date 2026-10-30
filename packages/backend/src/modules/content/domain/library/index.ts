import { computingRecipes, computingSystem } from './computing.js';
import { earthRecipes, earthSystem } from './earth.js';
import { historyRecipes, historySystem } from './history.js';
import { humanBodyRecipes, humanBodySystem } from './human-body.js';
import { machineLearningRecipes, machineLearningSystem } from './machine-learning.js';
import type { HazeFamilyName, LibraryRecipe, LibrarySystem, SceneFamilyName } from './plan.js';
import { spaceRecipes, spaceSystem } from './space.js';

/**
 * The library plan: every system, planet and facet KnowScroll holds Scrolls for, and the recipes the
 * generator runs. One file per system; add a recipe or a planet there, and the concept catalogue,
 * the operator's recipe keys and the coverage rule all follow.
 */
export const LIBRARY_SYSTEMS: readonly LibrarySystem[] = [
  earthSystem,
  spaceSystem,
  machineLearningSystem,
  humanBodySystem,
  computingSystem,
  historySystem,
];

/** The recipe records of each system file, so tests can prove no two files share a key. */
export const RECIPE_SETS = [
  earthRecipes,
  spaceRecipes,
  machineLearningRecipes,
  humanBodyRecipes,
  computingRecipes,
  historyRecipes,
] as const;

const declared = {
  ...earthRecipes,
  ...spaceRecipes,
  ...machineLearningRecipes,
  ...humanBodyRecipes,
  ...computingRecipes,
  ...historyRecipes,
} as const;

/** The operator key of a recipe: the record key in its system file. */
export type RecipeKey = keyof typeof declared;
export const RECIPES: Readonly<Record<RecipeKey, LibraryRecipe>> = declared;
export const RECIPE_KEYS = Object.keys(RECIPES) as readonly RecipeKey[];

const sceneFamilies = new Map<string, SceneFamilyName>(
  LIBRARY_SYSTEMS.flatMap((system) => [
    [system.id, system.sceneFamily] as const,
    ...system.topics.map((topic) => [topic.id, topic.sceneFamily ?? system.sceneFamily] as const),
  ]),
);

/**
 * The Scene family of a system (and its star) or a planet, by its catalogue id; `undefined` for an
 * id the plan does not hold. A region has no family of its own: it inherits its planet's.
 */
export function sceneFamilyOf(meaningId: string): SceneFamilyName | undefined {
  return sceneFamilies.get(meaningId);
}

const hazeFamilies = new Map<string, HazeFamilyName>(LIBRARY_SYSTEMS.map((system) => [system.id, system.haze]));

/** The haze family of a system by its catalogue id; `undefined` for an id the plan does not hold. */
export function hazeFamilyOf(systemId: string): HazeFamilyName | undefined {
  return hazeFamilies.get(systemId);
}
