import { SavedPageResponseSchema } from '@knowscroll/contracts';
import type { ReadSavedPage } from '@knowscroll/backend/modules/experience';
import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type {
  NavigateEncounter,
  ActivateOffer,
  ReadExposureContext,
  ApplyEncounterAction,
  ActivateExposure,
  ActivateExposureResult,
  ApplyAction,
  ApplyActionResult,
  ListSaved,
  OpenExposure,
  OpenExposureResult,
  ReadExposureDocument,
} from '@knowscroll/backend/modules/experience';
import {
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
  APPLY_ENCOUNTER_ACTION,
  ACTIVATE_EXPOSURE,
  APPLY_ACTION,
  LIST_SAVED,
  READ_SAVED_PAGE,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
} from '../modules/experience.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const refusalProblems: Record<Extract<ApplyActionResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  asset_not_found: 'ASSET_NOT_FOUND',
  asset_revision_stale: 'ASSET_REVISION_STALE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

const openRefusalProblems: Record<Extract<OpenExposureResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  asset_not_found: 'ASSET_NOT_FOUND',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

const activateRefusalProblems: Record<Extract<ActivateExposureResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  // Unknown and another person's exposure are the same answer: no oracle.
  exposure_not_found: 'NOT_FOUND',
  command_key_reused: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

/**
 * `POST /v1/actions`, `GET /v1/saved` and the exposure routes (`POST /v1/experience/open`,
 * `POST /v1/experience/activate`, `GET /v1/experience/exposures/{id}/document`): thin handlers over
 * experience's use cases. The caller is the one the scope guard admitted (`main.ts`: authenticated,
 * scope claim matching).
 */
@Controller()
export class ExperienceController {
  constructor(
    @Inject(APPLY_ACTION) private readonly applyAction: ApplyAction,
    @Inject(LIST_SAVED) private readonly listSaved: ListSaved,
    @Inject(READ_SAVED_PAGE) private readonly readSavedPage: ReadSavedPage,
    @Inject(OPEN_EXPOSURE) private readonly openExposure: OpenExposure,
    @Inject(ACTIVATE_EXPOSURE) private readonly activateExposure: ActivateExposure,
    @Inject(READ_EXPOSURE_DOCUMENT) private readonly readExposureDocument: ReadExposureDocument,
    @Inject(NAVIGATE_ENCOUNTER) private readonly navigate: NavigateEncounter,
    @Inject(ACTIVATE_OFFER) private readonly activateOffer: ActivateOffer,
    @Inject(READ_EXPOSURE_CONTEXT) private readonly readContext: ReadExposureContext,
    @Inject(APPLY_ENCOUNTER_ACTION) private readonly applyEncounterAction: ApplyEncounterAction,
  ) {}

