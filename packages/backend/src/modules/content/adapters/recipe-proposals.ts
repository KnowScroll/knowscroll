import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { researchUrl, type ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ContextItem } from '../../../reasoning/public.js';
import type { RecipeStatus } from '../domain/library/generated.js';
import { GENERATED_SCROLL_V2_PLAN } from '../domain/library/generated.js';
import type { AcceptedRecipe } from '../domain/library/recipe-draft.js';
import { evidencePassageCount } from '../production/evidence.js';
import { excerptOf } from '../production/recipe-brief.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/** A page code already holds for a planet: a research page frozen on one of its recipes' production jobs. */
export interface CandidatePage {
  readonly url: string;
  readonly title: string;
  /** How many evidence passages this page gives the writer. */
  readonly passages: number;
  readonly excerpt: string;
}

/** The newest jobs whose frozen research is read for one proposal. A planet has few recipes and each has up to three takes. */
const MAX_JOBS_READ = 12;

/** A frozen page shaped as the job wrote it; anything else is left out. */
function isFrozenPage(value: unknown): value is ResearchPage {
  const page = value as { readonly url?: unknown; readonly title?: unknown; readonly passages?: unknown } | null;
  return (
    typeof page === 'object' &&
    page !== null &&
    typeof page.url === 'string' &&
    typeof page.title === 'string' &&
    Array.isArray(page.passages) &&
    (page.passages as readonly ({ readonly text?: unknown } | null)[]).every(
      (passage) => typeof passage?.text === 'string',
    )
  );
}

