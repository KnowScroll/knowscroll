import { visiblePeerRead } from '../domain/conversations.js';
import type { EnteredConversation } from './conversation-gate.js';
import type { ConversationPorts } from './conversation-ports.js';

/**
 * SEEN, as the person who entered the conversation may be told (D-066, D-150): how far the other person has
 * read, and only while both people share their read position and the conversation stands. `undefined` is the
 * one answer for every other case (the other person hides theirs, the reader hides their own, either person
 * left, the other account is gone), and it gives no reason. A person who is shown nothing where they expect
 * something can guess the other hid theirs; that is what a mutual switch means, and nothing here confirms it.
 *
 * Reads the two switches under the conversation's pair lock. It reads the other person's stored read position
 * and never writes one: the position already moves for every reader, with or without this.
 */
export async function sharedPeerRead(
  p: Pick<ConversationPorts, 'visibility'>,
  entered: EnteredConversation,
): Promise<{ readonly throughSequence: number } | undefined> {
  const { lock, peer, peerAccess } = entered;
  if (lock === undefined || peer === undefined || peerAccess === undefined) return undefined;
  const reader = await p.visibility.settings(lock.shared, entered.owner.accountId);
  const theirs = await p.visibility.settings(lock.shared, peerAccess.accountId);
  const throughSequence = visiblePeerRead({
    readerShares: reader.shareReadState,
    peerShares: theirs.shareReadState,
    standing: !peer.left && !entered.conversation.closed,
    peerReadThrough: peer.readThroughSequence,
  });
  return throughSequence === undefined ? undefined : { throughSequence };
}
