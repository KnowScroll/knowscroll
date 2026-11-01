import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import {
  ASK_QUICK_ANSWER,
  DISMISS_QUICK_ANSWER,
  READ_QUICK_ANSWER,
  type AskQuickAnswerUseCase,
  type DismissQuickAnswerUseCase,
  type QuickAnswerRefusal,
  type ReadQuickAnswerUseCase,
} from '@knowscroll/backend/modules/supply';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const refusalProblems: Record<QuickAnswerRefusal, ProblemCode> = {
  scope_refused: 'UNIVERSE_UNAVAILABLE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  receipt_unavailable: 'SERVICE_UNAVAILABLE',
  // The Scroll, the stop or the words are not ones the person has open.
  source_unavailable: 'ASSET_NOT_FOUND',
  // Unknown, dismissed, expired and another person's answer all read the same.
  not_found: 'NOT_FOUND',
  // An answer is tied to what the person is reading, so it needs recording on (D-254); a stale generation reads the policy again.
  recording_paused: 'RECORDING_PAUSED',
  recording_stale: 'RECORDING_POLICY_STALE',
};

/**
 * Quick answer commands (V3 D2, D-253): the HTTP side only stores the ask and reads its state. The answer is written by a
 * worker, so no handler here waits for a model. Every answer carries the person's own words, so none is cached.
 */
@Controller()
export class QuickAnswersController {
  constructor(
    @Inject(ASK_QUICK_ANSWER) private readonly ask: AskQuickAnswerUseCase,
    @Inject(READ_QUICK_ANSWER) private readonly read: ReadQuickAnswerUseCase,
    @Inject(DISMISS_QUICK_ANSWER) private readonly dismiss: DismissQuickAnswerUseCase,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.quickAnswers.ask)
  askRoute(@Req() request: Request) {
    return implement(apiContract.quickAnswers.ask).handler(async ({ input }) => {
      const result = await this.ask(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.quickAnswers.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.quickAnswers.read).handler(async ({ input }) => {
      const result = await this.read(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.quickAnswers.dismiss)
  dismissRoute(@Req() request: Request) {
    return implement(apiContract.quickAnswers.dismiss).handler(async ({ input }) => {
      const result = await this.dismiss(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }
}
