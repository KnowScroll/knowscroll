/** How long a branch may stay preparing before it closes as unable to prepare. */
export const BRANCH_WAIT_LIMIT_MS = 30 * 60_000;

/** Where an order's production stands, as content reports it. */
export interface ProductionStanding {
  /** `held` is a library recipe's state at the review gate (D-138); an order never reaches it, and if it did nothing here could produce it. */
  readonly state: 'not_started' | 'running' | 'published' | 'held' | 'retryable' | 'stopped';
  /** The take a send for the order should name. */
  readonly take?: number;
  readonly published?: { readonly assetRevision: number; readonly title: string };
}

/** What to do with one preparing branch. */
export type BranchProgress =
  /** The Scroll is admitted: bind it. */
  | { readonly kind: 'bind'; readonly assetRevision: number; readonly assetTitle: string }
  /** Production is under way or a take was rejected: make sure the job for this take exists. */
  | { readonly kind: 'send'; readonly take: number }
  | { readonly kind: 'wait' }
  /** Nothing can produce it any more, or it took too long. */
  | { readonly kind: 'fail' };

/**
 * Decides one preparing branch from the standing of its production and its age (D-049). An admitted
 * Scroll always wins, even past the limit. A rejected take is followed by the next one, within
 * the three takes a recipe gets; an order with no job yet, or whose job was lost, is sent again, and
 * the queue's one-job-per-take rule makes a repeat harmless. Pure.
 */
export function branchProgress(standing: ProductionStanding, ageMs: number): BranchProgress {
  if (standing.state === 'published' && standing.published !== undefined)
    return { kind: 'bind', assetRevision: standing.published.assetRevision, assetTitle: standing.published.title };
  if (standing.state === 'stopped' || standing.state === 'held' || ageMs >= BRANCH_WAIT_LIMIT_MS)
    return { kind: 'fail' };
  if (standing.take === undefined) return { kind: 'wait' };
  return { kind: 'send', take: standing.take };
}
