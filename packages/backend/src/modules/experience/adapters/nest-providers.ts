import type { Kysely } from 'kysely';
import { applyActionEvidenceQueue } from '../../evidence/public.js';
import { findAssetForAction } from '../../content/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { makeApplyAction } from '../application/apply-action.js';
import { makeListSaved } from '../application/list-saved.js';
import { makeReadSavedItems, readSavedState, recordAction, writeSavedState } from './postgres-store.js';

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
 * Reusable outer wiring (blueprint §22): Nest factory providers that build experience's use
 * cases from concrete adapters. Only the apps' composition roots import this file.
 */
export function experienceProviders(tokens: ExperienceDependencyTokens) {
  return [
    {
      provide: APPLY_ACTION,
      inject: [tokens.withPersonalScope, tokens.enqueueJob],
      useFactory: (withPersonalScope: WithPersonalScope, enqueueJob: EnqueueJob) =>
        makeApplyAction({
          withPersonalScope,
          hashRequest: (operation, request) => requestHash(operation, request as CanonicalJson),
          findReceipt: findPersonalReceipt,
          insertReceipt: insertPersonalReceipt,
          completeReceipt: (scope, commandId, outcome) =>
            completePersonalReceipt(scope, commandId, outcome as { readonly [key: string]: CanonicalJson }),
          findAsset: findAssetForAction,
          readSavedState,
          writeSavedState,
          recordAction,
          enqueueActionEvidence: (scope, payload) => enqueueJob(scope, applyActionEvidenceQueue, payload),
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
