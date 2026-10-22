import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { z } from 'zod';
import type { Request } from 'express';
import {
  apiContract,
  FriendsPageSchema,
  FriendRequestsPageSchema,
  OwnFriendInvitesSchema,
  CreateFriendInviteResultSchema,
  FriendInviteAcceptanceSchema,
  ResolvedFriendInviteSchema,
  OwnSharingProfileSchema,
  SharingProfileAcceptanceSchema,
  SharingPersonLookupSchema,
  FriendPairResultSchema,
  FriendCommandAcceptanceSchema,
  type FriendCommandAcceptance,
} from '@knowscroll/contracts';
import {
  SOCIAL_USE_CASES,
  type SocialUseCases,
  type SocialResult,
  type FriendOperation,
} from '@knowscroll/backend/modules/social';
import { admittedCaller } from './scope-guard.js';
import { authorityOf, type Caller } from './callers.js';
import { socialProblem, socialRefusal } from './social-problems.js';

type Scoped = { scope: { accountId: string; privacyEpoch: number } };
/** Parse before returning; even a miswired adapter cannot substitute a different scope or selector. */
function output<T extends Scoped>(
  caller: Caller,
  schema: z.ZodType<T>,
  result: SocialResult<unknown>,
  binds: (value: T) => boolean = () => true,
): T {
  if (result.kind === 'refused') throw socialRefusal(result.code);
  const parsed = schema.safeParse(result.value);
  if (
    !parsed.success ||
    parsed.data.scope.accountId !== caller.accountId ||
    parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
    !binds(parsed.data)
  )
    throw socialProblem('INTERNAL');
  return parsed.data;
}

