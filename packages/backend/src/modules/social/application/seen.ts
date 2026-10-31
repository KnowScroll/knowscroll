import { planReadMove, visiblePeerRead } from '../domain/conversations.js';
import type { EnteredConversation } from './conversation-gate.js';
import type { ConversationPorts } from './conversation-ports.js';

type SeenPorts = Pick<ConversationPorts, 'visibility'>;

/** Both people's SEEN switches, read under the conversation's pair lock; undefined when there is no other person to ask. */
async function switchesOf(
  p: SeenPorts,
  entered: EnteredConversation,
): Promise<{ readonly readerShares: boolean; readonly peerShares: boolean } | undefined> {
  const { lock, peer, peerAccess } = entered;
  if (lock === undefined || peer === undefined || peerAccess === undefined) return undefined;
  const reader = await p.visibility.settings(lock.shared, entered.owner.accountId);
  const theirs = await p.visibility.settings(lock.shared, peerAccess.accountId);
  return { readerShares: reader.shareReadState, peerShares: theirs.shareReadState };
}

const stands = (entered: EnteredConversation): boolean =>
  entered.peer !== undefined && !entered.peer.left && !entered.conversation.closed;

/**
 * SEEN, as the person who entered the conversation may be told (D-066, D-150): how far the other person has
 * read while their own switch was on, and only while both people share and the conversation stands. What the
 * other person read while their switch was off is never in it, even after they turn it on, because it is a
 * separate stored position that only moves while they share. `undefined` is the one answer for every other
 * case (the other person hides theirs, the reader hides their own, either person left, the other account is
 * gone), and it gives no reason. A person who is shown nothing where they expect something can guess the other
 * hid theirs; that is what a mutual switch means, and nothing here confirms it.
 *
 * Reads the two switches under the conversation's pair lock and never writes.
 */
export async function sharedPeerRead(
  p: SeenPorts,
  entered: EnteredConversation,
): Promise<{ readonly throughSequence: number } | undefined> {
  const switches = await switchesOf(p, entered);
  if (switches === undefined || entered.peer === undefined) return undefined;
  const throughSequence = visiblePeerRead({
    ...switches,
    standing: stands(entered),
    peerSharedThrough: entered.peer.sharedReadThroughSequence,
  });
  return throughSequence === undefined ? undefined : { throughSequence };
}

/**
 * What a read that moved the reader's own position means for SEEN: whether the shared position moves with it
 * (only while the reader's switch is on) and whether the other person's inbox is told (only when the shared
 * position moved and they could see it). With no other person to ask (their account is gone) nothing is shared
 * or told.
 */
export async function planSharedRead(
  p: SeenPorts,
  entered: EnteredConversation,
  moved: boolean,
): Promise<{ readonly recordShared: boolean; readonly tellPeer: boolean }> {
  const switches = await switchesOf(p, entered);
  if (switches === undefined) return { recordShared: false, tellPeer: false };
  return planReadMove({ moved, ...switches, standing: stands(entered) });
}
