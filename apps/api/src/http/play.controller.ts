import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type {
  CallLockRefusal,
  PlayUseCases,
  ReadLandmarksResult,
  ReadOrbitResult,
  ReadResultsResult,
} from '@knowscroll/backend/modules/play';
import { PLAY_USE_CASES } from '../modules/play.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const lockProblems: Record<CallLockRefusal, ProblemCode> = {
  // A revision, a call and an exposure the caller does not have answer the same: a lock is no oracle.
  call_not_found: 'NOT_FOUND',
  exposure_required: 'NOT_FOUND',
  option_invalid: 'UNPROCESSABLE_REQUEST',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

const readProblems: Record<
  Extract<ReadResultsResult | ReadLandmarksResult | ReadOrbitResult, { kind: 'refused' }>['reason'],
  ProblemCode
> = {
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
};

/**
 * `/v1/play/*`: locking a call (a Call it or the Final call), and reading the person's own results,
 * landmarks and weekly Orbit (D-180, D-187, D-188, D-215). Handlers only
 * authenticate (the scope guard already admitted the caller) and map the use cases' outcomes; each
 * use case rechecks authority. Every answer is private to the caller and none is cacheable.
 */
@Controller()
export class PlayController {
  constructor(@Inject(PLAY_USE_CASES) private readonly play: PlayUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.play.lockCall)
  lockCallRoute(@Req() request: Request) {
    return implement(apiContract.play.lockCall).handler(async ({ input }) => {
      const result = await this.play.lockCall(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(lockProblems[result.reason]);
      return result.outcome;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.play.readResults)
  readResultsRoute(@Req() request: Request) {
    return implement(apiContract.play.readResults).handler(async ({ input }) => {
      const result = await this.play.readResults(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(readProblems[result.reason]);
      return result.results;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.play.readLandmarks)
  readLandmarksRoute(@Req() request: Request) {
    return implement(apiContract.play.readLandmarks).handler(async () => {
      const result = await this.play.readLandmarks(authorityOf(admittedCaller(request)));
      if (result.kind === 'refused') throw problem(readProblems[result.reason]);
      return { landmarks: result.landmarks };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.play.readOrbit)
  readOrbitRoute(@Req() request: Request) {
    return implement(apiContract.play.readOrbit).handler(async ({ input }) => {
      const result = await this.play.readOrbit(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(readProblems[result.reason]);
      return { orbit: result.orbit };
    });
  }
}
