import type { DirectConversationRef } from '@knowscroll/contracts';
import type { AccountAccess, PersonalScopeTx } from '../../identity/public.js';
import type { Conversation, ConversationPorts, ConversationReader } from './conversation-ports.js';
import type { PairLock } from './ports.js';

/** A conversation the caller may act in: gates passed and its rows loaded under the right lock. */
export interface EnteredConversation extends Conversation {
  /** Where its rows are read and the caller's own member row changed. */
  readonly reader: ConversationReader;
  /** The friendship's pair lock. Absent after the other person's account was deleted: no friendship remains. */
  readonly lock: PairLock | undefined;
  readonly owner: AccountAccess;
  readonly peerAccess: AccountAccess | undefined;
}

/**
 * Enters one conversation inside the caller's personal scope, in the lock order of the blueprint:
 * the caller's membership is found without locks (to learn the other person), both accounts are
 * gated, the friendship's pair root is locked, and then everything is read again under that lock.
 *
 * The one exception is a conversation whose other person deleted their account (D-043): their
 * membership and the friendship are gone, the conversation is closed, and its history stays
 * readable to the person who remains. There is nothing to lock then, so the caller's own scope is
 * the reader and only the caller's own row can change.
 *
 * It answers `undefined`, and nothing else, for every refusal: not a member, a stale membership
 * reference, either account inactive, the friendship ended or blocked by either side (the
 * conversation lives only while the friendship lineage it began under does), or the caller
 * having left. Callers cannot tell these apart, so no block or membership leaks.
 */
export async function enterConversation(
  p: ConversationPorts,
  scope: PersonalScopeTx,
  ref: DirectConversationRef,
): Promise<EnteredConversation | undefined> {
  const actor = scope.authority.actor;
  if (actor.kind !== 'account') return undefined;
  const found = await p.conversations.ownMembership(scope, actor.accountId, ref.conversationId);
  if (!found) return undefined;
  const sameMembership = (own: { membershipId: string; membershipRevision: number; left: boolean }) =>
    !own.left && own.membershipId === ref.membershipId && own.membershipRevision === ref.membershipRevision;
  if (found.peerAccountId === undefined) {
    const gate = await p.fenceOwn(scope);
    if (gate.kind !== 'active') return undefined;
    const loaded = await p.conversations.load(scope, ref.conversationId, gate.owner.accountId);
    if (!loaded || loaded.peer !== undefined || !loaded.conversation.closed || !sameMembership(loaded.own))
      return undefined;
    return { ...loaded, reader: scope, lock: undefined, owner: gate.owner, peerAccess: undefined };
  }
  const gate = await p.fencePair(scope, found.peerAccountId);
  if (gate.kind !== 'active') return undefined;
  const lock = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
  if (!lock) return undefined;
  const loaded = await p.conversations.load(lock, ref.conversationId, gate.owner.accountId);
  if (!loaded) return undefined;
  const { conversation, own } = loaded;
  const lineageStands = lock.pair.lineage !== null && lock.pair.lineage === conversation.lineage;
  if (!lineageStands || !sameMembership(own) || conversation.pairId !== lock.pair.id) return undefined;
  return { ...loaded, reader: lock, lock, owner: gate.owner, peerAccess: gate.peer };
}

export const refOf = (entered: Pick<Conversation, 'conversation' | 'own'>): DirectConversationRef => ({
  conversationId: entered.conversation.conversationId,
  membershipId: entered.own.membershipId,
  membershipRevision: entered.own.membershipRevision,
});
