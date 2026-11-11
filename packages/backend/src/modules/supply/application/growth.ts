import { growthRoom } from '../domain/gaps.js';
import type { GapBriefPorts, GrowthOutcome } from './gap-ports.js';
import type { CanonicalBrief } from './ports.js';

const UTC_DAY_MS = 86_400_000;

/** The catalogue brief a growth group serves: the planet, a facet when the recipe has one, a Scroll in English. */
export function growthBrief(target: { readonly topicId: string; readonly facetId?: string }): CanonicalBrief {
  return {
    version: 'supply-brief.v1',
    rights: 'shared_admitted',
    language: 'en',
    format: 'scroll',
    subject: {
      kind: 'catalogue',
      catalogueVersion: 'content-concepts.v1',
      topicId: target.topicId,
      ...(target.facetId === undefined ? {} : { facetId: target.facetId }),
    },
  };
}

/** The start of the UTC day of a moment: what the growth cap counts from. */
export const startOfUtcDay = (when: Date): Date => new Date(Math.floor(when.getTime() / UTC_DAY_MS) * UTC_DAY_MS);

/**
 * Create's decision for one catalogue brief, for the loop (#674, D-414): the same steps as Quartermaster's Create with no person.
 * One transaction takes the commissioning lock (as Create does, so the day's count and the groups agree), joins production
 * already under way for exactly this brief or closes a group that ended, refuses when the day's growth cap is used up, lets the
 * chooser pick a stored recipe (never a recipe of the library plan: those are the operator's), and commits the group. The
 * production job is sent by the caller after the commit, so the group and the job are never one transaction; a job lost between
 * them is sent again by the next pass, one job for each recipe, version and take.
 *
 * Only stored recipes count against the growth cap and only they are chosen: a person's and the Planner's caps are never touched.
 * No model call or network wait happens here.
 */
export async function commissionGrowth(
  p: Pick<GapBriefPorts, 'growth' | 'growthDailyCap' | 'newId' | 'now'>,
  target: { readonly topicId: string; readonly facetId?: string },
): Promise<GrowthOutcome> {
  if (p.growthDailyCap <= 0) return { kind: 'capped' };
  const brief = growthBrief(target);
  return p.growth.inCommissioning(async (tx) => {
    const running = await tx.findActiveWork(brief);
    if (running) {
      // Join only work that can still deliver; a group whose production ended is closed and the brief starts afresh.
      const standing =
        running.recipe === undefined
          ? undefined
          : (await tx.readRecipes(target)).find((recipe) => recipe.key === running.recipe);
      if (
        running.recipe !== undefined &&
        standing?.take !== undefined &&
        (standing.state === 'not_started' || standing.state === 'running')
      )
        return { kind: 'joined', recipe: running.recipe, take: standing.take };
      if (standing?.state === 'held' || standing?.state === 'published') return { kind: 'joined' };
      await tx.closeWork(running.id);
    }
    const startedToday = await tx.countGrowthSince(startOfUtcDay(p.now()));
    if (growthRoom(p.growthDailyCap, startedToday) === 0) return { kind: 'capped' };
    const choice = await tx.chooseRecipe(target, { allow: { code: false, generated: true } });
    if (choice.kind === 'none') return choice.capped === true ? { kind: 'capped' } : { kind: 'none' };
    const work = await tx.joinOrCreate(brief, p.newId(), choice.recipe);
    if (work.joined) return { kind: 'joined' };
    return { kind: 'commissioned', recipe: choice.recipe, take: choice.take };
  });
}
