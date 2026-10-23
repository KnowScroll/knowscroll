import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  LIST_CONTENT_REQUESTS,
  CANCEL_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
} from '../public.js';
import { CHECK_REQUEST_SOURCE, type CheckRequestSource } from '../../experience/public.js';
import {
  CHOOSE_SCROLL_RECIPE,
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_SCROLL_PRODUCTION,
  LOCK_CURRENT_ENCOUNTERS,
  produceScrollJob,
  produceScrollSingletonKey,
  produceScrollQueue,
  type ChooseScrollRecipe,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type ReadScrollProduction,
  type LockCurrentEncounters,
} from '../../content/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  type CheckPersonalOwnerActive,
  type WithPersonalScope,
} from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
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
  makeRecordPlannedDemand,
} from '../application/requests.js';
import { makeListRequests } from '../application/list.js';
import { makeMatchRequest } from '../application/matching.js';
import { makeResolveRequest } from '../application/resolve.js';
import { resolveSupplyQueue } from '../events.js';
import type { SupplyPorts } from '../application/ports.js';
import { supplyStore } from './postgres-store.js';
export const SUPPLY_PORTS = Symbol('supply.ports');
/** What Supply reads from a process's configuration (the API's and the worker's both carry it). */
export interface SupplySettings {
  readonly supplyCreateDailyCap: number;
}

/** Priority of a person's production job over operator seeding (priority 0). */
const REQUEST_PRIORITY = 10;

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
        CHOOSE_SCROLL_RECIPE,
        READ_SCROLL_PRODUCTION,
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
        chooseRecipe: ChooseScrollRecipe,
        readProduction: ReadScrollProduction,
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
        createDailyCap: settings.supplyCreateDailyCap,
        enqueueProduction: (scope, recipe) => {
          const job = produceScrollJob(recipe);
          return enqueue(scope, produceScrollQueue, job, {
            singletonKey: produceScrollSingletonKey(job),
            duplicate: 'ignore',
            priority: REQUEST_PRIORITY,
          });
        },
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
            options === undefined ? undefined : { ...options, duplicate: 'ignore' },
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
  makeRecordPlannedDemand,
} from '../application/requests.js';
export { makeResolveRequest } from '../application/resolve.js';
export { makeMatchRequest } from '../application/matching.js';
export { makeListRequests } from '../application/list.js';
export type { SupplyPorts } from '../application/ports.js';
