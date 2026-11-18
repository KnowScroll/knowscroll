import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';

/** The bounds of one scheduled prune pass. Every number is the pass's own, never a person's. */
export const PRUNE_COVER_OUTCOMES_BOUNDS = {
  /** Universes looked at per pass. */
  universes: 25,
  /** Rows deleted per universe per pass. */
  batch: 500,
} as const;

/** Worker consumer of the scheduled `experience.prune-cover-outcomes`. */
export type PruneCoverOutcomes = () => Promise<{
  readonly deleted: number;
  readonly universes: number;
  readonly failed: number;
}>;

/** A universe with at least one expired cover outcome. */
export interface ExpiredCoverOutcomesOwner {
  readonly universeId: string;
  readonly privacyEpoch: number;
}

export interface PruneCoverOutcomesPorts {
  readonly withPersonalScope: WithPersonalScope;
  /** Deletes at most `limit` expired rows of the scope's own universe and epoch; returns how many. */
  readonly prune: (scope: PersonalScopeTx, limit: number) => Promise<number>;
  /** The universes with an expired row, oldest first, from one indexed scan that takes no personal lock. Names no row. */
  readonly findOwners: (input: { readonly limit: number }) => Promise<readonly ExpiredCoverOutcomesOwner[]>;
}

const authorityOf = (owner: ExpiredCoverOutcomesOwner): PersonalAuthority => ({
  universeId: owner.universeId,
  privacyEpoch: owner.privacyEpoch,
  actor: { kind: 'system', purpose: 'experience.prune-cover-outcomes' },
});

/**
 * Scheduled pass: physically deletes cover outcomes past their 30-day life (`experience.cover_outcomes`, migration 0123). It
 * finds the universes with something to delete in one indexed read, then prunes each in its own short transaction as a system
 * actor under the personal root, which rechecks the account and epoch itself. A universe the root refuses (gone, suspended, a
 * new epoch) is skipped; one whose root is busy is left for the next pass (`failed`). Bounded (`PRUNE_COVER_OUTCOMES_BOUNDS`); no
 * model, network or provider. Safe to run late, twice or concurrently: a second pass finds nothing left.
 */
export function makePruneCoverOutcomes(ports: PruneCoverOutcomesPorts): PruneCoverOutcomes {
  return async () => {
    const found = await ports.findOwners({ limit: PRUNE_COVER_OUTCOMES_BOUNDS.universes });
    const owners = found.slice(0, PRUNE_COVER_OUTCOMES_BOUNDS.universes);
    let deleted = 0;
    let failed = 0;
    for (const owner of owners) {
      try {
        const entered = await ports.withPersonalScope(authorityOf(owner), (scope) =>
          ports.prune(scope, PRUNE_COVER_OUTCOMES_BOUNDS.batch),
        );
        if (entered.kind === 'entered') deleted += entered.value;
      } catch {
        // A busy root or a transient failure leaves this universe for the next pass; the others still run.
        failed += 1;
      }
    }
    return { deleted, universes: owners.length, failed };
  };
}
