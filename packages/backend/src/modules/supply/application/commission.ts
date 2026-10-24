import type { ScrollProductionState } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CanonicalBrief, CommissionOrigin, SupplyPorts, UnavailableReason } from './ports.js';

/** How often a waiter looks again while the production that serves it is unfinished. */
export const WAIT_POLL_MS = 20_000;
/**
 * How long a waiter waits for production before closing as `could_not_prepare`. A writer call takes
 * minutes and operator seeding may queue ahead of a request, but a person should not wait for ever.
 * The shared work carries on and a later request Reuses what it produces.
 */
export const WAIT_LIMIT_MS = 30 * 60_000;

/** How many asks a person may have open at once; each one is polled by its own jobs until it ends. */
export const MAX_OPEN_REQUESTS = 10;

export type Commission =
  /** The request waits on a shared group, one this transaction started (`create`) or one already running (`join`). */
  | { readonly kind: 'waiting'; readonly workId: string; readonly decision: 'join' | 'create' }
  /** Nothing can produce it: the request closes now with an honest reason. */
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

const UTC_DAY_MS = 86_400_000;

/**
 * Quartermaster's Join and Create for a brief that Reuse could not serve (blueprint §11, D-037).
 * Join first: an active group for exactly this brief that is still producing already has work behind
 * it, whoever started it. Joining also sends the group's production job again, idempotently (the
 * queue holds one job per recipe, version and take while one is queued or running), so work that a
 * pause, a recipe-version change or a dead letter left without a job resumes instead of leaving the
 * joiner to time out. Otherwise Create: code picks the library recipe that serves the brief, the day's
 * cap for the asker's origin is checked, and the group and the recipe's production job commit with
 * the caller's transaction, so a rollback removes both. The job ID is stable per recipe, version and
 * take, so two groups that choose the same recipe share one job. Only a Scroll can be produced, and
 * only for a catalogue meaning: a Reel, or a variant of an existing explanation, has no production
 * path and closes as `budget_unavailable`.
 *
 * `origin` names who asks: a person's own request, or the Planner's demand. Each has its own daily
 * cap, and the Planner's is never above the person's, so the Planner cannot starve an explicit ask.
 *
 * Authority: runs inside the caller's open personal scope. Lock order: the personal root, the owned
 * demand and Content's locks come first; the commissioning lock follows, then the shared group row.
 * No model call or network wait happens here: production runs later in a worker.
 */
export async function commissionSupply(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  brief: CanonicalBrief,
  origin: CommissionOrigin,
): Promise<Commission> {
  const { subject } = brief;
  if (subject.kind !== 'catalogue' || brief.format === 'reel')
    return { kind: 'unavailable', reason: 'budget_unavailable' };
  await p.store.lockCommissioning(scope);
  const running = await p.store.findActiveWork(scope, brief);
  if (running) {
    // Join only work that can still deliver. A group whose production ended has nothing left to
    // wait for, so it is closed and the request starts afresh (another recipe, or an honest refusal).
    const reading = running.recipe === undefined ? undefined : await p.readProduction(scope, running.recipe);
    if (running.recipe !== undefined && reading?.take !== undefined && isComing(reading.state)) {
      await p.enqueueProduction(scope, running.recipe, reading.take);
      return { kind: 'waiting', workId: running.id, decision: 'join' };
    }
    await p.store.closeWork(scope, running.id);
  }
  const startOfDay = new Date(Math.floor(p.now().getTime() / UTC_DAY_MS) * UTC_DAY_MS);
  if ((await p.store.countCommissionedSince(scope, startOfDay, origin)) >= p.createDailyCaps[origin])
    return { kind: 'unavailable', reason: 'budget_unavailable' };
  const choice = await p.chooseRecipe(scope, {
    topicId: subject.topicId,
    ...(subject.facetId === undefined ? {} : { facetId: subject.facetId }),
  });
  if (choice.kind === 'none') return { kind: 'unavailable', reason: 'could_not_prepare' };
  const work = await p.store.joinOrCreate(scope, brief, p.newId(), { recipe: choice.recipe, origin });
  if (work.joined) return { kind: 'waiting', workId: work.id, decision: 'join' };
  await p.enqueueProduction(scope, choice.recipe, choice.take);
  return { kind: 'waiting', workId: work.id, decision: 'create' };
}

/** Production that is queued or running will still deliver (a paused or dropped job counts: sending it again resumes it). */
export const isComing = (state: ScrollProductionState) => state === 'not_started' || state === 'running';

/**
 * When a waiter looks again, and which slot that is. Slots are fixed offsets from the request's
 * creation, and the sender makes one job per request and slot, so two deliveries of the same poll
 * schedule the same next one and the chain of polls never forks.
 */
export function nextPoll(createdAt: string, now: Date) {
  const waited = now.getTime() - Date.parse(createdAt);
  const slot = Math.max(1, Math.floor(waited / WAIT_POLL_MS) + 1);
  return {
    startAfter: new Date(Date.parse(createdAt) + slot * WAIT_POLL_MS),
    slot,
  };
}
