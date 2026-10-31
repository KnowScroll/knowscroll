import { sql, type Kysely, type Transaction } from 'kysely';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import { summariseAnswerChecks } from '../domain/answer-check.js';
import {
  MAX_TAKES_PER_RECIPE,
  pickRecipeToProduce,
  productionStanding,
  recipesServing,
  regenerationStanding,
  takeToSend,
  type CatalogueBrief,
  type LibraryRecipeStatus,
  type ProductionJobState,
  type ScrollProductionReading,
  type ScrollRecipeChoice,
} from '../domain/library/serving.js';
import { answerChecksOf } from '../production/answer-check.js';
import { planRefusalOf, productionVersionOf, scrollV2PlanOf } from '../production/topics.js';

type Queryable = Kysely<Database> | Transaction<Database>;

interface RunRow {
  readonly topic: string;
  readonly state: 'research' | 'writer' | 'published' | 'rejected' | 'unknown';
  /** The review gate's decision on the revision this job published, when it went through the gate (D-138). */
  readonly review: 'held' | 'released' | 'rejected' | null;
  readonly revision: number | null;
  readonly outcomes: readonly { readonly attempts?: readonly unknown[] }[];
}

/** The revision of each asset that waits for an operator's decision, whichever production version made it. */
async function readHeldRevisions(db: Queryable, assetIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
  const held = await db
    .selectFrom('content.revision_reviews')
    .select(['asset_id', 'revision'])
    .where('asset_id', 'in', assetIds)
    .where('state', '=', 'held')
    .orderBy('revision')
    .execute();
  const lowest = new Map<string, number>();
  for (const row of held) if (!lowest.has(row.asset_id)) lowest.set(row.asset_id, row.revision);
  return lowest;
}

/**
 * The job's state for the recipe's standing. A job that published into the review gate is `held` until
 * an operator decides, and `rejected` (its take spent, the next may start) once the gate rejected it.
 */
function standingStateOf(run: RunRow): ProductionJobState {
  if (run.state !== 'published') return run.state;
  if (run.review === 'held') return 'held';
  return run.review === 'rejected' ? 'rejected' : 'published';
}

/**
 * Every named recipe's production standing: its Scroll is admitted, its jobs at the current recipe
 * version are running, rejected (and may be taken again) or ended for good, or nothing has happened.
 * A recipe the plan marks `scrollV2` is published only once its current revision is a v2 document: a
 * v1 Scroll admitted earlier does not satisfy it, so the recipe is produced again as a new revision
 * (D-129). Reads shared, nonpersonal tables only.
 */
export async function readLibraryStatus(
  db: Queryable,
  recipes: readonly RecipeKey[],
): Promise<readonly LibraryRecipeStatus[]> {
  if (recipes.length === 0) return [];
  const runs = (
    await sql<RunRow>`select run.topic, run.state, review.state as review, run.asset_revision as revision, run.outcomes
      from content.scroll_production_runs run
      left join content.revision_reviews review on review.asset_id = run.asset_id and review.revision = run.asset_revision
      where (run.topic, run.policy_version) in (${sql.join(recipes.map((recipe) => sql`(${recipe}, ${productionVersionOf(recipe)})`))})
      order by run.topic, run.take`.execute(db)
  ).rows;
  const assetIds = recipes.map((recipe) => RECIPES[recipe].assetId);
  const heldRevisions = await readHeldRevisions(db, assetIds);
  const assets = await db
    .selectFrom('content.assets as asset')
    .leftJoin('content.asset_revisions as current', (join) =>
      join.onRef('current.asset_id', '=', 'asset.id').onRef('current.revision', '=', 'asset.revision'),
    )
    .select(['asset.id', 'asset.status', 'asset.revision', 'current.document_version'])
    .where('asset.id', 'in', assetIds)
    .execute();
  return recipes.map((recipe) => {
    const jobs = runs.filter((run) => run.topic === recipe);
    const asset = assets.find((row) => row.id === RECIPES[recipe].assetId);
    const admitted =
      asset?.status === 'admitted' &&
      (scrollV2PlanOf(recipe) === undefined || asset.document_version === SCROLL_DOCUMENT_V2_SCHEMA_VERSION);
    const latest = jobs.at(-1);
    const jobStates = jobs.map(standingStateOf);
    const v2 = scrollV2PlanOf(recipe) !== undefined;
    const regeneration = regenerationStanding({
      v2,
      admitted,
      jobs: jobStates,
      heldRevision: heldRevisions.has(RECIPES[recipe].assetId),
    });
    const check = latest === undefined ? undefined : summariseAnswerChecks(answerChecksOf(latest.outcomes));
    const standing = productionStanding(jobStates, admitted);
    return {
      recipe,
      state:
        // A recipe the plan does not allow can start no take, so nothing is sent for it and no request chooses it.
        !admitted && planRefusalOf(recipe) !== undefined
          ? 'stopped'
          : // A revision an earlier production version left held still waits for a decision: no new take piles on it.
            !admitted && heldRevisions.has(RECIPES[recipe].assetId) && ['not_started', 'retryable'].includes(standing)
            ? 'held'
            : standing,
      ...(latest === undefined ? {} : { job: standingStateOf(latest) }),
      takes: jobs.length,
      ...(admitted ? { assetId: asset.id, revision: asset.revision } : {}),
      ...(heldRevisions.has(RECIPES[recipe].assetId)
        ? { assetId: asset?.id ?? RECIPES[recipe].assetId, heldRevision: heldRevisions.get(RECIPES[recipe].assetId) }
        : {}),
      attempts: jobs.reduce(
        (total, job) => total + job.outcomes.reduce((sum, receipt) => sum + (receipt.attempts?.length ?? 0), 0),
        0,
      ),
      regeneration,
      ...(v2 ? { takesLeft: Math.max(0, MAX_TAKES_PER_RECIPE - jobs.length) } : {}),
      ...(check === undefined ? {} : { check }),
    };
  });
}

/**
 * Chooses the library recipe a Create decision commissions for a catalogue brief, and the take to
 * run (D-037): code only, from the plan and the recipes' current standing. Read inside the caller's
 * personal transaction; no lock and no write.
 *
 * A v2 library recipe is never chosen: its Scroll waits for an operator to read it before anyone is
 * served (D-138), so a person's ask could not be answered by it and the production would only be
 * paid for. The operator's library run makes those.
 */
export async function chooseScrollRecipe(scope: PersonalScopeTx, brief: CatalogueBrief): Promise<ScrollRecipeChoice> {
  const candidates = recipesServing(brief).filter((recipe) => scrollV2PlanOf(recipe) === undefined);
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
 *
 * Nothing a person's ask waits on is coming from a v2 library recipe (D-138): the operator's library run
 * makes those, and its Scroll waits for a read. So a group that names one, from before the plan marked it
 * v2, reads as stopped until the Scroll is served: a join never sends its job again, and its waiters
 * close honestly instead of waiting on work Create does not own.
 */
export async function readScrollProduction(scope: PersonalScopeTx, recipe: string): Promise<ScrollProductionReading> {
  const key = Object.hasOwn(RECIPES, recipe) ? (recipe as RecipeKey) : undefined;
  if (key === undefined) return { state: 'stopped' };
  const [standing] = await readLibraryStatus(transactionOf(scope), [key]);
  if (standing === undefined) return { state: 'stopped' };
  if (scrollV2PlanOf(key) !== undefined && standing.state !== 'published') return { state: 'stopped' };
  const take = takeToSend(standing.state, standing.takes);
  return { state: standing.state, ...(take === undefined ? {} : { take }) };
}
