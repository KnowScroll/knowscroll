import { backfillLooksQueue, expireFormationQueue, recoverFormationQueue } from './modules/scenes/events.js';
import { projectSceneQueue } from './modules/scenes/public.js';
import { cartographyQueue, publishDeltaQueue, settleQuietQueue, sweepQuietQueue } from './modules/geography/public.js';
import { resolveSupplyQueue } from './modules/supply/public.js';
import { produceScrollQueue } from './modules/content/public.js';
import { plannerQueue } from './modules/planner/public.js';
import { purgeReportsQueue } from './modules/feedback/public.js';
import {
  castDueQueue,
  castPassQueue,
  contributeQueue,
  nightlyRitualsQueue,
  summariseQueue,
} from './modules/rooms/public.js';
import { prepareBufferQueue } from './modules/composer/public.js';
import { resolveBranchesQueue, suggestDraftQueue, writeAnswerQueue } from './modules/scenarios/public.js';
import { queueRegistry } from './infrastructure/jobs/queues.js';
import {
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
} from './modules/evidence/public.js';
import {
  buildDataExportQueue,
  clearExplorationQueue,
  deleteAccountQueue,
  recoverAccountDeletionsQueue,
  recoverClearOperationsQueue,
  sweepSignInRecordsQueue,
} from './modules/identity/public.js';
import { purgeExpiredRequestsQueue, sweepDispatchedAttemptsQueue } from './reasoning/events.js';

/**
 * Every durable queue this release declares. `migrate.js` creates them and applies their
 * policies; the API sends to them; the worker consumes them through its explicit registry; the
 * erasure inventory checks that every queue carrying `universeId` has an eraser.
 */
export const releaseQueues = queueRegistry([
  clearExplorationQueue,
  recoverClearOperationsQueue,
  deleteAccountQueue,
  recoverAccountDeletionsQueue,
  buildDataExportQueue,
  projectSceneQueue,
  backfillLooksQueue,
  expireFormationQueue,
  recoverFormationQueue,
  cartographyQueue,
  publishDeltaQueue,
  sweepQuietQueue,
  settleQuietQueue,
  resolveSupplyQueue,
  produceScrollQueue,
  suggestDraftQueue,
  writeAnswerQueue,
  resolveBranchesQueue,
  plannerQueue,
  prepareBufferQueue,
  contributeQueue,
  castDueQueue,
  castPassQueue,
  summariseQueue,
  nightlyRitualsQueue,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
  sweepSignInRecordsQueue,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
  purgeReportsQueue,
]);