  @Implement(apiContract.experience.applyAction)
  applyActionRoute(@Req() request: Request) {
    return implement(apiContract.experience.applyAction).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      if ((input.kind !== 'save' && input.kind !== 'unsave') || input.exposureId !== undefined) {
        const result = await this.applyEncounterAction(authorityOf(caller), input);
        if (result.kind === 'refused') throw problem(result.code);
        return result.outcome;
      }
      const result = await this.applyAction(authorityOf(caller), { ...input, kind: input.kind });
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return { commandId: input.commandId, replayed: result.replayed, ...result.outcome };
    });
  }

  @Implement(apiContract.experience.listSaved)
  listSavedRoute(@Req() request: Request) {
    return implement(apiContract.experience.listSaved).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      if (input.pagination === 'saved-page.v1') {
        const result = await this.readSavedPage(authorityOf(caller), input);
        if (result.kind === 'refused') throw problem(result.code);
        const page = SavedPageResponseSchema.safeParse(result.value);
        if (
          !page.success ||
          page.data.scope.accountId !== caller.accountId ||
          page.data.scope.privacyEpoch !== caller.privacyEpoch ||
          page.data.filter !== input.filter ||
          page.data.limit !== Number(input.limit) ||
          page.data.requestCursor !== input.cursor
        )
          throw problem('INTERNAL');
        return page.data;
      }
      const result = await this.listSaved(authorityOf(caller), Number(input.limit ?? '50'));
      if (result.kind === 'refused')
        throw problem(result.reason === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
      return {
        revision: result.revision,
        items: result.items.map((item) => ({
          assetId: item.assetId,
          assetRevision: item.assetRevision,
          savedAt: item.savedAt.toISOString(),
          ...(item.metadata ? { metadata: item.metadata } : {}),
          ...(item.availability ? { availability: item.availability } : {}),
          ...(item.currentAssetRevision ? { currentAssetRevision: item.currentAssetRevision } : {}),
        })),
      };
    });
  }

  @Implement(apiContract.experience.openExposure)
  openExposureRoute(@Req() request: Request) {
    return implement(apiContract.experience.openExposure).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      if (input.target.kind === 'discover' || input.target.kind === 'return') {
        const result = await this.navigate(
          authorityOf(caller),
          input.target.kind === 'discover' ? { ...input, target: input.target } : { ...input, target: input.target },
        );
        if (result.kind === 'refused') throw problem(result.code);
        return result.outcome;
      }
      const result = await this.openExposure(authorityOf(caller), {
        ...input,
        target: { kind: input.target.kind, assetId: input.target.assetId },
        origin: { kind: 'direct' },
      });
      if (result.kind === 'refused') throw problem(openRefusalProblems[result.reason]);
      return { commandId: input.commandId, replayed: result.replayed, ...result.outcome };
    });
  }

  /** Navigation composes outside the scoped transactions. */
  @Implement(apiContract.experience.navigate)
  navigateExperienceRoute(@Req() request: Request) {
    return implement(apiContract.experience.navigate).handler(async ({ input }) => {
      const result = await this.navigate(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(result.code);
      return result.outcome;
    });
  }

  /** Context reflects the latest session intent and current preferences. */
  @Implement(apiContract.experience.exposureContext)
  exposureContextRoute(@Req() request: Request) {
    return implement(apiContract.experience.exposureContext).handler(async ({ input }) => {
      const result = await this.readContext(authorityOf(admittedCaller(request)), input.exposureId);
      if (result.kind === 'refused') throw problem(result.code);
      return result.context;
    });
  }

  @Implement(apiContract.experience.activateExposure)
  activateExposureRoute(@Req() request: Request) {
    return implement(apiContract.experience.activateExposure).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      if (input.target !== undefined) {
        const result = await this.activateOffer(authorityOf(caller), input);
        if (result.kind === 'refused') throw problem(result.code);
        return result.outcome;
      }
      const result = await this.activateExposure(authorityOf(caller), input);
      if (result.kind === 'refused') throw problem(activateRefusalProblems[result.reason]);
      return { commandId: input.commandId, replayed: result.replayed, ...result.outcome };
    });
  }

  @Implement(apiContract.experience.exposureDocument)
  exposureDocumentRoute(@Req() request: Request) {
    return implement(apiContract.experience.exposureDocument).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.readExposureDocument(authorityOf(caller), input.exposureId);
      if (result.kind === 'refused') {
        switch (result.reason) {
          case 'exposure_not_found':
            throw problem('NOT_FOUND');
          case 'epoch_changed':
            throw problem('PRIVACY_EPOCH_CHANGED');
          case 'universe_unavailable':
            throw problem('UNIVERSE_UNAVAILABLE');
          case 'cannot_render':
            // The client's declared capabilities cannot render this document at all: a stable
            // reason code, never text.
            throw problem('UNPROCESSABLE_REQUEST', { detail: result.cannotRender ?? 'cannot_render' });
        }
      }
      return {
        exposureId: result.exposureId,
        assetId: result.assetId,
        assetRevision: result.assetRevision,
        document: result.document,
        degradedEssential: [...result.degradedEssential],
      };
    });
  }
}
