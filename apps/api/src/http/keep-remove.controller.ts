import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import type { Request } from 'express';
import {
  apiContract,
  KeepRemovalAcceptanceSchema,
  KeepRemovalProblemSchema,
  problemDetails,
  type KeepRemovalProblem,
} from '@knowscroll/contracts';
import type { KeepRemovalUseCase } from '@knowscroll/backend/modules/experience';
import { KEEP_REMOVAL_USE_CASE } from '../modules/experience.js';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';

// The declared oRPC error data is the full closed problem, without privileged extensions.
function removalProblem(code: KeepRemovalProblem['code']) {
  const details = KeepRemovalProblemSchema.parse(problemDetails(code));
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
}

/** Removes only a named Saved membership; its historical ACK asserts no current absence. */
@Controller()
export class KeepRemoveController {
  constructor(@Inject(KEEP_REMOVAL_USE_CASE) private readonly removeEntry: KeepRemovalUseCase) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.keep.remove)
  removeRoute(@Req() request: Request) {
    return implement(apiContract.keep.remove).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.removeEntry(authorityOf(caller), input);
      if (result.kind === 'refused') {
        const closed = KeepRemovalProblemSchema.safeParse(problemDetails(result.code));
        throw removalProblem(closed.success ? closed.data.code : 'INTERNAL');
      }
      const parsed = KeepRemovalAcceptanceSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.scope.accountId !== caller.accountId ||
        parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
        parsed.data.commandId !== input.commandId ||
        parsed.data.entry.assetId !== input.entry.assetId ||
        parsed.data.entry.assetRevision !== input.entry.assetRevision ||
        parsed.data.entry.savedEntryId !== input.entry.savedEntryId
      )
        throw removalProblem('INTERNAL');
      return parsed.data;
    });
  }
}
