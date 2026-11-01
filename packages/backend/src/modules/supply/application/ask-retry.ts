import { madeToOrderKey } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { Demand, SupplyPorts } from './ports.js';

/**
 * Tries an ask order again (E07 "Couldn't prepare"): the same request, the same order, a new wait. What can go again
 * is decided from where the order's production stands, never from the person: the Scroll was admitted meanwhile (the
 * request is ready), a take may start or resume (it is sent, in the caller's transaction), or nothing can start and
 * the request stays closed. The order's words and research pages were fixed when it was made, so a retry asks no model
 * and reads nothing new. An attempt of unknown outcome never reaches here: it stops the order's takes, so nothing is
 * sent. An order costs at most three takes whatever the retries, because the job counts takes, not requests.
 *
 * Authority: the caller's open personal scope, under Create's lock order. Side effects: on a send, one production job
 * (same identity per take, so a repeat is a no-op) in the caller's transaction.
 */
export async function reopenedAskOrder(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand & { readonly askOrder: NonNullable<Demand['askOrder']> },
  requestRevision: number,
): Promise<Demand | undefined> {
  const recipe = madeToOrderKey(d.askOrder.orderId);
  const reading = await p.readOrderProduction(scope, recipe);
  const now = p.now().toISOString();
  const reopened = {
    ...d,
    requestRevision,
    updatedAt: now,
    waitStartedAt: now,
    retries: (d.retries ?? 0) + 1,
    reason: undefined,
  };
  if (reading.published !== undefined) {
    const [head] = await p.lockCurrent(scope, {
      refs: [{ assetId: reading.published.assetId, assetRevision: reading.published.assetRevision }],
      capabilities: d.command.capabilities,
    });
    return head?.encounter === undefined
      ? undefined
      : {
          ...reopened,
          status: 'ready',
          decision: 'reuse',
          content: head.encounter,
          contentAvailabilityRevision: head.availabilityRevision,
        };
  }
  if (reading.take === undefined) return undefined;
  await p.enqueueAnswerProduction(scope, recipe, reading.take);
  return {
    ...reopened,
    status: 'requested',
    decision: 'create',
    content: undefined,
    contentAvailabilityRevision: undefined,
  };
}
