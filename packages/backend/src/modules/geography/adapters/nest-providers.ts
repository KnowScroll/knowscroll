import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  READ_COVERAGE_INPUTS,
  READ_TRUSTED_COVERAGE,
  type ReadCoverageInputs,
  type ReadTrustedCoverage,
} from '../../personal-context/public.js';
import {
  CHECK_PERSONAL_OWNER_ACTIVE,
  type WithPersonalScope,
  type CheckPersonalOwnerActive,
  type PersonalScopeTx,
} from '../../identity/public.js';
import { REASONING_HARNESS, type ReasoningHarness } from '../../../reasoning/public.js';
import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { transactionOf, advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import {
  findPersonalReceipt,
  insertPersonalReceipt,
  completePersonalReceipt,
  requestHash,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { cartographyQueue, publishDeltaQueue } from '../events.js';
import {
  GEOGRAPHY_MATERIAL_CHANGE,
  REQUEST_CARTOGRAPHY,
  RUN_CARTOGRAPHER,
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  PUBLISH_GEOGRAPHY_DELTA,
} from '../public.js';
import { makeRequestCartography, makeGeographyMaterialChange } from '../application/request.js';
import { makeReadGeography, makeReadDeltas } from '../application/read.js';
import { makeRunCartographer, makePublishDelta } from '../application/run.js';
import type { GeographyPorts, RequestCartographyResult } from '../application/ports.js';
import { geographyStore } from './postgres-store.js';
export const GEOGRAPHY_PORTS = Symbol('geography.ports');
const key = (commandId: string, input: unknown) => ({
  commandId,
  operation: 'geography.request',
  outcomeVersion: 1,
  requestHash: requestHash('geography.request', input as CanonicalJson),
});
/** Provider-free API request/read/apply ports. Required jobs use the caller's pg-boss transaction. */
export function geographyProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    {
      provide: GEOGRAPHY_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        READ_COVERAGE_INPUTS,
        READ_TRUSTED_COVERAGE,
        CHECK_PERSONAL_OWNER_ACTIVE,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        enqueue: EnqueueJob,
        readInputs: ReadCoverageInputs,
        readTrusted: ReadTrustedCoverage,
        ownerActive: CheckPersonalOwnerActive,
      ): GeographyPorts => ({
        withScope,
        readInputs,
        readTrusted,
        ownerActive,
        store: geographyStore,
        hash: (value) => canonicalSha256(value),
        newId: () => uuidv7(),
        now: () => new Date(),
        advance: advanceScopeRevision,
        notify: (scope, revision, eventId) => notifyScopeChanged(scope, { revision, eventId }),
        enqueue: async (scope, runId, delayed) => {
          const exists =
            await sql`select 1 from pgboss.job where name=${cartographyQueue.name} and state in('created','retry') and data->>'universeId'=${scope.authority.universeId} and data->>'runId'=${runId} and coalesce(data->>'expectedClaimId','')=${delayed?.expectedClaimId ?? ''} limit 1`.execute(
              transactionOf(scope),
            );
          if (exists.rows.length) return;
          await enqueue(
            scope,
            cartographyQueue,
            {
              v: 1,
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              runId,
              ...(delayed ? { expectedClaimId: delayed.expectedClaimId } : {}),
            },
            delayed ? { startAfter: delayed.startAfter } : undefined,
          );
        },
        enqueueDelta: (scope, delta) =>
          enqueue(scope, publishDeltaQueue, {
            v: 1,
            universeId: scope.authority.universeId,
            privacyEpoch: scope.authority.privacyEpoch,
            transitionId: delta.transitionId,
            geographyRevision: delta.geography.revision,
          }),
        receipts: {
          find: async (scope, id, input) => {
            const r = await findPersonalReceipt(scope, key(id, input));
            return r.kind === 'new'
              ? r
              : r.kind === 'replay'
                ? { kind: 'replay', outcome: r.outcome as RequestCartographyResult }
                : { kind: 'refused' };
          },
          insert: (s, id, input) => insertPersonalReceipt(s, key(id, input)),
          complete: (s, id, result) => completePersonalReceipt(s, id, result),
        },
      }),
    },
    {
      provide: GEOGRAPHY_MATERIAL_CHANGE,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makeGeographyMaterialChange(p),
    },
    {
      provide: REQUEST_CARTOGRAPHY,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makeRequestCartography(p),
    },
    { provide: READ_OWN_GEOGRAPHY, inject: [GEOGRAPHY_PORTS], useFactory: (p: GeographyPorts) => makeReadGeography(p) },
    { provide: READ_OWN_DELTAS, inject: [GEOGRAPHY_PORTS], useFactory: (p: GeographyPorts) => makeReadDeltas(p) },
    {
      provide: PUBLISH_GEOGRAPHY_DELTA,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makePublishDelta(p),
    },
  ];
}
/** Separate flag and economic permit. Normal composition supplies no permit and cannot spend. */
export function cartographerWorkerProviders(
  t: { readonly workerConfig: symbol },
  options: { readonly permitted?: (scope: PersonalScopeTx) => Promise<boolean> } = {},
) {
  return [
    {
      provide: RUN_CARTOGRAPHER,
      inject: [GEOGRAPHY_PORTS, REASONING_HARNESS, t.workerConfig],
      useFactory: (base: GeographyPorts, harness: ReasoningHarness, config: WorkerConfig) =>
        makeRunCartographer({
          ...base,
          harness,
          enabled: () => config.cartographerEnabled,
          permitted: options.permitted ?? (() => Promise.resolve(false)),
        }),
    },
  ];
}
export { makeRunCartographer } from '../application/run.js';
export { makeRequestCartography, makeGeographyMaterialChange } from '../application/request.js';
export { applyProposal } from '../application/apply.js';
export { prepareGeography } from '../application/context.js';
export { geographyStore } from './postgres-store.js';
export type { GeographyPorts, CartographerPorts, GeographyContext } from '../application/ports.js';
