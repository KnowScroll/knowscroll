import type { ContentThreadRef } from '@knowscroll/contracts';
import type { AccountAccess, PersonalScopeTx } from '../../identity/public.js';
import { canAnswerInvitation, canTakePart } from '../domain/threads.js';
import type { LoadedThread, ThreadLock, ThreadMember, ThreadPorts } from './thread-ports.js';

/** A thread the caller may act in: gates passed and its rows loaded under the thread's lock. */
export interface EnteredThread extends LoadedThread {
  readonly lock: ThreadLock;
  readonly owner: AccountAccess;
}

/** Who may enter: only members who take part, or also members whose invitation is still open. */
export type Entry = 'participant' | 'participant_or_invitee';

/**
 * Enters one thread inside the caller's personal scope, in the lock order of the blueprint: the
 * caller's account gate, then the thread's own root (FOR UPDATE for commands, FOR SHARE for reads),
 * then everything is read under that lock. The membership is first looked up without a lock so a
 * stranger can never queue on a thread.
 *
 * It answers `undefined`, and nothing else, for every refusal: not a member, a stale membership
 * reference, the account inactive, a place that no longer stands (the inviting friendship ended,
 * the member left or declined). Callers cannot tell these apart, so nothing leaks about why.
 */
export async function enterThread(
  p: ThreadPorts,
  scope: PersonalScopeTx,
  ref: ContentThreadRef,
  mode: 'write' | 'read',
  entry: Entry = 'participant',
): Promise<EnteredThread | undefined> {
  if (scope.authority.actor.kind !== 'account') return undefined;
  return enterOwnThread(p, scope, ref.threadId, mode, entry, (own) => {
    return own.membershipId === ref.membershipId && own.membershipRevision === ref.membershipRevision;
  });
}

/**
 * Enters a thread for a worker acting on behalf of a member (a system actor in the member's personal
 * scope), by the thread's ID rather than a membership reference a client holds. Every other gate is
 * `enterThread`'s: the member's account, their place in the thread and the lock order.
 */
export function enterThreadAsMember(
  p: ThreadPorts,
  scope: PersonalScopeTx,
  threadId: string,
  mode: 'write' | 'read',
): Promise<EnteredThread | undefined> {
  return enterOwnThread(p, scope, threadId, mode, 'participant', () => true);
}

async function enterOwnThread(
  p: ThreadPorts,
  scope: PersonalScopeTx,
  threadId: string,
  mode: 'write' | 'read',
  entry: Entry,
  holdsReference: (own: ThreadMember) => boolean,
): Promise<EnteredThread | undefined> {
  const gate = await p.fenceOwn(scope);
  if (gate.kind !== 'active') return undefined;
  if (!(await p.threads.isMember(scope, gate.owner.accountId, threadId))) return undefined;
  const lock = await p.threads.lock(scope, threadId, mode);
  if (!lock) return undefined;
  const loaded = await p.threads.load(lock, gate.owner.accountId);
  if (!loaded) return undefined;
  const { own } = loaded;
  const allowed = canTakePart(own) || (entry === 'participant_or_invitee' && canAnswerInvitation(own));
  return holdsReference(own) && allowed ? { ...loaded, lock, owner: gate.owner } : undefined;
}

export const threadRefOf = (entered: Pick<LoadedThread, 'thread' | 'own'>): ContentThreadRef => ({
  threadId: entered.thread.threadId,
  membershipId: entered.own.membershipId,
  membershipRevision: entered.own.membershipRevision,
});
