import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import type { z } from 'zod';
import {
  apiContract,
  OwnPresencePreferenceSchema,
  OwnReadReceiptsSchema,
  PresencePreferenceAcceptanceSchema,
  ReadReceiptsAcceptanceSchema,
  SharingVisibilityAcceptanceSchema,
  SharingVisibilitySchema,
  VisitorWorldSnapshotSchema,
} from '@knowscroll/contracts';
import { VISIBILITY_USE_CASES, type SocialResult, type VisibilityUseCases } from '@knowscroll/backend/modules/social';
import { admittedCaller } from './scope-guard.js';
import { authorityOf, type Caller } from './callers.js';
import { socialProblem, socialRefusal } from './social-problems.js';

type Scoped = { scope: { accountId: string; privacyEpoch: number } };

/**
 * A refusal becomes its closed Social problem. An answer is parsed again and must name the caller's
 * own account and epoch, so a miswired adapter cannot hand one person another's settings.
 */
function answer<T extends Scoped>(caller: Caller, schema: z.ZodType<T>, result: SocialResult<unknown>): T {
  if (result.kind === 'refused') throw socialRefusal(result.code);
  const parsed = schema.safeParse(result.value);
  if (
    !parsed.success ||
    parsed.data.scope.accountId !== caller.accountId ||
    parsed.data.scope.privacyEpoch !== caller.privacyEpoch
  )
    throw socialProblem('INTERNAL');
  return parsed.data;
}

/**
 * `/v1/social/visibility`, `/v1/social/presence/preference`, `/v1/social/read-receipts` and
 * `/v1/social/visits/read`: what a person lets friends see, whether the people they talk with see how far
 * they have read, and a friend's visit. Handlers only map outcomes; every use case rechecks
 * authority itself. Nothing here is cached, and a visit answer for someone who may not see the
 * universe is the same `unavailable` snapshot whatever the reason.
 */
@Controller()
export class VisibilityController {
  constructor(@Inject(VISIBILITY_USE_CASES) private readonly useCases: VisibilityUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.visibility)
  visibilityRoute(@Req() request: Request) {
    return implement(apiContract.sharing.visibility).handler(async () => {
      const caller = admittedCaller(request);
      return answer(caller, SharingVisibilitySchema, await this.useCases.readVisibility(authorityOf(caller)));
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.setVisibility)
  setVisibilityRoute(@Req() request: Request) {
    return implement(apiContract.sharing.setVisibility).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const accepted = answer(
        caller,
        SharingVisibilityAcceptanceSchema,
        await this.useCases.setVisibility(authorityOf(caller), input),
      );
      if (
        accepted.commandId !== input.commandId ||
        accepted.baseVisibilityRevision !== input.expectedVisibilityRevision
      )
        throw socialProblem('INTERNAL');
      return accepted;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.presencePreference)
  presencePreferenceRoute(@Req() request: Request) {
    return implement(apiContract.sharing.presencePreference).handler(async () => {
      const caller = admittedCaller(request);
      return answer(
        caller,
        OwnPresencePreferenceSchema,
        await this.useCases.readPresencePreference(authorityOf(caller)),
      );
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.setPresencePreference)
  setPresencePreferenceRoute(@Req() request: Request) {
    return implement(apiContract.sharing.setPresencePreference).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const accepted = answer(
        caller,
        PresencePreferenceAcceptanceSchema,
        await this.useCases.setPresencePreference(authorityOf(caller), input),
      );
      if (
        accepted.commandId !== input.commandId ||
        accepted.basePresencePreferenceRevision !== input.expectedPresencePreferenceRevision
      )
        throw socialProblem('INTERNAL');
      return accepted;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.readReceipts)
  readReceiptsRoute(@Req() request: Request) {
    return implement(apiContract.sharing.readReceipts).handler(async () => {
      const caller = admittedCaller(request);
      return answer(caller, OwnReadReceiptsSchema, await this.useCases.readOwnReadReceipts(authorityOf(caller)));
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.setReadReceipts)
  setReadReceiptsRoute(@Req() request: Request) {
    return implement(apiContract.sharing.setReadReceipts).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const accepted = answer(
        caller,
        ReadReceiptsAcceptanceSchema,
        await this.useCases.setReadReceipts(authorityOf(caller), input),
      );
      if (
        accepted.commandId !== input.commandId ||
        accepted.baseReadReceiptsRevision !== input.expectedReadReceiptsRevision
      )
        throw socialProblem('INTERNAL');
      return accepted;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.sharing.visit)
  visitRoute(@Req() request: Request) {
    return implement(apiContract.sharing.visit).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const snapshot = answer(
        caller,
        VisitorWorldSnapshotSchema,
        await this.useCases.readVisit(authorityOf(caller), input),
      );
      // The answer must be about the person asked for, never another: the schema binds an available
      // owner to the target, and an unavailable answer carries only the target it was asked about.
      if (JSON.stringify(snapshot.target) !== JSON.stringify(input.target)) throw socialProblem('INTERNAL');
      return snapshot;
    });
  }
}
