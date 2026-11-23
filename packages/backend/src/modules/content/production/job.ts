import { parseProductionRecipe, productionVersionOf } from './topics.js';
import { isMadeToOrderKey } from '../domain/order-key.js';
import type { ProductionKey } from './subject.js';
import type { ProduceScrollJob } from './events.js';
import type { ProduceScrollResult } from './types.js';

/** The production use case one job runs: `makeProduceScroll`'s function, injected by composition. */
export type ProduceScroll = (
  recipe: ProductionKey,
  dryRun: boolean,
  signal: AbortSignal,
  resume?: boolean,
  take?: number,
) => Promise<ProduceScrollResult>;

/** What the production job reads from the process's configuration. */
export interface ScrollProductionSettings {
  /**
   * `KS_MADE_TO_ORDER_ENABLED` (D-436). Off, a job for an order placed from code (`order-…`: an ask order or a branch) ends at once
   * without producing anything.
   */
  readonly madeToOrderEnabled: boolean;
}

export type ScrollProductionJobOutcome =
  /**
   * The job is not for this build: another recipe version, or a recipe this code does not hold; or it is for a Scroll made to
   * order while that is switched off (`made_to_order_off`). A skipped job is complete: it is never retried, and no run, attempt or
   * paid request is made for it.
   */
  | { readonly kind: 'skipped'; readonly reason: 'policy_version' | 'unknown_recipe' | 'made_to_order_off' }
  /**
   * The delivery is done: the business run is terminal (published, rejected or unknown), or it paused
   * because a daily budget or the provider's quota is used up and waits for a later send, or the take
   * may not start yet (`take_refused`: an earlier take was not rejected).
   */
  | { readonly kind: 'finished'; readonly result: ProduceScrollResult };

/**
 * Runs the production of one library recipe, or of one Scroll ordered from code, for a queue delivery (blueprint §11, §15: the delivery
 * is not the business run, which is the recipe's job row, and not the attempt, which the writer's
 * ledger holds). Every delivery continues the same job row and writer run, so a redelivery after a
 * crash or a lost claim never starts over and never resends an attempt whose outcome is unknown.
 *
 * Authority: the production scope the use case enters itself; a disabled or revoked scope is an
 * error, so the job retries and then dead-letters rather than vanishing. Outcomes `published`,
 * `rejected` and `unknown` are final and complete the delivery: a rejected recipe stays rejected at
 * this version, and an unknown attempt waits for an operator. `paused` also completes it: nothing was
 * sent, the run stays open, and the next send for the recipe (an operator's library run, or a person's
 * request) resumes it once the budget or quota allows. A job that is still `in_progress` after the
 * call belongs to another running delivery, so this one fails to be tried again later. A transient
 * research failure (the network, a host that is slow or erroring) also fails the delivery, so the queue
 * tries it again with backoff; the job stays at its research stage and no take is spent.
 *
 * While `KS_MADE_TO_ORDER_ENABLED` is off (D-436) a job for an order placed from code is skipped as `made_to_order_off` before
 * anything is read or run. `madeToOrderQueue` says the job came from the queue that holds only such orders
 * (`content.produce-answer`), so a job there is held to the same rule whatever its recipe key says. Library recipes are never
 * affected.
 */
export function makeRunScrollProduction(produce: ProduceScroll, settings: ScrollProductionSettings) {
  return async function runScrollProduction(
    job: ProduceScrollJob,
    delivery: { readonly signal: AbortSignal },
    madeToOrderQueue = false,
  ): Promise<ScrollProductionJobOutcome> {
    if (!settings.madeToOrderEnabled && (madeToOrderQueue || isMadeToOrderKey(job.recipe)))
      return { kind: 'skipped', reason: 'made_to_order_off' };
    if (job.policyVersion !== productionVersionOf(job.recipe)) return { kind: 'skipped', reason: 'policy_version' };
    const recipe = parseProductionRecipe(job.recipe) ?? (isMadeToOrderKey(job.recipe) ? job.recipe : undefined);
    if (recipe === undefined) return { kind: 'skipped', reason: 'unknown_recipe' };
    const result = await produce(recipe, false, delivery.signal, true, job.take);
    if (result.outcome === 'unknown_recipe') return { kind: 'skipped', reason: 'unknown_recipe' };
    if (result.outcome === 'scope_refused') throw new Error('SCROLL_PRODUCTION_SCOPE_REFUSED');
    if (result.outcome === 'in_progress') throw new Error('SCROLL_PRODUCTION_IN_PROGRESS');
    if (result.outcome === 'retry_later') throw new Error('SCROLL_PRODUCTION_RESEARCH_UNAVAILABLE');
    return { kind: 'finished', result };
  };
}
export type RunScrollProduction = ReturnType<typeof makeRunScrollProduction>;
