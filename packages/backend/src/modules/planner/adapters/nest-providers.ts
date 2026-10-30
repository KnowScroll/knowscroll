import { sql } from 'kysely';
import type { RecordingScopeTx } from '../../identity/public.js';
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
import {
  REQUEST_PLANNER,
  PLANNER_MATERIAL_CHANGE,
  RUN_PLANNER,
  READ_PLANNER_OPPORTUNITIES,
  READ_CURRENT_PLAN,
} from '../public.js';
import { RECORD_PLANNED_DEMAND, type RecordPlannedDemand } from '../../supply/public.js';
import { makeReadCurrentPlan } from '../application/read-plan.js';
const REQUEST_PORTS = Symbol('planner.request-ports');
const PLANNER_PORTS = Symbol('planner.ports');
const hash = (value: unknown) => requestHash('personal-planner.v0', value as Parameters<typeof requestHash>[1]);
const capabilities = {
  ...FULL_V1_CAPABILITIES,
  documentSchemas: ['scroll-document.v1', 'scroll-document.v2', 'reel-document.v1'],
};
const now = () => new Date();
const key = (commandId: string, requestHash: string) => ({
  commandId,
  requestHash,
  operation: 'planner.request',
  outcomeVersion: 1,
});
/** Exact known queue PK only, under the producer's already-gated root. Never a JSON discovery scan. */
async function prepareNormalWake(cap: RecordingScopeTx, runId: string): Promise<'ready' | 'busy' | 'unavailable'> {
  const trx = recordingTransactionOf(cap),
    root = await plannerStore.root(cap),
    header = await plannerStore.accountingHeader(cap.personal, runId);
  if (
    !header ||
    (header.accountId && header.accountId !== root.accountId) ||
    (header.generation === undefined && !header.legacyUnproved) ||
    (header.generation !== undefined && !header.accountId)
  )
    return 'unavailable';
  const claim = (
    await sql<{
      claim_until: Date | null;
    }>`select claim_until from planner.runs where universe_id=${cap.personal.authority.universeId}::uuid and privacy_epoch=${cap.personal.authority.privacyEpoch} and id=${runId}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!claim) return 'unavailable';
  if (claim.claim_until && claim.claim_until.getTime() > now().getTime()) return 'busy';
  if (!header.normalWakeId) return 'ready';
  const marker = header.normalWakeId,
    original = header.generation ?? null;
  const legacyInitial = header.legacyUnproved && cap.generation === 1;
  const expected = {
    v: 2,
    universeId: cap.personal.authority.universeId,
    privacyEpoch: cap.personal.authority.privacyEpoch,
    runId,
    recordingGeneration: legacyInitial ? 1 : original,
    wakeId: marker,
  };
  const retirement = JSON.stringify({ ...expected, recordingGeneration: original, kind: 'retire' });
  const legacyOrdinary =
    original === null && header.legacyUnproved ? JSON.stringify({ ...expected, recordingGeneration: 1 }) : undefined;
  const bound = legacyInitial
    ? sql`data=${JSON.stringify(expected)}::jsonb`
    : original === null
      ? legacyOrdinary
        ? sql`(data=${retirement}::jsonb or data=${legacyOrdinary}::jsonb)`
        : sql`data=${retirement}::jsonb`
      : sql`(data=${JSON.stringify(expected)}::jsonb or data=${retirement}::jsonb)`;
  const row = (
    await sql<{
      state: string;
      bound: boolean;
    }>`select state,${bound} as bound from pgboss.job where name='planner.run' and id=${marker}::uuid`.execute(trx)
  ).rows[0];
  if (row && row.bound !== true) return 'unavailable';
  if (row && ['created', 'retry', 'active'].includes(row.state)) return 'busy';
  if (row && !['completed', 'cancelled', 'failed'].includes(row.state)) return 'unavailable';
  return (await plannerStore.consumeNormalWake(cap.personal, runId, marker)) ? 'ready' : 'unavailable';
}
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
        prepareNormalWake,
        enqueueRetirement: async (cap, runId) => {
          recordingTransactionOf(cap);
          const root = await plannerStore.root(cap),
            header = await plannerStore.accountingHeader(cap.personal, runId);
          if (
            !header ||
            (header.accountId && header.accountId !== root.accountId) ||
            header.generation === cap.generation ||
            (header.generation === undefined && cap.generation === 1)
          )
            return;
          const ready = await prepareNormalWake(cap, runId);
          if (ready === 'busy') return;
          if (ready !== 'ready') throw new Error('PLANNER_NORMAL_WAKE_UNPROVED');
          const wakeId = uuidv7();
          await enqueue(
            cap.personal,
            plannerQueue,
            {
              v: 2,
              kind: 'retire',
              universeId: cap.personal.authority.universeId,
              privacyEpoch: cap.personal.authority.privacyEpoch,
              runId,
              recordingGeneration: header.generation ?? null,
              wakeId,
            },
            { jobId: wakeId },
          );
          const trx = recordingTransactionOf(cap);
          const updated = await trx
            .updateTable('planner.runs')
            .set({ normal_wake_id: wakeId })
            .where('universe_id', '=', cap.personal.authority.universeId)
            .where('privacy_epoch', '=', cap.personal.authority.privacyEpoch)
            .where('id', '=', runId)
            .where('normal_wake_id', 'is', null)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) throw new Error('PLANNER_RETIREMENT_WAKE_RACE');
        },
        enqueue: async (cap, runId, delayed) => {
          recordingTransactionOf(cap);
          const scope = cap.personal,
            header = await plannerStore.header(scope, runId),
            root = await plannerStore.root(cap);
          if (
            !header ||
            (header.recording
              ? header.recording.source.generation !== cap.generation || header.recording.accountId !== root.accountId
              : cap.generation !== 1 || header.hasRecordingMetadata)
          )
            throw new Error('PLANNER_WAKE_ORIGIN_INVALID');
          if (delayed?.expectedClaimId) {
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
            const ready = await prepareNormalWake(cap, runId);
            if (ready === 'busy') return;
            if (ready !== 'ready') throw new Error('PLANNER_NORMAL_WAKE_UNPROVED');
            const wakeId = uuidv7();
            await enqueue(
              scope,
              plannerQueue,
              {
                v: 2,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
                runId,
                recordingGeneration: cap.generation,
                wakeId,
              },
              { jobId: wakeId, ...(delayed ? { startAfter: delayed.startAfter } : {}) },
            );
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
/**
 * The stored plan read Composer uses on the navigation path. Needs no harness, provider or worker
 * configuration, so the API and the worker install the same reader.
 */
export function plannerReadProviders() {
  return [{ provide: READ_CURRENT_PLAN, inject: [], useFactory: () => makeReadCurrentPlan({ store: plannerStore }) }];
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
        RECORD_PLANNED_DEMAND,
        t.workerConfig,
      ],
      useFactory: (
        request: RequestPorts,
        readSnapshot: ReadExplorationSnapshot,
        readRecentTopics: ReadRecentContextTopics,
        readInventory: ReadDiscoveryCandidates,
        readExact: ReadExactEncounter,
        harness: RecordingReasoningHarness,
        recordDemand: RecordPlannedDemand,
        config: WorkerConfig,
      ): PlannerPorts => ({
        ...request,
        readSnapshot,
        readRecentTopics,
        readInventory,
        readExact,
        harness,
        recordDemand,
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
