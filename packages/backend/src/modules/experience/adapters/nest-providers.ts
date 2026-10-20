import type { Kysely } from 'kysely';
import {
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  RENDER_SCROLL,
  type FindAssetForAction,
  type FindOpenableAsset,
  type RenderScroll,
} from '../../content/public.js';
import { applyActionEvidenceQueue } from '../../evidence/public.js';
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
import { makeListSaved } from '../application/list-saved.js';
import { makeOpenExposure } from '../application/open-exposure.js';
import { makeReadExposureDocument } from '../application/read-exposure-document.js';
import type { JsonValue } from '../application/ports.js';
import {
  READ_ACTION_FOR_EVIDENCE,
  READ_EXPOSURE_FOR_EVIDENCE,
  type ReadActionForEvidence,
  type ReadExposureForEvidence,
} from '../public.js';
import {
  insertExposure,
  makeReadExposureForDocument,
  makeReadSavedItems,
  markExposureActivated,
  readActionForEvidence,
  readExposure,
  readExposureForEvidence,
  readSavedState,
  recordAction,
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
          readSavedState,
          writeSavedState,
          recordAction,
          enqueueActionEvidence: (scope, payload) => enqueueJob(scope, applyActionEvidenceQueue, payload),
          advanceRevision: advanceScopeRevision,
          notifyScopeChanged,
          newId: () => uuidv7(),
          now: () => new Date(),
        }),
    },
    {
      provide: LIST_SAVED,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeListSaved({ readSavedItems: makeReadSavedItems(db) }),
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
      inject: [tokens.withPersonalScope],
      useFactory: (withPersonalScope: WithPersonalScope) =>
        makeActivateExposure({
          ...commandPorts(withPersonalScope),
          readExposure,
          markActivated: markExposureActivated,
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
export function experienceEvidenceReadProviders(): readonly (
  | { readonly provide: symbol; readonly useValue: ReadActionForEvidence }
  | { readonly provide: symbol; readonly useValue: ReadExposureForEvidence }
)[] {
  return [
    { provide: READ_ACTION_FOR_EVIDENCE, useValue: readActionForEvidence },
    { provide: READ_EXPOSURE_FOR_EVIDENCE, useValue: readExposureForEvidence },
  ];
}
