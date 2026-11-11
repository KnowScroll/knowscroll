import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import {
  lockPlanetRecipes,
  openProposal,
  readCandidatePages,
  readProposal,
  readRecipesOfRun,
  researchUrlAllowed,
  settleProposal,
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
  MAX_PROPOSAL_RETRY,
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

/** What an operator asks: a planet, optionally the facet to cover, and which try of that request this is (0, or 1 and 2 after a run that ended without recipes). */
export interface ProposeRecipesRequest {
  readonly topicId: string;
  readonly facetId?: string;
  readonly retry?: number;
  readonly dryRun: boolean;
}

/** How many drafts each check refused, by its code. */
export type RefusalCounts = Readonly<Partial<Record<DraftRefusal, number>>>;

export type ProposeRecipesResult =
  /**
   * Nothing was sent and nothing was stored: the request names no planet or facet of the catalogue, a retry out of range, or code holds no
   * page for the planet.
   */
  | {
      readonly kind: 'refused';
      readonly reason: 'topic_unknown' | 'facet_unknown' | 'retry_out_of_range' | 'no_candidate_pages';
    }
  /** The context a run would send, in counts. Nothing was sent. */
  | {
      readonly kind: 'dry_run';
      readonly runId: string;
      readonly contextItems: number;
      readonly candidatePages: number;
      readonly existingRecipes: number;
      readonly requestBound: number;
    }
  /** An earlier delivery of this very request already stored its recipes: nothing was paid again. */
  | { readonly kind: 'already_proposed'; readonly runId: string; readonly recipes: readonly string[] }
  /**
   * This request's run is closed and stored nothing: it ended as failed, it was answered with nothing code accepted, or another delivery
   * closed it. Nothing is sent. `nextRetry` is the number to ask again with the same day (`--retry`), absent when the retries are used.
   */
  | {
      readonly kind: 'closed_failed';
      readonly runId: string;
      readonly reason: 'failed' | 'nothing_accepted' | 'closed';
      readonly retry: number;
      readonly nextRetry?: number;
    }
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
   * The model gave no usable answer, or the answer could not be applied. `closed` says whether the run ended: a conclusive failure ends it
   * and `nextRetry` is the number to ask again with. An attempt of unknown outcome, a refusal of the harness or a scope that refused leave
   * it open, and nothing is ever resent.
   */
  | {
      readonly kind: 'failed';
      readonly runId: string;
      readonly code: string;
      readonly unknown: boolean;
      readonly closed: boolean;
      readonly nextRetry?: number;
    };

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * What a run's outcome does to its run, following the production job's convention. A kept answer closes it as completed. A conclusive
 * failure (an answer the harness found invalid after its one repair, or a provider that conclusively refused) closes it as failed, because
 * the attempt is settled and another run can be asked for. Everything else leaves it open: an attempt of unknown outcome is never resent,
 * a refusal of the harness may have reached the provider, and a spent budget or quota only pauses.
 */
export function settlementOf(outcome: ProposeOutcome<unknown>): 'completed' | 'failed' | 'open' {
  switch (outcome.kind) {
    case 'proposed':
      return 'completed';
    case 'invalid_output':
    case 'failed':
      return 'failed';
    case 'unknown':
    case 'refused':
    case 'budget_exhausted':
    case 'quota_unavailable':
      return 'open';
  }
}

/** The facts the model is told, read by code from the library and the pages it already holds. */
async function factsOf(
  db: Kysely<Database>,
  request: Pick<ProposeRecipesRequest, 'topicId' | 'facetId'>,
): Promise<{ readonly facts: RecipeBriefFacts } | Extract<ProposeRecipesResult, { kind: 'refused' }>> {
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

/**
 * Runs every draft through the checks, each against what exists and what was accepted before it in the same batch. `taken` is every
 * recipe of the library as the caller just read it; the planet's own are what the near-duplicate checks compare against, with the facet
 * and the pages each rests on.
 */
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
    .map((recipe) => ({
      title: recipe.title,
      brief: recipe.brief,
      facetId: recipe.facetId,
      pages: recipe.pages,
    }));
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
    existing.push({
      title: verdict.recipe.title,
      brief: verdict.recipe.brief,
      facetId: verdict.recipe.facetId,
      pages: verdict.recipe.pages,
    });
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
  retry: number,
  now: Date,
) {
  const read = await factsOf(db, request);
  if ('kind' in read) return read;
  const day = utcDayOf(now);
  const key = recipeBriefRequestKey({
    topicId: request.topicId,
    ...(request.facetId === undefined ? {} : { facetId: request.facetId }),
    day,
    retry,
  });
  return {
    facts: read.facts,
    items: recipeBriefContext(read.facts),
    runId: stableUuid(`content.recipe-brief:${key}`),
    day,
  };
}

const validRetry = (retry: number | undefined): retry is number | undefined =>
  retry === undefined || (Number.isInteger(retry) && retry >= 0 && retry <= MAX_PROPOSAL_RETRY);

/**
 * What a proposal would send, in counts, without calling a provider or storing anything: the operator's `--dry-run`. Reads the
 * shared database only, so it needs no model and no production grant.
 */
export async function previewRecipeProposal(
  db: Kysely<Database>,
  request: Pick<ProposeRecipesRequest, 'topicId' | 'facetId' | 'retry'>,
  now: () => Date = () => new Date(),
): Promise<Extract<ProposeRecipesResult, { kind: 'refused' | 'dry_run' }>> {
  if (!validRetry(request.retry)) return { kind: 'refused', reason: 'retry_out_of_range' };
  const prepared = await prepareProposal(db, request, request.retry ?? 0, now());
  if ('kind' in prepared) return prepared;
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
 * attempt is recorded and counted against the production caps. The run id is derived from the request (planet, facet, UTC day, retry
 * number and role version), never from what the request goes on to store, and the first delivery freezes the context it sends in
 * `content.recipe_proposals`: a later delivery sends that same context, so the harness answers from its ledger even when other recipes
 * have been stored since, and a paid answer that was kept is never refused as a changed request. An attempt of unknown outcome is never
 * resent and keeps its run open. A run that ended without recipes can be asked for again the same day with the next retry number, at most
 * twice.
 *
 * No network wait or model call holds a transaction. After the answer, one short production transaction takes the planet's advisory lock,
 * reads the recipes that exist now, checks every draft against them (so what is stored is judged against today's library, not the
 * library the request was sent against), stores what passes, closes the proposing run and its harness run. Two runs or operators that
 * propose the same angle at once are serialised by that lock, and the second finds the first.
 *
 * Code accepts a draft only if its shape and lengths match the library rules, neither field carries an address or markup, each page is
 * one of the pages code holds and passes the research URL rule, the pages' passage pool is in the source checker's range, it is not a
 * near-duplicate of a recipe of the planet (the same words, or the same facet on the same pages in other words), and its derived
 * identity is unique. A refusal is a code; nothing the model wrote is kept. Nothing here chooses a topic or a facet that the
 * catalogue lacks, and nothing here sends a production job.
 */
export function makeProposeRecipes(deps: ProposeRecipesDependencies) {
  const closedFailed = (
    runId: string,
    reason: 'failed' | 'nothing_accepted' | 'closed',
    retry: number,
  ): ProposeRecipesResult => ({
    kind: 'closed_failed',
    runId,
    reason,
    retry,
    ...(retry < MAX_PROPOSAL_RETRY ? { nextRetry: retry + 1 } : {}),
  });

  /** A run that has ended: its recipes if it stored any, else the fact that it stored nothing. */
  async function endedRun(runId: string, state: 'completed' | 'failed' | 'open', retry: number) {
    const recipes = await readRecipesOfRun(deps.db, runId);
    if (recipes.length > 0) return { kind: 'already_proposed', runId, recipes } as const;
    return closedFailed(
      runId,
      state === 'failed' ? 'failed' : state === 'completed' ? 'nothing_accepted' : 'closed',
      retry,
    );
  }

  /** Checks the answer against the library as it is now and stores what passes, with the run closed, in one transaction. */
  async function storeAnswer(
    runId: string,
    facts: RecipeBriefFacts,
    request: ProposeRecipesRequest,
    outcome: Extract<ProposeOutcome<RecipeBriefOutput>, { kind: 'proposed' }>,
  ): Promise<ProposeRecipesResult> {
    const stored = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      await lockPlanetRecipes(tx, facts.topicId);
      const decided = decideDrafts(outcome.output, facts, await recipeBookOf(tx).all(), request.facetId);
      await storeAcceptedRecipes(tx, runId, decided.accepted);
      await settleProposal(tx, runId, 'completed', decided.accepted.length);
      await deps.harness.closeProductionRun(scope, { runId, state: 'completed' });
      return decided;
    });
    // A scope that was switched off or changed stores nothing and closes nothing: the run stays open for a later delivery.
    if (stored.kind !== 'entered')
      return { kind: 'failed', runId, code: 'scope_refused', unknown: false, closed: false };
    return {
      kind: 'proposed',
      runId,
      repaired: outcome.repaired,
      drafts: outcome.output.drafts.length,
      accepted: stored.value.accepted.map((recipe) => ({
        key: recipe.key,
        facetId: recipe.facetId,
        title: recipe.title,
        pool: recipe.checks.pool,
      })),
      refused: stored.value.refused,
      requestBound: RECIPE_BRIEF_REQUEST_BOUND,
    };
  }

  /** Ends a run after a conclusive failure: the proposing run and the harness run close as failed, together. */
  async function closeFailed(runId: string): Promise<boolean> {
    const closed = await deps.withScope(deps.authority, async (scope) => {
      await settleProposal(productionTransactionOf(scope), runId, 'failed', 0);
      await deps.harness.closeProductionRun(scope, { runId, state: 'failed' });
    });
    return closed.kind === 'entered';
  }

  return async function proposeRecipes(
    request: ProposeRecipesRequest,
    signal: AbortSignal,
  ): Promise<ProposeRecipesResult> {
    if (!validRetry(request.retry)) return { kind: 'refused', reason: 'retry_out_of_range' };
    const retry = request.retry ?? 0;
    const now = deps.now ?? (() => new Date());
    if (request.dryRun) return previewRecipeProposal(deps.db, request, now);
    const prepared = await prepareProposal(deps.db, request, retry, now());
    if ('kind' in prepared) return prepared;
    const { facts, runId } = prepared;
    // The first delivery freezes its context; every later one sends that very context, whatever the library holds by then.
    const proposal = await openProposal(deps.db, {
      runId,
      topicId: facts.topicId,
      ...(request.facetId === undefined ? {} : { facetId: request.facetId }),
      day: prepared.day,
      retry,
      items: prepared.items,
    });
    if (proposal.state !== 'open') return endedRun(runId, proposal.state, retry);
    const items: readonly ContextItem[] | undefined = proposal.items;
    if (items === undefined)
      return { kind: 'failed', runId, code: 'frozen_context_unreadable', unknown: false, closed: false };

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
    // Another delivery closed the run while this one waited: read how it ended.
    if (outcome.kind === 'refused' && outcome.reason === 'run_closed') {
      const ended = await readProposal(deps.db, runId);
      return endedRun(runId, ended?.state ?? 'open', retry);
    }
    if (outcome.kind === 'budget_exhausted' || outcome.kind === 'quota_unavailable')
      return { kind: 'paused', runId, code: pauseCode(outcome) };
    if (outcome.kind === 'proposed') return storeAnswer(runId, facts, request, outcome);
    const code = uncheckedCode(outcome);
    if (settlementOf(outcome) === 'open')
      return { kind: 'failed', runId, code, unknown: outcome.kind === 'unknown', closed: false };
    const closed = await closeFailed(runId);
    return {
      kind: 'failed',
      runId,
      code: closed ? code : 'scope_refused',
      unknown: false,
      closed,
      ...(closed && retry < MAX_PROPOSAL_RETRY ? { nextRetry: retry + 1 } : {}),
    };
  };
}
