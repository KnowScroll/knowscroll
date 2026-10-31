import { inviteStatus } from '../domain/invites.js';
import {
  AcceptFriendSchema,
  BlockFriendSchema,
  CancelFriendRequestSchema,
  DeclineFriendSchema,
  FriendCommandAcceptanceSchema,
  RemoveFriendSchema,
  RequestFriendSchema,
  UnblockFriendSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { apply, atTime, replayAllowed, sideOf, type Operation } from '../domain/friends.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
import type { FriendCommandAcceptance } from '@knowscroll/contracts';
const schemas = {
  request: RequestFriendSchema,
  accept: AcceptFriendSchema,
  decline: DeclineFriendSchema,
  cancel: CancelFriendRequestSchema,
  remove: RemoveFriendSchema,
  block: BlockFriendSchema,
  unblock: UnblockFriendSchema,
};
export function makePairCommand(p: SocialPorts) {
  return async (
    authority: PersonalAuthority,
    operation: Operation,
    input: unknown,
  ): Promise<Result<FriendCommandAcceptance>> => {
    const parsed = schemas[operation].safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const selectedPerson = 'expectedPeerPersonId' in command ? command.expectedPeerPersonId : command.peerPersonId;
    try {
      const result = await p.withScope(authority, async (scope): Promise<Result<FriendCommandAcceptance>> => {
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const candidate = await p.store.profile(scope, { personId: selectedPerson });
        if (!candidate || candidate.accountId === scope.authority.actor.accountId) return refuse('unavailable');
        const gate = await p.fencePair(scope, candidate.accountId);
        if (gate.kind !== 'active') return refuse('unavailable');
        if (
          (operation === 'request' || operation === 'accept') &&
          !(await p.store.profile(scope, { accountId: gate.owner.accountId }))
        )
          return refuse('unavailable');
        const peer = await p.store.profile(scope, { personId: selectedPerson });
        if (
          !peer ||
          peer.accountId !== gate.peer.accountId ||
          ('target' in command && command.target.kind === 'handle' && peer.person.handle !== command.target.handle)
        )
          return refuse('unavailable');
        if ('target' in command && command.target.kind === 'invite') {
          const invite = await p.invites.read(scope, { tokenHash: p.digest(command.target.token) });
          if (
            !invite ||
            invite.accountId !== gate.peer.accountId ||
            inviteStatus(invite, p.now().getTime()) !== 'active'
          )
            return refuse('unavailable');
        }
        const locked = await p.store.lockPair(
          scope,
          gate.owner.accountId,
          gate.peer.accountId,
          operation === 'request' || operation === 'block',
        );
        if (!locked) return refuse('unavailable');
        const now = p.now(),
          pair = atTime(locked.pair, now.getTime());
        const binding = await p.store.binding(locked, gate.owner.accountId, operation, command.commandId);
        // Epoch AND grant-lineage admission precede receipt lookup. Current peer epochs are
        // checked by Identity, but are never hashed into a sender-visible replay distinction.
        if (
          binding &&
          (binding.epoch !== scope.authority.privacyEpoch ||
            !replayAllowed(pair, gate.owner.accountId, operation, binding.lineage, now.getTime()))
        )
          return refuse('unavailable');
        const key = {
          commandId: command.commandId,
          operation: `social.friend-${operation}`,
          outcomeVersion: 1,
          requestHash: p.hash(`social.friend-${operation}`, {
            ...command,
            ...('target' in command && command.target.kind === 'invite'
              ? { target: { kind: 'invite', tokenHash: p.digest(command.target.token) } }
              : {}),
            actorPrivacyEpoch: scope.authority.privacyEpoch,
          }),
        };
        const receipt = await p.store.findReceipt(locked, key);
        if (receipt.kind === 'refused') return receipt;
        if (receipt.kind === 'replay') {
          if (!binding) return refuse('unavailable');
          return {
            kind: 'ok',
            value: FriendCommandAcceptanceSchema.parse({
              ...FriendCommandAcceptanceSchema.parse(receipt.outcome),
              replayed: true,
            }),
          };
        }
        if (binding) return refuse('unavailable');
        const base = sideOf(pair, gate.owner.accountId).revision;
        const decision = apply(
          pair,
          {
            actor: gate.owner.accountId,
            operation,
            expected: command.expectedPairRevision,
            ...('requestId' in command && typeof command.requestId === 'string'
              ? { requestId: command.requestId }
              : {}),
          },
          now.getTime(),
          p.newId(),
        );
        if (decision.kind === 'refused') return decision;
        const value = FriendCommandAcceptanceSchema.parse({
          ...ownEnvelope(scope),
          commandId: command.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: `friend.${operation}`,
          peerPersonId: selectedPerson,
          basePairRevision: base,
          acceptedPairRevision: sideOf(decision.pair, gate.owner.accountId).revision,
        });
        await p.store.beginReceipt(locked, key);
        await p.store.savePair(locked, decision.pair);
        // A friendship that begins or ends takes neither person's choice of the other with it, so an
        // old "may visit" can never come back with a new friendship (D-047).
        if (operation === 'accept' || operation === 'remove' || operation === 'block') {
          await p.visibility.forgetChoiceBetween(locked.shared, gate.owner.accountId, gate.peer.accountId);
          await p.store.forgetPlacesBetween(locked, gate.owner.accountId, gate.peer.accountId);
        }
        await p.store.bind(locked, gate.owner.accountId, operation, command.commandId, {
          epoch: scope.authority.privacyEpoch,
          lineage: decision.lineage,
        });
        await p.store.receipt(locked, key, value);
        return { kind: 'ok', value };
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    } catch (error) {
      if (error instanceof Error && error.message === 'SOCIAL_COUNTER_EXHAUSTED') return refuse('counter_exhausted');
      throw error;
    }
  };
}
