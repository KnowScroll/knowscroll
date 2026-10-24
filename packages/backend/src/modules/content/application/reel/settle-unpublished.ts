import { summaryOf, type AttemptSummary } from './attempt-steps.js';
import type { ReelUntil } from '../../domain/reel/script.js';
import type { ReelPorts } from './ports.js';

export type SettleUnpublishedResult =
  | { readonly kind: 'refused'; readonly code: 'no_attempt' | 'not_settleable' | 'pool_unavailable' }
  | { readonly kind: 'settled'; readonly attempt: AttemptSummary; readonly costCents: number };

/**
 * Closes the pool claim of a request that finished but whose Reel `reel follow` holds, after a
 * person decided it will not be published. The pool records the cost Cutroom reported, exactly as
 * `follow` would have. Refused unless the request has finished, the claim is still open and no Reel
 * was published for the order. The reason is only echoed; nothing is resent and nothing is hidden.
 */
export function makeSettleUnpublished(ports: ReelPorts) {
  return async (command: {
    readonly scriptName: string;
    readonly until: ReelUntil;
  }): Promise<SettleUnpublishedResult> => {
    const order = await ports.ledger.latestOrderOf(command.scriptName, command.until);
    const attempt = order && (await ports.ledger.attemptsOf(order.id)).at(-1);
    if (!order || !attempt) return { kind: 'refused', code: 'no_attempt' };
    const facts = attempt.finished;
    if (facts === null || attempt.poolState !== 'claimed' || order.assetId !== null)
      return { kind: 'refused', code: 'not_settleable' };
    try {
      await ports.pool.settle({
        requestId: attempt.requestId,
        world: ports.world,
        outcome: facts.outcome,
        spentCents: facts.costCents,
        finalRunId: facts.finalRunId,
      });
    } catch {
      return { kind: 'refused', code: 'pool_unavailable' };
    }
    const settled = await ports.ledger.advance(attempt.id, { kind: 'settled' });
    return settled
      ? { kind: 'settled', attempt: summaryOf(settled), costCents: facts.costCents }
      : { kind: 'refused', code: 'not_settleable' };
  };
}