/** The existing research URL rule, as a yes or no: https, an allowlisted host, no credentials, port, query or fragment. */
export function researchUrlAllowed(url: string): boolean {
  try {
    researchUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pages code already holds for the recipes of a planet, from the research its production jobs froze: the page's address,
 * its title, how many passages it gives the writer and a short opening. Nothing is fetched here. A page counts once, the first
 * time a newer job holds it, and a page the research rule no longer allows is left out.
 */
export async function readCandidatePages(
  db: Queryable,
  recipeKeys: readonly string[],
): Promise<readonly CandidatePage[]> {
  if (recipeKeys.length === 0) return [];
  const { rows } = await sql<{ research: unknown }>`
    select research from content.scroll_production_runs
    where topic in (${sql.join(recipeKeys)}) and jsonb_array_length(research) > 0
    order by created_at desc, id limit ${MAX_JOBS_READ}`.execute(db);
  const found = new Map<string, CandidatePage>();
  for (const row of rows) {
    if (!Array.isArray(row.research)) continue;
    for (const page of (row.research as unknown[]).filter(isFrozenPage)) {
      if (found.has(page.url) || !researchUrlAllowed(page.url)) continue;
      const opening = page.passages.find((passage) => passage.text.length >= 40)?.text ?? page.passages[0]?.text ?? '';
      found.set(page.url, {
        url: page.url,
        title: page.title,
        passages: evidencePassageCount(page),
        excerpt: excerptOf(opening),
      });
    }
  }
  return [...found.values()];
}

/** Where a proposing run stands: `open` until its recipes are stored or its run is closed as failed. */
export type ProposalState = 'open' | 'completed' | 'failed';

/** A proposing run as `content.recipe_proposals` holds it: where it stands and the context it was first sent. */
export interface Proposal {
  readonly state: ProposalState;
  readonly accepted: number;
  /** The frozen context, or `undefined` when the stored value is not a list of items (never for a row this code wrote). */
  readonly items: readonly ContextItem[] | undefined;
}

const isContextItem = (value: unknown): value is ContextItem => {
  const item = value as { readonly ref?: unknown; readonly kind?: unknown; readonly text?: unknown } | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.ref === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.text === 'string'
  );
};

/**
 * The proposing run of a request, created if it does not exist. The first delivery freezes the context it is about to send; every later
 * delivery gets that row back, so the request it sends is byte for byte the first one and the harness answers from its ledger instead of
 * refusing a request that changed (`request_mismatch`) while a paid answer sits unread. Two deliveries racing to create it agree on the
 * first row to commit.
 */
export async function openProposal(
  db: Queryable,
  run: {
    readonly runId: string;
    readonly topicId: string;
    readonly facetId?: string;
    readonly day: string;
    readonly retry: number;
    readonly items: readonly ContextItem[];
  },
): Promise<Proposal> {
  await sql`insert into content.recipe_proposals (run_id, topic_id, facet_id, day, retry, context)
    values (${run.runId}::uuid, ${run.topicId}, ${run.facetId ?? null}, ${run.day}::date, ${run.retry}, ${JSON.stringify(run.items)}::jsonb)
    on conflict (run_id) do nothing`.execute(db);
  return (await readProposal(db, run.runId))!;
}

/** A proposing run's row, or `undefined`. */
export async function readProposal(db: Queryable, runId: string): Promise<Proposal | undefined> {
  const row = await db
    .selectFrom('content.recipe_proposals')
    .select(['state', 'accepted', 'context'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const context = row.context as unknown;
  return {
    state: row.state as ProposalState,
    accepted: row.accepted,
    items:
      Array.isArray(context) && (context as unknown[]).every(isContextItem) ? (context as ContextItem[]) : undefined,
  };
}

/** Moves a run from `open` to its end, in the transaction that stores its recipes or closes its run. A run that already ended stays as it is. */
export async function settleProposal(
  tx: Transaction<Database>,
  runId: string,
  state: Exclude<ProposalState, 'open'>,
  accepted: number,
): Promise<void> {
  await sql`update content.recipe_proposals set state = ${state}, accepted = ${accepted}, updated_at = now()
    where run_id = ${runId}::uuid and state = 'open'`.execute(tx);
}

/**
 * Serialises the storing of recipes for one planet: every run takes this lock, then reads the recipes that exist and checks its drafts
 * against them, then stores. Two runs or two operators that propose the same angle at once cannot both store it. Held to the end of the
 * caller's transaction. Taken after the production root, before anything else of Content's.
 */
export async function lockPlanetRecipes(tx: Transaction<Database>, topicId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`content.recipes:${topicId}`}, 0))`.execute(tx);
}

/** The keys of the recipes one proposing run made: a redelivery of the same request finds them and pays nothing. */
export async function readRecipesOfRun(db: Queryable, runId: string): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('content.recipes')
    .select('key')
    .where('proposing_run_id', '=', runId)
    .orderBy('key')
    .execute();
  return rows.map((row) => row.key);
}

/**
 * Stores accepted recipes as `checked`, in the caller's transaction. A key already stored is left as it is: the same draft
 * always has the same key, so a repeated proposal adds nothing. Returns the keys this call stored.
 */
export async function storeAcceptedRecipes(
  tx: Transaction<Database>,
  runId: string,
  recipes: readonly AcceptedRecipe[],
): Promise<readonly string[]> {
  const stored: string[] = [];
  for (const recipe of recipes) {
    const inserted = await tx
      .insertInto('content.recipes')
      .values({
        key: recipe.key,
        origin: 'proposal',
        status: 'checked',
        title: recipe.title,
        topic_id: recipe.topicId,
        facet_id: recipe.facetId,
        asset_id: recipe.assetId,
        explanation_unit_id: recipe.explanationUnitId,
        brief: recipe.brief,
        pages: [...recipe.pages],
        scroll_v2: JSON.stringify(GENERATED_SCROLL_V2_PLAN),
        proposing_run_id: runId,
        check_results: JSON.stringify({ pool: recipe.checks.pool, closest: recipe.checks.closest }),
      })
      .onConflict((conflict) => conflict.column('key').doNothing())
      .returning('key')
      .executeTakeFirst();
    if (inserted !== undefined) stored.push(inserted.key);
  }
  return stored;
}

/** One stored recipe as the operator's list shows it: identity, angle, standing and check numbers. Never the brief. */
export interface StoredRecipeListing {
  readonly key: string;
  readonly origin: string;
  readonly status: RecipeStatus;
  readonly title: string;
  readonly topicId: string;
  readonly facetId: string;
  readonly assetId: string;
  readonly pages: number;
  readonly pool: number | null;
  readonly createdAt: string;
}

/** Stored recipes, newest first, optionally of one status. No body text: the list carries no brief and no page address. */
export async function listStoredRecipes(
  db: Queryable,
  options: { readonly status?: RecipeStatus; readonly limit?: number },
): Promise<readonly StoredRecipeListing[]> {
  let query = db
    .selectFrom('content.recipes')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('key')
    .limit(options.limit ?? 200);
  if (options.status !== undefined) query = query.where('status', '=', options.status);
  return (await query.execute()).map((row) => {
    const pool = (row.check_results as { pool?: unknown } | null)?.pool;
    return {
      key: row.key,
      origin: row.origin,
      status: row.status as RecipeStatus,
      title: row.title,
      topicId: row.topic_id,
      facetId: row.facet_id,
      assetId: row.asset_id,
      pages: row.pages.length,
      pool: typeof pool === 'number' ? pool : null,
      createdAt: row.created_at.toISOString(),
    };
  });
}
