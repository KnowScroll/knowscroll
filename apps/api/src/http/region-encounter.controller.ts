import { isDeepStrictEqual } from 'node:util';
import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import type { Request } from 'express';
import {
  apiContract,
  RegionEncounterPreviewResponseSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterProblemSchema,
  problemDetails,
  type ProblemCode,
} from '@knowscroll/contracts';
import { REGION_ENCOUNTERS, type RegionEncounterUseCases } from '@knowscroll/backend/modules/experience';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';

function regionProblem(code: ProblemCode) {
  const result = RegionEncounterProblemSchema.safeParse(problemDetails(code));
  const details = result.success ? result.data : RegionEncounterProblemSchema.parse(problemDetails('INTERNAL'));
  return new ORPCError(details.code, { status: details.status, message: details.title, data: details });
}

/** Private bounded reads/commands; the API grants neither canonical approval nor rendering. */
@Controller()
export class RegionEncounterController {
  constructor(@Inject(REGION_ENCOUNTERS) private readonly region: RegionEncounterUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.experience.previewRegionEncounter)
  preview(@Req() request: Request) {
    return implement(apiContract.experience.previewRegionEncounter).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.region.preview(authorityOf(caller), input);
      if (result.kind === 'refused') throw regionProblem(result.code);
      const parsed = RegionEncounterPreviewResponseSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.readId !== input.readId ||
        parsed.data.scope.universeId !== caller.universeId ||
        parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
        !isDeepStrictEqual(parsed.data.target, input.target) ||
        !isDeepStrictEqual(parsed.data.capabilities, input.capabilities)
      )
        throw regionProblem('INTERNAL');
      return parsed.data;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.experience.openRegionEncounter)
  open(@Req() request: Request) {
    return implement(apiContract.experience.openRegionEncounter).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.region.open(authorityOf(caller), input);
      if (result.kind === 'refused') throw regionProblem(result.code);
      const parsed = RegionEncounterOpenResponseSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.universeId !== caller.universeId ||
        parsed.data.privacyEpoch !== caller.privacyEpoch ||
        parsed.data.outcome.commandId !== input.commandId ||
        !isDeepStrictEqual(parsed.data.target, input.target) ||
        !isDeepStrictEqual(parsed.data.expectedEncounter, input.expectedEncounter) ||
        !isDeepStrictEqual(parsed.data.capabilities, input.capabilities) ||
        (input.session &&
          (parsed.data.outcome.sessionId !== input.session.sessionId ||
            parsed.data.outcome.intentRevision !== input.session.expectedIntentRevision + 1))
      )
        throw regionProblem('INTERNAL');
      return parsed.data;
    });
  }
}
