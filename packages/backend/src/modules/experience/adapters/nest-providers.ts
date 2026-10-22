import { checkRequestSource } from './request-source.js';
import { CHECK_REQUEST_SOURCE } from '../public.js';
import type { Kysely } from 'kysely';
import {
  READ_SAVED_METADATA,
  type ReadSavedMetadata,
  READ_ENCOUNTER_ATTRIBUTION,
  type ReadEncounterAttribution,
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  RENDER_SCROLL,
  type FindAssetForAction,
  type FindOpenableAsset,
  type RenderScroll,
} from '../../content/public.js';
import { projectEncounterActivityQueue, applyActionEvidenceQueue } from '../../evidence/public.js';
import type { PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
} from '../../../infrastructure/receipts/index.js';
import { makeActivateExposure } from '../application/activate-exposure.js';
import { makeApplyAction } from '../application/apply-action.js';
import { hydratedSaved } from './saved-store.js';
import { makeApplyEncounterAction } from '../application/encounter-action.js';
import { makeCommitAction, makeRecordLegacyAction, readChannels } from './action-store.js';
import {
  readActivityLineage,
  ensureActivityLineage,
  readRoutingHistory,
  readActivityReconcilePage,
  recordActivation,
} from './navigation-store.js';
import {
  READ_ACTIVITY_LINEAGE,
  ENSURE_ACTIVITY_LINEAGE,
  READ_ROUTING_HISTORY,
  READ_ACTIVITY_RECONCILE_PAGE,
} from '../public.js';
import { makeOpenExposure } from '../application/open-exposure.js';
import { makeReadExposureDocument } from '../application/read-exposure-document.js';
import type { JsonValue } from '../application/ports.js';
import { READ_ACTION_FOR_EVIDENCE, READ_EXPOSURE_FOR_EVIDENCE } from '../public.js';
import {
  insertExposure,
  makeReadExposureForDocument,
  markExposureActivated,
  readActionForEvidence,
  readExposure,
  readExposureForEvidence,
  readSavedState,
  writeSavedState,
} from './postgres-store.js';

/** Injection tokens of experience's operations. */
export const APPLY_ACTION = Symbol('experience.applyAction');
export const LIST_SAVED = Symbol('experience.listSaved');
export const OPEN_EXPOSURE = Symbol('experience.openExposure');
export const ACTIVATE_EXPOSURE = Symbol('experience.activateExposure');
export const READ_EXPOSURE_DOCUMENT = Symbol('experience.readExposureDocument');

/** What the composition root must provide, by token. */
export interface ExperienceDependencyTokens {
  readonly database: symbol;
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
}

/**
 * Reusable outer wiring (blueprint §22): Nest factory providers that build experience's commands
 * and queries from concrete adapters. Needs content's providers (`FIND_ASSET_FOR_ACTION`,
 * `FIND_OPENABLE_ASSET`, `RENDER_SCROLL`) in the same composition root. Only the apps' composition
 * roots import this file.
 */
