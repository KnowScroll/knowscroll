import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ReportRefusal, ReportUseCases } from '@knowscroll/backend/modules/feedback';
import type { NotInterestedRefusal, NotInterestedUseCases } from '@knowscroll/backend/modules/experience';
import { NOT_INTERESTED_USE_CASES } from '../modules/experience.js';
import { REPORT_USE_CASES } from '../modules/feedback.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const notInterestedProblems: Record<NotInterestedRefusal, ProblemCode> = {
  asset_not_found: 'ASSET_NOT_FOUND',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

const reportProblems: Record<ReportRefusal, ProblemCode> = {
  // A missing, forbidden and own target all answer the same, so a report is no oracle.
  target_unavailable: 'NOT_FOUND',
  too_many_reports: 'TOO_MANY_REQUESTS',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

/**
 * `/v1/feedback/*`: "Not interested" and its Undo, and reports to the safety team (P03, D-055).
 * Handlers only authenticate (the scope guard already admitted the caller) and map the use cases'
 * outcomes; each use case rechecks authority. No route returns a report, and every answer is private.
 */
@Controller()
export class FeedbackController {
  constructor(
    @Inject(NOT_INTERESTED_USE_CASES) private readonly notInterested: NotInterestedUseCases,
    @Inject(REPORT_USE_CASES) private readonly reports: ReportUseCases,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.feedback.notInterested)
  notInterestedRoute(@Req() request: Request) {
    return implement(apiContract.feedback.notInterested).handler(async ({ input }) => {
      const result = await this.notInterested.set(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(notInterestedProblems[result.reason]);
      return result.outcome;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.feedback.undoNotInterested)
  undoNotInterestedRoute(@Req() request: Request) {
    return implement(apiContract.feedback.undoNotInterested).handler(async ({ input }) => {
      const result = await this.notInterested.undo(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(notInterestedProblems[result.reason]);
      return result.outcome;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.feedback.reportContentError)
  reportContentErrorRoute(@Req() request: Request) {
    return implement(apiContract.feedback.reportContentError).handler(async ({ input }) => {
      const result = await this.reports.reportContentError(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(reportProblems[result.reason]);
      return result.outcome;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.feedback.reportAbuse)
  reportAbuseRoute(@Req() request: Request) {
    return implement(apiContract.feedback.reportAbuse).handler(async ({ input }) => {
      const result = await this.reports.reportAbuse(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(reportProblems[result.reason]);
      return result.outcome;
    });
  }
}
