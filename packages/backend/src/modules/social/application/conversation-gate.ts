import type { DirectConversationRef } from '@knowscroll/contracts';
import type { AccountAccess, PersonalScopeTx } from '../../identity/public.js';
import type { Pair } from '../domain/friends.js';
import type { Conversation, ConversationPorts } from './conversation-ports.js';
import type { PairLock } from './ports.js';

/** A conversation the caller may act in: gates passed, friendship pair locked, rows loaded under that lock. */
export interface EnteredConversation extends Conversation {
  readonly lock: PairLock;
  readonly owner: AccountAccess;
  readonly peerAccess: AccountAccess;
  readonly pair: Pair;
}

/**
 * Enters one conversation inside the caller's personal scope, in the lock order of the blueprint:
 * the caller's membership is found without locks (to learn the peer), both accounts are gated,
 * the friendship's pair root is locked, and then everything is read again under that lock.
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
  const gate = await p.fencePair(scope, found.peerAccountId);
  if (gate.kind !== 'active') return undefined;
  const lock = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
  if (!lock) return undefined;
  const loaded = await p.conversations.load(lock, ref.conversationId, gate.owner.accountId);
  if (!loaded) return undefined;
  const { conversation, own } = loaded;
  const lineageStands = lock.pair.lineage !== null && lock.pair.lineage === conversation.lineage;
  const sameMembership = own.membershipId === ref.membershipId && own.membershipRevision === ref.membershipRevision;
  if (!lineageStands || own.left || !sameMembership || conversation.pairId !== lock.pair.id) return undefined;
  return { ...loaded, lock, owner: gate.owner, peerAccess: gate.peer, pair: lock.pair };
}

export const refOf = (entered: Pick<Conversation, 'conversation' | 'own'>): DirectConversationRef => ({
  conversationId: entered.conversation.conversationId,
  membershipId: entered.own.membershipId,
  membershipRevision: entered.own.membershipRevision,
});
