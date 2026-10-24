import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  CANCEL_CONTENT_REQUEST,
  type CreateRequest,
  type ReadRequest,
  type ListRequests,
  type CancelRequest,
  type Refusal,
} from '@knowscroll/backend/modules/supply';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const refusalProblems: Record<Refusal, ProblemCode> = {
  scope_refused: 'UNIVERSE_UNAVAILABLE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  receipt_unavailable: 'SERVICE_UNAVAILABLE',
  source_unavailable: 'ASSET_NOT_FOUND',
  stale_source: 'ASSET_REVISION_STALE',
  // Unknown and another person's request have the same answer.
  not_found: 'NOT_FOUND',
  // Too many asks are open at once: try again after one ends or is cancelled.
  too_many_open: 'TOO_MANY_REQUESTS',
};

/** Private demand commands: acceptance receipts and current status remain separate reads. */
@Controller()
export class SupplyController {
  constructor(
    @Inject(CREATE_CONTENT_REQUEST) private readonly createRequest: CreateRequest,
    @Inject(READ_CONTENT_REQUEST) private readonly readRequest: ReadRequest,
    @Inject(LIST_CONTENT_REQUESTS) private readonly listRequests: ListRequests,
    @Inject(CANCEL_CONTENT_REQUEST) private readonly cancelRequest: CancelRequest,
  ) {}

  @Implement(apiContract.supply.create)
  createRoute(@Req() request: Request) {
    return implement(apiContract.supply.create).handler(async ({ input }) => {
      const result = await this.createRequest(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }

  @Implement(apiContract.supply.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.supply.read).handler(async ({ input }) => {
      const result = await this.readRequest(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }

  @Implement(apiContract.supply.list)
  listRoute(@Req() request: Request) {
    return implement(apiContract.supply.list).handler(async () => {
      const result = await this.listRequests(authorityOf(admittedCaller(request)));
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }

  @Implement(apiContract.supply.cancel)
  cancelRoute(@Req() request: Request) {
    return implement(apiContract.supply.cancel).handler(async ({ input }) => {
      const result = await this.cancelRequest(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.value;
    });
  }
}
