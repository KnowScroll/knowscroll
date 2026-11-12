import {
  GAPS_PER_PASS,
  afterProposal,
  decideGapStep,
  growthRoom,
  mayPropose,
  type RecipeFact,
} from '../domain/gaps.js';
import { commissionGrowth, startOfUtcDay } from './growth.js';
import { utcDay } from './gap-signals.js';
import type { BriefGaps, GapBriefPorts, GapBriefResult, GapRow } from './gap-ports.js';

/** How many gaps whose production was sent a pass looks at to send a lost job again. */
const RESUME_LIMIT = 10;
/** How many gaps a pass reads to find the ones it can work on (the rest are for the next pass). */
const READ_LIMIT = 25;

const targetOf = (gap: GapRow) => ({ topicId: gap.planet, ...(gap.facet === undefined ? {} : { facetId: gap.facet }) });
const factsOf = (recipes: Awaited<ReturnType<GapBriefPorts['readGapRecipes']>>): readonly RecipeFact[] =>
  recipes.map((recipe) => ({
    key: recipe.key,
    stored: recipe.stored,
    facetId: recipe.facetId,
    state: recipe.state,
    ...(recipe.take === undefined ? {} : { take: recipe.take }),
  }));

/**
 * One pass of the brief job (#674, D-414, `supply.brief-gap`, background class): takes the most pressing open gaps, within the
 * growth cap, asks for recipes through the same path `content propose-recipes` uses, records the outcome on the gap and commissions
 * production of what was accepted through Create's decision with no person ({@link commissionGrowth}). Every Scroll it makes is
 * held by the operator's review gate like any v2 library Scroll; nothing is served until it is released.
 *
 * For each gap, in priority order and at most {@link GAPS_PER_PASS} of them, at most one for a planet:
 * - the hole is already being filled (recipes running or held for a read): it is noted as commissioned and nothing is spent;
 * - stored recipes wait to be produced: they are commissioned with no model call;
 * - otherwise the brief role is asked, once (and its one repair) on an identity the gap pins (planet, facet, the attempt's UTC day
 *   and which attempt), so a redelivery answers from the ledger and never pays twice. An attempt of unknown outcome blocks the gap
 *   and is never resent; the second failed attempt rejects it with the reason code.
 * Proposing needs room: the growth cap must not be used up, and the day's proposing attempts stay below the cap, so a run of failures
 * cannot spend model budget the cap never meets. Group commissioning happens under the cap too, in its own short transaction, and
 * the production job is sent after it commits; a pass also sends again the job of any gap it commissioned earlier, so a job lost
 * between the commit and the send is never lost for good (one job for each recipe, version and take).
 *
 * Failure and retry: a stopped worker or a redelivery repeats a pass without harm, and two passes never overlap: the pass holds a session advisory
 * lock (`GapBriefLock`), so a second one does nothing. No model call or network wait holds a transaction.
 */
export function makeBriefGaps(p: GapBriefPorts): BriefGaps {
  const pass = async (signal: AbortSignal): Promise<GapBriefResult> => {
    const counts = { proposed: 0, commissioned: 0, waiting: 0, failed: 0, rejected: 0, blocked: 0 };
    let paused = false;
    const now = p.now();
    const since = startOfUtcDay(now);

    /** Commissions what the gap's stored recipes allow, sends the jobs, and records it. */
    const commissionRecipes = async (gap: GapRow, recipes: readonly RecipeFact[]): Promise<void> => {
      const commissioned: string[] = [];
      for (const recipe of recipes) {
        if (signal.aborted) break;
        const outcome = await commissionGrowth(p, { topicId: gap.planet, facetId: recipe.facetId });
        if (outcome.kind === 'capped') break;
        if (outcome.kind === 'commissioned') {
          await p.enqueueProduction(outcome.recipe, outcome.take);
          commissioned.push(outcome.recipe);
          counts.commissioned += 1;
        } else if (outcome.kind === 'joined' && outcome.recipe !== undefined) {
          // Production for this brief is already under way: send its job again so a lost one resumes.
          if (outcome.take !== undefined) await p.enqueueProduction(outcome.recipe, outcome.take);
          commissioned.push(outcome.recipe);
        }
      }
      if (commissioned.length > 0) await p.store.commission(gap.id, commissioned, p.now());
    };

    // Send again the production of gaps already commissioned: a job lost between the commit and the send resumes.
    for (const gap of await p.store.commissioned(RESUME_LIMIT)) {
      if (signal.aborted) break;
      const recipes = await p.readGapRecipes(targetOf(gap));
      for (const recipe of recipes)
        if (
          recipe.stored &&
          gap.recipes.includes(recipe.key) &&
          recipe.take !== undefined &&
          (recipe.state === 'not_started' || recipe.state === 'running')
        )
          await p.enqueueProduction(recipe.key, recipe.take);
    }

    const planets = new Set<string>();
    let worked = 0;
    for (const gap of await p.store.actionable(READ_LIMIT)) {
      if (signal.aborted || paused || worked >= GAPS_PER_PASS) break;
      if (planets.has(gap.planet)) continue;
      const step = decideGapStep(gap, factsOf(await p.readGapRecipes(targetOf(gap))));
      if (step.kind === 'wait') {
        await p.store.commission(gap.id, step.recipes, p.now());
        counts.waiting += 1;
        continue;
      }
      const startedToday = await p.growth.countGrowthSince(since);
      if (growthRoom(p.growthDailyCap, startedToday) === 0) break;
      planets.add(gap.planet);
      if (step.kind === 'commission') {
        await commissionRecipes(gap, step.recipes);
        worked += 1;
        continue;
      }
      // Nothing is in the pipeline and nothing waits to be produced: ask the brief role, if the day's budget allows another attempt.
      if (!mayPropose(p.growthDailyCap, startedToday, await p.store.attemptedSince(since))) break;
      const day = await p.store.beginAttempt(gap.id, utcDay(now), now);
      if (day === undefined) continue;
      const result = await p.propose({ ...targetOf(gap), retry: gap.attempts, day }, signal);
      const transition = afterProposal(gap, result);
      await p.store.settle(gap.id, transition, p.now());
      // A refusal that costs nothing (a planet that holds no page) is not an attempt and does not use the pass up.
      if (transition.kind === 'refused') {
        counts.rejected += 1;
        planets.delete(gap.planet);
        continue;
      }
      counts.proposed += 1;
      worked += 1;
      if (transition.kind === 'keep') paused = true;
      else if (transition.kind === 'failed') counts.failed += 1;
      else if (transition.kind === 'rejected') counts.rejected += 1;
      else if (transition.kind === 'blocked') counts.blocked += 1;
      else if (!signal.aborted) {
        // The recipes are stored: commission them now, under the cap, with no further model call.
        const stored = factsOf(await p.readGapRecipes(targetOf(gap))).filter((recipe) =>
          transition.recipes.includes(recipe.key),
        );
        const next = decideGapStep(gap, stored);
        if (next.kind === 'commission') await commissionRecipes(gap, next.recipes);
      }
    }
    return { kind: 'done', ...counts, paused };
  };
  return async (signal) => {
    if (!p.enabled || p.growthDailyCap <= 0) return { kind: 'disabled' };
    // One pass at a time: a second one (another process, a redelivery that outlived its claim) finds the lock held and does nothing.
    return (await p.lock.exclusively(() => pass(signal))) ?? { kind: 'busy' };
  };
}
