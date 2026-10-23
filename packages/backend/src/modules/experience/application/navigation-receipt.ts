import { z } from 'zod';
import { NavigationOutcomeSchema } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { originalRecordingGeneration, type CommandKey } from './ports.js';
import type { NavigationCommand, NavigationPorts, NavigationResult } from './navigation-ports.js';
import { currentRegionOffers, isRegionOpen, json, refuse } from './navigation-support.js';

/** The idempotency key of a navigation command: its operation, a hash of the request and the outcome version. */
export function keyOf(p: NavigationPorts, command: NavigationCommand): CommandKey {
  originalRecordingGeneration(command);
  const { commandId, ...request } = command;
  const operation = isRegionOpen(command)
    ? 'experience.region-open-v1'
    : 'intent' in command
      ? 'experience.navigate-v0'
      : 'experience.compose-open-v0';
  return { commandId, operation, requestHash: p.hashRequest(operation, json(request)), outcomeVersion: 1 };
}

// The private receipt holds only immutable result identity; public metadata lives in the same
// atomically committed scoped offer rows. This keeps the existing whole-receipt 8 KiB constraint.
const ReceiptCommon = {
  version: z.literal('navigation-receipt.v0'),
  commandId: z.uuid(),
  sessionId: z.uuid(),
  intentRevision: z.number().int().min(0),
  revision: z.number().int().min(0),
  decisionId: z.uuid(),
  replayed: z.literal(false),
};
const NavigationReceipt = z.discriminatedUnion('status', [
  z.strictObject({
    ...ReceiptCommon,
    status: z.literal('ready'),
    offerId: z.uuid(),
    bufferedOfferIds: z.array(z.uuid()).max(2),
  }),
  z.strictObject({
    ...ReceiptCommon,
    status: z.literal('exhausted'),
    reason: z.enum([
      'no_eligible_content',
      'series_boundary',
      'no_related_ready',
      'variant_unavailable',
      'return_unavailable',
    ]),
  }),
]);

/**
 * The stored outcome of this command, if it already committed: replayed from the immutable offer
 * rows, after rechecking that regional offers are still current. `undefined` for a new command.
 */
export async function receipt(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  key: CommandKey,
  requestedCapabilities?: unknown,
): Promise<NavigationResult | undefined> {
  const found = await p.findReceipt(scope, key);
  if (found.kind === 'new') return undefined;
  if (found.kind !== 'replay')
    return refuse(found.kind === 'outcome_version_newer' ? 'SERVICE_UNAVAILABLE' : 'COMMAND_KEY_REUSED');
  const stored = NavigationReceipt.safeParse(found.outcome);
  if (!stored.success) return refuse('SERVICE_UNAVAILABLE');
  const { version: _version, ...value } = stored.data;
  if (value.status === 'exhausted')
    return { kind: 'accepted', outcome: NavigationOutcomeSchema.parse({ ...value, replayed: true }) };
  const ids = [value.offerId, ...value.bufferedOfferIds];
  const offers = await p.readOwnedOffers(scope, ids);
  if (
    offers.length !== ids.length ||
    offers.some(
      (o, i) =>
        o.id !== ids[i] ||
        o.sessionId !== value.sessionId ||
        o.intentRevision !== value.intentRevision ||
        o.descriptor.decisionId !== value.decisionId,
    )
  )
    return refuse('SERVICE_UNAVAILABLE');
  if (offers.some((o) => o.regionConstraint)) {
    const session = await p.readSession(scope, value.sessionId);
    if (!session || !(await currentRegionOffers(p, scope, offers, requestedCapabilities ?? session.capabilities)))
      return refuse('OFFER_UNAVAILABLE');
  }
  const { offerId: _offerId, bufferedOfferIds: _bufferedOfferIds, ...common } = value;
  return {
    kind: 'accepted',
    outcome: NavigationOutcomeSchema.parse({
      ...common,
      replayed: true,
      offer: offers[0]!.descriptor,
      bufferedOffers: offers.slice(1).map((o) => o.descriptor),
    }),
  };
}
