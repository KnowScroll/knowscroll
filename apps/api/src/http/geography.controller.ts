import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import {
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  READ_OWN_EMERGING,
  type ReadOwnGeography,
  type ReadOwnDeltas,
  type ReadOwnEmerging,
} from '@knowscroll/backend/modules/geography';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

type ReadRefusal = Extract<Awaited<ReturnType<ReadOwnGeography>>, { kind: 'refused' }>['reason'];
const refusalProblems: Record<ReadRefusal, ProblemCode> = {
  scope_refused: 'UNIVERSE_UNAVAILABLE',
  // A foreign system and an unknown system are indistinguishable.
  selection_not_found: 'NOT_FOUND',
};

/** Current own-world reads. No route requests cartography or acknowledges a transition. */
@Controller()
export class GeographyController {
  constructor(
    @Inject(READ_OWN_GEOGRAPHY) private readonly readGeography: ReadOwnGeography,
    @Inject(READ_OWN_DELTAS) private readonly readDeltas: ReadOwnDeltas,
    @Inject(READ_OWN_EMERGING) private readonly readEmerging: ReadOwnEmerging,
  ) {}

  @Implement(apiContract.geography.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.geography.read).handler(async ({ input }) => {
      const result = await this.readGeography(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.snapshot;
    });
  }

  @Implement(apiContract.geography.deltas)
  deltasRoute(@Req() request: Request) {
    return implement(apiContract.geography.deltas).handler(async ({ input }) => {
      const result = await this.readDeltas(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.deltas;
    });
  }

  @Implement(apiContract.geography.emerging)
  emergingRoute(@Req() request: Request) {
    return implement(apiContract.geography.emerging).handler(async ({ input }) => {
      const result = await this.readEmerging(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.emerging;
    });
  }
}
