import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import type { Request } from 'express';
import {
  apiContract,
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusSchema,
  PrivacyProblemSchema,
  problemDetails,
  type PrivacyProblem,
} from '@knowscroll/contracts';
import type { ScopeRefusal } from '@knowscroll/backend/modules/identity';
import { CLEAR_EXPLORATION, type ClearExplorationUseCases } from '../modules/privacy.js';
import { admittedCaller } from './scope-guard.js';

function privacyProblem(code: PrivacyProblem['code']) {
  const details = PrivacyProblemSchema.parse(problemDetails(code));
  return new ORPCError(code, { status: details.status, message: details.title, data: details });
}
function scopeProblem(refusal: ScopeRefusal): PrivacyProblem['code'] {
  switch (refusal.kind) {
    case 'account_mismatch':
      return 'FORBIDDEN';
    case 'epoch_changed':
      return 'PRIVACY_EPOCH_CHANGED';
    case 'universe_missing':
    case 'universe_suspended':
      return 'UNIVERSE_UNAVAILABLE';
  }
}

/** Current authenticated scope remains required during the Clear barrier. */
@Controller()
export class PrivacyController {
  constructor(@Inject(CLEAR_EXPLORATION) private readonly clear: ClearExplorationUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.privacy.clearExploration)
  startRoute(@Req() request: Request) {
    return implement(apiContract.privacy.clearExploration).handler(async ({ input }) => {
      const { accountId, universeId, privacyEpoch } = admittedCaller(request);
      const result = await this.clear.start({ accountId, universeId, privacyEpoch }, input);
      if (result.kind === 'refused') throw privacyProblem(scopeProblem(result.refusal));
      if (result.value.kind === 'rejected') throw privacyProblem(result.value.code);
      const receipt = ClearExplorationAcceptanceSchema.safeParse(result.value.value);
      if (
        !receipt.success ||
        receipt.data.commandId !== input.commandId ||
        receipt.data.fromEpoch !== input.expectedPrivacyEpoch ||
        (!receipt.data.replayed && receipt.data.fromEpoch !== privacyEpoch) ||
        (receipt.data.replayed && receipt.data.toEpoch > privacyEpoch)
      )
        throw privacyProblem('INTERNAL');
      return receipt.data;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.privacy.readClearExplorationStatus)
  statusRoute(@Req() request: Request) {
    return implement(apiContract.privacy.readClearExplorationStatus).handler(async ({ input }) => {
      const { accountId, universeId, privacyEpoch } = admittedCaller(request);
      const result = await this.clear.status({ accountId, universeId, privacyEpoch }, input);
      if (result.kind === 'refused') throw privacyProblem(scopeProblem(result.refusal));
      if (result.value.kind === 'rejected') throw privacyProblem(result.value.code);
      const snapshot = ClearExplorationStatusSchema.safeParse(result.value.value);
      if (
        !snapshot.success ||
        snapshot.data.scope.accountId !== accountId ||
        snapshot.data.scope.privacyEpoch !== privacyEpoch ||
        snapshot.data.target.kind !== input.target.kind ||
        (input.target.kind === 'command' &&
          (snapshot.data.target.kind !== 'command' || snapshot.data.target.commandId !== input.target.commandId))
      )
        throw privacyProblem('INTERNAL');
      return snapshot.data;
    });
  }
}
