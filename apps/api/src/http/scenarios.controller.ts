import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract } from '@knowscroll/contracts';
import {
  SCENARIO_USE_CASES,
  type ScenarioRefusal,
  type ScenarioResult,
  type ScenarioUseCases,
} from '@knowscroll/backend/modules/scenarios';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { socialProblem } from './social-problems.js';

/** A refusal becomes one of the closed Social problems; nothing else about why it was refused is said. */
function refusal(code: ScenarioRefusal) {
  switch (code) {
    case 'invalid_input':
      return socialProblem('INVALID_REQUEST');
    case 'stale_revision':
      return socialProblem('SHARING_REVISION_STALE');
    case 'command_key_reused':
      return socialProblem('COMMAND_KEY_REUSED');
    // A cap is reached: the person's drafts of the day, the world's day of branches or the thread's branches.
    case 'budget_unavailable':
      return socialProblem('TOO_MANY_REQUESTS');
    // Nothing the thread rests on can be researched by code: the idea is well formed and cannot be made here.
    case 'unsupported':
      return socialProblem('UNPROCESSABLE_REQUEST');
    case 'unavailable':
      return socialProblem('SHARING_UNAVAILABLE');
  }
}

function value<T>(result: ScenarioResult<T>): T {
  if (result.kind === 'refused') throw refusal(result.code);
  return result.value;
}

/**
 * `/v1/social/scenarios/*`: What if and Another perspective inside a content thread. Handlers only
 * authenticate (the scope guard already admitted the caller) and map the use cases' outcomes;
 * membership, the parent's revision and the budget are rechecked inside each use case.
 */
@Controller()
export class ScenariosController {
  constructor(@Inject(SCENARIO_USE_CASES) private readonly useCases: ScenarioUseCases) {}

  private authority(request: Request) {
    return authorityOf(admittedCaller(request));
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenarios.draft)
  draftRoute(@Req() request: Request) {
    return implement(apiContract.scenarios.draft).handler(async ({ input }) =>
      value(await this.useCases.draft(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenarios.readDraft)
  readDraftRoute(@Req() request: Request) {
    return implement(apiContract.scenarios.readDraft).handler(async ({ input }) =>
      value(await this.useCases.readDraft(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenarios.choose)
  chooseRoute(@Req() request: Request) {
    return implement(apiContract.scenarios.choose).handler(async ({ input }) =>
      value(await this.useCases.choose(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenarios.list)
  listRoute(@Req() request: Request) {
    return implement(apiContract.scenarios.list).handler(async ({ input }) =>
      value(await this.useCases.list(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenarios.remove)
  removeRoute(@Req() request: Request) {
    return implement(apiContract.scenarios.remove).handler(async ({ input }) =>
      value(await this.useCases.remove(this.authority(request), input)),
    );
  }
}
