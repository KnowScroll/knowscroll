import {
  sceneAppliedProviders,
  sceneProviders,
  formationProviders,
} from '@knowscroll/backend/modules/scenes/nest-providers';
import {
  PROJECT_SCENE,
  BACKFILL_SCENE_LOOKS,
  projectSceneQueue,
  backfillLooksQueue,
  FORMATION_PRESENTATIONS,
  expireFormationQueue,
  recoverFormationQueue,
  type BackfillSceneLooks,
  type FormationUseCases,
  type ProjectScene,
} from '@knowscroll/backend/modules/scenes';
import {
  geographyProviders,
  cartographerWorkerProviders,
  quietSweepProviders,
} from '@knowscroll/backend/modules/geography/nest-providers';
import {
  GEOGRAPHY_MATERIAL_CHANGE,
  RUN_CARTOGRAPHER,
  PUBLISH_GEOGRAPHY_DELTA,
  SETTLE_QUIET,
  SWEEP_QUIET,
  cartographyQueue,
  publishDeltaQueue,
  settleQuietQueue,
  sweepQuietQueue,
  type MaterialGeographyChange,
  type RunCartographer,
  type PublishGeographyDelta,
  type SettleQuiet,
  type SweepQuiet,
} from '@knowscroll/backend/modules/geography';
import type { PlannerMaterialChange } from '@knowscroll/backend/modules/planner';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { REFRESH_VISIT_PUBLICATION, type RefreshVisitPublication } from '@knowscroll/backend/modules/social';
import { socialPeopleProviders, visitRefreshProviders } from '@knowscroll/backend/modules/social/nest-providers';
import {
  roomsFeedProviders,
  roomsScoutProviders,
  roomsRitualProviders,
  roomsWorkerProviders,
} from '@knowscroll/backend/modules/rooms/nest-providers';
import {
  CONTRIBUTE_AS_INHABITANT,
  DECIDE_CAST,
  RUN_CAST_PASS,
  RUN_FEED_HEARTBEAT,
  RUN_NIGHTLY_RITUALS,
  RUN_SCOUT_HEARTBEAT,
  SUMMARISE,
  castDueQueue,
  castPassQueue,
  feedHeartbeatQueue,
  nightlyRitualsQueue,
  scoutHeartbeatQueue,
  summariseQueue,
  contributeQueue,
  type ContributeAsInhabitant,
  type DecideCast,
  type RunCastPass,
  type RunFeedHeartbeat,
  type RunNightlyRituals,
  type RunScoutHeartbeat,
  type Summarise,
} from '@knowscroll/backend/modules/rooms';
import { askOrderAudienceProviders, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { threadGuestProviders } from '@knowscroll/backend/modules/social/nest-providers';
import { orderAudienceProviders, scenarioWorkerProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
import {
  CHECK_ASSET_AUDIENCE,
  READ_ASK_ORDER_AUDIENCE,
  READ_ORDER_AUDIENCE,
  type CheckAssetAudience,
} from '@knowscroll/backend/modules/content';
import {
  resolveBranchesQueue,
  suggestDraftQueue,
  writeAnswerQueue,
  RESOLVE_SCENARIO_BRANCHES,
  SUGGEST_SCENARIO_DRAFT,
  WRITE_SCENARIO_ANSWER,
  type ResolveSummary,
  type SuggestStep,
  type WriteAnswerStep,
} from '@knowscroll/backend/modules/scenarios';
import { resolveSupplyQueue, RESOLVE_CONTENT_REQUEST, type ResolveRequest } from '@knowscroll/backend/modules/supply';
import {
  plannerReadProviders,
  plannerRequestProviders,
  plannerWorkerProviders,
} from '@knowscroll/backend/modules/planner/nest-providers';
import {
  PLANNER_MATERIAL_CHANGE,
  READ_CURRENT_PLAN,
  RUN_PLANNER,
  plannerQueue,
  type RunPlanner,
} from '@knowscroll/backend/modules/planner';
import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import {
  eraseCurrentAccount,
  eraseCurrentExploration,
  exportCurrentPerson,
} from '@knowscroll/backend/erasure-registry';
import {
  clearExplorationFor,
  dataExportFor,
  deleteAccountFor,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  contentProviders,
  libraryPassageProviders,
  madeToOrderProviders,
  scrollProductionSenderProviders,
} from '@knowscroll/backend/modules/content/nest-providers';
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
import {
  experienceBufferSourceProviders,
  experienceEvidenceReadProviders,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { PREPARE_COMPOSER_BUFFER, prepareBufferQueue, type PrepareBuffer } from '@knowscroll/backend/modules/composer';
import {
  composerBufferWorkerProviders,
  composerConfiguredProviders,
} from '@knowscroll/backend/modules/composer/nest-providers';
import {
  SWEEP_SIGN_IN_RECORDS,
  sweepSignInRecordsQueue,
  type SweepSignInRecords,
} from '@knowscroll/backend/modules/identity';
import { identitySweepProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { PURGE_REPORTS, purgeReportsQueue, type PurgeReports } from '@knowscroll/backend/modules/feedback';
import { feedbackPurgeProviders } from '@knowscroll/backend/modules/feedback/nest-providers';
import {
  PRODUCTION_REASONING_HARNESS,
  PURGE_EXPIRED_REQUESTS,
  REASONING_HARNESS,
  SWEEP_DISPATCHED_ATTEMPTS,
  WITH_PRODUCTION_SCOPE,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
  type ProductionReasoningHarness,
  type PurgeExpiredRequests,
  type SweepDispatchedAttempts,
  type WithProductionScope,
} from '@knowscroll/backend/reasoning';
import { reasoningPurgeProviders, reasoningSweepProviders } from '@knowscroll/backend/reasoning/nest-providers';
import { scrollProductionConsumers } from './production-jobs.js';
import {
  ENQUEUE_JOB,
  DATABASE,
  JOB_CONSUMERS,
  LOG_EVENT,
  WITH_PERSONAL_SCOPE,
  WORKER_CONFIG,
  PG_BOSS,
} from './tokens.js';
import { accountPrivacyConsumers, clearExplorationConsumers } from './privacy.js';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { ACTIVITY_CONTEXT_EFFECT } from '@knowscroll/backend/modules/personal-context';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
const PERSONAL_MATERIAL_CHANGE = Symbol('personal.materialChange');
export const jobWiring: Provider[] = [
  ...sceneAppliedProviders({ enqueueJob: ENQUEUE_JOB }),
  ...sceneProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, logEvent: LOG_EVENT }),
  ...formationProviders({ database: DATABASE, boss: PG_BOSS, withPersonalScope: WITH_PERSONAL_SCOPE }),
  ...geographyProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...visitRefreshProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  // An AI inhabitant answers a member's ask through the personal harness; it reads people and content only.
  ...socialPeopleProviders(),
  ...roomsWorkerProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    workerConfig: WORKER_CONFIG,
    enqueueJob: ENQUEUE_JOB,
  }),
  // The night's daily items for each room, drafted from the library's prose for an operator to approve (D-176).
  ...libraryPassageProviders({ database: DATABASE }),
  ...roomsRitualProviders({ database: DATABASE, workerConfig: WORKER_CONFIG }),
  // Residents' finds about library assets and the room's memory, on a heartbeat (v3 R-8, D-248).
  ...roomsFeedProviders({ database: DATABASE, workerConfig: WORKER_CONFIG }),
  // Members' scouts: one find a day at most, signed by the owner (v3 R-9, D-259).
  ...roomsScoutProviders({ database: DATABASE, workerConfig: WORKER_CONFIG }),
  ...cartographerWorkerProviders({ workerConfig: WORKER_CONFIG }),
  ...quietSweepProviders({ database: DATABASE, boss: PG_BOSS, workerConfig: WORKER_CONFIG }),
  {
    provide: PERSONAL_MATERIAL_CHANGE,
    inject: [PLANNER_MATERIAL_CHANGE, GEOGRAPHY_MATERIAL_CHANGE],
    useFactory:
      (planner: PlannerMaterialChange, geography: MaterialGeographyChange): MaterialGeographyChange =>
      async (cap, input) => {
        // Both real owners share the Evidence-issued original-generation capability and revision.
        await planner(cap, input);
        await geography(cap, input);
      },
  },
  ...identityScopeOwnerProviders(),
  // The worker's resolver matches free-text asks through the personal reasoning harness.
  ...supplyProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    config: WORKER_CONFIG,
    harness: REASONING_HARNESS,
  }),
  ...plannerRequestProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...plannerWorkerProviders({ workerConfig: WORKER_CONFIG }),
  ...plannerReadProviders(),
  ...experienceEvidenceReadProviders(),
  ...experienceBufferSourceProviders(),
  // The worker persists decisions and ranks; it exposes no operator read of them.
  ...composerConfiguredProviders({ isOperator: () => false }, WORKER_CONFIG),
  ...composerBufferWorkerProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, workerConfig: WORKER_CONFIG }),
  ...contentProviders(),
  ...madeToOrderProviders({ database: DATABASE, orderAudiences: [READ_ORDER_AUDIENCE, READ_ASK_ORDER_AUDIENCE] }),
  ...scrollProductionSenderProviders({ boss: PG_BOSS }),
  // Scenarios (D-049): the planner answers a draft, and a sweep binds branches to their Scrolls.
  ...threadGuestProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, database: DATABASE }),
  // Who may reach a branch's Scroll, so the data export keeps a title only for those still in its thread.
  ...orderAudienceProviders({ database: DATABASE }),
  ...askOrderAudienceProviders({ database: DATABASE }),
  ...scenarioWorkerProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    database: DATABASE,
    harness: REASONING_HARNESS,
  }),
  // Same required PC-owned Composer adapter as the API; no legacy prepared-input binding.
  ...personalContextProviders({ readCurrentPlan: READ_CURRENT_PLAN }),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...activityProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    derivedProjection: ACTIVITY_CONTEXT_EFFECT,
    materialChange: PERSONAL_MATERIAL_CHANGE,
  }),
  ...identitySweepProviders({ database: DATABASE }),
  ...feedbackPurgeProviders({ database: DATABASE, logEvent: LOG_EVENT }),
  ...reasoningPurgeProviders({ database: DATABASE, logEvent: LOG_EVENT }),
  ...reasoningSweepProviders({ database: DATABASE, logEvent: LOG_EVENT, workerConfig: WORKER_CONFIG }),
  {
    provide: JOB_CONSUMERS,
    inject: [
      PROJECT_SCENE,
      BACKFILL_SCENE_LOOKS,
      REFRESH_VISIT_PUBLICATION,
      FORMATION_PRESENTATIONS,
      RUN_CARTOGRAPHER,
      PUBLISH_GEOGRAPHY_DELTA,
      SETTLE_QUIET,
      SWEEP_QUIET,
      RESOLVE_CONTENT_REQUEST,
      SUGGEST_SCENARIO_DRAFT,
      WRITE_SCENARIO_ANSWER,
      RESOLVE_SCENARIO_BRANCHES,
      CHECK_ASSET_AUDIENCE,
      RUN_PLANNER,
      PREPARE_COMPOSER_BUFFER,
      CONTRIBUTE_AS_INHABITANT,
      DECIDE_CAST,
      RUN_CAST_PASS,
      SUMMARISE,
      APPLY_ACTION_EVIDENCE,
      PROJECT_SCROLL_READING,
      PROJECT_ENCOUNTER_ACTIVITY,
      SWEEP_SIGN_IN_RECORDS,
      PURGE_EXPIRED_REQUESTS,
      SWEEP_DISPATCHED_ATTEMPTS,
      PURGE_REPORTS,
      RUN_NIGHTLY_RITUALS,
      RUN_FEED_HEARTBEAT,
      RUN_SCOUT_HEARTBEAT,
      PRODUCTION_REASONING_HARNESS,
      WITH_PRODUCTION_SCOPE,
      LOG_EVENT,
      DATABASE,
      PG_BOSS,
      WORKER_CONFIG,
    ],
    useFactory: (
      projectScene: ProjectScene,
      backfillLooks: BackfillSceneLooks,
      refreshVisit: RefreshVisitPublication,
      formation: FormationUseCases,
      runCartographer: RunCartographer,
      publishDelta: PublishGeographyDelta,
      settleQuiet: SettleQuiet,
      sweepQuiet: SweepQuiet,
      resolveRequest: ResolveRequest,
      suggestDraft: SuggestStep,
      writeAnswer: WriteAnswerStep,
      resolveBranches: () => Promise<ResolveSummary>,
      audience: CheckAssetAudience,
      runPlanner: RunPlanner,
      prepareBuffer: PrepareBuffer,
      contributeAsInhabitant: ContributeAsInhabitant,
      decideCast: DecideCast,
      runCastPass: RunCastPass,
      summarise: Summarise,
      applyActionEvidence: ApplyActionEvidence,
      projectScrollReading: ProjectScrollReading,
      projectActivity: ProjectEncounterActivity,
      sweepSignInRecords: SweepSignInRecords,
      purgeExpiredRequests: PurgeExpiredRequests,
      sweepDispatchedAttempts: SweepDispatchedAttempts,
      purgeReports: PurgeReports,
      runNightlyRituals: RunNightlyRituals,
      runFeedHeartbeat: RunFeedHeartbeat,
      runScoutHeartbeat: RunScoutHeartbeat,
      productionHarness: ProductionReasoningHarness,
      withProductionScope: WithProductionScope,
      logEvent: LogEvent,
      db: Kysely<Database>,
      boss: ReturnType<typeof createBoss>,
      config: WorkerConfig,
    ): readonly JobConsumer<unknown>[] => [
      jobConsumer(expireFormationQueue, async (job) => formation.expire(job)),
      jobConsumer(recoverFormationQueue, async (job) => {
        await formation.recover(job);
      }),
      ...scrollProductionConsumers({
        config,
        db,
        harness: productionHarness,
        withScope: withProductionScope,
        logEvent,
      }),
      ...clearExplorationConsumers(
        clearExplorationFor(db, boss, {
          reasoning: clearReasoning,
          // The imported current runner alone verifies and brands the exact owner lifecycle.
          eraseCore: eraseCurrentExploration,
          lockTimeoutMs: config.scopeLockTimeoutMs,
        }),
      ),
      ...accountPrivacyConsumers(
        {
          deletion: deleteAccountFor(db, boss, {
            eraseAccountData: eraseCurrentAccount,
            lockTimeoutMs: config.scopeLockTimeoutMs,
          }),
          exports: dataExportFor(db, boss, {
            gather: (scope, person) => exportCurrentPerson(scope, person, audience),
            lockTimeoutMs: config.scopeLockTimeoutMs,
          }),
        },
        logEvent,
      ),
      // After a projection, friends who may visit see what it drew: the published copy is redrawn in its
      // own transaction (D-047). A universe that shares nothing is a no-op, and a failure retries the
      // job, which re-projects nothing.
      jobConsumer(projectSceneQueue, async (payload) => {
        await projectScene(payload);
        await refreshVisit({ universeId: payload.universeId, privacyEpoch: payload.privacyEpoch });
      }),
      // Worlds projected before looks existed get theirs; nothing already stored moves (D-102).
      jobConsumer(backfillLooksQueue, async (payload) => {
        const { assigned } = await backfillLooks(payload);
        logEvent('scenes.looks_backfilled', { count: assigned });
      }),
      jobConsumer(cartographyQueue, async (payload, delivery) => {
        await runCartographer(payload, delivery.signal);
      }),
      jobConsumer(publishDeltaQueue, async (payload) => {
        await publishDelta(payload);
      }),
      // Every 15 minutes: universes with a place due to go quiet are handed to a settle (D-104).
      jobConsumer(sweepQuietQueue, async () => {
        const { handedOver } = await sweepQuiet();
        if (handedOver > 0) logEvent('geography.quiet_swept', { count: handedOver });
      }),
      // Rules only, no model: a place whose newest support is over 30 days old goes quiet (D-104).
      jobConsumer(settleQuietQueue, async (payload) => {
        const { outcome, changed } = await settleQuiet(payload);
        logEvent('geography.quiet_settled', { outcome, count: changed });
      }),
      jobConsumer(resolveSupplyQueue, async (payload, delivery) => {
        await resolveRequest(payload, delivery);
      }),
      jobConsumer(suggestDraftQueue, async (payload, delivery) => {
        await suggestDraft(payload, delivery.signal);
      }),
      jobConsumer(writeAnswerQueue, async (payload, delivery) => {
        await writeAnswer(payload, delivery.signal);
      }),
      // Every minute: preparing branches get their Scroll, the next take, or an honest end; a short answer that
      // took too long is given up on.
      jobConsumer(resolveBranchesQueue, async () => {
        const summary = await resolveBranches();
        logEvent('scenarios.branches_resolved', {
          count: summary.bound + summary.failed + summary.sent + summary.answersEnded,
        });
      }),
      jobConsumer(plannerQueue, async (payload, delivery) => {
        await runPlanner(payload, delivery.signal);
      }),
      jobConsumer(prepareBufferQueue, async (payload, delivery) => {
        const startedAt = performance.now();
        const result = await prepareBuffer(payload, { jobId: delivery.jobId, signal: delivery.signal });
        logEvent('composer.buffer_prepared', {
          outcome: result.kind,
          reasonCode: result.kind === 'skipped' ? result.reason : result.jev,
          count: result.kind === 'prepared' ? result.offers : 0,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }),
      jobConsumer(contributeQueue, async (payload, delivery) => {
        await contributeAsInhabitant(payload, delivery.signal);
      }),
      // Residents speaking on their own are registered only when this worker holds the rooms grant
      // (KS_REASONING_ROOM_ENABLED), so a world that leaves them off keeps the jobs for one that has it (D-162).
      ...(config.reasoning.roomEnabled
        ? [
            jobConsumer(castDueQueue, async (payload) => {
              await decideCast(payload);
            }),
            jobConsumer(castPassQueue, async (payload, delivery) => {
              await runCastPass(payload, delivery.signal);
            }),
            jobConsumer(summariseQueue, async (payload, delivery) => {
              await summarise(payload, delivery.signal);
            }),
            // Once a night: each room's question and Spot the flaw, drafted for an operator to approve (D-176).
            jobConsumer(nightlyRitualsQueue, async (_payload, delivery) => {
              await runNightlyRituals(delivery.signal, (slug, error) =>
                logEvent('rooms.rituals_room_failed', { context: slug, error }),
              );
            }),
          ]
        : []),
      // Residents' heartbeat: finds and the room's memory, three times a day, only where its own switch is on as well (v3 R-8).
      ...(config.reasoning.roomEnabled && config.reasoning.roomFeedEnabled
        ? [
            jobConsumer(feedHeartbeatQueue, async (_payload, delivery) => {
              await runFeedHeartbeat(delivery.signal, (slug, error) =>
                logEvent('rooms.feed_room_failed', { context: slug, error }),
              );
            }),
          ]
        : []),
      // Scouts' heartbeat, only where its own switch is on as well (v3 R-9).
      ...(config.reasoning.roomEnabled && config.reasoning.roomScoutsEnabled
        ? [
            jobConsumer(scoutHeartbeatQueue, async (_payload, delivery) => {
              await runScoutHeartbeat(delivery.signal, (slug, error) =>
                logEvent('rooms.scout_room_failed', { context: slug, error }),
              );
            }),
          ]
        : []),
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
        logEvent('identity.sign_in_records_swept', { count: removed.links + removed.sessions + removed.exports });
      }),
      // Every 15 minutes: protected request bytes past their retention (logs `reasoning.requests_purged`).
      jobConsumer(purgeExpiredRequestsQueue, async () => {
        await purgeExpiredRequests();
      }),
      // Every 5 minutes: attempts a crash left `dispatched` become `unknown` (logs `reasoning.dispatched_swept`), and
      // personal runs left admitted and idle for hours are closed (logs `reasoning.idle_runs_closed`).
      jobConsumer(sweepDispatchedAttemptsQueue, async () => {
        await sweepDispatchedAttempts();
      }),
      // Once a day: reports about deleted accounts whose 90 days are over (logs `feedback.reports_purged`, D-055).
      jobConsumer(purgeReportsQueue, async () => {
        await purgeReports();
      }),
    ],
  },
];
