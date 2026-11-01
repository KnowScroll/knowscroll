import type { Kysely } from 'kysely';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import { READ_SCROLL_QUICK_ANSWER_FACTS, type ReadScrollQuickAnswerFacts } from '../../content/public.js';
import { HAS_ACTIVATED_EXPOSURE, type HasActivatedExposure } from '../../experience/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  FENCE_PERSONAL_RECORDING,
  type CheckPersonalOwnerActive,
  type FencePersonalRecording,
  type PersonalScopeTx,
  type WithPersonalScope,
} from '../../identity/public.js';
import { stableUuid, uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import type { LogEvent } from '../../../infrastructure/observability/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
} from '../../../infrastructure/receipts/index.js';
import { makeAnswerQuickAnswer } from '../application/answer-quick-answer.js';
import type { QuickAnswerPorts } from '../application/quick-answer-ports.js';
import { makeSupportCheck } from '../application/quick-answer-support.js';
import { makePurgeQuickAnswers } from '../application/purge-quick-answers.js';
import {
  makeAskQuickAnswer,
  makeDismissQuickAnswer,
  makeReadQuickAnswer,
  makeReadQuickAnswerForReport,
  QUICK_ANSWER_WAIT_LIMIT_MS,
} from '../application/quick-answers.js';
import { answerQuickAnswerQueue } from '../quick-answer-events.js';
import {
  ANSWER_QUICK_ANSWER,
  ASK_QUICK_ANSWER,
  DISMISS_QUICK_ANSWER,
  PURGE_QUICK_ANSWERS,
  READ_QUICK_ANSWER,
  READ_QUICK_ANSWER_FOR_REPORT,
} from '../public.js';
import {
  giveUpStaleQuickAnswers,
  purgeExpiredQuickAnswers,
  quickAnswerLedger,
  quickAnswerStore,
} from './postgres-quick-answers.js';

export const QUICK_ANSWER_PORTS = Symbol('supply.quick-answer-ports');

/** What Quick answers read from a process's configuration (the API's and the worker's both carry it). */
export interface QuickAnswerSettings {
  /** Quick answers for the whole world per UTC day; 0 turns them off. */
  readonly supplyQuickAnswerDailyCap: number;
  /** Quick answers one person may ask per UTC day. */
  readonly supplyQuickAnswerPersonDailyCap: number;
}

/**
 * Quick answer's use cases for the API and the worker. The API asks, reads and dismisses; the worker also passes `harness`,
 * the personal reasoning harness, which lets it answer. The worker's answering step is always built with the support check on
 * that same harness: there is no way to wire it without one.
 */
export function quickAnswerProviders(t: {
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
  readonly config: symbol;
  readonly harness?: symbol;
}) {
  return [
    {
      provide: QUICK_ANSWER_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        t.config,
        CHECK_PERSONAL_OWNER_ACTIVE,
        FENCE_PERSONAL_RECORDING,
        READ_SCROLL_QUICK_ANSWER_FACTS,
        HAS_ACTIVATED_EXPOSURE,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        enqueue: EnqueueJob,
        settings: QuickAnswerSettings,
        ownerActive: CheckPersonalOwnerActive,
        fenceRecording: FencePersonalRecording,
        readFacts: ReadScrollQuickAnswerFacts,
        hasActivatedExposure: HasActivatedExposure,
      ): QuickAnswerPorts => ({
        withScope,
        ownerActive,
        hasActivatedExposure,
        readFacts,
        fenceRecording,
        store: quickAnswerStore,
        ledger: quickAnswerLedger,
        caps: { perDay: settings.supplyQuickAnswerDailyCap, perPersonPerDay: settings.supplyQuickAnswerPersonDailyCap },
        receipts: {
          async find(scope, commandId, command) {
            const found = await findPersonalReceipt(scope, {
              operation: 'supply.quick-answer',
              commandId,
              requestHash: requestHash('supply.quick-answer', command),
              outcomeVersion: 1,
            });
            if (found.kind === 'new' || found.kind === 'replay') return found;
            return {
              kind: 'refused',
              reason: found.kind === 'key_reused' ? 'command_key_reused' : 'receipt_unavailable',
            };
          },
          insert: (scope, commandId, command) =>
            insertPersonalReceipt(scope, {
              operation: 'supply.quick-answer',
              commandId,
              requestHash: requestHash('supply.quick-answer', command),
              outcomeVersion: 1,
            }),
          complete: (scope, commandId, receipt) => completePersonalReceipt(scope, commandId, receipt),
        },
        enqueue: (scope: PersonalScopeTx, quickAnswerId) =>
          enqueue(
            scope,
            answerQuickAnswerQueue,
            {
              v: 1,
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              quickAnswerId,
            },
            { jobId: stableUuid(`quick-answer:${quickAnswerId}`), duplicate: 'ignore' },
          ),
        advance: advanceScopeRevision,
        notify: (scope, revision, eventId) => notifyScopeChanged(scope, { revision, eventId }),
        newId: () => uuidv7(),
        idFor: stableUuid,
        now: () => new Date(),
      }),
    },
    {
      provide: ASK_QUICK_ANSWER,
      inject: [QUICK_ANSWER_PORTS],
      useFactory: (p: QuickAnswerPorts) => makeAskQuickAnswer(p),
    },
    {
      provide: READ_QUICK_ANSWER,
      inject: [QUICK_ANSWER_PORTS],
      useFactory: (p: QuickAnswerPorts) => makeReadQuickAnswer(p),
    },
    {
      provide: DISMISS_QUICK_ANSWER,
      inject: [QUICK_ANSWER_PORTS],
      useFactory: (p: QuickAnswerPorts) => makeDismissQuickAnswer(p),
    },
    {
      provide: READ_QUICK_ANSWER_FOR_REPORT,
      inject: [QUICK_ANSWER_PORTS],
      useFactory: (p: QuickAnswerPorts) => makeReadQuickAnswerForReport(p),
    },
    ...(t.harness === undefined
      ? []
      : [
          {
            provide: ANSWER_QUICK_ANSWER,
            inject: [QUICK_ANSWER_PORTS, t.harness],
            useFactory: (p: QuickAnswerPorts, harness: ReasoningHarness) =>
              makeAnswerQuickAnswer(p, harness, makeSupportCheck(harness)),
          },
        ]),
  ];
}

/** Nest wiring of the scheduled Quick answer purge (`supply.purge-quick-answers`) for the worker composition root. */
export function quickAnswerPurgeProviders(tokens: { readonly database: symbol; readonly logEvent: symbol }) {
  return [
    {
      provide: PURGE_QUICK_ANSWERS,
      inject: [tokens.database, tokens.logEvent],
      useFactory: (db: Kysely<Database>, logEvent: LogEvent) =>
        makePurgeQuickAnswers({
          purgeDue: purgeExpiredQuickAnswers(db),
          giveUpStale: giveUpStaleQuickAnswers(db, QUICK_ANSWER_WAIT_LIMIT_MS),
          logEvent,
        }),
    },
  ];
}
