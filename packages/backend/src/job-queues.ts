import { queueRegistry } from './infrastructure/jobs/queues.js';
import {
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
} from './modules/evidence/public.js';
import { sweepSignInRecordsQueue } from './modules/identity/public.js';
import { purgeExpiredRequestsQueue, sweepDispatchedAttemptsQueue } from './reasoning/events.js';

/**
 * Every durable queue this release declares. `migrate.js` creates them and applies their
 * policies; the API sends to them; the worker consumes them through its explicit registry; the
 * erasure inventory checks that every queue carrying `universeId` has an eraser.
 */
export const releaseQueues = queueRegistry([
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
  sweepSignInRecordsQueue,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
]);
