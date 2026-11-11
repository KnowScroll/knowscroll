import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  CANCEL_CONTENT_REQUEST,
  RETRY_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
  COUNT_PLANNED_DEMAND,
  COMMISSION_SCENARIO_ORDER,
  RECORD_GAP_SIGNALS,
} from '../public.js';
import { CHECK_REQUEST_SOURCE, type CheckRequestSource } from '../../experience/public.js';
import {
  CHOOSE_SCROLL_RECIPE,
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_REGION_ENCOUNTER_CANDIDATES,
  READ_SCROLL_PRODUCTION,
  READ_SCROLL_ASK_FACTS,
  READ_SCROLL_SOURCE_PAGES,
  READ_LIBRARY_PASSAGES,
  READ_MADE_TO_ORDER_PRODUCTION_IN,
  READ_ASK_ORDER_AUDIENCE,
  LOCK_CURRENT_ENCOUNTERS,
  RECORD_MADE_TO_ORDER_SCROLL,
  type RecordMadeToOrderScroll,
  type ReadLibraryPassages,
  type ReadScrollAskFacts,
  type ReadScrollSourcePages,
  type ReadMadeToOrderProductionIn,
  type ReadOrderAudience,
  produceScrollJob,
  produceScrollSingletonKey,
  produceScrollQueue,
  produceAnswerQueue,
  type ChooseScrollRecipe,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type ReadRegionEncounterCandidates,
  type ReadScrollProduction,
  type LockCurrentEncounters,
} from '../../content/public.js';
import {
  CHECK_SUPPLY_RECORDING_RUN,
  type CheckPersonalRecordingRun,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import {
  READ_EXPLORATION_SNAPSHOT,
  encounteredUnitsOf,
  type ReadExplorationSnapshot,
} from '../../personal-context/public.js';
import {
  CHECK_PERSONAL_ACCOUNT_DISPOSABLE,
  CHECK_PERSONAL_OWNER_ACTIVE,
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type CheckPersonalAccountDisposable,
  type CheckPersonalOwnerActive,
  type PersonalScopeTx,
  type WithPersonalScope,
} from '../../identity/public.js';
import { stableUuid, uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import {
  requestHash,
  findPersonalReceipt,
  insertPersonalReceipt,
  completePersonalReceipt,
} from '../../../infrastructure/receipts/index.js';
import {
  makeCreateRequest,
  makeReadRequest,
  makeCancelRequest,
  makeRetryRequest,
  makeRecordPlannedDemand,
  makeCountPlannedDemand,
} from '../application/requests.js';
import { makeListRequests } from '../application/list.js';
import { makeCommissionScenarioOrder } from '../application/scenario-orders.js';
import { scenarioOrderStore } from './postgres-scenario-orders.js';
import { makeMatchRequest } from '../application/matching.js';
import { makeResolveRequest } from '../application/resolve.js';
import { resolveSupplyQueue } from '../events.js';
import type { SupplyPorts } from '../application/ports.js';
import type { RecordGapSignals } from '../application/gap-ports.js';
import { supplyStore } from './postgres-store.js';
import { askOrderLedger, makeReadAskOrderAudience } from './postgres-ask-orders.js';
import { plannedDemandLedger } from './postgres-planned-demand-ledger.js';
import { quickAnswerStore } from './postgres-quick-answers.js';
import { makeCheckSupplyRecordingRun } from '../application/check-recording-run.js';
import { makeRecordGapSignals } from '../application/gap-signals.js';
import { gapMarkStore } from './postgres-gaps.js';
import { bestEffort } from '../../../infrastructure/postgres/best-effort.js';
import type { LogEvent } from '../../../infrastructure/observability/index.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
export const SUPPLY_PORTS = Symbol('supply.ports');

/**
 * The recorder of the gap loop's counts as a best effort inside the caller's personal transaction: a savepoint and a short lock wait
 * (`bestEffort`), so a failure rolls back only its own writes, is swallowed and logged by its code, and a row another transaction holds makes it
 * give up instead of making the person wait.
 */
const guardedGapSignals =
  (record: RecordGapSignals, logEvent: LogEvent | undefined): RecordGapSignals =>
  async (scope, signals) => {
    const outcome = await bestEffort(scope, () => record(scope, signals));
    if (!outcome.ok) logEvent?.('supply.gap_signal_failed', { reasonCode: outcome.code });
  };
/** What Supply reads from a process's configuration (the API's and the worker's both carry it). */
export interface SupplySettings {
  /** Productions people's own asks may start per UTC day; 0 turns Create off. */
  readonly supplyCreateDailyCap: number;
  /** Productions the Planner's demand may start per UTC day; never above the cap for people. */
  readonly supplyPlannerCreateDailyCap: number;
  /** New Scrolls from stored recipes Create may start per UTC day (D-412); 0 or absent turns growth off. */
  readonly supplyGrowthDailyCap?: number;
  /** `KS_SUPPLY_GROWTH_ENABLED`: the gap loop notices content running out and proposes recipes (D-414); absent is off. */
  readonly supplyGrowthEnabled?: boolean;
  /** Ask orders (a short Scroll made for a person's question) Create may make per UTC day for the world; 0 turns them off. */
  readonly supplyAskDailyCap: number;
  /** Ask orders one person may have made per UTC day. */
  readonly supplyAskPersonDailyCap: number;
}

/** What scenario Create reads from the API's configuration. */
export interface ScenarioOrderSettings {
  /** Branches Quartermaster may order per UTC day; 0 turns scenario Create off. */
  readonly supplyScenarioDailyCap: number;
  /** Branches one thread may have ordered per UTC day. */
  readonly supplyScenarioThreadDailyCap: number;
}

/** Priority of a person's production job over operator seeding (priority 0). */
const REQUEST_PRIORITY = 10;

/** Sends the production job of one take of a recipe in a person's transaction, ahead of operator seeding. */
const sendProduction =
  (enqueue: EnqueueJob) =>
  (scope: PersonalScopeTx, recipe: string, take: number): Promise<void> => {
    const job = produceScrollJob(recipe, take);
    return enqueue(scope, produceScrollQueue, job, {
      singletonKey: produceScrollSingletonKey(job),
      duplicate: 'ignore',
      priority: REQUEST_PRIORITY,
    });
  };

/** Sends the production job of one take of an ask order's answer, on its own queue, with a person's priority. */
const sendAnswerProduction =
  (enqueue: EnqueueJob) =>
  (scope: PersonalScopeTx, recipe: string, take: number): Promise<void> => {
    const job = produceScrollJob(recipe, take);
    return enqueue(scope, produceAnswerQueue, job, {
      singletonKey: produceScrollSingletonKey(job),
      duplicate: 'ignore',
      priority: REQUEST_PRIORITY,
    });
  };

/**
 * Supply's use cases for the API and the worker. `config` names the token of the process's
 * configuration (`SupplySettings`). The worker also passes `recordingHarness`, the recording-aware personal harness
 * (D-264, D-270), which lets its resolver match a free-text ask to the catalogue and place a question asked from a Scroll and
 * read it against the library Scrolls of its subject, each at the person's recording generation (it then needs content's
 * `READ_LIBRARY_PASSAGES`, the `FENCE_OWN_ACCOUNT` provider and `supplyRecordingOwnerProviders`); without them (the API,
 * tests) a waiting ask simply waits for a worker.
 */
export function supplyProviders(t: {
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
  readonly config: symbol;
  readonly recordingHarness?: symbol;
  /** The token of the process's event log: a count for the gap loop that could not be recorded is logged by its code (D-414). */
  readonly logEvent?: symbol;
}) {
  return [
    {
      provide: SUPPLY_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        t.config,
        READ_EXPLORATION_SNAPSHOT,
        CHOOSE_SCROLL_RECIPE,
        READ_SCROLL_PRODUCTION,
        READ_REGION_ENCOUNTER_CANDIDATES,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        LOCK_CURRENT_ENCOUNTERS,
        CHECK_REQUEST_SOURCE,
        CHECK_PERSONAL_OWNER_ACTIVE,
        READ_SCROLL_ASK_FACTS,
        READ_SCROLL_SOURCE_PAGES,
        RECORD_MADE_TO_ORDER_SCROLL,
        READ_MADE_TO_ORDER_PRODUCTION_IN,
        FENCE_PERSONAL_RECORDING,
        CHECK_PERSONAL_ACCOUNT_DISPOSABLE,
        ...(t.logEvent === undefined ? [] : [t.logEvent]),
      ],
      useFactory: (
        withScope: WithPersonalScope,
        enqueue: EnqueueJob,
        settings: SupplySettings,
        readExploration: ReadExplorationSnapshot,
        chooseRecipe: ChooseScrollRecipe,
        readProduction: ReadScrollProduction,
        readFacetCandidates: ReadRegionEncounterCandidates,
        readCandidates: ReadDiscoveryCandidates,
        readExact: ReadExactEncounter,
        lockCurrent: LockCurrentEncounters,
        checkSource: CheckRequestSource,
        ownerActive: CheckPersonalOwnerActive,
        readAskFacts: ReadScrollAskFacts,
        readSourcePages: ReadScrollSourcePages,
        recordOrder: RecordMadeToOrderScroll,
        readOrderProduction: ReadMadeToOrderProductionIn,
        fenceRecording: FencePersonalRecording,
        accountDisposable: CheckPersonalAccountDisposable,
        logEvent?: LogEvent,
      ): SupplyPorts => ({
        withScope,
        ownerActive,
        accountDisposable,
        store: supplyStore,
        chooseRecipe,
        readProduction,
        readFacetCandidates,
        createDailyCaps: {
          person: settings.supplyCreateDailyCap,
          planner: Math.min(settings.supplyPlannerCreateDailyCap, settings.supplyCreateDailyCap),
        },
        growthDailyCap: settings.supplyGrowthDailyCap ?? 0,
        // A count for the gap loop never fails or delays the ask or the demand that knew it: a savepoint, a short lock wait, the error logged by code.
        recordGapSignals: guardedGapSignals(
          makeRecordGapSignals({
            enabled: settings.supplyGrowthEnabled === true,
            marks: gapMarkStore,
            isDisposable: accountDisposable,
            now: () => new Date(),
          }),
          logEvent,
        ),
        askCaps: { perDay: settings.supplyAskDailyCap, perPersonPerDay: settings.supplyAskPersonDailyCap },
        askLedger: askOrderLedger,
        plannedLedger: plannedDemandLedger,
        readAskFacts,
        readSourcePages,
        recordOrder,
        readOrderProduction,
        fenceRecording,
        readMetUnits: async (scope, query) => {
          const snapshot = await readExploration(scope, {
            evaluatedAt: new Date().toISOString(),
            topicIds: [...query.topicIds],
            candidates: query.units.map((explanationUnitId) => ({ explanationUnitId, facets: [] })),
            provisionalLimit: 0,
          });
          // Without proof of what they have met, nothing is shown to be new: bind nothing.
          return snapshot.proofAvailability === 'available'
            ? new Set(encounteredUnitsOf(snapshot))
            : new Set(query.units);
        },
        enqueueProduction: sendProduction(enqueue),
        enqueueAnswerProduction: sendAnswerProduction(enqueue),
        readCandidates,
        readExact,
        lockCurrent,
        checkSource,
        newId: () => uuidv7(),
        idFor: stableUuid,
        now: () => new Date(),
        advance: advanceScopeRevision,
        notify: (scope, revision, eventId) => notifyScopeChanged(scope, { revision, eventId }),
        enqueue: (scope, requestId, options) =>
          enqueue(
            scope,
            resolveSupplyQueue,
            {
              v: 1,
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              requestId,
            },
            options === undefined
              ? undefined
              : {
                  startAfter: options.startAfter,
                  jobId: stableUuid(
                    options.attempt === 0
                      ? `supply-wait:${requestId}:${options.slot}`
                      : `supply-wait:${requestId}:${options.attempt}:${options.slot}`,
                  ),
                  duplicate: 'ignore',
                },
          ),
        receipts: {
          async find(scope, operation, commandId, command) {
            const r = await findPersonalReceipt(scope, {
              operation,
              commandId,
              requestHash: requestHash(operation, command),
              outcomeVersion: 1,
            });
            if (r.kind === 'new' || r.kind === 'replay') return r;
            return { kind: 'refused', reason: r.kind === 'key_reused' ? 'command_key_reused' : 'receipt_unavailable' };
          },
          insert: (scope, operation, commandId, command) =>
            insertPersonalReceipt(scope, {
              operation,
              commandId,
              requestHash: requestHash(operation, command),
              outcomeVersion: 1,
            }),
          complete: (scope, commandId, receipt) => completePersonalReceipt(scope, commandId, receipt),
        },
      }),
    },
    { provide: CREATE_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeCreateRequest(p) },
    { provide: READ_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeReadRequest(p) },
    { provide: LIST_CONTENT_REQUESTS, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeListRequests(p) },
    { provide: CANCEL_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeCancelRequest(p) },
    { provide: RETRY_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeRetryRequest(p) },
    {
      provide: RESOLVE_CONTENT_REQUEST,
      inject: [
        SUPPLY_PORTS,
        ...(t.recordingHarness === undefined ? [] : [t.recordingHarness, FENCE_OWN_ACCOUNT, READ_LIBRARY_PASSAGES]),
      ],
      useFactory: (
        p: SupplyPorts,
        recordingHarness?: RecordingReasoningHarness,
        fenceOwn?: FenceOwnAccount,
        readLibrary?: ReadLibraryPassages,
      ) =>
        makeResolveRequest(
          p,
          recordingHarness === undefined || fenceOwn === undefined || readLibrary === undefined
            ? undefined
            : makeMatchRequest(p, { harness: recordingHarness, fenceOwn }, readLibrary),
        ),
    },
    {
      provide: RECORD_PLANNED_DEMAND,
      inject: [SUPPLY_PORTS],
      useFactory: (p: SupplyPorts) => makeRecordPlannedDemand(p),
    },
    // The same recorder the ports hold, for a caller that knows where content runs out in its own transaction (the Composer's decision).
    // It is not the guarded one: its caller guards it, as the Composer's persist port does, so nothing runs under two savepoints.
    {
      provide: RECORD_GAP_SIGNALS,
      inject: [t.config, CHECK_PERSONAL_ACCOUNT_DISPOSABLE],
      useFactory: (settings: SupplySettings, accountDisposable: CheckPersonalAccountDisposable): RecordGapSignals =>
        makeRecordGapSignals({
          enabled: settings.supplyGrowthEnabled === true,
          marks: gapMarkStore,
          isDisposable: accountDisposable,
          now: () => new Date(),
        }),
    },
    {
      provide: COUNT_PLANNED_DEMAND,
      inject: [SUPPLY_PORTS],
      useFactory: (p: SupplyPorts) => makeCountPlannedDemand(p),
    },
  ];
}
/**
 * The owner check the recording-aware harness runs for Supply's personal runs (D-264, D-270): the request or the Quick answer
 * a run serves must still be the one it was made for. Installed wherever the recording harness is
 * (the worker), because the harness cannot be built without it.
 */
export function supplyRecordingOwnerProviders() {
  return [
    {
      provide: CHECK_SUPPLY_RECORDING_RUN,
      inject: [],
      useFactory: (): CheckPersonalRecordingRun =>
        makeCheckSupplyRecordingRun({ requests: supplyStore, quickAnswers: quickAnswerStore }),
    },
  ];
}

/**
 * Who may open the Scroll of an ask order (`READ_ASK_ORDER_AUDIENCE`, which Content asks): the person who asked. Both
 * processes that serve a person's reads compose it, like the branch audience (`orderAudienceProviders` of scenarios).
 */
export function askOrderAudienceProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: READ_ASK_ORDER_AUDIENCE,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): ReadOrderAudience => makeReadAskOrderAudience(db),
    },
  ];
}
export {
  makeCreateRequest,
  makeReadRequest,
  makeCancelRequest,
  makeRetryRequest,
  makeRecordPlannedDemand,
  makeCountPlannedDemand,
} from '../application/requests.js';
export {
  QUICK_ANSWER_PORTS,
  quickAnswerProviders,
  quickAnswerPurgeProviders,
  type QuickAnswerSettings,
} from './quick-answer-providers.js';
export { makeResolveRequest } from '../application/resolve.js';
export { makeMatchRequest } from '../application/matching.js';
export { makeListRequests } from '../application/list.js';
export { recoverOpenDemand, type RecoveredDemand } from './recover-open-demand.js';
export { expireStalePlannedDemand, type ExpiredPlannedDemand } from './expire-stale-planned-demand.js';
/** The gap loop's use cases and stores, composed by the worker (`apps/worker/src/growth-jobs.ts`) and the operator (#674, D-414). */
export { makeScanGaps } from '../application/gap-scan.js';
export { makeBriefGaps } from '../application/gap-brief.js';
export { proposalOf } from '../application/gap-proposal.js';
export {
  gapBriefLock,
  gapBriefStore,
  gapScanStore,
  readGapSummary,
  settleBlockedGap,
  type GapSummary,
  type SettleBlockedResult,
} from './postgres-gaps.js';
export { growthStore } from './postgres-growth.js';
export type { SupplyPorts } from '../application/ports.js';

/**
 * Quartermaster's Create for a thread's chosen branch, for the API (a choice is an HTTP command).
 * `enqueueJob` and `config` name the tokens of the process's job port and configuration
 * (`ScenarioOrderSettings`). Needs content's `RECORD_MADE_TO_ORDER_SCROLL`.
 */
export function scenarioOrderProviders(t: { readonly enqueueJob: symbol; readonly config: symbol }) {
  return [
    {
      provide: COMMISSION_SCENARIO_ORDER,
      inject: [t.enqueueJob, t.config, RECORD_MADE_TO_ORDER_SCROLL],
      useFactory: (enqueue: EnqueueJob, settings: ScenarioOrderSettings, recordOrder: RecordMadeToOrderScroll) =>
        makeCommissionScenarioOrder({
          store: scenarioOrderStore,
          recordOrder,
          enqueueProduction: sendProduction(enqueue),
          caps: { perDay: settings.supplyScenarioDailyCap, perThreadPerDay: settings.supplyScenarioThreadDailyCap },
          now: () => new Date(),
        }),
    },
  ];
}