export function experienceProviders(tokens: ExperienceDependencyTokens) {
  return [
    {
      provide: APPLY_ENCOUNTER_ACTION,
      inject: [tokens.withPersonalScope, tokens.enqueueJob, FIND_ASSET_FOR_ACTION],
      useFactory: (withScope: WithPersonalScope, enqueue: EnqueueJob, findAsset: FindAssetForAction) =>
        makeApplyEncounterAction({
          ...commandPorts(withScope),
          findAsset,
          readExposure: readExposureForEvidence,
          readChannels,
          commitAction: makeCommitAction(enqueue),
          advance: advanceScopeRevision,
          notify: notifyScopeChanged,
        }),
    },
    {
      provide: APPLY_ACTION,
      inject: [tokens.withPersonalScope, tokens.enqueueJob, FIND_ASSET_FOR_ACTION],
      useFactory: (withPersonalScope: WithPersonalScope, enqueueJob: EnqueueJob, findAsset: FindAssetForAction) =>
        makeApplyAction({
          withPersonalScope,
          hashRequest: (operation, request) => requestHash(operation, request),
          findReceipt: findPersonalReceipt,
          insertReceipt: insertPersonalReceipt,
          completeReceipt: (scope, commandId, outcome) => completePersonalReceipt(scope, commandId, outcome),
          findAsset,
          readSavedReference: async (scope, id) => {
            const s = await readChannels(scope, id);
            return s.savedRevision === undefined ? undefined : { assetRevision: s.savedRevision };
          },
          readSavedState,
          writeSavedState,
          recordAction: makeRecordLegacyAction(enqueueJob),
          enqueueActionEvidence: (scope, payload) => enqueueJob(scope, applyActionEvidenceQueue, payload),
          advanceRevision: advanceScopeRevision,
          notifyScopeChanged,
          newId: () => uuidv7(),
          now: () => new Date(),
        }),
    },
    {
      provide: LIST_SAVED,
      inject: [tokens.withPersonalScope, READ_SAVED_METADATA],
      useFactory: (withScope: WithPersonalScope, metadata: ReadSavedMetadata) => hydratedSaved(withScope, metadata),
    },
    {
      provide: OPEN_EXPOSURE,
      inject: [tokens.withPersonalScope, FIND_OPENABLE_ASSET],
      useFactory: (withPersonalScope: WithPersonalScope, findOpenableAsset: FindOpenableAsset) =>
        makeOpenExposure({
          ...commandPorts(withPersonalScope),
          findOpenableAsset,
          insertExposure,
        }),
    },
    {
      provide: ACTIVATE_EXPOSURE,
      inject: [tokens.withPersonalScope, tokens.enqueueJob, READ_ENCOUNTER_ATTRIBUTION],
      useFactory: (withPersonalScope: WithPersonalScope, enqueue: EnqueueJob, metadata: ReadEncounterAttribution) =>
        makeActivateExposure({
          ...commandPorts(withPersonalScope),
          readExposure,
          markActivated: async (scope, id, at) => {
            await markExposureActivated(scope, id, at);
            const exposure = await readExposure(scope, id);
            if (exposure) {
              const m = await metadata(scope, { assetId: exposure.assetId, assetRevision: exposure.assetRevision });
              if (m) await recordActivation(scope, id, m);
              await enqueue(scope, projectEncounterActivityQueue, {
                v: 1,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                exposureId: id,
              });
            }
          },
        }),
    },
    {
      provide: READ_EXPOSURE_DOCUMENT,
      inject: [tokens.database, RENDER_SCROLL],
      useFactory: (db: Kysely<Database>, renderScroll: RenderScroll) =>
        makeReadExposureDocument({ readExposure: makeReadExposureForDocument(db), renderScroll }),
    },
  ];
}

/** The receipt and scope ports every experience command shares. */
function commandPorts(withPersonalScope: WithPersonalScope) {
  return {
    withPersonalScope,
    hashRequest: (operation: string, request: JsonValue) => requestHash(operation, request),
    findReceipt: findPersonalReceipt,
    insertReceipt: insertPersonalReceipt,
    completeReceipt: (scope: PersonalScopeTx, commandId: string, outcome: { readonly [key: string]: JsonValue }) =>
      completePersonalReceipt(scope, commandId, outcome),
    newId: () => uuidv7(),
    now: () => new Date(),
  };
}

/**
 * Experience's read ports for the evidence module (API and worker composition roots): one action
 * (for the action job) and one exposure's lineage (for observation intake and the projection).
 */
export function experienceEvidenceReadProviders() {
  return [
    { provide: CHECK_REQUEST_SOURCE, useValue: checkRequestSource },
    { provide: READ_ACTIVITY_LINEAGE, useValue: readActivityLineage },
    { provide: ENSURE_ACTIVITY_LINEAGE, useValue: ensureActivityLineage },
    { provide: READ_ROUTING_HISTORY, useValue: readRoutingHistory },
    { provide: READ_ACTIVITY_RECONCILE_PAGE, useValue: readActivityReconcilePage },
    { provide: READ_ACTION_FOR_EVIDENCE, useValue: readActionForEvidence },
    { provide: READ_EXPOSURE_FOR_EVIDENCE, useValue: readExposureForEvidence },
  ];
}

export const APPLY_ENCOUNTER_ACTION = Symbol('experience.applyEncounterAction');
export {
  navigationProviders,
  NAVIGATION_PORTS,
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
} from './navigation-providers.js';

export { checkRequestSource } from './request-source.js';

export { keepPlaceUseCases, keepPlaceProviders, keepStore, type KeepPorts, type KeepStore } from './keep-providers.js';

export { keepRemovalUseCase, keepRemovalProviders, type KeepRemovalPorts } from './keep-remove-providers.js';

export { savedPageUseCase } from './saved-page-providers.js';

// Owning factory seams for Actions fixtures; activation permits cannot be minted here.
export { makeRegionEncounters } from '../application/region-encounter.js';
export { makeNavigateEncounter, makeActivateOffer } from '../application/navigation.js';
export type { NavigationPorts, StoredOffer } from '../application/navigation-ports.js';
