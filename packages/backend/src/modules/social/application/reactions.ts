import type { MessageReactionKind } from '@knowscroll/contracts';
import type { ConversationStore } from './conversation-ports.js';
import { refuse, type Result, type SharedLock } from './ports.js';

/**
 * The message a reply answers. It must be a message of the same conversation (the store looks the
 * ID up inside it, so another conversation's message is simply not found) and not a tombstone.
 * Every refusal is the same `unavailable`, so nothing is learned about other conversations.
 */
export async function resolveReplyTarget(
  store: ConversationStore,
  lock: SharedLock,
  conversationId: string,
  replyTo: string | undefined,
): Promise<Result<number | undefined>> {
  if (replyTo === undefined) return { kind: 'ok', value: undefined };
  const target = await store.messageRef(lock, conversationId, replyTo);
  if (target === undefined || target.removed) return refuse('unavailable');
  return { kind: 'ok', value: target.sequence };
}

/** What a reaction command will do: whether the wanted state differs from the current one, and the write. */
export interface ReactionPlan {
  readonly changed: boolean;
  apply(): Promise<void>;
}

/**
 * Plans one reaction change under the conversation's lock. A message that is not in this
 * conversation, or was removed, is `unavailable`. A reaction already in the wanted state changes
 * nothing, so a repeat (a retry, a second tap, another device) is idempotent whatever its command ID.
 */
export async function planReaction(
  store: ConversationStore,
  lock: SharedLock,
  input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly accountId: string;
    readonly kind: MessageReactionKind;
    readonly present: boolean;
    readonly now: Date;
  },
): Promise<Result<ReactionPlan>> {
  const target = await store.messageRef(lock, input.conversationId, input.messageId);
  if (target === undefined || target.removed) return refuse('unavailable');
  const reaction = {
    conversationId: input.conversationId,
    sequence: target.sequence,
    accountId: input.accountId,
    kind: input.kind,
  };
  const held = await store.hasReaction(lock, reaction);
  return {
    kind: 'ok',
    value: {
      changed: held !== input.present,
      apply: () => store.setReaction(lock, { ...reaction, present: input.present, now: input.now }),
    },
  };
}
