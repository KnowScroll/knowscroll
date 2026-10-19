import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ApplyAction, ApplyActionResult, ListSaved } from '@knowscroll/backend/modules/experience';
import { APPLY_ACTION, LIST_SAVED } from '../modules/experience.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const refusalProblems: Record<Extract<ApplyActionResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  asset_not_found: 'ASSET_NOT_FOUND',
  asset_revision_stale: 'ASSET_REVISION_STALE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

/**
 * `POST /v1/actions` and `GET /v1/saved`: thin handlers over experience's use cases. The caller
 * is the one the scope guard admitted (`main.ts`: authenticated, scope claim matching).
 */
@Controller()
export class ExperienceController {
  constructor(
    @Inject(APPLY_ACTION) private readonly applyAction: ApplyAction,
    @Inject(LIST_SAVED) private readonly listSaved: ListSaved,
  ) {}

  @Implement(apiContract.experience.applyAction)
  applyActionRoute(@Req() request: Request) {
    return implement(apiContract.experience.applyAction).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.applyAction(authorityOf(caller), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return { commandId: input.commandId, replayed: result.replayed, ...result.outcome };
    });
  }

  @Implement(apiContract.experience.listSaved)
  listSavedRoute(@Req() request: Request) {
    return implement(apiContract.experience.listSaved).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.listSaved(authorityOf(caller), Number(input.limit ?? '50'));
      if (result.kind === 'refused')
        throw problem(result.reason === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
      return {
        revision: result.revision,
        items: result.items.map((item) => ({
          assetId: item.assetId,
          assetRevision: item.assetRevision,
          savedAt: item.savedAt.toISOString(),
        })),
      };
    });
  }
}
