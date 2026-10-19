import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ApplyAction, ApplyActionResult, ListSaved } from '@knowscroll/backend/modules/experience';
import { APPLY_ACTION, LIST_SAVED } from '../modules/experience.js';
import { CALLERS } from '../tokens.js';
import {
  authorityOf,
  scopeClaimMatches,
  scopeClaimOfRequest,
  type AuthenticatedCallers,
  type Caller,
} from './callers.js';
import { problem } from './problems.js';

const refusalProblems: Record<Extract<ApplyActionResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  asset_not_found: 'ASSET_NOT_FOUND',
  asset_revision_stale: 'ASSET_REVISION_STALE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

/** `POST /v1/actions` and `GET /v1/saved`: thin handlers over experience's use cases. */
@Controller()
export class ExperienceController {
  constructor(
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
    @Inject(APPLY_ACTION) private readonly applyAction: ApplyAction,
    @Inject(LIST_SAVED) private readonly listSaved: ListSaved,
  ) {}

  @Implement(apiContract.experience.applyAction)
  applyActionRoute(@Req() request: Request) {
    return implement(apiContract.experience.applyAction).handler(async ({ input }) => {
      const caller = await this.requireCaller(request);
      const result = await this.applyAction(authorityOf(caller), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return { commandId: input.commandId, replayed: result.replayed, ...result.outcome };
    });
  }

  @Implement(apiContract.experience.listSaved)
  listSavedRoute(@Req() request: Request) {
    return implement(apiContract.experience.listSaved).handler(async ({ input }) => {
      const caller = await this.requireCaller(request);
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

  /**
   * The authenticated caller, whose scope claim must name its account and current epoch (review
   * M1): a request of another scope is refused (`SCOPE_MISMATCH`) and never served.
   */
  private async requireCaller(request: Request): Promise<Caller> {
    const caller = await this.callers.resolve(request.headers);
    if (caller === undefined) throw problem('UNAUTHENTICATED');
    if (!scopeClaimMatches(caller, scopeClaimOfRequest(request.headers))) throw problem('SCOPE_MISMATCH');
    return caller;
  }
}
