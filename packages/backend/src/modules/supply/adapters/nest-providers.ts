import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  CANCEL_CONTENT_REQUEST,
  RETRY_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
  COMMISSION_SCENARIO_ORDER,
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
  CHECK_PERSONAL_OWNER_ACTIVE,
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
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
} from '../application/requests.js';
import { makeListRequests } from '../application/list.js';
import { makeCommissionScenarioOrder } from '../application/scenario-orders.js';
import { scenarioOrderStore } from './postgres-scenario-orders.js';
import { makeMatchRequest } from '../application/matching.js';
import { makeResolveRequest } from '../application/resolve.js';
import { resolveSupplyQueue } from '../events.js';
import type { SupplyPorts } from '../application/ports.js';
import { supplyStore } from './postgres-store.js';
import { askOrderLedger, makeReadAskOrderAudience } from './postgres-ask-orders.js';
import { quickAnswerStore } from './postgres-quick-answers.js';
import { makeCheckSupplyRecordingRun } from '../application/check-recording-run.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
export const SUPPLY_PORTS = Symbol('supply.ports');
/** What Supply reads from a process's configuration (the API's and the worker's both carry it). */
export interface SupplySettings {
  /** Productions people's own asks may start per UTC day; 0 turns Create off. */
  readonly supplyCreateDailyCap: number;
  /** Productions the Planner's demand may start per UTC day; never above the cap for people. */
  readonly supplyPlannerCreateDailyCap: number;
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
      ): SupplyPorts => ({
        withScope,
        ownerActive,
        store: supplyStore,
        chooseRecipe,
        readProduction,
        readFacetCandidates,
        createDailyCaps: {
          person: settings.supplyCreateDailyCap,
          planner: Math.min(settings.supplyPlannerCreateDailyCap, settings.supplyCreateDailyCap),
        },
        askCaps: { perDay: settings.supplyAskDailyCap, perPersonPerDay: settings.supplyAskPersonDailyCap },
        askLedger: askOrderLedger,
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
