import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { FeedStore } from './feed-ports.js';

/** How a run ends when its turn ends: `undefined` leaves the run open, as for an attempt whose outcome is unknown. */
export type RunEnd = 'completed' | 'failed' | 'cancelled' | undefined;

/**
 * Settles a turn that posts or writes nothing and closes its model run, in one transaction of the room scope, so a turn
 * is never left queued under a closed run. A turn that reached the provider stays counted (`dispatched` is only ever raised).
 */
export function makeSettle(
  store: FeedStore,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
  authority: ProductionAuthority,
  now: () => Date,
) {
  return async (
    turnId: string,
    outcome: { readonly state: 'declined' | 'failed'; readonly dispatched: boolean },
    end: RunEnd,
  ): Promise<void> => {
    await withRoomScope(authority, async (scope) => {
      await store.settleTurn(scope, turnId, { ...outcome, at: now() });
      if (end !== undefined) await harness.closeProductionRun(scope, { runId: turnId, state: end });
    });
  };
}
