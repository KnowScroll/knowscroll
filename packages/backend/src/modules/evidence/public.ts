/** Evidence's public surface: the queue other modules enqueue to, its payload, and the consumer's result. */
export {
  ApplyActionEvidencePayloadSchema,
  applyActionEvidenceQueue,
  type ApplyActionEvidencePayload,
} from './events.js';
export type { ApplyActionEvidence, ApplyActionEvidenceResult } from './application/apply-action-evidence.js';
