import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type WithPersonalScope,
} from '../../identity/public.js';
import {
  READ_EXPLORATION_SNAPSHOT,
  READ_RECENT_CONTEXT_TOPICS,
  type ReadExplorationSnapshot,
  type ReadRecentContextTopics,
} from '../../personal-context/public.js';
import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
} from '../../content/public.js';
import {
  RECORDING_REASONING_HARNESS,
  CHECK_PLANNER_RECORDING_RUN,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import { canonicalSha256, FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import {
  requestHash,
  findPersonalReceipt,
  insertPersonalReceipt,
  completePersonalReceipt,
} from '../../../infrastructure/receipts/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { plannerStore } from './postgres-store.js';
import { plannerQueue } from '../events.js';
import { makeMaterialChange, makeRequestPlanner } from '../application/request.js';
import {
  makeRunPlanner,
  makeReadPlannerOpportunities,
  makeCheckPlannerRecordingRun as makeOwnerChecker,
} from '../application/run.js';
import type { PlannerPorts, RequestPlannerOutcome } from '../application/ports.js';
import { REQUEST_PLANNER, PLANNER_MATERIAL_CHANGE, RUN_PLANNER, READ_PLANNER_OPPORTUNITIES } from '../public.js';
const REQUEST_PORTS = Symbol('planner.request-ports');
const PLANNER_PORTS = Symbol('planner.ports');
const hash = (value: unknown) => requestHash('personal-planner.v0', value as Parameters<typeof requestHash>[1]);
const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
const now = () => new Date();
const key = (commandId: string, requestHash: string) => ({
  commandId,
  requestHash,
  operation: 'planner.request',
  outcomeVersion: 1,
});
type RequestPorts = Parameters<typeof makeRequestPlanner>[0];
/** Both API and worker install only this request facility; it contains no harness/provider. */
export function plannerRequestProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    {
      provide: REQUEST_PORTS,
      inject: [t.withPersonalScope, t.enqueueJob, FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        enqueue: EnqueueJob,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
      ): RequestPorts => ({
        fenceOwn,
        fenceRecording,
        withPersonalScope,
        store: plannerStore,
        hash,
        canonicalHash: canonicalSha256,
        newId: () => uuidv7(),
        now,
        enqueue: async (cap, runId, delayed) => {
          recordingTransactionOf(cap);
          const scope = cap.personal,
            header = await plannerStore.header(scope, runId),
            root = await plannerStore.root(cap);
          if (
            !header?.recording ||
            header.recording.source.generation !== cap.generation ||
            header.recording.accountId !== root.accountId
          )
            throw new Error('PLANNER_WAKE_ORIGIN_INVALID');
          if (delayed) {
            if (header.status !== 'prepared' || header.claimId !== delayed.expectedClaimId) return;
            if (header.claimWakeClaimId === delayed.expectedClaimId) return;
            await enqueue(
              scope,
              plannerQueue,
              {
                v: 2,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                runId,
                recordingGeneration: cap.generation,
                expectedClaimId: delayed.expectedClaimId,
              },
              { startAfter: delayed.startAfter },
            );
            await plannerStore.writeRun(scope, { ...header, claimWakeClaimId: delayed.expectedClaimId });
          } else {
            if (header.normalWakeId) return;
            const wakeId = uuidv7();
            await enqueue(scope, plannerQueue, {
              v: 2,
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              runId,
              recordingGeneration: cap.generation,
              wakeId,
            });
            await plannerStore.writeRun(scope, { ...header, normalWakeId: wakeId });
          }
        },
        receipts: {
          find: async (scope, commandId, hash) => {
            const r = await findPersonalReceipt(scope, key(commandId, hash));
            return r.kind === 'new'
              ? r
              : r.kind === 'replay'
                ? { kind: 'replay', outcome: r.outcome as RequestPlannerOutcome }
                : { kind: 'refused' };
          },
          insert: (scope, commandId, hash) => insertPersonalReceipt(scope, key(commandId, hash)),
          complete: (scope, commandId, outcome) => completePersonalReceipt(scope, commandId, outcome),
        },
      }),
    },
    {
      provide: CHECK_PLANNER_RECORDING_RUN,
      inject: [],
      useFactory: () => makeCheckPlannerRecordingRun({ store: plannerStore, now }),
    },
    { provide: REQUEST_PLANNER, inject: [REQUEST_PORTS], useFactory: (p: RequestPorts) => makeRequestPlanner(p) },
    {
      provide: PLANNER_MATERIAL_CHANGE,
      inject: [REQUEST_PORTS],
      useFactory: (p: RequestPorts) => makeMaterialChange(p),
    },
  ];
}
/** Worker-only role; execution gate is checked before preparing a model reservation. */
export function plannerWorkerProviders(t: { readonly workerConfig: symbol }) {
  return [
    {
      provide: PLANNER_PORTS,
      inject: [
        REQUEST_PORTS,
        READ_EXPLORATION_SNAPSHOT,
        READ_RECENT_CONTEXT_TOPICS,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        RECORDING_REASONING_HARNESS,
        t.workerConfig,
      ],
      useFactory: (
        request: RequestPorts,
        readSnapshot: ReadExplorationSnapshot,
        readRecentTopics: ReadRecentContextTopics,
        readInventory: ReadDiscoveryCandidates,
        readExact: ReadExactEncounter,
        harness: RecordingReasoningHarness,
        config: WorkerConfig,
      ): PlannerPorts => ({
        ...request,
        readSnapshot,
        readRecentTopics,
        readInventory,
        readExact,
        harness,
        capabilities,
        now,
        enabled: () => config.plannerEnabled,
      }),
    },
    { provide: RUN_PLANNER, inject: [PLANNER_PORTS], useFactory: (p: PlannerPorts) => makeRunPlanner(p) },
    {
      provide: READ_PLANNER_OPPORTUNITIES,
      inject: [PLANNER_PORTS],
      useFactory: (p: PlannerPorts) => makeReadPlannerOpportunities(p),
    },
  ];
}
export { plannerStore } from './postgres-store.js';
export { makeRunPlanner, makeReadPlannerOpportunities } from '../application/run.js';
export { makeMaterialChange, makeRequestPlanner } from '../application/request.js';
export type { PlannerPorts, FrozenContext } from '../application/ports.js';

/** CI role evaluation uses the same role and frozen prepared context as the worker. */
export { plannerRole, plannerContextItems } from '../application/role.js';

/** Adapter supplies canonical crypto; applications receive only its pure hash capability. */
export function makeCheckPlannerRecordingRun(p: Pick<PlannerPorts, 'store' | 'now'>) {
  return makeOwnerChecker({ ...p, canonicalHash: canonicalSha256 });
}
