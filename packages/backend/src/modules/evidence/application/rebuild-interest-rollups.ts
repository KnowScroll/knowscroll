import type { PersonalAuthority, WithPersonalScope } from '../../identity/public.js';

/** One person whose topic rows hold something to roll up. A fact about rows: it names no topic. */
export interface InterestRollupOwner {
  readonly universeId: string;
  readonly privacyEpoch: number;
}

export interface RebuildInterestRollupsPorts {
  readonly withPersonalScope: WithPersonalScope;
  /** Rebuilds the roll-ups of the scope's person from their topic rows, in the scope's transaction. */
  readonly rebuild: (scope: Parameters<Parameters<WithPersonalScope>[1]>[0]) => Promise<{ readonly topics: number }>;
  /** The next `limit` persons with topic rows after `after` (universe id order), from one indexed read that takes no personal lock. */
  readonly owners: (input: {
    readonly after?: string;
    readonly limit: number;
  }) => Promise<readonly InterestRollupOwner[]>;
}

/** The persons looked at per page of the scan. */
export const REBUILD_INTEREST_PAGE = 50;

export interface RebuildInterestRollupsResult {
  /** Persons whose roll-ups were rebuilt. */
  readonly rebuilt: number;
  /** Topic rows read and stamped. */
  readonly topics: number;
  /** Persons the personal root refused (gone, suspended, a new epoch). */
  readonly skipped: number;
  /** Persons whose root was busy or whose rebuild failed; run the command again. */
  readonly failed: number;
  /** The scan reached its end: every person with topic rows was visited. False when `maxUniverses` stopped it. */
  readonly complete: boolean;
}

const authorityOf = (owner: InterestRollupOwner): PersonalAuthority => ({
  universeId: owner.universeId,
  privacyEpoch: owner.privacyEpoch,
  actor: { kind: 'system', purpose: 'evidence.rebuild-interest-rollups' },
});

/**
 * The operator's one-off pass behind `evidence rebuild-interest-rollups` (D-420): builds the system and person roll-ups, stamps what
 * each topic row was counted as and lets the table's trigger fill the `log_weight` of rows no writer has touched since migration
 * 0121, for every person with topic rows. It runs before a world turns Composer policy v3 on, and after any rollback to a binary that
 * does not write roll-ups. Each person is one transaction under their own personal scope (the account, epoch and root lock are
 * rechecked, so it never runs beside that person's projection), the work per person is a streamed read of their topic rows, and the
 * pass writes nothing but derived rows. Idempotent: a person already rebuilt gets the same rows again, so it can be stopped, run
 * twice or run beside live traffic. It stops after `maxUniverses` persons and says whether the scan finished. No model, no network.
 */
export function makeRebuildInterestRollups(ports: RebuildInterestRollupsPorts) {
  return async (options: { readonly maxUniverses: number }): Promise<RebuildInterestRollupsResult> => {
    let rebuilt = 0;
    let topics = 0;
    let skipped = 0;
    let failed = 0;
    let visited = 0;
    let after: string | undefined;
    while (visited < options.maxUniverses) {
      const limit = Math.min(REBUILD_INTEREST_PAGE, options.maxUniverses - visited);
      const page = await ports.owners({ ...(after === undefined ? {} : { after }), limit });
      for (const owner of page) {
        visited += 1;
        try {
          const entered = await ports.withPersonalScope(authorityOf(owner), (scope) => ports.rebuild(scope));
          if (entered.kind === 'entered') {
            rebuilt += 1;
            topics += entered.value.topics;
          } else skipped += 1;
        } catch {
          // A busy root or a transient failure leaves this person for the next run; the others still run.
          failed += 1;
        }
      }
      if (page.length < limit) return { rebuilt, topics, skipped, failed, complete: true };
      after = page.at(-1)!.universeId;
    }
    // `maxUniverses` persons were visited: the scan is complete only if nobody is left after the last one.
    const rest = await ports.owners({ ...(after === undefined ? {} : { after }), limit: 1 });
    return { rebuilt, topics, skipped, failed, complete: rest.length === 0 };
  };
}
