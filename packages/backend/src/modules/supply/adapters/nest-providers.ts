import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  CANCEL_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
} from '../public.js';
import { CHECK_REQUEST_SOURCE, type CheckRequestSource } from '../../experience/public.js';
import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  LOCK_CURRENT_ENCOUNTERS,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type LockCurrentEncounters,
} from '../../content/public.js';
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
import { makeCreateRequest, makeReadRequest, makeCancelRequest, makeResolveRequest } from '../application/requests.js';
import { resolveSupplyQueue } from '../events.js';
import type { SupplyPorts } from '../application/ports.js';
import { supplyStore } from './postgres-store.js';
export const SUPPLY_PORTS = Symbol('supply.ports');
/** Same provider-free use cases in API/worker. No HTTP route or production bridge is installed. */
export function supplyProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    {
      provide: SUPPLY_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        LOCK_CURRENT_ENCOUNTERS,
        CHECK_REQUEST_SOURCE,
        CHECK_PERSONAL_OWNER_ACTIVE,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        enqueue: EnqueueJob,
        readCandidates: ReadDiscoveryCandidates,
        readExact: ReadExactEncounter,
        lockCurrent: LockCurrentEncounters,
        checkSource: CheckRequestSource,
        ownerActive: CheckPersonalOwnerActive,
      ): SupplyPorts => ({
        withScope,
        ownerActive,
        store: supplyStore,
        readCandidates,
        readExact,
        lockCurrent,
        checkSource,
        newId: () => uuidv7(),
        now: () => new Date(),
        advance: advanceScopeRevision,
        notify: (scope, revision, eventId) => notifyScopeChanged(scope, { revision, eventId }),
        enqueue: (scope, requestId) =>
          enqueue(scope, resolveSupplyQueue, {
            v: 1,
            universeId: scope.authority.universeId,
            privacyEpoch: scope.authority.privacyEpoch,
            requestId,
          }),
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
    { provide: CANCEL_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeCancelRequest(p) },
    { provide: RESOLVE_CONTENT_REQUEST, inject: [SUPPLY_PORTS], useFactory: (p: SupplyPorts) => makeResolveRequest(p) },
  ];
}
export { makeCreateRequest, makeReadRequest, makeCancelRequest, makeResolveRequest } from '../application/requests.js';
export type { SupplyPorts } from '../application/ports.js';
