import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  READ_COVERAGE_INPUTS,
  READ_TRUSTED_COVERAGE,
  type ReadCoverageInputs,
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
  GEOGRAPHY_APPLIED,
  READ_GEOGRAPHY_SCENE_INPUT,
  REQUEST_CARTOGRAPHY,
  RUN_CARTOGRAPHER,
  READ_OWN_GEOGRAPHY,
  READ_OWN_DELTAS,
  PUBLISH_GEOGRAPHY_DELTA,
  READ_OWN_REGION_CONSTRAINT,
} from '../public.js';
import { makeRequestCartography, makeGeographyMaterialChange } from '../application/request.js';
import { makeReadGeography, makeReadDeltas } from '../application/read.js';
import {
  makeRunCartographer,
  makePublishDelta,
  makeCheckGeographyRecordingRun as makeOwnerCheck,
} from '../application/run.js';
import type {
  GeographyPorts,
  GeographyContext,
  GeographyRunHeader,
  RequestCartographyResult,
} from '../application/ports.js';
import { makeReadGeographySceneInput } from '../application/scene-input.js';
import type { GeographyApplied } from '../public.js';
import { geographyStore, readRegionPlace } from './postgres-store.js';
import { makeReadOwnRegionConstraint } from '../application/region-constraint.js';
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
  h: GeographyRunHeader,
  legacyInitial1 = false,
): Promise<boolean> {
  if (Boolean(h.claimId) !== Boolean(h.claimUntil)) return false;
  if (h.claimUntil && Date.parse(h.claimUntil) > Date.now()) return false;
  if (!h.normalWakeId) return true;
  const row = (
    await sql<{
      state: string;
      v: unknown;
      u: unknown;
      e: unknown;
      r: unknown;
      g: unknown;
      w: unknown;
      k: unknown;
      has_g: boolean;
      has_kind: boolean;
      has_claim: boolean;
    }>`select state,data->'v' v,data->'universeId' u,data->'privacyEpoch' e,data->'runId' r,data->'recordingGeneration' g,data->'wakeId' w,data->'kind' k,data?'recordingGeneration' has_g,data?'kind' has_kind,data?'expectedClaimId' has_claim from pgboss.job where name=${cartographyQueue.name} and id=${h.normalWakeId}::uuid`.execute(
      transactionOf(scope),
    )
  ).rows[0];
  if (!row) return true;
  const equal = (value: unknown, expected: string) =>
    typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
  if (
    row.v !== 2 ||
    !equal(row.u, scope.authority.universeId) ||
    row.e !== scope.authority.privacyEpoch ||
    !equal(row.r, h.id) ||
    !row.has_g ||
    (row.g !== (h.recording?.source.generation ?? null) &&
      !(legacyInitial1 && !h.recording && !h.contextSha256 && !h.modelContextSha256 && !row.has_kind && row.g === 1)) ||
    !equal(row.w, h.normalWakeId) ||
    row.has_claim ||
    (row.has_kind ? row.k !== 'retire' : row.g === null)
  )
    return false;
  return ['completed', 'cancelled', 'failed'].includes(row.state);
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
            h = await geographyStore.header(scope, runId);
          if (
            !h ||
            !['queued', 'prepared', 'blocked', 'unknown'].includes(h.status) ||
            (h.recording
              ? h.recording.source.generation !== cap.generation ||
                h.recording.accountId.toLowerCase() !== root.accountId.toLowerCase()
              : cap.generation !== 1)
          )
            return false;
          if (delayed) {
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
            if (!(await normalWakeReplaceable(scope, h, cap.generation === 1))) return false;
            if (h.normalWakeId) await geographyStore.consumeNormalWake(scope, h.id, h.normalWakeId);
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
              { jobId: wakeId },
            );
            return true;
          }
        },
        enqueueRetirement: async (cap, runId) => {
          const root = await geographyStore.root(cap),
            scope = cap.personal,
            state = await geographyStore.state(scope),
            h = await geographyStore.header(scope, runId);
          if (
            !h ||
            state.activeRunId !== runId ||
            state.desiredSource?.generation !== cap.generation ||
            !['queued', 'prepared', 'blocked', 'unknown'].includes(h.status)
          )
            return;
          if (
            h.recording &&
            (h.recording.source.generation === cap.generation ||
              h.recording.accountId.toLowerCase() !== root.accountId.toLowerCase())
          )
            return;
          if (!(await normalWakeReplaceable(scope, h, true))) return;
          if (h.normalWakeId) await geographyStore.consumeNormalWake(scope, h.id, h.normalWakeId);
          const wakeId = uuidv7();
          await geographyStore.writeRun(scope, { ...h, normalWakeId: wakeId });
          await enqueue(
            scope,
            cartographyQueue,
            {
              v: 2,
              kind: 'retire',
              universeId: scope.authority.universeId,
              privacyEpoch: scope.authority.privacyEpoch,
              runId,
              recordingGeneration: h.recording?.source.generation ?? null,
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
      inject: [GEOGRAPHY_PORTS, RECORDING_REASONING_HARNESS, t.workerConfig],
      useFactory: (base: GeographyPorts, harness: RecordingReasoningHarness, config: WorkerConfig) =>
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
