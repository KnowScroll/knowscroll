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
   * are not deleted yet) or was missed for a week, and the scheduled pass stops looking at it, so a held decision never keeps
   * the head of the scan. The backfill has no lookback (below); erasure removes what neither reclaims.
   */
  lookbackDays: 7,
  /** Batches one universe may take in a backfill, so one universe with a very long backlog cannot hold the command. */
  backfillBatchesPerUniverse: 200,
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

/** Where a scan stopped: the expiry (as text, to keep its microseconds) and id of the last decision it read. */
export interface DecisionScanKey {
  readonly expiresAt: string;
  readonly id: string;
}

export interface PruneDecisionsPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly prune: PruneComposerDecisions;
  /**
   * The universes with an expired decision that no offer and no live buffer holds, oldest first, from one indexed scan that
   * takes no personal lock. With `lookbackDays` only decisions that expired within that many days are looked at; without it
   * every expired decision is (the backfill). `after` continues a scan past the last key a page returned, so decisions that
   * are held, and so never returned, are not read again. `next` is absent when the scan reached its end. A fact about rows
   * only: it names no decision.
   */
  readonly findOwners: (input: {
    readonly limit: number;
    readonly lookbackDays?: number;
    readonly after?: DecisionScanKey;
  }) => Promise<{ readonly owners: readonly ExpiredDecisionsOwner[]; readonly next?: DecisionScanKey }>;
}

const authorityOf = (owner: ExpiredDecisionsOwner): PersonalAuthority => ({
  universeId: owner.universeId,
  privacyEpoch: owner.privacyEpoch,
  actor: { kind: 'system', purpose: 'composer.prune-decisions' },
});

/**
 * One batch for one universe, in its own short transaction under the personal root as a system actor, which rechecks the
 * account and epoch itself: `undefined` when the root refuses the universe (gone, suspended, a new epoch), and the number
 * deleted otherwise. A busy root or a transient failure throws.
 */
async function pruneBatch(ports: PruneDecisionsPorts, owner: ExpiredDecisionsOwner): Promise<number | undefined> {
  const entered = await ports.withPersonalScope(authorityOf(owner), (scope) =>
    ports.prune(scope, PRUNE_DECISIONS.batch),
  );
  return entered.kind === 'entered' ? entered.value : undefined;
}

/**
 * Scheduled pass: physically deletes expired decisions (blueprint §26 retention; `composer.decisions` README). It finds the
 * universes with something to delete in one indexed read, then prunes each in its own short transaction. A universe the root
 * refuses is skipped; one whose root is busy is left for the next pass (`failed`). The deletes are bounded
 * (`PRUNE_DECISIONS`), they never touch a decision an offer or a live buffer holds, and no model, network or provider is
 * involved. Safe to run late, twice or concurrently: a second pass finds nothing left.
 */
export function makePruneDecisions(ports: PruneDecisionsPorts): PruneDecisions {
  return async () => {
    const { owners: found } = await ports.findOwners({
      limit: PRUNE_DECISIONS.universes,
      lookbackDays: PRUNE_DECISIONS.lookbackDays,
    });
    const owners = found.slice(0, PRUNE_DECISIONS.universes);
    let deleted = 0;
    let failed = 0;
    for (const owner of owners) {
      try {
        deleted += (await pruneBatch(ports, owner)) ?? 0;
      } catch {
        // A busy root or a transient failure leaves this universe for the next pass; the others still run.
        failed += 1;
      }
    }
    return { deleted, universes: owners.length, failed };
  };
}

/** The operator's one-off backfill (`composer prune-backfill`): see {@link makeBackfillPruneDecisions}. */
export type BackfillPruneDecisions = (options: { readonly maxUniverses: number }) => Promise<{
  readonly deleted: number;
  readonly universes: number;
  readonly failed: number;
  /** The scan reached its end: no unheld expired decision is left (other than those a failure or the cap left). */
  readonly complete: boolean;
}>;

/**
 * A one-off pass with no lookback, so the old unheld decisions of universes that are never active again (the scheduled pass
 * looks back seven days only) are reclaimed. It scans every expired decision once, oldest first, in pages that continue past
 * the last key read, and prunes each universe it finds in batches of `PRUNE_DECISIONS.batch` until none is left or
 * `backfillBatchesPerUniverse` batches have run. It stops after `maxUniverses` universes (`complete` is false then) and can be
 * run again. Every guard of the scheduled pass holds: a decision an offer or a live buffer holds is never read or deleted, each
 * batch is its own transaction under the personal root, and a refused or busy universe is skipped. No model, network or provider.
 */
export function makeBackfillPruneDecisions(ports: PruneDecisionsPorts): BackfillPruneDecisions {
  return async ({ maxUniverses }) => {
    let after: DecisionScanKey | undefined;
    let deleted = 0;
    let universes = 0;
    let failed = 0;
    while (universes < maxUniverses) {
      const page = await ports.findOwners({
        limit: PRUNE_DECISIONS.universes,
        ...(after === undefined ? {} : { after }),
      });
      const room = maxUniverses - universes;
      for (const owner of page.owners.slice(0, room)) {
        universes += 1;
        try {
          for (let batch = 0; batch < PRUNE_DECISIONS.backfillBatchesPerUniverse; batch += 1) {
            const removed = await pruneBatch(ports, owner);
            deleted += removed ?? 0;
            if (removed === undefined || removed < PRUNE_DECISIONS.batch) break;
          }
        } catch {
          failed += 1;
        }
      }
      if (page.next === undefined) return { deleted, universes, failed, complete: page.owners.length <= room };
      after = page.next;
    }
    return { deleted, universes, failed, complete: false };
  };
}
