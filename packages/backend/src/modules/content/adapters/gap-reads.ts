import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { CatalogueSnapshot } from '../domain/catalogue/snapshot.js';
import type { GapRecipe, ReleasedCoverage } from '../domain/library/gap-facts.js';
import { isGeneratedRecipeKey } from '../domain/library/generated.js';
import { takeToSend, type CatalogueBrief, type ProductionRecipeKey } from '../domain/library/serving.js';
import { parseProductionRecipe } from '../production/topics.js';
import { readCatalogueIn } from './catalogue-store.js';
import { readLibraryStatus } from './production-state.js';
import { recipeBookOf } from './stored-recipes.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/**
 * The released Scrolls of the library by planet and facet, for the gap loop's scan and for making topics servable (#674, D-414, D-419).
 * A Scroll is released when its asset is `admitted` and the revision the asset points at has admitted coverage: a Scroll held for an
 * operator's read has no `admitted` asset yet, and a withdrawn one is no longer. Read from the derived region lookup, which the
 * coverage head's trigger keeps in step with admission, correction and retraction.
 *
 * A binding counts only while the catalogue still accepts the meaning it pinned (the same test a read of the mapping makes): a facet whose
 * meaning changed since the Scroll was mapped is not supplied by it, so it neither adds to a planet's count nor makes a topic servable.
 * `catalogue` is the release that judges it; the current one when none is given. Shared tables only: nothing personal is read.
 */
export async function readReleasedCoverage(db: Queryable, catalogue?: CatalogueSnapshot): Promise<ReleasedCoverage> {
  const snapshot = catalogue ?? (await readCatalogueIn(db));
  const bound = await sql<{ topic_id: string; facet_id: string; meaning_sha256: string; unit: string }>`
    select distinct b.topic_id, b.facet_id, bind->>'meaningSha256' as meaning_sha256, r.explanation_unit_id as unit
    from content.region_bindings b
    join content.assets a on a.id = b.asset_id and a.revision = b.asset_revision and a.status = 'admitted' and a.kind = 'scroll'
    join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
    join content.coverage_revisions c on c.asset_id = b.asset_id and c.asset_revision = b.asset_revision and c.revision = b.head_revision
    cross join lateral jsonb_array_elements(c.mapping->'bindings') bind
    where bind->>'topicId' = b.topic_id and bind->>'facetId' = b.facet_id`.execute(db);
  const planets = new Map<string, { units: Set<string>; facets: Map<string, Set<string>> }>();
  for (const row of bound.rows) {
    if (!snapshot.acceptsMeaning(row.topic_id, row.facet_id, row.meaning_sha256)) continue;
    const planet = planets.get(row.topic_id) ?? { units: new Set<string>(), facets: new Map<string, Set<string>>() };
    planets.set(row.topic_id, planet);
    planet.units.add(row.unit);
    const facet = planet.facets.get(row.facet_id) ?? new Set<string>();
    planet.facets.set(row.facet_id, facet);
    facet.add(row.unit);
  }
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    planets: [...planets]
      .sort(([a], [b]) => byId(a, b))
      .map(([topicId, planet]) => ({
        topicId,
        units: planet.units.size,
        facets: [...planet.facets]
          .sort(([a], [b]) => byId(a, b))
          .map(([facetId, units]) => ({ facetId, units: units.size })),
      })),
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
