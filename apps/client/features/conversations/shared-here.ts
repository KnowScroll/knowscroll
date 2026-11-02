import type { ConversationMessage, PublicPersonRef } from '@knowscroll/contracts';
import { rootOfCard } from './start-thread-sheet';

/** One card sent in this conversation, as the "In this chat" rail lists it. */
export interface SharedHere {
  readonly messageId: string;
  readonly title: string;
  readonly kind: 'reel' | 'scroll';
  /** Who sent it: the person's own words for themselves, the peer's name otherwise. */
  readonly by: string;
  readonly at: Date;
}

/**
 * The cards that were sent in this conversation, newest first (T3 "Shared here"). A card that was withdrawn or removed
 * is not listed. This is what the two people put in the chat themselves: nothing about what either of them opened or read.
 */
export function sharedHere(messages: readonly ConversationMessage[], peer: PublicPersonRef | undefined): SharedHere[] {
  const shared: SharedHere[] = [];
  for (const message of messages) {
    if (message.status !== 'available' || message.body.kind !== 'content') continue;
    const root = rootOfCard(message.body.content);
    if (root === undefined) continue;
    shared.push({
      messageId: message.messageId,
      title: root.metadata.title,
      kind: root.metadata.kind,
      by: message.author.personId === peer?.personId ? peer.displayName : 'You',
      at: new Date(message.recordedAt),
    });
  }
  return shared.reverse();
}
