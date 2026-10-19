/**
 * The external-attempt state machine (blueprint §15). `dispatched` means *may have been sent*;
 * an attempt found in `dispatched` by a later delivery has an unknown outcome and is never sent
 * again. Only reconciliation or an explicit write-off leaves `unknown`.
 */
export type AttemptState =
  'reserved' | 'not_sent' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'reconciled' | 'written_off';

const transitions: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  reserved: ['not_sent', 'dispatched'],
  dispatched: ['succeeded', 'failed', 'unknown'],
  unknown: ['reconciled', 'written_off'],
  not_sent: [],
  succeeded: [],
  failed: [],
  reconciled: [],
  written_off: [],
};

export function canTransition(from: AttemptState, to: AttemptState): boolean {
  return transitions[from].includes(to);
}

/**
 * What a (re)delivered job may do with an attempt that already exists for its step:
 * - `dispatch`: reserved but never dispatched, so nothing was sent; sending now is safe.
 * - `mark_unknown`: a previous delivery committed dispatch intent and never recorded an outcome
 *   (crash, lost claim). The provider may have received it: record `unknown`, do not resend.
 * - `settled`: the attempt is final (or awaiting reconciliation); return without sending.
 */
export type DeliveryDecision = 'dispatch' | 'mark_unknown' | 'settled';

export function decideOnDelivery(state: AttemptState): DeliveryDecision {
  switch (state) {
    case 'reserved':
      return 'dispatch';
    case 'dispatched':
      return 'mark_unknown';
    case 'not_sent':
    case 'succeeded':
    case 'failed':
    case 'unknown':
    case 'reconciled':
    case 'written_off':
      return 'settled';
  }
}
