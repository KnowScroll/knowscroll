import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { GapRecipe, ReleasedCoverage } from '../domain/library/gap-facts.js';
import { isGeneratedRecipeKey } from '../domain/library/generated.js';
import { takeToSend, type CatalogueBrief, type ProductionRecipeKey } from '../domain/library/serving.js';
import { parseProductionRecipe } from '../production/topics.js';
import { readLibraryStatus } from './production-state.js';
import { recipeBookOf } from './stored-recipes.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/**
 * The released Scrolls of the library by planet and facet, for the gap loop's scan (#674, D-414). A Scroll is released when its asset
 * is `admitted` and the revision the asset points at has admitted coverage: a Scroll held for an operator's read has no
 * `admitted` asset yet, and a withdrawn one is no longer. Read from the derived region lookup, which the coverage head's trigger
 * keeps in step with admission, correction and retraction. Shared tables only: nothing personal is read.
 */
export async function readReleasedCoverage(db: Queryable): Promise<ReleasedCoverage> {
  const released = sql`content.region_bindings b
    join content.assets a on a.id = b.asset_id and a.revision = b.asset_revision and a.status = 'admitted' and a.kind = 'scroll'
    join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision`;
  const planets = await sql<{ topic_id: string; units: string }>`
    select b.topic_id, count(distinct r.explanation_unit_id) as units from ${released} group by b.topic_id`.execute(db);
  const facets = await sql<{ topic_id: string; facet_id: string; units: string }>`
    select b.topic_id, b.facet_id, count(distinct r.explanation_unit_id) as units from ${released}
    group by b.topic_id, b.facet_id order by b.topic_id, b.facet_id`.execute(db);
  return {
    planets: planets.rows
      .map((row) => ({
        topicId: row.topic_id,
        units: Number(row.units),
        facets: facets.rows
          .filter((facet) => facet.topic_id === row.topic_id)
          .map((facet) => ({ facetId: facet.facet_id, units: Number(facet.units) })),
      }))
      .sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0)),
  };
}

/**
 * The recipes that would serve a gap's planet (and facet), code recipes and stored ones, with where each one's production stands
 * and the take a send should name (#674, D-414). A retired recipe is never listed. The loop uses it to see whether the hole is
 * already being filled (a recipe running or held for a read), whether a stored recipe waits to be commissioned, or whether
 * a proposal is due. Reads shared tables only; no lock, no write.
 */
export async function readGapRecipes(db: Queryable, target: CatalogueBrief): Promise<readonly GapRecipe[]> {
  const recipes = await recipeBookOf(db).servingBrief(target);
  const standing = await readLibraryStatus(
    db,
    recipes.map((recipe) => recipe.key as ProductionRecipeKey),
  );
  return recipes.flatMap((recipe) => {
    const row = standing.find((entry) => entry.recipe === recipe.key);
    if (row === undefined) return [];
    const take = takeToSend(row.state, row.takes);
    return [
      {
        key: recipe.key,
        stored: isGeneratedRecipeKey(recipe.key),
        facetId: recipe.facetId,
        state: row.state,
        ...(take === undefined ? {} : { take }),
      },
    ];
  });
}

/** Where each named recipe's production stands (a key the library does not hold is absent): for a commissioned gap to see whether its Scrolls were released. */
export async function readRecipeStates(
  db: Queryable,
  keys: readonly string[],
): Promise<ReadonlyMap<string, GapRecipe['state']>> {
  const named = keys.flatMap((key) => {
    const recipe = parseProductionRecipe(key);
    return recipe === undefined ? [] : [recipe];
  });
  const rows = await readLibraryStatus(db, named);
  return new Map(rows.map((row) => [row.recipe, row.state]));
}
