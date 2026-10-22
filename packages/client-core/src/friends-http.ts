import {
  ReadOwnSharingProfileSchema,
  OwnSharingProfileSchema,
  SetSharingProfileSchema,
  SharingProfileAcceptanceSchema,
  LookupSharingPersonSchema,
  SharingPersonLookupSchema,
  ReadFriendPairSchema,
  FriendPairResultSchema,
  ReadFriendsPageSchema,
  ReadFriendRequestsPageSchema,
  FriendsPageSchema,
  FriendRequestsPageSchema,
  RequestFriendSchema,
  AcceptFriendSchema,
  DeclineFriendSchema,
  CancelFriendRequestSchema,
  RemoveFriendSchema,
  BlockFriendSchema,
  UnblockFriendSchema,
  FriendCommandAcceptanceSchema,
  ReadOwnFriendInvitesSchema,
  OwnFriendInvitesSchema,
  CreateFriendInviteSchema,
  CreateFriendInviteResultSchema,
  RevokeFriendInviteSchema,
  FriendInviteAcceptanceSchema,
  ResolveFriendInviteSchema,
  ResolvedFriendInviteSchema,
} from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';
import type { FriendsFailure, FriendsInput, FriendsOperation, FriendsOutput } from './friends-types';

const inputs = {
  profile: ReadOwnSharingProfileSchema,
  setProfile: SetSharingProfileSchema,
  lookup: LookupSharingPersonSchema,
  pair: ReadFriendPairSchema,
  friends: ReadFriendsPageSchema,
  requests: ReadFriendRequestsPageSchema,
  request: RequestFriendSchema,
  accept: AcceptFriendSchema,
  decline: DeclineFriendSchema,
  cancel: CancelFriendRequestSchema,
  remove: RemoveFriendSchema,
  block: BlockFriendSchema,
  unblock: UnblockFriendSchema,
  invites: ReadOwnFriendInvitesSchema,
  createInvite: CreateFriendInviteSchema,
  revokeInvite: RevokeFriendInviteSchema,
  resolveInvite: ResolveFriendInviteSchema,
};
const outputs = {
  profile: OwnSharingProfileSchema,
  setProfile: SharingProfileAcceptanceSchema,
  lookup: SharingPersonLookupSchema,
  pair: FriendPairResultSchema,
  friends: FriendsPageSchema,
  requests: FriendRequestsPageSchema,
  request: FriendCommandAcceptanceSchema,
  accept: FriendCommandAcceptanceSchema,
  decline: FriendCommandAcceptanceSchema,
  cancel: FriendCommandAcceptanceSchema,
  remove: FriendCommandAcceptanceSchema,
  block: FriendCommandAcceptanceSchema,
  unblock: FriendCommandAcceptanceSchema,
  invites: OwnFriendInvitesSchema,
  createInvite: CreateFriendInviteResultSchema,
  revokeInvite: FriendInviteAcceptanceSchema,
  resolveInvite: ResolvedFriendInviteSchema,
};
const wireOperations = {
  setProfile: 'profile.set',
  request: 'friend.request',
  accept: 'friend.accept',
  decline: 'friend.decline',
  cancel: 'friend.cancel',
  remove: 'friend.remove',
  block: 'friend.block',
  unblock: 'friend.unblock',
  createInvite: 'invite.create',
  revokeInvite: 'invite.revoke',
} as const;
export const FRIENDS_LIMITS = Object.freeze({ pageItems: 50, previousCursors: 8, responseBytes: 65536 });
/** Coarse safe reason only; never retain a received body, token, path, error or peer cause. */
export class FriendsHttpError extends Error {
  constructor(
    readonly reason: FriendsFailure,
    readonly ambiguous: boolean,
  ) {
    super('Friends request unavailable');
  }
}
export function freezeFriends<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeFriends);
    Object.freeze(value);
  }
  return value;
}
/** Semantic comparison of schema-validated UUID references only; never changes wire/retry bytes. */
export function sameFriendsId(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}
function sameScope(scope: AccountScope, value: { accountId: string; privacyEpoch: number }): boolean {
  return sameFriendsId(value.accountId, scope.account.accountId) && value.privacyEpoch === scope.account.privacyEpoch;
}
function bound(
  scope: AccountScope,
  operation: FriendsOperation,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): boolean {
  const receipt = operation === 'createInvite' ? (output.acceptance as Record<string, unknown>) : output;
  if (!sameScope(scope, receipt.scope as { accountId: string; privacyEpoch: number })) return false;
  if (operation in wireOperations) {
    if (
      receipt.commandId !== input.commandId ||
      receipt.operation !== wireOperations[operation as keyof typeof wireOperations]
    )
      return false;
    if (operation === 'setProfile') return receipt.baseProfileRevision === input.expectedProfileRevision;
    if (operation === 'createInvite' || operation === 'revokeInvite')
      return (
        receipt.baseInviteRevision === input.expectedInviteRevision &&
        (operation !== 'revokeInvite' || sameFriendsId(receipt.linkId, input.linkId))
      );
    return (
      sameFriendsId(receipt.peerPersonId, operation === 'request' ? input.expectedPeerPersonId : input.peerPersonId) &&
      receipt.basePairRevision === input.expectedPairRevision
    );
  }
  if (operation === 'lookup' && output.status === 'available')
    return (output.person as { handle: string }).handle === input.handle;
  if (operation === 'pair' && output.status === 'available')
    return sameFriendsId((output.pair as { peer: { personId: string } }).peer.personId, input.peerPersonId);
  if (operation === 'friends' || operation === 'requests') {
    const page = output as unknown as FriendsOutput<'friends'>;
    const cursor = input.cursor as FriendsInput<'friends'>['cursor'];
    return (
      page.requestId === input.requestId &&
      page.filter === input.filter &&
      page.items.length <= Number(input.limit) &&
      (!cursor ||
        (sameScope(scope, cursor.scope) &&
          page.snapshotRevision === cursor.snapshotRevision &&
          page.next?.token !== cursor.token))
    );
  }
  return true;
}
/** Actual scope.api transport; pure reads and one explicit send, with no retry/cache/storage. */
export function createFriendsHttp(scope: AccountScope) {
  function prepare<K extends FriendsOperation>(operation: K, input: FriendsInput<K>): FriendsInput<K> {
    const parsed = inputs[operation].safeParse(input);
    if (!parsed.success) throw new FriendsHttpError('invalid', false);
    if ('cursor' in parsed.data && parsed.data.cursor && !sameScope(scope, parsed.data.cursor.scope))
      throw new FriendsHttpError('invalid', false);
    return freezeFriends(parsed.data as FriendsInput<K>);
  }
  return {
    prepare,
    async call<K extends FriendsOperation>(
      operation: K,
      input: FriendsInput<K>,
      signal?: AbortSignal,
    ): Promise<FriendsOutput<K>> {
      if (!scope.active || signal?.aborted) throw new FriendsHttpError('authority', false);
      const prepared = prepare(operation, input);
      let raw: unknown;
      try {
        const method = (
          operation === 'friends' || operation === 'requests'
            ? scope.api.friendPages[operation]
            : scope.api.sharing[operation]
        ) as (body: FriendsInput<K>, options: { signal?: AbortSignal }) => Promise<unknown>;
        raw = await method(prepared, signal ? { signal } : {});
      } catch (error) {
        if (!scope.active || signal?.aborted) throw new FriendsHttpError('authority', true);
        const problem = apiProblem(error);
        const authority =
          problem &&
          ['UNAUTHENTICATED', 'FORBIDDEN', 'SCOPE_MISMATCH', 'PRIVACY_EPOCH_CHANGED', 'UNIVERSE_UNAVAILABLE'].includes(
            problem.code,
          );
        const reason: FriendsFailure = authority
          ? 'authority'
          : problem?.code === 'SHARING_REVISION_STALE'
            ? 'refresh_required'
            : problem?.code === 'CONFLICT' || problem?.code === 'COMMAND_KEY_REUSED'
              ? 'conflict'
              : problem
                ? 'unavailable'
                : 'network';
        throw new FriendsHttpError(reason, !problem || problem.status >= 500);
      }
      if (!scope.active || signal?.aborted) throw new FriendsHttpError('authority', true);
      try {
        // Accepted decoded-data ceiling only, not a pre-decode allocation guarantee.
        if (new TextEncoder().encode(JSON.stringify(raw)).length > FRIENDS_LIMITS.responseBytes) throw new Error();
        const parsed = outputs[operation].safeParse(raw);
        if (!parsed.success || !bound(scope, operation, prepared, parsed.data)) throw new Error();
        return freezeFriends(parsed.data as FriendsOutput<K>);
      } catch {
        throw new FriendsHttpError('invalid', true);
      }
    },
  };
}
