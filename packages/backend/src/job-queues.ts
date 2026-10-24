import { expireFormationQueue, recoverFormationQueue } from './modules/scenes/events.js';
import { projectSceneQueue } from './modules/scenes/public.js';
import { cartographyQueue, publishDeltaQueue } from './modules/geography/public.js';
import { resolveSupplyQueue } from './modules/supply/public.js';
import { plannerQueue } from './modules/planner/public.js';
import { prepareBufferQueue } from './modules/composer/public.js';
import { queueRegistry } from './infrastructure/jobs/queues.js';
import {
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
} from './modules/evidence/public.js';
import {
  sweepSignInRecordsQueue,
  clearExplorationQueue,
  recoverClearOperationsQueue,
} from './modules/identity/public.js';
import {
  cutroomAccountingQueue,
  cutroomFollowQueue,
  cutroomPoolQueue,
  cutroomSettleQueue,
  recoverCutroomQueue,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
} from './reasoning/events.js';

/**
 * Every durable queue this release declares. `migrate.js` creates them and applies their
 * policies; the API sends to them; the worker consumes them through its explicit registry; the
 * erasure inventory checks that every queue carrying `universeId` has an eraser.
 */
export const releaseQueues = queueRegistry([
  receiveCutroomQueue,
  recoverReceiveCutroomQueue,
  clearExplorationQueue,
  recoverClearOperationsQueue,
  cutroomPoolQueue,
  cutroomAccountingQueue,
  cutroomFollowQueue,
  cutroomSettleQueue,
  recoverCutroomQueue,
  projectSceneQueue,
  expireFormationQueue,
  recoverFormationQueue,
  cartographyQueue,
  publishDeltaQueue,
  resolveSupplyQueue,
  produceScrollQueue,
  plannerQueue,
  prepareBufferQueue,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
  sweepSignInRecordsQueue,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
]);
import { produceScrollQueue, receiveCutroomQueue, recoverReceiveCutroomQueue } from './modules/content/public.js';
