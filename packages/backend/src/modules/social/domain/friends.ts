/** PRIVATE aggregate state. Only view() crosses the public relationship boundary. */
export type PairState = 'none' | 'incoming' | 'outgoing' | 'friends' | 'blocked';
export interface Side {
  accountId: string;
  blocked: boolean;
  revision: number;
  state: PairState;
}
export interface Window {
  id: string;
  sender: string;
  recipient: string;
  expiresAt: number;
  disposition: 'pending' | 'declined' | 'cancelled' | 'accepted' | 'expired' | 'blocked';
}
export interface Pair {
  id: string;
  low: string;
  high: string;
  privateRevision: number;
  lineage: string | null;
  window: Window | null;
  sides: [Side, Side];
}
export type Operation = 'request' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
export type Refusal = 'unavailable' | 'stale_revision' | 'counter_exhausted';
export const REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const increment = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw new Error('SOCIAL_COUNTER_EXHAUSTED');
  return value + 1;
};
export function sideOf(pair: Pair, accountId: string): Side {
  const side = pair.sides.find((s) => s.accountId === accountId);
  if (!side) throw new Error('SOCIAL_PAIR_BINDING');
  return side;
}
/** Pure effective deadline: ignored/declined histories age on the SAME public deadline.
 * Reads need no cleanup writes; a later command persists this same once-only transition. */
export function atTime(source: Pair, now: number): Pair {
  const pair = structuredClone(source);
  if (pair.window && now >= pair.window.expiresAt) {
    for (const s of pair.sides) {
      if (s.state === 'incoming' || s.state === 'outgoing') {
        s.state = 'none';
        s.revision = increment(s.revision);
      }
    }
    if (pair.window.disposition === 'pending' || pair.window.disposition === 'declined')
      pair.window.disposition = 'expired';
  }
  return pair;
}
export function apply(
  source: Pair,
  input: { actor: string; operation: Operation; expected: number; requestId?: string },
  now: number,
  newRequestId: string,
): { kind: 'accepted'; pair: Pair; lineage: string | null } | { kind: 'refused'; code: Refusal } {
  const pair = atTime(source, now);
  const own = sideOf(pair, input.actor);
  const peer = pair.sides.find((s) => s.accountId !== input.actor)!;
  const window = pair.window;
  const live = window !== null && now < window.expiresAt;
  // A private block cannot create a stale-revision oracle. Sender's already-open request
  // remains the same no-op in ignored, declined AND privately blocked histories.
  const pendingSender = live && window.sender === input.actor && own.state === 'outgoing';
  if (
    peer.blocked &&
    !((input.operation === 'request' || input.operation === 'cancel') && pendingSender) &&
    input.operation !== 'block'
  )
    return { kind: 'refused', code: 'unavailable' };
  if (own.blocked && input.operation !== 'unblock' && input.operation !== 'block')
    return { kind: 'refused', code: 'unavailable' };
  if (input.expected !== own.revision) return { kind: 'refused', code: 'stale_revision' };
  const change = (s: Side, state: PairState) => {
    if (s.state !== state) {
      s.revision = increment(s.revision);
      s.state = state;
    }
  };
  switch (input.operation) {
    case 'request':
      if (own.state === 'friends' || live) break; // reciprocal never accepts; fixed-window cooldown
      // Reserve the deterministic next public deadline revision before opening either view.
      if (own.revision > Number.MAX_SAFE_INTEGER - 2 || peer.revision > Number.MAX_SAFE_INTEGER - 2)
        throw new Error('SOCIAL_COUNTER_EXHAUSTED');
      pair.window = {
        id: newRequestId,
        sender: input.actor,
        recipient: peer.accountId,
        expiresAt: now + REQUEST_WINDOW_MS,
        disposition: 'pending',
      };
      change(own, 'outgoing');
      change(peer, 'incoming');
      break;
    case 'accept':
      if (
        !live ||
        !window ||
        window.id !== input.requestId ||
        window.recipient !== input.actor ||
        window.disposition !== 'pending' ||
        own.state !== 'incoming'
      )
        return { kind: 'refused', code: 'unavailable' };
      window.disposition = 'accepted';
      pair.lineage = window.id;
      change(own, 'friends');
      change(peer, 'friends');
      break;
    case 'decline':
      if (
        !live ||
        !window ||
        window.id !== input.requestId ||
        window.recipient !== input.actor ||
        window.disposition !== 'pending' ||
        own.state !== 'incoming'
      )
        return { kind: 'refused', code: 'unavailable' };
      window.disposition = 'declined';
      change(own, 'none'); // NOTHING on the sender's public side changes
      break;
    case 'cancel':
      if (
        !live ||
        !window ||
        window.id !== input.requestId ||
        window.sender !== input.actor ||
        own.state !== 'outgoing'
      )
        return { kind: 'refused', code: 'unavailable' };
      window.disposition = 'cancelled';
      change(own, 'none');
      if (peer.state === 'incoming') change(peer, 'none');
      break;
    case 'remove':
      if (own.state !== 'friends' || pair.lineage === null) return { kind: 'refused', code: 'unavailable' };
      pair.lineage = null;
      change(own, 'none');
      change(peer, peer.blocked ? 'blocked' : 'none');
      break;
    case 'block':
      if (own.blocked) break;
      own.blocked = true;
      change(own, 'blocked');
      if (pair.lineage !== null) {
        pair.lineage = null;
        change(peer, peer.blocked ? 'blocked' : 'none');
      }
      if (window && live && window.disposition !== 'accepted') window.disposition = 'blocked';
      break;
    case 'unblock':
      if (!own.blocked) return { kind: 'refused', code: 'unavailable' };
      own.blocked = false;
      change(own, 'none'); // never restores old authority
      break;
  }
  if (JSON.stringify(pair) !== JSON.stringify(atTime(source, now)))
    pair.privateRevision = increment(pair.privateRevision);
  return {
    kind: 'accepted',
    pair,
    lineage:
      input.operation === 'request'
        ? own.state === 'incoming' || own.state === 'outgoing'
          ? (pair.window?.id ?? null)
          : pair.lineage
        : pair.lineage,
  };
}
/** Public acceptance replay is a historical receipt, but grant-related replay still needs its
 * original current lineage. Do not use private disposition/revision for sender admission. */
export function replayAllowed(
  pair: Pair,
  actor: string,
  operation: Operation,
  lineage: string | null,
  now: number,
): boolean {
  if (operation !== 'request' && operation !== 'accept') return true;
  if (sideOf(pair, actor).blocked) return false;
  if (operation === 'accept')
    return lineage !== null && pair.lineage === lineage && pair.sides.every((s) => !s.blocked && s.state === 'friends');
  if (lineage === null) return true; // an actor-owned, non-granting cooldown no-op
  const window = pair.window;
  return (
    lineage !== null &&
    (pair.lineage === lineage ||
      (window?.id === lineage &&
        now < window.expiresAt &&
        (window.sender === actor
          ? sideOf(pair, actor).state === 'outgoing'
          : window.disposition === 'pending' && sideOf(pair, actor).state === 'incoming')))
  );
}
