/** Rules of direct conversations and share links that need no database, clock or crypto. */

/** Share links live thirty days from creation; they can be revoked earlier, never extended (D-042). */
export const SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export type ShareState = 'live' | 'revoked' | 'expired';

/** Revocation wins over expiry, so a revoked link never reads as merely old. */
export function shareState(
  share: { readonly expiresAt: Date; readonly revokedAt: Date | null },
  now: Date,
): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  return now.getTime() >= share.expiresAt.getTime() ? 'expired' : 'live';
}

/**
 * Where a person's read position ends up. It never moves back, and it cannot pass the newest
 * message: `undefined` means the request named a message that does not exist yet.
 */
export function acceptedReadThrough(current: number, requested: number, latest: number): number | undefined {
  if (requested > latest) return undefined;
  return Math.max(current, requested);
}

/** What decides whether one person may be told how far the other has read (D-066). */
export interface SeenInput {
  /** The reader shares their own read position (their SEEN switch). */
  readonly readerShares: boolean;
  /** The other person shares theirs. */
  readonly peerShares: boolean;
  /** The other person is still in the conversation and it has not ended. */
  readonly standing: boolean;
  /** How far the other person has read while their own switch was on, as stored (never what they read while it was off). */
  readonly peerSharedThrough: number;
}

/**
 * How far the other person has read, as the reader may be told, or `undefined` for no answer at all.
 * SEEN is mutual: it exists only while both people share, so a person who hides theirs sees nothing of
 * the other's. Saying nothing gives no reason.
 * A conversation that has ended (the other person left, or deleted their account) shows none.
 */
export function visiblePeerRead(input: SeenInput): number | undefined {
  if (!input.standing || !input.readerShares || !input.peerShares) return undefined;
  return input.peerSharedThrough;
}

/** What a read that may have moved the reader's position means for SEEN. */
export interface ReadMoveInput {
  /** The reader's own position moved forward with this read (not a repeat, not a smaller number). */
  readonly moved: boolean;
  readonly readerShares: boolean;
  readonly peerShares: boolean;
  readonly standing: boolean;
}

/**
 * The reader's own position always moves, for their own unread dot. The shared position, the only one the
 * other person can be told, moves with it only while the reader's switch is on: what a person reads while it
 * is off is never shown, even after they turn it on (D-150). The other person's inbox hears of it only when
 * the shared position moved and they could see it, which is while both share and the conversation stands.
 */
export function planReadMove(input: ReadMoveInput): { readonly recordShared: boolean; readonly tellPeer: boolean } {
  const recordShared = input.moved && input.readerShares;
  return { recordShared, tellPeer: recordShared && input.peerShares && input.standing };
}
