import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import {
  readCandidatePages,
  readRecipesOfRun,
  researchUrlAllowed,
  storeAcceptedRecipes,
} from '../adapters/recipe-proposals.js';
import { recipeBookOf } from '../adapters/stored-recipes.js';
import { CONCEPTS } from '../domain/concepts.js';
import { generatedKeyOf, type BookRecipe } from '../domain/library/generated.js';
import {
  checkRecipeDraft,
  type AcceptedRecipe,
  type DraftRefusal,
  type RecipeBriefOutput,
} from '../domain/library/recipe-draft.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import {
  RECIPE_BRIEF_REQUEST_BOUND,
  RECIPE_BRIEF_ROLE_VERSION,
  recipeBriefContext,
  recipeBriefRequestKey,
  recipeBriefRole,
  utcDayOf,
  type RecipeBriefFacts,
} from './recipe-brief.js';

export interface ProposeRecipesDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  /** The clock: the UTC day is part of what makes a request the same request. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** What an operator asks: a planet and, optionally, the facet to cover. */
export interface ProposeRecipesRequest {
  readonly topicId: string;
  readonly facetId?: string;
  readonly dryRun: boolean;
}

/** How many drafts each check refused, by its code. */
export type RefusalCounts = Readonly<Partial<Record<DraftRefusal, number>>>;

export type ProposeRecipesResult =
  /** Nothing was sent and nothing was stored: the request names no planet or facet of the catalogue, or code holds no page for the planet. */
  | { readonly kind: 'refused'; readonly reason: 'topic_unknown' | 'facet_unknown' | 'no_candidate_pages' }
  /** The context a run would send, in counts. Nothing was sent. */
  | {
      readonly kind: 'dry_run';
      readonly runId: string;
      readonly contextItems: number;
      readonly candidatePages: number;
      readonly existingRecipes: number;
      readonly requestBound: number;
    }
  /** An earlier delivery of this very request already stored its recipes (or finished with none): nothing was paid again. */
  | { readonly kind: 'already_proposed'; readonly runId: string; readonly recipes: readonly string[] }
  | {
      readonly kind: 'proposed';
      readonly runId: string;
      readonly repaired: boolean;
      readonly drafts: number;
      readonly accepted: readonly {
        readonly key: string;
        readonly facetId: string;
        readonly title: string;
        readonly pool: number;
      }[];
      readonly refused: RefusalCounts;
      readonly requestBound: number;
    }
  /** A daily budget or the provider's quota is used up: nothing was sent and the run stays open for a later send. */
  | { readonly kind: 'paused'; readonly runId: string; readonly code: string }
  /**
   * The model gave no usable answer. `unknown` may have reached the provider: the run stays open and is never resent.
   * Any other code closes the run.
   */
  | { readonly kind: 'failed'; readonly runId: string; readonly code: string; readonly unknown: boolean };

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The facts the model is told, read by code from the library and the pages it already holds. */
async function factsOf(
  db: Kysely<Database>,
  request: Pick<ProposeRecipesRequest, 'topicId' | 'facetId'>,
): Promise<{ readonly facts: RecipeBriefFacts } | ProposeRecipesResult> {
  const topic = CONCEPTS.find((concept) => concept.id === request.topicId && concept.parent !== null);
  if (topic === undefined) return { kind: 'refused', reason: 'topic_unknown' };
  if (request.facetId !== undefined && !topic.facets.some((facet) => facet.id === request.facetId))
    return { kind: 'refused', reason: 'facet_unknown' };
  const planet = (await recipeBookOf(db).servingBrief({ topicId: topic.id })).filter(
    (recipe) => recipe.status !== 'retired',
  );
  const candidates = await readCandidatePages(
    db,
    planet.map((recipe) => recipe.key),
  );
  if (candidates.length === 0) return { kind: 'refused', reason: 'no_candidate_pages' };
  return {
    facts: {
      topicId: topic.id,
      meaning: topic.meaning,
      facets: topic.facets.map((facet) => ({
        id: facet.id,
        meaning: facet.meaning,
        recipes: planet.filter((recipe) => recipe.facetId === facet.id).length,
      })),
      ...(request.facetId === undefined ? {} : { targetFacetId: request.facetId }),
      existing: planet.map((recipe) => ({ facetId: recipe.facetId, title: recipe.title, brief: recipe.brief })),
      candidates,
    },
  };
}

/** Runs every draft through the checks, each against what exists and what was accepted before it in the same batch. */
function decideDrafts(
  output: RecipeBriefOutput,
  facts: RecipeBriefFacts,
  taken: readonly BookRecipe[],
  requestedFacetId: string | undefined,
): { readonly accepted: readonly AcceptedRecipe[]; readonly refused: RefusalCounts } {
  const accepted: AcceptedRecipe[] = [];
  const refused: Partial<Record<DraftRefusal, number>> = {};
  const existing = taken
    .filter((recipe) => recipe.topicId === facts.topicId)
    .map((recipe) => ({ title: recipe.title, brief: recipe.brief }));
  const keys = new Set(taken.map((recipe) => recipe.key));
  const unitIds = new Set(taken.map((recipe) => recipe.explanationUnitId));
  const assetIds = new Set(taken.map((recipe) => recipe.assetId));
  for (const draft of output.drafts) {
    const key = generatedKeyOf({ topicId: facts.topicId, facetId: draft.facetId, title: draft.title }, sha256Hex);
    const verdict = checkRecipeDraft(draft, {
      topicId: facts.topicId,
      facetIds: facts.facets.map((facet) => facet.id),
      ...(requestedFacetId === undefined ? {} : { requestedFacetId }),
      candidates: facts.candidates,
      urlAllowed: researchUrlAllowed,
      existing,
      taken: { keys, unitIds, assetIds },
      identity: { key, assetId: stableUuid(`content.recipe-asset:${key}`) },
    });
    if (verdict.kind === 'refused') {
      refused[verdict.code] = (refused[verdict.code] ?? 0) + 1;
      continue;
    }
    accepted.push(verdict.recipe);
    existing.push({ title: verdict.recipe.title, brief: verdict.recipe.brief });
    keys.add(verdict.recipe.key);
    unitIds.add(verdict.recipe.explanationUnitId);
    assetIds.add(verdict.recipe.assetId);
  }
  return { accepted, refused };
}

