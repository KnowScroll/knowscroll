import type { PersonalAuthority, WithPersonalScope } from '../../identity/public.js';
import type { PruneComposerDecisions } from './ports.js';

/** The bounds of one scheduled prune pass. Every number is the pass's own, never a person's. */
export const PRUNE_DECISIONS = {
  /** Universes looked at per pass. */
  universes: 25,
  /** Decisions deleted per universe per pass (`pruneComposerDecisions` accepts 1 to 1000). */
  batch: 500,
  /**
   * A decision is looked for in the days after it expired. One that is still there after this is held by an offer (offers
   * are not deleted yet) or was missed for a week, and the pass stops looking at it, so a held decision never keeps the
   * head of the scan. Erasure still removes it.
   */
  lookbackDays: 7,
} as const;

/** Worker consumer of the scheduled `composer.prune-decisions`. */
export type PruneDecisions = () => Promise<{
  readonly deleted: number;
  readonly universes: number;
  readonly failed: number;
}>;

/** A universe whose decisions have expired and are held by no offer and no buffer. */
export interface ExpiredDecisionsOwner {
  readonly universeId: string;
  readonly privacyEpoch: number;
}

export interface PruneDecisionsPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly prune: PruneComposerDecisions;
  /**
   * The first `limit` universes with a decision that expired within `lookbackDays` and that no offer and no buffer holds,
   * oldest first, in one indexed read that takes no personal lock. A fact about rows only; it names no decision.
   */
  readonly findOwners: (input: {
    readonly limit: number;
    readonly lookbackDays: number;
  }) => Promise<readonly ExpiredDecisionsOwner[]>;
}

/**
 * Scheduled pass: physically deletes expired decisions (blueprint §26 retention; `composer.decisions` README). It finds the
 * universes with something to delete in one indexed read, then prunes each in its own short transaction under the personal
 * root as a system actor, which rechecks the account and epoch itself: a universe that is gone, suspended or at a new epoch
 * is skipped, and one whose root lock is busy is left for the next pass (`failed`). The deletes are bounded
 * (`PRUNE_DECISIONS`), they never touch a decision an offer or a live buffer holds, and no model, network or provider is
 * involved. Safe to run late, twice or concurrently: a second pass finds nothing left.
 */
export function makePruneDecisions(ports: PruneDecisionsPorts): PruneDecisions {
  return async () => {
    const owners = await ports.findOwners({
      limit: PRUNE_DECISIONS.universes,
      lookbackDays: PRUNE_DECISIONS.lookbackDays,
    });
    let deleted = 0;
    let failed = 0;
    for (const owner of owners) {
      const authority: PersonalAuthority = {
        universeId: owner.universeId,
        privacyEpoch: owner.privacyEpoch,
        actor: { kind: 'system', purpose: 'composer.prune-decisions' },
      };
      try {
        const entered = await ports.withPersonalScope(authority, (scope) => ports.prune(scope, PRUNE_DECISIONS.batch));
        if (entered.kind === 'entered') deleted += entered.value;
      } catch {
        // A busy root or a transient failure leaves this universe for the next pass; the others still run.
        failed += 1;
      }
    }
    return { deleted, universes: owners.length, failed };
  };
}
