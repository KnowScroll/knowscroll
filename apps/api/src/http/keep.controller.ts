import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, KeepEntrySnapshotSchema, KeepPlaceAcceptanceSchema } from '@knowscroll/contracts';
import type { KeepPlaceUseCases } from '@knowscroll/backend/modules/experience';
import { KEEP_PLACE_USE_CASES } from '../modules/experience.js';
import { authorityOf } from './callers.js';
import { keepProblem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

/** Durable private Saved membership positions only; reads create no encounter or work. */
@Controller()
export class KeepController {
  constructor(@Inject(KEEP_PLACE_USE_CASES) private readonly keep: KeepPlaceUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.keep.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.keep.read).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.keep.readEntry(authorityOf(caller), input);
      if (result.kind === 'refused') throw keepProblem(result);
      const parsed = KeepEntrySnapshotSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.scope.accountId !== caller.accountId ||
        parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
        parsed.data.target.assetId !== input.target.assetId ||
        parsed.data.target.assetRevision !== input.target.assetRevision
      )
        throw keepProblem({ code: 'INTERNAL' });
      return parsed.data;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.keep.setPlace)
  setPlaceRoute(@Req() request: Request) {
    return implement(apiContract.keep.setPlace).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.keep.setPlace(authorityOf(caller), input);
      if (result.kind === 'refused') throw keepProblem(result);
      const parsed = KeepPlaceAcceptanceSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.scope.accountId !== caller.accountId ||
        parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
        parsed.data.commandId !== input.commandId ||
        parsed.data.entry.assetId !== input.entry.assetId ||
        parsed.data.entry.assetRevision !== input.entry.assetRevision ||
        parsed.data.entry.savedEntryId !== input.entry.savedEntryId
      )
        throw keepProblem({ code: 'INTERNAL' });
      return parsed.data;
    });
  }
}
