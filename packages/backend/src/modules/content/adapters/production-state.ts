import { sql, type Kysely, type Transaction } from 'kysely';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { isGeneratedRecipeKey, type BookRecipe } from '../domain/library/generated.js';
import { summariseAnswerChecks } from '../domain/answer-check.js';
import {
  MAX_TAKES_PER_RECIPE,
  pickRecipeToProduce,
  productionStanding,
  regenerationStanding,
  takeToSend,
  type CatalogueBrief,
  type ChooseRecipeOptions,
  type LibraryRecipeStatus,
  type ProductionJobState,
  type ProductionRecipeKey,
  type ScrollProductionReading,
  type ScrollRecipeChoice,
} from '../domain/library/serving.js';
import { answerChecksOf } from '../production/answer-check.js';
import { parseProductionRecipe, planRefusalOf, productionVersionOf, scrollV2PlanOf } from '../production/topics.js';
import { codeRecipeOf } from '../application/recipe-book.js';
import { recipeBookOf } from './stored-recipes.js';

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

/** What a recipe key resolves to for its standing: the asset its Scroll is, and whether it may still be produced. */
interface RecipeIdentity {
  readonly assetId: string;
  readonly retired: boolean;
}

/** The asset of each named recipe: a code recipe's from the plan, a stored recipe's from `content.recipes`. */
async function readRecipeIdentities(
  db: Queryable,
  recipes: readonly ProductionRecipeKey[],
): Promise<ReadonlyMap<string, RecipeIdentity>> {
  const identities = new Map<string, RecipeIdentity>();
  const stored: string[] = [];
  for (const recipe of recipes) {
    if (isGeneratedRecipeKey(recipe)) stored.push(recipe);
    else {
      const code = codeRecipeOf(recipe);
      if (code !== undefined) identities.set(recipe, { assetId: code.assetId, retired: false });
    }
  }
  if (stored.length > 0) {
    const { rows } = await sql<{ key: string; asset_id: string; status: string }>`
      select key, asset_id, status from content.recipes where key in (${sql.join(stored)})`.execute(db);
    for (const row of rows) identities.set(row.key, { assetId: row.asset_id, retired: row.status === 'retired' });
  }
  return identities;
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
  requested: readonly ProductionRecipeKey[],
): Promise<readonly LibraryRecipeStatus[]> {
  if (requested.length === 0) return [];
  const identities = await readRecipeIdentities(db, requested);
  // A stored recipe the database no longer holds has no standing to report.
  const recipes = requested.filter((recipe) => identities.has(recipe));
  if (recipes.length === 0) return [];
  const runs = (
    await sql<RunRow>`select run.topic, run.state, review.state as review, run.asset_revision as revision, run.outcomes
      from content.scroll_production_runs run
      left join content.revision_reviews review on review.asset_id = run.asset_id and review.revision = run.asset_revision
      where (run.topic, run.policy_version) in (${sql.join(recipes.map((recipe) => sql`(${recipe}, ${productionVersionOf(recipe)})`))})
      order by run.topic, run.take`.execute(db)
  ).rows;
  const assetOf = (recipe: ProductionRecipeKey): string => identities.get(recipe)!.assetId;
  const assetIds = recipes.map(assetOf);
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
    const asset = assets.find((row) => row.id === assetOf(recipe));
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
      heldRevision: heldRevisions.has(assetOf(recipe)),
    });
    const check = latest === undefined ? undefined : summariseAnswerChecks(answerChecksOf(latest.outcomes));
    const standing = productionStanding(jobStates, admitted);
    return {
      recipe,
      state:
        // A recipe the plan does not allow, or a stored one retired, can start no take: nothing is sent for it and no request chooses it.
        (!admitted && planRefusalOf(recipe) !== undefined) || identities.get(recipe)?.retired === true
          ? 'stopped'
          : // A revision an earlier production version left held still waits for a decision: no new take piles on it.
            !admitted && heldRevisions.has(assetOf(recipe)) && ['not_started', 'retryable'].includes(standing)
            ? 'held'
            : standing,
      ...(latest === undefined ? {} : { job: standingStateOf(latest) }),
      takes: jobs.length,
      ...(admitted ? { assetId: asset.id, revision: asset.revision } : {}),
      ...(heldRevisions.has(assetOf(recipe))
        ? { assetId: asset?.id ?? assetOf(recipe), heldRevision: heldRevisions.get(assetOf(recipe)) }
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

const ALLOW_ALL: ChooseRecipeOptions = { allow: { code: true, generated: true } };

/** The recipes that teach the facet go first; the planet's others follow in the order they came. */
function facetFirst(recipes: readonly BookRecipe[], facetId: string): readonly BookRecipe[] {
  return [
    ...recipes.filter((recipe) => recipe.facetId === facetId),
    ...recipes.filter((recipe) => recipe.facetId !== facetId),
  ];
}

/**
 * Chooses the library recipe a Create decision commissions for a catalogue brief, and the take to
 * run (D-037): code only, from the recipe book and the recipes' current standing. Read inside the caller's
 * personal transaction; no lock and no write.
 *
 * A code recipe the plan marks v2 is never chosen: its Scroll waits for an operator to read it before anyone is
 * served (D-138), and a person's ask cannot be answered by it. A stored recipe is chosen though its Scroll is held the
 * same way: it exists so that readers always get new content, the operator's read is the one temporary gate, and the
 * Scroll is served once it is released (D-412). The kinds a decision may choose are `options.allow`: each has its own
 * daily cap. When a recipe could be chosen but its kind's cap is used up, the answer is `none` with `capped`.
 */
export async function chooseScrollRecipe(
  scope: PersonalScopeTx,
  brief: CatalogueBrief,
  options: ChooseRecipeOptions = ALLOW_ALL,
): Promise<ScrollRecipeChoice> {
  return chooseScrollRecipeIn(transactionOf(scope), brief, options);
}

/**
 * {@link chooseScrollRecipe} over a database handle or a transaction, for the one caller that has no person: the gap loop's
 * growth commissioning (#674, D-414). It reads only the shared tables, so the rule is the same whoever asks.
 */
export async function chooseScrollRecipeIn(
  db: Queryable,
  brief: CatalogueBrief,
  options: ChooseRecipeOptions = ALLOW_ALL,
): Promise<ScrollRecipeChoice> {
  const book = recipeBookOf(db);
  const aimedFacet =
    brief.facetId === undefined && options.plannedUnit !== undefined
      ? (await book.servingBrief({ topicId: brief.topicId })).find(
          (recipe) => recipe.explanationUnitId === options.plannedUnit,
        )?.facetId
      : undefined;
  const ranked =
    aimedFacet === undefined
      ? await book.servingBrief(brief)
      : facetFirst(await book.servingBrief({ topicId: brief.topicId }), aimedFacet);
  // A code recipe is Create's to make only while it is a v1 Scroll. A stored recipe has a status and is always v2.
  const producible = ranked.filter((recipe) => recipe.status !== undefined || recipe.scrollV2 === undefined);
  const standing = await readLibraryStatus(
    db,
    producible.map((recipe) => recipe.key as ProductionRecipeKey),
  );
  const row = (key: string) => standing.find((entry) => entry.recipe === key);
  const stateOf = (key: string) => row(key)?.state ?? 'stopped';
  const kindOpen = (recipe: BookRecipe) => (recipe.status === undefined ? options.allow.code : options.allow.generated);
  const anyKey = pickRecipeToProduce(
    producible.map((recipe) => recipe.key),
    stateOf,
  );
  if (anyKey === undefined) return { kind: 'none' };
  const key = pickRecipeToProduce(
    producible.filter(kindOpen).map((recipe) => recipe.key),
    stateOf,
  );
  if (key === undefined) return { kind: 'none', capped: true };
  const chosen = row(key);
  const take = chosen === undefined ? undefined : takeToSend(chosen.state, chosen.takes);
  return take === undefined ? { kind: 'none' } : { kind: 'recipe', recipe: key as ProductionRecipeKey, take };
}

/**
 * The standing of one recipe's production and the take a send for it should name, for a waiter
 * deciding whether to keep waiting and for a request that joins work already under way.
 *
 * Nothing a person's ask waits on is coming from a code recipe the plan marks v2 (D-138): the operator's library run
 * makes those, and its Scroll waits for a read. So a group that names one, from before the plan marked it
 * v2, reads as stopped until the Scroll is served: a join never sends its job again, and its waiters
 * close honestly instead of waiting on work Create does not own. A stored recipe is Create's own work, so its standing
 * is read as it is: a waiter keeps waiting while it runs, and stops once its Scroll is held for the operator's read.
 */
export async function readScrollProduction(scope: PersonalScopeTx, recipe: string): Promise<ScrollProductionReading> {
  return readScrollProductionIn(transactionOf(scope), recipe);
}

/** {@link readScrollProduction} over a database handle or a transaction (the gap loop, #674, D-414). */
export async function readScrollProductionIn(db: Queryable, recipe: string): Promise<ScrollProductionReading> {
  const key = parseProductionRecipe(recipe);
  if (key === undefined) return { state: 'stopped' };
  const [standing] = await readLibraryStatus(db, [key]);
  if (standing === undefined) return { state: 'stopped' };
  if (!isGeneratedRecipeKey(key) && scrollV2PlanOf(key) !== undefined && standing.state !== 'published')
    return { state: 'stopped' };
  const take = takeToSend(standing.state, standing.takes);
  return { state: standing.state, ...(take === undefined ? {} : { take }) };
}
