import { isDeepStrictEqual } from 'node:util';
import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import type { Request } from 'express';
import {
  apiContract,
  FormationPresentationReadSchema,
  FormationPresentationClaimAcceptanceSchema,
  FormationPresentationAcknowledgementSchema,
  FormationPresentationProblemSchema,
  problemDetails,
  type ProblemCode,
} from '@knowscroll/contracts';
import { FORMATION_PRESENTATIONS, type FormationUseCases } from '@knowscroll/backend/modules/scenes';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
function problem(code: ProblemCode) {
  const parsed = FormationPresentationProblemSchema.safeParse(problemDetails(code));
  const d = parsed.success ? parsed.data : FormationPresentationProblemSchema.parse(problemDetails('INTERNAL'));
  return new ORPCError(d.code, { status: d.status, message: d.title, data: d });
}
@Controller()
export class FormationController {
  constructor(@Inject(FORMATION_PRESENTATIONS) private readonly formation: FormationUseCases) {}
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.formation.read)
  read(@Req() request: Request) {
    return implement(apiContract.formation.read).handler(async ({ input }) => {
      const caller = admittedCaller(request),
        r = await this.formation.read(authorityOf(caller), input);
      if (r.kind === 'refused') throw problem(r.code);
      const p = FormationPresentationReadSchema.safeParse(r.value);
      if (
        !p.success ||
        p.data.scope.universeId !== caller.universeId ||
        p.data.scope.privacyEpoch !== caller.privacyEpoch ||
        p.data.readId !== input.readId ||
        !isDeepStrictEqual(p.data.target, input.target) ||
        !isDeepStrictEqual(p.data.capabilities, input.capabilities)
      )
        throw problem('INTERNAL');
      return p.data;
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.formation.claim)
  claim(@Req() request: Request) {
    return implement(apiContract.formation.claim).handler(async ({ input }) => {
      const caller = admittedCaller(request),
        r = await this.formation.claim(authorityOf(caller), input);
      if (r.kind === 'refused') throw problem(r.code);
      const p = FormationPresentationClaimAcceptanceSchema.safeParse(r.value);
      if (
        !p.success ||
        p.data.scope.universeId !== caller.universeId ||
        p.data.scope.privacyEpoch !== caller.privacyEpoch ||
        p.data.receipt.commandId !== input.commandId ||
        p.data.receipt.transitionId !== input.transitionId ||
        p.data.receipt.attemptNonce !== input.attemptNonce
      )
        throw problem('INTERNAL');
      return p.data;
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.formation.acknowledge)
  acknowledge(@Req() request: Request) {
    return implement(apiContract.formation.acknowledge).handler(async ({ input }) => {
      const caller = admittedCaller(request),
        r = await this.formation.acknowledge(authorityOf(caller), input);
      if (r.kind === 'refused') throw problem(r.code);
      const p = FormationPresentationAcknowledgementSchema.safeParse(r.value);
      if (
        !p.success ||
        p.data.scope.universeId !== caller.universeId ||
        p.data.scope.privacyEpoch !== caller.privacyEpoch ||
        p.data.commandId !== input.commandId ||
        p.data.transitionId !== input.transitionId ||
        p.data.claimId !== input.claimId ||
        p.data.attemptNonce !== input.attemptNonce ||
        p.data.requestedDisposition !== input.disposition
      )
        throw problem('INTERNAL');
      return p.data;
    });
  }
}
