import {
  FriendPairResultSchema,
  LookupSharingPersonSchema,
  ReadFriendPairSchema,
  SharingPersonLookupSchema,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { atTime, sideOf, type Pair } from '../domain/friends.js';
import { availabilityOf, type Availability } from '../domain/presence.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
/** `availability` is what the peer lets this friend see; it is read only for a friendship that is current. */
export function publicPair(
  pair: Pair | undefined,
  actor: string,
  peer: PublicPersonRef,
  now: number,
  availability: Availability = { state: 'unknown' },
) {
  if (!pair) return { state: 'none' as const, peer, pairRevision: 0 };
  const current = atTime(pair, now),
    own = sideOf(current, actor);
  if ((own.state === 'incoming' || own.state === 'outgoing') && current.window)
    return { state: own.state, peer, pairRevision: own.revision, requestId: current.window.id };
  if (own.state === 'friends') return { state: 'friends' as const, peer, pairRevision: own.revision, availability };
  return { state: own.state, peer, pairRevision: own.revision };
}
export function makeLookupPerson(p: SocialPorts) {
  return async (
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof SharingPersonLookupSchema>>> => {
    const parsed = LookupSharingPersonSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const result = await p.withScope(
      authority,
      async (scope): Promise<Result<z.infer<typeof SharingPersonLookupSchema>>> => {
        const missing = () => ({
          kind: 'ok' as const,
          value: SharingPersonLookupSchema.parse({ ...ownEnvelope(scope), status: 'unavailable' }),
        });
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const candidate = await p.store.profile(scope, { handle: parsed.data.handle });
        if (!candidate || candidate.accountId === scope.authority.actor.accountId) return missing();
        const gate = await p.fencePair(scope, candidate.accountId);
        if (gate.kind !== 'active') return missing();
        const peer = await p.store.profile(scope, { handle: parsed.data.handle });
        if (!peer || peer.accountId !== candidate.accountId || peer.person.personId !== candidate.person.personId)
          return missing();
        const locked = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
        if (locked?.pair.sides.some((s) => s.blocked)) return missing();
        const view = publicPair(locked?.pair, gate.owner.accountId, peer.person, p.now().getTime());
        return {
          kind: 'ok',
          value: SharingPersonLookupSchema.parse({
            ...ownEnvelope(scope),
            status: 'available',
            person: peer.person,
            pairRevision: view.pairRevision,
          }),
        };
      },
    );
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
export function makeReadPair(p: SocialPorts) {
  return async (
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof FriendPairResultSchema>>> => {
    const parsed = ReadFriendPairSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const result = await p.withScope(
      authority,
      async (scope): Promise<Result<z.infer<typeof FriendPairResultSchema>>> => {
        const missing = () => ({
          kind: 'ok' as const,
          value: FriendPairResultSchema.parse({ ...ownEnvelope(scope), status: 'unavailable' }),
        });
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const candidate = await p.store.profile(scope, { personId: parsed.data.peerPersonId });
        if (!candidate || candidate.accountId === scope.authority.actor.accountId) return missing();
        const gate = await p.fencePair(scope, candidate.accountId);
        if (gate.kind !== 'active') return missing();
        const peer = await p.store.profile(scope, { personId: parsed.data.peerPersonId });
        if (!peer || peer.accountId !== candidate.accountId) return missing();
        const locked = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
        const now = p.now().getTime();
        const peerSettings = locked ? await p.visibility.settings(locked.shared, gate.peer.accountId) : undefined;
        const peerPresence = locked ? await p.visibility.presence(locked.shared, gate.peer.accountId) : undefined;
        const availability = availabilityOf(peerSettings?.presencePreference ?? 'hidden', peerPresence, now);
        const view = publicPair(locked?.pair, gate.owner.accountId, peer.person, now, availability);
        // Preserve a pending sender projection even after a private peer block; it conveys no access.
        if (
          locked &&
          !sideOf(locked.pair, gate.owner.accountId).blocked &&
          locked.pair.sides.some((s) => s.blocked) &&
          view.state !== 'outgoing'
        )
          return missing();
        return {
          kind: 'ok',
          value: FriendPairResultSchema.parse({ ...ownEnvelope(scope), status: 'available', pair: view }),
        };
      },
    );
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
