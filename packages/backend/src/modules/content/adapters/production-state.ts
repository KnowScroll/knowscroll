import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import {
  pickRecipeToProduce,
  recipesServing,
  type CatalogueBrief,
  type LibraryRecipeStatus,
  type ScrollProductionState,
  type ScrollRecipeChoice,
} from '../domain/library/serving.js';
import { SCROLL_PRODUCTION_VERSION } from '../production/topics.js';

type Queryable = Kysely<Database> | Transaction<Database>;

interface RunRow {
  readonly topic: string;
  readonly state: NonNullable<LibraryRecipeStatus['job']>;
  readonly outcomes: readonly { readonly attempts?: readonly unknown[] }[];
}

function stateOf(job: RunRow | undefined, admitted: boolean): ScrollProductionState {
  if (admitted) return 'published';
  if (job === undefined) return 'not_started';
  return job.state === 'research' || job.state === 'writer' ? 'running' : 'stopped';
}

/**
 * Every named recipe's production standing: its Scroll is admitted, a job at the current recipe
 * version is running or ended, or nothing has happened. Reads shared, nonpersonal tables only.
 */
export async function readLibraryStatus(
  db: Queryable,
  recipes: readonly RecipeKey[],
): Promise<readonly LibraryRecipeStatus[]> {
  if (recipes.length === 0) return [];
  const runs = (
    await sql<RunRow>`select topic, state, outcomes from content.scroll_production_runs
      where policy_version = ${SCROLL_PRODUCTION_VERSION} and topic in (${sql.join(recipes)})`.execute(db)
  ).rows;
  const assetIds = recipes.map((recipe) => RECIPES[recipe].assetId);
  const assets = await db
    .selectFrom('content.assets')
    .select(['id', 'status', 'revision'])
    .where('id', 'in', assetIds)
    .execute();
  return recipes.map((recipe) => {
    const job = runs.find((run) => run.topic === recipe);
    const asset = assets.find((row) => row.id === RECIPES[recipe].assetId);
    const admitted = asset?.status === 'admitted';
    return {
      recipe,
      state: stateOf(job, admitted),
      ...(job === undefined ? {} : { job: job.state }),
      ...(admitted ? { assetId: asset.id, revision: asset.revision } : {}),
      attempts: (job?.outcomes ?? []).reduce((total, receipt) => total + (receipt.attempts?.length ?? 0), 0),
    };
  });
}

/**
 * Chooses the library recipe a Create decision commissions for a catalogue brief (D-037): code
 * only, from the plan and the recipes' current standing. Read inside the caller's personal
 * transaction; no lock and no write.
 */
export async function chooseScrollRecipe(scope: PersonalScopeTx, brief: CatalogueBrief): Promise<ScrollRecipeChoice> {
  const candidates = recipesServing(brief);
  const standing = await readLibraryStatus(transactionOf(scope), candidates);
  const recipe = pickRecipeToProduce(
    candidates,
    (key) => standing.find((row) => row.recipe === key)?.state ?? 'stopped',
  );
  return recipe === undefined ? { kind: 'none' } : { kind: 'recipe', recipe };
}

/** The standing of one recipe's production, for a waiter deciding whether to keep waiting. */
export async function readScrollProduction(scope: PersonalScopeTx, recipe: string): Promise<ScrollProductionState> {
  const key = Object.hasOwn(RECIPES, recipe) ? (recipe as RecipeKey) : undefined;
  if (key === undefined) return 'stopped';
  const [standing] = await readLibraryStatus(transactionOf(scope), [key]);
  return standing?.state ?? 'stopped';
}