/** What a request would send: the facts, the frozen context and the run it would use; or why nothing can be proposed. */
async function prepareProposal(
  db: Kysely<Database>,
  request: Pick<ProposeRecipesRequest, 'topicId' | 'facetId'>,
  now: Date,
) {
  const read = await factsOf(db, request);
  if ('kind' in read) return read;
  const key = recipeBriefRequestKey({
    topicId: request.topicId,
    ...(request.facetId === undefined ? {} : { facetId: request.facetId }),
    day: utcDayOf(now),
  });
  return { facts: read.facts, items: recipeBriefContext(read.facts), runId: stableUuid(`content.recipe-brief:${key}`) };
}

/**
 * What a proposal would send, in counts, without calling a provider or storing anything: the operator's `--dry-run`. Reads the
 * shared database only, so it needs no model and no production grant.
 */
export async function previewRecipeProposal(
  db: Kysely<Database>,
  request: Pick<ProposeRecipesRequest, 'topicId' | 'facetId'>,
  now: () => Date = () => new Date(),
): Promise<Extract<ProposeRecipesResult, { kind: 'refused' | 'dry_run' }>> {
  const prepared = await prepareProposal(db, request, now());
  if ('kind' in prepared) return prepared as Extract<ProposeRecipesResult, { kind: 'refused' }>;
  return {
    kind: 'dry_run',
    runId: prepared.runId,
    contextItems: prepared.items.length,
    candidatePages: prepared.facts.candidates.length,
    existingRecipes: prepared.facts.existing.length,
    requestBound: RECIPE_BRIEF_REQUEST_BOUND,
  };
}

/**
 * Proposes recipes for a planet that already exists (#674, D-412): the model drafts, code decides.
 *
 * One request of the brief role, and at most one repair, on the production harness and its attempt ledger, so every paid
 * attempt is recorded and counted against the production caps. The run id is derived from the request (planet, facet, UTC day and
 * role version), never from what the request goes on to store: asking for the same thing again reaches the same run, so a redelivery
 * after a crash is answered from the ledger (or finds the recipes already stored) and never pays twice, and an attempt of unknown
 * outcome is never resent. Another day, or another facet, is a new request. No network wait or model call
 * holds a transaction: the recipes are stored, and the run closed, in one short production transaction after the answer.
 *
 * Code accepts a draft only if its shape and lengths match the library rules, each page is one of the pages code holds and
 * passes the research URL rule, the pages' passage pool is in the source checker's range, it is not a near-duplicate of a
 * recipe of the planet, and its derived identity is unique. A refusal is a code; nothing the model wrote is kept.
 * Nothing here chooses a topic or a facet that the catalogue lacks, and nothing here sends a production job.
 */
export function makeProposeRecipes(deps: ProposeRecipesDependencies) {
  return async function proposeRecipes(
    request: ProposeRecipesRequest,
    signal: AbortSignal,
  ): Promise<ProposeRecipesResult> {
    const now = deps.now ?? (() => new Date());
    if (request.dryRun) return previewRecipeProposal(deps.db, request, now);
    const prepared = await prepareProposal(deps.db, request, now());
    if ('kind' in prepared) return prepared;
    const { facts, items, runId } = prepared;
    const earlier = await readRecipesOfRun(deps.db, runId);
    if (earlier.length > 0) return { kind: 'already_proposed', runId, recipes: earlier };

    const outcome = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'recipe-brief',
          policyVersion: RECIPE_BRIEF_ROLE_VERSION,
        },
        role: recipeBriefRole(),
        context: { bundleRef: `recipes:${facts.topicId}:${runId.slice(0, 8)}`, items },
      },
      signal,
    );
    if (outcome.kind === 'refused' && outcome.reason === 'run_closed')
      return { kind: 'already_proposed', runId, recipes: await readRecipesOfRun(deps.db, runId) };
    if (outcome.kind === 'budget_exhausted' || outcome.kind === 'quota_unavailable')
      return { kind: 'paused', runId, code: pauseCode(outcome) };
    if (outcome.kind !== 'proposed') {
      const unknown = outcome.kind === 'unknown';
      // An attempt that may have reached the provider keeps its run open: nothing resends it.
      if (!unknown)
        await deps.withScope(deps.authority, (scope) =>
          deps.harness.closeProductionRun(scope, { runId, state: 'failed' }),
        );
      return { kind: 'failed', runId, code: uncheckedCode(outcome), unknown };
    }
    const { accepted, refused } = decideDrafts(
      outcome.output,
      facts,
      await recipeBookOf(deps.db).all(),
      request.facetId,
    );
    await deps.withScope(deps.authority, async (scope) => {
      await storeAcceptedRecipes(productionTransactionOf(scope), runId, accepted);
      await deps.harness.closeProductionRun(scope, { runId, state: 'completed' });
    });
    return {
      kind: 'proposed',
      runId,
      repaired: outcome.repaired,
      drafts: outcome.output.drafts.length,
      accepted: accepted.map((recipe) => ({
        key: recipe.key,
        facetId: recipe.facetId,
        title: recipe.title,
        pool: recipe.checks.pool,
      })),
      refused,
      requestBound: RECIPE_BRIEF_REQUEST_BOUND,
    };
  };
}
