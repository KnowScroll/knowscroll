/**
 * Evidence's public surface: the queues other modules enqueue to, their payloads, and the use
 * cases' types. Framework-free; built by `adapters/nest-providers.ts` in the composition roots.
 */
export {
  ApplyActionEvidencePayloadSchema,
  ProjectScrollReadingPayloadSchema,
  projectEncounterActivityQueue,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidencePayload,
  type ProjectScrollReadingPayload,
} from './events.js';
export type { ApplyActionEvidence, ApplyActionEvidenceResult } from './application/apply-action-evidence.js';
export type {
  IngestObservations,
  IngestObservationsCommand,
  IngestObservationsRefusal,
  IngestObservationsResult,
} from './application/ingest-observations.js';
export type { ProjectScrollReading, ProjectScrollReadingResult } from './application/project-scroll-reading.js';
export type {
  ReadEvidenceDiagnostics,
  ReadEvidenceDiagnosticsResult,
} from './application/read-evidence-diagnostics.js';
export type { EvidenceDiagnostics } from './application/ports.js';

export { ACTIVITY_POLICY, type ActivityChannels } from './domain/activity.js';
export type {
  ProjectEncounterActivity,
  ReconcileEncounterActivity,
  ReadPreparedActivity,
  ActivityProjectionResult,
} from './application/activity-contracts.js';
export const PROJECT_ENCOUNTER_ACTIVITY = Symbol('evidence.projectEncounterActivity');
export const RECONCILE_ENCOUNTER_ACTIVITY = Symbol('evidence.reconcileEncounterActivity');
export const READ_PREPARED_ACTIVITY = Symbol('evidence.readPreparedActivity');
