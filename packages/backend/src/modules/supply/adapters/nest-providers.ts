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
  LOCK_CURRENT_ENCOUNTERS,
  RECORD_MADE_TO_ORDER_SCROLL,
  type RecordMadeToOrderScroll,
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
import type { ReasoningHarness } from '../../../reasoning/public.js';
import {
  READ_EXPLORATION_SNAPSHOT,
  encounteredUnitsOf,
  type ReadExplorationSnapshot,
} from '../../personal-context/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
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
export const SUPPLY_PORTS = Symbol('supply.ports');
/** What Supply reads from a process's configuration (the API's and the worker's both carry it). */
export interface SupplySettings {
  /** Productions people's own asks may start per UTC day; 0 turns Create off. */
  readonly supplyCreateDailyCap: number;
  /** Productions the Planner's demand may start per UTC day; never above the cap for people. */
  readonly supplyPlannerCreateDailyCap: number;
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
 * configuration (`SupplySettings`). The worker also passes `harness`, the personal reasoning
 * harness, which lets its resolver match free-text asks to the catalogue; without it (the API, tests)
 * a free-text ask simply waits for a worker.
 */
export function supplyProviders(t: {
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
  readonly config: symbol;
  readonly harness?: symbol;
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
      inject: [SUPPLY_PORTS, ...(t.harness === undefined ? [] : [t.harness])],
      useFactory: (p: SupplyPorts, harness?: ReasoningHarness) =>
        makeResolveRequest(p, harness === undefined ? undefined : makeMatchRequest(p, harness)),
    },
    {
      provide: RECORD_PLANNED_DEMAND,
      inject: [SUPPLY_PORTS],
      useFactory: (p: SupplyPorts) => makeRecordPlannedDemand(p),
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
