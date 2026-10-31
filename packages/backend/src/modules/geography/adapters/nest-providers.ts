import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  READ_COVERAGE_INPUTS,
  READ_EXPLORATION_SNAPSHOT,
  READ_TRUSTED_COVERAGE,
  type ReadCoverageInputs,
  type ReadExplorationSnapshot,
  type ReadTrustedCoverage,
} from '../../personal-context/public.js';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  CHECK_PERSONAL_OWNER_ACTIVE,
  type WithPersonalScope,
  type CheckPersonalOwnerActive,
  type PersonalScopeTx,
} from '../../identity/public.js';
import {
  RECORDING_REASONING_HARNESS,
  CHECK_GEOGRAPHY_RECORDING_RUN,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { transactionOf, advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { makeEnqueueInTransaction, type EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import type { PgBoss } from 'pg-boss';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
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
  GEOGRAPHY_APPLIED,
  READ_GEOGRAPHY_SCENE_INPUT,
  REQUEST_CARTOGRAPHY,
  RUN_CARTOGRAPHER,
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  READ_OWN_EMERGING,
  READ_OWN_PLACE_CONCEPTS,
  PUBLISH_GEOGRAPHY_DELTA,
  READ_OWN_REGION_CONSTRAINT,
  SETTLE_QUIET,
  SWEEP_QUIET,
} from '../public.js';
import { makeRequestCartography, makeGeographyMaterialChange } from '../application/request.js';
import { makeReadGeography, makeReadDeltas } from '../application/read.js';
import { makeReadOwnEmerging } from '../application/emerging.js';
import { makeReadOwnPlaceConcepts } from '../application/place-concepts.js';
import {
  makeRunCartographer,
  makePublishDelta,
  makeCheckGeographyRecordingRun as makeOwnerCheck,
} from '../application/run.js';
import type {
  GeographyPorts,
  GeographyContext,
  GeographyAccountingHeader,
  RequestCartographyResult,
} from '../application/ports.js';
import { makeReadGeographySceneInput } from '../application/scene-input.js';
import type { GeographyApplied } from '../public.js';
import { geographyStore, readRegionPlace } from './postgres-store.js';
import { makeReadOwnRegionConstraint } from '../application/region-constraint.js';
import { makeSettleQuiet, makeSweepQuiet } from '../application/quiet.js';
import { quietSweepStore } from './quiet-store.js';
export const GEOGRAPHY_PORTS = Symbol('geography.ports');
const key = (commandId: string, input: unknown) => ({
  commandId,
  operation: 'geography.request',
  outcomeVersion: 1,
  requestHash: requestHash('geography.request', input as CanonicalJson),
});
/** One exact existing (name,id) queue key; no historical jobs or protected payload are read. */
async function normalWakeReplaceable(
  scope: PersonalScopeTx,
  h: GeographyAccountingHeader,
  mode: 'normal' | 'retire',
): Promise<boolean> {
  if (Boolean(h.claimId) !== Boolean(h.claimUntil) || (h.claimUntil && Date.parse(h.claimUntil) > Date.now()))
    return false;
  if (!h.normalWakeId) return true;
  const original = h.generation ?? null,
    marker = h.normalWakeId,
    base = {
      v: 2,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      runId: h.id,
      wakeId: marker,
    },
    ordinary = JSON.stringify({
      ...base,
      recordingGeneration: original === null && h.legacyOrigin && mode === 'normal' ? 1 : original,
    }),
    retirement = JSON.stringify({ ...base, recordingGeneration: original, kind: 'retire' }),
    legacy = original === null && h.legacyOrigin ? JSON.stringify({ ...base, recordingGeneration: 1 }) : undefined;
  const match =
    original === null
      ? mode === 'normal'
        ? sql`data=${ordinary}::jsonb`
        : legacy
          ? sql`(data=${legacy}::jsonb or data=${retirement}::jsonb)`
          : sql`data=${retirement}::jsonb`
      : sql`(data=${ordinary}::jsonb or data=${retirement}::jsonb)`;
  const row = (
    await sql<{
      state: string;
      bound: boolean;
    }>`select state,${match} as bound from pgboss.job where name=${cartographyQueue.name} and id=${marker}::uuid`.execute(
      transactionOf(scope),
    )
  ).rows[0];
  if (!row) return true;
  return row.bound === true && ['completed', 'cancelled', 'failed'].includes(row.state);
}
/** Provider-free API request/read/apply ports. Required jobs use the caller's pg-boss transaction. */
export function geographyProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    {
      provide: READ_OWN_REGION_CONSTRAINT,
      inject: [CHECK_PERSONAL_OWNER_ACTIVE],
      useFactory: (ownerActive: CheckPersonalOwnerActive) =>
        makeReadOwnRegionConstraint({
          ownerActive,
          state: (scope) => geographyStore.state(scope),
          object: readRegionPlace,
        }),
    },
    {
      provide: GEOGRAPHY_PORTS,
      inject: [
        t.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        FENCE_PERSONAL_RECORDING,
        t.enqueueJob,
        READ_COVERAGE_INPUTS,
        READ_TRUSTED_COVERAGE,
        CHECK_PERSONAL_OWNER_ACTIVE,
        GEOGRAPHY_APPLIED,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
        enqueue: EnqueueJob,
        readInputs: ReadCoverageInputs,
        readTrusted: ReadTrustedCoverage,
        ownerActive: CheckPersonalOwnerActive,
        applied: GeographyApplied,
      ): GeographyPorts => ({
        withScope,
        fenceOwn,
        fenceRecording,
        applied,
        rootRevision: async (scope) => {
          const row = await transactionOf(scope)
            .selectFrom('identity.universes')
            .select('revision')
            .where('id', '=', scope.authority.universeId)
            .executeTakeFirstOrThrow();
          return row.revision;
        },
        readInputs,
        readTrusted,
        ownerActive,
        store: geographyStore,
        hash: (value) => canonicalSha256(value),
        newId: () => uuidv7(),
        now: () => new Date(),
        advance: advanceScopeRevision,
        notify: (scope, revision, eventId) => notifyScopeChanged(scope, { revision, eventId }),
        enqueue: async (cap, runId, delayed) => {
          const root = await geographyStore.root(cap);
          const scope = cap.personal,
            minimal = await geographyStore.accountingHeader(scope, runId);
          if (
            !minimal ||
            (minimal.generation === undefined
              ? !minimal.legacyOrigin || cap.generation !== 1
              : minimal.generation !== cap.generation ||
                minimal.accountId?.toLowerCase() !== root.accountId.toLowerCase())
          )
            return false;
          const h = await geographyStore.header(scope, runId);
          if (
            !h ||
            !['queued', 'prepared', 'blocked', 'unknown'].includes(h.status) ||
            (h.recording
              ? h.recording.source.generation !== cap.generation ||
                h.recording.accountId.toLowerCase() !== root.accountId.toLowerCase()
              : cap.generation !== 1)
          )
            return false;
          if (delayed?.expectedClaimId) {
            if (h.claimId !== delayed.expectedClaimId || h.claimWakeClaimId === delayed.expectedClaimId) return false;
            await geographyStore.writeRun(scope, { ...h, claimWakeClaimId: delayed.expectedClaimId });
            await enqueue(
              scope,
              cartographyQueue,
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
            return true;
          } else {
            if (!(await normalWakeReplaceable(scope, minimal, 'normal'))) return false;
            if (h.normalWakeId && !(await geographyStore.consumeNormalWake(scope, h.id, h.normalWakeId)))
              throw new Error('GEOGRAPHY_NORMAL_WAKE_RACE');
            const wakeId = uuidv7();
            await geographyStore.writeRun(scope, {
              ...h,
              status: h.hasContext ? 'prepared' : 'queued',
              claimId: undefined,
              claimUntil: undefined,
              claimWakeClaimId: undefined,
              normalWakeId: wakeId,
            });
            await enqueue(
              scope,
              cartographyQueue,
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
            return true;
          }
        },
        enqueueRetirement: async (cap, runId) => {
          const root = await geographyStore.root(cap),
            scope = cap.personal,
            state = await geographyStore.state(scope),
            h = await geographyStore.accountingHeader(scope, runId);
          if (
            !h ||
            state.activeRunId !== runId ||
            state.desiredSource?.generation !== cap.generation ||
            !['queued', 'prepared', 'blocked', 'unknown'].includes(h.status)
          )
            return;
          if (
            h.generation === cap.generation ||
            (h.generation === undefined && cap.generation === 1) ||
            (h.accountId && h.accountId.toLowerCase() !== root.accountId.toLowerCase()) ||
            (h.generation === undefined && !h.legacyOrigin) ||
            (h.generation !== undefined && !h.accountId)
          )
            return;
          if (!(await normalWakeReplaceable(scope, h, 'retire'))) return;
          if (h.normalWakeId && !(await geographyStore.consumeNormalWake(scope, h.id, h.normalWakeId)))
            throw new Error('GEOGRAPHY_RETIREMENT_WAKE_RACE');
          const wakeId = uuidv7();
          if (!(await geographyStore.setNormalWake(scope, h.id, wakeId)))
            throw new Error('GEOGRAPHY_RETIREMENT_WAKE_RACE');
          await enqueue(
            scope,
            cartographyQueue,
            {
              v: 2,
              kind: 'retire',
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              runId,
              recordingGeneration: h.generation ?? null,
              wakeId,
            },
            { jobId: wakeId },
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
      provide: CHECK_GEOGRAPHY_RECORDING_RUN,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makeCheckGeographyRecordingRun(p),
    },
    {
      provide: READ_GEOGRAPHY_SCENE_INPUT,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makeReadGeographySceneInput(p),
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
      provide: READ_OWN_EMERGING,
      inject: [GEOGRAPHY_PORTS, READ_EXPLORATION_SNAPSHOT],
      useFactory: (p: GeographyPorts, readSnapshot: ReadExplorationSnapshot) =>
        makeReadOwnEmerging({ ...p, readSnapshot }),
    },
    {
      provide: READ_OWN_PLACE_CONCEPTS,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makeReadOwnPlaceConcepts(p),
    },
    {
      provide: PUBLISH_GEOGRAPHY_DELTA,
      inject: [GEOGRAPHY_PORTS],
      useFactory: (p: GeographyPorts) => makePublishDelta(p),
    },
  ];
}
/** The Cartographer worker role. `KS_CARTOGRAPHER_ENABLED` is its only switch (D-038). */
export function cartographerWorkerProviders(t: { readonly workerConfig: symbol }) {
  return [
    {
      provide: RUN_CARTOGRAPHER,
      inject: [GEOGRAPHY_PORTS, RECORDING_REASONING_HARNESS, t.workerConfig],
      useFactory: (base: GeographyPorts, harness: RecordingReasoningHarness, config: WorkerConfig) =>
        makeRunCartographer({ ...base, harness, enabled: () => config.cartographerEnabled }),
    },
    // The rules-only settle of one universe's quiet places: the same switch, no model harness (D-104).
    {
      provide: SETTLE_QUIET,
      inject: [GEOGRAPHY_PORTS, t.workerConfig],
      useFactory: (base: GeographyPorts, config: WorkerConfig) =>
        makeSettleQuiet({ ...base, enabled: () => config.cartographerEnabled }),
    },
  ];
}
/** The scheduled quiet sweep (D-104). It reads state rows only and hands each due universe to its settle. */
export function quietSweepProviders(t: {
  readonly database: symbol;
  readonly boss: symbol;
  readonly workerConfig: symbol;
}) {
  return [
    {
      provide: SWEEP_QUIET,
      inject: [t.database, t.boss, t.workerConfig],
      useFactory: (db: Kysely<Database>, boss: PgBoss, config: WorkerConfig) =>
        makeSweepQuiet({
          enabled: () => config.cartographerEnabled,
          now: () => new Date(),
          store: quietSweepStore({ db, enqueueInTransaction: makeEnqueueInTransaction(boss) }),
        }),
    },
  ];
}
export { makeRunCartographer } from '../application/run.js';
export { makeSettleQuiet, makeSweepQuiet } from '../application/quiet.js';
export { quietSweepStore } from './quiet-store.js';
export function makeCheckGeographyRecordingRun(p: Pick<GeographyPorts, 'store' | 'now'>) {
  return makeOwnerCheck({ ...p, hash: canonicalSha256 });
}
export { makeRequestCartography, makeGeographyMaterialChange } from '../application/request.js';
export { applyProposal } from '../application/apply.js';
import { geographyContextHashes as contextHashes } from '../application/role.js';
export function geographyContextHashes(c: GeographyContext, runId: string) {
  return contextHashes(c, runId, canonicalSha256);
}
export { prepareGeography } from '../application/context.js';
export { geographyStore } from './postgres-store.js';
export type { GeographyPorts, CartographerPorts, GeographyContext } from '../application/ports.js';
