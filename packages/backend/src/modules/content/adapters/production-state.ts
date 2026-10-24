import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import {
  pickRecipeToProduce,
  productionStanding,
  recipesServing,
  takeToSend,
  type CatalogueBrief,
  type LibraryRecipeStatus,
  type ProductionJobState,
  type ScrollProductionReading,
  type ScrollRecipeChoice,
} from '../domain/library/serving.js';
import { SCROLL_PRODUCTION_VERSION } from '../production/topics.js';

type Queryable = Kysely<Database> | Transaction<Database>;

interface RunRow {
  readonly topic: string;
  readonly state: ProductionJobState;
  readonly outcomes: readonly { readonly attempts?: readonly unknown[] }[];
}

/**
 * Every named recipe's production standing: its Scroll is admitted, its jobs at the current recipe
 * version are running, rejected (and may be taken again) or ended for good, or nothing has happened.
 * Reads shared, nonpersonal tables only.
 */
export async function readLibraryStatus(
  db: Queryable,
  recipes: readonly RecipeKey[],
): Promise<readonly LibraryRecipeStatus[]> {
  if (recipes.length === 0) return [];
  const runs = (
    await sql<RunRow>`select topic, state, outcomes from content.scroll_production_runs
      where policy_version = ${SCROLL_PRODUCTION_VERSION} and topic in (${sql.join(recipes)})
      order by topic, take`.execute(db)
  ).rows;
  const assetIds = recipes.map((recipe) => RECIPES[recipe].assetId);
  const assets = await db
    .selectFrom('content.assets')
    .select(['id', 'status', 'revision'])
    .where('id', 'in', assetIds)
    .execute();
  return recipes.map((recipe) => {
    const jobs = runs.filter((run) => run.topic === recipe);
    const asset = assets.find((row) => row.id === RECIPES[recipe].assetId);
    const admitted = asset?.status === 'admitted';
    const latest = jobs.at(-1);
    return {
      recipe,
      state: productionStanding(
        jobs.map((job) => job.state),
        admitted,
      ),
      ...(latest === undefined ? {} : { job: latest.state }),
      takes: jobs.length,
      ...(admitted ? { assetId: asset.id, revision: asset.revision } : {}),
      attempts: jobs.reduce(
        (total, job) => total + job.outcomes.reduce((sum, receipt) => sum + (receipt.attempts?.length ?? 0), 0),
        0,
      ),
    };
  });
}

/**
 * Chooses the library recipe a Create decision commissions for a catalogue brief, and the take to
 * run (D-037): code only, from the plan and the recipes' current standing. Read inside the caller's
 * personal transaction; no lock and no write.
 */
export async function chooseScrollRecipe(scope: PersonalScopeTx, brief: CatalogueBrief): Promise<ScrollRecipeChoice> {
  const candidates = recipesServing(brief);
  const standing = await readLibraryStatus(transactionOf(scope), candidates);
  const row = (key: RecipeKey) => standing.find((entry) => entry.recipe === key);
  const recipe = pickRecipeToProduce(candidates, (key) => row(key)?.state ?? 'stopped');
  const chosen = recipe === undefined ? undefined : row(recipe);
  const take = chosen === undefined ? undefined : takeToSend(chosen.state, chosen.takes);
  return recipe === undefined || take === undefined ? { kind: 'none' } : { kind: 'recipe', recipe, take };
}

/**
 * The standing of one recipe's production and the take a send for it should name, for a waiter
 * deciding whether to keep waiting and for a request that joins work already under way.
 */
export async function readScrollProduction(scope: PersonalScopeTx, recipe: string): Promise<ScrollProductionReading> {
  const key = Object.hasOwn(RECIPES, recipe) ? (recipe as RecipeKey) : undefined;
  if (key === undefined) return { state: 'stopped' };
  const [standing] = await readLibraryStatus(transactionOf(scope), [key]);
  if (standing === undefined) return { state: 'stopped' };
  const take = takeToSend(standing.state, standing.takes);
  return { state: standing.state, ...(take === undefined ? {} : { take }) };
}