/** Only the eleven already implemented explicit profile/pair routes. No declared-only fallbacks. */
@Controller()
export class SocialController {
  constructor(@Inject(SOCIAL_USE_CASES) private readonly useCases: SocialUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.profile)
  profileRoute(@Req() request: Request) {
    return implement(apiContract.sharing.profile).handler(async () => {
      const caller = admittedCaller(request);
      return output(caller, OwnSharingProfileSchema, await this.useCases.readProfile(authorityOf(caller)));
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.setProfile)
  setProfileRoute(@Req() request: Request) {
    return implement(apiContract.sharing.setProfile).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        SharingProfileAcceptanceSchema,
        await this.useCases.setProfile(authorityOf(caller), input),
        (value) => value.commandId === input.commandId && value.baseProfileRevision === input.expectedProfileRevision,
      );
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.lookup)
  lookupRoute(@Req() request: Request) {
    return implement(apiContract.sharing.lookup).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        SharingPersonLookupSchema,
        await this.useCases.lookup(authorityOf(caller), input),
        (value) => value.status === 'unavailable' || value.person.handle === input.handle,
      );
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.pair)
  pairRoute(@Req() request: Request) {
    return implement(apiContract.sharing.pair).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        FriendPairResultSchema,
        await this.useCases.readPair(authorityOf(caller), input),
        (value) =>
          value.status === 'unavailable' || value.pair.peer.personId.toLowerCase() === input.peerPersonId.toLowerCase(),
      );
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.request)
  requestRoute(@Req() request: Request) {
    return implement(apiContract.sharing.request).handler(async ({ input }) =>
      this.friend(
        request,
        'request',
        input,
        input.expectedPeerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.request') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.accept)
  acceptRoute(@Req() request: Request) {
    return implement(apiContract.sharing.accept).handler(async ({ input }) =>
      this.friend(
        request,
        'accept',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.accept') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.decline)
  declineRoute(@Req() request: Request) {
    return implement(apiContract.sharing.decline).handler(async ({ input }) =>
      this.friend(
        request,
        'decline',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.decline') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.cancel)
  cancelRoute(@Req() request: Request) {
    return implement(apiContract.sharing.cancel).handler(async ({ input }) =>
      this.friend(
        request,
        'cancel',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.cancel') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.remove)
  removeRoute(@Req() request: Request) {
    return implement(apiContract.sharing.remove).handler(async ({ input }) =>
      this.friend(
        request,
        'remove',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.remove') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.block)
  blockRoute(@Req() request: Request) {
    return implement(apiContract.sharing.block).handler(async ({ input }) =>
      this.friend(
        request,
        'block',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.block') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.unblock)
  unblockRoute(@Req() request: Request) {
    return implement(apiContract.sharing.unblock).handler(async ({ input }) =>
      this.friend(
        request,
        'unblock',
        input,
        input.peerPersonId,
        FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.unblock') }),
      ),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.invites)
  invitesRoute(@Req() request: Request) {
    return implement(apiContract.sharing.invites).handler(async () => {
      const caller = admittedCaller(request);
      return output(caller, OwnFriendInvitesSchema, await this.useCases.readInvites(authorityOf(caller)));
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.createInvite)
  createInviteRoute(@Req() request: Request) {
    return implement(apiContract.sharing.createInvite).handler(async ({ input }) => {
      const caller = admittedCaller(request),
        result = await this.useCases.createInvite(authorityOf(caller), input);
      if (result.kind === 'refused') throw socialRefusal(result.code);
      const parsed = CreateFriendInviteResultSchema.safeParse(result.value);
      if (!parsed.success) throw socialProblem('INTERNAL');
      output(
        caller,
        FriendInviteAcceptanceSchema,
        { kind: 'ok', value: parsed.data.acceptance },
        (v) =>
          v.operation === 'invite.create' &&
          v.commandId === input.commandId &&
          v.baseInviteRevision === input.expectedInviteRevision,
      );
      return parsed.data;
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.revokeInvite)
  revokeInviteRoute(@Req() request: Request) {
    return implement(apiContract.sharing.revokeInvite).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        FriendInviteAcceptanceSchema.safeExtend({ operation: z.literal('invite.revoke') }),
        await this.useCases.revokeInvite(authorityOf(caller), input),
        (v) =>
          v.commandId === input.commandId &&
          v.linkId.toLowerCase() === input.linkId.toLowerCase() &&
          v.baseInviteRevision === input.expectedInviteRevision,
      );
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.resolveInvite)
  resolveInviteRoute(@Req() request: Request) {
    return implement(apiContract.sharing.resolveInvite).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(caller, ResolvedFriendInviteSchema, await this.useCases.resolveInvite(authorityOf(caller), input));
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.friendPages.friends)
  friendsPageRoute(@Req() request: Request) {
    return implement(apiContract.friendPages.friends).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        FriendsPageSchema,
        await this.useCases.readFriends(authorityOf(caller), input),
        (v) =>
          v.requestId === input.requestId &&
          v.filter === input.filter &&
          v.items.length <= input.limit &&
          (!input.cursor || v.snapshotRevision === input.cursor.snapshotRevision) &&
          (!v.next || v.next.token !== input.cursor?.token),
      );
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.friendPages.requests)
  requestsPageRoute(@Req() request: Request) {
    return implement(apiContract.friendPages.requests).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      return output(
        caller,
        FriendRequestsPageSchema,
        await this.useCases.readRequests(authorityOf(caller), input),
        (v) =>
          v.requestId === input.requestId &&
          v.filter === input.filter &&
          v.items.length <= input.limit &&
          (!input.cursor || v.snapshotRevision === input.cursor.snapshotRevision) &&
          (!v.next || v.next.token !== input.cursor?.token),
      );
    });
  }
  private async friend<T extends FriendCommandAcceptance>(
    request: Request,
    operation: FriendOperation,
    input: { commandId: string; expectedPairRevision: number },
    peerPersonId: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const caller = admittedCaller(request);
    return output(
      caller,
      schema,
      await this.useCases.command(authorityOf(caller), operation, input),
      (value) =>
        value.commandId === input.commandId &&
        value.peerPersonId === peerPersonId &&
        value.basePairRevision === input.expectedPairRevision,
    );
  }
}
