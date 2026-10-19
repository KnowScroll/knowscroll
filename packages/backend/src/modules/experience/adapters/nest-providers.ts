import type { Kysely } from 'kysely';
import { FIND_ASSET_FOR_ACTION, type FindAssetForAction } from '../../content/public.js';
import { applyActionEvidenceQueue } from '../../evidence/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
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
import { makeApplyAction } from '../application/apply-action.js';
import { makeListSaved } from '../application/list-saved.js';
import { READ_ACTION_FOR_EVIDENCE, type ReadActionForEvidence } from '../public.js';
import {
  makeReadSavedItems,
  readActionForEvidence,
  readSavedState,
  recordAction,
  writeSavedState,
} from './postgres-store.js';

/** Injection tokens of experience's operations. */
export const APPLY_ACTION = Symbol('experience.applyAction');
export const LIST_SAVED = Symbol('experience.listSaved');

/** What the composition root must provide, by token. */
export interface ExperienceDependencyTokens {
  readonly database: symbol;
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
}

/**
 * Reusable outer wiring (blueprint §22): Nest factory providers that build experience's commands
 * and queries from concrete adapters. Needs content's providers (`FIND_ASSET_FOR_ACTION`) in the
 * same composition root. Only the apps' composition roots import this file.
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
  ];
}

/** Experience's read port for the evidence job (worker composition root). */
export function experienceEvidenceReadProviders(): {
  readonly provide: symbol;
  readonly useValue: ReadActionForEvidence;
}[] {
  return [{ provide: READ_ACTION_FOR_EVIDENCE, useValue: readActionForEvidence }];
}
