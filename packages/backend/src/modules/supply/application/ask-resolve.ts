import { madeToOrderKey, type EncounterSnapshot } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { WAIT_LIMIT_MS, isComing, nextPoll, waitStartOf } from './commission.js';
import { checkedRevision, snapshot } from './inventory.js';
import type { Demand, SupplyPorts } from './ports.js';

type AskOrderOutcome =
  | { readonly kind: 'ready'; readonly encounter: EncounterSnapshot; readonly availabilityRevision: number }
  | { readonly kind: 'wait' }
  | { readonly kind: 'could_not_prepare' };

/**
 * Where a person's ask order stands: its Scroll is admitted and readable (ready), production is queued or running within
 * the wait limit (wait), or it ended without a Scroll, was withdrawn, or took too long (could not prepare; the person may
 * try it again, D-054). Reads shared production state on the caller's own transaction.
 */
async function askOrderOutcome(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand & { readonly askOrder: NonNullable<Demand['askOrder']> },
): Promise<AskOrderOutcome> {
  const reading = await p.readOrderProduction(scope, madeToOrderKey(d.askOrder.orderId));
  if (reading.published !== undefined) {
    const [head] = await p.lockCurrent(scope, {
      refs: [{ assetId: reading.published.assetId, assetRevision: reading.published.assetRevision }],
      capabilities: d.command.capabilities,
    });
    return head?.encounter === undefined
      ? { kind: 'could_not_prepare' }
      : { kind: 'ready', encounter: head.encounter, availabilityRevision: head.availabilityRevision };
  }
  const waited = p.now().getTime() - Date.parse(waitStartOf(d));
  return isComing(reading.state) && waited < WAIT_LIMIT_MS ? { kind: 'wait' } : { kind: 'could_not_prepare' };
}

/**
 * Advances one waiter whose request became an ask order (D-218): binds the admitted Scroll and notes, once, how long the
 * order took (the ledger's "usually" time), looks again in {@link nextPoll} while production is under way, or closes the
 * request as could-not-prepare. A redelivery changes nothing that is already decided. No model call and no network wait:
 * the order's production runs in its own job.
 *
 * Authority: the caller's open personal scope with the request already read and the owner checked; the Scroll's current
 * admission is rechecked here.
 */
export async function advanceAskOrder(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  d: Demand & { readonly askOrder: NonNullable<Demand['askOrder']> },
): Promise<void> {
  const outcome = await askOrderOutcome(p, scope, d);
  if (outcome.kind === 'wait') {
    await p.enqueue(scope, d.id, nextPoll(d, p.now()));
    return;
  }
  const current = await snapshot(p, scope, d);
  const revision = await p.advance(scope);
  const ready = outcome.kind === 'ready';
  await p.store.finish(scope, {
    ...d,
    revision,
    requestRevision: checkedRevision(current.requestRevision + 1),
    updatedAt: p.now().toISOString(),
    status: ready ? 'ready' : 'unavailable',
    reason: ready ? undefined : 'could_not_prepare',
    ...(ready ? { content: outcome.encounter, contentAvailabilityRevision: outcome.availabilityRevision } : {}),
  });
  if (ready) await p.askLedger.markReady(scope, d.askOrder.orderId);
  await p.notify(scope, revision, d.id);
}
