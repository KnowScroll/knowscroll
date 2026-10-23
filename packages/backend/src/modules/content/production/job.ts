import { parseScrollTopic, SCROLL_PRODUCTION_VERSION, type ScrollTopic } from './topics.js';
import type { ProduceScrollJob } from './events.js';
import type { ProduceScrollResult } from './types.js';

/** The production use case one job runs: `makeProduceScroll`'s function, injected by composition. */
export type ProduceScroll = (
  recipe: ScrollTopic,
  dryRun: boolean,
  signal: AbortSignal,
  resume?: boolean,
) => Promise<ProduceScrollResult>;

export type ScrollProductionJobOutcome =
  /** The job is not for this build: another recipe version, or a recipe this code does not hold. */
  | { readonly kind: 'skipped'; readonly reason: 'policy_version' | 'unknown_recipe' }
  /** The business run is in a terminal state (published, rejected or unknown); the job is done. */
  | { readonly kind: 'finished'; readonly result: ProduceScrollResult };

/**
 * Runs the production of one library recipe for a queue delivery (blueprint §11, §15: the delivery
 * is not the business run, which is the recipe's job row, and not the attempt, which the writer's
 * ledger holds). Every delivery continues the same job row and writer run, so a redelivery after a
 * crash or a lost claim never starts over and never resends an attempt whose outcome is unknown.
 *
 * Authority: the production scope the use case enters itself; a disabled or revoked scope is an
 * error, so the job retries and then dead-letters rather than vanishing. Outcomes `published`,
 * `rejected` and `unknown` are final and complete the delivery: a rejected recipe stays rejected at
 * this version, and an unknown attempt waits for an operator. A job that is still `in_progress` after
 * the call belongs to another running delivery, so this one fails to be tried again later.
 */
export function makeRunScrollProduction(produce: ProduceScroll) {
  return async function runScrollProduction(
    job: ProduceScrollJob,
    delivery: { readonly signal: AbortSignal },
  ): Promise<ScrollProductionJobOutcome> {
    if (job.policyVersion !== SCROLL_PRODUCTION_VERSION) return { kind: 'skipped', reason: 'policy_version' };
    const recipe = parseScrollTopic(job.recipe);
    if (recipe === undefined) return { kind: 'skipped', reason: 'unknown_recipe' };
    const result = await produce(recipe, false, delivery.signal, true);
    if (result.outcome === 'scope_refused') throw new Error('SCROLL_PRODUCTION_SCOPE_REFUSED');
    if (result.outcome === 'in_progress') throw new Error('SCROLL_PRODUCTION_IN_PROGRESS');
    return { kind: 'finished', result };
  };
}
export type RunScrollProduction = ReturnType<typeof makeRunScrollProduction>;
