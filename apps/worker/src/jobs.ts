import { sceneAppliedProviders, sceneProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { PROJECT_SCENE, projectSceneQueue, type ProjectScene } from '@knowscroll/backend/modules/scenes';
import { geographyProviders, cartographerWorkerProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import {
  GEOGRAPHY_MATERIAL_CHANGE,
  RUN_CARTOGRAPHER,
  PUBLISH_GEOGRAPHY_DELTA,
  cartographyQueue,
  publishDeltaQueue,
  type MaterialGeographyChange,
  type RunCartographer,
  type PublishGeographyDelta,
} from '@knowscroll/backend/modules/geography';
import type { PlannerMaterialChange } from '@knowscroll/backend/modules/planner';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { resolveSupplyQueue, RESOLVE_CONTENT_REQUEST, type ResolveRequest } from '@knowscroll/backend/modules/supply';
import { plannerRequestProviders, plannerWorkerProviders } from '@knowscroll/backend/modules/planner/nest-providers';
import {
  PLANNER_MATERIAL_CHANGE,
  RUN_PLANNER,
  plannerQueue,
  type RunPlanner,
} from '@knowscroll/backend/modules/planner';
import type { Provider } from '@nestjs/common';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import {
  projectEncounterActivityQueue,
  PROJECT_ENCOUNTER_ACTIVITY,
  type ProjectEncounterActivity,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidence,
  type ProjectScrollReading,
} from '@knowscroll/backend/modules/evidence';
import {
  APPLY_ACTION_EVIDENCE,
  PROJECT_SCROLL_READING,
  evidenceProviders,
  activityProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  SWEEP_SIGN_IN_RECORDS,
  sweepSignInRecordsQueue,
  type SweepSignInRecords,
} from '@knowscroll/backend/modules/identity';
import { identitySweepProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  PURGE_EXPIRED_REQUESTS,
  SWEEP_DISPATCHED_ATTEMPTS,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
  type PurgeExpiredRequests,
  type SweepDispatchedAttempts,
} from '@knowscroll/backend/reasoning';
import { reasoningPurgeProviders, reasoningSweepProviders } from '@knowscroll/backend/reasoning/nest-providers';
import { ENQUEUE_JOB, DATABASE, JOB_CONSUMERS, LOG_EVENT, WITH_PERSONAL_SCOPE, WORKER_CONFIG } from './tokens.js';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { ACTIVITY_CONTEXT_EFFECT } from '@knowscroll/backend/modules/personal-context';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
const PERSONAL_MATERIAL_CHANGE = Symbol('personal.materialChange');
export const jobWiring: Provider[] = [
  ...sceneAppliedProviders({ enqueueJob: ENQUEUE_JOB }),
  ...sceneProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  ...geographyProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...cartographerWorkerProviders({ workerConfig: WORKER_CONFIG }),
  {
    provide: PERSONAL_MATERIAL_CHANGE,
    inject: [PLANNER_MATERIAL_CHANGE, GEOGRAPHY_MATERIAL_CHANGE],
    useFactory:
      (planner: PlannerMaterialChange, geography: MaterialGeographyChange): MaterialGeographyChange =>
      async (scope, input) => {
        await planner(scope, input);
        await geography(scope, input);
      },
  },
  ...identityScopeOwnerProviders(),
  ...supplyProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...plannerRequestProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...plannerWorkerProviders({ workerConfig: WORKER_CONFIG }),
  ...experienceEvidenceReadProviders(),
  ...contentProviders(),
  // Same required PC-owned Composer adapter as the API; no legacy prepared-input binding.
  ...personalContextProviders(),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...activityProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    derivedProjection: ACTIVITY_CONTEXT_EFFECT,
    materialChange: PERSONAL_MATERIAL_CHANGE,
  }),
  ...identitySweepProviders({ database: DATABASE }),
  ...reasoningPurgeProviders({ database: DATABASE, logEvent: LOG_EVENT }),
  ...reasoningSweepProviders({ database: DATABASE, logEvent: LOG_EVENT, workerConfig: WORKER_CONFIG }),
  {
    provide: JOB_CONSUMERS,
    inject: [
      PROJECT_SCENE,
      RUN_CARTOGRAPHER,
      PUBLISH_GEOGRAPHY_DELTA,
      RESOLVE_CONTENT_REQUEST,
      RUN_PLANNER,
      APPLY_ACTION_EVIDENCE,
      PROJECT_SCROLL_READING,
      PROJECT_ENCOUNTER_ACTIVITY,
      SWEEP_SIGN_IN_RECORDS,
      PURGE_EXPIRED_REQUESTS,
      SWEEP_DISPATCHED_ATTEMPTS,
      LOG_EVENT,
    ],
    useFactory: (
      projectScene: ProjectScene,
      runCartographer: RunCartographer,
      publishDelta: PublishGeographyDelta,
      resolveRequest: ResolveRequest,
      runPlanner: RunPlanner,
      applyActionEvidence: ApplyActionEvidence,
      projectScrollReading: ProjectScrollReading,
      projectActivity: ProjectEncounterActivity,
      sweepSignInRecords: SweepSignInRecords,
      purgeExpiredRequests: PurgeExpiredRequests,
      sweepDispatchedAttempts: SweepDispatchedAttempts,
      logEvent: LogEvent,
    ): readonly JobConsumer<unknown>[] => [
      jobConsumer(projectSceneQueue, async (payload) => {
        await projectScene(payload);
      }),
      jobConsumer(cartographyQueue, async (payload, delivery) => {
        await runCartographer(payload, delivery.signal);
      }),
      jobConsumer(publishDeltaQueue, async (payload) => {
        await publishDelta(payload);
      }),
      jobConsumer(resolveSupplyQueue, async (payload) => {
        await resolveRequest(payload);
      }),
      jobConsumer(plannerQueue, async (payload, delivery) => {
        await runPlanner(payload, delivery.signal);
      }),
      jobConsumer(applyActionEvidenceQueue, async (payload) => {
        const result = await applyActionEvidence(payload);
        if (result.kind === 'skipped')
          logEvent('jobs.work_skipped', { queue: applyActionEvidenceQueue.name, reasonCode: result.reason });
      }),
      // After the evidence commit the use case has already sent its disposable hint; the event below
      // is logged after commit, with the outcome and a code, never the observations (D-017).
      jobConsumer(projectScrollReadingQueue, async (payload) => {
        const startedAt = performance.now();
        const result = await projectScrollReading(payload);
        logEvent('evidence.reading_projected', {
          exposureId: payload.exposureId,
          outcome: result.kind,
          durationMs: Math.round(performance.now() - startedAt),
          ...(result.kind === 'skipped' ? { reasonCode: result.reason } : {}),
        });
      }),
      jobConsumer(projectEncounterActivityQueue, async (payload) => {
        await projectActivity(payload);
      }),
      // Every 15 minutes (pg-boss cron, review m12): expired links and long-ended sessions.
      jobConsumer(sweepSignInRecordsQueue, async () => {
        const removed = await sweepSignInRecords();
        logEvent('identity.sign_in_records_swept', { count: removed.links + removed.sessions });
      }),
      // Every 15 minutes: protected request bytes past their retention (logs `reasoning.requests_purged`).
      jobConsumer(purgeExpiredRequestsQueue, async () => {
        await purgeExpiredRequests();
      }),
      // Every 5 minutes: attempts a crash left `dispatched` become `unknown` (logs `reasoning.dispatched_swept`).
      jobConsumer(sweepDispatchedAttemptsQueue, async () => {
        await sweepDispatchedAttempts();
      }),
    ],
  },
];
